"""
Pharaon Memory Engine — the scheduling "brain".

Implements the DSR (Difficulty / Stability / Retrievability) three-component
model of long-term memory, using the FSRS-4.5 formulation — the open-source
spaced-repetition scheduler that benchmarks ahead of SM-2 and now powers Anki.

The three state variables (per topic)
─────────────────────────────────────
Difficulty  D ∈ [1, 10]  — how hard this topic is for THIS user. Learned from
                            the user's own ratings; mean-reverting so a few bad
                            days don't permanently brand a topic as "hard".
Stability   S (days)     — how long the memory lasts: the time for recall
                            probability to sink from 100% to 90%. Grows with
                            every successful, well-timed review (this is the
                            long-term consolidation the user cares about).
Retrievability R ∈ (0,1] — probability of successful recall right now, from
                            the power-law forgetting curve (power fits human
                            forgetting better than Ebbinghaus' exponential).

Core relationships (FSRS-4.5)
─────────────────────────────
  R(t, S)   = (1 + FACTOR·t/S) ^ DECAY          (forgetting curve)
  I(R_d, S) = (S/FACTOR)·(R_d^(1/DECAY) − 1)    (interval that hits target R_d)
  S grows most when a review happens at LOW retrievability and succeeds
  ("desirable difficulty", Bjork) — but risk of forgetting rises, so the
  scheduler reviews when R falls to the desired-retention target: the sweet
  spot between efficiency and safety.

Grades (mapped from the app's 0-10 rating modal)
────────────────────────────────────────────────
  1 Again — failed to recall        (rating 0-2)
  2 Hard  — recalled with struggle  (rating 3-5)
  3 Good  — recalled with effort    (rating 6-8)
  4 Easy  — effortless              (rating 9-10)
"""

import math

# FSRS-4.5 default parameters (trained on hundreds of millions of real reviews;
# see open-spaced-repetition / py-fsrs).
W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031,
     1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755]

DECAY  = -0.5
FACTOR = 19.0 / 81.0          # ensures R(S, S) = 0.9

MIN_STABILITY = 0.5           # days
MAX_INTERVAL  = 365           # yearly touch even for rock-solid topics


# ── Forgetting curve ───────────────────────────────────────────────────────────

def retrievability(elapsed_days, stability):
    """Probability of successful recall after `elapsed_days` without review."""
    if stability is None or stability <= 0:
        return 0.0
    t = max(0.0, float(elapsed_days))
    return (1.0 + FACTOR * t / stability) ** DECAY


def interval_for_retention(stability, desired_r):
    """Days until retrievability decays to `desired_r` (the review interval)."""
    if stability is None or stability <= 0:
        return 1
    r = min(0.97, max(0.70, float(desired_r)))
    ivl = (stability / FACTOR) * (r ** (1.0 / DECAY) - 1.0)
    return max(1, min(MAX_INTERVAL, round(ivl)))


# ── Grade mapping ──────────────────────────────────────────────────────────────

def grade_from_rating(rating_0_10):
    """App rating (0-10) → FSRS grade (1 Again / 2 Hard / 3 Good / 4 Easy)."""
    r = int(rating_0_10)
    if r <= 2:
        return 1
    if r <= 5:
        return 2
    if r <= 8:
        return 3
    return 4


# ── Initial state (first review of a topic) ────────────────────────────────────

def init_stability(grade):
    return max(MIN_STABILITY, W[grade - 1])


def init_difficulty(grade):
    return _clamp_d(W[4] - (grade - 3) * W[5])


# ── State update after a review ────────────────────────────────────────────────

def _clamp_d(d):
    return min(10.0, max(1.0, d))


def next_difficulty(difficulty, grade):
    """Grade-driven difficulty update with mean reversion toward D0(Easy)."""
    d = difficulty - W[6] * (grade - 3)
    d = W[7] * init_difficulty(4) + (1.0 - W[7]) * d
    return _clamp_d(d)


def _stability_after_recall(difficulty, stability, r, grade):
    hard_penalty = W[15] if grade == 2 else 1.0
    easy_bonus   = W[16] if grade == 4 else 1.0
    inc = (math.exp(W[8])
           * (11.0 - difficulty)
           * stability ** (-W[9])
           * (math.exp(W[10] * (1.0 - r)) - 1.0)
           * hard_penalty
           * easy_bonus)
    return stability * (1.0 + inc)


def _stability_after_forget(difficulty, stability, r):
    s_new = (W[11]
             * difficulty ** (-W[12])
             * ((stability + 1.0) ** W[13] - 1.0)
             * math.exp(W[14] * (1.0 - r)))
    return min(s_new, stability)     # a lapse can never increase stability


def update_memory(difficulty, stability, elapsed_days, grade, calib=1.0):
    """
    One review step. Returns (difficulty', stability').
    Handles first-ever review (stability None/0) transparently.
    `calib` scales the retrievability estimate at review time (personal
    calibration): if the user's memory is genuinely stronger than the
    population model, the true R at review is higher and the stability
    increment should reflect that.
    """
    g = int(grade)
    if stability is None or stability <= 0 or difficulty is None:
        return init_difficulty(g), init_stability(g)

    r = retrievability(elapsed_days, stability * calib)
    d2 = next_difficulty(difficulty, g)
    if g == 1:
        s2 = _stability_after_forget(difficulty, stability, r)
    else:
        s2 = _stability_after_recall(difficulty, stability, r, g)
    return d2, max(MIN_STABILITY, s2)


# ── Desired retention (folds in priority & exams, principled) ──────────────────

