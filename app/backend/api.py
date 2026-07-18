"""
Pharaon API — exposed to JavaScript via window.pywebview.api.*
"""

import os
import uuid
import functools
import traceback
import json as _json
from datetime import datetime, date
from backend import database, scheduler, autostart, memory
from backend.version import APP_VERSION

SUPPORT_EMAIL = 'support.pharaon@gmail.com'


def log_error(context, exc_text=None):
    """Append an error report to %APPDATA%/Pharaon/logs/error.log (best-effort)."""
    try:
        log_dir = os.path.join(os.path.dirname(database.get_db_path()), 'logs')
        os.makedirs(log_dir, exist_ok=True)
        with open(os.path.join(log_dir, 'error.log'), 'a', encoding='utf-8') as f:
            f.write('\n[%s] v%s — %s\n%s' % (
                datetime.now().isoformat(), APP_VERSION, context,
                exc_text if exc_text is not None else traceback.format_exc()))
    except Exception:
        pass


PALETTE = [
    '#337EA9','#9065B0','#D44C47','#448361',
    '#CB912F','#D9730D','#C14C8A','#2F7E79',
    '#40566D','#9F6B53','#6E7F3E','#787774',
]

FITNESS_PALETTE = [
    '#9065B0','#C14C8A','#D9730D','#448361',
    '#337EA9','#D44C47','#CB912F','#40566D',
]


