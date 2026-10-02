// Side-effect helpers for the timer: sound, screen wake lock, notifications.

// Synthesized wind chime. Six aluminium tubes tuned to an A pentatonic scale
// are struck in a gust: random order, random velocity, gusty timing. Each
// strike has the inharmonic partials of a free tube (1 : 2.76 : 5.40), a fast
// attack and a long ring, through a soft low-pass and a short synthetic
// reverb. No audio files, nothing to license.
//
// Two playback paths:
//   1. Live Web Audio (preferred).
//   2. A pre-rendered copy of the same chime in an <audio> element, used when
//      the live context is not running (iOS parks it as 'interrupted' or
//      'suspended' after another app has had the audio session). Media
//      elements are what iOS expects timers and alarms to use.
export function createAlerts() {
  let ctx = null;
  let master = null;
  let input = null;
  let mode = 'mix'; // 'mix' | 'always'
  let volume = 0.55;
  let lastRing = null;
  const media = { work: null, rest: null, volume: null, rendering: false, unlocked: false };

  const TUBES = [880.0, 987.77, 1108.73, 1318.51, 1479.98, 1760.0];
  const PARTIALS = [
    [1.0, 1.0, 2.2],
    [2.76, 0.3, 1.1],
    [5.4, 0.08, 0.5],
  ];

  // Slider percent → master gain. Perceptual (squared) curve. The synth runs
  // hot and a compressor keeps the top of the range clean; 100% is roughly
  // double the previous edition's ceiling and the default of 30 sits slightly
  // above its old default loudness. (Later raised again: strikes at 0.8.)
  const gainFor = (v) => 1.0 * Math.pow(Math.min(1, Math.max(0, v)), 2);

  // iOS 17+ Audio Session API. 'transient' plays over other audio (which ducks
  // and then resumes) but obeys the ring/silent switch. 'playback' ignores the
  // switch but pauses other apps' audio.
  const SESSION_TYPES = { mix: 'transient', solo: 'transient-solo', always: 'playback' };
  function applySession() {
    try {
      if (navigator.audioSession) navigator.audioSession.type = SESSION_TYPES[mode] || 'transient';
    } catch {
      /* not supported */
    }
  }

  // ------------------------------------------------------------ synthesis
  // Everything below takes the context explicitly so the same code renders
  // live or offline.

  function impulse(c, seconds, decay) {
    const rate = c.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = c.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function buildGraph(c, gain) {
    // Master gain → compressor (keeps the louder settings clean) → output.
    const out = c.createGain();
    out.gain.value = gain;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 12;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    out.connect(comp).connect(c.destination);
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 4200;
    filter.Q.value = 0.4;
    const dry = c.createGain();
    dry.gain.value = 0.8;
    const wet = c.createGain();
    wet.gain.value = 0.35;
    const verb = c.createConvolver();
    verb.buffer = impulse(c, 1.8, 3.5);
    filter.connect(dry).connect(out);
    filter.connect(verb).connect(wet).connect(out);
    return { master: out, input: filter };
  }

  function strike(c, dest, freq, at, vel, collect) {
    const detune = 1 + (Math.random() - 0.5) * 0.003;
    for (const [ratio, gain, len] of PARTIALS) {
      const osc = c.createOscillator();
      if (collect) collect.push(osc);
      const g = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * ratio * detune;
      const peak = vel * gain * 0.8;
      const ring = len * (0.75 + vel * 0.5);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(peak, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0003, at + ring);
      osc.connect(g).connect(dest);
      osc.start(at);
      osc.stop(at + ring + 0.05);
    }
  }

  function gust(c, dest, at, strikes, energy, collect) {
    let t = at;
    let last = -1;
    for (let i = 0; i < strikes; i++) {
      let idx;
      do idx = Math.floor(Math.random() * TUBES.length);
      while (idx === last);
      last = idx;
      const vel = (0.25 + Math.random() * 0.5) * energy;
      strike(c, dest, TUBES[idx], t, vel, collect);
      t += Math.random() < 0.3 ? 0.2 + Math.random() * 0.3 : 0.06 + Math.random() * 0.16;
    }
    return t;
  }

  function chime(c, dest, kind, at, collect) {
    if (kind === 'work') {
      // a short gust, a breath, then a couple of trailing notes
      const end = gust(c, dest, at, 6, 1.0, collect);
      return gust(c, dest, end + 0.4 + Math.random() * 0.3, 3, 0.55, collect);
    }
    return gust(c, dest, at, 3, 0.7, collect);
  }

  // ------------------------------------------------------------ offline copy

  function wavBlob(buffer) {
    const ch = buffer.numberOfChannels;
    const n = buffer.length;
    const rate = buffer.sampleRate;
    const bytes = 44 + n * ch * 2;
    const ab = new ArrayBuffer(bytes);
    const v = new DataView(ab);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * ch * 2, true);
    let o = 44;
    const chans = Array.from({ length: ch }, (_, i) => buffer.getChannelData(i));
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < ch; k++) {
        const s = Math.max(-1, Math.min(1, chans[k][i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  async function renderMedia() {
    const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OAC || media.rendering || media.volume === volume) return;
    media.rendering = true;
    try {
      for (const kind of ['work', 'rest']) {
        const seconds = kind === 'work' ? 5 : 3.2;
        const off = new OAC(2, Math.ceil(44100 * seconds), 44100);
        const g = buildGraph(off, gainFor(volume));
        chime(off, g.input, kind, 0.02);
        const rendered = await off.startRendering();
        const url = URL.createObjectURL(wavBlob(rendered));
        let el = media[kind];
        if (!el) {
          el = new Audio();
          el.preload = 'auto';
          el.setAttribute('playsinline', '');
          media[kind] = el;
        } else if (el.src) {
          URL.revokeObjectURL(el.src);
        }
        el.src = url;
        el.load();
      }
      media.volume = volume;
      media.unlocked = false;
    } catch {
      /* offline rendering unavailable */
    } finally {
      media.rendering = false;
    }
  }

  // iOS lets a media element be played from a timer only after it has been
  // played once from a tap. Do that silently.
  function unlockMedia() {
    if (media.unlocked) return;
    let ok = true;
    for (const kind of ['work', 'rest']) {
      const el = media[kind];
      if (!el || !el.src) return;
      try {
        el.muted = true;
        const p = el.play();
        if (p && p.then) {
          p.then(() => { el.pause(); el.currentTime = 0; el.muted = false; })
            .catch(() => { el.muted = false; media.unlocked = false; });
        } else {
          el.pause(); el.currentTime = 0; el.muted = false;
        }
      } catch {
        el.muted = false;
        ok = false;
      }
    }
    // Optimistic; a rejected play() above clears it so the next tap retries.
    media.unlocked = ok;
  }

  // ------------------------------------------------------------ public

  // In the modes that interrupt other audio, the chime plays only through the
  // <audio> element: when the clip ends, WebKit ends its media session and iOS
  // hands playback back to the other app. A live Web Audio engine would keep
  // the session held, so it is closed in those modes.
  const interrupting = () => mode !== 'mix';

  function closeEngine() {
    if (!ctx) return;
    try { ctx.close().catch(() => {}); } catch { /* ignore */ }
    ctx = null;
    master = null;
    input = null;
  }

  function setMode(m) {
    const next = SESSION_TYPES[m] ? m : 'mix';
    if (next !== mode) {
      mode = next;
      applySession();
      if (interrupting()) closeEngine();
    }
  }

  // ------------------------------------------------------------ scheduling
  // Called when a timer is within a second of its deadline: warm the engine
  // and schedule the chime on the audio clock so it lands on the deadline.
  let scheduled = null;

  // iOS gives audio back to other apps only when our audio session goes
  // inactive, and WebKit keeps it active while the context is running. So in
  // the modes that interrupt other audio, suspend the engine once the chime
  // has rung out; the next schedule()/ring() wakes it again.
  let releaseTimer = null;
  function releaseLater(kind, delayMs) {
    clearTimeout(releaseTimer);
    if (mode === 'mix') return;
    const tail = kind === 'work' ? 5500 : 4000;
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (ctx && ctx.state === 'running' && !scheduled) ctx.suspend().catch(() => {});
    }, Math.max(0, delayMs) + tail);
  }

  function cancelScheduled() {
    if (!scheduled) return;
    clearTimeout(scheduled.timer);
    for (const n of scheduled.nodes) {
      try { n.stop(0); } catch { /* already stopped */ }
    }
    scheduled = null;
  }

  function schedule(kind, endsAt) {
    if (scheduled && scheduled.endsAt === endsAt) return;
    cancelScheduled();
    unlock();
    const s = { endsAt, kind, nodes: [], timer: null, played: false };
    scheduled = s;
    if (volume <= 0) { s.played = true; return; }
    if (interrupting()) {
      // Clip only: it plays at the deadline and ends on its own, releasing
      // the audio session so the other app resumes.
      s.timer = setTimeout(() => {
        if (scheduled === s && !s.played) {
          s.played = true;
          const ok = playMedia(kind);
          lastRing = { at: endsAt, kind, path: ok ? 'media (scheduled)' : 'none', state: 'engine closed' };
        }
      }, Math.max(0, endsAt - Date.now()));
      return;
    }
    const arm = () => {
      if (scheduled !== s || s.played || !ctx || ctx.state !== 'running') return;
      s.played = true;
      const at = ctx.currentTime + Math.max(0, endsAt - Date.now()) / 1000;
      master.gain.setValueAtTime(gainFor(volume), ctx.currentTime);
      chime(ctx, input, kind, at, s.nodes);
      lastRing = { at: endsAt, kind, path: 'web-audio (scheduled)', state: ctx.state };
      releaseLater(kind, endsAt - Date.now());
    };
    if (ctx && ctx.state === 'running') arm();
    else if (ctx) ctx.resume().then(arm).catch(() => {});
    // If the engine never came up in time, the clip plays at the deadline.
    s.timer = setTimeout(() => {
      if (scheduled === s && !s.played) {
        s.played = true;
        const ok = playMedia(kind);
        lastRing = { at: endsAt, kind, path: ok ? 'media (scheduled)' : 'none', state: ctx ? ctx.state : 'no-context' };
      }
    }, Math.max(0, endsAt - Date.now()));
  }

  // At the deadline: true if a scheduled chime already covers it.
  function consumeScheduled(endsAt) {
    if (!scheduled || scheduled.endsAt !== endsAt) return false;
    const played = scheduled.played;
    if (played) {
      clearTimeout(scheduled.timer);
      scheduled = null; // let the sound ring out
    } else {
      cancelScheduled();
    }
    return played;
  }

  function setVolume(v) {
    const next = Math.min(1, Math.max(0, Number(v) || 0));
    if (next !== volume) {
      volume = next;
      renderMedia();
    }
  }

  // Must be called from a user gesture at least once (iOS requirement). Safe
  // to call any time after that; it also recovers from the 'interrupted'
  // state iOS puts the context in after another app has had the audio session.
  function unlock() {
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      applySession();
      clearTimeout(releaseTimer);
      releaseTimer = null;
      if (interrupting()) {
        closeEngine();
        if (media.volume == null) renderMedia().then(unlockMedia);
        else unlockMedia();
        return;
      }
      if (AC && !ctx) {
        ctx = new AC();
        const g = buildGraph(ctx, gainFor(volume));
        master = g.master;
        input = g.input;
        // Play one silent sample inside the gesture: the classic iOS unlock.
        const kick = ctx.createBufferSource();
        kick.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        kick.connect(ctx.destination);
        kick.start(0);
      }
      if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
      if (media.volume == null) renderMedia().then(unlockMedia);
      else unlockMedia();
    } catch {
      /* audio unavailable */
    }
  }

  function playMedia(kind) {
    const el = media[kind];
    if (!el || !el.src) return false;
    try {
      el.muted = false;
      el.currentTime = 0;
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  function playLive(kind) {
    master.gain.setValueAtTime(gainFor(volume), ctx.currentTime);
    chime(ctx, input, kind, ctx.currentTime + 0.02);
    releaseLater(kind, 0);
  }

  function ring(kind) {
    unlock();
    const info = { at: Date.now(), kind, path: 'none', state: ctx ? ctx.state : 'no-context' };
    lastRing = info;
    try {
      if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.([150, 80, 150]);
    } catch {
      /* ignore */
    }
    if (volume <= 0) return info;
    if (interrupting()) {
      info.path = playMedia(kind) ? 'media' : 'none';
      info.state = 'engine closed';
      return info;
    }
    if (ctx && ctx.state === 'running') {
      playLive(kind);
      info.path = 'web-audio';
      return info;
    }
    // Engine not running yet (iOS creates it suspended and resumes it
    // asynchronously). Play live as soon as it resumes; if that has not
    // happened shortly, play the pre-rendered clip instead.
    let done = false;
    const finish = (path) => {
      if (done) return;
      done = true;
      info.path = path;
      info.state = ctx ? ctx.state : 'no-context';
    };
    if (ctx) {
      ctx.resume().then(() => {
        if (!done && ctx.state === 'running') {
          playLive(kind);
          finish('web-audio');
        }
      }).catch(() => {});
    }
    setTimeout(() => {
      if (!done) finish(playMedia(kind) ? 'media' : 'none');
    }, 250);
    info.path = 'pending';
    return info;
  }

  function status() {
    let session = 'unsupported';
    try {
      if (navigator.audioSession) session = navigator.audioSession.type;
    } catch {
      /* ignore */
    }
    return {
      context: ctx ? ctx.state : interrupting() ? 'closed (clip mode)' : 'not created',
      session,
      media: media.work && media.work.src ? (media.unlocked ? 'ready' : 'rendered') : 'none',
      mode,
      lastRing,
    };
  }

  // Coming back to the app with a chime pending: make sure the context is
  // running again. (Without one pending, leave it alone so other apps' audio
  // is not interrupted just by opening the app.)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running' && (scheduled || mode === 'mix')) {
      ctx.resume().catch(() => {});
    }
  });

  // Offline rendering needs no user gesture, so prepare the clip right away;
  // the first tap then only has to unlock the element.
  renderMedia();

  return { unlock, ring, setMode, setVolume, status, schedule, cancelScheduled, consumeScheduled };
}

export function createWakeLock() {
  let lock = null;
  let wanted = false;

  async function acquire() {
    wanted = true;
    if (lock || !navigator.wakeLock) return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => {
        lock = null;
      });
    } catch {
      lock = null;
    }
  }

  async function release() {
    wanted = false;
    if (lock) {
      try {
        await lock.release();
      } catch {
        /* ignore */
      }
      lock = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wanted && !lock) acquire();
  });

  return { acquire, release };
}

export function createNotifier() {
  function supported() {
    return typeof Notification !== 'undefined';
  }

  async function request() {
    if (!supported()) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
      return (await Notification.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  function notify(title, body) {
    if (!supported() || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return;
    try {
      new Notification(title, { body, tag: 'tracker-timer', renotify: true });
    } catch {
      /* some platforms only allow notifications from a service worker */
    }
  }

  return { supported, request, notify };
}
