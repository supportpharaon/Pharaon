/* ═══════════════════════════════════════════════════
   PHARAON  app.js  —  Complete frontend logic
   ═══════════════════════════════════════════════════ */

'use strict';

// ── State ────────────────────────────────────────────
const S = {
  page: 'today',
  topics: [],
  sessions: [],
  todaySessions: [],
  exams: [],
  flashcards: [],
  specialDates: [],
  studyRestrictions: [],
  fitnessWorkouts: [],
  settings: {},
  stats: {},
  fitnessSports: [],
  appVersion: '',
  calDate: new Date(),
  calSelected: null,
  recallIdx: 0,
  recallFlipped: false,
  recallDeck: [],
  recallFilter: 'due',
  recallSubject: '',
  recallTopic: '',
  showAnswers: false,
};

// ── API wrapper ──────────────────────────────────────
const api = new Proxy({}, {
  get(_, fn) {
    return (...args) => new Promise((res, rej) => {
      const attempt = () => {
        if (window.pywebview && window.pywebview.api && window.pywebview.api[fn]) {
          Promise.resolve(window.pywebview.api[fn](...args))
            .then(res)
            .catch(err => {
              const msg = (typeof err === 'string' ? err : err?.message) || 'An unexpected error occurred';
              toast(`Error: ${msg} — you can report it from Settings → Help`, 'err');
              const wrapped = (err && typeof err === 'object') ? err : new Error(String(err));
              wrapped._toasted = true;   // suppress the global duplicate toast
              rej(wrapped);
            });
        } else {
          setTimeout(attempt, 80);
        }
      };
      attempt();
    });
  }
});

// ── Global error handling ─────────────────────────────
const SUPPORT_EMAIL = 'support.pharaon@gmail.com';
window.addEventListener('error', () => {
  try { toast('Something went wrong — please report it from Settings → Help', 'err'); } catch (_) {}
});
window.addEventListener('unhandledrejection', e => {
  if (e && e.reason && e.reason._toasted) return;   // already surfaced by the api proxy
  try { toast('Something went wrong — please report it from Settings → Help', 'err'); } catch (_) {}
});

function reportBug() {
  const body = encodeURIComponent(
    'Describe the bug (what you did, what you expected, what happened):\n\n\n'
    + '---\nPharaon v' + (S.appVersion || '?') + '\n' + navigator.userAgent);
  api.open_external(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('[Pharaon] Bug report')}&body=${body}`);
}

function contactSupport() {
  api.open_external(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('[Pharaon] Support request')}`);
}

// ── Undo system ──────────────────────────────────────
let _undoAction = null;
let _undoTimer  = null;

function setUndo(label, fn, ms = 9000) {
  _undoAction = fn;
  const el = document.getElementById('undoToast');
  el.innerHTML = `<span>${esc(label)}</span><button class="undo-btn" onclick="execUndo()">Undo</button>`;
  el.classList.add('show');
  clearTimeout(_undoTimer);
  _undoTimer = setTimeout(() => {
    el.classList.remove('show');
    _undoAction = null;
  }, ms);
}

async function execUndo() {
  if (!_undoAction) return;
  const fn = _undoAction;
  _undoAction = null;
  clearTimeout(_undoTimer);
  document.getElementById('undoToast').classList.remove('show');
  try {
    await fn();
    await refreshAll();
    toast('Restored successfully', 'ok');
  } catch {
    toast('Could not undo', 'warn');
  }
}

// ── Helpers ──────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtDate(d) {
  if (!d) return '—';
  const o = new Date(d + (d.length === 10 ? 'T00:00:00' : ''));
  return o.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
}
function fmtDateShort(d) {
  if (!d) return '—';
  const o = new Date(d + 'T00:00:00');
  return o.toLocaleDateString('en-GB', { day:'numeric', month:'short' });
}
function today() {
  // LOCAL date, not UTC — toISOString() flips to tomorrow after ~22:00 for
  // UTC+ users and disagreed with the backend's local date.today().
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function greetWord() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
function priorityBadge(p) {
  const labels = {1:'Critical',2:'High',3:'Medium',4:'Low',5:'Minimal'};
  return `<span class="badge p${p}">${labels[p]||'?'}</span>`;
}

// ── Toast ─────────────────────────────────────────────
let toastTimer;
function toast(msg, type='') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show${type ? ' '+type : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

// ── Modal ─────────────────────────────────────────────
let _modalHideTimer = null;
function openModal(html, wide=false) {
  // A modal opened right after closeModal() must survive the pending
  // hide-timer of the previous one (e.g. Settings → Open Tutorial).
  clearTimeout(_modalHideTimer);
  document.getElementById('modal').className = wide ? 'modal modal-wide' : 'modal';
  document.getElementById('modal').innerHTML = html;
  document.getElementById('overlay').classList.add('show');
  const wrap = document.getElementById('modalWrap');
  wrap.removeAttribute('hidden');
  wrap.classList.add('show');
  setTimeout(() => wrap.querySelector('input,select,textarea')?.focus(), 80);
}
function closeModal() {
  document.getElementById('overlay').classList.remove('show');
  const wrap = document.getElementById('modalWrap');
  wrap.classList.remove('show');
  clearTimeout(_modalHideTimer);
  _modalHideTimer = setTimeout(() => wrap.setAttribute('hidden', ''), 200);
}
document.getElementById('overlay').addEventListener('click', closeModal);

// ── Navigation ────────────────────────────────────────
function navigate(page) {
  S.page = page;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });
  renderPage();
}
document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', e => { e.preventDefault(); navigate(el.dataset.page); });
});

// ── Refresh ───────────────────────────────────────────
async function refreshAll() {
  const [topics, todaySessions, sessions, exams, cards, sds, restrictions, settings, stats, sports, workouts, ver] = await Promise.all([
    api.get_topics(),
    api.get_today_sessions(),
    api.get_sessions(),
    api.get_exams(),
    api.get_flashcards(),
    api.get_special_dates(),
    api.get_study_restrictions(),
    api.get_settings(),
    api.get_stats(),
    api.get_fitness_sports(),
    api.get_all_fitness_workouts(),
    api.get_version(),
  ]);
  S.topics             = topics || [];
  S.todaySessions      = todaySessions || [];
  S.sessions           = sessions || [];
  S.exams              = exams || [];
  S.flashcards         = cards || [];
  S.specialDates       = sds || [];
  S.studyRestrictions  = restrictions || [];
  S.settings           = settings || {};
  S.stats              = stats || {};
  S.fitnessSports      = sports || [];
  S.fitnessWorkouts    = workouts || [];
  S.appVersion         = ver || '';
  updateSidebarStats();
  renderPage();
}

function updateSidebarStats() {
  const { streak=0, today_completed=0, today_scheduled=0 } = S.stats;
  document.getElementById('sfStreak').textContent = streak;
  document.getElementById('sfDone').textContent = `${today_completed}/${today_scheduled}`;
}

function renderPage() {
  const main = document.getElementById('main');
  main.innerHTML = '';
  switch (S.page) {
    case 'today':      renderToday(main);      break;
    case 'topics':     renderTopics(main);     break;
    case 'calendar':   renderCalendar(main);   break;
    case 'recall':     renderRecall(main);     break;
    case 'exams':      renderExams(main);      break;
    case 'fitness':    renderFitness(main);    break;
    case 'otherdates': renderOtherDates(main); break;
    default:           renderToday(main);
  }
}

// ══════════════════════════════════════════════════════
// TODAY
// ══════════════════════════════════════════════════════
function tint(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '';
  const n = parseInt(m[1], 16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}

function renderToday(main) {
  const name = S.settings.user_name ? `, ${S.settings.user_name}` : '';
  const greet = `${greetWord()}${name}!`;
  const { streak=0 } = S.stats;
  const sessions = S.todaySessions;
  const active   = sessions.filter(s => s.status !== 'skipped');
  const done     = active.filter(s => s.status === 'completed');
  const pct      = active.length ? Math.round(done.length / active.length * 100) : 0;
  // Skipped sessions sink to the bottom of the list.
  const ordered  = [...sessions].sort((a,b) => (a.status==='skipped'?1:0) - (b.status==='skipped'?1:0));

  const weekExams = S.exams.filter(e => !e.is_past && e.days_until != null && e.days_until <= 7);
  const todayWorkouts = (S.fitnessWorkouts||[]).filter(w => w.scheduled_date === today());

  main.innerHTML = `
    <div class="page-hero">
      <div class="hero-label">${new Date().toLocaleDateString('en-US',{weekday:'long'}).toUpperCase()}</div>
      <div class="hero-date">${esc(greet)}</div>
      <div class="hero-sub">${new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</div>
      <div class="hero-streak${streak>=3?' achieved':''}" id="heroStreak">
        <div class="hero-streak-num">${streak}</div>
        <div class="hero-streak-label">DAY STREAK</div>
      </div>
    </div>
    <div class="content">

      <div class="section-bar mb8">
        <span class="section-title">EXAMS THIS WEEK${weekExams.length?` (${weekExams.length})`:''}</span>
      </div>
      ${weekExams.length === 0
        ? `<div class="today-empty-line">No exams in the next 7 days</div>`
        : `<div class="session-list">${weekExams.map(examMini).join('')}</div>`}

      <div class="today-divider"></div>

      <div class="section-bar mb8">
        <span class="section-title">TODAY'S SESSIONS${active.length?` · ${done.length}/${active.length} DONE`:''}</span>
      </div>
      ${sessions.length === 0 ? `
        <div class="today-empty-line">No study sessions today — all clear! 🎉</div>` : `
      <div class="prog mb16">
        <div class="prog-fill${done.length===active.length&&active.length>0?' green':''}" style="width:${pct}%"></div>
      </div>
      <div class="session-list">
        ${ordered.map(s => sessionCard(s)).join('')}
      </div>`}

      <div class="today-divider"></div>

      <div class="section-bar mb8">
        <span class="section-title">WORKOUTS${todayWorkouts.length?` (${todayWorkouts.length})`:''}</span>
      </div>
      ${todayWorkouts.length === 0
        ? `<div class="today-empty-line">No workouts scheduled today</div>`
        : `<div class="session-list">${todayWorkouts.map(todayWorkoutRow).join('')}</div>`}

    </div>`;
}

function todayWorkoutRow(w) {
  const sp = S.fitnessSports.find(x => x.id === w.sport_id) || {};
  const color = sp.color || '#9065B0';
  const doneW = w.status === 'completed';
  return `
  <div class="session-card${doneW ? ' done' : ''}"${doneW?'':` style="background:${tint(color,.07)}"`}>
    <div class="s-strip" style="background:${color}"></div>
    <div class="s-info">
      <div class="s-name">${sp.icon || '💪'} ${esc(w.name || 'Workout')}</div>
      <div class="s-meta">
        <span>${esc(sp.name || '')}</span>
        ${w.duration ? `<span>${w.duration}min</span>` : ''}
        ${w.exercise_count ? `<span>${w.exercise_count} exercise${w.exercise_count!==1?'s':''}</span>` : ''}
      </div>
    </div>
    <div class="s-actions">
      ${doneW ? `<span class="badge badge-green">✓ Done</span>` : `
        <button class="btn-icon check" onclick="completeWorkout('${w.id}','${w.sport_id}')" title="Mark done">
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M4 10l5 5 7-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="btn-icon skip-btn" onclick="skipWorkout('${w.id}')" title="Skip — push to next open day">
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M9 6l6 4-6 4V6zM5 6v8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="btn-icon" onclick="openWorkoutRescheduleModal('${w.id}')" title="Reschedule manually">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M12 3l5 5-6 2-4 4-1-1 4-4 2-6z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M7 13l-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>`}
    </div>
  </div>`;
}

async function skipWorkout(workoutId) {
  const res = await api.skip_fitness_workout(workoutId);
  toast(res?.rescheduled_to ? `Workout moved to ${fmtDate(res.rescheduled_to)}` : 'No open day found', res?.rescheduled_to ? 'warn' : 'err');
  await refreshAll();
}

function openWorkoutRescheduleModal(workoutId) {
  const w  = (S.fitnessWorkouts||[]).find(x => x.id === workoutId) || {};
  const sp = S.fitnessSports.find(x => x.id === w.sport_id) || {};
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Reschedule Workout</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <p style="color:var(--n500);font-size:13px;margin-bottom:14px">
        <b>${sp.icon||'💪'} ${esc(w.name||'Workout')}</b> — pick the day it should happen.
      </p>
      <div class="form-row">
        <div class="form-group"><label class="label">New date</label>
          <input class="input" type="date" id="wkPinDate" value="${w.scheduled_date||today()}" min="${today()}"></div>
        <div class="form-group"><label class="label">Time (optional)</label>
          <input class="input" type="time" id="wkPinTime" value="${w.scheduled_time||''}"></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-purple" onclick="saveWorkoutPin('${workoutId}')">Reschedule</button>
    </div>`);
}

async function saveWorkoutPin(workoutId) {
  const d = document.getElementById('wkPinDate').value;
  const t = document.getElementById('wkPinTime').value || null;
  if (!d) { toast('Choose a date', 'warn'); return; }
  closeModal();
  await api.update_fitness_workout(workoutId, { scheduled_date: d, scheduled_time: t });
  toast(`Workout set for ${fmtDate(d)}`, 'ok');
  await refreshAll();
}

// For a skipped/ghost session, find the forward session the skip created.
function rescheduledTo(ghost) {
  const s = S.sessions.find(x =>
    x.topic_id === ghost.topic_id &&
    x.status === 'scheduled' &&
    x.reschedule_reason === 'skipped' &&
    x.original_date === ghost.scheduled_date);
  return s ? s.scheduled_date : null;
}

function sessionCard(s) {
  const topic = S.topics.find(t => t.id === s.topic_id) || {};
  const color = parseColors(S.settings.subject_colors)[s.subject] || topic.color || '#337EA9';
  const done    = s.status === 'completed';
  const skipped = s.status === 'skipped';
  const rto     = skipped ? rescheduledTo(s) : null;
  const cls = done ? 'session-card done'
            : skipped ? 'session-card skipped'
            : s.is_rescheduled ? 'session-card rescheduled' : 'session-card';
  const bg  = (!done && !skipped) ? ` style="background:${tint(color,.07)}"` : '';
  return `
  <div class="${cls}"${bg}${s.why?` title="${esc(s.why)}"`:''}>
    <div class="s-strip" style="background:${skipped?'var(--n300)':color}"></div>
    <div class="s-info">
      <div class="s-name">${esc(s.topic_name)}</div>
      <div class="s-meta">
        <span>${esc(s.subject||'')}</span>
        ${skipped ? `<span class="badge badge-gray" style="font-size:10px">Rescheduled${rto?` → ${fmtDateShort(rto)}`:''}</span>` : ''}
        ${!skipped && s.reschedule_reason==='manual' ? `<span class="badge badge-amber" style="font-size:10px">📌 Manual</span>` : ''}
        ${!skipped && s.reschedule_reason==='extra' ? `<span class="badge badge-blue" style="font-size:10px">＋ Extra</span>` : ''}
        ${!skipped && s.reschedule_reason==='missed' ? `<span class="badge badge-amber" style="font-size:10px" title="Missed on ${fmtDateShort(s.original_date)} — brought back so nothing slips">↻ Catch-up</span>` : ''}
        ${!skipped && s.reschedule_reason==='skipped' && s.is_rescheduled ? `<span class="badge badge-amber" style="font-size:10px">Rescheduled</span>` : ''}
        ${s.scheduled_time ? `<span class="s-time-badge">${esc(s.scheduled_time)}</span>` : ''}
        ${s.scheduled_duration ? `<span>${s.scheduled_duration}min</span>` : ''}
        ${!done && !skipped && s.why ? `<span class="s-why">${esc(s.why)}</span>` : ''}
      </div>
    </div>
    <div class="s-actions">
      ${done ? `<span class="badge badge-green">✓ Done</span>`
      : skipped ? `
        <button class="btn-icon check" onclick="unskipSession('${s.id}')" title="Re-add to today">
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M8 4L4 8l4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 8h8a4 4 0 0 1 4 4v2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>`
      : `
        <button class="btn-icon check" onclick="openRatingModal('${s.id}')" title="Mark done">
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M4 10l5 5 7-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="btn-icon skip-btn" onclick="skipSession('${s.id}')" title="Skip">
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M9 6l6 4-6 4V6zM5 6v8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="btn-icon" onclick="openManualRescheduleModal('${s.id}')" title="Reschedule manually — pinned, the AI won't move it">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M12 3l5 5-6 2-4 4-1-1 4-4 2-6z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M7 13l-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>`}
    </div>
  </div>`;
}

function examMini(e) {
  const nc = e.days_until <= 3 ? 'red' : e.days_until <= 7 ? 'amber' : 'green';
  const cls = e.days_until <= 3 ? 'urgent' : e.days_until <= 7 ? 'soon' : 'ok';
  return `<div class="exam-card ${cls}" style="padding:12px 16px">
    <div class="exam-cdown"><div class="exam-days ${nc}">${e.days_until}</div><div class="exam-dlabel">DAYS</div></div>
    <div class="exam-info"><div class="exam-name">${esc(e.name)}</div><div class="exam-date-str">${fmtDate(e.exam_date)}${e.readiness!=null?` · <span style="font-weight:600;color:${e.readiness>=85?'var(--green)':e.readiness>=60?'var(--amber)':'var(--red)'}">🎯 ${e.readiness}%</span>`:''}</div></div>
  </div>`;
}

// ══════════════════════════════════════════════════════
// SUBJECTS & TOPICS
// ══════════════════════════════════════════════════════
function renderTopics(main) {
  const colors = parseColors(S.settings.subject_colors);
  const subjects = {};
  S.topics.forEach(t => {
    const sub = t.subject || 'General';
    if (!subjects[sub]) subjects[sub] = { name: sub, color: colors[sub] || t.color || '#337EA9', topics: [] };
    subjects[sub].topics.push(t);
  });
  const subList = Object.values(subjects);

  main.innerHTML = `
    <div class="page-hero">
      <div class="hero-label">LIBRARY</div>
      <div class="hero-date">Subjects &amp; Topics</div>
      <div class="hero-sub">${S.topics.length} topic${S.topics.length!==1?'s':''} across ${subList.length} subject${subList.length!==1?'s':''}</div>
    </div>
    <div class="content">
      <div class="section-bar mb16">
        <span class="section-title">YOUR SUBJECTS</span>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-ghost btn-sm" id="recalcBtn" onclick="triggerRecalculate()" title="Rebuild the full schedule using current priorities and exam dates">
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" style="margin-right:4px"><path d="M4 10a6 6 0 1 1 1.5 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4 14V10H8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Recalculate
          </button>
          <button class="btn btn-primary btn-sm" onclick="openAddTopicModal()">+ Add Topic</button>
        </div>
      </div>
      ${subList.length === 0 ? `
        <div class="empty">
          <div class="empty-icon">📚</div>
          <div class="empty-title">No topics yet</div>
          <div class="empty-desc">Create your first topic to begin spaced repetition scheduling.</div>
          <button class="btn btn-primary mt16" onclick="openAddTopicModal()">Add your first topic</button>
        </div>` : `
      <div class="subject-grid">
        ${subList.map(subjectWindow).join('')}
      </div>`}
    </div>`;
}

async function triggerRecalculate() {
  const btn = document.getElementById('recalcBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Recalculating…'; }
  await api.recalculate_schedule();
  await refreshAll();
  toast('Schedule recalculated!', 'ok');
  if (btn) { btn.disabled = false; btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 20 20" fill="none" style="margin-right:4px"><path d="M4 10a6 6 0 1 1 1.5 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4 14V10H8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Recalculate`; }
}