# Priority shifts the retention target, not the interval directly: critical
# material is held to a stricter standard (reviewed sooner), minimal material
# to a looser one. This is the knob FSRS is designed around.
_PRIORITY_SHIFT = {1: +0.03, 2: +0.015, 3: 0.0, 4: -0.02, 5: -0.04}

_EXAM_RAMP_DAYS   = 21     # retention starts ramping this many days pre-exam
_EXAM_PEAK_TARGET = 0.96
_EXAM_IMPORTANCE  = {1: 0.6, 2: 0.85, 3: 1.0}


def desired_retention(base, priority, days_to_exam=None, exam_importance=2):
    """
    Target recall probability at review time.
      base          : user setting (default 0.90)
      priority      : 1 (critical) … 5 (minimal)
      days_to_exam  : days until nearest linked exam, or None
    """
    r = float(base) + _PRIORITY_SHIFT.get(int(priority), 0.0)
    if days_to_exam is not None and 0 <= days_to_exam <= _EXAM_RAMP_DAYS:
        ramp = (_EXAM_RAMP_DAYS - days_to_exam) / _EXAM_RAMP_DAYS
        ramp *= _EXAM_IMPORTANCE.get(int(exam_importance), 0.85)
        r = max(r, r + (_EXAM_PEAK_TARGET - r) * ramp)
    return min(0.97, max(0.80, r))


# ── User-facing level (long-term consolidation ladder) ─────────────────────────

_LEVELS = [
    (0,    'New'),          # never reviewed
    (7,    'Learning'),     # S < 7d
    (21,   'Developing'),   # 7-21d
    (60,   'Established'),  # 21-60d
    (180,  'Solid'),        # 60-180d
    (None, 'Mastered'),     # ≥ 180d — survives half a year untouched
]


def level_info(stability, repetitions):
    """Returns {'tier': 0-5, 'name': str} from consolidation state."""
    if not repetitions or stability is None or stability <= 0:
        return {'tier': 0, 'name': 'New'}
    tier = 1
    for i, (upper, _name) in enumerate(_LEVELS[1:-1], start=1):
        if stability >= upper:
            tier = i + 1
    return {'tier': tier, 'name': _LEVELS[tier][1]}


# ── Legacy migration (SM-2 → DSR) ──────────────────────────────────────────────

def migrate_sm2(ease_factor, interval, repetitions):
    """
    One-time conversion of old SM-2 state.
    SM-2's interval targets ~90% recall — which is exactly FSRS's definition of
    stability, so S ≈ interval. Difficulty maps inversely from ease factor.
    """
    if not repetitions or not interval:
        return None, None                     # never truly reviewed → new
    s = max(MIN_STABILITY, float(interval))
    d = _clamp_d(11.9 - 2.7 * float(ease_factor or 2.5))
    return d, s


def state_of(topic):
    """
    (difficulty, stability) for a topic dict — reads the DSR columns when
    present, otherwise migrates legacy SM-2 state on the fly. (None, None)
    means the topic has never been reviewed.
    """
    s = topic.get('stability')
    d = topic.get('difficulty')
    if s and d:
        return float(d), float(s)
    return migrate_sm2(topic.get('ease_factor'), topic.get('interval'),
                       topic.get('repetitions'))


# ── Expected review outcomes (used by the optimization engine) ─────────────────

def expected_outcome(difficulty, stability, elapsed_days, calib=1.0):
    """
    Expected result of reviewing after `elapsed_days`:
      returns (p_recall, stability_if_recalled, stability_if_forgotten).
    Recall is projected with grade Good; `calib` is the personal calibration
    factor applied to predictions (see calibration_step).
    """
    r  = retrievability(elapsed_days, stability * calib)
    s1 = _stability_after_recall(difficulty, stability, r, 3)
    s0 = _stability_after_forget(difficulty, stability, r)
    return r, max(MIN_STABILITY, s1), max(MIN_STABILITY, s0)


def review_gain(difficulty, stability, elapsed_days, calib=1.0):
    """
    Expected log-stability gain of reviewing after `elapsed_days` (nats),
    and the recall probability at that moment:  (E[ln S'] − ln S,  R).

    Log-stability is the natural unit of long-term progress: review intervals
    scale multiplicatively with S, so each nat of ln S removes a constant
    fraction of all future reviews — maximising it directly minimises
    unnecessary reviews.
    """
    r, s_yes, s_no = expected_outcome(difficulty, stability, elapsed_days, calib)
    e_ln = r * math.log(s_yes) + (1.0 - r) * math.log(s_no)
    return e_ln - math.log(max(MIN_STABILITY, stability)), r


# ── Online calibration: learn from the user's actual performance ───────────────
# One-parameter online gradient step on the calibration gap between predicted
# recall probability and observed outcomes. If the user systematically recalls
# more (less) than the model predicts, the personal stability scale k drifts
# up (down); every prediction site — retention display, due dates, optimizer
# utilities — uses S·k. Bounded to [0.5, 2.0]; learning rate keeps ~50-review
# memory so it adapts as the user improves.

CALIB_MIN, CALIB_MAX, CALIB_ETA = 0.5, 2.0, 0.05


def calibration_step(current_k, predicted_r, recalled):
    """One observed review: multiplicative-weights update of the scale k."""
    err = (1.0 if recalled else 0.0) - float(predicted_r)
    k = float(current_k or 1.0) * math.exp(CALIB_ETA * err)
    return min(CALIB_MAX, max(CALIB_MIN, k))


def calibration_of(settings):
    """Read the personal calibration scale from a settings dict, safely."""
    try:
        k = float(settings.get('memory_calibration', 1.0) or 1.0)
    except (TypeError, ValueError):
        return 1.0
    return min(CALIB_MAX, max(CALIB_MIN, k))
