// Pure domain logic. No DOM, no timers, no storage. Everything here is
// deterministic given (state, action, now) so it can be unit tested in Node.

export const SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  countsPerDay: 10,
  items: ['2', '3', '4', '5', '5.5', '6'],
  workSeconds: 180,
  restSeconds: 60,
  ratingAtCount: 3,
  restDaysBetween: 0,
  frozen: false,
  volume: 30,
  audioMode: 'mix',
});

export const RATINGS = ['easy', 'medium', 'hard'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------- dates

export function dateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key, n) {
  const d = keyToDate(key);
  d.setDate(d.getDate() + n);
  return dateKey(d.getTime());
}

export function diffDays(a, b) {
  return Math.round((keyToDate(b) - keyToDate(a)) / 86400000);
}

// ---------------------------------------------------------------- levels

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function maxLevelIndex(s) {
  return Math.max(0, (s.items.length - 1) * s.countsPerDay);
}

export function clampLevel(s, level) {
  const lastStage = Math.max(0, s.items.length - 1);
  const stage = clamp(level?.stage ?? 0, 0, lastStage);
  let offset = clamp(level?.offset ?? 0, 0, Math.max(0, s.countsPerDay - 1));
  if (stage === lastStage) offset = 0;
  return { stage, offset };
}

export function levelToIndex(s, level) {
  const l = clampLevel(s, level);
  return l.stage * s.countsPerDay + l.offset;
}

export function indexToLevel(s, index) {
  const idx = clamp(index, 0, maxLevelIndex(s));
  return clampLevel(s, {
    stage: Math.floor(idx / s.countsPerDay),
    offset: idx % s.countsPerDay,
  });
}

export function nextLevel(s, level) {
  return indexToLevel(s, levelToIndex(s, level) + 1);
}

export function levelInfo(s, level) {
  const l = clampLevel(s, level);
  const N = s.countsPerDay;
  const itemA = s.items[l.stage];
  const itemB = s.items[l.stage + 1] ?? null;
  const countB = itemB ? l.offset : 0;
  const countA = N - countB;
  const index = levelToIndex(s, l);
  return {
    stage: l.stage,
    offset: l.offset,
    itemA,
    itemB,
    countA,
    countB,
    total: N,
    index,
    isFinal: index >= maxLevelIndex(s),
  };
}

export function itemForCount(info, count) {
  return count <= info.countA ? info.itemA : info.itemB;
}

