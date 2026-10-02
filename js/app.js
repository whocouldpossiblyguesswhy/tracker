import * as E from './engine.js';
import { load, save, serialize, parseImport, toCSV } from './store.js';
import { createAlerts, createWakeLock, createNotifier } from './timer.js';

// ---------------------------------------------------------------- helpers

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ITEM_COLORS = ['var(--item-1)', 'var(--item-2)', 'var(--item-3)', 'var(--item-4)', 'var(--item-5)', 'var(--item-6)', 'var(--item-7)', 'var(--item-8)'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function itemColor(label) {
  const idx = state.settings.items.indexOf(label);
  if (idx >= 0) return ITEM_COLORS[idx % ITEM_COLORS.length];
  let h = 0;
  for (const ch of String(label)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ITEM_COLORS[h % ITEM_COLORS.length];
}

const mmss = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

const fmtDate = (key) => {
  const d = E.keyToDate(key);
  return `${DOW[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
};
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- state

let state;
let loadSource;
{
  const r = load();
  state = E.reduce(r.state, { type: 'reconcile' }, Date.now());
  loadSource = r.source;
  save(state);
}

const alerts = createAlerts();
const wake = createWakeLock();
const notifier = createNotifier();

let view = 'today';
let sheet = null; // null | { kind: 'rating' } | { kind: 'day', date }
let lastPhase = null;

function dispatch(action, now = Date.now()) {
  const next = E.reduce(state, action, now);
  if (next !== state) {
    state = next;
    if (!save(state)) toast('Could not save. Storage may be full or blocked.', 5000);
  }
  render();
}

function replaceState(next) {
  state = E.reduce(next, { type: 'reconcile' }, Date.now());
  if (!save(state)) toast('Could not save. Storage may be full or blocked.', 5000);
  render();
}

// Which level and progress the Today screen should describe.
function todayPlan() {
  const today = E.dateKey(Date.now());
  const day = state.days[today];
  const a = state.active;
  if (!a && day?.status === 'complete') {
    return { info: { ...day.level, isFinal: false }, count: day.level.total, complete: true };
  }
  const info = E.levelInfo(state.settings, state.level);
  return { info, count: a?.count ?? 0, complete: false };
}

// ---------------------------------------------------------------- calendar

function countsHTML(level, cls = '') {
  const parts = [`<span style="color:${itemColor(level.itemA)}">${level.countA}<small>×${esc(level.itemA)}</small></span>`];
  if (level.countB > 0) {
    parts.push(`<span style="color:${itemColor(level.itemB)}">${level.countB}<small>×${esc(level.itemB)}</small></span>`);
  }
  return `<span class="counts ${cls}">${parts.join('')}</span>`;
}

// One dot per completed session, coloured by its rating. `empty` is the dot
// style when the day has no completed session yet.
function ratingDots(day, empty) {
  const done = day ? day.sessions.filter((x) => x.outcome === 'completed') : [];
  if (done.length === 0) return `<span class="dots"><span class="dot ${empty}"></span></span>`;
  return `<span class="dots">${done.map((x) => `<span class="dot ${x.rating ?? 'none'}"></span>`).join('')}</span>`;
}

// "×2" in the cell corner when a day holds more than one completed session.
function repeatBadge(day) {
  const n = day ? day.sessions.filter((x) => x.outcome === 'completed').length : 0;
  return n > 1 ? `<span class="repeat">×${n}</span>` : '';
}

function renderCalendar() {
  const now = Date.now();
  const today = E.dateKey(now);
  const proj = E.projectDays(state, today, 3);
  const cells = [];
  for (let i = -3; i <= 3; i++) {
    const date = E.addDays(today, i);
    const d = E.keyToDate(date);
    const dow = DOW[d.getDay()];
    const dom = d.getDate();
    let cls = '';
    let body = '';
    let dot = '';
    let repeat = '';
    if (i < 0) {
      const day = state.days[date];
      if (!day) {
        cls = 'past empty';
        body = '<span class="counts"><span class="none">—</span></span>';
        dot = '<span class="dot none"></span>';
      } else if (day.status === 'skipped') {
        cls = 'past skipped';
        body = '<span class="counts"><span class="none">skipped</span></span>';
        dot = '<span class="dot hard"></span>';
      } else {
        cls = `past ${day.status}`;
        body = countsHTML(day.level);
        dot = ratingDots(day, 'none');
        repeat = repeatBadge(day);
      }
    } else if (i === 0) {
      const day = state.days[date];
      const plan = todayPlan();
      cls = `today ${day?.status ?? ''}`;
      body = day?.status === 'skipped' ? '<span class="counts"><span class="none">skipped</span></span>' : countsHTML(plan.info);
      dot = day?.status === 'skipped' ? '<span class="dot hard"></span>' : ratingDots(day, 'pending');
      repeat = repeatBadge(day);
    } else {
      const p = proj[i - 1];
      if (p.scheduled) {
        cls = 'future scheduled';
        body = countsHTML(p.level);
      } else {
        cls = 'future rest';
        body = '<span class="counts"><span class="none">rest</span></span>';
      }
      dot = '<span class="dot none"></span>';
    }
    cells.push(
      `<button class="day ${cls}" data-date="${date}" aria-label="${fmtDate(date)}">` +
        `<span class="dow">${i === 0 ? 'Today' : dow}</span>${repeat}<span class="dom">${dom}</span>${body}${dot}</button>`,
    );
  }
  $('cal').innerHTML = cells.join('');
}

// ---------------------------------------------------------------- status

function renderStatus() {
  const today = E.dateKey(Date.now());
  const ds = E.dueStatus(state, today);
  const plan = todayPlan();
  const total = E.maxLevelIndex(state.settings) + 1;
  const idx = plan.complete ? plan.info.index : E.levelInfo(state.settings, state.level).index;
  let badge = '';
  if (state.days[today]?.status === 'skipped') ds.kind = 'skipped';
  switch (ds.kind) {
    case 'skipped': badge = '<span class="badge skipped">Skipped today</span>'; break;
    case 'done': badge = `<span class="badge done">✓ Complete · next ${esc(fmtDate(ds.next))}</span>`; break;
    case 'repeat': badge = '<span class="badge repeat">Repeat required</span>'; break;
    case 'due': badge = '<span class="badge due">Due today</span>'; break;
    case 'overdue': badge = `<span class="badge overdue">Overdue since ${esc(fmtDate(ds.since))}</span>`; break;
    case 'rest': badge = `<span class="badge rest">Rest day · next ${esc(fmtDate(ds.next))}</span>`; break;
  }
  const frozen = state.settings.frozen ? ' <span class="badge">❄ Frozen</span>' : '';
  const dayNo = E.dayNumber(state, today);
  $('status').innerHTML = `<span class="level">Day ${dayNo}</span><span class="sep">·</span><span class="level">Level ${idx + 1} of ${total}</span>${badge}${frozen}`;
}

// ---------------------------------------------------------------- timer

function renderTimer() {
  const now = Date.now();
  const a = state.active;
  const s = state.settings;
  const plan = todayPlan();
  const ring = $('ring');
  let phase = a?.phase ?? 'none';
  let progress = 1;
  let text;
  let caption;

  if (a && (a.phase === 'working' || a.phase === 'resting')) {
    const total = (a.phase === 'working' ? s.workSeconds : s.restSeconds) * 1000;
    const remaining = Math.max(0, a.endsAt - now);
    progress = Math.min(1, remaining / total);
    text = mmss(remaining);
    caption = a.phase === 'working'
      ? `Count ${a.count + 1} of ${s.countsPerDay} · ${E.itemForCount(plan.info, a.count + 1)}`
      : 'Rest';
  } else if (a && a.phase === 'restReady') {
    text = mmss(s.restSeconds * 1000);
    caption = `Count ${a.count} done · rest`;
  } else if (a && a.phase === 'awaitingRating') {
    text = mmss(0);
    caption = `Rate count ${a.count}`;
  } else if (a) {
    text = mmss(s.workSeconds * 1000);
    caption = `Next: count ${a.count + 1} · ${E.itemForCount(plan.info, a.count + 1)}`;
  } else {
    const ds = E.dueStatus(state, E.dateKey(now));
    text = mmss(s.workSeconds * 1000);
    if (state.days[E.dateKey(now)]?.status === 'skipped') { phase = 'skipped'; caption = 'Skipped today'; }
    else if (ds.kind === 'done') { phase = 'done'; caption = 'Done for today'; }
    else if (ds.kind === 'repeat') { caption = 'Repeat this level'; }
    else if (ds.kind === 'rest') { caption = 'Rest day'; }
    else { caption = `Tap to start · ${plan.info.itemA}`; }
  }

  ring.className = `ring phase-${phase}`;
  $('ring-fill').style.strokeDashoffset = String(552.92 * (1 - progress));
  if (phase !== lastPhase) {
    // avoid a visible sweep animation when the phase changes
    $('ring-fill').style.transition = 'none';
    requestAnimationFrame(() => ($('ring-fill').style.transition = ''));
    lastPhase = phase;
  }
  $('time').textContent = text;
  $('caption').textContent = caption;
}

// ---------------------------------------------------------------- controls

function primaryAction() {
  const a = state.active;
  const s = state.settings;
  if (!a) {
    const ds = E.dueStatus(state, E.dateKey(Date.now()));
    if (ds.kind === 'done') return { label: 'Done for today', cls: 'done', disabled: true, secondary: { label: 'Extra session', action: 'startWork' } };
    if (ds.kind === 'repeat') return { label: 'Repeat level', cls: '', action: 'startWork' };
    if (ds.kind === 'rest') return { label: 'Start anyway', cls: '', action: 'startWork' };
    if (state.days[E.dateKey(Date.now())]?.status === 'skipped') return { label: 'Start anyway', cls: '', action: 'startWork' };
    return { label: 'Start count 1', cls: '', action: 'startWork' };
  }
  switch (a.phase) {
    case 'idle': return { label: `Start count ${a.count + 1}`, cls: '', action: 'startWork' };
    case 'working': return { label: 'Cancel', cls: 'danger', action: 'cancelTimer', ringTap: false };
    case 'restReady': return { label: 'Start rest', cls: 'rest', action: 'startRest', secondary: { label: 'Skip rest', action: 'skipRest' } };
    case 'resting': return { label: 'Skip rest', cls: 'rest', action: 'skipRest' };
    case 'awaitingRating': return { label: `Rate count ${a.count}`, cls: 'rate', action: 'openRating' };
  }
  return { label: 'Start', cls: '', action: 'startWork', s };
}

function runAction(name) {
  if (!name) return;
  alerts.unlock();
  if (name === 'openRating') { sheet = { kind: 'rating' }; render(); return; }
  if (name === 'startWork' && !state.active) {
    const ds = E.dueStatus(state, E.dateKey(Date.now()));
    if (ds.kind === 'done' && !confirm('Today is already complete. Start an extra session? It will not change your level.')) return;
  }
  dispatch({ type: name });
}

function renderControls() {
  const p = primaryAction();
  const btn = $('primary');
  btn.textContent = p.label;
  btn.className = `btn primary ${p.cls || ''}`;
  btn.disabled = Boolean(p.disabled);
  btn.dataset.action = p.action || '';
  const sec = $('secondary');
  if (p.secondary) {
    sec.hidden = false;
    sec.textContent = p.secondary.label;
    sec.dataset.action = p.secondary.action;
  } else {
    sec.hidden = true;
  }
  const a = state.active;
  const today = E.dateKey(Date.now());
  const day = state.days[today];
  const canUndoClosed = !a && day && day.sessions.length > 0 && day.sessions[day.sessions.length - 1].outcome === 'completed';
  $('undo-count').hidden = !((a && a.count > 0) || canUndoClosed);
  $('reset-session').hidden = !a;
  $('skip-today').hidden = Boolean(a) || Boolean(day);
}

// ---------------------------------------------------------------- plan

function renderPlan() {
  const { info, count, complete } = todayPlan();
  const chips = [`<span class="chip" style="--c:${itemColor(info.itemA)}">${info.countA} <small>counts of</small> <span class="item">${esc(info.itemA)}</span></span>`];
  if (info.countB > 0) {
    chips.push(`<span class="chip" style="--c:${itemColor(info.itemB)}">${info.countB} <small>counts of</small> <span class="item">${esc(info.itemB)}</span></span>`);
  }
  $('plan-chips').innerHTML = chips.join('');

  const a = state.active;
  const pips = [];
  for (let i = 1; i <= info.total; i++) {
    const item = E.itemForCount(info, i);
    let cls = 'pip';
    if (i <= count) cls += ' done';
    else if (a && a.phase === 'working' && i === count + 1) cls += ' current';
    pips.push(`<span class="${cls}" style="--c:${itemColor(item)}" title="Count ${i}: ${esc(item)}"></span>`);
  }
  $('pips').innerHTML = pips.join('');

  const sub = $('plan-sub');
  if (complete || count >= info.total) {
    sub.className = 'plan-sub done';
    sub.textContent = `All ${info.total} counts done`;
    return;
  }
  sub.className = 'plan-sub';
  const remA = Math.max(0, info.countA - count);
  const doneB = Math.max(0, count - info.countA);
  const remB = info.countB - doneB;
  const parts = [];
  if (remA > 0) parts.push(`<b style="color:${itemColor(info.itemA)}">${remA}</b> of ${esc(info.itemA)} remaining`);
  if (info.countB > 0 && remB > 0) parts.push(`<b style="color:${itemColor(info.itemB)}">${remB}</b> of ${esc(info.itemB)} ${doneB > 0 ? 'remaining' : 'coming'}`);
  sub.innerHTML = parts.join('<span class="sep">·</span>');
}

// ---------------------------------------------------------------- sheet

function sessionHTML(sess, i) {
  const r = sess.rating ? `<span class="rating-dot ${sess.rating}"></span>${sess.rating}` : '<span class="rating-dot"></span>unrated';
  const when = sess.startedAt ? `${fmtTime(sess.startedAt)}${sess.finishedAt ? ' – ' + fmtTime(sess.finishedAt) : ''}` : '';
  return `<div class="session"><div>Session ${i + 1} · ${plural(sess.countsDone, 'count')}</div><div>${r}</div><div class="meta">${esc(when)}</div><div class="meta">${sess.outcome}</div></div>`;
}

function renderSheet() {
  const el = $('sheet');
  const bd = $('sheet-backdrop');
  if (!sheet) {
    el.hidden = true;
    bd.hidden = true;
    return;
  }
  el.hidden = false;
  bd.hidden = false;
  if (sheet.kind === 'rating') {
    const a = state.active;
    el.innerHTML =
      '<div class="grip"></div>' +
      `<h3>How was count ${a?.count ?? ''}?</h3><div class="sub">${esc(E.levelLabel(E.levelInfo(state.settings, state.level)))}</div>` +
      '<div class="rating-buttons">' +
      '<button class="rating-btn easy" data-rate="easy">Easy</button>' +
      '<button class="rating-btn medium" data-rate="medium">Medium</button>' +
      '<button class="rating-btn hard" data-rate="hard">Hard</button></div>' +
      '<div class="rating-note">Hard means you repeat this level again today before it counts.</div>';
    return;
  }
  const date = sheet.date;
  const today = E.dateKey(Date.now());
  const day = state.days[date];
  let html = `<div class="grip"></div><button class="close" data-close aria-label="Close">✕</button><h3>${esc(fmtDate(date))}${date === today ? ' · Today' : ''}</h3>`;
  const activeHere = state.active && state.active.date === date;
  const ratingOpts = (cur) => ['easy', 'medium', 'hard'].map((r) => `<option value="${r}" ${r === cur ? 'selected' : ''}>${r}</option>`).join('');
  if (day && day.status !== 'skipped') {
    const lbl = E.levelLabel(day.level);
    const st = { complete: 'Complete', 'needs-repeat': 'Needs repeat', incomplete: 'Incomplete' }[day.status];
    html += `<div class="sub">${esc(lbl)} · ${st}${day.advanced ? ' · advanced ↑' : ''}${day.frozen ? ' · frozen' : ''}</div>`;
    if (activeHere) {
      html += `<div class="session"><div>In progress · ${plural(state.active.count, 'count')}</div><div>${state.active.rating ? `<span class="rating-dot ${state.active.rating}"></span>${state.active.rating}` : ''}</div><div class="meta">${esc(fmtTime(state.active.startedAt))}</div><div class="meta">${state.active.phase}</div></div>`;
    }
    html += `<div class="session-list">${day.sessions.map(sessionHTML).join('')}</div>`;
    if (day.sessions.length === 0 && !activeHere) html += '<div class="empty-note">No sessions recorded.</div>';
    html += '<div class="edit"><div class="edit-title">Corrections</div>';
    day.sessions.forEach((sess, i) => {
      const rate = sess.outcome === 'completed' ? `<select data-rate-session="${i}">${ratingOpts(sess.rating)}</select>` : '<span class="meta">abandoned</span>';
      html += `<div class="edit-row"><span>Session ${i + 1}</span><span class="grow"></span>${rate}<button class="icon-btn del" data-act="remove-session" data-i="${i}" ${activeHere ? 'disabled' : ''} aria-label="Remove session ${i + 1}">✕</button></div>`;
    });
    html += `<div class="edit-row"><span>Add a session</span><span class="grow"></span><select data-add-session-rating>${ratingOpts(sheet.addRating ?? 'medium')}</select><button class="btn small" data-act="add-session" ${activeHere ? 'disabled' : ''}>Add</button></div>`;
    html += `<div class="edit-row"><span>Move to date</span><input type="date" id="move-date" value="${date}" ${activeHere ? 'disabled' : ''}><button class="btn small" data-act="move-day" ${activeHere ? 'disabled' : ''}>Move</button></div>`;
    html += `<div class="edit-row"><span class="grow"></span><button class="btn small danger" data-act="delete-day" ${activeHere ? 'disabled' : ''}>Delete this day</button></div>`;
    html += `<div class="edit-note">${activeHere ? 'Finish or reset the session before moving or deleting today. ' : ''}Corrections never change your current level; adjust that in Settings if needed.</div></div>`;
  } else if (date <= today && !activeHere) {
    const s = state.settings;
    const cur = E.levelInfo(s, state.level);
    const stage = sheet.addStage ?? cur.stage;
    const offset = sheet.addOffset ?? 0;
    const info = E.levelInfo(s, { stage, offset });
    const stageOpts = s.items.map((it, i) => `<option value="${i}" ${i === stage ? 'selected' : ''}>${esc(it)}${s.items[i + 1] != null ? ' → ' + esc(s.items[i + 1]) : ' (final)'}</option>`).join('');
    const offOpts = [];
    for (let k = 0; k < (info.itemB ? s.countsPerDay : 1); k++) {
      offOpts.push(`<option value="${k}" ${k === info.offset ? 'selected' : ''}>${s.countsPerDay - k} × ${esc(info.itemA)}${info.itemB ? ` · ${k} × ${esc(info.itemB)}` : ''}</option>`);
    }
    if (day) {
      html += `<div class="sub"><span class="rating-dot hard"></span>Skipped${day.skipped === 'auto' ? ' · nothing was recorded on this scheduled day' : ' · marked by you'}</div>`;
      html += '<div class="edit"><div class="edit-row"><span class="grow"></span><button class="btn small" data-act="unskip">Remove skip mark</button></div></div>';
    } else {
      html += `<div class="sub">${date === today ? 'Not started yet.' : 'Nothing recorded on this day.'}</div>`;
      html += '<div class="edit"><div class="edit-row"><span class="grow"></span><button class="btn small danger" data-act="mark-skipped">Mark as skipped</button></div></div>';
    }
    html += '<div class="edit"><div class="edit-title">Record a completed day</div>' +
      `<div class="edit-row"><span>Date</span><input type="date" data-add="date" value="${date}" max="${today}"></div>` +
      `<div class="edit-row"><span>Pair</span><select data-add="stage">${stageOpts}</select></div>` +
      `<div class="edit-row"><span>Split</span><select data-add="offset">${offOpts.join('')}</select></div>` +
      `<div class="edit-row"><span>Rating</span><select data-add="rating">${ratingOpts(sheet.addRating ?? 'medium')}</select></div>` +
      `<div class="edit-row"><span class="grow"></span><button class="btn small" data-act="add-day">Add day</button></div>` +
      '<div class="edit-note">Use this when a day was done but not logged, or logged on another device. Your current level is not changed.</div></div>';
  } else if (date > today) {
    const n = E.diffDays(today, date);
    const p = E.projectDays(state, today, n)[n - 1];
    html += p.scheduled
      ? `<div class="sub">Projected: ${esc(E.levelLabel(p.level))}</div><div class="empty-note">Based on your current level and schedule.</div>`
      : '<div class="sub">Rest day</div><div class="empty-note">No session scheduled.</div>';
  } else if (date === today) {
    html += `<div class="sub">${esc(E.levelLabel(E.levelInfo(state.settings, state.level)))}</div><div class="empty-note">Not started yet.</div>`;
  } else {
    html += '<div class="empty-note">Nothing recorded on this day.</div>';
  }
  el.innerHTML = html;
}

// ---------------------------------------------------------------- history

function renderHistory() {
  const { days, complete, repeats } = E.historySummary(state);
  const info = E.levelInfo(state.settings, state.level);
  const total = E.maxLevelIndex(state.settings) + 1;
  $('history-tiles').innerHTML =
    `<div class="tile"><div class="v">${E.dayNumber(state, E.dateKey(Date.now()))}</div><div class="k">Day</div></div>` +
    `<div class="tile"><div class="v small">${esc(E.levelLabel(info))}</div><div class="k">Level ${info.index + 1}/${total}</div></div>` +
    `<div class="tile"><div class="v">${complete}</div><div class="k">Days done</div></div>` +
    `<div class="tile"><div class="v">${repeats}</div><div class="k">Repeats</div></div>`;
  if (days.length === 0) {
    $('day-list').innerHTML = '<div class="empty-note">No days recorded yet.</div>';
    return;
  }
  $('day-list').innerHTML = days
    .map((d) => {
      const dt = E.keyToDate(d.date);
      const r = E.dayRating(d);
      const st = { complete: 'Complete', 'needs-repeat': 'Needs repeat', incomplete: 'Incomplete', skipped: 'Skipped' }[d.status];
      const done = d.sessions.filter((x) => x.outcome === 'completed').length;
      return (
        `<button class="day-card" data-date="${d.date}">` +
        `<div><div class="d1">${DOW[dt.getDay()]}</div><div class="d2">${dt.getDate()}</div><div class="d1">${MONTHS[dt.getMonth()]}</div></div>` +
        `<div><div class="lvl">${esc(E.levelLabel(d.level))}</div><div class="meta">${plural(d.sessions.length, 'session')}${done > 1 ? ` · repeated ×${done - 1}` : ''}${d.advanced ? ' · advanced ↑' : ''}${d.frozen ? ' · frozen' : ''}</div></div>` +
        `<div class="st ${d.status}">${done > 0 ? d.sessions.filter((x) => x.outcome === 'completed').map((x) => `<span class="rating-dot ${x.rating ?? ''}"></span>`).join('') : `<span class="rating-dot ${d.status === 'skipped' ? 'hard' : ''}"></span>`}${done > 1 ? `×${done}` : (r ?? st)}</div></button>`
      );
    })
    .join('');
}

// ---------------------------------------------------------------- settings

// Live readout for the Settings view; refreshed every tick while visible.
function audioStatusText() {
  const st = alerts.status();
  const last = st.lastRing
    ? `last chime ${new Date(st.lastRing.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })} via ${st.lastRing.path}`
    : 'no chime played yet';
  return `engine ${st.context} · session ${st.session} · fallback ${st.media} · ${last}`;
}

function renderSettings() {
  const s = state.settings;
  const lvl = E.levelInfo(s, state.level);
  const restText = s.restDaysBetween === 0 ? 'Every day' : s.restDaysBetween === 1 ? 'Every other day' : `Every ${s.restDaysBetween + 1} days`;
  const items = s.items
    .map(
      (it, i) =>
        `<div class="item-row"><span class="swatch" style="background:${ITEM_COLORS[i % ITEM_COLORS.length]}"></span>` +
        `<input type="text" data-item="${i}" value="${esc(it)}" aria-label="Item ${i + 1}">` +
        `<button class="icon-btn" data-act="item-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>` +
        `<button class="icon-btn" data-act="item-down" data-i="${i}" ${i === s.items.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>` +
        `<button class="icon-btn del" data-act="item-del" data-i="${i}" ${s.items.length <= 1 ? 'disabled' : ''} aria-label="Remove">✕</button></div>`,
    )
    .join('');
  const stageOpts = s.items
    .map((it, i) => `<option value="${i}" ${i === lvl.stage ? 'selected' : ''}>${esc(it)}${s.items[i + 1] != null ? ' → ' + esc(s.items[i + 1]) : ' (final)'}</option>`)
    .join('');
  const offOpts = [];
  const lastStage = lvl.stage === s.items.length - 1;
  for (let k = 0; k < (lastStage ? 1 : s.countsPerDay); k++) {
    offOpts.push(`<option value="${k}" ${k === lvl.offset ? 'selected' : ''}>${s.countsPerDay - k} × ${esc(lvl.itemA)}${lvl.itemB ? ` · ${k} × ${esc(lvl.itemB)}` : ''}</option>`);
  }

  $('settings-form').innerHTML = `
    <h2>Timers</h2>
    <div class="group">
      <div class="field"><label>Work timer <span class="hint">seconds · counts toward the day</span></label><input type="number" min="1" max="3600" name="workSeconds" value="${s.workSeconds}"></div>
      <div class="field"><label>Rest timer <span class="hint">seconds · does not count</span></label><input type="number" min="1" max="3600" name="restSeconds" value="${s.restSeconds}"></div>
    </div>
    <h2>Counts</h2>
    <div class="group">
      <div class="field"><label>Counts per day</label><input type="number" min="1" max="99" name="countsPerDay" value="${s.countsPerDay}"></div>
      <div class="field"><label>Rate difficulty <span class="hint">Easy / medium / hard prompt. Default: after count 3.</span></label><select name="ratingAtCount">${Array.from({ length: s.countsPerDay }, (_, i) => i + 1).map((n) => `<option value="${n}" ${n === s.ratingAtCount ? "selected" : ""}>After count ${n}${n === s.countsPerDay ? " (after completion)" : ""}</option>`).join("")}</select></div>
    </div>
    <h2>Items</h2>
    <div class="group">
      <div class="items-editor">${items}</div>
      <div class="add-row"><button class="btn small" data-act="item-add">+ Add item</button></div>
    </div>
    <h2>Schedule</h2>
    <div class="group">
      <div class="field"><label>Rest days between sessions <span class="hint">${restText}</span></label><input type="number" min="0" max="30" name="restDaysBetween" value="${s.restDaysBetween}"></div>
    </div>
    <h2>Progression</h2>
    <div class="group">
      <div class="field"><label>Freeze level <span class="hint">Completing a day keeps the same level</span></label><label class="switch"><input type="checkbox" name="frozen" ${s.frozen ? 'checked' : ''}><span></span></label></div>
      <div class="field"><label>Current pair</label><select name="stage">${stageOpts}</select></div>
      <div class="field"><label>Split</label><select name="offset">${offOpts}</select></div>
      <div class="level-preview">Now: ${esc(E.levelLabel(lvl))} · level ${lvl.index + 1} of ${E.maxLevelIndex(s) + 1}</div>
    </div>
    <h2>Alerts</h2>
    <div class="group">
      <div class="field"><label>Desktop notifications <span class="hint">${notifier.supported() ? (Notification.permission === 'granted' ? 'Enabled' : Notification.permission === 'denied' ? 'Blocked in browser settings' : 'Shown when the app is in the background') : 'Not supported here'}</span></label>
        <button class="btn small" data-act="notify" ${!notifier.supported() || Notification.permission !== 'default' ? 'disabled' : ''}>Enable</button></div>
      <div class="field"><label>Chime volume <span class="hint">${s.volume ?? 35}%</span></label><input type="range" min="0" max="100" step="5" name="volume" value="${s.volume ?? 35}" aria-label="Chime volume"></div>
      <div class="field"><label>Test chime</label><button class="btn small" data-act="test-sound">Play</button></div>
      <div class="field"><label>Audio status <span class="hint" id="audio-status">${audioStatusText()}</span></label></div>
    </div>
    <h2>Data</h2>
    <div class="group">
      <div class="field"><label>Clear all history <span class="hint">Settings and level are kept</span></label><button class="btn small danger" data-act="clear">Clear</button></div>
      <div class="field"><label>Reset everything <span class="hint">Back to defaults</span></label><button class="btn small danger" data-act="reset-all">Reset</button></div>
    </div>
    <div class="about">Tracker · data stored on this device${loadSource === 'backup' ? ' · restored from backup' : ''}</div>`;
}

