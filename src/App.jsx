import { useState, useRef, useEffect, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// MATH UTILS
// ─────────────────────────────────────────────────────────────────────────────

const lerp    = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
const eIn     = t => t * t;
const eInOut  = t => t < 0.5 ? 2*t*t : 1 - (-2*t+2)**2/2;

function lerpHex(c1, c2, t) {
  const p = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
  const [r1,g1,b1] = p(c1), [r2,g2,b2] = p(c2);
  return `rgb(${~~lerp(r1,r2,t)},${~~lerp(g1,g2,t)},${~~lerp(b1,b2,t)})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO ENGINE
// Additive synthesis using inharmonic Tibetan singing bowl partial series.
// Each partial is a sine oscillator with independent amplitude envelope.
// Stereo panning + programmatic impulse-response reverb.
// ─────────────────────────────────────────────────────────────────────────────

class AudioEngine {
  // Inharmonic partials: ratio (freq multiplier), amp (peak), decay (seconds)
  // These ratios approximate the resonant modes of a metal singing bowl.
  static PARTIALS = [
    { r: 1.000, a: 1.00, d: 7.5 },
    { r: 2.756, a: 0.42, d: 5.8 },
    { r: 5.404, a: 0.18, d: 3.8 },
    { r: 8.933, a: 0.09, d: 2.2 },
    { r: 13.34, a: 0.04, d: 1.3 },
  ];

  constructor() {
    this.ctx    = null;
    this.master = null;
    this.panner = null;
    this.ready  = false;
  }

  async init() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.76;

    this.panner = this.ctx.createStereoPanner();
    this.panner.pan.value = 0;

    // Programmatic reverb: exponentially-decaying noise burst as impulse response
    const conv = this.ctx.createConvolver();
    conv.buffer = this._makeIR(3.2, 3.0);

    const dry = this.ctx.createGain(); dry.gain.value = 0.58;
    const wet = this.ctx.createGain(); wet.gain.value = 0.50;

    // Signal path: master → panner → [dry path + reverb wet path] → destination
    this.master.connect(this.panner);
    this.panner.connect(dry);
    this.panner.connect(conv);
    conv.connect(wet);
    dry.connect(this.ctx.destination);
    wet.connect(this.ctx.destination);

    this.ready = true;
  }

  // Generate a stereo impulse response buffer for algorithmic reverb
  _makeIR(durationSec, decay) {
    const sr  = this.ctx.sampleRate;
    const len = Math.ceil(sr * durationSec);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        // White noise × exponential decay envelope
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  // Core synthesis: strike a bell with given parameters
  _strike({ freq, vol, decayMul, tension, pan }) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;

    // Smoothly transition stereo pan position
    this.panner.pan.setTargetAtTime(pan, now, 0.14);

    // Bus gain for this bell instance
    const bus = this.ctx.createGain();
    bus.gain.value = vol;
    bus.connect(this.master);

    AudioEngine.PARTIALS.forEach(({ r, a, d }, i) => {
      const osc = this.ctx.createOscillator();
      const g   = this.ctx.createGain();

      // Apply harmonic tension: progressively detune upper partials
      // This creates a subtle dissonance that grows uncomfortable without being harsh
      let f = freq * r;
      if (tension > 0 && i > 0) {
        const tensionCents = tension * 26 * (i / AudioEngine.PARTIALS.length);
        f *= Math.pow(2, tensionCents / 1200);
      }

      osc.type = 'sine';
      osc.frequency.value = f;

      const dt = d * decayMul;
      // Sharp attack, exponential decay — natural struck-metal envelope
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(a, now + 0.007);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dt);

      osc.connect(g);
      g.connect(bus);
      osc.start(now);
      osc.stop(now + dt + 0.15);
    });
  }

  // Acknowledgment bell: pure, warm, centered, resolving
  ack() {
    this._strike({ freq: 330, vol: 0.64, decayMul: 1.45, tension: 0, pan: 0 });
  }

  // Escalation bell: varies per escalation parameters
  bell(params) {
    const { volume, pitchVar, tension, decay, baseFreq, pan } = params;
    // Apply random pitch deviation (semitones) to prevent habituation
    const semDev = (Math.random() - 0.5) * 2 * pitchVar;
    const freq   = baseFreq * Math.pow(2, semDev / 12);
    this._strike({ freq, vol: volume, decayMul: decay, tension, pan });
  }

  dispose() {
    this.ctx?.close();
    this.ready = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ESCALATION ENGINE
// Pure functions mapping escalation level (0→1) to sound parameters.
// All dimensions are independently tunable; easing functions shape the curve.
// ─────────────────────────────────────────────────────────────────────────────

const Esc = {
  // Total duration (seconds) to traverse 0→1 escalation
  // Level increases at exactly 1/DURATION per second regardless of bell density
  DURATION: 60,

  params(lvl) {
    const l = Math.max(0, Math.min(1, lvl));
    return {
      // Inter-bell interval: 9.0s (sparse) → 0.60s (dense)
      interval:  lerp(9.0,  0.60, eIn(l)),

      // Timing jitter: 0.04 (metronomic) → 0.90 (chaotic)
      // High jitter = unpredictable timing = harder to pre-filter
      jitter:    lerp(0.04, 0.90, l * l),

      // Volume: 0.12 (whisper) → 0.90 (full presence)
      volume:    lerp(0.12, 0.90, eInOut(l)),

      // Pitch deviation in semitones: 0 → 2.3
      // Each bell is pitched differently, preventing tonal habituation
      pitchVar:  lerp(0,    2.3,  Math.pow(l, 1.5)),

      // Stereo pan range: 0 (mono center) → 0.95 (full stereo field)
      panRange:  lerp(0,    0.95, Math.pow(l, 2.0)),

      // Harmonic tension: 0 (pure inharmonic bowl) → 0.70 (dissonant pressure)
      tension:   lerp(0,    0.70, Math.pow(l, 2.5)),

      // Decay multiplier: 1.4 (long, meditative) → 0.28 (short, clipped)
      // Short decay = each bell is more staccato, less forgiving, more insistent
      decay:     lerp(1.4,  0.28, eIn(l)),

      // Fundamental frequency drift (subtle): A3 (220Hz) → slight rise
      baseFreq:  220 * Math.pow(2, lerp(0, 0.09, l * l)),
    };
  },

  // Compute next bell firing interval with jitter applied
  nextInterval(p) {
    const dev = (Math.random() - 0.5) * 2 * p.interval * p.jitter;
    return Math.max(0.22, p.interval + dev);
  },

  // Random walk in stereo field, bounded by panRange
  nextPan(current, p) {
    if (p.panRange < 0.04) return 0;
    const step = (Math.random() - 0.5) * 0.55 * p.panRange;
    return Math.max(-p.panRange, Math.min(p.panRange, current + step));
  },

  // Level increment per interval: level rises at 1/DURATION per second
  delta(intervalSec) {
    return intervalSec / Esc.DURATION;
  },

  // Perceptual color: blue (calm) → purple (emerging) → amber (insistent)
  color(l) {
    const t = Math.max(0, Math.min(1, l));
    if (t < 0.5) return lerpHex('#4a8ab0', '#8b6cc4', t * 2);
    return lerpHex('#8b6cc4', '#c47a3a', (t - 0.5) * 2);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ADAPTIVE MEMORY
// Tracks acknowledgment behavior across sessions and adjusts the silent
// interval so the escalation challenge matches the user's awareness level.
//
// Algorithm: rolling average of last 6 sessions' escalation level at ack.
// Target = 0.33 (acknowledge at ~one-third of escalation).
// Error drives a proportional correction to the silent interval.
// Adaptation is intentionally slow (18% per unit error) to feel organic.
// ─────────────────────────────────────────────────────────────────────────────

const Mem = {
  KEY:     'awareness_app_v2',
  TARGET:  0.33,   // ideal escalation level at acknowledgment
  DEFAULT: 60,     // initial silent interval in seconds

  blank: () => ({ sessions: [], silence: Mem.DEFAULT }),

  async load() {
    try {
      const r = localStorage.getItem(Mem.KEY);
      return r ? JSON.parse(r) : Mem.blank();
    } catch {
      return Mem.blank();
    }
  },

  async save(d) {
    try { localStorage.setItem(Mem.KEY, JSON.stringify(d)); } catch {}
  },

  integrate(data, { level, timeToAck, silence }) {
    const sessions = [...data.sessions, {
      ts: Date.now(), level, timeToAck, silence,
    }].slice(-30); // retain last 30 sessions

    let newSilence = data.silence;

    if (sessions.length >= 3) {
      const recent = sessions.slice(-6);
      const avg    = recent.reduce((s, x) => s + x.level, 0) / recent.length;
      const err    = avg - Mem.TARGET; // positive = acking too late → shorten silence
      const factor = 1 - err * 0.18;
      newSilence   = Math.round(
        Math.max(15, Math.min(600, data.silence * factor)) / 5
      ) * 5; // round to nearest 5s
    }

    return { sessions, silence: newSilence };
  },

  stats(sessions) {
    if (!sessions.length) return null;
    const r = sessions.slice(-10);
    return {
      total:    sessions.length,
      avgLevel: r.reduce((s, x) => s + x.level, 0) / r.length,
      avgTime:  r.reduce((s, x) => s + x.timeToAck, 0) / r.length,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// PHASE STATE MACHINE
// IDLE → ACKING → SILENT → ESCALATING → ACKING → SILENT → ...
// ─────────────────────────────────────────────────────────────────────────────

const Ph = {
  IDLE:       'idle',
  ACKING:     'acking',
  SILENT:     'silent',
  ESCALATING: 'escalating',
};

// ─────────────────────────────────────────────────────────────────────────────
// RIPPLE SYSTEM
// Each bell adds an expanding ring; removed after animation completes.
// ─────────────────────────────────────────────────────────────────────────────

function useRipples() {
  const [ripples, set] = useState([]);
  const idRef = useRef(0);

  const add = useCallback((color) => {
    const id = ++idRef.current;
    set(r => [...r.slice(-12), { id, color }]);
    setTimeout(() => set(r => r.filter(x => x.id !== id)), 2800);
  }, []);

  return [ripples, add];
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APPLICATION
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [phase,    setPhase]    = useState(Ph.IDLE);
  const [level,    setLevel]    = useState(0);
  const [silence,  setSilence]  = useState(Mem.DEFAULT);
  const [countdown, setCount]   = useState(0);
  const [sessions, setSessions] = useState([]);
  const [stats,    setStats]    = useState(null);
  const [ripples,  addRipple]   = useRipples();

  // Refs: used inside timer callbacks to avoid stale closures
  const phR    = useRef(Ph.IDLE);
  const lvlR   = useRef(0);
  const silR   = useRef(Mem.DEFAULT);
  const datR   = useRef(Mem.blank());
  const panR   = useRef(0);
  const escTS  = useRef(0);          // escalation start timestamp
  const audioR = useRef(null);
  const escTmR = useRef(null);       // escalation setTimeout handle
  const silTmR = useRef(null);       // silent setTimeout handle
  const cdIntR = useRef(null);       // countdown setInterval handle

  // Keep refs in sync with state
  useEffect(() => { phR.current  = phase;   }, [phase]);
  useEffect(() => { lvlR.current = level;   }, [level]);
  useEffect(() => { silR.current = silence; }, [silence]);

  const clearAll = useCallback(() => {
    clearTimeout(escTmR.current);
    clearTimeout(silTmR.current);
    clearInterval(cdIntR.current);
  }, []);

  // Load persistent data on mount
  useEffect(() => {
    Mem.load().then(d => {
      datR.current = d;
      setSessions(d.sessions);
      setStats(Mem.stats(d.sessions));
      setSilence(d.silence);
      silR.current = d.silence;
    });
    return () => { clearAll(); audioR.current?.dispose(); };
  }, [clearAll]);

  // Lazy-initialize audio engine (requires user gesture)
  const getAudio = useCallback(async () => {
    if (!audioR.current) audioR.current = new AudioEngine();
    await audioR.current.init();
    return audioR.current;
  }, []);

  // ── Bell loop (recursive setTimeout for precise jittered timing) ──────────
  const bellLoop = useCallback(() => {
    if (phR.current !== Ph.ESCALATING) return;

    const p   = Esc.params(lvlR.current);
    const pan = Esc.nextPan(panR.current, p);
    panR.current = pan;

    audioR.current?.bell({ ...p, pan });
    addRipple(Esc.color(lvlR.current));

    const dt     = Esc.nextInterval(p);
    const newLvl = Math.min(1, lvlR.current + Esc.delta(dt));
    lvlR.current = newLvl;
    setLevel(newLvl);

    escTmR.current = setTimeout(bellLoop, dt * 1000);
  }, [addRipple]);

  // ── Silent phase → escalation transition ─────────────────────────────────
  const startSilent = useCallback((dur) => {
    setPhase(Ph.SILENT);
    phR.current = Ph.SILENT;
    setCount(dur);

    cdIntR.current = setInterval(() => setCount(c => Math.max(0, c - 1)), 1000);

    silTmR.current = setTimeout(() => {
      clearInterval(cdIntR.current);
      // Begin escalation
      setPhase(Ph.ESCALATING);
      phR.current    = Ph.ESCALATING;
      lvlR.current   = 0;
      panR.current   = 0;
      setLevel(0);
      escTS.current  = Date.now();
      escTmR.current = setTimeout(bellLoop, 300);
    }, dur * 1000);
  }, [bellLoop]);

  // ── Primary interaction handler ───────────────────────────────────────────
  const handlePress = useCallback(async () => {
    if (phR.current === Ph.SILENT || phR.current === Ph.ACKING) return;

    const a = await getAudio();
    clearAll();

    if (phR.current === Ph.IDLE) {
      // ── Session start ──
      setPhase(Ph.ACKING);
      phR.current = Ph.ACKING;
      a.ack();
      addRipple('#4a8ab0');
      setTimeout(() => startSilent(silR.current), 1500);

    } else if (phR.current === Ph.ESCALATING) {
      // ── Awareness recovered ──
      const ackLevel  = lvlR.current;
      const timeToAck = (Date.now() - escTS.current) / 1000;

      setPhase(Ph.ACKING);
      phR.current = Ph.ACKING;
      a.ack();
      addRipple('#4a8ab0');

      // Integrate session into adaptive memory
      const newData = Mem.integrate(datR.current, {
        level: ackLevel, timeToAck, silence: silR.current,
      });
      datR.current = newData;
      setSessions(newData.sessions);
      setSilence(newData.silence);
      silR.current = newData.silence;
      setStats(Mem.stats(newData.sessions));
      Mem.save(newData);

      // Continue cycle
      setTimeout(() => startSilent(newData.silence), 1500);
    }
  }, [addRipple, clearAll, getAudio, startSilent]);

  // ── Derived visual values ─────────────────────────────────────────────────
  const isEsc   = phase === Ph.ESCALATING;
  const col     = Esc.color(level);
  const glowPx  = isEsc ? lerp(14, 70, level) : 10;
  const pulseS  = isEsc ? lerp(2.8, 0.36, eIn(level)) : 3.6;
  const CIRC    = 2 * Math.PI * 104; // circumference for progress ring (r=104)

  const phaseLabel = {
    [Ph.IDLE]:       'Touch the circle to begin',
    [Ph.ACKING]:     'Returning…',
    [Ph.SILENT]:     `Silent period · ${countdown}s remaining`,
    [Ph.ESCALATING]: 'Return to awareness · touch the circle',
  }[phase];

  const isInteractive = phase === Ph.IDLE || phase === Ph.ESCALATING;

  return (
    <>
      <style>{CSS}</style>
      <div style={S.root}>
        <div style={S.grain} />

        {/* ── Title ─────────────────────────────────────────────────────── */}
        <header style={S.header}>
          <h1 style={S.wordmark}>Awareness</h1>
          <p style={S.tagline}>mindful attention recovery</p>
        </header>

        {/* ── Orb stage ─────────────────────────────────────────────────── */}
        <div style={S.stage}>
          {/* Expanding ripples on each bell */}
          {ripples.map(r => (
            <span key={r.id} className="ripple"
              style={{ '--rc': r.color }} />
          ))}

          {/* SVG progress ring (appears during escalation) */}
          <svg style={S.ring} viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg">
            {isEsc && <>
              <circle cx="110" cy="110" r="104" fill="none"
                stroke={col} strokeWidth="1.5" strokeOpacity="0.16" />
              <circle cx="110" cy="110" r="104" fill="none"
                stroke={col} strokeWidth="2.5" strokeLinecap="round"
                strokeDasharray={CIRC}
                strokeDashoffset={CIRC * (1 - level)}
                transform="rotate(-90 110 110)"
                style={{ transition: 'stroke-dashoffset 0.5s ease, stroke 1.2s ease' }}
              />
            </>}
          </svg>

          {/* Main orb button */}
          <button
            onClick={handlePress}
            className={isEsc ? 'orb-pulse' : 'orb-breathe'}
            aria-label={phaseLabel}
            style={{
              ...S.orb,
              borderColor: col,
              boxShadow: `0 0 ${glowPx}px ${col}, 0 0 ${glowPx * 2.2}px ${col}28`,
              background: `radial-gradient(circle at 40% 38%, ${col}1e 0%, ${col}09 55%, transparent 100%)`,
              '--ps': `${pulseS}s`,
              cursor:  isInteractive ? 'pointer' : 'default',
              opacity: phase === Ph.SILENT ? 0.5 : 1,
            }}
          >
            <OrbGlyph phase={phase} col={col} />
          </button>
        </div>

        {/* ── Phase label ───────────────────────────────────────────────── */}
        <p style={{ ...S.phaseLabel, color: isEsc ? col : '#3e4668' }}>
          {phaseLabel}
        </p>

        {/* ── Adaptive stats panel ──────────────────────────────────────── */}
        {stats && <StatsPanel stats={stats} silence={silence} col={col} isEsc={isEsc} />}

        {/* ── Session history dots ──────────────────────────────────────── */}
        {sessions.length > 0 && (
          <HistoryDots sessions={sessions.slice(-20)} />
        )}

        {/* ── First-use prose (replaces stats before any sessions) ─────── */}
        {!stats && phase === Ph.IDLE && (
          <p style={S.prose}>
            A bell sounds. Then silence.<br />
            When the bells return, they grow.<br />
            The moment you notice — touch the circle.<br />
            <span style={{ color: '#2a3050' }}>
              The system learns your rhythm.
            </span>
          </p>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function OrbGlyph({ phase, col }) {
  const glyphs = {
    [Ph.IDLE]:       '◌',
    [Ph.ACKING]:     '◉',
    [Ph.SILENT]:     '○',
    [Ph.ESCALATING]: '◎',
  };
  return (
    <span style={{
      fontSize: 40, color: col, lineHeight: 1, fontFamily: 'serif',
      textShadow: `0 0 28px ${col}`,
      transition: 'color 1.2s ease, text-shadow 1.2s ease',
    }}>
      {glyphs[phase]}
    </span>
  );
}

function StatsPanel({ stats, silence, col, isEsc }) {
  const lvlPct = `${(stats.avgLevel * 100).toFixed(0)}%`;
  const avgT   = stats.avgTime > 0 ? `${stats.avgTime.toFixed(0)}s` : '—';
  const dir    = stats.avgLevel < 0.25 ? '↑ lengthening'
               : stats.avgLevel > 0.55 ? '↓ shortening'
               : '→ calibrated';

  return (
    <div style={S.stats}>
      <StatCell label="Sessions"       val={stats.total}  />
      <StatCell label="Avg recovery"   val={lvlPct}  sub="lower = earlier" />
      <StatCell label="Avg time"       val={avgT} />
      <StatCell label="Silence"        val={`${silence}s`} sub={dir} />
    </div>
  );
}

function StatCell({ label, val, sub }) {
  return (
    <div style={S.statCell}>
      <div style={S.statLabel}>{label}</div>
      <div style={S.statVal}>{val}</div>
      {sub && <div style={S.statSub}>{sub}</div>}
    </div>
  );
}

function HistoryDots({ sessions }) {
  return (
    <div style={S.dots}>
      {sessions.map((s, i) => {
        const c = Esc.color(s.level);
        return (
          <span key={i}
            title={`Session ${i+1}: ${(s.level*100).toFixed(0)}% escalation · ${s.timeToAck?.toFixed(0)}s`}
            style={{
              display: 'block',
              width: 7, height: 7, borderRadius: '50%',
              backgroundColor: c, boxShadow: `0 0 5px ${c}`,
              opacity: 0.40 + s.level * 0.60,
            }}
          />
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const S = {
  root: {
    minHeight: '100vh',
    background: 'linear-gradient(155deg, #060810 0%, #08091c 50%, #07091a 100%)',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    fontFamily: '"Cormorant Garamond", Georgia, serif',
    color: '#c2c8e0', padding: '24px 20px', gap: 28,
    position: 'relative', overflow: 'hidden', userSelect: 'none',
  },
  grain: {
    position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, opacity: 1,
    backgroundImage: [
      `radial-gradient(ellipse at 30% 20%, #0d1535 0%, transparent 60%)`,
      `radial-gradient(ellipse at 75% 80%, #100d28 0%, transparent 60%)`,
    ].join(','),
  },
  header: { textAlign: 'center', position: 'relative', zIndex: 1 },
  wordmark: {
    fontSize: 30, fontWeight: 300, letterSpacing: '0.32em',
    color: '#7a88ac', fontStyle: 'italic', margin: 0,
  },
  tagline: {
    fontSize: 10, letterSpacing: '0.22em', color: '#2e3555',
    textTransform: 'uppercase', marginTop: 6, fontStyle: 'normal',
  },
  stage: {
    position: 'relative', width: 220, height: 220,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1,
  },
  ring: {
    position: 'absolute', inset: 0,
    pointerEvents: 'none', zIndex: 1,
  },
  orb: {
    width: 180, height: 180, borderRadius: '50%',
    border: '1.5px solid',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'none',
    transition: [
      'box-shadow 1.4s ease',
      'border-color 1.4s ease',
      'background 1.4s ease',
      'opacity 0.9s ease',
    ].join(', '),
    zIndex: 2, position: 'relative',
  },
  phaseLabel: {
    fontSize: 11, letterSpacing: '0.15em', textTransform: 'uppercase',
    minHeight: 18, transition: 'color 1.2s ease',
    textAlign: 'center', fontFamily: 'Georgia, serif',
    fontStyle: 'italic', zIndex: 1,
  },
  stats: {
    display: 'flex', gap: 30, zIndex: 1,
    borderTop: '1px solid #111828', paddingTop: 20,
  },
  statCell:  { textAlign: 'center' },
  statLabel: { fontSize: 9, letterSpacing: '0.18em', color: '#2e3858', textTransform: 'uppercase', marginBottom: 3 },
  statVal:   { fontSize: 22, color: '#5e6e90', fontWeight: 300, fontStyle: 'italic' },
  statSub:   { fontSize: 9, color: '#252e48', marginTop: 2, letterSpacing: '0.04em' },
  dots: {
    display: 'flex', gap: 6, flexWrap: 'wrap',
    justifyContent: 'center', maxWidth: 200, zIndex: 1,
  },
  prose: {
    textAlign: 'center', color: '#2c3355', fontSize: 14,
    lineHeight: 2.0, letterSpacing: '0.03em', fontStyle: 'italic',
    maxWidth: 260, zIndex: 1,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// CSS (keyframes + font import)
// ─────────────────────────────────────────────────────────────────────────────

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  button:focus { outline: none; }

  /* ── Ripple: expanding ring that fades out ── */
  @keyframes ripple {
    0%   { transform: scale(1);   opacity: 0.55; }
    100% { transform: scale(2.7); opacity: 0; }
  }

  .ripple {
    position: absolute;
    width: 180px; height: 180px;
    border-radius: 50%;
    border: 1px solid var(--rc, #4a8ab0);
    box-shadow: 0 0 6px var(--rc, #4a8ab0);
    animation: ripple 2.6s ease-out forwards;
    pointer-events: none;
    z-index: 0;
  }

  /* ── Idle: slow meditative breathing ── */
  @keyframes breathe {
    0%, 100% { transform: scale(1); }
    50%       { transform: scale(1.026); }
  }
  .orb-breathe {
    animation: breathe 3.6s ease-in-out infinite;
  }

  /* ── Escalating: faster, more insistent pulse ── */
  @keyframes orb-pulse {
    0%, 100% { transform: scale(1); }
    50%       { transform: scale(1.072); }
  }
  .orb-pulse {
    animation: orb-pulse var(--ps, 1.2s) ease-in-out infinite;
  }
`;


  /* ── Ripple: expanding ring that fades out ── */
  @keyframes ripple {
    0%   { transform: scale(1);   opacity: 0.55; }
    100% { transform: scale(2.7); opacity: 0; }
  }

  .ripple {
    position: absolute;
    width: 180px; height: 180px;
    border-radius: 50%;
    border: 1px solid var(--rc, #4a8ab0);
    box-shadow: 0 0 6px var(--rc, #4a8ab0);
    animation: ripple 2.6s ease-out forwards;
    pointer-events: none;
    z-index: 0;
  }

  /* ── Idle: slow meditative breathing ── */
  @keyframes breathe {
    0%, 100% { transform: scale(1); }
    50%       { transform: scale(1.026); }
  }
  .orb-breathe {
    animation: breathe 3.6s ease-in-out infinite;
  }

  /* ── Escalating: faster, more insistent pulse ── */
  @keyframes orb-pulse {
    0%, 100% { transform: scale(1); }
    50%       { transform: scale(1.072); }
  }
  .orb-pulse {
    animation: orb-pulse var(--ps, 1.2s) ease-in-out infinite;
  }
`;