class API:
    def __init__(self):
        self._window = None
        # Global error handling: every public endpoint logs its traceback to
        # the error log before the exception reaches the UI (where the api
        # proxy shows a toast). Support diagnoses from the log file.
        for _name in dir(self):
            if _name.startswith('_'):
                continue
            _fn = getattr(self, _name)
            if callable(_fn):
                setattr(self, _name, self._logged(_fn))

    @staticmethod
    def _logged(fn):
        @functools.wraps(fn)
        def wrapped(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except Exception:
                log_error('api.%s' % fn.__name__)
                raise
        return wrapped

    # ── External links (support / bug reports) ────────────

    def open_external(self, url):
        """Open a mailto:/https: link with the system default handler."""
        import webbrowser
        if not isinstance(url, str) or not url.startswith(('mailto:', 'https://')):
            return {'success': False, 'error': 'blocked'}
        webbrowser.open(url)
        return {'success': True}

    def get_support_info(self):
        return {'email': SUPPORT_EMAIL, 'version': APP_VERSION}

    # ── Window ────────────────────────────────────────────

    def minimize_window(self):
        try: self._window.minimize()
        except Exception: pass

    def maximize_window(self):
        try: self._window.maximize()
        except Exception: pass

    def close_window(self):
        try: self._window.destroy()
        except Exception: pass

    # ── Topics ────────────────────────────────────────────

    def get_topics(self):
        topics = database.get_all_topics()
        exams  = database.get_all_exams()
        today  = date.today()
        calib  = memory.calibration_of(database.get_settings())
        for t in topics:
            d_mem, s_mem = memory.state_of(t)
            lv = memory.level_info(s_mem, t.get('repetitions'))
            t['level'], t['level_tier'] = lv['name'], lv['tier']
            t['stability'] = round(s_mem, 1) if s_mem else None
            lr = t.get('last_review_date')
            if s_mem and lr:
                elapsed = max(0, (today - date.fromisoformat(lr)).days)
                t['retention'] = round(memory.retrievability(elapsed, s_mem * calib) * 100)
            else:
                t['retention'] = None
            t['exam_pressure'] = scheduler.exam_pressure(t, exams)
        return topics

    def add_topic(self, data):
        settings  = database.get_settings()
        s_colors  = settings.get('subject_colors') or {}
        if isinstance(s_colors, str):
            import json; s_colors = json.loads(s_colors)

        subject = data.get('subject', 'General')
        if subject not in s_colors:
            s_colors[subject] = PALETTE[len(s_colors) % len(PALETTE)]
            database.update_settings({'subject_colors': s_colors})

        raw_dur = data.get('session_duration')
        topic = {
            'id':               str(uuid.uuid4()),
            'name':             data['name'],
            'subject':          subject,
            'priority':         int(data.get('priority', 3)),
            'description':      data.get('description', ''),
            'color':            s_colors[subject],
            'ease_factor':      2.5,
            'interval':         1,
            'repetitions':      0,
            'next_review_date': None,
            'session_duration': int(raw_dur) if raw_dur else None,
            'created_at':       datetime.now().isoformat(),
        }
        database.add_topic(topic)
        scheduler.recalculate_schedule(settings)
        return {'success': True, 'topic': topic}

    def update_topic(self, topic_id, data):
        allowed = {'name', 'subject', 'priority', 'description', 'session_duration'}
        updates = {k: v for k, v in data.items() if k in allowed}
        database.update_topic(topic_id, updates)
        if 'priority' in updates or 'session_duration' in updates:
            scheduler.recalculate_schedule()
        return {'success': True}

    def delete_topic(self, topic_id):
        database.delete_topic(topic_id)
        scheduler.recalculate_schedule()   # cleans up orphaned future sessions
        return {'success': True}

    def get_topic_sessions(self, topic_id):
        return database.get_sessions_for_topic(topic_id)

    # ── Sessions ──────────────────────────────────────────

    def _session_why(self, s, topics, exams, calib):
        """One human-readable sentence: WHY this session sits on its day."""
        reason = s.get('reschedule_reason')
        if reason == 'manual':
            return 'Pinned by you — the planner works around it'
        if reason == 'extra':
            return 'Added by you — extra practice on top of the plan'
        if reason == 'missed':
            return f"Catch-up — missed on {s.get('original_date') or 'a previous day'}"
        if reason == 'skipped':
            return 'Moved here when you skipped it'
        t = topics.get(s['topic_id'])
        if not t:
            return ''
        try:
            sched = date.fromisoformat(s['scheduled_date'])
        except (TypeError, ValueError):
            return ''
        exam_d, _imp = scheduler._nearest_exam_info(t, exams, date.today())
        if exam_d and sched < exam_d and (exam_d - sched).days <= 14:
            n = (exam_d - sched).days
            return f'Exam preparation — {n} day{"s" if n != 1 else ""} before the exam'
        d_mem, s_mem = memory.state_of(t)
        lr = t.get('last_review_date')
        if s_mem and lr:
            elapsed = max(0, (sched - date.fromisoformat(lr)).days)
            r = memory.retrievability(elapsed, s_mem * calib)
            return (f'Optimal timing — recall will be ≈{round(r * 100)}% here, '
                    'the sweet spot where reviewing strengthens memory most')
        return 'First session — starts the memory clock for this topic'

    def _attach_why(self, sessions):
        topics = {t['id']: t for t in database.get_all_topics()}
        exams  = database.get_all_exams()
        try:
            calib = float(database.get_settings().get('memory_calibration', 1.0) or 1.0)
        except (TypeError, ValueError):
            calib = 1.0
        for s in sessions:
            s['why'] = self._session_why(s, topics, exams, calib) \
                       if s.get('status') == 'scheduled' else ''
        return sessions

    def get_sessions(self):
        return self._attach_why(database.get_all_sessions())

    def get_today_sessions(self):
        sessions  = database.get_today_sessions()
        today_str = date.today().strftime('%Y-%m-%d')
        # Aggregate ALL availability entries covering today (strictest wins),
        # so overlapping entries can't mask a full day off.
        kind, max_p = scheduler.availability_for_date(
            today_str, database.get_all_special_dates())
        if kind == 'off':
            return []
        topics = {t['id']: t for t in database.get_all_topics()}
        if kind == 'reduced':
            sessions = [
                s for s in sessions
                if topics.get(s['topic_id'], {}).get('priority', 99) <= max_p
            ]

        # Fragility triage: most at-risk memories first (lowest retrievability).
        today = date.today()
        calib = memory.calibration_of(database.get_settings())
        def _fragility(s):
            t = topics.get(s['topic_id'])
            if not t:
                return 1.0
            _d, s_mem = memory.state_of(t)
            lr = t.get('last_review_date')
            if not s_mem or not lr:
                return 0.0                     # new topic → learn first
            elapsed = max(0, (today - date.fromisoformat(lr)).days)
            return memory.retrievability(elapsed, s_mem * calib)
        sessions.sort(key=lambda s: (s['status'] == 'completed', _fragility(s)))
        return self._attach_why(sessions)

    def get_sessions_for_date(self, date_str):
        return database.get_sessions_for_date(date_str)

    def get_sessions_in_range(self, start_date, end_date):
        return database.get_sessions_in_range(start_date, end_date)

    def complete_session(self, session_id, rating, notes=''):
        """rating: 0-10"""
        all_sessions = database.get_all_sessions()
        session = next((s for s in all_sessions if s['id'] == session_id), None)
        if not session:
            return {'success': False, 'error': 'Session not found'}

        now = datetime.now()
        database.update_session(session_id, {
            'status':         'completed',
            'completed_date': now.isoformat(),
            'rating':         int(rating),
            'notes':          notes,
        })

        topic = database.get_topic(session['topic_id'])
        if not topic:
            return {'success': True}

        # DSR memory update (FSRS): grade from rating, elapsed real time since
        # the last review — reviewing late/early is accounted for naturally.
        grade  = memory.grade_from_rating(int(rating))
        d_mem, s_mem = memory.state_of(topic)
        lr = topic.get('last_review_date')
        elapsed = max(0, (date.today() - date.fromisoformat(lr)).days) if lr else 0
        k = memory.calibration_of(database.get_settings())
        d_new, s_new = memory.update_memory(d_mem, s_mem, elapsed, grade, k)
        reps = 0 if grade == 1 else int(topic.get('repetitions') or 0) + 1

        # Online calibration: one gradient step on the gap between predicted
        # recall and the observed outcome — the engine learns the user.
        if s_mem is not None and lr:
            predicted = memory.retrievability(elapsed, s_mem * k)
            k_new = memory.calibration_step(k, predicted, grade >= 2)
            database.update_settings({'memory_calibration': round(k_new, 4)})

        database.update_topic(topic['id'], {
            'stability':        round(s_new, 4),
            'difficulty':       round(d_new, 4),
            'interval':         max(1, round(s_new)),   # legacy mirror
            'repetitions':      reps,
            'last_review_date': now.strftime('%Y-%m-%d'),
            'last_rating':      int(rating),
        })

        settings = database.get_settings()
        scheduler.recalculate_schedule(settings)

        # Fetch the next scheduled session for this topic to report it
        all_sessions  = database.get_all_sessions()
        next_s = next(
            (s for s in all_sessions
             if s['topic_id'] == topic['id'] and s['status'] == 'scheduled'),
            None
        )
        lv = memory.level_info(s_new, reps)
        return {
            'success':      True,
            'next_review':  next_s['scheduled_date'] if next_s else None,
            'new_interval': max(1, round(s_new)),
            'level':        lv['name'],
            'level_tier':   lv['tier'],
            'stability':    round(s_new, 1),
        }

    def skip_session(self, session_id):
        """
        Push a session to the next open day. This is a LOCAL move — only this
        topic is affected; everyone else's schedule stays exactly where it is.
        The original slot stays visible as a greyed 'rescheduled' marker.
        """
        all_sessions = database.get_all_sessions()
        session = next((s for s in all_sessions if s['id'] == session_id), None)
        if not session:
            return {'success': False}
        database.update_session(session_id, {'status': 'skipped'})
        topic = database.get_topic(session['topic_id'])
        if not topic:
            return {'success': True, 'rescheduled_to': None}
        new_date = scheduler.reschedule_one(topic, session['scheduled_date'])
        return {'success': True, 'rescheduled_to': new_date}

    def unskip_session(self, session_id):
        """
        Undo a skip: delete the forward session it created and restore the
        original session to its day. Purely local — nothing else is touched.
        """
        all_sessions = database.get_all_sessions()
        ghost = next((s for s in all_sessions if s['id'] == session_id), None)
        if not ghost:
            return {'success': False}
        # Remove the forward reschedule this skip created (linked by reason + day).
        for s in all_sessions:
            if (s['id'] != session_id
                    and s['topic_id'] == ghost['topic_id']
                    and s['status'] == 'scheduled'
                    and s.get('reschedule_reason') == 'skipped'
                    and s.get('original_date') == ghost['scheduled_date']):
                database.delete_session(s['id'])
        today_str = date.today().strftime('%Y-%m-%d')
        # Restore the session's ORIGINAL nature: a skipped pin stays a pin,
        # a skipped extra stays an extra — only plain auto sessions reset.
        prior = ghost.get('reschedule_reason')
        if prior in ('manual', 'extra', 'missed'):
            updates = {'status': 'scheduled'}
        else:
            updates = {'status': 'scheduled', 'is_rescheduled': 0,
                       'reschedule_reason': None}
        # If the skipped day has already passed, bring it back onto today.
        if ghost['scheduled_date'] < today_str:
            updates['scheduled_date'] = today_str
        database.update_session(session_id, updates)
        return {'success': True}

    def schedule_manual_session(self, topic_id, date_str, time_str=None):
        """
        ADD an extra session on a specific date, on top of the topic's normal
        plan. Unlike a pin (move), the topic's auto sessions REMAIN — the
        planner simply rebuilds around the new fixed load, so other sessions
        may shift if the day's balance changed.
        """
        topic    = database.get_topic(topic_id)
        settings = database.get_settings()
        if not topic:
            return {'success': False, 'error': 'Topic not found'}
        import uuid as _uuid
        dur = int(topic.get('session_duration') or settings.get('default_session_duration', 25))
        session = {
            'id':                str(_uuid.uuid4()),
            'topic_id':          topic_id,
            'topic_name':        topic['name'],
            'subject':           topic.get('subject', ''),
            'scheduled_date':    date_str,
            'scheduled_time':    time_str,
            'scheduled_duration': dur,
            'status':            'scheduled',
            'is_rescheduled':    0,
            'original_date':     date_str,
            'reschedule_reason': 'extra',
            'created_at':        datetime.now().isoformat(),
        }
        database.add_session(session)
        scheduler.recalculate_schedule()   # the plan absorbs the new fixed load
        return {'success': True, 'session': session}

    def delete_session(self, session_id):
        database.delete_session(session_id)
        return {'success': True}

    def reschedule_session(self, session_id, date_str, time_str=None):
        """
        Pin a session to a user-chosen date. Pinned ('manual') sessions are
        never moved by the scheduler; the rest of the plan — every topic —
        is rebuilt around them.
        """
        database.update_session(session_id, {
            'scheduled_date': date_str,
            'scheduled_time': time_str or None,
            'is_rescheduled': 1,
            'reschedule_reason': 'manual',
        })
        scheduler.recalculate_schedule()
        return {'success': True}

    def set_session_time(self, session_id, time_str):
        database.update_session(session_id, {'scheduled_time': time_str or None})
        return {'success': True}

    def check_missed_sessions(self):
        settings      = database.get_settings()
        special_dates = database.get_all_special_dates()
        res = scheduler.process_missed_sessions(settings, special_dates)
        return {'count':         len(res['missed']),
                'rescued_today': len(res['rescued']),
                'names':         [r['topic_name'] for r in res['rescued']]}

    # ── Exams ─────────────────────────────────────────────

    def get_exams(self):
        exams    = database.get_all_exams()
        today_d  = date.today()
        topics   = database.get_all_topics()
        sessions = database.get_all_sessions()
        for e in exams:
            try:
                ed = datetime.strptime(e['exam_date'], '%Y-%m-%d').date()
                e['days_until'] = (ed - today_d).days
                e['is_past']    = e['days_until'] < 0
            except (ValueError, KeyError):
                e['days_until'] = None
                e['is_past']    = False
            e['readiness'] = (scheduler.exam_readiness(e, topics, sessions)
                              if not e['is_past'] else None)
        return exams

    def add_exam(self, data):
        exam = {
            'id':         str(uuid.uuid4()),
            'name':       data['name'],
            'subject':    data.get('subject', ''),
            'exam_date':  data['exam_date'],
            'importance': int(data.get('importance', 2)),
            'topic_ids':  data.get('topic_ids', []),
            'notes':      data.get('notes', ''),
            'created_at': datetime.now().isoformat(),
        }
        database.add_exam(exam)
        scheduler.recalculate_schedule()
        return {'success': True, 'exam': exam}

    def update_exam(self, exam_id, data):
        allowed = {'name', 'subject', 'exam_date', 'importance', 'topic_ids', 'notes'}
        database.update_exam(exam_id, {k: v for k, v in data.items() if k in allowed})
        scheduler.recalculate_schedule()
        return {'success': True}

    def delete_exam(self, exam_id):
        database.delete_exam(exam_id)
        scheduler.recalculate_schedule()
        return {'success': True}

    def recalculate_schedule(self):
        """Manually trigger a full schedule rebuild from the UI."""
        scheduler.recalculate_schedule()
        return {'success': True}

    # ── Flashcards ────────────────────────────────────────

    def get_flashcards(self):
        return database.get_all_flashcards()

    def add_flashcard(self, data):
        today = date.today().strftime('%Y-%m-%d')
        card  = {
            'id':               str(uuid.uuid4()),
            'question':         data['question'],
            'answer':           data['answer'],
            'subject':          data.get('subject', ''),
            'topic_id':         data.get('topic_id', ''),
            'ease_factor':      2.5,
            'interval':         1,
            'repetitions':      0,
            'next_review_date': today,
            'last_review_date': None,
            'created_at':       datetime.now().isoformat(),
        }
        database.add_flashcard(card)
        return {'success': True, 'card': card}

    def update_flashcard(self, card_id, data):
        allowed = {'question', 'answer', 'subject', 'topic_id'}
        database.update_flashcard(card_id, {k: v for k, v in data.items() if k in allowed})
        return {'success': True}

    def delete_flashcard(self, card_id):
        database.delete_flashcard(card_id)
        return {'success': True}

    def rate_flashcard(self, card_id, correct):
        cards = database.get_all_flashcards()
        card  = next((c for c in cards if c['id'] == card_id), None)
        if not card:
            return {'success': False}

        rating  = 10 if correct else 0
        sm2     = scheduler.calculate_sm2(
            card['ease_factor'], card['interval'], card['repetitions'], rating
        )
        from datetime import timedelta as _td
        next_date = (date.today() + _td(days=sm2['interval'])).strftime('%Y-%m-%d')

        database.update_flashcard(card_id, {
            'ease_factor':      sm2['ease_factor'],
            'interval':         sm2['interval'],
            'repetitions':      sm2['repetitions'],
            'next_review_date': next_date,
            'last_review_date': date.today().strftime('%Y-%m-%d'),
            'last_correct':     1 if correct else 0,
            'times_shown':      int(card.get('times_shown', 0)) + 1,
            'times_correct':    int(card.get('times_correct', 0)) + (1 if correct else 0),
        })
        return {'success': True, 'next_review': next_date}

    # ── Special Dates ─────────────────────────────────────

    def get_special_dates(self):
        return database.get_all_special_dates()

    def add_special_date(self, data):
        sd = {
            'id':           str(uuid.uuid4()),
            'name':         data['name'],
            'start_date':   data['start_date'],
            'end_date':     data.get('end_date', data['start_date']),
            'date_type':    data.get('date_type', 'reduced'),
            'max_priority': int(data.get('max_priority', 2)),
            'start_time':   data.get('start_time') or None,
            'end_time':     data.get('end_time') or None,
            'created_at':   datetime.now().isoformat(),
        }
        database.add_special_date(sd)
        scheduler.recalculate_schedule()
        moved = scheduler.fix_workout_conflicts()
        return {'success': True, 'special_date': sd, 'workouts_moved': len(moved)}

    def update_special_date(self, sd_id, data):
        allowed = {'name', 'start_date', 'end_date', 'date_type', 'max_priority', 'start_time', 'end_time'}
        database.update_special_date(sd_id, {k: v for k, v in data.items() if k in allowed})
        scheduler.recalculate_schedule()
        moved = scheduler.fix_workout_conflicts()
        return {'success': True, 'workouts_moved': len(moved)}

    def delete_special_date(self, sd_id):
        database.delete_special_date(sd_id)
        scheduler.recalculate_schedule()
        return {'success': True}

    def get_manual_conflicts(self, start_date, end_date, date_type='off', max_priority=2):
        """Pinned (manual) sessions that fall inside a newly blocked date range."""
        topics    = {t['id']: t for t in database.get_all_topics()}
        today_str = date.today().isoformat()
        out = []
        for s in database.get_all_sessions():
            if s['status'] != 'scheduled' or s.get('reschedule_reason') not in ('manual', 'extra'):
                continue
            d = s['scheduled_date']
            if d < today_str or not (start_date <= d <= end_date):
                continue
            if date_type == 'reduced':
                p = int(topics.get(s['topic_id'], {}).get('priority', 3))
                if p <= int(max_priority):
                    continue           # still allowed on a reduced day
            out.append({'id': s['id'], 'topic_name': s['topic_name'],
                        'date': d, 'time': s.get('scheduled_time')})
        return out

    def release_sessions(self, session_ids):
        """
        Un-pin the given sessions (user chose to let the AI move them).
        They become auto-scheduled again and the whole plan is rebuilt.
        """
        ids = session_ids or []
        for sid in ids:
            database.update_session(sid, {'reschedule_reason': None, 'is_rescheduled': 0})
        if ids:
            scheduler.recalculate_schedule()
        return {'success': True, 'released': len(ids)}

    # ── Deep refresh (integrity pass) ─────────────────────

    def deep_refresh(self):
        """
        Full integrity pass, run when the user hits Refresh:
          1. roll overdue sessions forward,
          2. move workouts off blocked days,
          3. audit every scheduled item one by one (conflicts, over-/under-
             saturated days) and rebuild the whole schedule if anything is off.
        """
        settings = database.get_settings()
        special  = database.get_all_special_dates()
        restr    = database.get_all_study_restrictions()

        report = []
        mres   = scheduler.process_missed_sessions(settings, special)
        if mres['missed']:
            note = f"{len(mres['missed'])} overdue session(s) rescheduled"
            if mres['rescued']:
                note += f" ({len(mres['rescued'])} brought back today)"
            report.append(note)
        moved = scheduler.fix_workout_conflicts(settings, special)
        if moved:
            report.append(f"{len(moved)} workout(s) moved off blocked days")
        problems = scheduler.audit_schedule(settings, special, restr)
        remaining = []
        if problems:
            scheduler.recalculate_schedule(settings, special, restrictions=restr)
            # Verify the rebuild actually cleared what was flagged — never
            # claim a fix that didn't happen.
            remaining = scheduler.audit_schedule(settings, special, restr)
            fixed = len(problems) - len(remaining)
            if fixed > 0:
                report.append(f"{fixed} scheduling issue(s) found and fixed")
            if remaining:
                report.append(f"{len(remaining)} conflict(s) need your attention "
                              "(pinned sessions or unsatisfiable constraints)")
        return {'ok': not report, 'report': report, 'problems': remaining or problems}

    # ── Subject colors ────────────────────────────────────

    def update_subject_color(self, subject, color):
        settings = database.get_settings()
        s_colors = settings.get('subject_colors') or {}
        if isinstance(s_colors, str):
            s_colors = _json.loads(s_colors)
        s_colors[subject] = color
        database.update_settings({'subject_colors': s_colors})
        for t in database.get_all_topics():
            if t.get('subject') == subject:
                database.update_topic(t['id'], {'color': color})
        return {'success': True}

    # ── Study Restrictions ────────────────────────────────

    def get_study_restrictions(self):
        return database.get_all_study_restrictions()

    def add_study_restriction(self, data):
        r = {
            'id':         str(uuid.uuid4()),
            'name':       data.get('name', ''),
            'scope':      data.get('scope', 'subject'),
            'subject':    data.get('subject'),
            'topic_id':   data.get('topic_id'),
            'topic_name': data.get('topic_name'),
            'start_date': data['start_date'],
            'end_date':   data.get('end_date') or data['start_date'],
            'created_at': datetime.now().isoformat(),
        }
        database.add_study_restriction(r)
        scheduler.recalculate_schedule()
        return {'success': True, 'restriction': r}

    def delete_study_restriction(self, rid):
        database.delete_study_restriction(rid)
        scheduler.recalculate_schedule()
        return {'success': True}

    # ── Settings ──────────────────────────────────────────

    def get_settings(self):
        s = database.get_settings()
        s['auto_start_actual'] = autostart.is_autostart_enabled()
        return s

    def update_settings(self, updates):
        if 'auto_start' in updates:
            autostart.set_autostart(bool(updates['auto_start']))
        database.update_settings(updates)
        if any(k in updates for k in
               ('max_sessions_per_day', 'daily_goal_minutes', 'desired_retention')):
            scheduler.recalculate_schedule()
        return {'success': True, 'settings': database.get_settings()}

    # ── Version ───────────────────────────────────────────

    def get_version(self):
        return APP_VERSION

    # ── Tutorial ──────────────────────────────────────────

    def mark_tutorial_done(self):
        database.update_settings({'first_run': False})
        return {'success': True}

    # ── Undo helpers ──────────────────────────────────────

    def restore_topic(self, topic_data, sessions_data):
        """Re-insert a deleted topic and its sessions (undo support)."""
        database.restore_topic(topic_data)
        for sess in (sessions_data or []):
            database.restore_session(sess)
        scheduler.recalculate_schedule()
        return {'success': True}

    def restore_session(self, session_data):
        """Re-insert a deleted session (undo support)."""
        database.restore_session(session_data)
        return {'success': True}

    # ── Export / Import ───────────────────────────────────

    def export_data(self):
        """Return the full database as a JSON-serialisable dict."""
        settings = database.get_settings()
        # Remove device-specific keys from export
        for key in ('auto_start', 'auto_start_actual', 'first_run'):
            settings.pop(key, None)
        return {
            'pharaon_version':    APP_VERSION,
            'exported_at':        datetime.now().isoformat(),
            'topics':             database.get_all_topics(),
            'sessions':           database.get_all_sessions(),
            'exams':              database.get_all_exams(),
            'flashcards':         database.get_all_flashcards(),
            'special_dates':      database.get_all_special_dates(),
            'study_restrictions': database.get_all_study_restrictions(),
            'fitness_sports':     database.get_all_fitness_sports(),
            'fitness_workouts':   database.get_all_fitness_workouts(),
            'fitness_exercises':  database.get_all_fitness_exercises(),
            'settings':           settings,
        }

    def auto_backup(self, keep=7):
        """
        Silent daily safety net: write a full JSON backup next to the database
        (%APPDATA%/Pharaon/backups), one file per day, keeping the last `keep`.
        Called on every app start.
        """
        import os
        try:
            data = self.export_data()
            backup_dir = os.path.join(os.path.dirname(database.get_db_path()), 'backups')
            os.makedirs(backup_dir, exist_ok=True)
            fname = os.path.join(backup_dir, f'pharaon-backup-{date.today().isoformat()}.json')
            if not os.path.exists(fname):
                with open(fname, 'w', encoding='utf-8') as f:
                    f.write(_json.dumps(data, ensure_ascii=False))
            files = sorted(f for f in os.listdir(backup_dir)
                           if f.startswith('pharaon-backup-') and f.endswith('.json'))
            for old in files[:-keep]:
                os.remove(os.path.join(backup_dir, old))
            return {'success': True, 'file': fname}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def import_data(self, json_str):
        """Replace all user data with the contents of a JSON backup string."""
        try:
            data = _json.loads(json_str)
        except Exception as e:
            return {'success': False, 'error': f'Invalid JSON: {e}'}

        database.clear_all_data()

        restored = {'topics': 0, 'sessions': 0}
        for t in data.get('topics', []):
            try:
                database.restore_topic(t)
                restored['topics'] += 1
            except Exception:
                pass
        for s in data.get('sessions', []):
            try:
                database.restore_session(s)
                restored['sessions'] += 1
            except Exception:
                pass
        for e in data.get('exams', []):
            try:
                database.add_exam(e)
            except Exception:
                pass
        for f in data.get('flashcards', []):
            try:
                database.add_flashcard(f)
            except Exception:
                pass
        for sd in data.get('special_dates', []):
            try:
                database.add_special_date(sd)
            except Exception:
                pass
        for r in data.get('study_restrictions', []):
            try:
                database.add_study_restriction(r)
            except Exception:
                pass
        for sp in data.get('fitness_sports', []):
            try:
                database.add_fitness_sport(sp)
            except Exception:
                pass
        for w in data.get('fitness_workouts', []):
            try:
                database.add_fitness_workout(w)
                if w.get('difficulty') is not None:
                    database.update_fitness_workout(w['id'], {'difficulty': w['difficulty']})
            except Exception:
                pass
        for ex in data.get('fitness_exercises', []):
            try:
                database.add_fitness_exercise(ex)
            except Exception:
                pass
        if 'settings' in data:
            skip = {'first_run', 'auto_start', 'auto_start_actual'}
            safe = {k: v for k, v in data['settings'].items() if k not in skip}
            if safe:
                database.update_settings(safe)

        return {'success': True, **restored}

    # ── Stats ─────────────────────────────────────────────

    def get_stats(self):
        sessions  = database.get_all_sessions()
        topics    = database.get_all_topics()
        today_s   = date.today().strftime('%Y-%m-%d')

        streak     = scheduler.get_study_streak(sessions)
        completed  = [s for s in sessions if s['status'] == 'completed']
        today_c    = [s for s in completed if (s.get('completed_date') or '').startswith(today_s)]
        mastered   = sum(1 for t in topics
                         if memory.level_info(memory.state_of(t)[1], t.get('repetitions'))['tier'] >= 4)

        today_sched   = [s for s in sessions
                         if s['scheduled_date'] == today_s and s['status'] != 'missed']
        today_done    = [s for s in today_sched if s['status'] == 'completed']
        today_all_done = len(today_sched) > 0 and len(today_done) == len(today_sched)

        return {
            'streak':          streak,
            'today_all_done':  today_all_done,
            'total_completed': len(completed),
            'today_completed': len(today_c),
            'today_scheduled': len(today_sched),
            'total_topics':    len(topics),
            'mastered_topics': mastered,
        }

    # ── Fitness ───────────────────────────────────────────

    def get_fitness_sports(self):
        sports = database.get_all_fitness_sports()
        for sp in sports:
            workouts = database.get_workouts_for_sport(sp['id'])
            sp['workout_count'] = len(workouts)
            sp['next_workout']  = next((w['scheduled_date'] for w in workouts
                                        if w['status'] == 'planned'
                                        and (w['scheduled_date'] or '') >= date.today().isoformat()), None)
        return sports

    def add_fitness_sport(self, data):
        existing = database.get_all_fitness_sports()
        color    = FITNESS_PALETTE[len(existing) % len(FITNESS_PALETTE)]
        sport    = {
            'id':               str(uuid.uuid4()),
            'name':             data['name'],
            'color':            data.get('color', color),
            'icon':             data.get('icon', '💪'),
            'show_in_calendar': 1 if data.get('show_in_calendar', True) else 0,
            'use_scheduling':   1 if data.get('use_scheduling', False) else 0,
            'ease_factor':      2.5,
            'interval':         2,
            'repetitions':      0,
            'notes':            data.get('notes', ''),
            'created_at':       datetime.now().isoformat(),
        }
        database.add_fitness_sport(sport)
        return {'success': True, 'sport': sport}

    def update_fitness_sport(self, sport_id, data):
        allowed = {'name', 'color', 'icon', 'show_in_calendar', 'use_scheduling', 'notes'}
        database.update_fitness_sport(sport_id, {k: v for k, v in data.items() if k in allowed})
        return {'success': True}

    def delete_fitness_sport(self, sport_id):
        database.delete_fitness_sport(sport_id)
        return {'success': True}

    def get_fitness_workouts(self, sport_id):
        workouts = database.get_workouts_for_sport(sport_id)
        for w in workouts:
            w['exercises'] = database.get_exercises_for_sport(sport_id, w['id'])
        return workouts

    def get_all_fitness_workouts(self):
        workouts = database.get_all_fitness_workouts()
        for w in workouts:
            w['exercise_count'] = len(database.get_exercises_for_sport(w['sport_id'], w['id']))
        return workouts

    def add_fitness_workout(self, data):
        workout = {
            'id':             str(uuid.uuid4()),
            'sport_id':       data['sport_id'],
            'name':           data.get('name', ''),
            'scheduled_date': data.get('scheduled_date') or None,
            'scheduled_time': data.get('scheduled_time') or None,
            'duration':       int(data.get('duration', 60)),
            'status':         'planned',
            'notes':          data.get('notes', ''),
            'created_at':     datetime.now().isoformat(),
        }
        database.add_fitness_workout(workout)
        return {'success': True, 'workout': workout}

    def update_fitness_workout(self, workout_id, data):
        allowed = {'name', 'scheduled_date', 'scheduled_time', 'duration', 'status', 'difficulty', 'notes'}
        updates = {k: v for k, v in data.items() if k in allowed}
        database.update_fitness_workout(workout_id, updates)

        # If completed with difficulty and sport uses scheduling, compute next
        if data.get('status') == 'completed' and data.get('difficulty') is not None:
            workouts = database.get_all_fitness_workouts()
            w = next((x for x in workouts if x['id'] == workout_id), None)
            if w:
                sport = database.get_fitness_sport(w['sport_id'])
                if sport and sport.get('use_scheduling'):
                    settings      = database.get_settings()
                    special_dates = database.get_all_special_dates()
                    next_d = scheduler.schedule_next_workout(sport, int(data['difficulty']),
                                                              settings, special_dates)
                    new_w = {
                        'id':             str(uuid.uuid4()),
                        'sport_id':       sport['id'],
                        'name':           w.get('name', ''),
                        'scheduled_date': next_d,
                        'scheduled_time': None,
                        'duration':       w.get('duration', 60),
                        'status':         'planned',
                        'notes':          '',
                        'created_at':     datetime.now().isoformat(),
                    }
                    database.add_fitness_workout(new_w)
        return {'success': True}

    def skip_fitness_workout(self, workout_id):
        """Push a workout to the next open day (mirrors session skip)."""
        new_d = scheduler.skip_workout(workout_id)
        return {'success': new_d is not None, 'rescheduled_to': new_d}

    def delete_fitness_workout(self, workout_id):
        database.delete_fitness_workout(workout_id)
        return {'success': True}

    def get_fitness_exercises(self, sport_id, workout_id=None):
        return database.get_exercises_for_sport(sport_id, workout_id)

    def add_fitness_exercise(self, data):
        exercise = {
            'id':           str(uuid.uuid4()),
            'sport_id':     data['sport_id'],
            'workout_id':   data.get('workout_id') or None,
            'name':         data['name'],
            'sets':         data.get('sets') or None,
            'reps':         data.get('reps') or None,
            'weight':       data.get('weight') or None,
            'duration_min': data.get('duration_min') or None,
            'distance':     data.get('distance') or None,
            'notes':        data.get('notes', ''),
            'order_index':  int(data.get('order_index', 0)),
            'created_at':   datetime.now().isoformat(),
        }
        database.add_fitness_exercise(exercise)
        return {'success': True, 'exercise': exercise}

    def update_fitness_exercise(self, exercise_id, data):
        allowed = {'name', 'sets', 'reps', 'weight', 'duration_min', 'distance', 'notes', 'order_index'}
        database.update_fitness_exercise(exercise_id, {k: v for k, v in data.items() if k in allowed})
        return {'success': True}

    def delete_fitness_exercise(self, exercise_id):
        database.delete_fitness_exercise(exercise_id)
        return {'success': True}
