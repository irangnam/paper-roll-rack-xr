/**
 * Effects — 게임 이펙트 (파티클 · 색종이 · 링 · 완성 문구 · 효과음)
 *
 *   const fx = new Effects(scene, config.effects, { getViewer: () => camera, groundAt: (x, z) => y });
 *   fx.play('select', worldPos)            // 짧은 반짝임: select | cut | land | swap
 *   fx.gather(worldPos, progress, dt)      // 모으는 동안 계속 반짝임
 *   fx.celebrate('complete', worldPos)     // 완성 축하: complete(포장 완성) | ribbon(리본까지 완성)
 *   fx.update(dt)                          // 매 프레임
 *   fx.unlockAudio()                       // 첫 클릭/VR 시작 때 (브라우저 소리 정책)
 *
 * 설정(config.effects)은 참조로 들고 있으므로 편집기에서 값을 바꾸면 바로 반영됨.
 * 모든 이펙트는 enabled 로 끄고 켤 수 있고, 맨 위 enabled = false 면 전부 꺼짐.
 * 크기·거리 단위 m, 시간 s, 속도 m/s, 각도 °.
 */
import * as THREE from 'three';

const CELEBRATE_BASE = (o = {}) => ({
  enabled: true,
  confetti: { enabled: true, count: 180, colors: ['#ff4d6d', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff', '#ffffff'], size: 0.016, speed: 1.7, spread: 50, gravity: 2.4, drag: 1.6, life: 3.0, ...o.confetti },
  stars: { enabled: true, count: 36, color: '#ffe066', size: 0.045, speed: 0.9, life: 1.3, ...o.stars },
  sparkle: { enabled: true, count: 60, color: '#fff6d5', size: 0.02, speed: 0.45, life: 1.8, ...o.sparkle },
  ring: { enabled: true, color: '#fff1a8', radius: 0.32, life: 0.8, ...o.ring },
  flash: { enabled: true, color: '#fff3c4', size: 0.28, life: 0.4, ...o.flash },
  text: { enabled: true, label: '완성!', color: '#ffffff', outline: '#d6336c', size: 0.1, life: 2.4, height: 0.22, ...o.text },
  bounce: { enabled: true, amount: 0.14, ...o.bounce },
  sound: { enabled: true, ...o.sound },
});

export const DEFAULT_EFFECTS = {
  enabled: true,
  sound: { enabled: true, volume: 0.6 },
  hover: { enabled: true, color: '#ffd98a', intensity: 0.35 },
  select: { enabled: true, count: 16, color: '#fff3b0', size: 0.018, speed: 0.35, life: 0.6 },
  cut: { enabled: true, count: 28, color: '#ffffff', size: 0.016, speed: 0.4, life: 0.55 },
  land: { enabled: true, count: 18, color: '#f4efe6', size: 0.04, speed: 0.28, life: 0.75 },
  swap: { enabled: true, count: 30, color: '#ffe8f4', size: 0.02, speed: 0.3, life: 0.7 },
  gather: { enabled: true, rate: 45, color: '#ffd8f0', size: 0.014, life: 0.9, ring: true, ringColor: '#ffd166' },
  complete: CELEBRATE_BASE({ text: { label: '포장 완성!' } }),
  ribbon: CELEBRATE_BASE({
    confetti: { count: 140, colors: ['#9b1c31', '#e9c46a', '#f4a261', '#ffffff', '#ff8fab'] },
    stars: { count: 28 },
    text: { label: '선물 완성! 🎀', outline: '#9b1c31' },
    bounce: { amount: 0.1 },
  }),
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(base, user) {
  if (!isObj(user)) return structuredClone(base);
  const out = Array.isArray(base) ? [...base] : {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(user)])) {
    const b = base[k], u = user[k];
    out[k] = isObj(b) ? deepMerge(b, u) : (u !== undefined ? structuredClone(u) : structuredClone(b));
  }
  return out;
}
/** 저장된 설정 + 기본값 (빠진 항목은 기본값으로) */
export function mergeEffects(user) { return deepMerge(DEFAULT_EFFECTS, user); }

/* ------------------------------------------------------------------ 텍스처 아틀라스 (흰색, 색은 파티클마다 곱함) */
const SHAPES = 4;   // 0 = 둥근 빛, 1 = 반짝(십자), 2 = 별, 3 = 몽글 연기
function makeAtlas() {
  const S = 128, c = document.createElement('canvas'); c.width = S * SHAPES; c.height = S;
  const g = c.getContext('2d');
  const glow = (cx, cy, r, a = 1) => {
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(0.25, `rgba(255,255,255,${a * 0.65})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  };
  // 0 둥근 빛
  glow(S / 2, S / 2, S / 2);
  // 1 반짝: 가는 십자 + 중심 빛
  { const o = S, cx = o + S / 2, cy = S / 2;
    g.save(); g.translate(cx, cy);
    for (const [w, l, a] of [[5, 62, 1], [3, 40, 0.8]]) {
      for (let k = 0; k < (a === 1 ? 2 : 2); k++) {
        g.rotate(a === 1 ? (k ? Math.PI / 2 : 0) : Math.PI / 4 * (k ? 2 : 1));
        const gr = g.createLinearGradient(-l, 0, l, 0);
        gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, `rgba(255,255,255,${a})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.beginPath(); g.ellipse(0, 0, l, w, 0, 0, Math.PI * 2); g.fill();
      }
    }
    g.restore(); glow(cx, cy, 26); }
  // 2 별 (속 채운 5각 별 + 테두리 빛)
  { const cx = 2 * S + S / 2, cy = S / 2 + 4;
    glow(cx, cy, S / 2, 0.35);
    g.fillStyle = '#fff'; g.beginPath();
    for (let k = 0; k < 10; k++) { const r = k % 2 ? 19 : 46, a = -Math.PI / 2 + k * Math.PI / 5; g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
    g.closePath(); g.fill(); }
  // 3 몽글 연기
  { const ox = 3 * S;
    for (const [x, y, r] of [[64, 64, 40], [44, 70, 28], [86, 70, 28], [62, 46, 28], [70, 82, 24]]) {
      const gr = g.createRadialGradient(ox + x, y, 0, ox + x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.75)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(ox + x, y, r, 0, Math.PI * 2); g.fill();
    } }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/* ------------------------------------------------------------------ 빌보드 파티클 (InstancedBufferGeometry — VR 두 눈에서도 정확) */
class BillboardSystem {
  constructor(atlas, max, additive) {
    this.max = max; this.list = [];
    const base = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index; g.setAttribute('position', base.attributes.position); g.setAttribute('uv', base.attributes.uv);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aMisc = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iCol', this.aCol); g.setAttribute('iMisc', this.aMisc);
    g.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uAtlas: { value: atlas } },
      vertexShader: `
        attribute vec3 iPos; attribute vec4 iCol; attribute vec3 iMisc;
        varying vec2 vUv; varying vec4 vCol;
        void main() {
          vUv = vec2((uv.x + iMisc.z) / ${SHAPES}.0, uv.y); vCol = iCol;
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          float c = cos(iMisc.y), s = sin(iMisc.y);
          vec2 p = position.xy * iMisc.x;
          mv.xy += vec2(c * p.x - s * p.y, s * p.x + c * p.y);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uAtlas; varying vec2 vUv; varying vec4 vCol;
        void main() {
          vec4 t = texture2D(uAtlas, vUv);
          float a = t.a * vCol.a;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vCol.rgb * t.rgb${additive ? ' * a' : ''}, a);
        }`,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = additive ? 12 : 11;
    this.mesh.name = additive ? 'FX_Sparkles' : 'FX_Puffs';
  }

  spawn(p) { if (this.list.length >= this.max) this.list.shift(); this.list.push(p); }

  update(dt) {
    const L = this.list;
    for (let i = L.length - 1; i >= 0; i--) {
      const p = L[i]; p.age += dt;
      if (p.age < 0) continue;                          // 지연 출발
      if (p.age >= p.life) { L.splice(i, 1); continue; }
      p.v.y -= (p.gravity ?? 0) * dt;
      p.v.multiplyScalar(Math.exp(-(p.drag ?? 2) * dt));
      p.pos.addScaledVector(p.v, dt);
      p.rot += (p.spin ?? 0) * dt;
    }
    let n = 0;
    const P = this.aPos.array, C = this.aCol.array, M = this.aMisc.array;
    for (const p of L) {
      if (p.age < 0) continue;
      const t = p.age / p.life;
      let a = Math.min(1, p.age / (p.fadeIn ?? 0.06)) * (1 - Math.pow(t, p.fadePow ?? 2));
      if (p.twinkle) a *= 0.55 + 0.45 * Math.sin(p.age * p.twinkle + p.phase);
      const size = p.size0 + (p.size1 - p.size0) * (p.sizeEase === 'out' ? 1 - (1 - t) * (1 - t) : t);
      P[n * 3] = p.pos.x; P[n * 3 + 1] = p.pos.y; P[n * 3 + 2] = p.pos.z;
      C[n * 4] = p.color.r; C[n * 4 + 1] = p.color.g; C[n * 4 + 2] = p.color.b; C[n * 4 + 3] = a * (p.alpha ?? 1);
      M[n * 3] = size; M[n * 3 + 1] = p.rot; M[n * 3 + 2] = p.shape;
      n++;
    }
    this.mesh.geometry.instanceCount = n;
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aMisc.needsUpdate = true;
  }

  clear() { this.list.length = 0; this.mesh.geometry.instanceCount = 0; }
}

/* ------------------------------------------------------------------ 색종이 (나풀거리며 떨어지고 바닥/테이블에 잠깐 쌓임) */
class ConfettiSystem {
  constructor(max, groundAt) {
    this.max = max; this.list = []; this.groundAt = groundAt;
    const geo = new THREE.PlaneGeometry(1, 0.55);
    const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.45, metalness: 0.25 });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.name = 'FX_Confetti';
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._c = new THREE.Color();
  }

  spawn(p) { if (this.list.length >= this.max) this.list.shift(); this.list.push(p); }

  update(dt) {
    const L = this.list;
    for (let i = L.length - 1; i >= 0; i--) {
      const p = L[i]; p.age += dt;
      if (p.age >= p.life) { L.splice(i, 1); continue; }
      if (p.age < 0) continue;
      if (!p.landed) {
        p.v.y -= p.gravity * dt;
        p.v.multiplyScalar(Math.exp(-p.drag * dt));
        // 종이라 떨어질 땐 좌우로 하늘거림
        const fl = Math.min(1, p.age * 1.5) * 0.25;
        p.pos.x += (p.v.x + Math.sin(p.age * p.fw + p.phase) * fl) * dt;
        p.pos.y += p.v.y * dt;
        p.pos.z += (p.v.z + Math.cos(p.age * p.fw * 0.8 + p.phase) * fl) * dt;
        p.angle += p.angVel * dt;
        const gy = this.groundAt ? this.groundAt(p.pos.x, p.pos.z) : -Infinity;
        if (p.pos.y <= gy + 0.001) {                    // 바닥에 닿으면 납작하게 눕고 잠시 뒤 사라짐
          p.pos.y = gy + 0.001 + Math.random() * 0.0015; p.landed = true;
          p.life = Math.min(p.life, p.age + 0.9 + Math.random() * 0.8);
          p.flat = this._q2.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2).clone()
            .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * 6.28));
        }
      }
    }
    let n = 0;
    for (const p of L) {
      if (p.age < 0) continue;
      const t = p.age / p.life, fade = t > 0.85 ? 1 - (t - 0.85) / 0.15 : 1;
      if (p.landed) this._q.copy(p.flat); else this._q.setFromAxisAngle(p.axis, p.angle);
      this._s.set(p.size * fade, p.size * fade, p.size * fade);
      this._m.compose(p.pos, this._q, this._s);
      this.mesh.setMatrixAt(n, this._m);
      this.mesh.setColorAt(n, p.color);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() { this.list.length = 0; this.mesh.count = 0; }
}