function readSettingsForm() {
  const form = $('settings-form');
  const num = (name) => Number(form.querySelector(`[name=${name}]`).value);
  return {
    workSeconds: num('workSeconds'),
    restSeconds: num('restSeconds'),
    countsPerDay: num('countsPerDay'),
    ratingAtCount: num('ratingAtCount'),
    restDaysBetween: num('restDaysBetween'),
    frozen: form.querySelector('[name=frozen]').checked,
    volume: num('volume'),
    items: [...form.querySelectorAll('input[data-item]')].map((el) => el.value.trim()).filter(Boolean),
  };
}

// ---------------------------------------------------------------- render

function render() {
  if (view === 'today') {
    renderCalendar();
    renderStatus();
    renderTimer();
    renderControls();
    renderPlan();
  } else if (view === 'history') {
    renderHistory();
  } else {
    renderSettings();
  }
  const a = state.active;
  if (a && a.phase === 'awaitingRating' && (!sheet || sheet.kind !== 'rating')) sheet = { kind: 'rating' };
  if ((!a || a.phase !== 'awaitingRating') && sheet?.kind === 'rating') sheet = null;
  renderSheet();
  alerts.setVolume((state.settings.volume ?? 35) / 100);
  if (!a || a.endsAt == null) alerts.cancelScheduled();
  if (a && (a.phase === 'working' || a.phase === 'resting')) wake.acquire();
  else wake.release();
}

