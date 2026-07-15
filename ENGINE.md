# Pharaon Optimization Engine — Formal Design

The scheduler is a **receding-horizon constrained optimizer** built on a
**trained memory model** and an **online calibration learner**. No placement
decision is made by an if–then rule; every decision is the argmax of one
scalar objective.

## 1. Memory dynamics (the predictive model)

Each topic *i* carries a DSR state (FSRS-4.5, trained on hundreds of millions
of real reviews — the learned component of the system):

| Symbol | Meaning | Domain |
|---|---|---|
| Dᵢ | difficulty (per-user, per-topic, grade-driven, mean-reverting) | [1,10] |
| Sᵢ | stability — days for recall probability to decay 100%→90% | (0,∞) |
| Rᵢ(t) | retrievability after t days: R = (1 + f·t/S)^c, f=19/81, c=−½ | (0,1] |
| k | personal calibration scale (learned online, §5) | [0.5,2] |

Review transition (grade g ∈ {Again, Hard, Good, Easy}):
S′ = S·(1 + e^{w₈}(11−D)S^{−w₉}(e^{w₁₀(1−R)}−1)·pen(g)) on recall,
post-lapse S′ = w₁₁D^{−w₁₂}((S+1)^{w₁₃}−1)e^{w₁₄(1−R)} ≤ S on failure.
Every prediction site uses the calibrated stability S·k.

## 2. Decision variables and horizon

x[i,d] ∈ {0,1}: topic *i* reviewed on day *d* of the horizon H = 14 days.
Sessions whose model due date falls beyond H are placed at the due date and
re-optimized when the horizon reaches them (model-predictive control: replan
after every state change, commit only the near future).

## 3. Objective

maximize J(x) = Σᵢ Σ_d x[i,d]·Uᵢ(d)
     − λ_L Σ_d ((m_d − M)⁺/M)²        (workload overshoot)
     − λ_B Σ_d (m_d/M)²               (leveling; convex ⇒ Jensen ⇒ balance)
     − λ_F Σ_d ((c_d − M)⁺/M)²        (cognitive fatigue)
     − λ_S Σ_d Σ_s n_{s,d}(n_{s,d}−1)/2   (same-subject interference)

with m_d = Σ x[i,d]·τᵢ (minutes), c_d = Σ x[i,d]·τᵢ·(1+(Dᵢ−5)/10)
(cognitive-load-weighted minutes, harder material costs more — Sweller),
n_{s,d} = same-subject sessions on day d (interference theory; its convexity
also produces interleaving — Rohrer & Taylor).

### Per-review utility

Uᵢ(d) = wᵢ · [ Gᵢ(d) − β·(1−Rᵢ(d)) + Eᵢ(d) ] · (25/τᵢ)

- **Gᵢ(d) = E[ln S′] − ln S** — expected log-stability gain of reviewing on
  day d, mixing the recall and lapse branches by R. Log-stability is the
  natural progress unit: intervals scale multiplicatively with S, so each nat
  of ln S removes a constant fraction of *all future reviews* — maximizing G
  **is** minimizing unnecessary reviews. G grows as R falls (desirable
  difficulty, Bjork; matches the optimal-intensity result u*(t) ∝ 1−R(t) of
  MEMORIZE, Tabibian et al. 2019, and the efficiency objective of SSP-MMC).
- **β·(1−R)** — the price of lapse risk. β is **derived, not tuned**: it is
  the unique value for which U peaks exactly at R = R* (the user's retention
  target) on the nominal state — β = −dG/dR |_{R=R*}, computed numerically at
  plan time. The strictness knob therefore shifts a mathematically defined
  optimum; each topic's own (D,S) then bends its curve around it.
- **Eᵢ(d)** — exam term: retrievability projected on exam morning if the
  review happens on day d (one expected transition + decay), weighted by
  W_exam · importance. Recall is maximized *on the day it matters*.
- **wᵢ** — the topic's declared value (priority), user data.
- **25/τᵢ** — utilities are per-minute: long sessions must earn their time.
- New topics: constant acquisition gain minus a linear delay cost (each day
  of postponement shifts the entire retention chain right).

Overdue triage **emerges**: as R collapses, the lapse term dominates and
U becomes strictly decreasing in further delay ⇒ most-fragile-first.

## 4. Hard constraints

- x[i,d] = 0 on days off, on reduced days above the topic's priority ceiling,
  and on restricted dates (aggregated strictest-wins across overlapping
  entries).
- Σᵢ x[i,d] ≤ cap_d (session-count cap; halved on reduced days).
- Exam topics choose among days ≤ exam−1 whenever any such day is eligible;
  only an infeasible deadline is relaxed (the cap is the harder constraint).
- Pinned / committed sessions (manual, skip-committed, today's, catch-ups)
  are constants: counted in m_d, c_d, n_{s,d}, never moved.

## 5. Learning from the user

- **Difficulty** adapts per topic from grades (FSRS D update).
- **Calibration k** adapts per user: after every review with a prediction,
  one multiplicative-weights step k ← k·exp(η·(recalled − R̂)), clamped
  [0.5,2], η=0.05 (≈50-review memory). Systematic over-performance stretches
  all intervals; under-performance shrinks them. This is a one-parameter
  online gradient step on calibration error — the engine adapts
  automatically as the user improves.

## 6. Algorithm

**Regret-guided construction + steepest-descent local search.**
1. Closed-form utility curves Uᵢ(d) for every eligible (i,d).
2. Construction: repeatedly place the topic with the largest *regret*
   (best-day net utility minus second-best) at its best marginal day —
   assignment-problem logic: whoever loses most from a wrong slot picks first.
3. Improvement: steepest-descent over single-session relocations, accepting
   the best strictly-improving ΔJ until a local optimum (≤4 sweeps).

Justification: the problem is an integer program with separable single-peaked
utilities and convex day penalties — a structure for which move-based local
search reaches within a few percent of the ILP optimum. It is dependency-free
(no solver in the shipped app), deterministic (idempotent replanning is a
hard product requirement), and runs in ~0.4 s at 40 topics × 14 days.
Upgrade path: the identical model is expressible in CP-SAT (OR-Tools) for
provably optimal solves if a solver dependency ever becomes acceptable.

## 7. Known weaknesses and the improvement path

1. **Day granularity** — preferred study hours, breaks, max continuous time
   are not modeled; sessions have no intra-day placement. Next step: a
   second-stage intra-day packer under the same objective family.
2. **Global k** — calibration is one scalar; per-subject scales (hierarchical
   shrinkage toward the global k) would capture subject-specific memory.
3. **FSRS weights are population defaults** — on-device re-optimization of
   the 17 weights needs the user's full review log and a gradient optimizer;
   the log is already stored, so batch re-fit is feasible later.
4. **Interference is subject-level** — true inter-topic similarity would need
   content embeddings; the subject proxy is the on-device approximation.
5. **Grade projection uses Good** — a full expectation over the user's
   empirical grade distribution is a cheap refinement.
6. **Local search is boundedly suboptimal** — see CP-SAT path above.