function parseColors(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function subjectWindow(sub) {
  const total = sub.topics.length;
  return `
  <div class="subject-window">
    <div class="sw-header">
      <div class="sw-dot" style="background:${sub.color};cursor:pointer" title="Change color"
           data-subj="${esc(sub.name)}" data-color="${sub.color}"
           onclick="openSubjectColorModal(this.dataset.subj, this.dataset.color)"></div>
      <div class="sw-name">${esc(sub.name)}</div>
      <div class="sw-actions">
        <button class="btn-icon" data-subj="${esc(sub.name)}" onclick="openAddTopicModal(this.dataset.subj)" title="Add topic">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>
    <div class="sw-stats">
      <span>${total} topic${total!==1?'s':''}</span>
    </div>
    <div class="sw-topics">
      ${total === 0
        ? `<div class="sw-empty">No topics — add one above</div>`
        : sub.topics.map(topicRow).join('')}
    </div>
    <div class="sw-add-row" data-subj="${esc(sub.name)}" onclick="openAddTopicModal(this.dataset.subj)">
      <svg width="12" height="12" viewBox="0 0 20 20" fill="none"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      Add topic to ${esc(sub.name)}
    </div>
  </div>`;
}

// ── Subject color picker ──────────────────────────────────────────────────────
const _PALETTE_COLORS = [
  '#337EA9','#9065B0','#D44C47','#448361',
  '#CB912F','#D9730D','#C14C8A','#2F7E79',
  '#40566D','#9F6B53','#6E7F3E','#787774',
  '#191919','#5B8A72','#8A6BBE','#B65C49',
];

function openSubjectColorModal(subject, currentColor) {
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Color — ${esc(subject)}</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <p class="label" style="margin-bottom:10px">Choose a color for all topics in this subject</p>
      <div class="color-swatch-grid">
        ${_PALETTE_COLORS.map(c => `<button class="color-swatch${c.toLowerCase()===currentColor.toLowerCase()?' active':''}"
          style="background:${c}" data-subj="${esc(subject)}" data-color="${c}"
          onclick="pickSubjectColor(this.dataset.subj, this.dataset.color)"></button>`).join('')}
      </div>
      <div style="margin-top:16px;display:flex;align-items:center;gap:10px">
        <label class="label" style="margin:0">Custom:</label>
        <input type="color" id="customColorPick" value="${currentColor}"
               style="width:44px;height:32px;border-radius:6px;border:1px solid var(--n200);cursor:pointer;padding:2px">
        <button class="btn btn-primary btn-sm" data-subj="${esc(subject)}"
                onclick="pickSubjectColor(this.dataset.subj, document.getElementById('customColorPick').value)">Apply</button>
      </div>
    </div>`);
}

async function pickSubjectColor(subject, color) {
  closeModal();
  await api.update_subject_color(subject, color);
  await refreshAll();
  toast('Color updated', 'ok');
}


function topicRow(t) {
  const nextSess = S.sessions.find(s => s.topic_id === t.id && s.status === 'scheduled');
  const nextDate = nextSess ? fmtDateShort(nextSess.scheduled_date) : '—';
  const dur = t.session_duration || S.settings.default_session_duration || 25;
  return `
  <div class="sw-topic-row">
    <div class="sw-topic-info">
      <div class="sw-topic-name">
        ${t.exam_pressure ? `<span class="pressure-dot" title="Exam approaching!"></span> ` : ''}
        ${esc(t.name)}
      </div>
      <div class="sw-topic-meta">
        ${priorityBadge(t.priority)}
        <span class="level-chip lv-${t.level_tier||0}" title="Memory level — grows as reviews stick">${t.level||'New'}</span>
        ${t.retention!=null ? `<span title="Estimated chance you could recall this right now">${t.retention}% recall</span>` : ''}
        <span>${dur} min</span>
        <span>Next: ${nextDate}</span>
      </div>
    </div>
    <div class="sw-topic-actions">
      <button class="btn-icon" onclick="openAddSessionModal('${t.id}')" title="Add session — an extra one on top of the plan">
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><rect x="3" y="4" width="14" height="13" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M3 8h14M7 3v2M13 3v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10 10.5v4M8 12.5h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
      <button class="btn-icon" onclick="openTopicSessionsModal('${t.id}')" title="Sessions">
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><rect x="3" y="4" width="14" height="13" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M3 8h14M7 3v2M13 3v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
      <button class="btn-icon" onclick="openEditTopicModal('${t.id}')" title="Edit">
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M4 16l3-1 8-8-2-2-8 8-1 3zm10-11l1-1a1.4 1.4 0 0 1 2 2l-1 1-2-2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
      </button>
      <button class="btn-icon" onclick="deleteTopic('${t.id}')" title="Delete">
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M6 4h8M4 6h12M7 6v10h6V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════
// CALENDAR — Google Calendar style, Monday-first
// ══════════════════════════════════════════════════════
function renderCalendar(main) {
  main.innerHTML = `
    <div class="page-hero">
      <div class="hero-label">OVERVIEW</div>
      <div class="hero-date">Calendar</div>
    </div>
    <div class="content"><div class="cal-v2" id="calV2"></div></div>`;
  buildCalendar();
}

function buildCalendar() {
  const c = document.getElementById('calV2');
  if (!c) return;
  const d  = S.calDate;
  const yr = d.getFullYear();
  const mo = d.getMonth();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const days   = ['MON','TUE','WED','THU','FRI','SAT','SUN'];

  const firstDay   = new Date(yr, mo, 1).getDay();
  const startOff   = (firstDay + 6) % 7;
  const dInMonth   = new Date(yr, mo+1, 0).getDate();
  const dInPrev    = new Date(yr, mo, 0).getDate();
  const totalCells = Math.ceil((startOff + dInMonth) / 7) * 7;
  const todayStr   = today();

  // Build event map — every session chip (past and future) carries its
  // subject's CURRENT colour: resolved by subject name first, so changing a
  // subject's colour recolours the whole history, even for sessions whose
  // topic was later deleted or re-created.
  const evMap = {};
  const subjColors = parseColors(S.settings.subject_colors);
  const tColor = {};
  S.topics.forEach(t => { tColor[t.id] = t.color || '#337EA9'; });
  S.sessions.forEach(s => {
    const k = s.scheduled_date; if (!k) return;
    const type = s.status==='completed'?'done':s.status==='missed'?'missed':s.status==='skipped'?'skipped':'study';
    const pin  = type==='study' && s.reschedule_reason==='manual' ? '📌 ' : '';
    (evMap[k] = evMap[k]||[]).push({
      type,
      label: pin + s.topic_name,
      color: subjColors[s.subject] || tColor[s.topic_id] || null,
      why: s.why || ''
    });
  });
  S.exams.forEach(e => {
    const k = e.exam_date; if (!k) return;
    (evMap[k] = evMap[k]||[]).push({ type:'exam', label: e.name });
  });
  // Workouts (for sports with "show in calendar" enabled)
  (S.fitnessWorkouts||[]).forEach(w => {
    const k = w.scheduled_date; if (!k) return;
    const sp = S.fitnessSports.find(x => x.id === w.sport_id);
    if (!sp || !sp.show_in_calendar) return;
    (evMap[k] = evMap[k]||[]).push({
      type: w.status==='completed' ? 'done' : 'workout',
      label: `${sp.icon||'💪'} ${w.name||sp.name}`,
      color: sp.color || '#9065B0'
    });
  });

  let cells = '';
  for (let i = 0; i < totalCells; i++) {
    let dt, other = false;
    if (i < startOff) {
      dt = new Date(yr, mo-1, dInPrev - startOff + i + 1); other = true;
    } else if (i - startOff >= dInMonth) {
      dt = new Date(yr, mo+1, i - startOff - dInMonth + 1); other = true;
    } else {
      dt = new Date(yr, mo, i - startOff + 1);
    }
    const ds  = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
    const evs = evMap[ds] || [];
    const isT = ds === todayStr;
    const isSel = S.calSelected === ds;
    const sds = S.specialDates.filter(x => x.start_date <= ds && ds <= x.end_date);
    const sdOff = sds.some(x => x.date_type === 'off' && !(x.start_time && x.end_time));
    const sdRed = !sdOff && sds.some(x => x.date_type === 'reduced');
    const sdPart = !sdOff && !sdRed && sds.length > 0;   // timed off-block only
    cells += `
      <div class="cal-cell-v2${other?' other-month':''}${isT?' today':''}${isSel?' selected':''}${sdOff?' blocked-day':''}" onclick="selectCalDay('${ds}')">
        <div class="cal-cell-num">${dt.getDate()}</div>
        ${sdOff?`<div class="cal-day-tag t-off">Day off</div>`:sdRed?`<div class="cal-day-tag t-reduced">Reduced</div>`:sdPart?`<div class="cal-day-tag t-reduced">Partial</div>`:''}
        ${evs.slice(0,3).map(ev=>{
          // Background carries the subject/sport colour; the left border is
          // NOT overridden — it keeps the status colour from the legend.
          const st = ev.color
            ? ` style="background:${tint(ev.color,.15)}${(ev.type==='study'||ev.type==='workout')?`;color:${ev.color}`:''}"`
            : '';
          return `<div class="cal-event ev-${ev.type}"${st} title="${esc(ev.label)}${ev.why?` — ${esc(ev.why)}`:''}">${esc(ev.label)}</div>`;
        }).join('')}
        ${evs.length>3?`<div style="font-size:10px;color:var(--n400);padding:1px 4px">+${evs.length-3} more</div>`:''}
      </div>`;
  }

  c.innerHTML = `
    <div class="cal-header">
      <div class="cal-nav-left">
        <button class="btn btn-ghost btn-sm" onclick="calNav(-1)">← Prev</button>
        <div class="cal-month-title">${months[mo]} ${yr}</div>
        <button class="btn btn-ghost btn-sm" onclick="calNav(1)">Next →</button>
        <button class="btn btn-ghost btn-sm" id="calRefreshBtn" onclick="refreshCalendar()" title="Reload the calendar">
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none" style="margin-right:4px"><path d="M4 10a6 6 0 1 1 1.5 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4 14V10H8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Refresh
        </button>
      </div>
      <div class="cal-legend">
        <span class="cal-legend-item li-study">Study</span>
        <span class="cal-legend-item li-exam">Exam</span>
        <span class="cal-legend-item li-done">Done</span>
        <span class="cal-legend-item li-missed">Missed</span>
        <span class="cal-legend-item li-skipped">Rescheduled</span>
        <span class="cal-legend-item li-workout">Workout</span>
      </div>
    </div>
    <div class="cal-grid-wrap">
      <div class="cal-day-names">${days.map(n=>`<div class="cal-dn">${n}</div>`).join('')}</div>
      <div class="cal-grid-v2">${cells}</div>
    </div>
    <div id="calDetail"></div>`;

  if (S.calSelected) renderCalDetail(S.calSelected);
}

function calNav(dir) {
  S.calDate = new Date(S.calDate.getFullYear(), S.calDate.getMonth()+dir, 1);
  buildCalendar();
}

async function refreshCalendar() {
  const btn = document.getElementById('calRefreshBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  let res = null;
  try { res = await api.deep_refresh(); } catch {}
  await refreshAll();   // reloads everything and re-renders the calendar
  if (res && res.report && res.report.length) {
    toast(`🔧 ${res.report.join(' · ')}`, 'warn');
  } else {
    toast('✓ All good — no scheduling issues found', 'ok');
  }
}
function selectCalDay(ds) {
  S.calSelected = S.calSelected === ds ? null : ds;
  buildCalendar();
}
function renderCalDetail(ds) {
  const el = document.getElementById('calDetail');
  if (!el) return;
  const ss = S.sessions.filter(s => s.scheduled_date === ds);
  const es = S.exams.filter(e => e.exam_date === ds);
  const ws = (S.fitnessWorkouts||[]).filter(w => w.scheduled_date === ds);
  if (!ss.length && !es.length && !ws.length) {
    el.innerHTML = `<div class="cal-detail-panel"><div class="cal-detail-title">${fmtDate(ds)}</div><p style="color:var(--n400);font-size:13px">Nothing scheduled</p></div>`;
    return;
  }
  el.innerHTML = `<div class="cal-detail-panel">
    <div class="cal-detail-title">${fmtDate(ds)}</div>
    ${es.map(e=>`<div class="cal-detail-row"><span class="badge badge-red">EXAM</span><span style="font-size:13px;font-weight:600">${esc(e.name)}</span></div>`).join('')}
    ${ws.map(w=>{
      const sp = S.fitnessSports.find(x=>x.id===w.sport_id)||{};
      const planned = w.status === 'planned';
      return `<div class="cal-detail-row">
        <div class="s-strip" style="background:${sp.color||'#9065B0'};height:18px;margin-right:2px"></div>
        <div style="flex:1"><b>${sp.icon||'💪'} ${esc(w.name||sp.name||'Workout')}</b> <span style="color:var(--n400);font-size:12px">${w.duration?w.duration+'min':''}</span></div>
        <span class="badge ${w.status==='completed'?'badge-green':'badge-purple'}">${w.status==='completed'?'done':'workout'}</span>
        ${planned ? `
        <button class="btn-icon check" title="Mark done" onclick="completeWorkout('${w.id}','${w.sport_id}')">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M4 10l5 5 7-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="btn-icon skip-btn" title="Skip — push to next open day" onclick="skipWorkout('${w.id}')">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M9 6l6 4-6 4V6zM5 6v8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="btn-icon" title="Reschedule manually" onclick="openWorkoutRescheduleModal('${w.id}')">
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M12 3l5 5-6 2-4 4-1-1 4-4 2-6z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M7 13l-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>` : ''}
      </div>`;
    }).join('')}
    ${ss.map(s=>{
      const t = S.topics.find(x=>x.id===s.topic_id)||{};
      const sColor = parseColors(S.settings.subject_colors)[s.subject] || t.color || '#337EA9';
      const skipped = s.status==='skipped';
      const pending = s.status==='scheduled';
      const manual  = pending && s.reschedule_reason==='manual';
      const extra   = pending && s.reschedule_reason==='extra';
      const catchup = pending && s.reschedule_reason==='missed';
      const rto = skipped ? rescheduledTo(s) : null;
      const st = s.status==='completed'?'badge-green':s.status==='missed'?'badge-amber':skipped?'badge-gray':catchup?'badge-amber':'badge-blue';
      const label = skipped ? `rescheduled${rto?` → ${fmtDateShort(rto)}`:''}` : manual ? '📌 manual' : extra ? '＋ extra' : catchup ? '↻ catch-up' : s.status;
      return `<div class="cal-detail-row">
        <div class="s-strip" style="background:${skipped?'var(--n300)':sColor};height:18px;margin-right:2px"></div>
        <div style="flex:1"><b style="${skipped?'color:var(--n500)':''}">${esc(s.topic_name)}</b> <span style="color:var(--n400);font-size:12px">${esc(s.subject||'')}</span>
          ${pending && s.why ? `<div style="font-size:11px;color:var(--n400);margin-top:1px">${esc(s.why)}</div>` : ''}</div>
        <span class="badge ${st}">${label}</span>
        ${skipped ? `<button class="btn-icon check" title="Re-add to its day" onclick="unskipSession('${s.id}')">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M8 4L4 8l4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 8h8a4 4 0 0 1 4 4v2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>` : ''}
        ${pending ? `
        <button class="btn-icon check" title="Mark done" onclick="openRatingModal('${s.id}')">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M4 10l5 5 7-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="btn-icon skip-btn" title="Skip — push to next open day" onclick="skipSession('${s.id}')">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M9 6l6 4-6 4V6zM5 6v8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="btn-icon" title="Reschedule manually — pinned, the AI won't move it" onclick="openManualRescheduleModal('${s.id}')">
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M12 3l5 5-6 2-4 4-1-1 4-4 2-6z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M7 13l-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

// ══════════════════════════════════════════════════════
// ACTIVE RECALL
// ══════════════════════════════════════════════════════
function renderRecall(main) {
  const todayStr = today();
  const weekAgo  = new Date(); weekAgo.setDate(weekAgo.getDate()-7);
  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate()-30);

  let deck = [...S.flashcards];
  if (S.recallSubject) deck = deck.filter(c => c.subject === S.recallSubject);
  if (S.recallTopic)   deck = deck.filter(c => c.topic_id === S.recallTopic);
  if (S.recallFilter === 'due')
    deck = deck.filter(c => !c.next_review_date || c.next_review_date <= todayStr);
  else if (S.recallFilter === 'failed_today')
    deck = deck.filter(c => c.last_review_date === todayStr && !c.last_correct);
  else if (S.recallFilter === 'failed_week')
    deck = deck.filter(c => c.last_review_date && new Date(c.last_review_date) >= weekAgo && !c.last_correct);
  else if (S.recallFilter === 'failed_month')
    deck = deck.filter(c => c.last_review_date && new Date(c.last_review_date) >= monthAgo && !c.last_correct);

  if (S.recallIdx >= deck.length && deck.length > 0) S.recallIdx = 0;
  S.recallDeck = deck;

  const subjects = [...new Set(S.flashcards.map(c=>c.subject).filter(Boolean))];
  const topicsForSubj = S.recallSubject ? S.topics.filter(t=>t.subject===S.recallSubject) : S.topics;

  const filterLabels = {due:'Due Today',failed_today:'Failed Today',failed_week:'Failed This Week',failed_month:'Failed This Month',all:'All Cards'};

  main.innerHTML = `
    <div class="page-hero">
      <div class="hero-label">STUDY</div>
      <div class="hero-date">Active Recall</div>
      <div class="hero-sub">${deck.length} card${deck.length!==1?'s':''} in deck</div>
    </div>
    <div class="content">
      <div class="recall-controls">
        <button class="btn btn-ghost btn-sm" onclick="restartDeck()">↺ Restart</button>
        <div class="recall-sep"></div>
        <select class="input" style="width:auto;padding:5px 10px;font-size:12px" onchange="S.recallSubject=this.value;S.recallTopic='';S.recallIdx=0;renderPage()">
          <option value="">All Subjects</option>
          ${subjects.map(s=>`<option value="${esc(s)}" ${S.recallSubject===s?'selected':''}>${esc(s)}</option>`).join('')}
        </select>
        <select class="input" style="width:auto;padding:5px 10px;font-size:12px" onchange="S.recallTopic=this.value;S.recallIdx=0;renderPage()">
          <option value="">All Topics</option>
          ${topicsForSubj.map(t=>`<option value="${t.id}" ${S.recallTopic===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}
        </select>
        <div class="recall-sep"></div>
        <div class="toggle-pills">
          ${Object.keys(filterLabels).map(f=>`<button class="toggle-pill${S.recallFilter===f?' active':''}" onclick="S.recallFilter='${f}';S.recallIdx=0;renderPage()">${filterLabels[f]}</button>`).join('')}
        </div>
      </div>

      ${deck.length === 0 ? `
        <div class="empty">
          <div class="empty-icon">🎯</div>
          <div class="empty-title">No cards to review</div>
          <div class="empty-desc">All caught up! Add cards in Subjects &amp; Topics or change the filter.</div>
        </div>` : `
      <div class="recall-area" id="recallArea">
        <div class="fc-counter">Card ${S.recallIdx+1} of ${deck.length}</div>
        ${flashcardEl(deck[S.recallIdx])}
      </div>`}

      <div class="section-bar mt24 mb8">
        <span class="section-title">ALL CARDS (${deck.length})</span>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-ghost btn-xs" onclick="S.showAnswers=!S.showAnswers;renderPage()">
            ${S.showAnswers ? '🙈 Hide Answers' : '👁 Show Answers'}
          </button>
          <button class="btn btn-primary btn-xs" onclick="openAddCardModal()">+ Add Card</button>
        </div>
      </div>
      <div class="fc-list">
        ${deck.length === 0
          ? `<div class="empty" style="padding:24px"><div class="empty-desc">No cards match this filter.</div></div>`
          : deck.map((card, i) => `
            <div class="fc-row">
              <div style="min-width:22px;font-size:12px;color:var(--n400);font-weight:600">${i+1}</div>
              <div style="flex:1">
                <div class="fc-row-q">${esc(card.question)}</div>
                <div class="fc-row-a${S.showAnswers?'':' hidden-answer'}">${esc(card.answer)}</div>
                ${card.subject?`<div style="margin-top:4px"><span class="badge badge-gray" style="font-size:10px">${esc(card.subject)}</span></div>`:''}
              </div>
              <div class="fc-row-actions">
                <button class="btn-icon" onclick="openEditCardModal('${card.id}')">
                  <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M4 16l3-1 8-8-2-2-8 8-1 3zm10-11l1-1a1.4 1.4 0 0 1 2 2l-1 1-2-2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
                </button>
                <button class="btn-icon" onclick="deleteCard('${card.id}')">
                  <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M6 4h8M4 6h12M7 6v10h6V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
              </div>
            </div>`).join('')}
      </div>
    </div>`;
}

function flashcardEl(card) {
  return `
  <div class="flashcard${S.recallFlipped?' flipped':''}" id="fcCard" onclick="flipCard()">
    <div class="fc-inner">
      <div class="fc-front">
        <div class="fc-label">QUESTION</div>
        <div class="fc-text">${esc(card.question)}</div>
        <div class="fc-hint">Click to reveal answer</div>
      </div>
      <div class="fc-back">
        <div class="fc-label">ANSWER</div>
        <div class="fc-text">${esc(card.answer)}</div>
      </div>
    </div>
  </div>
  <div class="fc-actions" id="fcActions" style="${S.recallFlipped?'':'visibility:hidden'}">
    <button class="btn btn-danger" onclick="rateCard('${card.id}',false)">✗ Wrong</button>
    <button class="btn btn-primary" onclick="rateCard('${card.id}',true)">✓ Correct</button>
  </div>`;
}

function flipCard() {
  S.recallFlipped = !S.recallFlipped;
  document.getElementById('fcCard')?.classList.toggle('flipped', S.recallFlipped);
  const acts = document.getElementById('fcActions');
  if (acts) acts.style.visibility = S.recallFlipped ? 'visible' : 'hidden';
}
function restartDeck() { S.recallIdx = 0; S.recallFlipped = false; renderPage(); }
async function rateCard(cardId, correct) {
  await api.rate_flashcard(cardId, correct);
  S.recallFlipped = false;
  S.recallIdx = (S.recallIdx + 1) % Math.max(1, S.recallDeck.length);
  S.flashcards = await api.get_flashcards() || [];
  renderPage();
}

// ══════════════════════════════════════════════════════
// EXAMS
// ══════════════════════════════════════════════════════
function renderExams(main) {
  const upcoming = S.exams.filter(e=>!e.is_past).sort((a,b)=>a.days_until-b.days_until);
  const past = S.exams.filter(e=>e.is_past);
  main.innerHTML = `
    <div class="page-hero">
      <div class="hero-label">LIBRARY</div>
      <div class="hero-date">Exams &amp; Tests</div>
      <div class="hero-sub">${upcoming.length} upcoming</div>
    </div>
    <div class="content">
      <div class="section-bar mb16">
        <span class="section-title">UPCOMING (${upcoming.length})</span>
        <button class="btn btn-primary btn-sm" onclick="openAddExamModal()">+ Add Exam</button>
      </div>
      ${upcoming.length===0
        ? `<div class="empty"><div class="empty-icon">📋</div><div class="empty-title">No upcoming exams</div><div class="empty-desc">Add exams to trigger pressure-aware scheduling.</div></div>`
        : `<div class="session-list">${upcoming.map(examCard).join('')}</div>`}
      ${past.length>0?`
        <div class="section-bar mt24 mb16"><span class="section-title">PAST (${past.length})</span></div>
        <div class="session-list">${past.map(examCard).join('')}</div>`:''}
    </div>`;
}

function examCard(e) {
  const nc = e.is_past?'green':e.days_until<=3?'red':e.days_until<=7?'amber':'green';
  const cls = e.is_past?'ok':e.days_until<=3?'urgent':e.days_until<=7?'soon':'ok';
  const impLabels = {1:'Low',2:'Medium',3:'High'};
  return `<div class="exam-card ${cls}">
    <div class="exam-cdown">
      <div class="exam-days ${nc}">${e.is_past?'✓':(e.days_until??'?')}</div>
      <div class="exam-dlabel">${e.is_past?'DONE':'DAYS'}</div>
    </div>
    <div class="exam-info">
      <div class="exam-name">${esc(e.name)}</div>
      <div class="exam-date-str">${fmtDate(e.exam_date)}${e.subject?` · <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${parseColors(S.settings.subject_colors)[e.subject]||'#94A3B8'};margin:0 3px 0 1px;vertical-align:baseline"></span>`+esc(e.subject):''}</div>
      <div class="exam-chips">
        ${e.readiness!=null?`<span class="badge ${e.readiness>=85?'badge-green':e.readiness>=60?'badge-amber':'badge-red'}" title="Predicted recall of this exam's topics on exam day, counting the reviews scheduled before it">🎯 ${e.readiness}% ready</span>`:''}
        <span class="badge badge-gray">Importance: ${impLabels[e.importance]||'?'}</span>
        ${(e.topic_ids||[]).length>0?`<span class="badge badge-blue">${e.topic_ids.length} topic${e.topic_ids.length!==1?'s':''} linked</span>`:''}
      </div>
    </div>
    <div class="exam-actions">
      <button class="btn-icon" onclick="openEditExamModal('${e.id}')">
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M4 16l3-1 8-8-2-2-8 8-1 3zm10-11l1-1a1.4 1.4 0 0 1 2 2l-1 1-2-2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
      </button>
      <button class="btn-icon" onclick="deleteExam('${e.id}')">
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M6 4h8M4 6h12M7 6v10h6V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════
// FITNESS HUB
// ══════════════════════════════════════════════════════
function renderFitness(main) {
  main.innerHTML = `
    <div class="page-hero">
      <div class="hero-label">LIBRARY</div>
      <div class="hero-date">Fitness Hub</div>
      <div class="hero-sub">${S.fitnessSports.length} sport${S.fitnessSports.length!==1?'s':''} tracked</div>
    </div>
    <div class="content">
      <div class="section-bar mb16">
        <span class="section-title">YOUR SPORTS</span>
        <button class="btn btn-purple btn-sm" onclick="openAddSportModal()">+ Add Sport</button>
      </div>
      ${S.fitnessSports.length===0
        ? `<div class="empty"><div class="empty-icon">🏋️</div><div class="empty-title">No sports yet</div><div class="empty-desc">Add Gym, Football, Tennis… then create workouts (Upper Body, Leg Day…) with their exercises inside.</div><button class="btn btn-purple mt16" onclick="openAddSportModal()">Add your first sport</button></div>`
        : `<div class="fitness-grid">${S.fitnessSports.map(sportCard).join('')}</div>`}
    </div>`;
}

function sportCard(sp) {
  const workouts = (S.fitnessWorkouts||[]).filter(w => w.sport_id === sp.id);
  return `
  <div class="sport-card">
    <div class="sport-header">
      <div class="sport-icon-wrap" style="background:${sp.color}22">${sp.icon||'💪'}</div>
      <div class="sport-name">${esc(sp.name)}</div>
      <div class="sw-actions">
        <button class="btn-icon" onclick="openAddWorkoutModal('${sp.id}')" title="Add workout">
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <button class="btn-icon" onclick="openEditSportModal('${sp.id}')" title="Edit">
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M4 16l3-1 8-8-2-2-8 8-1 3zm10-11l1-1a1.4 1.4 0 0 1 2 2l-1 1-2-2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
        </button>
        <button class="btn-icon" onclick="deleteSport('${sp.id}')" title="Delete">
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M6 4h8M4 6h12M7 6v10h6V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
    <div class="sport-stats">
      <span>${workouts.length} workout${workouts.length!==1?'s':''}</span>
      ${sp.next_workout?`<span>Next: ${fmtDateShort(sp.next_workout)}</span>`:''}
      ${sp.use_scheduling?`<span class="badge badge-blue" style="font-size:10px">Auto</span>`:''}
      ${sp.show_in_calendar?`<span class="badge badge-gray" style="font-size:10px">📅</span>`:''}
    </div>
    <div class="sport-body">
      ${workouts.length===0
        ? `<div class="sw-empty">No workouts yet — add one above</div>`
        : workouts.map(w => workoutRow(w, sp)).join('')}
    </div>
    <div class="sport-add-row" onclick="openAddWorkoutModal('${sp.id}')">
      <svg width="12" height="12" viewBox="0 0 20 20" fill="none"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      Add workout to ${esc(sp.name)}
    </div>
  </div>`;
}

function workoutRow(w, sp) {
  return `
  <div class="workout-row" style="cursor:pointer" onclick="openWorkoutModal('${sp.id}','${w.id}')" title="Open workout — exercises inside">
    <div class="workout-name">${esc(w.name||'Workout')}
      <span style="font-weight:400;color:var(--n400);font-size:11px;margin-left:6px">${w.exercise_count||0} exercise${(w.exercise_count||0)!==1?'s':''}</span>
    </div>
    <div class="workout-date">${w.scheduled_date?fmtDateShort(w.scheduled_date):''}</div>
    ${w.status==='completed'
      ? `<span class="badge badge-green">Done</span>`
      : w.scheduled_date
        ? `<button class="btn btn-ghost btn-sm" style="padding:3px 9px;font-size:11px" onclick="event.stopPropagation();completeWorkout('${w.id}','${sp.id}')">Done</button>`
        : ''}
    <button class="btn-icon" onclick="event.stopPropagation();deleteWorkout('${w.id}','${sp.id}')" title="Delete">
      <svg width="12" height="12" viewBox="0 0 20 20" fill="none"><path d="M6 4h8M4 6h12M7 6v10h6V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>`;
}

async function completeWorkout(workoutId, sportId) {
  const sp = S.fitnessSports.find(x=>x.id===sportId);
  if (sp && sp.use_scheduling) {
    openModal(`
      <div class="modal-hdr"><div class="modal-title">Rate Difficulty</div><button class="modal-x" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <p style="color:var(--n500);font-size:13px;margin-bottom:14px">How hard was this workout?</p>
        <div class="rating-v2">
          ${[[0,'😵','Very Easy'],[2,'🙂','Easy'],[5,'😐','Medium'],[7,'😬','Hard'],[10,'💀','Brutal']].map(([v,em,lb])=>
            `<button class="rating-v2-btn" onclick="submitWorkoutDone('${workoutId}','${sportId}',${v})">
              <span class="r-emoji">${em}</span><div class="r-label">${lb}</div><div class="r-sub">${v}/10</div>
            </button>`).join('')}
        </div>
      </div>`);
  } else {
    await api.update_fitness_workout(workoutId, { status:'completed' });
    toast('Workout done!', 'ok');
    await refreshAll();
  }
}

async function submitWorkoutDone(wId, spId, diff) {
  closeModal();
  await api.update_fitness_workout(wId, { status:'completed', difficulty: diff });
  toast('Workout done! Next session scheduled.', 'ok');
  await refreshAll();
}

async function deleteWorkout(wId, spId) {
  if (!confirm('Delete this workout and its exercises?')) return;
  await api.delete_fitness_workout(wId);
  toast('Deleted', 'warn');
  await refreshAll();
}

// ── Workout popup: exercise list with inline expand ───────────────────
let _wkCtx = null;   // { sportId, workoutId, exercises, openExId, adding }

async function openWorkoutModal(sportId, workoutId) {
  const exercises = await api.get_fitness_exercises(sportId, workoutId) || [];
  _wkCtx = { sportId, workoutId, exercises, openExId: null, adding: false };
  const w  = (S.fitnessWorkouts||[]).find(x=>x.id===workoutId) || {};
  const sp = S.fitnessSports.find(x=>x.id===sportId) || {};
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">${sp.icon||'💪'} ${esc(w.name||'Workout')} <span style="font-weight:400;color:var(--n400);font-size:13px">— ${esc(sp.name||'')}</span></div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-row">
        <div class="form-group"><label class="label">Scheduled date</label><input class="input" type="date" id="wkDate" value="${w.scheduled_date||''}"></div>
        <div class="form-group"><label class="label">Duration (min)</label><input class="input" type="number" id="wkDur" value="${w.duration||60}" min="5" max="300"></div>
      </div>
      <div class="today-divider" style="margin:6px 0 14px"></div>
      <div class="section-bar mb8"><span class="section-title">EXERCISES (<span id="wkExCount">${exercises.length}</span>)</span></div>
      <div id="wkExList"></div>
      <button class="btn btn-ghost btn-sm mt16" onclick="wkStartAdd()" id="wkAddBtn">+ Add exercise</button>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Close</button>
      <button class="btn btn-purple" onclick="saveWorkoutMeta()">Save</button>
    </div>`);
  _renderWkExercises();
}

function _exSummary(ex) {
  const bits = [];
  if (ex.sets && ex.reps) bits.push(`${ex.sets}×${esc(String(ex.reps))}`);
  else if (ex.sets) bits.push(`${ex.sets} sets`);
  else if (ex.reps) bits.push(`${esc(String(ex.reps))} reps`);
  if (ex.weight)       bits.push(esc(String(ex.weight)));
  if (ex.duration_min) bits.push(`${ex.duration_min}min`);
  if (ex.distance)     bits.push(esc(String(ex.distance)));
  return bits.join(' · ') || 'no details yet';
}

function _renderWkExercises() {
  const el = document.getElementById('wkExList');
  if (!el || !_wkCtx) return;
  const { exercises, openExId, adding } = _wkCtx;
  const cnt = document.getElementById('wkExCount');
  if (cnt) cnt.textContent = exercises.length;

  const exForm = (ex) => `
    <div class="wk-ex-body">
      <div class="form-group"><label class="label">Name</label><input class="input" id="exName" value="${esc(ex.name||'')}" placeholder="e.g. Bench press"></div>
      <div class="form-row">
        <div class="form-group"><label class="label">Sets</label><input class="input" type="number" id="exSets" value="${ex.sets??''}" min="0"></div>
        <div class="form-group"><label class="label">Reps</label><input class="input" id="exReps" value="${esc(String(ex.reps??''))}" placeholder="e.g. 12 or 8-10"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="label">Weight</label><input class="input" id="exWeight" value="${esc(String(ex.weight??''))}" placeholder="e.g. 40kg"></div>
        <div class="form-group"><label class="label">Time (min)</label><input class="input" type="number" id="exDur" value="${ex.duration_min??''}" min="0"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="label">Distance</label><input class="input" id="exDist" value="${esc(String(ex.distance??''))}" placeholder="e.g. 5km"></div>
        <div class="form-group"><label class="label">Notes</label><input class="input" id="exNotes" value="${esc(ex.notes||'')}"></div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px">
        ${ex.id ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="wkDeleteExercise('${ex.id}')">Delete</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="wkCollapse()">Cancel</button>
        <button class="btn btn-purple btn-sm" onclick="wkSaveExercise('${ex.id||''}')">Save</button>
      </div>
    </div>`;

  let html = exercises.map(ex => `
    <div class="wk-ex-row${openExId===ex.id?' open':''}">
      <div class="wk-ex-head" onclick="wkToggle('${ex.id}')">
        <span class="wk-ex-name">${esc(ex.name||'Exercise')}</span>
        <span class="wk-ex-summary">${_exSummary(ex)}</span>
        <svg class="wk-ex-chev" width="12" height="12" viewBox="0 0 20 20" fill="none"><path d="M7 5l6 5-6 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      ${openExId===ex.id ? exForm(ex) : ''}
    </div>`).join('');

  if (!exercises.length && !adding)
    html = `<div class="sw-empty">No exercises yet — add the first one below</div>`;
  if (adding)
    html += `<div class="wk-ex-row open"><div class="wk-ex-head"><span class="wk-ex-name" style="color:var(--purple)">New exercise</span></div>${exForm({})}</div>`;

  el.innerHTML = html;
  const addBtn = document.getElementById('wkAddBtn');
  if (addBtn) addBtn.style.display = adding ? 'none' : '';
}

function wkToggle(exId) {
  if (!_wkCtx) return;
  _wkCtx.adding = false;
  _wkCtx.openExId = (_wkCtx.openExId === exId) ? null : exId;
  _renderWkExercises();
}
function wkCollapse() {
  if (!_wkCtx) return;
  _wkCtx.openExId = null; _wkCtx.adding = false;
  _renderWkExercises();
}
function wkStartAdd() {
  if (!_wkCtx) return;
  _wkCtx.openExId = null; _wkCtx.adding = true;
  _renderWkExercises();
}

async function wkSaveExercise(exId) {
  if (!_wkCtx) return;
  const name = document.getElementById('exName').value.trim();
  if (!name) { toast('Exercise name required', 'warn'); return; }
  const data = {
    name,
    sets:         parseInt(document.getElementById('exSets').value) || null,
    reps:         document.getElementById('exReps').value.trim() || null,
    weight:       document.getElementById('exWeight').value.trim() || null,
    duration_min: parseInt(document.getElementById('exDur').value) || null,
    distance:     document.getElementById('exDist').value.trim() || null,
    notes:        document.getElementById('exNotes').value.trim(),
  };
  if (exId) {
    await api.update_fitness_exercise(exId, data);
  } else {
    await api.add_fitness_exercise({ ...data, sport_id: _wkCtx.sportId, workout_id: _wkCtx.workoutId,
                                     order_index: _wkCtx.exercises.length });
  }
  _wkCtx.exercises = await api.get_fitness_exercises(_wkCtx.sportId, _wkCtx.workoutId) || [];
  _wkCtx.openExId = null; _wkCtx.adding = false;
  _renderWkExercises();
  toast('Exercise saved', 'ok');
}

async function wkDeleteExercise(exId) {
  if (!_wkCtx || !confirm('Delete this exercise?')) return;
  await api.delete_fitness_exercise(exId);
  _wkCtx.exercises = await api.get_fitness_exercises(_wkCtx.sportId, _wkCtx.workoutId) || [];
  _wkCtx.openExId = null;
  _renderWkExercises();
  toast('Exercise deleted', 'warn');
}

async function saveWorkoutMeta() {
  if (!_wkCtx) return;
  await api.update_fitness_workout(_wkCtx.workoutId, {
    scheduled_date: document.getElementById('wkDate').value || null,
    duration:       parseInt(document.getElementById('wkDur').value) || 60,
  });
  closeModal();
  toast('Workout saved', 'ok');
  await refreshAll();
}

// ══════════════════════════════════════════════════════
// AVAILABILITY
// ══════════════════════════════════════════════════════
function renderOtherDates(main) {
  const off          = S.specialDates.filter(s=>s.date_type==='off');
  const reduced      = S.specialDates.filter(s=>s.date_type==='reduced');
  const restrictions = S.studyRestrictions || [];
  main.innerHTML = `
    <div class="page-hero">
      <div class="hero-label">SCHEDULE</div>
      <div class="hero-date">Availability</div>
      <div class="hero-sub">Days off, reduced availability &amp; topic restrictions</div>
    </div>
    <div class="content">
      <div class="section-bar mb16">
        <span class="section-title">DAYS OFF (${off.length})</span>
        <button class="btn btn-primary btn-sm" onclick="openAddSpecialDateModal('off')">+ Add Day Off</button>
      </div>
      ${off.length===0?`<div class="empty" style="padding:24px 0"><div class="empty-desc">No days off added.</div></div>`
        :`<div class="session-list">${off.map(sdCard).join('')}</div>`}
      <div class="section-bar mt24 mb16">
        <span class="section-title">REDUCED DAYS (${reduced.length})</span>
        <button class="btn btn-ghost btn-sm" onclick="openAddSpecialDateModal('reduced')">+ Add Reduced Day</button>
      </div>
      ${reduced.length===0?`<div class="empty" style="padding:24px 0"><div class="empty-desc">No reduced days added.</div></div>`
        :`<div class="session-list">${reduced.map(sdCard).join('')}</div>`}
      <div class="section-bar mt24 mb16">
        <span class="section-title">TOPIC RESTRICTIONS (${restrictions.length})</span>
        <button class="btn btn-ghost btn-sm" onclick="openAddRestrictionModal()">+ Add Restriction</button>
      </div>
      ${restrictions.length===0
        ?`<div class="empty" style="padding:24px 0"><div class="empty-desc">No restrictions added. Block a subject or topic from being scheduled on specific dates.</div></div>`
        :`<div class="session-list">${restrictions.map(restrictionCard).join('')}</div>`}
    </div>`;
}

function sdCard(sd) {
  const isOff = sd.date_type==='off';
  const ds = sd.start_date===sd.end_date ? fmtDate(sd.start_date) : `${fmtDate(sd.start_date)} – ${fmtDate(sd.end_date)}`;
  const hr = sd.start_time && sd.end_time ? ` · ${sd.start_time}–${sd.end_time}` : '';
  return `<div class="sd-card">
    <div class="sd-icon ${isOff?'off':'reduced'}">${isOff?'🚫':'⚡'}</div>
    <div class="sd-info">
      <div class="sd-name">${esc(sd.name)}</div>
      <div class="sd-range">${ds}${hr}</div>
      <div class="sd-type-label">${isOff?'Day off — no sessions scheduled':`Reduced · max priority ${sd.max_priority}`}</div>
    </div>
    <div class="sd-actions">
      <button class="btn-icon" onclick="openEditSpecialDateModal('${sd.id}')">
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M4 16l3-1 8-8-2-2-8 8-1 3zm10-11l1-1a1.4 1.4 0 0 1 2 2l-1 1-2-2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
      </button>
      <button class="btn-icon" onclick="deleteSpecialDate('${sd.id}')">
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M6 4h8M4 6h12M7 6v10h6V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════
// RATING MODAL  (0-10 scale, 5 descriptive buttons)
// ══════════════════════════════════════════════════════
function openRatingModal(sessionId) {
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Rate This Session</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <p style="color:var(--n500);font-size:13px;margin-bottom:14px">Before checking your notes, how much could you recall from memory?</p>
      <div class="rating-v2">
        <button class="rating-v2-btn" onclick="submitRating('${sessionId}',0)">
          <span class="r-emoji">😵</span><div class="r-label">Blackout</div><div class="r-sub">No recall at all</div>
        </button>
        <button class="rating-v2-btn" onclick="submitRating('${sessionId}',2)">
          <span class="r-emoji">😬</span><div class="r-label">Wrong</div><div class="r-sub">Recalled incorrectly</div>
        </button>
        <button class="rating-v2-btn r-ok" onclick="submitRating('${sessionId}',5)">
          <span class="r-emoji">😐</span><div class="r-label">Hard</div><div class="r-sub">Barely — big struggle</div>
        </button>
        <button class="rating-v2-btn r-good" onclick="submitRating('${sessionId}',7)">
          <span class="r-emoji">🙂</span><div class="r-label">Good</div><div class="r-sub">Recalled with effort</div>
        </button>
        <button class="rating-v2-btn r-great" onclick="submitRating('${sessionId}',10)">
          <span class="r-emoji">🚀</span><div class="r-label">Easy</div><div class="r-sub">Instant &amp; effortless</div>
        </button>
      </div>
    </div>`);
}

async function submitRating(sessionId, rating) {
  closeModal();
  try {
    const res = await api.complete_session(sessionId, rating);
    if (res?.success) {
      const nr = res.next_review ? ` · Next: ${fmtDate(res.next_review)}` : '';
      toast(`Done! Level: ${res.level||'—'}${nr}`, 'ok');
    }
  } catch { toast('Error saving session', 'err'); }
  await refreshAll();
}

async function skipSession(sessionId) {
  const res = await api.skip_session(sessionId);
  toast(`Rescheduled to ${res?.rescheduled_to ? fmtDate(res.rescheduled_to) : 'soon'}`, 'warn');
  await refreshAll();
}

async function unskipSession(sessionId) {
  await api.unskip_session(sessionId);
  toast('Re-added', 'ok');
  await refreshAll();
}

// ── Manual reschedule (pin): user picks the date, AI never moves it ──────
function openManualRescheduleModal(sessionId) {
  const s = S.sessions.find(x => x.id === sessionId) || {};
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Reschedule Manually</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <p style="color:var(--n500);font-size:13px;margin-bottom:14px">
        <b>${esc(s.topic_name||'Session')}</b> will be pinned 📌 to the date you choose.
        The AI will rebuild everyone else's schedule around it, but will never move a pinned session.
      </p>
      <div class="form-row">
        <div class="form-group"><label class="label">New date</label>
          <input class="input" type="date" id="pinDate" value="${s.scheduled_date||today()}" min="${today()}"></div>
        <div class="form-group"><label class="label">Time (optional)</label>
          <input class="input" type="time" id="pinTime" value="${s.scheduled_time||''}"></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="savePinnedReschedule('${sessionId}')">📌 Pin Session</button>
    </div>`);
}

async function savePinnedReschedule(sessionId) {
  const dateStr = document.getElementById('pinDate').value;
  const timeStr = document.getElementById('pinTime').value || null;
  if (!dateStr) { toast('Choose a date', 'warn'); return; }
  closeModal();
  await api.reschedule_session(sessionId, dateStr, timeStr);
  toast(`Pinned to ${fmtDate(dateStr)} — schedule rebuilt around it`, 'ok');
  await refreshAll();
}

// ══════════════════════════════════════════════════════
// TOPIC MODALS
// ══════════════════════════════════════════════════════
function subjectOptions(sel='') {
  return [...new Set(S.topics.map(t=>t.subject).filter(Boolean))]
    .map(s=>`<option value="${esc(s)}" ${sel===s?'selected':''}>${esc(s)}</option>`).join('');
}

function openAddTopicModal(preSubject='') {
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Add Topic</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="label">Topic name *</label>
        <input class="input" id="tName" placeholder="e.g. Differential Equations">
      </div>
      <div class="form-group">
        <label class="label">Subject *</label>
        <input class="input" id="tSubject" placeholder="e.g. Mathematics" value="${esc(preSubject)}" list="subjectList">
        <datalist id="subjectList">${subjectOptions()}</datalist>
      </div>
      <div class="form-group">
        <label class="label">Priority</label>
        <div class="prio-row">
          ${[1,2,3,4,5].map(p=>{const lb={1:'Critical',2:'High',3:'Medium',4:'Low',5:'Minimal'}[p];
            return `<button type="button" class="prio-btn p${p}${p===3?' active':''}" onclick="setPrio(this,${p},'tPrio')">${lb}</button>`;}).join('')}
        </div>
        <input type="hidden" id="tPrio" value="3">
      </div>
      <div class="form-group">
        <label class="label">Session duration</label>
        <div style="display:flex;align-items:center;gap:8px">
          <input class="input" type="number" id="tDuration" min="5" max="300" step="5"
                 value="${S.settings.default_session_duration || 25}" style="width:90px">
          <span style="color:var(--n400);font-size:13px">minutes per session</span>
        </div>
      </div>
      <div class="form-group">
        <label class="label">Description</label>
        <textarea class="input" id="tDesc" rows="2" placeholder="Optional notes"></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveTopic()">Add Topic</button>
    </div>`);
}

function setPrio(btn, p, hiddenId) {
  btn.closest('.prio-row').querySelectorAll('.prio-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(hiddenId).value = p;
}

async function saveTopic() {
  const name     = document.getElementById('tName').value.trim();
  const subject  = document.getElementById('tSubject').value.trim() || 'General';
  const priority = parseInt(document.getElementById('tPrio').value);
  const desc     = document.getElementById('tDesc').value.trim();
  const duration = parseInt(document.getElementById('tDuration').value) || (S.settings.default_session_duration || 25);
  if (!name) { toast('Enter a topic name', 'warn'); return; }
  closeModal();
  await api.add_topic({ name, subject, priority, description: desc, session_duration: duration });
  toast(`"${name}" added! First session scheduled.`, 'ok');
  await refreshAll();
}

function openEditTopicModal(topicId) {
  const t = S.topics.find(x=>x.id===topicId);
  if (!t) return;
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Edit Topic</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="label">Topic name</label>
        <input class="input" id="etName" value="${esc(t.name)}">
      </div>
      <div class="form-group">
        <label class="label">Subject</label>
        <input class="input" id="etSubject" value="${esc(t.subject||'')}" list="etSubjList">
        <datalist id="etSubjList">${subjectOptions()}</datalist>
      </div>
      <div class="form-group">
        <label class="label">Priority</label>
        <div class="prio-row">
          ${[1,2,3,4,5].map(p=>{const lb={1:'Critical',2:'High',3:'Medium',4:'Low',5:'Minimal'}[p];
            return `<button type="button" class="prio-btn p${p}${p===t.priority?' active':''}" onclick="setPrio(this,${p},'etPrio')">${lb}</button>`;}).join('')}
        </div>
        <input type="hidden" id="etPrio" value="${t.priority}">
      </div>
      <div class="form-group">
        <label class="label">Session duration</label>
        <div style="display:flex;align-items:center;gap:8px">
          <input class="input" type="number" id="etDuration" min="5" max="300" step="5"
                 value="${t.session_duration || S.settings.default_session_duration || 25}" style="width:90px">
          <span style="color:var(--n400);font-size:13px">minutes per session</span>
        </div>
      </div>
      <div class="form-group">
        <label class="label">Description</label>
        <textarea class="input" id="etDesc" rows="2">${esc(t.description||'')}</textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="updateTopic('${topicId}')">Save</button>
    </div>`);
}

async function updateTopic(topicId) {
  const name     = document.getElementById('etName').value.trim();
  const subject  = document.getElementById('etSubject').value.trim() || 'General';
  const priority = parseInt(document.getElementById('etPrio').value);
  const desc     = document.getElementById('etDesc').value.trim();
  const duration = parseInt(document.getElementById('etDuration').value) || (S.settings.default_session_duration || 25);
  if (!name) { toast('Name required', 'warn'); return; }
  closeModal();
  await api.update_topic(topicId, { name, subject, priority, description: desc, session_duration: duration });
  toast('Topic updated', 'ok');
  await refreshAll();
}

async function deleteTopic(topicId) {
  const t = S.topics.find(x=>x.id===topicId);
  if (!t || !confirm(`Delete "${t.name}"? This can be undone for a few seconds.`)) return;
  // Snapshot before deletion
  const topicSnap = {...t};
  const sessSnap  = (await api.get_topic_sessions(topicId) || []).map(s => ({...s}));
  await api.delete_topic(topicId);
  await refreshAll();
  setUndo(`"${t.name}" deleted`, async () => {
    await api.restore_topic(topicSnap, sessSnap);
  });
}

// ── Topic Sessions Modal ─────────────────────────────
async function openTopicSessionsModal(topicId) {
  const t = S.topics.find(x=>x.id===topicId);
  if (!t) return;
  const all      = await api.get_topic_sessions(topicId) || [];
  const upcoming = all.filter(s=>s.status==='scheduled').sort((a,b)=>a.scheduled_date.localeCompare(b.scheduled_date));
  const past     = all.filter(s=>s.status!=='scheduled').slice(-5).reverse();

  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Sessions — ${esc(t.name)}</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="section-bar mb8">
        <span class="section-title">UPCOMING (${upcoming.length})</span>
        <button class="btn btn-primary btn-xs" onclick="showSchedForm('${topicId}')">+ Schedule</button>
      </div>
      ${upcoming.length===0
        ? `<div style="color:var(--n400);font-size:13px;padding:8px 0">No upcoming sessions.</div>`
        : upcoming.map(s=>`
          <div id="sess-row-${s.id}">
            <div class="cal-detail-row">
              <span class="badge badge-blue">${fmtDateShort(s.scheduled_date)}</span>
              <span style="font-size:13px;flex:1">${esc(s.topic_name)}</span>
              <button class="btn-icon" title="Reschedule" onclick="toggleReschedForm('${s.id}','${s.scheduled_date}','${s.scheduled_time||''}')">
                <svg width="12" height="12" viewBox="0 0 20 20" fill="none"><path d="M4 16l3-1 8-8-2-2-8 8-1 3zm10-11l1-1a1.4 1.4 0 0 1 2 2l-1 1-2-2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
              </button>
              <button class="btn-icon" title="Delete" onclick="delSessModal('${s.id}','${topicId}')">
                <svg width="12" height="12" viewBox="0 0 20 20" fill="none"><path d="M6 4h8M4 6h12M7 6v10h6V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </div>
            <div id="resch-form-${s.id}" style="display:none;padding:8px 0 4px 0">
              <div class="form-row" style="gap:8px;align-items:flex-end">
                <div class="form-group" style="margin-bottom:0;flex:1">
                  <label class="label">New date</label>
                  <input class="input" type="date" id="resch-date-${s.id}" value="${s.scheduled_date}">
                </div>
                <div class="form-group" style="margin-bottom:0;flex:1">
                  <label class="label">Time (optional)</label>
                  <input class="input" type="time" id="resch-time-${s.id}" value="${s.scheduled_time||''}">
                </div>
                <button class="btn btn-primary btn-sm" onclick="saveReschedule('${s.id}','${topicId}')">Save</button>
                <button class="btn btn-ghost btn-sm" onclick="toggleReschedForm('${s.id}')">Cancel</button>
              </div>
            </div>
          </div>`).join('')}
      <div id="schedFormArea"></div>
      <div class="sep"></div>
      <div class="section-title mb8" style="font-size:10px;letter-spacing:1.5px;color:var(--n400)">RECENT HISTORY</div>
      ${past.length===0
        ? `<div style="color:var(--n400);font-size:13px">No sessions completed yet.</div>`
        : past.map(s=>`<div class="cal-detail-row">
            <span class="badge ${s.status==='completed'?'badge-green':s.status==='missed'?'badge-amber':'badge-gray'}">${s.status}</span>
            <span style="font-size:12px;flex:1">${fmtDateShort(s.scheduled_date)}${s.rating!=null?' · '+s.rating+'/10':''}</span>
          </div>`).join('')}
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Close</button>
    </div>`, true);
}

function showSchedForm(topicId) {
  const area = document.getElementById('schedFormArea');
  if (!area) return;
  area.innerHTML = `
    <div style="margin:12px 0;padding:12px;background:var(--n050);border-radius:var(--radius-s);border:1px solid var(--n200)">
      <div class="form-row">
        <div class="form-group" style="margin-bottom:0">
          <label class="label">Date</label>
          <input class="input" type="date" id="schedDate" value="${today()}">
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="label">Time (optional)</label>
          <input class="input" type="time" id="schedTime">
        </div>
      </div>
      <button class="btn btn-primary btn-sm mt8" onclick="saveManualSession('${topicId}')">Schedule Session</button>
    </div>`;
}

async function saveManualSession(topicId) {
  const dateStr = document.getElementById('schedDate').value;
  const timeStr = document.getElementById('schedTime').value || null;
  if (!dateStr) { toast('Choose a date', 'warn'); return; }
  await api.schedule_manual_session(topicId, dateStr, timeStr);
  toast('Extra session added — plan rebuilt around it', 'ok');
  closeModal();
  await refreshAll();
}

// ── Add session (Topics tab): EXTRA session on top of the plan ──────────
function openAddSessionModal(topicId) {
  const t = S.topics.find(x => x.id === topicId);
  if (!t) return;
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Add Session</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <p style="color:var(--n500);font-size:13px;margin-bottom:14px">
        An <b>extra</b> session of <b>${esc(t.name)}</b> on the day you choose.
        The topic's normal reviews stay in place — the planner just rebalances
        the rest of the calendar around the new session.
      </p>
      <div class="form-row">
        <div class="form-group"><label class="label">Date</label>
          <input class="input" type="date" id="addSessDate" value="${today()}" min="${today()}"></div>
        <div class="form-group"><label class="label">Time (optional)</label>
          <input class="input" type="time" id="addSessTime"></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveExtraSession('${topicId}')">＋ Add Session</button>
    </div>`);
}

async function saveExtraSession(topicId) {
  const d = document.getElementById('addSessDate').value;
  const t = document.getElementById('addSessTime').value || null;
  if (!d) { toast('Choose a date', 'warn'); return; }
  closeModal();
  await api.schedule_manual_session(topicId, d, t);
  toast(`Extra session added for ${fmtDate(d)}`, 'ok');
  await refreshAll();
}

async function delSessModal(sessionId, topicId) {
  const sessSnap = (S.sessions.find(s => s.id === sessionId) || null);
  const snap = sessSnap ? {...sessSnap} : null;
  await api.delete_session(sessionId);
  await openTopicSessionsModal(topicId);
  if (snap) {
    setUndo('Session deleted', async () => {
      await api.restore_session(snap);
    });
  }
}

function toggleReschedForm(sessionId, date, time) {
  const form = document.getElementById(`resch-form-${sessionId}`);
  if (!form) return;
  const opening = form.style.display === 'none';
  form.style.display = opening ? 'block' : 'none';
  if (opening && date) {
    const di = document.getElementById(`resch-date-${sessionId}`);
    const ti = document.getElementById(`resch-time-${sessionId}`);
    if (di) di.value = date;
    if (ti) ti.value = time || '';
  }
}

async function saveReschedule(sessionId, topicId) {
  const dateStr = document.getElementById(`resch-date-${sessionId}`)?.value;
  const timeStr = document.getElementById(`resch-time-${sessionId}`)?.value || null;
  if (!dateStr) { toast('Choose a date', 'warn'); return; }
  await api.reschedule_session(sessionId, dateStr, timeStr);
  toast('Session rescheduled!', 'ok');
  await openTopicSessionsModal(topicId);
  await refreshAll();
}

// ══════════════════════════════════════════════════════
// EXAM MODALS
// ══════════════════════════════════════════════════════
function _examSubjects() {
  return [...new Set(S.topics.map(t=>t.subject||'General').filter(Boolean))];
}

function _examTopicRows(subject) {
  if (!subject) return `<div style="padding:8px;color:var(--n400);font-size:12px">Choose a subject first</div>`;
  const list = S.topics.filter(t => (t.subject||'General') === subject);
  if (list.length === 0) return `<div style="padding:8px;color:var(--n400);font-size:12px">No topics in this subject</div>`;
  return list.map(t=>`<label class="topic-check-row"><input type="checkbox" value="${t.id}" class="eTopic"> ${esc(t.name)}</label>`).join('');
}

function onExamSubjectChange() {
  const subj = document.getElementById('eSubject').value;
  document.getElementById('eTopicList').innerHTML = _examTopicRows(subj);
}

function openAddExamModal() {
  const subs  = _examSubjects();
  const first = subs[0] || '';
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Add Exam</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="label">Exam name *</label>
        <input class="input" id="eName" placeholder="e.g. Calculus Final">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="label">Date *</label>
          <input class="input" type="date" id="eDate">
        </div>
        <div class="form-group">
          <label class="label">Subject</label>
          ${subs.length===0
            ? `<input class="input" id="eSubject" placeholder="No subjects yet" disabled>`
            : `<select class="input" id="eSubject" onchange="onExamSubjectChange()">
                 ${subs.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('')}
               </select>`}
        </div>
      </div>
      <div class="form-group">
        <label class="label">Importance</label>
        <select class="input" id="eImp">
          <option value="1">1 — Low</option>
          <option value="2" selected>2 — Medium</option>
          <option value="3">3 — High (accelerates review scheduling)</option>
        </select>
      </div>
      <div class="form-group">
        <label class="label">Link topics (optional — accelerates their review)</label>
        <div class="topic-check-list" id="eTopicList">
          ${_examTopicRows(first)}
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveExam()">Add Exam</button>
    </div>`);
}

async function saveExam() {
  const name = document.getElementById('eName').value.trim();
  const date_ = document.getElementById('eDate').value;
  if (!name || !date_) { toast('Name and date required', 'warn'); return; }
  const subEl    = document.getElementById('eSubject');
  const subject  = (subEl && subEl.value ? subEl.value : '').trim();
  const topicIds = [...document.querySelectorAll('.eTopic:checked')].map(el=>el.value);
  closeModal();
  await api.add_exam({ name, exam_date:date_, subject, importance:parseInt(document.getElementById('eImp').value), topic_ids:topicIds });
  toast(`Exam "${name}" added`, 'ok');
  await refreshAll();
}

function openEditExamModal(examId) {
  const e = S.exams.find(x=>x.id===examId);
  if (!e) return;
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Edit Exam</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group"><label class="label">Name</label><input class="input" id="eeName" value="${esc(e.name)}"></div>
      <div class="form-row">
        <div class="form-group"><label class="label">Date</label><input class="input" type="date" id="eeDate" value="${e.exam_date}"></div>
        <div class="form-group"><label class="label">Subject</label><input class="input" id="eeSubject" value="${esc(e.subject||'')}"></div>
      </div>
      <div class="form-group">
        <label class="label">Importance</label>
        <select class="input" id="eeImp">${[1,2,3].map(v=>`<option value="${v}"${v===e.importance?' selected':''}>${v}</option>`).join('')}</select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="updateExam('${examId}')">Save</button>
    </div>`);
}

async function updateExam(examId) {
  const name = document.getElementById('eeName').value.trim();
  const date_ = document.getElementById('eeDate').value;
  if (!name || !date_) { toast('Name and date required', 'warn'); return; }
  closeModal();
  await api.update_exam(examId, { name, exam_date:date_, subject:document.getElementById('eeSubject').value.trim(), importance:parseInt(document.getElementById('eeImp').value) });
  toast('Exam updated', 'ok');
  await refreshAll();
}

async function deleteExam(examId) {
  const e = S.exams.find(x=>x.id===examId);
  if (!confirm(`Delete exam "${e?.name}"?`)) return;
  await api.delete_exam(examId);
  toast('Exam deleted', 'warn');
  await refreshAll();
}

// ══════════════════════════════════════════════════════
// SPECIAL DATE MODALS
// ══════════════════════════════════════════════════════
function openAddSpecialDateModal(type='off') {
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">${type==='off'?'Add Day Off':'Add Reduced Day'}</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group"><label class="label">Label *</label><input class="input" id="sdName" placeholder="${type==='off'?'e.g. Easter Weekend':'e.g. Exam Eve'}"></div>
      <div class="form-row">
        <div class="form-group"><label class="label">Start date</label><input class="input" type="date" id="sdStart" value="${today()}"></div>
        <div class="form-group"><label class="label">End date</label><input class="input" type="date" id="sdEnd" value="${today()}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="label">Start time (optional)</label><input class="input" type="time" id="sdST"></div>
        <div class="form-group"><label class="label">End time (optional)</label><input class="input" type="time" id="sdET"></div>
      </div>
      ${type==='reduced'?`<div class="form-group"><label class="label">Max priority to schedule</label>
        <select class="input" id="sdMaxP">
          <option value="1">1 — Critical only</option>
          <option value="2" selected>2 — High and above</option>
          <option value="3">3 — Medium and above</option>
        </select></div>`:''}
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveSpecialDate('${type}')">Save</button>
    </div>`);
}

async function saveSpecialDate(type) {
  const name = document.getElementById('sdName').value.trim();
  const sd   = document.getElementById('sdStart').value;
  if (!name || !sd) { toast('Label and start date required', 'warn'); return; }
  const ed   = document.getElementById('sdEnd').value || sd;
  const maxp = parseInt(document.getElementById('sdMaxP')?.value||'2');
  closeModal();
  const res = await api.add_special_date({ name, start_date:sd, end_date:ed, date_type:type,
    max_priority:maxp,
    start_time:document.getElementById('sdST')?.value||null,
    end_time:document.getElementById('sdET')?.value||null });
  toast(`Date saved${res?.workouts_moved?` · ${res.workouts_moved} workout(s) rescheduled`:''}`, 'ok');
  await refreshAll();
  const conflicts = await api.get_manual_conflicts(sd, ed, type, maxp) || [];
  if (conflicts.length) openManualConflictModal(conflicts);
}

function openManualConflictModal(conflicts) {
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">📌 Your Sessions on Blocked Days</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <p style="color:var(--n500);font-size:13px;margin-bottom:12px">
        These sessions you placed yourself (pinned or added) fall on the days you just blocked.
        They are yours — they stay where they are unless you say otherwise.
        <b>Untick</b> the ones the planner may move to another day.
      </p>
      ${conflicts.map(c=>`
        <label class="topic-check-row" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" class="mcKeep" value="${c.id}" checked>
          <b>${esc(c.topic_name)}</b>
          <span style="color:var(--n400);font-size:12px">· ${fmtDate(c.date)}${c.time?' · '+c.time:''}</span>
        </label>`).join('')}
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Keep All Pinned</button>
      <button class="btn btn-primary" onclick="applyManualConflicts()">Apply</button>
    </div>`);
}

async function applyManualConflicts() {
  const release = [...document.querySelectorAll('.mcKeep:not(:checked)')].map(el=>el.value);
  closeModal();
  if (!release.length) return;                     // everything kept — nothing to do
  await api.release_sessions(release);
  toast(`${release.length} session(s) handed back to the scheduler`, 'ok');
  await refreshAll();
}

function openEditSpecialDateModal(sdId) {
  const sd = S.specialDates.find(x=>x.id===sdId);
  if (!sd) return;
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Edit Date</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group"><label class="label">Label</label><input class="input" id="esdName" value="${esc(sd.name)}"></div>
      <div class="form-row">
        <div class="form-group"><label class="label">Start</label><input class="input" type="date" id="esdStart" value="${sd.start_date}"></div>
        <div class="form-group"><label class="label">End</label><input class="input" type="date" id="esdEnd" value="${sd.end_date||sd.start_date}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="label">Start time</label><input class="input" type="time" id="esdST" value="${sd.start_time||''}"></div>
        <div class="form-group"><label class="label">End time</label><input class="input" type="time" id="esdET" value="${sd.end_time||''}"></div>
      </div>
      ${sd.date_type==='reduced'?`<div class="form-group"><label class="label">Max priority</label>
        <select class="input" id="esdMaxP">${[1,2,3].map(v=>`<option value="${v}"${v==sd.max_priority?' selected':''}>${v}</option>`).join('')}</select></div>`:''}
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="updateSpecialDate('${sdId}')">Save</button>
    </div>`);
}

async function updateSpecialDate(sdId) {
  const orig = S.specialDates.find(x=>x.id===sdId) || {};
  const sd   = document.getElementById('esdStart').value;
  const ed   = document.getElementById('esdEnd').value || sd;
  const maxp = parseInt(document.getElementById('esdMaxP')?.value||'2');
  closeModal();
  const res = await api.update_special_date(sdId, {
    name:document.getElementById('esdName').value.trim(),
    start_date:sd,
    end_date:ed,
    start_time:document.getElementById('esdST')?.value||null,
    end_time:document.getElementById('esdET')?.value||null,
    max_priority:maxp,
  });
  toast(`Updated${res?.workouts_moved?` · ${res.workouts_moved} workout(s) rescheduled`:''}`, 'ok');
  await refreshAll();
  const conflicts = await api.get_manual_conflicts(sd, ed, orig.date_type||'off', maxp) || [];
  if (conflicts.length) openManualConflictModal(conflicts);
}

async function deleteSpecialDate(sdId) {
  if (!confirm('Delete this date?')) return;
  await api.delete_special_date(sdId);
  toast('Deleted', 'warn');
  S.specialDates = await api.get_special_dates() || [];
  renderPage();
}

// ══════════════════════════════════════════════════════
// TOPIC RESTRICTION MODALS
// ══════════════════════════════════════════════════════
function restrictionCard(r) {
  const ds = r.start_date === r.end_date
    ? fmtDate(r.start_date)
    : `${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}`;
  const target = r.scope === 'subject'
    ? `Subject: ${esc(r.subject||'')}`
    : `Topic: ${esc(r.topic_name||'')}`;
  return `<div class="sd-card">
    <div class="sd-icon off" style="background:var(--n100);color:var(--n600)">🚫</div>
    <div class="sd-info">
      <div class="sd-name">${esc(r.name||target)}</div>
      <div class="sd-range">${ds}</div>
      <div class="sd-type-label">${target} — no sessions scheduled</div>
    </div>
    <div class="sd-actions">
      <button class="btn-icon" title="Remove" onclick="deleteRestriction('${r.id}')">
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M6 4h8M4 6h12M7 6v10h6V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
  </div>`;
}

function openAddRestrictionModal() {
  const subjects = [...new Set(S.topics.map(t=>t.subject).filter(Boolean))];
  const topicOpts = S.topics.map(t=>`<option value="${esc(t.id)}">${esc(t.subject)} — ${esc(t.name)}</option>`).join('');
  const subjOpts  = subjects.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Add Topic Restriction</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="label">Label (optional)</label>
        <input class="input" id="rName" placeholder="e.g. Exam Week — No Algebra">
      </div>
      <div class="form-group">
        <label class="label">Restrict a</label>
        <div style="display:flex;gap:8px">
          <button type="button" class="btn btn-primary btn-sm" id="rScopeSubj" onclick="setRestrScope('subject')">Subject</button>
          <button type="button" class="btn btn-ghost btn-sm" id="rScopeTopic" onclick="setRestrScope('topic')">Topic</button>
        </div>
        <input type="hidden" id="rScope" value="subject">
      </div>
      <div class="form-group" id="rSubjectRow">
        <label class="label">Subject</label>
        <select class="input" id="rSubject">${subjOpts||'<option value="">No subjects yet</option>'}</select>
      </div>
      <div class="form-group" id="rTopicRow" style="display:none">
        <label class="label">Topic</label>
        <select class="input" id="rTopic">${topicOpts||'<option value="">No topics yet</option>'}</select>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="label">Start date</label><input class="input" type="date" id="rStart" value="${today()}"></div>
        <div class="form-group"><label class="label">End date</label><input class="input" type="date" id="rEnd" value="${today()}"></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveRestriction()">Save</button>
    </div>`);
}

function setRestrScope(scope) {
  document.getElementById('rScope').value = scope;
  const isSubj = scope === 'subject';
  document.getElementById('rSubjectRow').style.display = isSubj ? '' : 'none';
  document.getElementById('rTopicRow').style.display   = isSubj ? 'none' : '';
  document.getElementById('rScopeSubj').className = `btn btn-sm ${isSubj?'btn-primary':'btn-ghost'}`;
  document.getElementById('rScopeTopic').className = `btn btn-sm ${isSubj?'btn-ghost':'btn-primary'}`;
}

async function saveRestriction() {
  const scope = document.getElementById('rScope').value;
  const sd    = document.getElementById('rStart').value;
  if (!sd) { toast('Start date required', 'warn'); return; }
  let subject = null, topic_id = null, topic_name = null, dispName = '';
  if (scope === 'subject') {
    subject = document.getElementById('rSubject').value;
    if (!subject) { toast('Select a subject', 'warn'); return; }
    dispName = subject;
  } else {
    topic_id = document.getElementById('rTopic').value;
    if (!topic_id) { toast('Select a topic', 'warn'); return; }
    const topicObj = S.topics.find(t=>t.id===topic_id);
    topic_name = topicObj ? topicObj.name : topic_id;
    dispName   = topic_name;
  }
  const name = document.getElementById('rName').value.trim() || `No ${dispName}`;
  closeModal();
  await api.add_study_restriction({ name, scope, subject, topic_id, topic_name,
    start_date: sd, end_date: document.getElementById('rEnd').value || sd });
  toast('Restriction saved', 'ok');
  await refreshAll();
}

async function deleteRestriction(rid) {
  if (!confirm('Remove this restriction?')) return;
  await api.delete_study_restriction(rid);
  toast('Removed', 'warn');
  S.studyRestrictions = await api.get_study_restrictions() || [];
  renderPage();
}

// ══════════════════════════════════════════════════════
// FLASHCARD MODALS
// ══════════════════════════════════════════════════════
function openAddCardModal() {
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Add Flashcard</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group"><label class="label">Question *</label><textarea class="input" id="cQ" rows="2" placeholder="What is...?"></textarea></div>
      <div class="form-group"><label class="label">Answer *</label><textarea class="input" id="cA" rows="2" placeholder="The answer is..."></textarea></div>
      <div class="form-row">
        <div class="form-group"><label class="label">Subject</label><input class="input" id="cSubj" placeholder="Optional" list="cSubjList"><datalist id="cSubjList">${subjectOptions()}</datalist></div>
        <div class="form-group"><label class="label">Topic</label><select class="input" id="cTopic"><option value="">— none —</option>${S.topics.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveCard()">Add Card</button>
    </div>`);
}

async function saveCard() {
  const q = document.getElementById('cQ').value.trim();
  const a = document.getElementById('cA').value.trim();
  if (!q || !a) { toast('Question and answer required', 'warn'); return; }
  closeModal();
  await api.add_flashcard({ question:q, answer:a, subject:document.getElementById('cSubj').value.trim(), topic_id:document.getElementById('cTopic').value });
  toast('Card added!', 'ok');
  S.flashcards = await api.get_flashcards() || [];
  renderPage();
}

function openEditCardModal(cardId) {
  const c = S.flashcards.find(x=>x.id===cardId);
  if (!c) return;
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Edit Flashcard</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group"><label class="label">Question</label><textarea class="input" id="ecQ" rows="2">${esc(c.question)}</textarea></div>
      <div class="form-group"><label class="label">Answer</label><textarea class="input" id="ecA" rows="2">${esc(c.answer)}</textarea></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="updateCard('${cardId}')">Save</button>
    </div>`);
}

async function updateCard(cardId) {
  const q = document.getElementById('ecQ').value.trim();
  const a = document.getElementById('ecA').value.trim();
  if (!q || !a) { toast('Both fields required', 'warn'); return; }
  closeModal();
  await api.update_flashcard(cardId, { question:q, answer:a });
  toast('Card updated', 'ok');
  S.flashcards = await api.get_flashcards() || [];
  renderPage();
}

async function deleteCard(cardId) {
  if (!confirm('Delete this flashcard?')) return;
  await api.delete_flashcard(cardId);
  toast('Card deleted', 'warn');
  S.flashcards = await api.get_flashcards() || [];
  renderPage();
}

// ══════════════════════════════════════════════════════
// FITNESS MODALS
// ══════════════════════════════════════════════════════
function openAddSportModal() {
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Add Sport</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-row">
        <div class="form-group"><label class="label">Name *</label><input class="input" id="spName" placeholder="e.g. Gym"></div>
        <div class="form-group"><label class="label">Icon (emoji)</label><input class="input" id="spIcon" value="💪" style="font-size:18px" maxlength="2"></div>
      </div>
      <div class="form-group">
        <label class="label" style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="spSched" style="width:16px;height:16px;accent-color:var(--b500)">
          Smart scheduling — auto-schedules the next workout from its difficulty
        </label>
      </div>
      <div class="form-group">
        <label class="label" style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="spCal" checked style="width:16px;height:16px;accent-color:var(--b500)">
          Show workouts in calendar
        </label>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-purple" onclick="saveSport()">Add Sport</button>
    </div>`);
}

async function saveSport() {
  const name = document.getElementById('spName').value.trim();
  if (!name) { toast('Name required', 'warn'); return; }
  closeModal();
  await api.add_fitness_sport({ name, icon:document.getElementById('spIcon').value.trim()||'💪', use_scheduling:document.getElementById('spSched').checked, show_in_calendar:document.getElementById('spCal').checked });
  toast(`${name} added!`, 'ok');
  S.fitnessSports = await api.get_fitness_sports() || [];
  renderPage();
}

function openEditSportModal(sportId) {
  const sp = S.fitnessSports.find(x=>x.id===sportId);
  if (!sp) return;
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Edit ${esc(sp.name)}</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-row">
        <div class="form-group"><label class="label">Name</label><input class="input" id="espName" value="${esc(sp.name)}"></div>
        <div class="form-group"><label class="label">Icon</label><input class="input" id="espIcon" value="${esc(sp.icon||'💪')}" style="font-size:18px" maxlength="2"></div>
      </div>
      <div class="form-group">
        <label class="label" style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="espSched" ${sp.use_scheduling?'checked':''} style="width:16px;height:16px;accent-color:var(--b500)">
          Smart scheduling — auto-schedules the next workout
        </label>
      </div>
      <div class="form-group">
        <label class="label" style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="espCal" ${sp.show_in_calendar?'checked':''} style="width:16px;height:16px;accent-color:var(--b500)">
          Show in calendar
        </label>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="updateSport('${sportId}')">Save</button>
    </div>`);
}

async function updateSport(sportId) {
  closeModal();
  await api.update_fitness_sport(sportId, { name:document.getElementById('espName').value.trim(), icon:document.getElementById('espIcon').value.trim()||'💪', use_scheduling:document.getElementById('espSched').checked?1:0, show_in_calendar:document.getElementById('espCal').checked?1:0 });
  toast('Sport updated', 'ok');
  S.fitnessSports = await api.get_fitness_sports() || [];
  renderPage();
}

async function deleteSport(sportId) {
  const sp = S.fitnessSports.find(x=>x.id===sportId);
  if (!confirm(`Delete "${sp?.name}" and all its workouts?`)) return;
  await api.delete_fitness_sport(sportId);
  toast('Deleted', 'warn');
  await refreshAll();
}

function openAddWorkoutModal(sportId) {
  const sp = S.fitnessSports.find(x=>x.id===sportId);
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Add Workout${sp?' — '+esc(sp.name):''}</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group"><label class="label">Workout name *</label><input class="input" id="wName" placeholder="e.g. Upper Body, Leg Day"></div>
      <div class="form-row">
        <div class="form-group"><label class="label">Date (optional)</label><input class="input" type="date" id="wDate"><div style="font-size:11px;color:var(--n400);margin-top:4px">Leave empty for an unscheduled routine</div></div>
        <div class="form-group"><label class="label">Duration (min)</label><input class="input" type="number" id="wDur" value="60" min="5" max="300"></div>
      </div>
      <p style="font-size:12px;color:var(--n400)">You can add the exercises right after — click the workout to open it.</p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-purple" onclick="saveWorkout('${sportId}')">Add Workout</button>
    </div>`);
}

async function saveWorkout(sportId) {
  const name = document.getElementById('wName').value.trim();
  if (!name) { toast('Name required', 'warn'); return; }
  closeModal();
  const res = await api.add_fitness_workout({ sport_id:sportId, name,
    scheduled_date:document.getElementById('wDate').value||null,
    duration:parseInt(document.getElementById('wDur').value)||60 });
  toast('Workout added — click it to add exercises', 'ok');
  await refreshAll();
  if (res?.workout?.id) openWorkoutModal(sportId, res.workout.id);
}

// ══════════════════════════════════════════════════════
// SETTINGS MODAL
// ══════════════════════════════════════════════════════
document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);

function openSettingsModal() {
  const s = S.settings;
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">Settings</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="settings-section">
        <div class="settings-section-title">Profile</div>
        <div class="setting-row">
          <div><div class="setting-name">Your name</div><div class="setting-desc">Used in the greeting on the Today page</div></div>
          <input class="input" id="setName" value="${esc(s.user_name||'')}" style="width:180px" placeholder="e.g. Alex">
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Schedule</div>
        <div class="setting-row">
          <div><div class="setting-name">Max sessions per day</div><div class="setting-desc">Hard cap for the auto-scheduler</div></div>
          <input class="input" type="number" id="setMax" value="${s.max_sessions_per_day||6}" min="1" max="20" style="width:80px">
        </div>
        <div class="setting-row">
          <div><div class="setting-name">Default session duration (min)</div><div class="setting-desc">Preset duration for new topics</div></div>
          <input class="input" type="number" id="setDur" value="${s.default_session_duration||25}" min="5" max="180" style="width:80px">
        </div>
        <div class="setting-row">
          <div><div class="setting-name">Daily study goal (min)</div><div class="setting-desc">Target total minutes per day — used to balance the schedule</div></div>
          <input class="input" type="number" id="setGoal" value="${s.daily_goal_minutes||120}" min="15" max="600" style="width:80px">
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Memory</div>
        <div class="setting-row">
          <div><div class="setting-name">Personal calibration</div><div class="setting-desc">Learned automatically from your reviews — above ×1.00 means you remember better than the model predicts, so intervals stretch; below, they tighten</div></div>
          <span style="font-size:14px;font-weight:700;color:var(--n900)">×${(parseFloat(s.memory_calibration)||1).toFixed(2)}</span>
        </div>
        <div class="setting-row">
          <div><div class="setting-name">Memory strictness</div><div class="setting-desc">How strong memories must stay before a review is due. Stricter = more frequent reviews, higher retention</div></div>
          <select class="input" id="setRetention" style="width:150px">
            <option value="0.85" ${(+s.desired_retention||0.9)===0.85?'selected':''}>Light — 85%</option>
            <option value="0.9"  ${!s.desired_retention||(+s.desired_retention)===0.9?'selected':''}>Balanced — 90%</option>
            <option value="0.93" ${(+s.desired_retention)===0.93?'selected':''}>Thorough — 93%</option>
          </select>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Startup</div>
        <div class="setting-row">
          <div><div class="setting-name">Launch at login</div><div class="setting-desc">Start Pharaon automatically with Windows</div></div>
          <input type="checkbox" id="setAutoStart" ${s.auto_start_actual?'checked':''} style="width:18px;height:18px;accent-color:var(--b500);cursor:pointer">
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Data</div>
        <div class="setting-row-full">
          <div><div class="setting-name">Backup &amp; Restore</div><div class="setting-desc">Export all your topics, sessions, exams and flashcards to a JSON file, or restore from a previous backup. A backup is also saved automatically every day (the last 7 are kept in the app's data folder)</div></div>
          <div class="setting-row-btns" style="margin-top:8px">
            <button class="btn btn-ghost btn-sm" onclick="exportData()">Export Backup</button>
            <label class="btn btn-ghost btn-sm" style="cursor:pointer">
              Import Backup
              <input type="file" accept=".json" style="display:none" onchange="importData(this)">
            </label>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Help &amp; Support</div>
        <div class="setting-row">
          <div><div class="setting-name">Open Tutorial</div><div class="setting-desc">Replay the getting-started guide</div></div>
          <button class="btn btn-ghost btn-sm" onclick="closeModal();openTutorialModal(true)">Open</button>
        </div>
        <div class="setting-row">
          <div><div class="setting-name">About Pharaon</div><div class="setting-desc">What it is, why it exists, and how the engine works</div></div>
          <button class="btn btn-ghost btn-sm" onclick="closeModal();openAboutModal()">About</button>
        </div>
        <div class="setting-row-full">
          <div><div class="setting-name">Something not right?</div><div class="setting-desc">Errors are logged automatically — attach a description and we'll take it from there</div></div>
          <div class="setting-row-btns" style="margin-top:8px">
            <button class="btn btn-ghost btn-sm" onclick="reportBug()">🐞 Report a Bug</button>
            <button class="btn btn-ghost btn-sm" onclick="contactSupport()">✉️ Contact Support</button>
          </div>
        </div>
      </div>
    </div>
    <div class="modal-footer" style="justify-content:space-between;align-items:center">
      <span style="font-size:11px;color:var(--n400)">Pharaon v${S.appVersion||'—'}</span>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>
      </div>
    </div>`);
}

async function saveSettings() {
  closeModal();
  const res = await api.update_settings({
    user_name:                  document.getElementById('setName').value.trim(),
    max_sessions_per_day:       parseInt(document.getElementById('setMax').value)||6,
    default_session_duration:   parseInt(document.getElementById('setDur').value)||25,
    daily_goal_minutes:         parseInt(document.getElementById('setGoal').value)||120,
    desired_retention:          parseFloat(document.getElementById('setRetention').value)||0.9,
    auto_start:                 document.getElementById('setAutoStart').checked,
  });
  S.settings = res?.settings || S.settings;
  toast('Settings saved', 'ok');
  renderPage();
}

async function exportData() {
  const data = await api.export_data();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const ts   = new Date().toISOString().slice(0, 10);
  a.href     = url;
  a.download = `pharaon-backup-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('Backup exported!', 'ok');
}

async function importData(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const result = await api.import_data(e.target.result);
      if (result?.success) {
        closeModal();
        await refreshAll();
        toast(`Imported ${result.topics} topics and ${result.sessions} sessions`, 'ok');
      } else {
        toast('Import failed: ' + (result?.error || 'Invalid file'), 'err');
      }
    } catch {
      toast('Import failed — check the file format', 'err');
    }
  };
  reader.readAsText(file);
  input.value = '';
}

// ══════════════════════════════════════════════════════
// ABOUT
// ══════════════════════════════════════════════════════
function openAboutModal() {
  openModal(`
    <div class="modal-hdr">
      <div class="modal-title">About Pharaon</div>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body about-body">

      <p class="about-lead">Pharaon is a personal memory engine for students: a study
      calendar that plans itself, so that what you learn is never forgotten.</p>

      <div class="about-sec">Why Pharaon exists</div>
      <p>Pharaon was developed <b>by students, for students</b>, to solve a problem every
      student knows: a term involves many subjects, each with dozens of topics, and each
      topic needs to be revisited several times — at the right moments — or it quietly fades.
      Organising those sessions by hand is practically impossible: plain calendars do not know
      how memory works, and flashcard apps do not plan your days. The result is always the
      same — crammed weeks before exams, empty weeks after them, and material studied in
      October that has vanished by June.</p>
      <p>Pharaon closes that gap. You tell it <i>what</i> you are studying; it decides
      <i>when</i>, keeping every topic alive for the long term with the minimum number of
      sessions and calm, evenly balanced days.</p>

      <div class="about-sec">Objectives</div>
      <p>
      <b>1. Forget nothing.</b> Every topic is reviewed just before it would slip away, so
      knowledge consolidates for months and years, not days.<br>
      <b>2. Waste nothing.</b> Reviewing too early is wasted time; too late is wasted learning.
      The engine aims for the scientific sweet spot between the two.<br>
      <b>3. Balanced days.</b> Study load is distributed evenly — no ten-session Mondays next
      to empty Tuesdays — respecting your daily time budget, days off and restrictions.<br>
      <b>4. Ready on exam day.</b> Material linked to an exam intensifies as the date
      approaches, with a guaranteed final pass and a readiness estimate for the morning itself.<br>
      <b>5. Zero planning effort.</b> You study and rate your recall; everything else —
      scheduling, rescheduling, catching up missed days — is automatic.
      </p>

      <div class="about-sec">How it works</div>
      <p><b>A model of your memory.</b> Each topic carries a scientific memory state: its
      <i>stability</i> (how long the memory lasts) and its <i>retrievability</i> (the
      probability you could recall it right now), following the research-backed forgetting
      curve. Every time you complete a session and rate your recall honestly — from
      <i>Blackout</i> to <i>Easy</i> — that state is updated: successful, well-timed reviews
      multiply stability, so intervals stretch from days to weeks to months while retention
      stays high. Topics climb a visible ladder: New → Learning → Developing → Established →
      Solid → Mastered.</p>
      <p><b>An optimizer builds the calendar.</b> Rather than filling days with rules, Pharaon
      plans the next two weeks as a single optimisation problem: each possible day for each
      review is scored by how much long-term memory it buys per minute of study, and the plan
      that maximises the total — while keeping days balanced, subjects varied, fatigue bounded
      and every constraint respected — wins. Sessions you pin or add by hand are treated as
      immovable; the engine plans around you, never over you.</p>
      <p><b>It learns you.</b> After every review, the engine compares what it predicted with
      what actually happened. If you consistently remember better than the model expects, all
      intervals stretch; if you struggle, they tighten. This personal calibration is visible in
      Settings and improves for as long as you use the app.</p>
      <p><b>Life happens; the plan adapts.</b> Days off, reduced days and topic restrictions
      reshape the schedule instantly. Missed sessions come back the next morning as catch-ups,
      most fragile first. Skipping moves one session without disturbing the rest. Workouts from
      the Fitness Hub live on the same calendar.</p>

      <div class="about-sec">Your data</div>
      <p>Everything is stored <b>locally on your computer</b> — nothing is uploaded anywhere.
      A backup of all your data is saved automatically every day (the last seven are kept),
      and you can export or import a full backup at any time from Settings.</p>

      <div class="about-sec">Support</div>
      <p>Questions, ideas or problems — we read everything:
      <b>${SUPPORT_EMAIL}</b></p>
      <div class="setting-row-btns" style="margin-top:4px">
        <button class="btn btn-ghost btn-sm" onclick="reportBug()">🐞 Report a Bug</button>
        <button class="btn btn-ghost btn-sm" onclick="contactSupport()">✉️ Contact Support</button>
      </div>

      <p class="about-footer">Pharaon v${S.appVersion||'—'} · Built with care by students, for students.</p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-primary" onclick="closeModal()">Close</button>
    </div>`, true);
}

// ══════════════════════════════════════════════════════
// TUTORIAL
// ══════════════════════════════════════════════════════
let _tutStep = 0;

function _tutSteps() {
  const BG = '#f7f7f5', INK = '#191919', LINE = '#e9e9e7', MUT = '#9b9a97',
        BLU = '#337EA9', GRN = '#448361', AMB = '#cb7b37', PUR = '#9065b0', RED = '#d44c47';
  const card = (x,y,w,h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="white" stroke="${LINE}" stroke-width="1.5"/>`;
  return [
    {
      title: 'Welcome to Pharaon',
      svg: `<svg viewBox="0 0 240 160" width="240" height="160" xmlns="http://www.w3.org/2000/svg">
        <rect width="240" height="160" rx="14" fill="${BG}"/>
        <path d="M40 118 C 70 118, 90 60, 120 46 C 150 32, 180 30, 204 29"
              stroke="${INK}" stroke-width="2.5" fill="none" stroke-linecap="round"/>
        <path d="M40 118 C 66 118, 82 92, 100 78" stroke="${MUT}" stroke-width="1.5"
              fill="none" stroke-dasharray="3,4" stroke-linecap="round"/>
        ${[[64,101],[104,60],[152,37],[204,29]].map(([x,y],i)=>
          `<circle cx="${x}" cy="${y}" r="5" fill="white" stroke="${INK}" stroke-width="2"/>
           <circle cx="${x}" cy="${y}" r="1.8" fill="${[BLU,GRN,AMB,PUR][i]}"/>`).join('')}
        <text x="120" y="146" text-anchor="middle" fill="${MUT}" font-size="9" font-family="sans-serif" letter-spacing="2">MEMORY THAT LASTS YEARS</text>
      </svg>`,
      desc: 'Pharaon is a <strong>memory engine</strong> for students. Built on an open, research-backed model of human memory, it tracks how strong each memory is and schedules every review at exactly the right moment. Each well-timed review multiplies how long you remember: days become weeks, then months, then years.'
    },
    {
      title: 'Add Subjects & Topics',
      svg: `<svg viewBox="0 0 240 160" width="240" height="160" xmlns="http://www.w3.org/2000/svg">
        <rect width="240" height="160" rx="14" fill="${BG}"/>
        ${card(28,24,184,34)}<circle cx="46" cy="41" r="5" fill="${BLU}"/>
        <rect x="60" y="33" width="86" height="6" rx="3" fill="${INK}" opacity=".8"/>
        <rect x="60" y="45" width="52" height="4" rx="2" fill="${MUT}" opacity=".6"/>
        <rect x="168" y="33" width="34" height="14" rx="7" fill="${BG}" stroke="${LINE}"/>
        ${card(28,66,184,34)}<circle cx="46" cy="83" r="5" fill="${GRN}"/>
        <rect x="60" y="75" width="70" height="6" rx="3" fill="${INK}" opacity=".8"/>
        <rect x="60" y="87" width="44" height="4" rx="2" fill="${MUT}" opacity=".6"/>
        ${card(28,108,184,34)}<circle cx="46" cy="125" r="5" fill="${AMB}"/>
        <rect x="60" y="117" width="78" height="6" rx="3" fill="${INK}" opacity=".8"/>
        <rect x="60" y="129" width="48" height="4" rx="2" fill="${MUT}" opacity=".6"/>
        <circle cx="196" cy="125" r="9" fill="${INK}"/>
        <path d="M192 125h8M196 121v8" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
      </svg>`,
      desc: 'In <strong>Subjects &amp; Topics</strong>, add everything you study. Give each topic a <strong>priority</strong> (Critical topics are held to a stricter memory standard) and a <strong>session duration</strong>. Click a subject\'s color dot to pick its color — it follows the subject everywhere. The schedule builds itself.'
    },
    {
      title: 'Your Day, Ready Every Morning',
      svg: `<svg viewBox="0 0 240 160" width="240" height="160" xmlns="http://www.w3.org/2000/svg">
        <rect width="240" height="160" rx="14" fill="${BG}"/>
        ${card(24,22,192,32)}<rect x="30" y="28" width="3" height="20" rx="1.5" fill="${BLU}"/>
        <rect x="44" y="31" width="78" height="5.5" rx="2.75" fill="${INK}" opacity=".8"/>
        <rect x="44" y="42" width="46" height="4" rx="2" fill="${MUT}" opacity=".6"/>
        <circle cx="196" cy="38" r="9" fill="${GRN}"/><path d="M192 38l3 3 5-6" stroke="white" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        ${card(24,60,192,32)}<rect x="30" y="66" width="3" height="20" rx="1.5" fill="${GRN}"/>
        <rect x="44" y="69" width="66" height="5.5" rx="2.75" fill="${INK}" opacity=".8"/>
        <rect x="44" y="80" width="40" height="4" rx="2" fill="${MUT}" opacity=".6"/>
        <rect x="152" y="68" width="26" height="13" rx="6.5" fill="${BG}" stroke="${LINE}"/>
        <rect x="184" y="68" width="22" height="13" rx="6.5" fill="${BG}" stroke="${LINE}"/>
        ${card(24,98,192,32)}<rect x="30" y="104" width="3" height="20" rx="1.5" fill="${MUT}"/>
        <rect x="44" y="107" width="70" height="5.5" rx="2.75" fill="${MUT}" opacity=".7"/>
        <rect x="44" y="118" width="80" height="4" rx="2" fill="${MUT}" opacity=".4"/>
        <text x="120" y="150" text-anchor="middle" fill="${MUT}" font-size="8.5" font-family="sans-serif">Blackout · Wrong · Hard · Good · Easy</text>
      </svg>`,
      desc: 'Open <strong>Today</strong> and work through the list — the most fragile memories come first. After each session, rate your recall honestly (<em>Blackout → Easy</em>): the rating updates that topic\'s memory model. Watch topics climb the ladder: <strong>New → Learning → Developing → Established → Solid → Mastered</strong>.'
    },
    {
      title: 'The Calendar Is the Plan',
      svg: `<svg viewBox="0 0 240 160" width="240" height="160" xmlns="http://www.w3.org/2000/svg">
        <rect width="240" height="160" rx="14" fill="${BG}"/>
        ${card(24,20,192,124)}
        ${['M','T','W','T','F','S','S'].map((d,i)=>`<text x="${44+i*26}" y="38" text-anchor="middle" fill="${MUT}" font-size="8" font-family="sans-serif">${d}</text>`).join('')}
        <line x1="30" y1="45" x2="210" y2="45" stroke="${LINE}" stroke-width="1"/>
        ${Array.from({length:21},(_,i)=>{
          const x=44+(i%7)*26, y=60+Math.floor(i/7)*30;
          const chip=[2,4,8,9,11,15,16,18].includes(i);
          const col=[BLU,GRN,AMB,PUR][i%4];
          return `<text x="${x}" y="${y}" text-anchor="middle" fill="${INK}" opacity=".65" font-size="8" font-family="sans-serif">${i+1}</text>
            ${chip?`<rect x="${x-11}" y="${y+4}" width="22" height="6" rx="2" fill="${col}" opacity=".25"/><rect x="${x-11}" y="${y+4}" width="2.5" height="6" fill="${col}"/>`:''}`;
        }).join('')}
        <rect x="148" y="86" width="24" height="7" rx="2" fill="${RED}" opacity=".2"/><rect x="148" y="86" width="2.5" height="7" fill="${RED}"/>
      </svg>`,
      desc: 'The <strong>Calendar</strong> shows every study session (in its subject\'s color), exams, and workouts. Click a day to act on its sessions: mark done, <strong>skip</strong> (pushes just that one to the next open day), or <strong>📌 reschedule manually</strong> — pinned sessions are yours; the AI plans around them but never moves them. The <strong>Refresh</strong> button runs a full integrity check of the whole plan.'
    },
    {
      title: 'Exams: Ready On the Day',
      svg: `<svg viewBox="0 0 240 160" width="240" height="160" xmlns="http://www.w3.org/2000/svg">
        <rect width="240" height="160" rx="14" fill="${BG}"/>
        <line x1="32" y1="96" x2="208" y2="96" stroke="${LINE}" stroke-width="2"/>
        ${[0,1,2,3,4].map(i=>`<circle cx="${40+i*32}" cy="96" r="3.5" fill="${i===4?RED:MUT}" opacity="${i===4?1:.5}"/>`).join('')}
        <rect x="146" y="56" width="46" height="20" rx="5" fill="${RED}" opacity=".12"/>
        <text x="169" y="70" text-anchor="middle" fill="${RED}" font-size="9" font-family="sans-serif" font-weight="bold">EXAM</text>
        <line x1="168" y1="78" x2="168" y2="92" stroke="${RED}" stroke-width="1.3" stroke-dasharray="3,2"/>
        ${card(32,112,80,28)}
        <text x="72" y="130" text-anchor="middle" fill="${GRN}" font-size="10" font-family="sans-serif" font-weight="bold">🎯 92% ready</text>
        ${card(128,112,80,28)}
        <text x="168" y="130" text-anchor="middle" fill="${AMB}" font-size="10" font-family="sans-serif" font-weight="bold">🎯 64% ready</text>
      </svg>`,
      desc: 'Add exams in <strong>Exams &amp; Tests</strong> and link their topics. Reviews automatically intensify as the date approaches, and a <strong>final pass is guaranteed before the exam</strong>. The <strong>🎯 readiness</strong> badge predicts your recall on exam morning — if it\'s low, the plan (or the topic list) needs attention.'
    },
    {
      title: 'Tell It When You Can\'t Study',
      svg: `<svg viewBox="0 0 240 160" width="240" height="160" xmlns="http://www.w3.org/2000/svg">
        <rect width="240" height="160" rx="14" fill="${BG}"/>
        ${card(28,26,184,30)}
        <text x="46" y="45" text-anchor="middle" font-size="12">🚫</text>
        <rect x="62" y="34" width="70" height="5.5" rx="2.75" fill="${INK}" opacity=".8"/>
        <rect x="62" y="44" width="46" height="4" rx="2" fill="${MUT}" opacity=".6"/>
        ${card(28,64,184,30)}
        <text x="46" y="83" text-anchor="middle" font-size="12">⚡</text>
        <rect x="62" y="72" width="60" height="5.5" rx="2.75" fill="${INK}" opacity=".8"/>
        <rect x="62" y="82" width="52" height="4" rx="2" fill="${MUT}" opacity=".6"/>
        ${card(28,102,184,30)}
        <text x="46" y="121" text-anchor="middle" font-size="12">📋</text>
        <rect x="62" y="110" width="84" height="5.5" rx="2.75" fill="${INK}" opacity=".8"/>
        <rect x="62" y="120" width="40" height="4" rx="2" fill="${MUT}" opacity=".6"/>
      </svg>`,
      desc: 'In <strong>Availability</strong>, add <strong>days off</strong> (nothing gets scheduled — workouts included), <strong>reduced days</strong> (only high-priority topics), and <strong>topic restrictions</strong> (block a subject or topic on specific dates). Everything reschedules itself around them — and if a blocked day holds sessions you pinned, Pharaon asks you first.'
    },
    {
      title: 'Fitness Hub',
      svg: `<svg viewBox="0 0 240 160" width="240" height="160" xmlns="http://www.w3.org/2000/svg">
        <rect width="240" height="160" rx="14" fill="${BG}"/>
        ${card(30,22,180,116)}
        <text x="52" y="46" text-anchor="middle" font-size="14">🏋️</text>
        <rect x="66" y="34" width="60" height="7" rx="3.5" fill="${INK}" opacity=".85"/>
        <line x1="30" y1="58" x2="210" y2="58" stroke="${LINE}"/>
        <rect x="44" y="68" width="76" height="5.5" rx="2.75" fill="${INK}" opacity=".75"/>
        <rect x="168" y="66" width="30" height="12" rx="6" fill="${PUR}" opacity=".15"/>
        <rect x="44" y="86" width="64" height="5.5" rx="2.75" fill="${INK}" opacity=".75"/>
        <line x1="30" y1="102" x2="210" y2="102" stroke="${LINE}"/>
        <rect x="56" y="112" width="52" height="4.5" rx="2.25" fill="${MUT}"/>
        <rect x="128" y="112" width="24" height="4.5" rx="2.25" fill="${MUT}" opacity=".6"/>
        <rect x="56" y="124" width="44" height="4.5" rx="2.25" fill="${MUT}"/>
        <rect x="128" y="124" width="30" height="4.5" rx="2.25" fill="${MUT}" opacity=".6"/>
      </svg>`,
      desc: 'In the <strong>Fitness Hub</strong>, create a <strong>sport</strong>, add <strong>workouts</strong> inside it (Upper Body, Leg Day…), and open a workout to fill in its <strong>exercises</strong> — sets, reps, weight, time. Scheduled workouts appear on the Today tab and the Calendar, and can auto-reschedule themselves based on how hard the last one felt.'
    },
    {
      title: "You're All Set",
      svg: `<svg viewBox="0 0 240 160" width="240" height="160" xmlns="http://www.w3.org/2000/svg">
        <rect width="240" height="160" rx="14" fill="${BG}"/>
        <circle cx="120" cy="70" r="34" fill="white" stroke="${LINE}" stroke-width="1.5"/>
        <path d="M105 70 L116 81 L137 57" stroke="${GRN}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <text x="120" y="132" text-anchor="middle" fill="${MUT}" font-size="9" font-family="sans-serif" letter-spacing="1.5">SHOW UP · RATE HONESTLY · FORGET NOTHING</text>
      </svg>`,
      desc: "Add your first topic and let the engine take over. Your data is backed up automatically every day, and you can replay this guide anytime from <strong>Settings → Help</strong>. If you're coming from another device, import your backup below.",
      last: true
    },
  ];
}

function openTutorialModal(fromSettings = false) {
  _tutStep = 0;
  const steps = _tutSteps();
  openModal(`
    <div style="position:relative">
      <button class="modal-x" style="position:absolute;top:12px;right:12px;z-index:2"
              onclick="skipTutorial()" title="Skip tutorial">✕</button>
      <div class="tut-wrap">
        <div id="tutContent"></div>
        <div class="tut-nav">
          <div class="tut-dots">
            ${steps.map((_,i) => `<span class="tut-dot${i===0?' active':''}" onclick="_tutGo(${i})"></span>`).join('')}
          </div>
          <div class="tut-btns">
            <button class="btn btn-ghost btn-sm" id="tutPrev" style="visibility:hidden" onclick="tutNav(-1)">← Back</button>
            <button class="btn btn-primary btn-sm" id="tutNext" onclick="tutNav(1)">Next →</button>
          </div>
        </div>
      </div>
    </div>`);
  _renderTutStep();
}

async function skipTutorial() {
  await api.mark_tutorial_done();
  closeModal();
}

function _renderTutStep() {
  const steps = _tutSteps();
  const s = steps[_tutStep];
  const isLast = _tutStep === steps.length - 1;
  const tc = document.getElementById('tutContent');
  if (!tc) return;
  tc.innerHTML = `
    <div class="tut-illo">${s.svg}</div>
    <div class="tut-title">${s.title}</div>
    <div class="tut-desc">${s.desc}</div>
    ${isLast ? `
      <div class="tut-last-actions">
        <label class="btn btn-ghost btn-sm" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px">
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M10 3v10M6 9l4 4 4-4M4 15h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Import Backup
          <input type="file" accept=".json" style="display:none" onchange="handleTutImport(this)">
        </label>
      </div>` : ''}
  `;
  document.querySelectorAll('.tut-dot').forEach((d,i) => d.classList.toggle('active', i === _tutStep));
  const prev = document.getElementById('tutPrev');
  const next = document.getElementById('tutNext');
  if (prev) prev.style.visibility = _tutStep === 0 ? 'hidden' : 'visible';
  if (next) next.textContent = isLast ? 'Get Started' : 'Next →';
}

function _tutGo(idx) { _tutStep = idx; _renderTutStep(); }

async function tutNav(dir) {
  const steps = _tutSteps();
  const isLast = _tutStep === steps.length - 1;
  if (isLast && dir > 0) {
    await api.mark_tutorial_done();
    closeModal();
    toast('Welcome to Pharaon! Start by adding your first topic.', 'ok');
    S.settings.first_run = false;
    return;
  }
  _tutStep = Math.max(0, Math.min(steps.length - 1, _tutStep + dir));
  _renderTutStep();
}

async function handleTutImport(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const result = await api.import_data(e.target.result);
      if (result?.success) {
        await api.mark_tutorial_done();
        closeModal();
        await refreshAll();
        toast(`Imported ${result.topics} topics and ${result.sessions} sessions`, 'ok');
      } else {
        toast('Import failed: ' + (result?.error || 'Invalid file'), 'err');
      }
    } catch {
      toast('Import failed — check the file format', 'err');
    }
  };
  reader.readAsText(file);
  input.value = '';
}

