// Persistence. One JSON blob under a single key, with a backup copy of the
// previous good value so a corrupt write never loses history.

import { SCHEMA_VERSION, DEFAULT_SETTINGS, createState, clampLevel, reduce } from './engine.js';

export const STORAGE_KEY = 'tracker.v1';
export const BACKUP_KEY = 'tracker.v1.backup';

const PHASES = new Set(['idle', 'working', 'resting', 'awaitingRating', 'restReady']);

const OUTCOMES = new Set(['completed', 'abandoned']);
const RATINGS = new Set(['easy', 'medium', 'hard', null]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const num = (x, fallback) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

// Turn arbitrary parsed JSON into a valid state, or throw if it is not
// recognisably a tracker state at all.
export function normalize(raw) {
  if (!isObj(raw)) throw new Error('not an object');
  if (raw.schemaVersion != null && raw.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`schema ${raw.schemaVersion} is newer than ${SCHEMA_VERSION}`);
  }
  if (!isObj(raw.settings) && !isObj(raw.days) && !isObj(raw.level) && !isObj(raw.active)) {
    throw new Error('not a tracker state');
  }

  let state = createState();
  const settings = isObj(raw.settings) ? raw.settings : {};
  const merged = { ...DEFAULT_SETTINGS, items: [...DEFAULT_SETTINGS.items] };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (settings[k] !== undefined) merged[k] = settings[k];
  }
  if (!Array.isArray(merged.items)) merged.items = [...DEFAULT_SETTINGS.items];
  state = reduce(state, { type: 'updateSettings', settings: merged });

  state.level = clampLevel(state.settings, isObj(raw.level) ? raw.level : { stage: 0, offset: 0 });

  const days = {};
  if (isObj(raw.days)) {
    for (const [date, d] of Object.entries(raw.days)) {
      if (!DATE_RE.test(date) || !isObj(d)) continue;
      const lvl = isObj(d.level) ? d.level : {};
      const sessions = Array.isArray(d.sessions)
        ? d.sessions
            .filter(isObj)
            .map((sess) => ({
              startedAt: num(sess.startedAt, 0),
              finishedAt: num(sess.finishedAt, 0),
              countsDone: Math.max(0, Math.round(num(sess.countsDone, 0))),
              rating: RATINGS.has(sess.rating) ? sess.rating : null,
              outcome: OUTCOMES.has(sess.outcome) ? sess.outcome : 'abandoned',
            }))
        : [];
      // Status is fully determined by the sessions, so derive it: this is
      // lossless for app-written data and repairs inconsistent data.
      const completed = sessions.filter((x) => x.outcome === 'completed');
      let status = 'incomplete';
      if (completed.some((x) => x.rating !== 'hard')) status = 'complete';
      else if (completed.length > 0) status = 'needs-repeat';
      else if (sessions.length === 0 && d.status === 'skipped') status = 'skipped';
      days[date] = {
        date,
        level: {
          stage: Math.max(0, Math.round(num(lvl.stage, 0))),
          offset: Math.max(0, Math.round(num(lvl.offset, 0))),
          itemA: lvl.itemA == null ? '?' : String(lvl.itemA),
          itemB: lvl.itemB == null ? null : String(lvl.itemB),
          countA: Math.max(0, Math.round(num(lvl.countA, 0))),
          countB: Math.max(0, Math.round(num(lvl.countB, 0))),
          total: Math.max(1, Math.round(num(lvl.total, 1))),
          index: Math.max(0, Math.round(num(lvl.index, 0))),
        },
        restDaysBetween: Math.max(0, Math.round(num(d.restDaysBetween, 0))),
        frozen: Boolean(d.frozen),
        sessions,
        status,
        advanced: Boolean(d.advanced) && status === 'complete',
        ...(status === 'skipped' ? { skipped: d.skipped === 'auto' ? 'auto' : 'manual' } : {}),
      };
    }
  }
  state.days = days;

  let active = null;
  const a = raw.active;
  if (isObj(a) && DATE_RE.test(a.date || '') && PHASES.has(a.phase)) {
    active = {
      date: a.date,
      startedAt: num(a.startedAt, 0),
      count: Math.min(state.settings.countsPerDay, Math.max(0, Math.round(num(a.count, 0)))),
      phase: a.phase,
      endsAt: a.phase === 'working' || a.phase === 'resting' ? num(a.endsAt, null) : null,
      rating: RATINGS.has(a.rating) ? a.rating : null,
      isRepeat: Boolean(a.isRepeat),
    };
    if ((a.phase === 'working' || a.phase === 'resting') && active.endsAt == null) {
      active.phase = 'idle';
    }
  }
  state.active = active;
  state.schemaVersion = SCHEMA_VERSION;
  return state;
}

export function serialize(state) {
  return JSON.stringify(state);
}

export function parseImport(text) {
  return normalize(JSON.parse(text));
}

function tryParse(storage, key) {
  let text;
  try {
    text = storage.getItem(key);
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    return normalize(JSON.parse(text));
  } catch {
    return null;
  }
}

// Returns { state, source } where source is 'primary', 'backup' or 'fresh'.
export function load(storage = globalThis.localStorage) {
  if (!storage) return { state: createState(), source: 'fresh' };
  const primary = tryParse(storage, STORAGE_KEY);
  if (primary) return { state: primary, source: 'primary' };
  const backup = tryParse(storage, BACKUP_KEY);
  if (backup) return { state: backup, source: 'backup' };
  let hadData = false;
  try {
    hadData = Boolean(storage.getItem(STORAGE_KEY));
  } catch {
    /* ignore */
  }
  return { state: createState(), source: hadData ? 'corrupt' : 'fresh' };
}

// Writes the state, keeping the previous good value as a backup, and verifies
// the write by reading it back. Returns true on success.
export function save(state, storage = globalThis.localStorage) {
  if (!storage) return false;
  const text = serialize(state);
  try {
    const prev = storage.getItem(STORAGE_KEY);
    if (prev && prev !== text) storage.setItem(BACKUP_KEY, prev);
    storage.setItem(STORAGE_KEY, text);
    return storage.getItem(STORAGE_KEY) === text;
  } catch {
    return false;
  }
}

export function toCSV(state) {
  const rows = [['date', 'level', 'session', 'started', 'finished', 'counts_done', 'rating', 'outcome', 'day_status', 'advanced', 'frozen', 'rest_days_between']];
  const dates = Object.keys(state.days).sort();
  for (const date of dates) {
    const d = state.days[date];
    const lvl = d.level.countB > 0
      ? `${d.level.countA} x ${d.level.itemA} + ${d.level.countB} x ${d.level.itemB}`
      : `${d.level.countA} x ${d.level.itemA}`;
    if (d.sessions.length === 0) {
      rows.push([date, lvl, '', '', '', '', '', '', d.status, d.advanced, d.frozen, d.restDaysBetween]);
    }
    d.sessions.forEach((s, i) => {
      rows.push([
        date, lvl, i + 1,
        s.startedAt ? new Date(s.startedAt).toISOString() : '',
        s.finishedAt ? new Date(s.finishedAt).toISOString() : '',
        s.countsDone, s.rating ?? '', s.outcome, d.status, d.advanced, d.frozen, d.restDaysBetween,
      ]);
    });
  }
  return rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
}
