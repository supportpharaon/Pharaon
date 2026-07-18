"""
Pharaon Intelligent Adaptive Scheduler — v3  ("the brain")

The planning core is the DSR memory model in backend/memory.py (FSRS-4.5):
each topic carries Difficulty, Stability and Retrievability, updated from the
user's 0-10 session ratings. The scheduler's job is to place each review at
the moment retrievability decays to the topic's desired-retention target —
the evidence-based sweet spot between review efficiency and forgetting risk.

Design principles
─────────────────
1. Review when it matters (spacing effect / desirable difficulty)
   Due date = the day recall probability hits the retention target. Reviewing
   earlier wastes sessions; much later risks forgetting. Every successful,
   well-timed review multiplies stability → intervals stretch from days to
   weeks to months to years while retention stays above target.

2. Priorities & exams change the TARGET, not hacky interval multipliers
   Critical topics are held to a stricter recall standard (reviewed sooner);
   near an exam the target ramps toward 96% and a final pass is guaranteed
   no later than the day before the exam.

3. Balanced days (no over-/under-tasking)
   Each review has a placement window around its due date (small early slack,
   larger late slack — being late is far cheaper than early on a power-law
   forgetting curve). Within the window the least-loaded day wins, respecting
   the daily minutes budget, the hard session cap, off days and restrictions.

4. Interleaving (Rohrer & Taylor)
   Subjects are round-robined within each due-date group so days hold a mix
   of subjects instead of blocks of one.

5. Fragility triage
   Overdue material is ordered by retention deficit — what's most at risk of
   being forgotten is scheduled (and listed) first.

6. Local edits stay local
   Manual placements and skip-reschedules are never touched by recalculation.
"""

import math
import uuid as _uuid
from datetime import date, timedelta, datetime
from backend import database, memory, optimizer


# ── SM-2 core (kept for flashcards & fitness scheduling) ──────────────────────

def calculate_sm2(ease_factor, interval, repetitions, rating):
    """
    rating 0-10 → quality 0-5 internally.
    Returns {'ease_factor', 'interval', 'repetitions'}.
    """
    q = min(5.0, rating / 2.0)
    if q < 3.0:
        new_reps     = 0
        new_interval = 1
        penalty      = 0.2 + (3.0 - q) * 0.05
        new_ease     = max(1.3, ease_factor - penalty)
    else:
        new_reps = repetitions + 1
        if repetitions == 0:
            new_interval = 1
        elif repetitions == 1:
            new_interval = 6
        else:
            new_interval = max(1, round(interval * ease_factor))
        ef_delta = 0.1 - (5.0 - q) * (0.08 + (5.0 - q) * 0.02)
        new_ease     = max(1.3, ease_factor + ef_delta)
        new_interval = max(1, new_interval)
    return {
        'ease_factor': round(new_ease, 4),
        'interval':    new_interval,
        'repetitions': new_reps,
    }


# ── Streak ─────────────────────────────────────────────────────────────────────

def get_study_streak(sessions):
    """Consecutive days (ending yesterday) where all sessions were completed."""
    today = date.today()
    by_day = {}
    for s in sessions:
        d = s.get('scheduled_date', '')
        if not d:
            continue
        by_day.setdefault(d, {'total': 0, 'done': 0})
        # 'skipped' ghosts moved to another day — they don't count against
        # this one; 'missed' days simply break the streak by leaving done<total.
        if s['status'] not in ('missed', 'skipped'):
            by_day[d]['total'] += 1
        if s['status'] == 'completed':
            by_day[d]['done'] += 1
    streak = 0
    cursor = today - timedelta(days=1)
    while True:
        d    = cursor.isoformat()
        info = by_day.get(d)
        if info and info['total'] > 0 and info['done'] == info['total']:
            streak += 1
            cursor -= timedelta(days=1)
        else:
            break
    return streak


# ── Exam helpers ───────────────────────────────────────────────────────────────

def _exam_topic_ids(exam):
    import json
    linked = exam.get('topic_ids') or []
    if isinstance(linked, str):
        try:
            linked = json.loads(linked)
        except Exception:
            linked = []
    return linked


def _exams_for_topic(topic, exams):
    """
    Exams relevant to this topic: explicitly linked ones, or — when an exam
    has no explicit links — exams of the topic's subject. A legacy exam with
    neither links nor subject applies to everything.
    """
    result = []
    tid  = topic['id']
    subj = (topic.get('subject') or '').strip().lower()
    for e in exams:
        linked = _exam_topic_ids(e)
        if linked:
            if tid in linked:
                result.append(e)
            continue
        esubj = (e.get('subject') or '').strip().lower()
        if not esubj or esubj == subj:
            result.append(e)
    return result


def _nearest_exam_info(topic, exams, today):
    """(date, importance) of the closest upcoming exam for this topic, or (None, 2)."""
    nearest, imp = None, 2
    for e in _exams_for_topic(topic, exams):
        try:
            exam_d = date.fromisoformat(e['exam_date'])
        except (KeyError, ValueError):
            continue
        if exam_d <= today:
            continue
        if nearest is None or exam_d < nearest:
            nearest = exam_d
            imp     = int(e.get('importance', 2))
    return nearest, imp


