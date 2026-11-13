/**
 * Effects — 효과음 + 완성 순간 선물 '통통' (파티클·빛 고리·완성 문구 같은 화면 효과는 넣지 않음)
 *
 *   const fx = new Effects(scene, config.effects);
 *   fx.play('select')                       // 효과음: select | cut | land | swap
 *   fx.playSound('tear', 0.55)              // 효과음 직접: tear | pull | whoosh | hop | tick | complete | ribbon
 *   const amt = fx.celebrate('complete')    // 완성 효과음 + 통통 정도(0 이면 끔): complete(포장 완성) | ribbon(리본까지)
 *   fx.unlockAudio()                        // 첫 클릭/VR 시작 때 (브라우저 소리 정책)
 *
 * 설정(config.effects)은 참조로 들고 있으므로 편집기에서 값을 바꾸면 바로 반영됨.
 */

export const DEFAULT_EFFECTS = {
  enabled: true,
  sound: { enabled: true, volume: 0.6 },
  hover: { enabled: true, color: '#ffd98a', intensity: 0.35 },          // 가리킬 때 살짝 빛남
  complete: { enabled: true, bounce: { enabled: true, amount: 0.14 }, sound: { enabled: true } },
  ribbon: { enabled: true, bounce: { enabled: true, amount: 0.1 }, sound: { enabled: true } },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(base, user) {
  if (!isObj(user)) return structuredClone(base);
  const out = {};
  for (const k of Object.keys(base)) {                 // 기본값에 있는 항목만 (예전 파티클 설정은 버림)
    const b = base[k], u = user[k];
    out[k] = isObj(b) ? deepMerge(b, u) : (u !== undefined && typeof u === typeof b ? structuredClone(u) : structuredClone(b));
  }
  return out;
}
/** 저장된 설정 + 기본값 (빠진 항목은 기본값으로) */
export function mergeEffects(user) { return deepMerge(DEFAULT_EFFECTS, user); }

/* ------------------------------------------------------------------ 효과음 (WebAudio 합성 — 파일 필요 없음) */
class Sounds {
  constructor(cfg) { this.cfg = cfg; this.ctx = null; }
  unlock() {
    if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; } }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  get ok() { const s = this.cfg(); return s.enabled && this.ctx && this.ctx.state === 'running'; }
  _out(gain) { const g = this.ctx.createGain(); g.gain.value = gain * this.cfg().volume; g.connect(this.ctx.destination); return g; }
  _tone(freq, t0, dur, { type = 'sine', gain = 0.3, f1 = null, attack = 0.005 } = {}) {
    const c = this.ctx, o = c.createOscillator(), g = this._out(1);
    o.type = type; o.frequency.setValueAtTime(freq, t0); if (f1) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain * this.cfg().volume, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  _noise(t0, dur, { gain = 0.2, freq = 3000, q = 1, type = 'bandpass' } = {}) {
    const c = this.ctx, n = Math.ceil(c.sampleRate * dur), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = c.createBufferSource(); s.buffer = buf;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this._out(gain); s.connect(f); f.connect(g); s.start(t0);
  }
  play(name, dur = 0.5) {
    if (!this.ok) return;
    const t = this.ctx.currentTime + 0.01;
    switch (name) {
      case 'tear': {                                   // 지지직: 짧은 종이 찢는 소리가 빠르게 이어짐
        let k = 0;
        while (k < dur) {
          this._noise(t + k, 0.012 + Math.random() * 0.02, { freq: 1800 + Math.random() * 3800, q: 1.5 + Math.random() * 2, gain: 0.12 + Math.random() * 0.22 });
          k += 0.008 + Math.random() * 0.022;
        }
        this._noise(t, dur + 0.05, { freq: 1200, q: 0.6, gain: 0.06 });
        this._noise(t + dur - 0.02, 0.06, { freq: 3000, q: 1, gain: 0.3 });
        break;
      }
      case 'pull': this._tone(260 + Math.random() * 40, t, 0.03, { type: 'square', gain: 0.025 }); this._noise(t, 0.02, { freq: 2500, q: 3, gain: 0.05 }); break;
      case 'select': this._tone(880, t, 0.09, { f1: 1500, gain: 0.18 }); break;
      case 'click':                                   // 램프 당김 줄: 딸깍
        this._noise(t, 0.012, { freq: 4200, q: 3, gain: 0.35 }); this._tone(1800, t, 0.025, { type: 'square', gain: 0.03 });
        this._noise(t + 0.09, 0.01, { freq: 3000, q: 3, gain: 0.2 });
        break;
      case 'cut': this._noise(t, 0.05, { freq: 5200, q: 2.5, gain: 0.35 }); this._noise(t + 0.07, 0.06, { freq: 4300, q: 2.5, gain: 0.3 }); break;
      case 'whoosh': this._noise(t, 0.35, { freq: 900, q: 0.7, gain: 0.12 }); break;
      case 'land': this._tone(340, t, 0.14, { f1: 140, gain: 0.25 }); this._noise(t, 0.08, { freq: 700, q: 0.8, gain: 0.08, type: 'lowpass' }); break;
      case 'hop': this._tone(420, t, 0.16, { f1: 900, gain: 0.12, type: 'triangle' }); break;
      case 'swap': this._tone(1200, t, 0.08, { gain: 0.1 }); this._tone(1600, t + 0.06, 0.1, { gain: 0.1 }); break;
      case 'tick': this._tone(1000 + Math.random() * 500, t, 0.05, { gain: 0.06, type: 'triangle' }); break;
      case 'complete':
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this._tone(f, t + i * 0.09, 0.5, { type: 'triangle', gain: 0.22 }));
        this._tone(1046.5, t + 0.36, 0.9, { gain: 0.16 }); this._tone(1318.5, t + 0.36, 0.9, { gain: 0.1 });
        break;
      case 'ribbon':
        for (const dt of [0, 0.14, 0.26]) for (const [f, g] of [[2093, 0.12], [3135, 0.06], [4186, 0.04]]) this._tone(f * (1 + dt * 0.1), t + dt, 0.5, { gain: g });
        [659.25, 783.99, 987.77, 1318.5].forEach((f, i) => this._tone(f, t + 0.3 + i * 0.08, 0.45, { type: 'triangle', gain: 0.16 }));
        break;
    }
  }
}

export class Effects {
  constructor(scene, cfg) { this.cfg = cfg; this.sound = new Sounds(() => this.cfg.sound); }
  setConfig(cfg) { this.cfg = cfg; }
  get on() { return this.cfg?.enabled !== false; }
  unlockAudio() { this.sound.unlock(); }
  playSound(name, dur) { if (this.on) this.sound.play(name, dur); }
  play(name) { this.playSound(name); }
  /** 완성: 효과음 + 통통 정도 반환 (호출한 쪽에서 선물 크기에 적용) */
  celebrate(key) {
    if (!this.on) return 0;
    const c = this.cfg[key]; if (!c || c.enabled === false) return 0;
    if (c.sound?.enabled !== false) this.sound.play(key === 'ribbon' ? 'ribbon' : 'complete');
    return c.bounce?.enabled ? c.bounce.amount : 0;
  }
  update() {}
  clear() {}
}