// ══════════════════════════════════════════════════════
// DAY ROLLOVER  —  auto-postpone uncompleted sessions
// ══════════════════════════════════════════════════════
// If the app is left open past midnight (or the machine wakes from sleep),
// any session the user never completed must not linger on the past day.
// We re-run the missed-session check whenever the calendar day changes so
// those sessions are marked missed and the topic is rescheduled forward.
let _currentDay = new Date().toDateString();

function notifyMissed(mr) {
  if (!mr || !mr.count) return;
  const back = mr.rescued_today
    ? ` — ${mr.rescued_today} brought back today (${(mr.names||[]).slice(0,3).join(', ')}${(mr.names||[]).length>3?'…':''})`
    : ' — replanned for the coming days';
  toast(`↻ ${mr.count} missed session${mr.count!==1?'s':''} rescheduled${back}`, 'warn');
}

async function checkDayRollover() {
  const todayStr = new Date().toDateString();
  if (todayStr === _currentDay) return;
  _currentDay = todayStr;
  let mr = null;
  try { mr = await api.check_missed_sessions(); } catch {}
  await refreshAll();
  notifyMissed(mr);
}

setInterval(checkDayRollover, 60 * 1000);          // catch midnight while open
window.addEventListener('focus', checkDayRollover); // catch wake / re-focus

// ══════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════
async function init() {
  navigate('today');
  _currentDay = new Date().toDateString();
  let mr = null;
  try { mr = await api.check_missed_sessions(); } catch {}
  await refreshAll();
  if (S.settings.first_run) {
    openTutorialModal();
  } else {
    notifyMissed(mr);
  }
}

init();
