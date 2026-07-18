"""
Pharaon Optimization Engine
═══════════════════════════

The calendar is planned as ONE constrained optimization problem, not a chain
of placement rules. Full derivation in ENGINE.md; summary:

Decision variables
    x[i,d] ∈ {0,1} — topic i is reviewed on day d of the rolling horizon
    (14 days; a receding-horizon controller: the plan is re-solved after
    every state change, so only the near future needs joint optimization —
    far-future sessions are placed at their model due date and re-enter the
    horizon later).

Objective (maximised)
    J(x) = Σ_i Σ_d x[i,d] · U_i(d)                      review utility
         − λ_L Σ_d ((m_d − M)⁺ / M)²                    workload dispersion
         − λ_F Σ_d ((c_d − M)⁺ / M)²                    cognitive fatigue
         − λ_S Σ_d Σ_s n_{s,d}(n_{s,d}−1)/2             same-subject interference

    U_i(d)  = w_i · [ G_i(d) − β·(1−R_i(d)) + E_i(d) ] · 25/τ_i
      G_i(d)  expected log-stability gain of reviewing topic i on day d,
              E[ln S′] − ln S under the FSRS-4.5 transition (recall projected
              at grade Good, lapse to post-lapse stability, mixed by R).
              Log-stability gain per study-minute is the "review efficiency"
              of optimal-control formulations (SSP-MMC; MEMORIZE's optimal
              intensity u*(t) ∝ 1−R(t) has the same shape).
      β       lapse-risk price, DERIVED (not tuned): the unique β for which
              U peaks exactly at R = R* (the user's retention target) on the
              nominal memory state — argmax_d U then lands where R(d)=R* and
              shifts with every topic's own state. Stricter target ⇒ larger
              β ⇒ earlier reviews.
      E_i(d)  exam term: projected retrievability on exam morning if the
              review happens on day d (single-transition projection) times
              W_EXAM · importance — pulls exam material so that recall is
              maximal on the day it matters.
      w_i     the topic's declared value (priority weight) — user data.
      τ_i     session duration; utilities are per-time-unit so long sessions
              must earn their minutes.
      m_d     study minutes on day d;  c_d = Σ τ_i·(1+(D_i−5)/10) cognitive
              load (harder material costs more per minute, cognitive-load
              theory);  M = daily budget;  (·)⁺ = max(0,·).
      Convex quadratic penalties ⇒ by Jensen's inequality the optimum levels
      the load across days — balance is a THEOREM of the objective, not a
      rule. The λ are Lagrange multipliers of the soft constraints.

Hard constraints (never violated)
    • availability: x[i,d]=0 on days off / reduced days above the topic's
      priority ceiling / restricted dates                (eligibility matrix)
    • capacity: Σ_i x[i,d] ≤ cap_d                       (session-count cap)
    • deadlines: exam topics choose among days ≤ exam−1 when any such day is
      eligible (unsatisfiable ⇒ relaxed rather than overloading a day)
    • pinned / committed sessions are constants, not variables.

Algorithm — regret-guided construction + steepest-descent local search
    1. Marginal-utility curves U_i(d) are closed-form from the memory model.
    2. Construction: place topics in order of REGRET (best-day utility minus
       second-best) — the assignment-problem intuition: whoever loses most
       from a wrong slot chooses first.
    3. Improvement: steepest-descent local search over single-session moves
       (relocate to any eligible day), accepting the best strictly-improving
       move of ΔJ until a local optimum (≤ MAX_PASSES sweeps).
    Justification: with separable single-peaked utilities and convex
    day-penalties, move-based local search converges to solutions within a
    few percent of the ILP optimum while remaining dependency-free (no
    solver), deterministic (idempotent replanning), and < 100 ms at
    hundreds of topics. See ENGINE.md §6 for the CP-SAT upgrade path.
"""

import math
from datetime import date, timedelta
from backend import memory

HORIZON_DAYS = 14
MAX_PASSES   = 6