/* ------------------------------------------------------------------ 퍼지는 빛 고리 (바닥에 눕혀서) */
class RingSystem {
  constructor(n = 6) {
    this.items = [];
    this.group = new THREE.Group(); this.group.name = 'FX_Rings';
    const geo = new THREE.RingGeometry(0.86, 1, 72); geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }));
      m.visible = false; m.renderOrder = 10; this.group.add(m);
      this.items.push({ m, age: 0, life: 1, r: 0.3, on: false });
    }
  }
  spawn(pos, color, radius, life, delay = 0) {
    const it = this.items.find((x) => !x.on) || this.items[0];
    Object.assign(it, { on: true, age: -delay, life, r: radius });
    it.m.position.copy(pos); it.m.material.color.set(color); it.m.visible = false;
  }
  update(dt) {
    for (const it of this.items) {
      if (!it.on) continue;
      it.age += dt;
      if (it.age < 0) continue;
      const t = it.age / it.life;
      if (t >= 1) { it.on = false; it.m.visible = false; continue; }
      const e = 1 - Math.pow(1 - t, 3);
      it.m.visible = true; it.m.scale.setScalar(0.02 + it.r * e);
      it.m.material.opacity = (1 - t) * (1 - t);
    }
  }
  clear() { for (const it of this.items) { it.on = false; it.m.visible = false; } }
}

