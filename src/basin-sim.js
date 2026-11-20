/**
 * BasinSim — 수반 물의 GPU 시뮬레이션 (WebGL2, 반원 수면 전용)
 *
 *  1) 물결   : 높이 텍스처의 파동 방정식 (손·배스밤이 닿으면 동그랗게 퍼지고 벽에 부딪혀 되돌아옴)
 *  2) 흐름   : 2D 유체 (반-라그랑주 이류 + 소용돌이 강화 + 압력 투영) — 배스밤 색이 소용돌이치며 번지는 바탕
 *  3) 물감   : 흐름을 따라 옮겨지는 색 (rgb = 색 × 농도, a = 거품)
 *
 * 좌표: 시뮬레이션 uv 정사각형이 수반 원 (중심 c, 반지름 R) 을 덮음.
 *   u = (x - cx) / 2R + 0.5,  v = (z - cz) / 2R + 0.5   (월드 x, z)
 *   벽(뒤쪽, z 작은 쪽) 은 v < wallV 로 막힘.
 * 외부에서 주는 속도 단위는 uv/초 (내부에서 격자 칸/초로 바꿈).
 *
 * 유체 풀이 방식은 Pavel Dobryakov 의 WebGL-Fluid-Simulation (MIT) 과 같은 순서를 따름.
 */
import * as THREE from 'three';

export const SIM_QUALITY = {
  low:  { vel: 64,  dye: 128, wave: 96,  iters: 8 },
  mid:  { vel: 96,  dye: 192, wave: 128, iters: 12 },
  high: { vel: 128, dye: 320, wave: 192, iters: 18 },
};