# Lagrange multipliers of the soft constraints
LAMBDA_LOAD    = 3.0     # overshoot above the daily budget (quadratic)
LAMBDA_LEVEL   = 0.9     # leveling: convex in load everywhere (Jensen ⇒ spread)
LAMBDA_FATIGUE = 1.5
LAMBDA_SUBJECT = 0.10
STICKINESS     = 0.45    # plan-continuity bonus for keeping a session on the
                         # day the PREVIOUS plan published — a switching cost
                         # (receding-horizon hysteresis): the plan only moves
                         # a session when the improvement genuinely beats the
                         # disruption, so replans stop looking random.

W_EXAM          = 2.5     # weight of the exam-retention term (× importance/3)
FIRST_GAIN      = 2.0     # nats: acquiring initial stability for new material
GAMMA_DELAY_NEW = 0.12    # per-day cost of postponing a first exposure
PRIORITY_W      = {1: 1.6, 2: 1.25, 3: 1.0, 4: 0.8, 5: 0.65}


# ── β derivation: price of lapse risk from the retention target ───────────────

def derive_beta(r_target, difficulty=5.0, stability=10.0, calib=1.0):
    """
    U(R) = G(R) − β(1−R) peaks where dG/dR = −β. Choosing β = −dG/dR at
    R = r_target makes the unconstrained optimum of U sit exactly at the
    user's retention target on the nominal state — the strictness knob
    stays meaningful while every topic's own state shifts its optimum.
    """
    r = min(0.96, max(0.70, float(r_target)))
    # elapsed time at which R(t) = r  (inverse forgetting curve)
    t  = (stability * calib / memory.FACTOR) * (r ** (1.0 / memory.DECAY) - 1.0)
    dt = max(0.5, 0.05 * t)
    g1, _ = memory.review_gain(difficulty, stability, max(0.1, t - dt), calib)
    g2, r2 = memory.review_gain(difficulty, stability, t + dt, calib)
    r1 = memory.retrievability(max(0.1, t - dt), stability * calib)
    if abs(r2 - r1) < 1e-9:
        return 1.0
    dg_dr = (g2 - g1) / (r2 - r1)
    return max(0.1, min(8.0, -dg_dr))


# ── Per-topic utility curves ───────────────────────────────────────────────────

def day_utilities(item, days, today, beta, calib):
    """
    U_i(d) for every eligible day. `item` carries: topic, state (d_mem,s_mem),
    last_d, exam_d, exam_imp, r_target, duration, priority.
    """
    t          = item['topic']
    d_mem      = item.get('d_mem')
    s_mem      = item.get('s_mem')
    last_d     = item.get('last_d')
    exam_d     = item.get('exam_d')
    exam_imp   = int(item.get('exam_imp') or 2)
    dur        = max(5, int(item.get('duration') or 25))
    w          = PRIORITY_W.get(int(t.get('priority', 3)), 1.0)
    per_minute = 25.0 / dur

    out = {}
    for d in days:
        if s_mem is None or last_d is None:
            # First exposure: constant acquisition gain, linear delay cost
            # (postponing shifts the whole retention chain right).
            util = FIRST_GAIN - GAMMA_DELAY_NEW * (d - today).days
            r_at = 0.0
        else:
            elapsed = max(0, (d - last_d).days)
            gain, r_at = memory.review_gain(d_mem, s_mem, elapsed, calib)
            util = gain - beta * (1.0 - r_at)

        if exam_d and d < exam_d:
            # Retention on exam morning if the review happens on day d.
            if s_mem is None:
                _, s_yes, _ = memory.expected_outcome(memory.init_difficulty(3),
                                                      memory.init_stability(3), 0, calib)
                r_exam = memory.retrievability((exam_d - d).days, s_yes * calib)
            else:
                p, s_yes, s_no = memory.expected_outcome(
                    d_mem, s_mem, max(0, (d - last_d).days), calib)
                s_exp  = p * s_yes + (1 - p) * s_no
                r_exam = memory.retrievability((exam_d - d).days, s_exp * calib)
            util += W_EXAM * (exam_imp / 3.0) * r_exam

        out[d] = w * util * per_minute
        if item.get('prev_day') == d:
            out[d] += STICKINESS          # plan continuity (switching cost)
    return out


# ── Global objective (soft-constraint penalties) ───────────────────────────────