/* ------------------------------------------------------------------ 완성 문구 (통통 튀어나와 떠오르다 사라짐) */
class TextPop {
  constructor() {
    this.canvas = document.createElement('canvas'); this.canvas.width = 1024; this.canvas.height = 256;
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false }));
    this.mesh.renderOrder = 30; this.mesh.visible = false; this.mesh.name = 'FX_Text';
    this.on = false;
  }
  show(pos, o) {
    const c = this.canvas, g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    // 글자 수에 맞게 글꼴 크기를 줄여 캔버스 안에 들어가게
    let fs = 150;
    const font = (n) => `900 ${n}px "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif`;
    g.font = font(fs);
    while (fs > 40 && g.measureText(o.label).width > c.width - 190) { fs -= 6; g.font = font(fs); }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const cx = c.width / 2, cy = c.height / 2 + 8;
    g.lineJoin = 'round';
    g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 18; g.shadowOffsetY = 8;
    g.lineWidth = 30; g.strokeStyle = o.outline; g.strokeText(o.label, cx, cy);
    g.shadowColor = 'transparent';
    g.lineWidth = 12; g.strokeStyle = '#ffffff'; g.strokeText(o.label, cx, cy);
    const gr = g.createLinearGradient(0, cy - 70, 0, cy + 70);
    const base = new THREE.Color(o.color);
    gr.addColorStop(0, '#' + base.clone().lerp(new THREE.Color('#ffffff'), 0.6).getHexString());
    gr.addColorStop(1, '#' + base.getHexString());
    g.fillStyle = gr; g.fillText(o.label, cx, cy);
    // 작은 별 장식
    g.fillStyle = '#ffe066';
    const w = Math.min(c.width - 80, g.measureText(o.label).width);
    for (const [x, y, r] of [[cx - w / 2 - 34, cy - 54, 18], [cx + w / 2 + 30, cy - 40, 14], [cx + w / 2 + 52, cy + 36, 9]]) {
      g.beginPath(); for (let k = 0; k < 10; k++) { const rr = k % 2 ? r * 0.42 : r, a = -Math.PI / 2 + k * Math.PI / 5; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } g.closePath(); g.fill();
    }
    this.tex.needsUpdate = true;
    this.pos = pos.clone(); this.o = o; this.age = 0; this.on = true; this.mesh.visible = true;
  }
  update(dt, viewer) {
    if (!this.on) return;
    this.age += dt;
    const o = this.o, t = this.age;
    if (t >= o.life) { this.on = false; this.mesh.visible = false; return; }
    // 튀어나옴(오버슈트) → 천천히 떠오름 → 사라짐
    const k = Math.min(1, t / 0.45);
    const pop = k < 1 ? 1 + 2.7 * Math.pow(k - 1, 3) + 1.7 * Math.pow(k - 1, 2) : 1;
    const s = o.size * Math.max(0.001, pop);
    this.mesh.scale.set(s, s, s);
    this.mesh.position.copy(this.pos); this.mesh.position.y += o.height + t * 0.03;
    const fade = t > o.life * 0.7 ? 1 - (t - o.life * 0.7) / (o.life * 0.3) : 1;
    this.mesh.material.opacity = Math.max(0, fade);
    if (viewer) { viewer.getWorldPosition(_tmp); this.mesh.lookAt(_tmp); }
  }
  hide() { this.on = false; this.mesh.visible = false; }
}
const _tmp = new THREE.Vector3();

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
  play(name) {
    if (!this.ok) return;
    const t = this.ctx.currentTime + 0.01;
    switch (name) {
      case 'select': this._tone(880, t, 0.09, { f1: 1500, gain: 0.18 }); break;
      case 'cut': this._noise(t, 0.05, { freq: 5200, q: 2.5, gain: 0.35 }); this._noise(t + 0.07, 0.06, { freq: 4300, q: 2.5, gain: 0.3 }); this._tone(2400, t + 0.06, 0.08, { gain: 0.05 }); break;
      case 'whoosh': this._noise(t, 0.35, { freq: 900, q: 0.7, gain: 0.12 }); break;
      case 'land': this._tone(340, t, 0.14, { f1: 140, gain: 0.25 }); this._noise(t, 0.08, { freq: 700, q: 0.8, gain: 0.08, type: 'lowpass' }); break;
      case 'hop': this._tone(420, t, 0.16, { f1: 900, gain: 0.12, type: 'triangle' }); break;
      case 'swap': this._tone(1200, t, 0.08, { gain: 0.1 }); this._tone(1600, t + 0.06, 0.1, { gain: 0.1 }); break;
      case 'tick': this._tone(1000 + Math.random() * 500, t, 0.05, { gain: 0.06, type: 'triangle' }); break;
      case 'complete': {
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this._tone(f, t + i * 0.09, 0.5, { type: 'triangle', gain: 0.22 }));
        this._tone(1046.5, t + 0.36, 0.9, { type: 'sine', gain: 0.16 });
        this._tone(1318.5, t + 0.36, 0.9, { type: 'sine', gain: 0.1 });
        for (let i = 0; i < 9; i++) this._tone(2200 + Math.random() * 2600, t + 0.3 + i * 0.06, 0.18, { gain: 0.04 });
        this._noise(t, 0.12, { freq: 1800, q: 0.6, gain: 0.08 });
        break;
      }
      case 'ribbon': {
        for (const dt of [0, 0.14, 0.26]) for (const [f, g] of [[2093, 0.12], [3135, 0.06], [4186, 0.04]]) this._tone(f * (1 + dt * 0.1), t + dt, 0.5, { gain: g });
        [659.25, 783.99, 987.77, 1318.5].forEach((f, i) => this._tone(f, t + 0.3 + i * 0.08, 0.45, { type: 'triangle', gain: 0.16 }));
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------ main */
const rnd = (a, b) => a + Math.random() * (b - a);
function randDir(out, spreadDeg = 180, up = new THREE.Vector3(0, 1, 0)) {
  // up 축 중심 원뿔(반각 spread) 안의 무작위 방향
  const ca = Math.cos(THREE.MathUtils.degToRad(spreadDeg));
  const z = rnd(ca, 1), phi = rnd(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
  out.set(r * Math.cos(phi), z, r * Math.sin(phi));
  if (up.y < 0.999) out.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up));
  return out;
}

export class Effects {
  /** cfg = config.effects (참조). opts.getViewer() = 카메라(VR이면 XR 카메라), opts.groundAt(x, z) = 그 위치의 바닥/테이블 높이(월드) */
  constructor(scene, cfg, opts = {}) {
    this.cfg = cfg;
    this.getViewer = opts.getViewer ?? (() => null);
    this.root = new THREE.Group(); this.root.name = 'Effects';
    scene.add(this.root);
    const atlas = makeAtlas();
    this.glow = new BillboardSystem(atlas, 2400, true);
    this.puff = new BillboardSystem(atlas, 500, false);
    this.confetti = new ConfettiSystem(900, opts.groundAt ?? null);
    this.rings = new RingSystem();
    this.text = new TextPop();
    this.root.add(this.puff.mesh, this.glow.mesh, this.confetti.mesh, this.rings.group, this.text.mesh);
    this.sound = new Sounds(() => this.cfg.sound);
    this._gatherAcc = 0;
  }

  setConfig(cfg) { this.cfg = cfg; }
  get on() { return this.cfg?.enabled !== false; }
  unlockAudio() { this.sound.unlock(); }
  playSound(name) { if (this.on) this.sound.play(name); }

  _c(hex) { return new THREE.Color(hex); }

  /** 짧은 이펙트: select | cut | land | swap. extra: { axis(월드 방향), width } — cut 은 그 폭만큼 선으로 반짝 */
  play(name, pos, extra = {}) {
    if (!this.on) return;
    const c = this.cfg[name];
    if (c?.enabled === false) { return; }
    if (name === 'select' || name === 'swap') {
      if (c) for (let i = 0; i < c.count; i++) {
        const d = randDir(new THREE.Vector3(), 180);
        this.glow.spawn({ pos: pos.clone().addScaledVector(d, 0.01), v: d.multiplyScalar(c.speed * rnd(0.4, 1)), age: -rnd(0, 0.05), life: c.life * rnd(0.7, 1.1),
          size0: c.size * rnd(0.8, 1.3), size1: 0, color: this._c(c.color), shape: i % 3 ? 0 : 1, rot: rnd(0, 6), spin: rnd(-3, 3), drag: 3, gravity: 0.1 });
      }
      this.sound.play(name);
    } else if (name === 'cut') {
      const axis = (extra.axis ?? new THREE.Vector3(1, 0, 0)).clone().normalize(), W = extra.width ?? 0.3;
      if (c) for (let i = 0; i < c.count; i++) {
        const s = rnd(-0.5, 0.5) * W, d = randDir(new THREE.Vector3(), 180);
        this.glow.spawn({ pos: pos.clone().addScaledVector(axis, s), v: d.multiplyScalar(c.speed * rnd(0.3, 1)), age: -Math.abs(s) / W * 0.12, life: c.life * rnd(0.6, 1.1),
          size0: c.size * rnd(0.7, 1.4), size1: 0, color: this._c(c.color), shape: i % 4 ? 0 : 1, rot: rnd(0, 6), spin: rnd(-4, 4), drag: 4, gravity: 0.5 });
      }
      this.sound.play('cut');
    } else if (name === 'land') {
      if (c) for (let i = 0; i < c.count; i++) {
        const a = (i / c.count) * Math.PI * 2 + rnd(-0.2, 0.2), d = new THREE.Vector3(Math.cos(a), rnd(0.05, 0.25), Math.sin(a));
        this.puff.spawn({ pos: pos.clone().addScaledVector(d, extra.radius ?? 0.05), v: d.multiplyScalar(c.speed * rnd(0.6, 1.1)), age: 0, life: c.life * rnd(0.7, 1.1),
          size0: c.size * 0.5, size1: c.size * rnd(1, 1.5), sizeEase: 'out', color: this._c(c.color), shape: 3, rot: rnd(0, 6), spin: rnd(-1, 1), drag: 4.5, alpha: 0.8, fadePow: 1.5 });
      }
      this.sound.play('land');
    }
  }

  /** 모으는 동안: 배스밤 둘레에서 반짝임이 피어오름 (progress 0~1 에 비례) */
  gather(pos, progress, dt, radius = 0.06) {
    if (!this.on) return;
    const c = this.cfg.gather; if (!c?.enabled) return;
    this._gatherAcc += c.rate * (0.3 + progress) * dt;
    while (this._gatherAcc >= 1) {
      this._gatherAcc--;
      const a = rnd(0, Math.PI * 2), r = radius * rnd(0.9, 1.4);
      const p = pos.clone().add(new THREE.Vector3(Math.cos(a) * r, rnd(-0.02, 0.05), Math.sin(a) * r));
      this.glow.spawn({ pos: p, v: new THREE.Vector3(-Math.cos(a) * 0.02, rnd(0.06, 0.16), -Math.sin(a) * 0.02), age: 0, life: c.life * rnd(0.7, 1.2),
        size0: c.size * rnd(0.6, 1.3), size1: 0, color: this._c(c.color), shape: Math.random() < 0.3 ? 1 : 0, rot: rnd(0, 6), spin: rnd(-2, 2), drag: 1, twinkle: 18, phase: rnd(0, 6) });
    }
  }

  /** 완성 축하. key = 'complete' | 'ribbon'. 반환: 통통 튀는 정도(0이면 끔) — 호출한 쪽에서 선물 크기에 적용 */
  celebrate(key, pos) {
    if (!this.on) return 0;
    const c = this.cfg[key]; if (!c || c.enabled === false) return 0;
    const up = new THREE.Vector3(0, 1, 0);
    if (c.flash?.enabled) {
      this.glow.spawn({ pos: pos.clone(), v: new THREE.Vector3(), age: 0, life: c.flash.life, size0: c.flash.size * 0.3, size1: c.flash.size, sizeEase: 'out', color: this._c(c.flash.color), shape: 0, rot: 0, fadePow: 1, fadeIn: 0.02 });
    }
    if (c.ring?.enabled) {
      const base = pos.clone(); base.y = this.confetti.groundAt ? this.confetti.groundAt(pos.x, pos.z) + 0.004 : pos.y - 0.05;
      this.rings.spawn(base, c.ring.color, c.ring.radius, c.ring.life);
      this.rings.spawn(base, c.ring.color, c.ring.radius * 0.65, c.ring.life * 0.9, 0.12);
    }
    if (c.stars?.enabled) {
      const s = c.stars;
      for (let i = 0; i < s.count; i++) {
        const d = randDir(new THREE.Vector3(), 75, up);
        this.glow.spawn({ pos: pos.clone(), v: d.multiplyScalar(s.speed * rnd(0.5, 1.1)), age: -rnd(0, 0.08), life: s.life * rnd(0.7, 1.1),
          size0: s.size * rnd(0.6, 1.1), size1: s.size * 0.2, color: this._c(s.color), shape: 2, rot: rnd(0, 6), spin: rnd(-5, 5), drag: 2.2, gravity: 0.6 });
      }
    }
    if (c.sparkle?.enabled) {
      const s = c.sparkle;
      for (let i = 0; i < s.count; i++) {
        const a = rnd(0, Math.PI * 2), r = rnd(0.02, 0.16);
        this.glow.spawn({ pos: pos.clone().add(new THREE.Vector3(Math.cos(a) * r, rnd(-0.03, 0.06), Math.sin(a) * r)), v: new THREE.Vector3(rnd(-0.03, 0.03), s.speed * rnd(0.3, 1), rnd(-0.03, 0.03)),
          age: -rnd(0, 0.9), life: s.life * rnd(0.6, 1.1), size0: s.size * rnd(0.6, 1.4), size1: 0, color: this._c(s.color), shape: Math.random() < 0.5 ? 1 : 0, rot: rnd(0, 6), spin: rnd(-2, 2), drag: 0.6, twinkle: 14, phase: rnd(0, 6) });
      }
    }
    if (c.confetti?.enabled) {
      const s = c.confetti, cols = (s.colors?.length ? s.colors : ['#ffffff']).map((h) => new THREE.Color(h));
      for (let i = 0; i < s.count; i++) {
        const d = randDir(new THREE.Vector3(), s.spread, up);
        this.confetti.spawn({ pos: pos.clone().add(new THREE.Vector3(rnd(-0.02, 0.02), rnd(0, 0.03), rnd(-0.02, 0.02))), v: d.multiplyScalar(s.speed * rnd(0.55, 1.1)),
          age: -rnd(0, 0.06), life: s.life * rnd(0.7, 1.15), size: s.size * rnd(0.7, 1.3), color: cols[i % cols.length],
          axis: new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize(), angle: rnd(0, 6), angVel: rnd(6, 16) * (Math.random() < 0.5 ? -1 : 1),
          gravity: s.gravity, drag: s.drag, fw: rnd(4, 9), phase: rnd(0, 6), landed: false });
      }
    }
    if (c.text?.enabled && c.text.label) this.text.show(pos, c.text);
    if (c.sound?.enabled !== false) this.sound.play(key === 'ribbon' ? 'ribbon' : 'complete');
    return c.bounce?.enabled ? c.bounce.amount : 0;
  }

  update(dt) {
    dt = Math.min(dt, 0.05);
    this.glow.update(dt); this.puff.update(dt); this.confetti.update(dt); this.rings.update(dt);
    this.text.update(dt, this.getViewer());
  }

  clear() { this.glow.clear(); this.puff.clear(); this.confetti.clear(); this.rings.clear(); this.text.hide(); }
}
