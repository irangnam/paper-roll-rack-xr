/**
 * 배스밤 — 떨어뜨리면 퐁당 → 물 위에 떠서 빙글 돌며 쉬익 녹고, 색이 소용돌이 팔로 번지며 물 전체가 뽀얗게 물듦
 *
 * 상태: held(손에 듦) → fall(떨어짐) → float(물 위, 녹는 중) → done
 *       물 밖으로 떨어지면 floor(바닥에 굴러 있다 사라짐)
 */
import * as THREE from 'three';

export const BOMB_PRESETS = [
  { id: 'rose',     name: '로즈',     shell: '#f6b3c2', speck: '#ffffff', dye: ['#ff4f86', '#ffb0c8', '#ff7aa8'] },
  { id: 'lavender', name: '라벤더',   shell: '#cdbcf2', speck: '#8a6ad6', dye: ['#9361ff', '#d9baff', '#6b55e0'] },
  { id: 'ocean',    name: '민트 오션', shell: '#a6e8dc', speck: '#3a9fd6', dye: ['#1fc3d9', '#86f2c8', '#1f74d8'] },
  { id: 'sunset',   name: '선셋 골드', shell: '#ffd394', speck: '#ff7a45', dye: ['#ffad24', '#ff5f3a', '#ffd965'] },
  { id: 'galaxy',   name: '갤럭시',   shell: '#7464dd', speck: '#ffe08a', dye: ['#5a35ff', '#ff4fd2', '#24c2ff', '#ffd45e'] },
];

export const BOMB = {
  radius: 0.034,        // m (지름 약 7cm)
  duration: 30,         // 다 녹는 데 걸리는 초 (천천히 풀어짐)
};

// ---------------------------------------------------------------- 녹는 셰이더 (MeshStandardMaterial 확장)
const N3 = /* glsl */`
float h31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vn3(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z); }`;