def exam_pressure(topic, exams, within_days=14):
    """True when an upcoming exam for this topic is within `within_days`."""
    today = date.today()
    exam_d, _ = _nearest_exam_info(topic, exams, today)
    return exam_d is not None and (exam_d - today).days <= within_days


# ── Special-date helpers ───────────────────────────────────────────────────────

def availability_for_date(date_str, special_dates):
    """
    Aggregate ALL availability entries covering a date — strictest wins.
    (A single first-match lookup let an earlier-starting reduced day or an
    hourly block mask a full day off on the overlapping day.)

    Returns ('off', None)              — any full day off covers the date
            ('reduced', min_priority)  — strictest reduced ceiling applies
            (None, None)               — fully available
    Timed off-blocks (start & end time set) never block the whole day.
    """
    kind, maxp = None, None
    for sd in special_dates:
        if not (sd['start_date'] <= date_str <= sd['end_date']):
            continue
        if sd['date_type'] == 'off' and not (sd.get('start_time') and sd.get('end_time')):
            return 'off', None
        if sd['date_type'] == 'reduced':
            p = int(sd.get('max_priority', 2))
            kind = 'reduced'
            maxp = p if maxp is None else min(maxp, p)
    return kind, maxp


def _effective_cap(date_obj, settings, special_dates, priority):
    """Return (int cap, bool blocked) for a candidate date."""
    max_s = int(settings.get('max_sessions_per_day', 6))
    kind, maxp = availability_for_date(date_obj.isoformat(), special_dates)
    if kind == 'off':
        return 0, True
    if kind == 'reduced':
        if priority > maxp:
            return 0, True
        return max(1, max_s // 2), False
    return max_s, False


def _is_restricted(cstr, topic, subject, restrictions):
    """True if the candidate date is blocked for this topic/subject."""
    if not restrictions:
        return False
    for r in restrictions:
        if r['start_date'] <= cstr <= r['end_date']:
            if r['scope'] == 'subject' and r.get('subject') == subject:
                return True
            if r['scope'] == 'topic' and r.get('topic_id') == topic['id']:
                return True
    return False


# ── Slot finder: windowed, load-balanced placement ─────────────────────────────

def _find_slot(due, day_load, settings, special_dates, topic,
               min_date=None, day_minutes=None, restrictions=None,
               interval_len=1, hard_deadline=None, max_lookahead=365):
    """
    Place a review near its memory-model due date.

    Window: [due − early_slack, due + late_slack]. Early slack is tiny (an
    early review wastes efficiency on a power-law forgetting curve); late
    slack scales with the interval (a mature memory decays slowly, so a few
    days late is nearly free and buys balanced days).

    Within the window every eligible day is scored — relative minute-load,
    distance from due, an early-day penalty, and a large penalty when over
    the daily budget — and the cheapest day wins. If the whole window is
    over budget, the search walks forward for the first day under budget
    (never past hard_deadline, used to keep pre-exam reviews before the exam).

    Hard limits are never violated: session cap, off days, restricted dates.
    """
    priority    = int(topic.get('priority', 3))
    subject     = topic.get('subject', '')
    session_dur = int(topic.get('session_duration') or settings.get('default_session_duration', 25))
    daily_goal  = max(session_dur, int(settings.get('daily_goal_minutes', 120)))
    tomorrow    = date.today() + timedelta(days=1)

    earliest = tomorrow
    if min_date and min_date > earliest:
        earliest = min_date
    if due < earliest:
        due = earliest
    if hard_deadline and due > hard_deadline >= earliest:
        due = hard_deadline

    early_slack = 1 if interval_len >= 7 else 0
    late_slack  = max(2, min(10, round(interval_len * 0.15)))

    lo = max(earliest, due - timedelta(days=early_slack))
    hi = due + timedelta(days=late_slack)
    if hard_deadline and hi > hard_deadline >= lo:
        hi = hard_deadline
    if hi < lo:
        hi = lo

    def _eligible(d):
        cstr = d.isoformat()
        cap, blocked = _effective_cap(d, settings, special_dates, priority)
        if blocked or day_load.get(cstr, 0) >= cap:
            return False
        if _is_restricted(cstr, topic, subject, restrictions):
            return False
        return True

    def _mins_after(d):
        cur = day_minutes.get(d.isoformat(), 0) if day_minutes is not None else 0
        return cur + session_dur

    best, best_score = None, None
    d = lo
    while d <= hi:
        if _eligible(d):
            score  = _mins_after(d) / daily_goal
            score += abs((d - due).days) / (late_slack + 1)
            if d < due:
                score += 0.75                      # early = wasted efficiency
            if _mins_after(d) > daily_goal:
                score += 2.0                       # over budget = last resort
            if best_score is None or score < best_score - 1e-9:
                best, best_score = d, score
        d += timedelta(days=1)

    if best is not None and best_score < 2.0:
        return best

    # Whole window over budget or full.
    # With a deadline (pre-exam review): distribute across the ENTIRE span
    # before the deadline, least-loaded day first (ties → closest to due).
    # Demanding a strictly under-budget day here made every same-deadline
    # session collapse onto exam−1 whenever sessions are large relative to
    # the daily goal (e.g. five 90-minute reviews stacked on one day while
    # nearby days sat empty).
    if hard_deadline:
        candidates = []
        d = earliest
        while d <= hi:
            if _eligible(d):
                candidates.append(d)
            d += timedelta(days=1)
        if candidates:
            return min(candidates, key=lambda x: (
                day_minutes.get(x.isoformat(), 0) if day_minutes is not None else 0,
                abs((x - due).days),
            ))
        # Every pre-deadline day is at the hard cap — the deadline cannot be
        # satisfied. The cap is the harder constraint: fall through and place
        # after it instead of overloading a day.

    # Walk forward for the first day with budget room; remember the first
    # merely-eligible day (under cap) as a fallback.
    d = hi + timedelta(days=1)
    first_eligible = None
    for _ in range(max_lookahead):
        if _eligible(d):
            if _mins_after(d) <= daily_goal:
                return d
            if first_eligible is None:
                first_eligible = d
        d += timedelta(days=1)

    return best or first_eligible or due


# ── Session factory ────────────────────────────────────────────────────────────

def _make_session(topic, scheduled_date, settings, reason='auto',
                  is_rescheduled=False, original_date=None):
    dur = int(topic.get('session_duration') or settings.get('default_session_duration', 25))
    return {
        'id':                 str(_uuid.uuid4()),
        'topic_id':           topic['id'],
        'topic_name':         topic['name'],
        'subject':            topic.get('subject', ''),
        'scheduled_date':     scheduled_date,
        'scheduled_time':     None,
        'scheduled_duration': dur,
        'status':             'scheduled',
        'is_rescheduled':     1 if is_rescheduled else 0,
        'original_date':      original_date or scheduled_date,
        'reschedule_reason':  reason,
        'created_at':         datetime.now().isoformat(),
    }


# ── Subject interleaving ───────────────────────────────────────────────────────

def _subject_interleave(candidates, target_key):
    """
    Round-robin same-due-date topics by subject so each day receives a mix of
    subjects instead of a block of one (interleaving effect). No topic ever
    moves to a different due-date group, so daily balance is untouched.
    """
    result   = []
    group    = []
    grp_key  = object()

    def _flush(g):
        buckets, order = {}, []
        for c in g:
            subj = c['topic'].get('subject', '') or ''
            if subj not in buckets:
                buckets[subj] = []
                order.append(subj)
            buckets[subj].append(c)
        while any(buckets[s] for s in order):
            for s in order:
                if buckets[s]:
                    result.append(buckets[s].pop(0))

    for c in candidates:
        k = target_key(c)
        if group and k != grp_key:
            _flush(group)
            group = []
        grp_key = k
        group.append(c)
    if group:
        _flush(group)
    return result


# ── Core: full schedule recalculation ─────────────────────────────────────────

def recalculate_schedule(settings=None, special_dates=None, exams=None, restrictions=None):
    """
    Rebuild every topic's future sessions from the memory model.

    Steps:
      1. Seed day loads from sessions that survive the rebuild (today's,
         manual, committed skips) and anchor those topics' Session 1 on them.
      2. Delete all other auto-scheduled future sessions.
      3. For each topic: compute (D, S) memory state, its retention target
         (base setting ± priority shift, ramped toward 96% near exams), and
         the due date where retrievability hits the target. Overdue topics
         carry their retention deficit as triage urgency.
      4. Sort by (due, deficit), interleave subjects, place Session 1 in a
         balanced window around due (never after a pre-exam deadline).
      5. Project the post-review state assuming "Good" and place Session 2
         the same way.
    """
    today    = date.today()
    tomorrow = today + timedelta(days=1)

    if settings      is None: settings      = database.get_settings()
    if special_dates is None: special_dates = database.get_all_special_dates()
    if exams         is None: exams         = database.get_all_exams()
    if restrictions  is None: restrictions  = database.get_all_study_restrictions()

    topics    = database.get_all_topics()
    t_by_id   = {t['id']: t for t in topics}
    valid_ids = set(t_by_id)

    try:
        base_r = float(settings.get('desired_retention', 0.9) or 0.9)
    except (TypeError, ValueError):
        base_r = 0.9

    # ── 1. Seed day loads & anchors from surviving sessions ───────────────
    # Orphan sessions (their topic no longer exists) are garbage-collected
    # here — they would otherwise survive every rebuild and pollute the audit.
    all_current = database.get_all_sessions()
    day_load    = {}   # date_str → session count
    day_minutes = {}   # date_str → total scheduled minutes
    day_subj    = {}   # date_str → {subject: count} (interference term seed)
    anchor      = {}   # topic_id → date (committed current session)
    for s in all_current:
        if s['status'] != 'scheduled':
            continue
        if s['topic_id'] not in valid_ids:
            database.delete_session(s['id'])
            continue
        d = s['scheduled_date']
        if d < today.isoformat():
            continue
        reason     = s.get('reschedule_reason')
        is_today   = (d == today.isoformat())
        is_manual  = (reason == 'manual')
        is_skipped = (reason == 'skipped')
        is_extra   = (reason == 'extra')     # user-ADDED session on top of the plan
        # Sessions that would normally survive the rebuild (today's, and
        # skip-committed ones) must NOT survive on a day that has since been
        # blocked (day off / reduced above the topic's priority, or a topic
        # restriction). Without this, marking TODAY as a day off hid the
        # sessions from the Today list but left them visible on the calendar.
        # User-placed sessions (pins, extras) are exempt — the conflict dialog rules.
        if (is_today or is_skipped) and not (is_manual or is_extra):
            t = t_by_id.get(s['topic_id'])
            if t is not None:
                _cap, blocked = _effective_cap(date.fromisoformat(d), settings,
                                               special_dates, int(t.get('priority', 3)))
                if blocked or _is_restricted(d, t, t.get('subject', ''), restrictions):
                    database.delete_session(s['id'])
                    continue
        if is_today or is_manual or is_skipped or is_extra:
            day_load[d]    = day_load.get(d, 0) + 1
            day_minutes[d] = day_minutes.get(d, 0) + int(s.get('scheduled_duration', 25))
            sub = s.get('subject') or ''
            day_subj.setdefault(d, {})[sub] = day_subj.get(d, {}).get(sub, 0) + 1
        # Committed sessions (today's, a skip-reschedule, or a user-pinned MOVE)
        # anchor the topic: they ARE its next session, so no duplicate auto
        # Session 1 is generated. User-ADDED 'extra' sessions never anchor —
        # the topic keeps its full auto plan alongside them.
        if (is_today or is_skipped or is_manual) and not is_extra:
            dd = date.fromisoformat(d)
            if anchor.get(s['topic_id']) is None or dd < anchor[s['topic_id']]:
                anchor[s['topic_id']] = dd

    # Plan continuity: record where the PREVIOUS plan put each topic's future
    # auto sessions. The optimizer pays a switching cost (STICKINESS) to move
    # them, so replanning after every review no longer shuffles the calendar —
    # a session moves only when the improvement genuinely beats the disruption.
    prev_plan = {}
    for s in all_current:
        if (s['status'] == 'scheduled'
                and s.get('reschedule_reason') not in ('manual', 'skipped', 'missed', 'extra')
                and s['scheduled_date'] > today.isoformat()
                and s['topic_id'] in valid_ids):
            prev_plan.setdefault(s['topic_id'], []).append(s['scheduled_date'])
    for v in prev_plan.values():
        v.sort()

    # ── 2. Delete auto-scheduled future sessions ───────────────────────────
    database.delete_auto_scheduled_sessions(tomorrow.isoformat())

    # ── 3. Memory state → due date & triage urgency per topic ─────────────
    calib = memory.calibration_of(settings)

    candidates = []
    for topic in topics:
        d_mem, s_mem = memory.state_of(topic)
        p            = int(topic.get('priority', 3))
        exam_d, exam_imp = _nearest_exam_info(topic, exams, today)
        days_to_exam = (exam_d - today).days if exam_d else None
        r_target     = memory.desired_retention(base_r, p, days_to_exam, exam_imp)

        last_review = topic.get('last_review_date')
        if not last_review or s_mem is None:
            due, ivl, deficit = tomorrow, 1, 1.0      # new topic: start at once
            last_d = None
        else:
            last_d  = date.fromisoformat(last_review)
            ivl     = memory.interval_for_retention(s_mem * calib, r_target)
            due     = last_d + timedelta(days=ivl)
            elapsed = max(0, (today - last_d).days)
            r_now   = memory.retrievability(elapsed, s_mem * calib)
            deficit = max(0.0, r_target - r_now)      # how far past due already

        deadline = (exam_d - timedelta(days=1)) if exam_d else None
        if deadline and due > deadline >= tomorrow:
            due = deadline                             # guaranteed final pass
        if due < tomorrow:
            due = tomorrow

        candidates.append({
            'topic':     topic,
            'due':       due,
            'ivl':       ivl,
            'deficit':   deficit,
            'r_target':  r_target,
            'd_mem':     d_mem,
            's_mem':     s_mem,
            'last_d':    last_d,
            'deadline':  deadline,
            'exam_d':    exam_d,
            'exam_imp':  exam_imp,
        })

    candidates.sort(key=lambda c: (c['due'], -c['deficit']))

    # ── 4. Joint optimization over the horizon; direct placement beyond ────
    # Sessions due within the rolling horizon are planned TOGETHER by the
    # optimization engine (global objective: retention utility − workload
    # dispersion − fatigue − subject interference). Far-future sessions are
    # placed at their model due date and re-enter the horizon as it rolls
    # (receding-horizon control).
    horizon_days = [today + timedelta(days=k)
                    for k in range(1, optimizer.HORIZON_DAYS + 1)]
    horizon_end  = horizon_days[-1]
    goal = max(25, int(settings.get('daily_goal_minutes', 120)))

    day_states, caps = {}, {}
    for d in horizon_days:
        cstr = d.isoformat()
        cap, blocked = _effective_cap(d, settings, special_dates, 1)
        caps[d] = 0 if blocked else cap
        day_states[d] = {'mins':  day_minutes.get(cstr, 0),
                         'cload': day_minutes.get(cstr, 0),
                         'count': day_load.get(cstr, 0),
                         'subj':  dict(day_subj.get(cstr, {}))}

    def _eligible_days(topic, deadline, min_day=None):
        elig = set()
        for d in horizon_days:
            if min_day and d < min_day:
                continue
            _c, blocked = _effective_cap(d, settings, special_dates,
                                         int(topic.get('priority', 3)))
            if blocked or _is_restricted(d.isoformat(), topic,
                                         topic.get('subject', ''), restrictions):
                continue
            elig.add(d)
        if deadline:
            pre = {d for d in elig if d <= deadline}
            if pre:
                return pre     # hard: final pass stays before the exam
        return elig

    def _commit(topic, day):
        slot_str = day.isoformat()
        day_load[slot_str] = day_load.get(slot_str, 0) + 1
        dur = int(topic.get('session_duration') or settings.get('default_session_duration', 25))
        day_minutes[slot_str] = day_minutes.get(slot_str, 0) + dur
        database.add_session(_make_session(topic, slot_str, settings))

    def _place_batch(batch, min_days=None, ordinal=0):
        """Optimize in-horizon items jointly; _find_slot the rest. → {tid: day}"""
        opt_items, far, result = [], [], {}
        for c in batch:
            topic   = c['topic']
            min_day = (min_days or {}).get(topic['id'])
            if c['due'] <= horizon_end:
                elig = _eligible_days(topic, c['deadline'], min_day)
                if elig:
                    dur = int(topic.get('session_duration')
                              or settings.get('default_session_duration', 25))
                    prevs = prev_plan.get(topic['id'], [])
                    prev_day = (date.fromisoformat(prevs[ordinal])
                                if len(prevs) > ordinal else None)
                    opt_items.append({
                        'id': topic['id'], 'topic': topic,
                        'd_mem': c['d_mem'], 's_mem': c['s_mem'],
                        'last_d': c['last_d'],
                        'exam_d': c['exam_d'] if c['deadline'] else None,
                        'exam_imp': c.get('exam_imp', 2),
                        'duration': dur, 'eligible': elig,
                        'prev_day': prev_day,
                    })
                    continue
            far.append(c)

        placed = optimizer.optimize(opt_items, horizon_days, day_states, caps,
                                    goal, base_r, calib, today)
        by_id = {it['id']: it for it in opt_items}
        for tid, day in placed.items():
            result[tid] = day
            _commit(by_id[tid]['topic'], day)
        for it in opt_items:                    # horizon full → overflow forward
            if it['id'] not in placed:
                far.append(next(c for c in batch if c['topic']['id'] == it['id']))

        for c in far:
            topic   = c['topic']
            min_day = (min_days or {}).get(topic['id'])
            slot = _find_slot(c['due'], day_load, settings, special_dates, topic,
                              min_date=min_day, day_minutes=day_minutes,
                              restrictions=restrictions, interval_len=c['ivl'],
                              hard_deadline=c['deadline'])
            result[topic['id']] = slot
            _commit(topic, slot)
        return result

    s1_dates = {}
    s1_batch = []
    for c in candidates:
        if c['topic']['id'] in anchor:                 # committed session exists
            s1_dates[c['topic']['id']] = anchor[c['topic']['id']]
        else:
            s1_batch.append(c)
    s1_dates.update(_place_batch(s1_batch))

    # ── 5. Pass 2 — project state after S1 (assume "Good"), plan Session 2 ─
    s2_candidates, s2_min_days = [], {}
    for c in candidates:
        topic   = c['topic']
        s1_date = s1_dates[topic['id']]

        if c['s_mem'] is None or c['last_d'] is None:
            d2, s2_stab = memory.init_difficulty(3), memory.init_stability(3)
        else:
            elapsed_at_s1 = max(0, (s1_date - c['last_d']).days)
            d2, s2_stab   = memory.update_memory(c['d_mem'], c['s_mem'],
                                                 elapsed_at_s1, 3, calib)

        ivl2      = memory.interval_for_retention(s2_stab * calib, c['r_target'])
        s2_target = s1_date + timedelta(days=ivl2)
        s2_deadline = c['deadline']
        s2_min      = s1_date + timedelta(days=1)
        if s2_deadline:
            if s1_date < s2_deadline and s2_target > s2_deadline:
                # There is still room before the exam → squeeze a 2nd pre-exam pass.
                s2_target = s2_deadline
            elif s1_date >= s2_deadline:
                # S1 already IS the final pre-exam pass. S2 becomes post-exam
                # long-term maintenance: natural due date, never on exam day.
                s2_deadline = None
                if c['exam_d']:
                    s2_min = max(s2_min, c['exam_d'] + timedelta(days=1))
                    if s2_target <= c['exam_d']:
                        s2_target = c['exam_d'] + timedelta(days=1)

        s2_min_days[topic['id']] = s2_min
        s2_candidates.append({
            'topic':    topic,
            'due':      max(s2_target, s2_min),
            'ivl':      ivl2,
            'deficit':  c['deficit'] * 0.7,
            'r_target': c['r_target'],
            'd_mem':    (d2 if c['s_mem'] is not None else memory.init_difficulty(3)),
            's_mem':    s2_stab,
            'last_d':   s1_date,               # S2 utility measured from S1
            'deadline': s2_deadline,
            'exam_d':   c['exam_d'] if s2_deadline else None,
            'exam_imp': c.get('exam_imp', 2),
        })

    s2_candidates.sort(key=lambda c: (c['due'], -c['deficit']))
    _place_batch(s2_candidates, min_days=s2_min_days, ordinal=1)

    return True


# ── Single-session reschedule (skip) ───────────────────────────────────────────

def reschedule_one(topic, after_date, settings=None, special_dates=None, restrictions=None):
    """
    Push ONE session for `topic` forward to the next balanced open slot strictly
    after `after_date`, WITHOUT recomputing (and reshuffling) any other topic's
    schedule. The new session is tagged 'skipped' so a later full recalc leaves
    it in place. Returns the new date string.
    """
    if settings      is None: settings      = database.get_settings()
    if special_dates is None: special_dates = database.get_all_special_dates()
    if restrictions  is None: restrictions  = database.get_all_study_restrictions()

    today = date.today()
    day_load, day_minutes = {}, {}
    for s in database.get_all_sessions():
        if s['status'] != 'scheduled':
            continue
        d = s['scheduled_date']
        if d < today.isoformat():
            continue
        day_load[d]    = day_load.get(d, 0) + 1
        day_minutes[d] = day_minutes.get(d, 0) + int(s.get('scheduled_duration', 25))

    nxt  = date.fromisoformat(after_date) + timedelta(days=1)
    slot = _find_slot(nxt, day_load, settings, special_dates, topic,
                      min_date=nxt, day_minutes=day_minutes,
                      restrictions=restrictions, interval_len=1)
    slot_str = slot.isoformat()
    database.add_session(_make_session(topic, slot_str, settings, reason='skipped',
                                       is_rescheduled=True, original_date=after_date))
    return slot_str


# ── Missed-session processing ──────────────────────────────────────────────────

def process_missed_sessions(settings=None, special_dates=None):
    """
    Mark overdue sessions as missed, then bring each missed topic straight
    back onto TODAY as a catch-up session (reason='missed') — most fragile
    memory first — as long as today has room (cap, budget, blocked days and
    restrictions respected). Whatever doesn't fit is re-planned normally by
    the rebuild. Catch-ups are ordinary sessions: the user can complete,
    skip or pin them, and the scheduler anchors around them like any other
    committed session.

    Returns {'missed': [...], 'rescued': [{'topic_name', 'from'}, ...]}.
    """
    if settings      is None: settings      = database.get_settings()
    if special_dates is None: special_dates = database.get_all_special_dates()

    missed = database.get_missed_sessions()
    for s in missed:
        database.update_session(s['id'], {'status': 'missed'})
    if not missed:
        return {'missed': [], 'rescued': []}

    today  = date.today()
    tstr   = today.isoformat()
    topics = {t['id']: t for t in database.get_all_topics()}
    restrictions = database.get_all_study_restrictions()
    goal   = max(1, int(settings.get('daily_goal_minutes', 120)))

    todays     = [s for s in database.get_all_sessions()
                  if s['status'] == 'scheduled' and s['scheduled_date'] == tstr]
    day_count  = len(todays)
    day_mins   = sum(int(s.get('scheduled_duration', 25)) for s in todays)
    have_today = {s['topic_id'] for s in todays}

    # One catch-up per missed topic, most fragile memory first
    calib = memory.calibration_of(settings)
    def _fragility(tid):
        t = topics.get(tid)
        if not t:
            return 1.0
        _d, s_mem = memory.state_of(t)
        lr = t.get('last_review_date')
        if not s_mem or not lr:
            return 0.0                       # never studied → most urgent
        return memory.retrievability(max(0, (today - date.fromisoformat(lr)).days),
                                     s_mem * calib)

    queue, seen_topics = [], set()
    for s in sorted(missed, key=lambda x: _fragility(x['topic_id'])):
        if s['topic_id'] not in seen_topics:
            seen_topics.add(s['topic_id'])
            queue.append(s)

    rescued = []
    for s in queue:
        t = topics.get(s['topic_id'])
        if not t or t['id'] in have_today:
            continue
        cap, blocked = _effective_cap(today, settings, special_dates,
                                      int(t.get('priority', 3)))
        if blocked or day_count >= cap:
            continue                          # no room today — rebuild handles it
        if _is_restricted(tstr, t, t.get('subject', ''), restrictions):
            continue
        dur = int(t.get('session_duration') or settings.get('default_session_duration', 25))
        if day_mins + dur > goal * 1.5:       # catch-ups may stretch, not crush, today
            continue
        database.add_session(_make_session(t, tstr, settings, reason='missed',
                                           is_rescheduled=True,
                                           original_date=s['scheduled_date']))
        day_count += 1
        day_mins  += dur
        have_today.add(t['id'])
        rescued.append({'topic_name': t['name'], 'from': s['scheduled_date']})

    recalculate_schedule(settings, special_dates)
    return {'missed': missed, 'rescued': rescued}


# ── Exam readiness projection ──────────────────────────────────────────────────

def exam_readiness(exam, topics=None, sessions=None):
    """
    Predicted average recall (%) of the exam's material on exam morning.

    For each linked topic (explicit links, else the exam's subject) the
    memory state is projected forward: every review scheduled before the
    exam is simulated as "Good", then retrievability is read on exam day.
    Purely read-only — nothing is written or rescheduled.
    Returns 0-100, or None when the exam is past / has no resolvable topics.
    """
    today = date.today()
    try:
        exam_d = date.fromisoformat(exam['exam_date'])
    except (KeyError, ValueError):
        return None
    if exam_d < today:
        return None
    if topics   is None: topics   = database.get_all_topics()
    if sessions is None: sessions = database.get_all_sessions()
    calib = memory.calibration_of(database.get_settings())

    linked = _exam_topic_ids(exam)
    esubj  = (exam.get('subject') or '').strip().lower()
    if linked:
        pool = [t for t in topics if t['id'] in linked]
    elif esubj:
        pool = [t for t in topics if (t.get('subject') or '').strip().lower() == esubj]
    else:
        pool = list(topics)
    if not pool:
        return None

    upcoming = {}
    for s in sessions:
        if s['status'] != 'scheduled':
            continue
        if today.isoformat() <= s['scheduled_date'] < exam_d.isoformat():
            upcoming.setdefault(s['topic_id'], []).append(s['scheduled_date'])

    total = 0.0
    for t in pool:
        d_mem, s_mem = memory.state_of(t)
        last = (date.fromisoformat(t['last_review_date'])
                if t.get('last_review_date') else None)
        for ds in sorted(upcoming.get(t['id'], [])):
            rd = date.fromisoformat(ds)
            elapsed = max(0, (rd - last).days) if last else 0
            d_mem, s_mem = memory.update_memory(d_mem, s_mem, elapsed, 3, calib)
            last = rd
        if s_mem is None or last is None:
            r = 0.0        # never studied and nothing planned before the exam
        else:
            r = memory.retrievability(max(0, (exam_d - last).days), s_mem * calib)
        total += r
    return round(total / len(pool) * 100)


# ── Workout ↔ availability integration ─────────────────────────────────────────

def _blocked_for_workout(date_str, special_dates):
    """Workouts are blocked on full days off and on reduced days."""
    kind, _ = availability_for_date(date_str, special_dates)
    return kind in ('off', 'reduced')


def fix_workout_conflicts(settings=None, special_dates=None):
    """
    Move every planned workout that sits on a day off / reduced day to the
    next open day (skipping blocked days and days that already hold a planned
    workout of the same sport). Returns the list of moves.
    """
    if special_dates is None:
        special_dates = database.get_all_special_dates()

    today_str = date.today().isoformat()
    workouts  = database.get_all_fitness_workouts()
    taken = {}   # sport_id → set of dates already holding a planned workout
    for w in workouts:
        if w['status'] == 'planned' and w.get('scheduled_date'):
            taken.setdefault(w['sport_id'], set()).add(w['scheduled_date'])

    moved = []
    for w in workouts:
        d = w.get('scheduled_date')
        if w['status'] != 'planned' or not d or d < today_str:
            continue
        if not _blocked_for_workout(d, special_dates):
            continue
        cur, new_d = date.fromisoformat(d), None
        for off in range(1, 60):
            cstr = (cur + timedelta(days=off)).isoformat()
            if _blocked_for_workout(cstr, special_dates):
                continue
            if cstr in taken.get(w['sport_id'], set()):
                continue
            new_d = cstr
            break
        if new_d:
            database.update_fitness_workout(w['id'], {'scheduled_date': new_d})
            taken.setdefault(w['sport_id'], set()).add(new_d)
            taken[w['sport_id']].discard(d)
            moved.append({'id': w['id'], 'name': w.get('name', ''), 'from': d, 'to': new_d})
    return moved


def skip_workout(workout_id, special_dates=None):
    """
    Push ONE workout to the next open day (skipping blocked days and days
    already holding a planned workout of the same sport). Local move — no
    other workout or session is touched. Returns the new date string or None.
    """
    if special_dates is None:
        special_dates = database.get_all_special_dates()
    workouts = database.get_all_fitness_workouts()
    w = next((x for x in workouts if x['id'] == workout_id), None)
    if not w:
        return None
    taken = {x['scheduled_date'] for x in workouts
             if x['sport_id'] == w['sport_id'] and x['status'] == 'planned'
             and x.get('scheduled_date') and x['id'] != workout_id}
    start = date.today()
    if w.get('scheduled_date'):
        try:
            start = max(start, date.fromisoformat(w['scheduled_date']))
        except ValueError:
            pass
    for off in range(1, 60):
        cand = (start + timedelta(days=off)).isoformat()
        if _blocked_for_workout(cand, special_dates) or cand in taken:
            continue
        database.update_fitness_workout(workout_id, {'scheduled_date': cand})
        return cand
    return None


# ── Schedule audit (one-by-one integrity check) ────────────────────────────────

def audit_schedule(settings=None, special_dates=None, restrictions=None, exams=None):
    """
    Walk every future scheduled session one by one and report HARD violations
    only — things the optimizer never produces on its own, so a finding means
    outside circumstances changed and a rebuild will genuinely fix it:
      • a session on a blocked day (off, or reduced above its priority ceiling)
      • a session violating a topic/subject restriction
      • duplicate sessions for the same topic on the same day / orphans
      • days over the hard session cap, or grossly over budget (>1.5×)
    Pinned ('manual') sessions are the user's explicit choice — never flagged.
    Days inside a pre-exam crunch window (2 weeks before an upcoming exam) are
    exempt from saturation checks: packing extra reviews there is deliberate.
    Soft balance/imbalance judgements are NOT audited — they are the
    optimizer's objective, and second-guessing it here made every Refresh
    report the same phantom issues forever.
    Returns a list of human-readable issue strings (empty = all clear).
    """
    if settings      is None: settings      = database.get_settings()
    if special_dates is None: special_dates = database.get_all_special_dates()
    if restrictions  is None: restrictions  = database.get_all_study_restrictions()
    if exams         is None: exams         = database.get_all_exams()

    today_str = date.today().isoformat()
    goal      = max(1, int(settings.get('daily_goal_minutes', 120)))
    max_cap   = int(settings.get('max_sessions_per_day', 6))
    topics    = {t['id']: t for t in database.get_all_topics()}

    crunch = set()      # dates where exam cramming legitimately exceeds budget
    for e in exams:
        try:
            exam_d = date.fromisoformat(e['exam_date'])
        except (KeyError, ValueError):
            continue
        d = max(date.today(), exam_d - timedelta(days=14))
        while d < exam_d:
            crunch.add(d.isoformat())
            d += timedelta(days=1)

    issues = []
    day_count, day_mins = {}, {}
    per_topic_day = {}   # (topic_id, date) → [manual flags]

    for s in database.get_all_sessions():
        if s['status'] != 'scheduled':
            continue
        d = s['scheduled_date']
        if d <= today_str:                      # today's list is anchored as-is
            continue
        manual = s.get('reschedule_reason') in ('manual', 'extra')
        day_count[d] = day_count.get(d, 0) + 1
        day_mins[d]  = day_mins.get(d, 0) + int(s.get('scheduled_duration', 25))
        per_topic_day.setdefault((s['topic_id'], d), []).append(manual)

        if manual:
            continue
        t = topics.get(s['topic_id'])
        if not t:
            issues.append(f"orphan session '{s['topic_name']}' on {d}")
            continue
        p = int(t.get('priority', 3))
        _cap, blocked = _effective_cap(date.fromisoformat(d), settings, special_dates, p)
        if blocked:
            issues.append(f"'{s['topic_name']}' sits on a blocked day ({d})")
        if _is_restricted(d, t, t.get('subject', ''), restrictions):
            issues.append(f"'{s['topic_name']}' violates a restriction on {d}")

    for (tid, d), flags in per_topic_day.items():
        if len(flags) > 1 and not all(flags):
            name = topics.get(tid, {}).get('name', 'topic')
            issues.append(f"duplicate sessions for '{name}' on {d}")

    for d, n in day_count.items():
        # Real cap for that day (reduced days run at half capacity); priority 1
        # is the least restrictive, so blocked here means blocked for everyone.
        day_cap, blocked = _effective_cap(date.fromisoformat(d), settings, special_dates, 1)
        cap_for_day = max_cap if blocked else day_cap
        if n > cap_for_day:
            issues.append(f"{d} exceeds the session cap ({n}/{cap_for_day})")
    for d, m in day_mins.items():
        if d in crunch:
            continue
        if m > goal * 1.5 and day_count.get(d, 0) > 1:
            issues.append(f"{d} is grossly over-saturated ({m} min vs {goal} min goal)")

    return issues


# ── Fitness scheduling ─────────────────────────────────────────────────────────

def schedule_next_workout(sport, difficulty_0_10, settings, special_dates=None):
    """Apply SM-2 to a fitness sport after a completed workout."""
    if special_dates is None:
        special_dates = database.get_all_special_dates()

    sm2 = calculate_sm2(
        sport.get('ease_factor', 2.5),
        sport.get('interval', 2),
        sport.get('repetitions', 0),
        difficulty_0_10,
    )
    database.update_fitness_sport(sport['id'], {
        'ease_factor': sm2['ease_factor'],
        'interval':    sm2['interval'],
        'repetitions': sm2['repetitions'],
    })

    target = date.today() + timedelta(days=max(1, sm2['interval']))
    for offset in range(14):
        candidate = target + timedelta(days=offset)
        if _blocked_for_workout(candidate.isoformat(), special_dates):
            continue
        return candidate.isoformat()
    return (date.today() + timedelta(days=2)).isoformat()