function showView(name) {
  view = name;
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${name}`));
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.view === name));
  render();
}

// ---------------------------------------------------------------- tick

let deadlineTimer = null;
let lastDate = E.dateKey(Date.now());

function tick() {
  // Midnight while the app is open: close out yesterday and mark misses.
  const todayKey = E.dateKey(Date.now());
  if (todayKey !== lastDate) {
    lastDate = todayKey;
    dispatch({ type: 'reconcile' });
  }
  const a = state.active;
  if (a && a.endsAt != null) {
    const remaining = a.endsAt - Date.now();
    const kind = a.phase === 'working' ? 'work' : 'rest';
    if (remaining <= 0) {
      const wasWork = a.phase === 'working';
      const countBefore = a.count;
      // Claim a chime pre-scheduled on the audio clock before dispatching:
      // render() clears any scheduled chime once no timer is running.
      const covered = alerts.consumeScheduled(a.endsAt);
      dispatch({ type: 'timerDone' });
      alerts.setVolume((state.settings.volume ?? 35) / 100);
      if (!covered) alerts.ring(kind);
      notifier.notify('Tracker', wasWork ? `Count ${countBefore + 1} done` : 'Rest over');
      return;
    }
    if (remaining <= 1200) alerts.schedule(kind, a.endsAt);
    if (deadlineTimer == null) {
      // A precise one-shot so the deadline lands within a few ms, not at the
      // next 250 ms tick.
      deadlineTimer = setTimeout(() => { deadlineTimer = null; tick(); }, remaining + 5);
    }
  } else {
    alerts.cancelScheduled();
  }
  if (view === 'today' && a && (a.phase === 'working' || a.phase === 'resting')) renderTimer();
  if (view === 'settings') { const el = $('audio-status'); if (el) el.textContent = audioStatusText(); }
}

setInterval(tick, 250);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const today = E.dateKey(Date.now());
    if (today !== lastDate) lastDate = today;
    dispatch({ type: 'reconcile' });
    tick();
    render();
  }
});

// ---------------------------------------------------------------- events

$('primary').addEventListener('click', () => runAction($('primary').dataset.action));
$('secondary').addEventListener('click', () => runAction($('secondary').dataset.action));
$('ring').addEventListener('click', () => {
  const p = primaryAction();
  if (p.disabled || p.ringTap === false) return;
  runAction(p.action);
});

$('undo-count').addEventListener('click', () => {
  if (confirm('Discount the last count? It will be removed from today.')) dispatch({ type: 'undoCount' });
});
$('reset-session').addEventListener('click', () => {
  if (confirm("Reset today's session? Counts so far will be recorded as abandoned and the level will not change.")) dispatch({ type: 'resetSession' });
});

$('skip-today').addEventListener('click', () => {
  if (confirm('Mark today as skipped? It will show in red and count as a missed day. You can still start a session later.')) dispatch({ type: 'markSkipped' });
});

$('cal').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-date]');
  if (!btn) return;
  sheet = { kind: 'day', date: btn.dataset.date };
  render();
});
$('day-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-date]');
  if (!btn) return;
  sheet = { kind: 'day', date: btn.dataset.date };
  render();
});

$('sheet').addEventListener('click', (e) => {
  const rate = e.target.closest('[data-rate]');
  if (rate) {
    dispatch({ type: 'rate', rating: rate.dataset.rate });
    return;
  }
  if (e.target.closest('[data-close]')) {
    sheet = null;
    render();
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn || sheet?.kind !== 'day') return;
  const date = sheet.date;
  if (btn.dataset.act === 'move-day') {
    const to = $('move-date').value;
    if (!to || to === date) return;
    if (state.days[to]) { toast(`${fmtDate(to)} already has a record. Delete or move it first.`, 4000); return; }
    if (!confirm(`Move ${fmtDate(date)} to ${fmtDate(to)}?`)) return;
    sheet = { kind: 'day', date: to };
    dispatch({ type: 'moveDay', from: date, to });
    toast('Day moved');
  } else if (btn.dataset.act === 'delete-day') {
    if (!confirm(`Delete everything recorded on ${fmtDate(date)}? This cannot be undone.`)) return;
    sheet = null;
    dispatch({ type: 'deleteDay', date });
    toast('Day deleted');
  } else if (btn.dataset.act === 'mark-skipped') {
    if (!confirm(`Mark ${fmtDate(date)} as skipped?`)) return;
    dispatch({ type: 'markSkipped', date });
    toast('Marked as skipped');
  } else if (btn.dataset.act === 'unskip') {
    sheet = null;
    dispatch({ type: 'deleteDay', date });
    toast('Skip mark removed');
  } else if (btn.dataset.act === 'remove-session') {
    const i = Number(btn.dataset.i);
    if (!confirm(`Remove session ${i + 1} from ${fmtDate(date)}?`)) return;
    dispatch({ type: 'removeSession', date, index: i });
    toast('Session removed');
  } else if (btn.dataset.act === 'add-session') {
    const rating = $('sheet').querySelector('[data-add-session-rating]').value;
    dispatch({ type: 'addSession', date, rating });
    toast('Session added');
  } else if (btn.dataset.act === 'add-day') {
    const sel = (k) => $('sheet').querySelector(`[data-add=${k}]`).value;
    dispatch({ type: 'addDay', date, level: { stage: Number(sel('stage')), offset: Number(sel('offset')) }, rating: sel('rating') });
    toast('Day recorded');
  }
});

$('sheet').addEventListener('change', (e) => {
  const t = e.target;
  if (sheet?.kind !== 'day') return;
  if (t.dataset.rateSession != null) {
    dispatch({ type: 'setSessionRating', date: sheet.date, index: Number(t.dataset.rateSession), rating: t.value });
    return;
  }
  if (t.dataset.add === 'date') { const today = E.dateKey(Date.now()); if (t.value && t.value <= today) { sheet.date = t.value; render(); } }
  else if (t.dataset.add === 'stage') { sheet.addStage = Number(t.value); sheet.addOffset = 0; render(); }
  else if (t.dataset.add === 'offset') { sheet.addOffset = Number(t.value); render(); }
  else if (t.dataset.add === 'rating' || t.hasAttribute('data-add-session-rating')) { sheet.addRating = t.value; }
});
$('sheet-backdrop').addEventListener('click', () => {
  if (sheet?.kind === 'rating') return;
  sheet = null;
  render();
});

document.querySelectorAll('.tab').forEach((el) => el.addEventListener('click', () => showView(el.dataset.view)));

$('export-json').addEventListener('click', () => download(`tracker-${E.dateKey(Date.now())}.json`, serialize(state), 'application/json'));
$('export-csv').addEventListener('click', () => download(`tracker-${E.dateKey(Date.now())}.csv`, toCSV(state), 'text/csv'));
$('record-day').addEventListener('click', () => {
  sheet = { kind: 'day', date: E.dateKey(Date.now()) };
  render();
});
$('import-json').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const next = parseImport(await file.text());
    const n = Object.keys(next.days).length;
    if (!confirm(`Replace current data with the imported file (${plural(n, 'day')})? Your current data will be kept as a backup.`)) return;
    replaceState(next);
    toast('Imported');
  } catch (err) {
    toast('Import failed: not a valid Tracker export', 4000);
  }
});

$('settings-form').addEventListener('change', (e) => {
  const t = e.target;
  if (t.name === 'stage' || t.name === 'offset') {
    const stage = Number($('settings-form').querySelector('[name=stage]').value);
    const offset = t.name === 'stage' ? 0 : Number($('settings-form').querySelector('[name=offset]').value);
    dispatch({ type: 'setLevel', level: { stage, offset } });
    return;
  }
  dispatch({ type: 'updateSettings', settings: readSettingsForm() });
});

$('settings-form').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const i = Number(btn.dataset.i);
  const items = [...state.settings.items];
  if (act === 'item-up' && i > 0) { [items[i - 1], items[i]] = [items[i], items[i - 1]]; dispatch({ type: 'updateSettings', settings: { items } }); }
  else if (act === 'item-down' && i < items.length - 1) { [items[i + 1], items[i]] = [items[i], items[i + 1]]; dispatch({ type: 'updateSettings', settings: { items } }); }
  else if (act === 'item-del') { if (confirm(`Remove item "${items[i]}"?`)) { items.splice(i, 1); dispatch({ type: 'updateSettings', settings: { items } }); } }
  else if (act === 'item-add') { items.push(`${items.length + 1}`); dispatch({ type: 'updateSettings', settings: { items } }); }
  else if (act === 'notify') { await notifier.request(); render(); }
  else if (act === 'test-sound') {
    alerts.setVolume(Number($('settings-form').querySelector('[name=volume]').value) / 100);
    const r = alerts.ring('work');
    toast(r.path === 'none' ? `No audio path available (engine: ${r.state})` : r.path === 'pending' ? `Starting audio engine (was ${r.state})…` : `Playing via ${r.path} (engine: ${r.state})`, 3500);
    setTimeout(() => { if (view === 'settings') renderSettings(); }, 600);
  }
  else if (act === 'clear') { if (confirm('Delete all recorded days? This cannot be undone (a backup of the previous state is kept until the next change).')) dispatch({ type: 'clearHistory' }); }
  else if (act === 'reset-all') { if (confirm('Reset settings, level and history to defaults?')) replaceState(E.createState()); }
});

// ---------------------------------------------------------------- boot

render();
if (loadSource === 'backup') toast('Saved data was unreadable. Restored from backup.', 5000);
if (loadSource === 'corrupt') toast('Saved data was unreadable and no backup existed. Started fresh.', 6000);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