function makeBombMaterial(preset) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
  m.userData.u = { uDis: { value: 0 }, uEdge: { value: new THREE.Color(preset.dye[0]) }, uFizz: { value: 0 }, uSpeck: { value: new THREE.Color(preset.speck) } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, m.userData.u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vLP;\nuniform float uDis, uFizz;\nuniform vec3 uEdge, uSpeck;\n${N3}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        float dn = vn3(vLP * 95.0) * 0.55 + vn3(vLP * 32.0) * 0.45;
        if (dn < uDis) discard;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float gr = vn3(vLP * 420.0);
        diffuseColor.rgb *= 0.9 + 0.16 * gr;                                   // 가루 결
        diffuseColor.rgb = mix(diffuseColor.rgb, uSpeck, smoothstep(0.80, 0.86, vn3(vLP * 520.0 + 3.0)));   // 알갱이
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), smoothstep(0.88, 0.92, vn3(vLP * 700.0 + 11.0)) * 0.6);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += uEdge * smoothstep(0.05, 0.0, dn - uDis) * step(0.002, uDis) * 0.18;`);
  };
  m.customProgramCacheKey = () => 'bathbomb';
  return m;
}

function makeBombGeometry(preset, seed) {
  const g = new THREE.IcosahedronGeometry(BOMB.radius, 5);
  const pos = g.attributes.position, v = new THREE.Vector3();
  const shell = new THREE.Color(preset.shell), speck = new THREE.Color(preset.speck), col = new Float32Array(pos.count * 3);
  let s = seed * 9301 + 49297; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const ph = [rnd() * 6, rnd() * 6, rnd() * 6];
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    // 손으로 뭉친 듯 살짝 울퉁불퉁 + 가운데 이음선 (틀 두 쪽을 붙인 자국)
    const bump = 0.035 * Math.sin(v.x * 7 + ph[0]) * Math.sin(v.y * 6 + ph[1]) * Math.sin(v.z * 8 + ph[2]) + 0.012 * Math.sin(v.x * 23 + v.z * 19);
    const seam = -0.025 * Math.exp(-((v.y / 0.05) ** 2));
    v.multiplyScalar(BOMB.radius * (1 + bump + seam));
    pos.setXYZ(i, v.x, v.y, v.z);
    c.copy(shell).multiplyScalar(0.97 + 0.04 * Math.sin(v.y * 9 + ph[0]));
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- 소리 (Web Audio 로 바로 만듦)
export class BasinAudio {
  constructor() { this.ctx = null; this.enabled = true; this.fizzLevel = 0; }
  _init() {
    if (this.ctx) return this.ctx.state === 'suspended' ? this.ctx.resume() : null;
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = ctx.createGain(); this.master.gain.value = 0.7; this.master.connect(ctx.destination);
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    const loop = (f, q, g) => {
      const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const gn = ctx.createGain(); gn.gain.value = g; s.connect(bp).connect(gn).connect(this.master); s.start(); return gn;
    };
    this.fizzGain = loop(5200, 0.7, 0);          // 쉬익
    this.crackGain = loop(2600, 2.5, 0);          // 톡톡 터지는 거품
    this.trickle = loop(1300, 1.2, 0.035);        // 졸졸 물소리 (늘)
  }
  unlock() { try { this._init(); } catch (e) { /* 소리 없이 진행 */ } }
  plop(strength = 1) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(520, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.12);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5 * strength, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.3);
    const s = ctx.createBufferSource(); s.buffer = this.noise;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(3000, t); lp.frequency.exponentialRampToValueAtTime(400, t + 0.4);
    const g2 = ctx.createGain(); g2.gain.setValueAtTime(0.35 * strength, t); g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    s.connect(lp).connect(g2).connect(this.master); s.start(t); s.stop(t + 0.5);
  }
  splash(strength = 0.5) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime, s = ctx.createBufferSource(); s.buffer = this.noise;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900 + Math.random() * 600; bp.Q.value = 0.9;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25 * strength + 0.01, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    s.connect(bp).connect(g).connect(this.master); s.start(t, Math.random()); s.stop(t + 0.35);
  }
  update(fizz, time) {
    if (!this.ctx) return;
    const on = this.enabled ? 1 : 0, t = this.ctx.currentTime;
    this.fizzGain.gain.setTargetAtTime(0.16 * fizz * on, t, 0.08);
    this.crackGain.gain.setTargetAtTime((0.05 + 0.08 * Math.max(0, Math.sin(time * 37) * Math.sin(time * 23))) * fizz * on, t, 0.02);
    this.trickle.gain.setTargetAtTime(0.035 * on, t, 0.2);
  }
}

// ---------------------------------------------------------------- 배스밤들
const _v = new THREE.Vector3(), _u = new THREE.Vector2();

export class BathBombs {
  /**
   * @param {{scene: THREE.Object3D, sim: import('./basin-sim.js').BasinSim, fx: import('./basin-water.js').BasinWaterFX,
   *          audio: BasinAudio, floorY?: number, light?: THREE.PointLight, onHaptic?: Function}} o
   */
  constructor(o) {
    Object.assign(this, o);
    this.floorY ??= 0;
    this.list = []; this.time = 0; this._seed = 1;
  }

  /** 새 배스밤. holder 가 있으면 그 물체를 따라다님 (손·컨트롤러) */
  spawn(preset, pos, { holder = null, vel = null } = {}) {
    const mesh = new THREE.Mesh(makeBombGeometry(preset, this._seed++), makeBombMaterial(preset));
    mesh.position.copy(pos); mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    mesh.castShadow = true;
    this.scene.add(mesh);
    const b = {
      mesh, preset, holder, state: holder ? 'held' : 'fall',
      vel: vel ? vel.clone() : new THREE.Vector3(), prog: 0, t: 0, spin: (Math.random() < 0.5 ? -1 : 1),
      dye: preset.dye.map((c) => new THREE.Color(c)), hist: [], wander: new THREE.Vector2(),
    };
    b.avg = b.dye.reduce((a, c) => a.add(c), new THREE.Color(0, 0, 0)).multiplyScalar(1 / b.dye.length);
    this.list.push(b);
    return b;
  }
  /** 손에서 놓기: 최근 움직임으로 던지는 속도 계산 */
  release(b) {
    if (!b || b.state !== 'held') return;
    b.state = 'fall'; b.holder = null;
    const h = b.hist;
    if (h.length >= 2) {
      const a = h[0], z = h[h.length - 1], dt = Math.max(1e-3, z.t - a.t);
      b.vel.set((z.p.x - a.p.x) / dt, (z.p.y - a.p.y) / dt, (z.p.z - a.p.z) / dt).clampLength(0, 3);
    }
  }
  /** 손으로 저으면 근처 배스밤이 그 방향으로 밀림 (p: 손끝, vx·vz: 손 속도 m/s) */
  push(p, vx, vz, reach = 0.09) {
    for (const b of this.list) {
      if (b.state !== 'float') continue;
      const d = Math.hypot(b.mesh.position.x - p.x, b.mesh.position.z - p.z);
      if (d > reach) continue;
      const f = (1 - d / reach) ** 2 * 0.06;
      b.vel.x += (vx * 0.4 - b.vel.x) * f; b.vel.z += (vz * 0.4 - b.vel.z) * f;
      b.spinV = (b.spinV ?? 0) + (vx * (b.mesh.position.z - p.z) - vz * (b.mesh.position.x - p.x)) * f * 8;
      b.vel.y -= Math.min(0.2, Math.hypot(vx, vz)) * f * 0.3;          // 살짝 출렁
    }
  }
  clear() { for (const b of this.list) this._remove(b); this.list.length = 0; }
  get fizz() { return this.list.reduce((m, b) => Math.max(m, b.state === 'float' ? this._rate(b) : 0), 0); }

  /** 물 영역 밖으로 못 나가게: 테두리 · 뒷벽에 닿으면 바깥쪽 속도를 없애고 살짝 튕김 */
  _keepInside(b, r) {
    const sim = this.sim, p = b.mesh.position, lim = sim.radius - r - 0.012;
    const dx = p.x - sim.center.x, dz = p.z - sim.center.z, d = Math.hypot(dx, dz);
    if (d > lim) {
      const nx = dx / d, nz = dz / d;
      p.x = sim.center.x + nx * lim; p.z = sim.center.z + nz * lim;
      const vn = b.vel.x * nx + b.vel.z * nz;
      if (vn > 0) { b.vel.x -= nx * vn * 1.3; b.vel.z -= nz * vn * 1.3; }
    }
    const wz = sim.wallZ + r + 0.012;
    if (p.z < wz) { p.z = wz; if (b.vel.z < 0) b.vel.z *= -0.3; }
  }
  _rate(b) { return Math.pow(Math.max(0, 1 - b.prog), 0.65) * (0.75 + 0.25 * Math.sin(b.t * 5.3) * Math.sin(b.t * 2.1)); }
  _remove(b) { b.mesh.removeFromParent(); b.mesh.geometry.dispose(); b.mesh.material.dispose(); }

  update(dt) {
    this.time += dt;
    const sim = this.sim, Y = this.fx.surfaceY, R = BOMB.radius;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i], m = b.mesh; b.t += dt;
      if (b.state === 'held') {
        b.holder.getWorldPosition(m.position);
        b.hist.push({ t: this.time, p: m.position.clone() }); while (b.hist.length > 6) b.hist.shift();
        m.rotation.y += dt * 0.6;
        continue;
      }
      if (b.state === 'fall') {
        b.vel.y -= 9.8 * dt; m.position.addScaledVector(b.vel, dt);
        m.rotation.x += dt * 3; m.rotation.z += dt * 2;
        const nearBasin = sim.isInside(m.position.x, m.position.z, -0.05);
        if (nearBasin && m.position.y - R * 0.4 <= Y && b.vel.y < 0) this._splash(b);
        else if (!nearBasin && m.position.y - R <= this.floorY) { m.position.y = this.floorY + R; b.state = 'floor'; b.t = 0; this.audio?.splash(0.2); }
        continue;
      }
      if (b.state === 'floor') {
        b.vel.multiplyScalar(Math.exp(-3 * dt)); b.vel.y = 0; m.position.addScaledVector(b.vel, dt);
        if (b.t > 2.5) { m.scale.multiplyScalar(Math.exp(-6 * dt)); if (m.scale.x < 0.05) { this._remove(b); this.list.splice(i, 1); } }
        continue;
      }
      // float: 녹는 중
      b.prog = Math.min(1, b.prog + dt / BOMB.duration);
      const rate = this._rate(b), sc = 1 - 0.72 * b.prog, r = R * sc;
      m.scale.setScalar(sc);
      m.material.userData.u.uDis.value = 0.08 * b.prog + Math.max(0, b.prog - 0.55) * 1.6;
      m.material.userData.u.uFizz.value = rate;
      // 물 위 둥실 + 떠다님 (벽 · 테두리 피함)
      const p = m.position;
      b.vel.y += ((Y - r * 0.15 + 0.003 * Math.sin(b.t * 3.1)) - p.y) * 60 * dt; b.vel.y *= Math.exp(-6 * dt);
      b.wander.x += (Math.random() - 0.5) * dt * 0.06; b.wander.y += (Math.random() - 0.5) * dt * 0.06; b.wander.multiplyScalar(Math.exp(-1.2 * dt));
      b.vel.x += b.wander.x * dt; b.vel.z += b.wander.y * dt;
      const dx = p.x - sim.center.x, dz = p.z - sim.center.z, d = Math.hypot(dx, dz), lim = sim.radius - r - 0.03;
      if (d > lim) { b.vel.x -= dx / d * (d - lim) * 8 * dt; b.vel.z -= dz / d * (d - lim) * 8 * dt; }
      if (p.z < sim.wallZ + r + 0.03) b.vel.z += (sim.wallZ + r + 0.03 - p.z) * 8 * dt;
      b.vel.x *= Math.exp(-0.9 * dt); b.vel.z *= Math.exp(-0.9 * dt);
      p.addScaledVector(b.vel, dt);
      this._keepInside(b, r);
      b.spinV = (b.spinV ?? 0) * Math.exp(-1.5 * dt); m.rotation.y += b.spin * dt * (0.08 + 0.12 * rate) + b.spinV * dt; m.rotation.x = 0.06 * Math.sin(b.t * 0.9); m.rotation.z = 0.06 * Math.cos(b.t * 0.7);

      // 물에 풀기: 소용돌이 없이 잔잔하게 바깥으로 번짐. 색은 시간 따라 바뀌어 동심원 띠 → 천천히 일렁여 마블 무늬
      const u = sim.toUv(p.x, p.z, _u), ru = sim.len(r), f = dt * 60;
      sim.addSwirl(u.x, u.y, ru * 4.0, 0.11 * rate, 0.004 * b.spin);
      const band = b.t / 4.5, ci = Math.floor(band) % b.dye.length, cn = (ci + 1) % b.dye.length, w = band % 1;
      const col = _c2.copy(b.dye[ci]).lerp(b.dye[cn], Math.min(1, Math.max(0, (w - 0.7) / 0.3)));
      const ring = 7;
      for (let k = 0; k < ring; k++) {
        const a = b.t * 0.12 * b.spin + (k / ring) * Math.PI * 2 + Math.sin(b.t * 0.7 + k) * 0.25;
        const ju = u.x + Math.cos(a) * ru * 1.35, jv = u.y + Math.sin(a) * ru * 1.35;
        const amt = 0.065 * rate * f * (0.6 + 0.4 * Math.sin(b.t * 1.3 + k * 2.1));
        sim.addDye(ju, jv, ru * 0.8, col.r * amt, col.g * amt, col.b * amt, 0);
      }
      sim.addDye(u.x, u.y, ru * 1.4, 0, 0, 0, 0.022 * rate * f);                 // 하얀 거품 (물에 남아 흐름 따라감)
      // 배스밤이 움직이면 둘레 물을 조금 끌고 감 → 거품은 뒤처져 꼬리처럼 남음 (관성)
      sim.addVel(u.x, u.y, ru * 1.6, sim.len(b.vel.x) * 0.3, sim.len(b.vel.z) * 0.3);
      for (let k = 0; k < 2; k++) {                                              // 보글보글 잔물결
        const a = Math.random() * Math.PI * 2, rr = ru * (1.1 + Math.random() * 0.6);
        sim.addWave(u.x + Math.cos(a) * rr, u.y + Math.sin(a) * rr, 0.006, (Math.random() - 0.3) * 0.0025 * rate);
      }
      this.fx.addTint(b.avg, dt * 0.02 * rate);
      this.fx.setBomb(p, r, rate);
      this.fx.pulseMagic(b.avg, 0.2 + 0.3 * rate);
      // 입자: 배스밤 둘레 수면에서 톡톡 터지는 잔 탄산 기포 (작고 금방 사라짐)
      for (let k = 0; k < 3; k++) if (Math.random() < rate) {
        const a = Math.random() * Math.PI * 2, rr = r * (1.0 + Math.random() * 0.5);
        this.fx.bubbles.spawn(p.x + Math.cos(a) * rr, Y + 0.0015, p.z + Math.sin(a) * rr, Math.cos(a) * 0.01, 0, Math.sin(a) * 0.01,
          { size: 0.0012 + Math.random() * 0.0016, life: 0.15 + Math.random() * 0.3, kind: 0, drag: 3 });
      }
      // 부스러져 떨어지는 가루 조각 (배스밤 색, 물에 닿으면 가라앉아 사라짐)
      if (Math.random() < rate * dt * 4) {
        const a = Math.random() * Math.PI * 2, c = b.mesh.material.userData.u.uSpeck.value;
        const sh = new THREE.Color(b.preset.shell);
        const cc = Math.random() < 0.3 ? c : sh;
        this.fx.bubbles.spawn(p.x + Math.cos(a) * r * 0.9, p.y + r * 0.2, p.z + Math.sin(a) * r * 0.9, Math.cos(a) * 0.02, 0.02, Math.sin(a) * 0.02,
          { color: [cc.r, cc.g, cc.b], size: 0.0025 + Math.random() * 0.002, life: 1.2, kind: 1, grav: 0.4, drag: 2, floorY: Y - 0.004 });
      }
      if (Math.random() < rate * dt * 1.5) {
        const c = b.dye[Math.floor(Math.random() * b.dye.length)];
        this.fx.sparks.spawn(p.x + (Math.random() - 0.5) * r, Y + 0.01, p.z + (Math.random() - 0.5) * r,
          (Math.random() - 0.5) * 0.015, 0.03 + Math.random() * 0.04, (Math.random() - 0.5) * 0.015,
          { color: [0.55 + c.r * 0.15, 0.48 + c.g * 0.15, 0.36 + c.b * 0.15], size: 0.003 + Math.random() * 0.003, life: 2 + Math.random() * 2.5, kind: 2 });
      }
      if (this.light) { this.light.color.lerp(b.avg, 0.05); }
      if (b.prog >= 1) { this._remove(b); this.list.splice(i, 1); }
    }
    if (this.light) {
      const a = this.fx.state.magicAmt;
      this.light.intensity = 0.04 + 0.22 * a * (0.85 + 0.15 * Math.sin(this.time * 7));
      if (a < 0.05) this.light.color.lerp(_c.set(1, 0.8, 0.5), 0.02);
    }
    if (!this.list.some((b) => b.state === 'float')) this.fx.setBomb(null);
    this.audio?.update(this.fizz, this.time);
  }

  _splash(b) {
    const sim = this.sim, fx = this.fx, m = b.mesh, Y = fx.surfaceY;
    // 물 안으로 끌어들임
    const lim = sim.radius - BOMB.radius - 0.03, dx = m.position.x - sim.center.x, dz = m.position.z - sim.center.z, d = Math.hypot(dx, dz);
    if (d > lim) { m.position.x = sim.center.x + dx / d * lim; m.position.z = sim.center.z + dz / d * lim; }
    m.position.z = Math.max(m.position.z, sim.wallZ + BOMB.radius + 0.03);
    const speed = Math.min(4, Math.abs(b.vel.y) + 0.5);
    b.state = 'float'; b.t = 0; b.vel.set(b.vel.x * 0.25, -speed * 0.15, b.vel.z * 0.25);
    const u = sim.toUv(m.position.x, m.position.z, _u), ru = sim.len(BOMB.radius);
    sim.addWave(u.x, u.y, ru * 1.6, -0.05 * Math.min(1.5, speed / 2));
    sim.addSwirl(u.x, u.y, ru * 3, 0.18, 0);
    const c = b.dye[0]; sim.addDye(u.x, u.y, ru * 1.6, c.r * 0.5, c.g * 0.5, c.b * 0.5, 0.5);
    for (let k = 0; k < 22; k++) {
      const a = Math.random() * Math.PI * 2, s = 0.25 + Math.random() * 0.55 * Math.min(1.5, speed / 2);
      fx.bubbles.spawn(m.position.x + Math.cos(a) * 0.02, Y + 0.01, m.position.z + Math.sin(a) * 0.02,
        Math.cos(a) * s * 0.45, 0.6 + Math.random() * 0.9 * Math.min(1.5, speed / 2), Math.sin(a) * s * 0.45,
        { color: [0.8, 0.95, 1], size: 0.004 + Math.random() * 0.005, life: 1.2, kind: 1, grav: 9.8, floorY: Y - 0.005 });
    }
    fx.pulseMagic(b.avg, 1);
    this.audio?.plop(Math.min(1, speed / 2.5));
    this.onHaptic?.(0.6, 60);
  }
}
const _c = new THREE.Color(), _c2 = new THREE.Color();