def _penalty(day_state, goal):
    """Convex day penalties: workload dispersion, fatigue, subject interference."""
    p = 0.0
    over_m = max(0.0, day_state['mins'] - goal) / goal
    p += LAMBDA_LOAD * over_m * over_m
    # Leveling term: strictly convex in the day's load, so for a fixed total
    # the sum is minimised by the most even distribution (Jensen) — a gentle,
    # ever-present pull toward empty days, not only above the budget.
    rel = day_state['mins'] / goal
    p += LAMBDA_LEVEL * rel * rel
    over_c = max(0.0, day_state['cload'] - goal) / goal
    p += LAMBDA_FATIGUE * over_c * over_c
    for n in day_state['subj'].values():
        p += LAMBDA_SUBJECT * n * (n - 1) / 2.0
    return p


def _apply(day_state, item, sign):
    dur = max(5, int(item.get('duration') or 25))
    dmem = item.get('d_mem')
    cog  = dur * (1.0 + ((dmem if dmem is not None else 5.0) - 5.0) / 10.0)
    subj = (item['topic'].get('subject') or '')
    day_state['mins']  += sign * dur
    day_state['cload'] += sign * cog
    day_state['count'] += sign
    day_state['subj'][subj] = day_state['subj'].get(subj, 0) + sign
    if day_state['subj'][subj] <= 0:
        day_state['subj'].pop(subj, None)


def _marginal(day_state, item, goal):
    """ΔPenalty of adding `item` to a day (needed for marginal-utility choice)."""
    before = _penalty(day_state, goal)
    _apply(day_state, item, +1)
    after = _penalty(day_state, goal)
    _apply(day_state, item, -1)
    return after - before


# ── The solver: regret construction + steepest-descent moves ──────────────────

def optimize(items, days, day_states, caps, goal, r_target, calib, today):
    """
    items      : list of item dicts (see day_utilities) with 'eligible': set of days
    days       : ordered list of horizon day objects
    day_states : {day → {'mins','cload','count','subj':{}}} seeded with anchors
    caps       : {day → max session count}
    Returns {item_id → day}. Deterministic.
    """
    beta = derive_beta(r_target, calib=calib)
    U = {}
    for it in items:
        elig = [d for d in days if d in it['eligible']]
        U[it['id']] = day_utilities(it, elig, today, beta, calib)

    def net(it, d):
        return U[it['id']][d] - _marginal(day_states[d], it, goal)

    def feasible(it):
        return [d for d in U[it['id']]
                if day_states[d]['count'] < caps.get(d, 0)]

    # 1. Regret-based construction
    placed, unplaced = {}, sorted(items, key=lambda x: x['id'])
    while unplaced:
        best_pick = None
        for it in unplaced:
            f = feasible(it)
            if not f:
                continue
            scored = sorted((net(it, d) for d in f), reverse=True)
            regret = scored[0] - (scored[1] if len(scored) > 1 else scored[0] - 1.0)
            if best_pick is None or regret > best_pick[0] + 1e-12:
                best_pick = (regret, it)
        if best_pick is None:
            break                                    # nothing feasible remains
        it = best_pick[1]
        d  = max(feasible(it), key=lambda x: (net(it, x), -abs((x - today).days)))
        placed[it['id']] = d
        _apply(day_states[d], it, +1)
        unplaced = [x for x in unplaced if x['id'] != it['id']]

    # 2. Local search: improvement sweeps over single-session relocations.
    #    Each sweep moves every session to its best net day if that strictly
    #    improves J; sweeps repeat until a full pass makes no move (local
    #    optimum) or the sweep budget is exhausted.
    by_id = {it['id']: it for it in items}
    for _sweep in range(MAX_PASSES):
        improved = False
        for iid in sorted(placed):
            it, cur = by_id[iid], placed[iid]
            _apply(day_states[cur], it, -1)
            best_d = cur
            best_v = U[iid][cur] - _marginal(day_states[cur], it, goal)
            for d in U[iid]:
                if d == cur or day_states[d]['count'] >= caps.get(d, 0):
                    continue
                v = U[iid][d] - _marginal(day_states[d], it, goal)
                if v > best_v + 1e-9:
                    best_v, best_d = v, d
            _apply(day_states[best_d], it, +1)
            if best_d != cur:
                placed[iid] = best_d
                improved = True
        if not improved:
            break

    return placed