export function levelLabel(info) {
  const parts = [`${info.countA} × ${info.itemA}`];
  if (info.countB > 0) parts.push(`${info.countB} × ${info.itemB}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------- state

export function createState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { ...DEFAULT_SETTINGS, items: [...DEFAULT_SETTINGS.items] },
    level: { stage: 0, offset: 0 },
    days: {},
    active: null,
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function snapshotLevel(s, level) {
  const info = levelInfo(s, level);
  return {
    stage: info.stage,
    offset: info.offset,
    itemA: info.itemA,
    itemB: info.itemB,
    countA: info.countA,
    countB: info.countB,
    total: info.total,
    index: info.index,
  };
}

function ensureDay(state, date) {
  if (!state.days[date]) {
    state.days[date] = {
      date,
      level: snapshotLevel(state.settings, state.level),
      restDaysBetween: state.settings.restDaysBetween,
      frozen: state.settings.frozen,
      sessions: [],
      status: 'incomplete',
      advanced: false,
    };
  }
  return state.days[date];
}

function closeActive(state, outcome, now) {
  const a = state.active;
  if (!a) return;
  const day = ensureDay(state, a.date);
  day.sessions.push({
    startedAt: a.startedAt,
    finishedAt: now,
    countsDone: a.count,
    rating: a.rating,
    outcome,
  });
  if (outcome === 'completed') {
    if (a.rating === 'hard' && day.status !== 'complete') {
      day.status = 'needs-repeat';
    } else {
      day.status = 'complete';
      if (!day.advanced) {
        const info = levelInfo(state.settings, state.level);
        day.frozen = state.settings.frozen;
        day.advanced = !state.settings.frozen && !info.isFinal;
        if (day.advanced) state.level = nextLevel(state.settings, state.level);
      }
    }
  } else if (day.status !== 'complete' && day.status !== 'needs-repeat') {
    day.status = 'incomplete';
  }
  state.active = null;
}

function afterCount(state, now) {
  const a = state.active;
  if (a.count >= state.settings.countsPerDay) {
    closeActive(state, 'completed', now);
  } else {
    a.phase = 'restReady';
    a.endsAt = null;
  }
}

function skippedDay(state, date, how) {
  return {
    date,
    level: snapshotLevel(state.settings, state.level),
    restDaysBetween: state.settings.restDaysBetween,
    frozen: state.settings.frozen,
    sessions: [],
    status: 'skipped',
    skipped: how, // 'manual' | 'auto'
    advanced: false,
  };
}

// Day status is fully determined by its sessions.
function recomputeStatus(day) {
  const completed = day.sessions.filter((x) => x.outcome === 'completed');
  if (completed.some((x) => x.rating !== 'hard')) day.status = 'complete';
  else if (completed.length > 0) day.status = 'needs-repeat';
  else day.status = 'incomplete';
  day.advanced = day.advanced && day.status === 'complete';
  delete day.skipped;
}

// Latest completed day strictly before `date`.
function lastCompleteBefore(state, date) {
  let best = null;
  for (const [d, day] of Object.entries(state.days)) {
    if (day.status === 'complete' && d < date && (!best || d > best)) best = d;
  }
  return best;
}

// Was a session due on `date`, given the rest-day cadence in force after the
// previous completed day? Days before the first completion all count as due.
export function wasScheduled(state, date) {
  const last = lastCompleteBefore(state, date);
  if (!last) return true;
  const gap = (state.days[last].restDaysBetween ?? state.settings.restDaysBetween) + 1;
  return date >= addDays(last, gap);
}

// Reducer. Returns a new state; never mutates the input.
export function reduce(input, action, now = Date.now()) {
  const state = cloneState(input);
  const s = state.settings;
  const a = state.active;

  switch (action.type) {
    case 'startWork': {
      if (a && a.phase !== 'idle' && a.phase !== 'restReady') return input;
      if (!a) {
        const date = dateKey(now);
        const day = ensureDay(state, date);
        if (day.status === 'skipped') {
          // Starting a session un-skips the day.
          day.status = 'incomplete';
          delete day.skipped;
        }
        state.active = {
          date,
          startedAt: now,
          count: 0,
          phase: 'working',
          endsAt: now + s.workSeconds * 1000,
          rating: null,
          isRepeat: day.sessions.length > 0,
        };
      } else {
        a.phase = 'working';
        a.endsAt = now + s.workSeconds * 1000;
      }
      return state;
    }

    case 'timerDone': {
      if (!a) return input;
      // Refuse to credit a timer that has not actually elapsed.
      if (a.endsAt != null && now < a.endsAt) return input;
      if (a.phase === 'working') {
        a.count += 1;
        a.endsAt = null;
        if (a.count === s.ratingAtCount) {
          a.phase = 'awaitingRating';
        } else {
          afterCount(state, now);
        }
        return state;
      }
      if (a.phase === 'resting') {
        a.phase = 'idle';
        a.endsAt = null;
        return state;
      }
      return input;
    }

    case 'rate': {
      if (!a || a.phase !== 'awaitingRating') return input;
      if (!RATINGS.includes(action.rating)) return input;
      a.rating = action.rating;
      afterCount(state, now);
      return state;
    }

    case 'startRest': {
      if (!a || a.phase !== 'restReady') return input;
      a.phase = 'resting';
      a.endsAt = now + s.restSeconds * 1000;
      return state;
    }

    case 'skipRest': {
      if (!a || (a.phase !== 'restReady' && a.phase !== 'resting')) return input;
      a.phase = 'idle';
      a.endsAt = null;
      return state;
    }

    // Abort the running timer. A cancelled work timer does not count.
    case 'cancelTimer': {
      if (!a || (a.phase !== 'working' && a.phase !== 'resting')) return input;
      a.phase = 'idle';
      a.endsAt = null;
      return state;
    }

    // Discount the most recent count (something went wrong mid-run and the
    // timer was not cancelled in time). Works in any phase of an open session,
    // and can reopen a session that completed earlier today.
    case 'undoCount': {
      if (a) {
        if (a.count <= 0) return input;
        a.count -= 1;
        if (a.phase === 'awaitingRating') {
          a.phase = 'idle';
          a.endsAt = null;
        }
        return state;
      }
      const date = dateKey(now);
      const day = state.days[date];
      if (!day || day.sessions.length === 0) return input;
      const last = day.sessions[day.sessions.length - 1];
      if (last.outcome !== 'completed' || last.countsDone <= 0) return input;
      day.sessions.pop();
      const completed = day.sessions.filter((x) => x.outcome === 'completed');
      const prevStatus = day.status;
      if (completed.some((x) => x.rating !== 'hard')) day.status = 'complete';
      else if (completed.length > 0) day.status = 'needs-repeat';
      else day.status = 'incomplete';
      if (day.advanced && prevStatus === 'complete' && day.status !== 'complete') {
        day.advanced = false;
        // Only roll the level back when it is still exactly one step past the
        // day's snapshot; if settings changed since, leave the level alone.
        const cur = levelToIndex(s, state.level);
        if (cur === day.level.index + 1) state.level = indexToLevel(s, day.level.index);
      }
      state.active = {
        date,
        startedAt: last.startedAt,
        count: Math.min(last.countsDone - 1, s.countsPerDay - 1),
        phase: 'idle',
        endsAt: null,
        rating: Math.min(last.countsDone - 1, s.countsPerDay - 1) >= s.ratingAtCount ? last.rating : null,
        isRepeat: day.sessions.length > 0,
      };
      return state;
    }

    case 'resetSession': {
      if (!a) return input;
      closeActive(state, 'abandoned', now);
      return state;
    }

    // Called on app load, when the app comes back to the foreground, and at
    // midnight: abandon a session left over from a previous day, and mark
    // every past scheduled day with nothing recorded as skipped.
    case 'reconcile': {
      const today = dateKey(now);
      let changed = false;
      if (a && a.date !== today) {
        closeActive(state, 'abandoned', now);
        changed = true;
      }
      const dates = Object.keys(state.days).sort();
      if (dates.length > 0) {
        for (let d = addDays(dates[0], 1); d < today; d = addDays(d, 1)) {
          if (state.days[d] || !wasScheduled(state, d)) continue;
          state.days[d] = skippedDay(state, d, 'auto');
          changed = true;
        }
      }
      return changed ? state : input;
    }

    // Append a completed session to an existing day (e.g. a repeat that was
    // done but not logged). Status follows the sessions; level untouched.
    case 'addSession': {
      const day = state.days[action.date];
      if (!day || day.status === 'skipped') return input;
      if (state.active && state.active.date === action.date) return input;
      const rating = RATINGS.includes(action.rating) ? action.rating : 'medium';
      const noon = keyToDate(action.date).getTime() + 12 * 3600 * 1000;
      const lastEnd = day.sessions.reduce((m, x) => Math.max(m, x.finishedAt || 0), 0);
      const ts = Math.min(now, Math.max(noon, lastEnd + 60 * 1000));
      day.sessions.push({ startedAt: ts, finishedAt: ts, countsDone: day.level.total, rating, outcome: 'completed' });
      recomputeStatus(day);
      return state;
    }

    case 'removeSession': {
      const day = state.days[action.date];
      if (!day || !day.sessions[action.index]) return input;
      if (state.active && state.active.date === action.date) return input;
      day.sessions.splice(action.index, 1);
      recomputeStatus(day);
      return state;
    }

    // Mark a day (today or a past day) as deliberately skipped.
    case 'markSkipped': {
      const date = action.date ?? dateKey(now);
      if (!DATE_RE.test(date) || date > dateKey(now) || state.days[date]) return input;
      if (state.active && state.active.date === date) return input;
      state.days[date] = skippedDay(state, date, 'manual');
      return state;
    }

    case 'updateSettings': {
      const next = { ...s, ...action.settings };
      next.countsPerDay = clamp(Math.round(next.countsPerDay) || 1, 1, 99);
      next.workSeconds = clamp(Math.round(next.workSeconds) || 1, 1, 3600);
      next.restSeconds = clamp(Math.round(next.restSeconds) || 1, 1, 3600);
      next.ratingAtCount = clamp(Math.round(next.ratingAtCount) || 1, 1, next.countsPerDay);
      next.restDaysBetween = clamp(Math.round(next.restDaysBetween) || 0, 0, 30);
      next.items = (next.items || []).map((x) => String(x).trim()).filter(Boolean);
      if (next.items.length === 0) next.items = ['1'];
      next.frozen = Boolean(next.frozen);
      next.volume = next.volume === undefined ? DEFAULT_SETTINGS.volume : clamp(Math.round(Number(next.volume)) || 0, 0, 100);
      next.audioMode = ['mix', 'solo', 'always'].includes(next.audioMode) ? next.audioMode : 'mix';
      state.settings = next;
      state.level = clampLevel(next, state.level);
      if (state.active) state.active.count = Math.min(state.active.count, next.countsPerDay);
      return state;
    }

    case 'setLevel': {
      state.level = clampLevel(s, action.level);
      return state;
    }

    case 'setFrozen': {
      state.settings.frozen = Boolean(action.frozen);
      return state;
    }

    case 'clearHistory': {
      state.days = {};
      state.active = null;
      return state;
    }

    // ---- manual history corrections. None of these touch the current level;
    // the user adjusts that in Settings if a correction calls for it.

    // Record a completed day that the app missed or logged on the wrong device.
    case 'addDay': {
      const date = action.date;
      // A skipped day may be replaced by a real record.
      if (!DATE_RE.test(date || '') || (state.days[date] && state.days[date].status !== 'skipped')) return input;
      if (state.active && state.active.date === date) return input;
      const rating = RATINGS.includes(action.rating) ? action.rating : 'medium';
      // noon of that day, but never in the future (today's entry may be reopened by undo)
      const noon = Math.min(keyToDate(date).getTime() + 12 * 3600 * 1000, now);
      const day = {
        date,
        level: snapshotLevel(s, action.level ?? state.level),
        restDaysBetween: s.restDaysBetween,
        frozen: s.frozen,
        sessions: [{ startedAt: noon, finishedAt: noon, countsDone: s.countsPerDay, rating, outcome: 'completed' }],
        status: rating === 'hard' ? 'needs-repeat' : 'complete',
        advanced: false,
      };
      state.days[date] = day;
      return state;
    }

    // Move a recorded day to a different date (e.g. logged after midnight).
    case 'moveDay': {
      const { from, to } = action;
      if (!DATE_RE.test(to || '') || !state.days[from] || state.days[to] || from === to) return input;
      if (state.active && state.active.date === from) return input;
      const day = state.days[from];
      delete state.days[from];
      day.date = to;
      state.days[to] = day;
      return state;
    }

    case 'deleteDay': {
      if (!state.days[action.date]) return input;
      if (state.active && state.active.date === action.date) return input;
      delete state.days[action.date];
      return state;
    }

    // Change the rating recorded for one session; the day status follows.
    case 'setSessionRating': {
      const day = state.days[action.date];
      if (!day || !RATINGS.includes(action.rating)) return input;
      const sess = day.sessions[action.index];
      if (!sess) return input;
      sess.rating = action.rating;
      const completed = day.sessions.filter((x) => x.outcome === 'completed');
      if (completed.some((x) => x.rating !== 'hard')) day.status = 'complete';
      else if (completed.length > 0) day.status = 'needs-repeat';
      else day.status = 'incomplete';
      day.advanced = day.advanced && day.status === 'complete';
      return state;
    }

    default:
      return input;
  }
}

// ---------------------------------------------------------------- queries

export function lastCompleteDate(state) {
  let best = null;
  for (const [date, day] of Object.entries(state.days)) {
    if (day.status === 'complete' && (!best || date > best)) best = date;
  }
  return best;
}

// Where today stands relative to the schedule.
//   done     – today is complete, next session on `next`
//   repeat   – today needs a repeat session
//   due      – today is a scheduled day
//   overdue  – a scheduled day was missed; `since` is that date
//   rest     – today is a rest day, next session on `next`
export function dueStatus(state, today) {
  const gap = state.settings.restDaysBetween + 1;
  const day = state.days[today];
  if (day?.status === 'complete') return { kind: 'done', next: addDays(today, gap) };
  if (day?.status === 'needs-repeat') return { kind: 'repeat' };
  const last = lastCompleteDate(state);
  if (!last) return { kind: 'due' };
  const next = addDays(last, gap);
  if (next < today) return { kind: 'overdue', since: next };
  if (next === today) return { kind: 'due' };
  return { kind: 'rest', next };
}

// Projected level for each of the next `n` days after `today`.
export function projectDays(state, today, n) {
  const s = state.settings;
  const gap = s.restDaysBetween + 1;
  const status = dueStatus(state, today);
  let level = state.level;
  let nextDue;
  if (status.kind === 'done' || status.kind === 'rest') {
    nextDue = status.next;
  } else {
    // today is (or should be) a session day at the current level
    nextDue = addDays(today, gap);
    if (!s.frozen) level = nextLevel(s, level);
  }
  const out = [];
  for (let i = 1; i <= n; i++) {
    const date = addDays(today, i);
    if (date === nextDue) {
      out.push({ date, scheduled: true, level: levelInfo(s, level) });
      if (!s.frozen) level = nextLevel(s, level);
      nextDue = addDays(nextDue, gap);
    } else {
      out.push({ date, scheduled: false, level: null });
    }
  }
  return out;
}

// Rating that best describes a recorded day: the rating of its final completed
// session, or the worst rating seen if it never completed.
export function dayRating(day) {
  if (!day || day.sessions.length === 0) return null;
  const completed = day.sessions.filter((x) => x.outcome === 'completed');
  if (day.status === 'complete' && completed.length) {
    return completed[completed.length - 1].rating;
  }
  const order = { hard: 3, medium: 2, easy: 1 };
  let worst = null;
  for (const sess of day.sessions) {
    if (sess.rating && (!worst || order[sess.rating] > order[worst])) worst = sess.rating;
  }
  return worst;
}

export function countsDoneToday(state, today) {
  const day = state.days[today];
  if (!day) return 0;
  let best = 0;
  for (const sess of day.sessions) best = Math.max(best, sess.countsDone);
  if (state.active && state.active.date === today) best = Math.max(best, state.active.count);
  return best;
}

// Running day number, ignoring rest days: completed days so far, plus one
// for today while today is not yet complete. The first session is day 1.
export function dayNumber(state, today) {
  let complete = 0;
  for (const day of Object.values(state.days)) if (day.status === 'complete') complete += 1;
  const todayDone = state.days[today]?.status === 'complete';
  return complete + (todayDone ? 0 : 1);
}

export function historySummary(state) {
  const days = Object.values(state.days).sort((a, b) => (a.date < b.date ? 1 : -1));
  const complete = days.filter((d) => d.status === 'complete').length;
  const skipped = days.filter((d) => d.status === 'skipped').length;
  const repeats = days.reduce(
    (n, d) => n + d.sessions.filter((x) => x.rating === 'hard' && x.outcome === 'completed').length,
    0,
  );
  return { days, complete, repeats, skipped };
}
