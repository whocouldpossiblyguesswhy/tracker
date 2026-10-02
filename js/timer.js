// Side-effect helpers for the timer: sound, screen wake lock, notifications.

// Synthesized wind chime. Six aluminium tubes tuned to an A pentatonic scale
// are struck in a gust: random order, random velocity, gusty timing. Each
// strike has the inharmonic partials of a free tube (1 : 2.76 : 5.40 : 8.93),
// a very fast attack and a long ring, through a soft low-pass and a short
// synthetic reverb. No audio files, nothing to license.
export function createAlerts() {
  let ctx = null;
  let master = null;
  let dry = null;
  let wet = null;

  const TUBES = [880.0, 987.77, 1108.73, 1318.51, 1479.98, 1760.0];
  const PARTIALS = [
    [1.0, 1.0, 2.2],
    [2.76, 0.3, 1.1],
    [5.4, 0.08, 0.5],
  ];

  // Slider percent → master gain. Perceptual (squared) curve, and the top of
  // the range is deliberately modest: 100% ≈ 35% of the first edition's linear
  // scale, and the default of 55 lands near that edition's 10%.
  const gainFor = (volume) => 0.35 * Math.pow(Math.min(1, Math.max(0, volume)), 2);

  function impulse(seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function unlock() {
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      // iOS 17+: play as a short 'transient' sound so music in other apps ducks
      // during the chime and resumes afterwards instead of being stopped.
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'transient';
      } catch {
        /* not supported */
      }
      if (!ctx) {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.7;
        master.connect(ctx.destination);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 4200;
        filter.Q.value = 0.4;

        dry = ctx.createGain();
        dry.gain.value = 0.8;
        wet = ctx.createGain();
        wet.gain.value = 0.35;
        const verb = ctx.createConvolver();
        verb.buffer = impulse(1.8, 3.5);

        filter.connect(dry).connect(master);
        filter.connect(verb).connect(wet).connect(master);
        dry._in = filter;
      }
      if (ctx.state === 'suspended') ctx.resume();
    } catch {
      /* audio unavailable */
    }
  }

  function strike(freq, at, vel) {
    const detune = 1 + (Math.random() - 0.5) * 0.003;
    for (const [ratio, gain, len] of PARTIALS) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * ratio * detune;
      const peak = vel * gain * 0.25;
      const ring = len * (0.75 + vel * 0.5);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(peak, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0003, at + ring);
      osc.connect(g).connect(dry._in);
      osc.start(at);
      osc.stop(at + ring + 0.05);
    }
  }

  function gust(at, strikes, energy) {
    let t = at;
    let last = -1;
    for (let i = 0; i < strikes; i++) {
      let idx;
      do idx = Math.floor(Math.random() * TUBES.length);
      while (idx === last);
      last = idx;
      const vel = (0.25 + Math.random() * 0.5) * energy;
      strike(TUBES[idx], t, vel);
      t += Math.random() < 0.3 ? 0.2 + Math.random() * 0.3 : 0.06 + Math.random() * 0.16;
    }
    return t;
  }

  // volume: 0..1
  function ring(kind, volume = 0.7) {
    unlock();
    if (!ctx || volume <= 0) return;
    master.gain.setValueAtTime(gainFor(volume), ctx.currentTime);
    const t = ctx.currentTime + 0.02;
    if (kind === 'work') {
      // a short gust, a breath, then a couple of trailing notes
      const end = gust(t, 6, 1.0);
      gust(end + 0.4 + Math.random() * 0.3, 3, 0.55);
    } else {
      gust(t, 3, 0.7);
    }
    try {
      if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.([150, 80, 150]);
    } catch {
      /* ignore */
    }
  }

  return { unlock, ring };
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