const MAX_SPLATS = 8;

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COMMON = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uWallV;
float inside(vec2 uv) { vec2 p = uv * 2.0 - 1.0; return step(length(p), 0.992) * step(uWallV, uv.y); }`;

const SPLAT = COMMON + /* glsl */`
uniform sampler2D uSrc;
uniform int uN;
uniform vec4 uP[${MAX_SPLATS}];   // xy = uv, z = 반지름(uv), w = 0 더하기 / 1 방사+소용돌이
uniform vec4 uV[${MAX_SPLATS}];
uniform vec4 uMax;
void main() {
  vec4 c = texture2D(uSrc, vUv);
  for (int i = 0; i < ${MAX_SPLATS}; i++) {
    if (i >= uN) break;
    vec2 d = vUv - uP[i].xy;
    float g = exp(-dot(d, d) / (uP[i].z * uP[i].z));
    if (uP[i].w > 0.5) {
      vec2 dir = d / (length(d) + 1e-4);
      c.xy += (dir * uV[i].x + vec2(-dir.y, dir.x) * uV[i].y) * g;
    } else c += uV[i] * g;
  }
  gl_FragColor = clamp(c, -uMax, uMax) * inside(vUv);
}`;

const ADVECT = COMMON + /* glsl */`
uniform sampler2D uVel, uSrc;
uniform vec2 uVelTexel;
uniform float uDt; uniform vec4 uDiss;
void main() {
  vec2 coord = vUv - uDt * texture2D(uVel, vUv).xy * uVelTexel;
  gl_FragColor = texture2D(uSrc, coord) / (1.0 + uDiss * uDt) * inside(vUv);
}`;

const CURL = COMMON + /* glsl */`
uniform sampler2D uVel; uniform vec2 uT;
void main() {
  float L = texture2D(uVel, vUv - vec2(uT.x, 0.0)).y;
  float R = texture2D(uVel, vUv + vec2(uT.x, 0.0)).y;
  float T = texture2D(uVel, vUv + vec2(0.0, uT.y)).x;
  float B = texture2D(uVel, vUv - vec2(0.0, uT.y)).x;
  gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`;

const VORTICITY = COMMON + /* glsl */`
uniform sampler2D uVel, uCurl; uniform vec2 uT; uniform float uCurlK, uDt;
void main() {
  float L = texture2D(uCurl, vUv - vec2(uT.x, 0.0)).x;
  float R = texture2D(uCurl, vUv + vec2(uT.x, 0.0)).x;
  float T = texture2D(uCurl, vUv + vec2(0.0, uT.y)).x;
  float B = texture2D(uCurl, vUv - vec2(0.0, uT.y)).x;
  float C = texture2D(uCurl, vUv).x;
  vec2 f = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  f /= length(f) + 1e-4;
  f *= uCurlK * C; f.y *= -1.0;
  vec2 v = texture2D(uVel, vUv).xy + f * uDt;
  gl_FragColor = vec4(clamp(v, -1000.0, 1000.0) * inside(vUv), 0.0, 1.0);
}`;

const DIVERGENCE = COMMON + /* glsl */`
uniform sampler2D uVel; uniform vec2 uT;
void main() {
  vec2 C = texture2D(uVel, vUv).xy;
  vec2 l = vUv - vec2(uT.x, 0.0), r = vUv + vec2(uT.x, 0.0), t = vUv + vec2(0.0, uT.y), b = vUv - vec2(0.0, uT.y);
  float L = inside(l) > 0.5 ? texture2D(uVel, l).x : -C.x;
  float R = inside(r) > 0.5 ? texture2D(uVel, r).x : -C.x;
  float T = inside(t) > 0.5 ? texture2D(uVel, t).y : -C.y;
  float B = inside(b) > 0.5 ? texture2D(uVel, b).y : -C.y;
  gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;

const SCALE = COMMON + /* glsl */`
uniform sampler2D uSrc; uniform float uK;
void main() { gl_FragColor = texture2D(uSrc, vUv) * uK; }`;

const PRESSURE = COMMON + /* glsl */`
uniform sampler2D uP, uDiv; uniform vec2 uT;
void main() {
  float C = texture2D(uP, vUv).x;
  vec2 l = vUv - vec2(uT.x, 0.0), r = vUv + vec2(uT.x, 0.0), t = vUv + vec2(0.0, uT.y), b = vUv - vec2(0.0, uT.y);
  float L = inside(l) > 0.5 ? texture2D(uP, l).x : C;
  float R = inside(r) > 0.5 ? texture2D(uP, r).x : C;
  float T = inside(t) > 0.5 ? texture2D(uP, t).x : C;
  float B = inside(b) > 0.5 ? texture2D(uP, b).x : C;
  gl_FragColor = vec4((L + R + B + T - texture2D(uDiv, vUv).x) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADIENT = COMMON + /* glsl */`
uniform sampler2D uP, uVel; uniform vec2 uT;
void main() {
  float C = texture2D(uP, vUv).x;
  vec2 l = vUv - vec2(uT.x, 0.0), r = vUv + vec2(uT.x, 0.0), t = vUv + vec2(0.0, uT.y), b = vUv - vec2(0.0, uT.y);
  float L = inside(l) > 0.5 ? texture2D(uP, l).x : C;
  float R = inside(r) > 0.5 ? texture2D(uP, r).x : C;
  float T = inside(t) > 0.5 ? texture2D(uP, t).x : C;
  float B = inside(b) > 0.5 ? texture2D(uP, b).x : C;
  vec2 v = texture2D(uVel, vUv).xy - vec2(R - L, T - B);
  gl_FragColor = vec4(v * inside(vUv), 0.0, 1.0);
}`;

// 물결: r = 높이, g = 이전 높이. 벽(밖)과 맞닿은 칸은 자기 높이를 써서 반사
const WAVE = COMMON + /* glsl */`
uniform sampler2D uH; uniform vec2 uT; uniform float uK, uDamp;
void main() {
  vec4 c = texture2D(uH, vUv); float h = c.r;
  vec2 l = vUv - vec2(uT.x, 0.0), r = vUv + vec2(uT.x, 0.0), t = vUv + vec2(0.0, uT.y), b = vUv - vec2(0.0, uT.y);
  float L = inside(l) > 0.5 ? texture2D(uH, l).r : h;
  float R = inside(r) > 0.5 ? texture2D(uH, r).r : h;
  float T = inside(t) > 0.5 ? texture2D(uH, t).r : h;
  float B = inside(b) > 0.5 ? texture2D(uH, b).r : h;
  float nh = h + (h - c.g) * uDamp + uK * (L + R + T + B - 4.0 * h);
  nh *= 0.9995;
  gl_FragColor = vec4(nh, h, 0.0, 1.0) * inside(vUv);
}`;

function rt(size, filter = THREE.LinearFilter) {
  return new THREE.WebGLRenderTarget(size, size, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: filter, magFilter: filter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
}
class Double {
  constructor(size) { this.size = size; this.read = rt(size); this.write = rt(size); this.texel = new THREE.Vector2(1 / size, 1 / size); }
  swap() { const t = this.read; this.read = this.write; this.write = t; }
  dispose() { this.read.dispose(); this.write.dispose(); }
}

export class BasinSim {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{center: THREE.Vector3, radius: number, wallZ: number, quality?: string}} o
   */
  constructor(renderer, o) {
    this.renderer = renderer;
    this.center = o.center.clone(); this.radius = o.radius; this.wallZ = o.wallZ;
    this.params = {
      velDiss: 1.2,        // 흐름이 잦아드는 빠르기
      dyeDiss: 0.025,       // 물감이 옅어지는 빠르기 (작을수록 오래 남음)
      foamDiss: 0.75,        // 거품이 꺼지는 빠르기
      curl: 5,             // 소용돌이 강조
      waveK: 0.24,          // 물결 퍼지는 빠르기 (0.5 미만)
      waveDamp: 0.986,      // 물결 감쇠
    };
    this.wallV = (this.wallZ - this.center.z) / (2 * this.radius) + 0.5 + 0.004;
    this._queues = { vel: [], dye: [], wave: [] };

    this.scene = new THREE.Scene();
    this.cam = new THREE.Camera();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    const mk = (frag, uniforms) => new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false,
      uniforms: { uWallV: { value: this.wallV }, ...uniforms },
    });
    this.m = {
      splat: mk(SPLAT, { uSrc: { value: null }, uN: { value: 0 }, uP: { value: Array.from({ length: MAX_SPLATS }, () => new THREE.Vector4()) },
        uV: { value: Array.from({ length: MAX_SPLATS }, () => new THREE.Vector4()) }, uMax: { value: new THREE.Vector4() } }),
      advect: mk(ADVECT, { uVel: { value: null }, uSrc: { value: null }, uVelTexel: { value: new THREE.Vector2() }, uDt: { value: 0 }, uDiss: { value: new THREE.Vector4() } }),
      curl: mk(CURL, { uVel: { value: null }, uT: { value: new THREE.Vector2() } }),
      vort: mk(VORTICITY, { uVel: { value: null }, uCurl: { value: null }, uT: { value: new THREE.Vector2() }, uCurlK: { value: 0 }, uDt: { value: 0 } }),
      div: mk(DIVERGENCE, { uVel: { value: null }, uT: { value: new THREE.Vector2() } }),
      scale: mk(SCALE, { uSrc: { value: null }, uK: { value: 1 } }),
      press: mk(PRESSURE, { uP: { value: null }, uDiv: { value: null }, uT: { value: new THREE.Vector2() } }),
      grad: mk(GRADIENT, { uP: { value: null }, uVel: { value: null }, uT: { value: new THREE.Vector2() } }),
      wave: mk(WAVE, { uH: { value: null }, uT: { value: new THREE.Vector2() }, uK: { value: 0 }, uDamp: { value: 0 } }),
    };
    this.setQuality(o.quality ?? 'high');
  }

  setQuality(q) {
    this.quality = SIM_QUALITY[q] ? q : 'mid';
    const Q = SIM_QUALITY[this.quality];
    this.iters = Q.iters;
    for (const k of ['vel', 'dye', 'wave', 'press']) this[k]?.dispose();
    this.curlRT?.dispose(); this.divRT?.dispose();
    this.vel = new Double(Q.vel); this.press = new Double(Q.vel);
    this.dye = new Double(Q.dye); this.wave = new Double(Q.wave);
    this.curlRT = rt(Q.vel); this.divRT = rt(Q.vel);
    this.clear();
  }

  /** 물 비우기: 모든 장을 0 으로 */
  clear() {
    this._withGL(() => {
      const r = this.renderer; const cc = r.getClearColor(new THREE.Color()); const ca = r.getClearAlpha();
      r.setClearColor(0x000000, 0);
      for (const d of [this.vel, this.press, this.dye, this.wave]) for (const t of [d.read, d.write]) { r.setRenderTarget(t); r.clear(true, false, false); }
      for (const t of [this.curlRT, this.divRT]) { r.setRenderTarget(t); r.clear(true, false, false); }
      r.setClearColor(cc, ca);
    });
  }

  // ---------------------------------------------------------------- 좌표
  toUv(x, z, out = new THREE.Vector2()) {
    return out.set((x - this.center.x) / (2 * this.radius) + 0.5, (z - this.center.z) / (2 * this.radius) + 0.5);
  }
  /** 월드 x,z 가 수면 안인지 (margin m 만큼 안쪽) */
  isInside(x, z, margin = 0) {
    const dx = x - this.center.x, dz = z - this.center.z;
    return Math.hypot(dx, dz) < this.radius - margin && z > this.wallZ + margin;
  }
  /** m → uv 길이 */
  len(m) { return m / (2 * this.radius); }

  // ---------------------------------------------------------------- 넣기 (uv 좌표 · uv/초)
  addVel(u, v, r, vx, vy) { this._queues.vel.push([u, v, r, 0, vx * this.vel.size, vy * this.vel.size, 0, 0]); }
  addSwirl(u, v, r, outward, swirl) { this._queues.vel.push([u, v, r, 1, outward * this.vel.size, swirl * this.vel.size, 0, 0]); }
  addDye(u, v, r, cr, cg, cb, foam = 0) { this._queues.dye.push([u, v, r, 0, cr, cg, cb, foam]); }
  addWave(u, v, r, amp) { this._queues.wave.push([u, v, r, 0, amp, 0, 0, 0]); }

  // ---------------------------------------------------------------- 내부
  _withGL(fn) {
    const r = this.renderer;
    const xr = r.xr.enabled, prev = r.getRenderTarget(), auto = r.autoClear;
    r.xr.enabled = false; r.autoClear = false;
    fn();
    r.setRenderTarget(prev); r.xr.enabled = xr; r.autoClear = auto;
  }
  _run(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
  }
  _flush(queue, dbl, max) {
    const m = this.m.splat; m.uniforms.uMax.value.set(...max);
    while (queue.length) {
      const batch = queue.splice(0, MAX_SPLATS);
      batch.forEach((s, i) => { m.uniforms.uP.value[i].set(s[0], s[1], s[2], s[3]); m.uniforms.uV.value[i].set(s[4], s[5], s[6], s[7]); });
      m.uniforms.uN.value = batch.length;
      m.uniforms.uSrc.value = dbl.read.texture;
      this._run(m, dbl.write); dbl.swap();
    }
  }

  /** 한 프레임 진행 */
  step(dt) {
    dt = Math.min(Math.max(dt, 1 / 240), 1 / 30);
    const P = this.params, M = this.m, V = this.vel;
    this._withGL(() => {
      // 넣기
      this._flush(this._queues.vel, V, [1500, 1500, 0, 0]);
      this._flush(this._queues.dye, this.dye, [2.2, 2.2, 2.2, 1.0]);
      this._flush(this._queues.wave, this.wave, [0.2, 0.2, 0, 0]);

      // 물결 (프레임 속도와 상관없이 비슷한 빠르기)
      const W = this.wave, n = Math.min(3, Math.max(1, Math.round(dt * 120)));
      M.wave.uniforms.uT.value.copy(W.texel); M.wave.uniforms.uK.value = P.waveK; M.wave.uniforms.uDamp.value = P.waveDamp;
      for (let i = 0; i < n; i++) { M.wave.uniforms.uH.value = W.read.texture; this._run(M.wave, W.write); W.swap(); }

      // 흐름
      M.curl.uniforms.uVel.value = V.read.texture; M.curl.uniforms.uT.value.copy(V.texel); this._run(M.curl, this.curlRT);
      M.vort.uniforms.uVel.value = V.read.texture; M.vort.uniforms.uCurl.value = this.curlRT.texture;
      M.vort.uniforms.uT.value.copy(V.texel); M.vort.uniforms.uCurlK.value = P.curl; M.vort.uniforms.uDt.value = dt;
      this._run(M.vort, V.write); V.swap();
      M.div.uniforms.uVel.value = V.read.texture; M.div.uniforms.uT.value.copy(V.texel); this._run(M.div, this.divRT);
      M.scale.uniforms.uSrc.value = this.press.read.texture; M.scale.uniforms.uK.value = 0.8; this._run(M.scale, this.press.write); this.press.swap();
      M.press.uniforms.uDiv.value = this.divRT.texture; M.press.uniforms.uT.value.copy(V.texel);
      for (let i = 0; i < this.iters; i++) { M.press.uniforms.uP.value = this.press.read.texture; this._run(M.press, this.press.write); this.press.swap(); }
      M.grad.uniforms.uP.value = this.press.read.texture; M.grad.uniforms.uVel.value = V.read.texture; M.grad.uniforms.uT.value.copy(V.texel);
      this._run(M.grad, V.write); V.swap();
      const A = M.advect.uniforms;
      A.uVel.value = V.read.texture; A.uSrc.value = V.read.texture; A.uVelTexel.value.copy(V.texel); A.uDt.value = dt; A.uDiss.value.setScalar(P.velDiss);
      this._run(M.advect, V.write); V.swap();
      A.uVel.value = V.read.texture; A.uSrc.value = this.dye.read.texture; A.uDiss.value.set(P.dyeDiss, P.dyeDiss, P.dyeDiss, P.foamDiss);
      this._run(M.advect, this.dye.write); this.dye.swap();
    });
  }

  get dyeTexture() { return this.dye.read.texture; }
  get waveTexture() { return this.wave.read.texture; }
  get waveTexel() { return this.wave.texel; }

  dispose() {
    for (const k of ['vel', 'dye', 'wave', 'press']) this[k].dispose();
    this.curlRT.dispose(); this.divRT.dispose();
    Object.values(this.m).forEach((m) => m.dispose()); this.quad.geometry.dispose();
  }
}
