/**
 * WrappingPaperRack — 포장지 롤 랙 인터랙션 모듈 (three.js / WebXR)
 *
 * 엔진 독립 API (손/가위는 아무 Object3D 나 넘기면 됨):
 *   const rack = new WrappingPaperRack(config, { renderer });
 *   await rack.load();                 // GLB + 패턴 텍스처 로드
 *   scene.add(rack.root);
 *   rack.update(dt);                   // 매 프레임
 *   rack.grab(handObj)  -> boolean     // 종이 끝 또는 자른 종이 잡기
 *   rack.release(handObj)              // 놓기 (자른 종이는 바닥으로 떨어지고, 자르지 않은 종이는 롤로 말려 들어감)
 *   rack.setScissors(tipObj | null)    // 가위 날 끝 위치 (종이 가까이 가져가면 자를 위치가 정해짐)
 *   rack.snip()                        // 가위질 1번. snipsToCut(기본 3)번 채우면 그 위치에서 잘림
 *   rack.tryCut()                      // 즉시 자르기
 *   rack.flipPiece(piece)              // 바닥의 자른 종이 뒤집기 (들고 있을 땐 손목을 돌리면 됨)
 *   rack.setPattern(i, {image, tileWidth, offsetU, backColor})
 *   rack.setPaperWidth(i, meters)
 *   rack.addEventListener('cut', e => e.roll, e.length, e.piece)
 *
 * 좌표: 모델(rack.root) 로컬 기준. 앞쪽 = +Z, 위 = +Y, 롤 축 = X. 단위 m.
 * 종이 무늬 좌표: m = 롤에서 풀려 나온 누적 길이(feed) 기준이라
 *   당기면 무늬가 종이와 같이 흘러나오고, 자른 조각/남은 종이 모두 무늬가 이어진다.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const DEFAULT_CONFIG = {
  model: 'models/PaperRollRack.glb',
  surfaceY: 0,                  // 자른 종이가 내려앉는 가상 바닥 높이 (랙 로컬, 0 = 랙 바닥면)
  rolls: [
    { name: 'Roll_01', image: 'textures/T_GiftWrap_Trees.jpg',      tileWidth: 0.1257, paperWidth: 0.305, offsetU: 0, backColor: '#f3f0e8' },
    { name: 'Roll_02', image: 'textures/T_GiftWrap_Gingerbread.jpg', tileWidth: 0.2513, paperWidth: 0.381, offsetU: 0, backColor: '#f3f0e8' },
    { name: 'Roll_03', image: 'textures/T_GiftWrap_Stripes.jpg',     tileWidth: 0.10,   paperWidth: 0.457, offsetU: 0, backColor: '#f3f0e8' },
  ],
  interaction: {
    maxPull: 1.5,               // 최대로 뽑을 수 있는 길이 (m)
    startLip: 0.025,            // 커터 아래로 나와 있는 기본 길이
    grabRadius: 0.07,           // 종이 끝/조각을 잡을 수 있는 거리
    guideDistance: 0.06,        // 가위(날 끝)가 종이에서 이 거리 안이면 '자를 수 있는 위치'
    contactDistance: 0.008,     // cutMode 'contact' 일 때만: 이 거리 안이면 바로 자름
    cutMode: 'snip',            // 'snip' = 가위질(snip) 횟수를 채우면 자름, 'contact' = 닿으면 자름, 'trigger' = tryCut()
    snipsToCut: 3,              // 자르기에 필요한 가위질 횟수
    snipWindow: 2.0,            // 가위질 사이 최대 간격 (초). 넘으면 처음부터
    showGuide: false,           // 절취선(점선) 표시
    cutCooldown: 0.4,
    minPieceLength: 0.02,
    maxPieces: 20,              // 바닥에 남길 최대 조각 수 (오래된 것부터 제거)
    fallSpeed: 0.7,             // 종이 낙하 최대 속도 (m/s, 종이라 천천히)
    retractOnRelease: true,     // 자르지 않고 놓으면 롤로 다시 말려 들어감
    retractSpeed: 1.6,          // 말려 들어가는 최대 속도 (m/s)
    scissorsHand: 'right',      // xr-input.js 에서 사용
  },
};

const TAU = Math.PI * 2;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m2q = new THREE.Quaternion();

export function mergeConfig(user = {}) {
  const base = structuredClone(DEFAULT_CONFIG);
  const out = { ...base, ...user, interaction: { ...base.interaction, ...(user.interaction || {}) } };
  out.rolls = (user.rolls || base.rolls).map((r, i) => ({ ...(base.rolls[i] || {}), ...r }));
  return out;
}

/* ------------------------------------------------------------------ materials */
const WHITE_TEX = (() => {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; return t;
})();

/** mode 'roll' : 롤 표면 (롤 컨트롤 좌표에서 각도로 무늬 계산, 회전과 무관하게 접점에서 시트와 이어짐)
 *  mode 'strip': 롤에서 나온 종이 띠 (꺾임 가능, aArc = 접점에서부터의 길이, m = uM0 - aArc)
 *  mode 'piece': 자른 조각 (휘어져도 무늬가 종이에 붙어 있도록 uv 기준, uYOff = 종이 폭) */
function createPaperMaterial(mode) {
  const uniforms = {
    uTu: { value: 0.25 }, uTv: { value: 0.25 }, uOffU: { value: 0 },
    uR: { value: 0.04 }, uFeed: { value: 0 }, uT0: { value: 0 }, uWorldToCtrl: { value: new THREE.Matrix4() },
    uM0: { value: 0 }, uLen: { value: 0 }, uYOff: { value: 0 },
    uBack: { value: new THREE.Color('#f3f0e8') },
  };
  const mat = new THREE.MeshStandardMaterial({
    map: WHITE_TEX, roughness: 0.62, metalness: 0,
    side: mode === 'roll' ? THREE.FrontSide : THREE.DoubleSide,
  });
  mat.name = `WrappingPaper_${mode}`;
  mat.userData.uniforms = uniforms;
  mat.customProgramCacheKey = () => `wrapping-paper-${mode}`;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    const decl = `
      uniform float uTu; uniform float uTv; uniform float uOffU; uniform float uR; uniform float uFeed; uniform float uT0;
      uniform mat4 uWorldToCtrl; uniform float uM0; uniform float uLen; uniform float uYOff; uniform vec3 uBack;
      varying vec3 vCP; varying vec2 vPat;`;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${decl}\n${mode === 'strip' ? 'attribute float aArc;' : ''}`)
      .replace('#include <begin_vertex>', mode === 'roll'
        ? `#include <begin_vertex>\n vCP = (uWorldToCtrl * modelMatrix * vec4(transformed, 1.0)).xyz; vPat = vec2(0.0);`
        : mode === 'strip'
        ? `#include <begin_vertex>\n vCP = vec3(0.0); vPat = vec2(position.x / uTu + uOffU, (uM0 - aArc) / uTv);`
        : mode === 'piece'
        ? `#include <begin_vertex>\n vCP = vec3(0.0); vPat = vec2((uv.x - 0.5) * uYOff / uTu + uOffU, (uM0 - (1.0 - uv.y) * uLen) / uTv);`
        : `#include <begin_vertex>\n vCP = vec3(0.0);
           float mPos = uM0 + (position.y + uYOff) * uLen;
           vPat = vec2(position.x / uTu + uOffU, mPos / uTv);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${decl}`)
      .replace('#include <map_fragment>', mode === 'roll'
        ? `{
            float a = atan(vCP.y, vCP.z) - uT0;           // 0 = 종이가 롤을 떠나는 접점, 위쪽으로 +
            a = mod(a + 3.14159265359, 6.28318530718) - 3.14159265359;
            float phi = a < 0.0 ? a + 6.28318530718 : a;   // [0, 2pi)  이음새는 정면 = 시트 뒤
            vec2 uv  = vec2(vCP.x / uTu + uOffU, (uFeed + phi * uR) / uTv);
            vec2 uv2 = vec2(uv.x, (uFeed + a * uR) / uTv);  // 정면에서 연속 → 밉맵 이음새 방지용 미분
            vec2 dx = dFdx(uv), dy = dFdy(uv), dx2 = dFdx(uv2), dy2 = dFdy(uv2);
            if (dot(dx2, dx2) + dot(dy2, dy2) < dot(dx, dx) + dot(dy, dy)) { dx = dx2; dy = dy2; }
            diffuseColor *= textureGrad(map, uv, dx, dy);
          }`
        : `diffuseColor *= gl_FrontFacing ? texture2D(map, vPat) : vec4(uBack, 1.0);`);
  };
  return mat;
}

function makeCanvasTexture(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}


/* ------------------------------------------------------------------ 자른 종이 변형 (종이 질감)
 * 길이 방향 체인(행마다 하나의 방향각)으로 근사:
 *  - 말림: 롤에 감겨 있던 방향(무늬 면이 바깥)으로 살짝 둥글게 말리려는 성질
 *  - 처짐: 잡고 있으면 손에서 먼 쪽이 중력 방향으로 휨
 *  - 나풀거림: 먼 끝일수록 늦게 따라오고(지연) 손 움직임/낙하 때 흔들림
 *  - 바닥: 양 끝이 바닥에 닿고 가운데가 살짝 뜬 둥근 형태로 자리잡음 */
const PAPER = {
  curlHeld: 1 / 0.45,  curlFall: 1 / 0.35, curlRest: 1 / 2.2,   // 바닥: 떨어질 때의 말림에서 천천히 거의 평평하게 펴짐   // 말림 곡률 (1/반지름 m)
  droop: 0.11,          // 행마다 중력 쪽으로 휘는 정도
  follow: 16,           // 손 가까운 부분이 따라오는 속도 (멀수록 느려져 나풀거림)
  flutter: 0.05,        // 나풀거림 각도 (rad, 끝으로 갈수록 커짐)
};

function makePieceGeometry(W, L) {
  const cols = 4, rows = THREE.MathUtils.clamp(Math.round(L / 0.012), 8, 64);
  const g = new THREE.BufferGeometry();
  const nV = (rows + 1) * (cols + 1);
  const pos = new Float32Array(nV * 3), uv = new Float32Array(nV * 2), idx = [];
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
    const i = r * (cols + 1) + c;
    pos[i * 3] = (c / cols - 0.5) * W; pos[i * 3 + 1] = L / 2 - (r / rows) * L;
    uv[i * 2] = c / cols; uv[i * 2 + 1] = 1 - r / rows;
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const a = r * (cols + 1) + c, b = a + cols + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  g.userData = { cols, rows };
  return g;
}

function initPieceSim(pc) {
  const { rows, cols } = pc.mesh.geometry.userData;
  const psi = new Float32Array(rows);
  pc.sim = { rows, cols, h: pc.length / rows, psi, anchor: Math.floor(rows / 2), t: 0, fallT: 0,
             phase: Math.random() * 6.28, excite: 0.6, hand: null, prevHand: new THREE.Vector3(), settle: 0, inited: false };
}

const _gl = new THREE.Vector3(), _wq = new THREE.Quaternion(), _hp = new THREE.Vector3();
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** 잡는 위치(앵커 행)를 바꿀 때 체인 방향 기준이 뒤집히는 세그먼트를 보정 → 모양이 튀지 않음 */
function setAnchor(sm, a) {
  a = Math.max(0, Math.min(sm.rows, a));
  if (sm.inited && a !== sm.anchor) {
    for (let k = 0; k < sm.rows; k++) if ((k < sm.anchor) !== (k < a)) sm.psi[k] = wrapPi(sm.psi[k] + Math.PI);
  }
  sm.anchor = a;
}

function simulatePiece(pc, dt) {
  const sm = pc.sim, m = pc.mesh, { rows, cols, h } = sm;
  sm.t += dt;
  // 아래쪽 세그먼트 k(행 k→k+1)의 바깥 기본 방향 = -y (psi=pi), 위쪽 = +y (psi=0)
  if (!sm.inited) { for (let k = 0; k < rows; k++) sm.psi[k] = k >= sm.anchor ? Math.PI : 0; sm.inited = true; }

  // 국소 중력 방향 (y,z 평면 성분)
  m.getWorldQuaternion(_wq);
  _gl.set(0, -1, 0).applyQuaternion(_wq.invert());
  let gy = _gl.y, gz = _gl.z, gmag = Math.hypot(gy, gz);
  let curl = PAPER.curlHeld, grav = PAPER.droop, flut = 0, rest = false;

  if (pc.state === 'held') {
    if (sm.hand) {
      sm.hand.getWorldPosition(_hp);
      if (sm.prevHand && dt > 0) sm.excite = Math.max(sm.excite * Math.exp(-1.8 * dt), Math.min(1.2, _hp.distanceTo(sm.prevHand) / dt * 0.9));
      sm.prevHand = (sm.prevHand || new THREE.Vector3()).copy(_hp);
    } else sm.excite *= Math.exp(-1.8 * dt);
    flut = PAPER.flutter * (0.25 + sm.excite);
  } else if (pc.state === 'falling') {
    curl = PAPER.curlFall; grav = 0.05; gy = -gy; gz = -gz;   // 공기 저항: 양 끝이 위로 들림
    setAnchor(sm, Math.floor(rows / 2));
    flut = PAPER.flutter * 1.3;
  } else { // landing / rest : 바닥에 닿은 뒤 말림이 천천히 풀림
    sm.restT = (sm.restT || 0) + dt;
    curl = PAPER.curlFall + (PAPER.curlRest - PAPER.curlFall) * (1 - Math.exp(-1.8 * sm.restT));
    grav = 0; rest = true;
    setAnchor(sm, Math.floor(rows / 2));
    sm.settle = Math.max(0, sm.settle - dt * 1.5);
    flut = PAPER.flutter * 0.6 * sm.settle;
  }
  if (gmag < 0.12) grav = 0; else { gy /= gmag; gz /= gmag; }
  const psiG = Math.atan2(gz, gy);

  // 체인 각도: 앵커에서 바깥쪽으로
  const a = sm.anchor;
  const free = pc.state !== 'held';
  const step = (k, prevPsi, sideSign, j) => {
    // sideSign: 아래(-y) = +1 (psi 증가 = -z 쪽), 위(+y) = -1
    // 들고 있을 때: 앞 세그먼트를 따라가는 체인(먼 끝이 늦게 따라와 나풀거림)
    // 떨어질 때/바닥: 전체가 동시에 원래 말림 형태로 돌아감
    let target = free ? (sideSign > 0 ? Math.PI : 0) + sideSign * curl * h * (j + 0.5) : prevPsi + sideSign * curl * h;
    target += grav * gmag * wrapPi(psiG - target) * Math.min(1, h / 0.012);
    const rate = free ? (rest ? 9 : 4) : PAPER.follow / (1 + 0.12 * j);
    sm.psi[k] += wrapPi(target - sm.psi[k]) * (1 - Math.exp(-rate * Math.max(dt, 1 / 120)));
    return sm.psi[k];
  };
  let prev = Math.PI;
  for (let k = a, j = 0; k < rows; k++, j++) prev = step(k, prev, +1, j);
  prev = 0;
  for (let k = a - 1, j = 0; k >= 0; k--, j++) prev = step(k, prev, -1, j);

  // 위치 생성 (+ 나풀거림/비틀림)
  const P = m.geometry.attributes.position, W = pc.width;
  const ys = new Float32Array(rows + 1), zs = new Float32Array(rows + 1), tw = new Float32Array(rows + 1);
  ys[a] = pc.length / 2 - a * h; zs[a] = 0;
  const wave = (k, j) => flut * Math.pow(j, 1.15) * 0.12 * Math.sin(sm.t * 7.5 - j * 0.55 + sm.phase);
  for (let k = a, j = 1; k < rows; k++, j++) {
    const ps = sm.psi[k] + wave(k, j);
    ys[k + 1] = ys[k] + Math.cos(ps) * h; zs[k + 1] = zs[k] + Math.sin(ps) * h;
    tw[k + 1] = flut * j * 0.03 * Math.sin(sm.t * 5.1 + sm.phase * 2);
  }
  for (let k = a - 1, j = 1; k >= 0; k--, j++) {
    const ps = sm.psi[k] + wave(k, j);
    ys[k] = ys[k + 1] + Math.cos(ps) * h; zs[k] = zs[k + 1] + Math.sin(ps) * h;
    tw[k] = flut * j * 0.03 * Math.sin(sm.t * 5.1 + sm.phase * 2);
  }
  // 바닥에서는 가장 낮은 줄이 면 기준 0 이 되도록 — 갑자기 옮기지 않고 서서히
  { let mn = Infinity; for (const z of zs) mn = Math.min(mn, z);
    let mx = -Infinity; for (const z of zs) mx = Math.max(mx, z);
    const target = rest ? (sm.flipped ? -mx : -mn) : 0;
    sm.zShift = (sm.zShift ?? 0) + (target - (sm.zShift ?? 0)) * (1 - Math.exp(-5 * Math.max(dt, 1 / 120)));
    for (let r = 0; r <= rows; r++) zs[r] += sm.zShift; }
  if (pc.state === 'held' && m.parent === sm.hand) {
    // 잡은 지점(앵커 행)이 손 위치로 오도록 조각을 부드럽게 끌어옴
    _hp.set(sm.grabX || 0, ys[a], zs[a]).applyQuaternion(m.quaternion).multiply(m.scale);
    _gl.copy(_hp).negate();
    m.position.lerp(_gl, 1 - Math.exp(-14 * Math.max(dt, 1 / 120)));
  }
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
    const i = r * (cols + 1) + c, x = (c / cols - 0.5) * W;
    P.setXYZ(i, x, ys[r], zs[r] + (x / W) * tw[r] * W);
  }
  P.needsUpdate = true;
  m.geometry.computeVertexNormals();
}

/* ------------------------------------------------------------------ main class */
export class WrappingPaperRack extends THREE.EventDispatcher {
  constructor(config = {}, { renderer = null, baseUrl = '' } = {}) {
    super();
    this.config = mergeConfig(config);
    this.renderer = renderer;
    this.baseUrl = baseUrl;
    this.root = new THREE.Group();
    this.root.name = 'WrappingPaperRack';
    this.rolls = [];
    this.pieces = [];
    this.holds = new Map();          // hand Object3D -> { type: 'sheet', roll } | { type: 'piece', piece }
    this.scissors = null;
    this.guide = null;               // { roll, d, dist } 현재 절취선
    this._texCache = new Map();
    this._rackBox = new THREE.Box3();
    this._restCount = 0;
  }

  _url(u) { return /^(data:|blob:|https?:|\/)/.test(u) ? u : this.baseUrl + u; }

  async load(url = this.config.model) {
    const gltf = await new GLTFLoader().loadAsync(this._url(url));
    this.model = gltf.scene;
    this.root.add(this.model);
    this.root.updateMatrixWorld(true);

    // 랙 바닥 영역 (자른 종이가 랙 안쪽에 떨어지지 않게)
    const rootInv = _m.copy(this.root.matrixWorld).invert();
    this.model.traverse((o) => {
      if (o.isMesh && /^Frame_/.test(o.name)) {
        o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld));
        this._rackBox.union(b);
      }
    });

    const cfgRolls = this.config.rolls;
    const N = cfgRolls.length;
    cfgRolls.forEach((rc, i) => {
      const ctrl = this.model.getObjectByName(rc.name);
      if (!ctrl) { console.warn(`[WrappingPaperRack] ${rc.name} 를 GLB에서 찾지 못함`); return; }
      const ex = ctrl.userData || {};
      const R = ex.roll_radius ?? 0.04;
      const roll = {
        index: i, name: rc.name, ctrl, R,
        cutDist: ex.cut_distance ?? R + 0.015,
        width0: ex.paper_width ?? 0.3,
        width: ex.paper_width ?? 0.3,
        spin: this.model.getObjectByName(`${rc.name}_Spin`),
        paperNode: this.model.getObjectByName(`${rc.name}_Paper`),
        coreNode: this.model.getObjectByName(`${rc.name}_Core`),
        pull: 0, feed: 0, tilt: 0, tiltTarget: 0, prevZ: null, cooldown: 0,
        Tu: 0.25, Tv: 0.25, offU: 0, back: new THREE.Color('#f3f0e8'), texture: WHITE_TEX,
      };
      // 롤 표면 재질 교체
      roll.rollMat = createPaperMaterial('roll');
      roll.rollMat.userData.uniforms.uR.value = R;
      roll.paperNode?.traverse((m) => {
        if (m.isMesh && m.material?.name?.startsWith('PAT_')) m.material = roll.rollMat;
      });
      // 늘어진 종이: pivot(롤 정면 접점) → sheet (위쪽 끝 y=0, 아래로 1, scale.y = pull)
      roll.pivot = new THREE.Object3D();
      roll.pivot.name = `${rc.name}_SheetPivot`;
      roll.pivot.position.set(0, 0, 0);                 // 롤 축. 종이는 롤 표면을 감싸고 접선으로 나옴
      roll.Rs = R + 0.0012 + (N - 1 - i) * 0.002;       // 늘어진 종이 반지름 (위 롤 종이가 아래 롤 종이 앞을 지나가도록)
      ctrl.add(roll.pivot);
      roll.sheetMat = createPaperMaterial('strip');
      roll.sheet = new THREE.Mesh(this._makeStripGeometry(), roll.sheetMat);
      roll.sheet.frustumCulled = false;
      roll.outset = 0.0015 + (N - 1 - i) * 0.0015;   // 모서리/바닥에서 띄우는 거리 (롤끼리 겹침 방지)
      roll.sheet.name = `${rc.name}_Sheet`;
      roll.pivot.add(roll.sheet);
      this.rolls.push(roll);
      this._setWidth(roll, rc.paperWidth ?? roll.width0);
      this._resetRoll(roll);
    });

    this._computeEdges();
    this._buildGuide();
    await Promise.all(this.rolls.map((r) => this.setPattern(r.index, cfgRolls[r.index])));
    this.update(0);
    return this;
  }

  /* -------------------------------------------------- pattern / size */
  async _loadTexture(src) {
    if (src instanceof THREE.Texture) return src;
    const url = this._url(src);
    if (!this._texCache.has(url)) {
      this._texCache.set(url, new THREE.TextureLoader().loadAsync(url).then((t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = this.renderer?.capabilities.getMaxAnisotropy?.() ?? 4;
        return t;
      }));
    }
    return this._texCache.get(url);
  }

  /** opts: { image (url|dataURL|Texture), tileWidth (m, 이미지 1장 가로), offsetU (0~1), backColor } */
  async setPattern(i, opts = {}) {
    const r = this.rolls[i]; if (!r) return;
    const rc = this.config.rolls[i];
    Object.assign(rc, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined && !(v instanceof THREE.Texture))));
    if (opts.image) {
      r.texture = await this._loadTexture(opts.image);
      r.sheetMat.map = r.rollMat.map = r.texture;
      r.sheetMat.needsUpdate = r.rollMat.needsUpdate = true;
    }
    if (opts.tileWidth) r.Tu = opts.tileWidth;
    if (opts.offsetU !== undefined) r.offU = opts.offsetU;
    if (opts.backColor) r.back.set(opts.backColor);
    const img = r.texture.image;
    r.Tv = r.Tu * (img && img.width ? img.height / img.width : 1);
    for (const mat of [r.rollMat, r.sheetMat]) {
      const u = mat.userData.uniforms;
      u.uTu.value = r.Tu; u.uTv.value = r.Tv; u.uOffU.value = r.offU; u.uBack.value.copy(r.back);
    }
  }

  setPaperWidth(i, w) { const r = this.rolls[i]; if (r) { this.config.rolls[i].paperWidth = w; this._setWidth(r, w); } }

  _setWidth(r, w) {
    r.width = w;
    const s = w / r.width0;
    if (r.paperNode) r.paperNode.scale.x = s;
    if (r.coreNode) r.coreNode.scale.x = (w + 0.005) / (r.width0 + 0.005);
  }

  _resetRoll(r) {
    r.pull = r.cutDist + this.config.interaction.startLip;
    r.feed = r.pull; r.tilt = r.tiltTarget = r.tiltEdge ?? 0; r.retracting = false;
    if (r.edge) this._buildPath(r, false);
  }

  resetRolls() {
    for (const [hand, h] of this.holds) if (h.type === 'sheet') this.holds.delete(hand);
    this.rolls.forEach((r) => this._resetRoll(r));
  }

  clearPieces() {
    for (const p of [...this.pieces]) this._removePiece(p);
    this._restCount = 0;
  }

  /** 애니메이션/테스트용: i번 롤을 len 길이까지 뽑기 */
  pullTo(i, len) {
    const r = this.rolls[i]; if (!r) return;
    const L = THREE.MathUtils.clamp(len, 0, this.config.interaction.maxPull);
    if (L > r.pull) { r.feed += L - r.pull; r.pull = L; }
  }

  getSheetMeshes() { return this.rolls.map((r) => r.sheet); }
  getPieceMeshes() { return this.pieces.map((p) => p.mesh); }
  getState() {
    return {
      rolls: this.rolls.map((r) => ({ name: r.name, pull: r.pull, feed: r.feed, width: r.width, tileWidth: r.Tu })),
      pieces: this.pieces.map((p) => ({ roll: p.roll, length: p.length, state: p.state })),
      guide: this.guide && { roll: this.guide.roll.index, cutLength: this.guide.roll.pull - this.guide.d },
    };
  }

  /* -------------------------------------------------- input */
  grab(hand) {
    if (this.holds.has(hand)) return true;
    this.root.updateMatrixWorld(true);
    hand.updateWorldMatrix(true, false);
    const hp = hand.getWorldPosition(new THREE.Vector3());
    const gr = this.config.interaction.grabRadius;

    // 1) 늘어진 종이 아래쪽 끝
    let best = null, bestD = Infinity;
    for (const r of this.rolls) {
      if ([...this.holds.values()].some((h) => h.roll === r)) continue;
      const p = r.pivot.worldToLocal(_v.copy(hp));
      const end = r.path[r.path.length - 1];
      const dEdge = Math.hypot(p.y - end.y, p.z - end.z);
      const pr = this._project(r, p);
      if (Math.abs(p.x) <= r.width / 2 + 0.02 && Math.abs(pr.dist) < gr && pr.d > r.pull * 0.5 - 0.02 && dEdge < gr * 1.6) {
        if (dEdge < bestD) { bestD = dEdge; best = r; }
      }
    }
    if (best) { best.retracting = false; this.holds.set(hand, { type: 'sheet', roll: best }); return true; }

    // 2) 자른 종이 조각
    let bp = null; bestD = Infinity;
    for (const pc of this.pieces) {
      if (pc.state === 'held') continue;
      const p = pc.mesh.worldToLocal(_v.copy(hp));
      const W = pc.width, L = pc.length;
      if (Math.abs(p.x) <= W / 2 + 0.03 && Math.abs(p.y) <= L / 2 + 0.03 && Math.abs(p.z) < gr + 0.03 && Math.abs(p.z) < bestD) {
        bestD = Math.abs(p.z); bp = pc; bp._grabY = p.y;
      }
    }
    if (bp) {
      hand.attach(bp.mesh); bp.state = 'held'; bp.vel = 0; bp.sim.wasHeld = true;
      setAnchor(bp.sim, Math.round((bp.length / 2 - bp._grabY) / bp.sim.h));
      bp.sim.grabX = THREE.MathUtils.clamp(hand.worldToLocal(bp.mesh.getWorldPosition(new THREE.Vector3())).x * 0, -bp.width / 2, bp.width / 2);
      bp.sim.hand = hand; bp.sim.prevHand = null;
      this.holds.set(hand, { type: 'piece', piece: bp });
      return true;
    }
    return false;
  }

  release(hand) {
    const h = this.holds.get(hand); if (!h) return;
    this.holds.delete(hand);
    if (h.type === 'piece') this._drop(h.piece);
    if (h.type === 'sheet' && this.config.interaction.retractOnRelease) h.roll.retracting = true;
  }

  setScissors(tip) { this.scissors = tip; if (!tip) this._hideGuide(); }

  tryCut() {
    if (!this.guide) return null;
    return this.cut(this.guide.roll.index, this.guide.d);
  }

  /** 가위질 1번. 가위 날 끝이 늘어진 종이 가까이 있을 때만 셈.
   *  같은 자리에서 snipWindow 초 안에 snipsToCut 번 하면 그 위치에서 잘림 */
  snip() {
    const it = this.config.interaction, now = performance.now() / 1000, g = this.guide;
    if (!g) { this._snip = null; this.dispatchEvent({ type: 'snip', count: 0, needed: it.snipsToCut, near: false }); return null; }
    const sp = this._snip;
    if (!sp || sp.roll !== g.roll || Math.abs(sp.d - g.d) > 0.05 || now - sp.t > it.snipWindow) this._snip = { roll: g.roll, d: g.d, n: 0, t: now };
    const s = this._snip; s.n++; s.t = now; s.d = (s.d * (s.n - 1) + g.d) / s.n;
    this.dispatchEvent({ type: 'snip', count: s.n, needed: it.snipsToCut, near: true, roll: g.roll.index });
    if (s.n >= it.snipsToCut) { this._snip = null; return this.cut(g.roll.index, s.d); }
    return null;
  }

  /** 바닥(또는 떨어지는 중)의 자른 종이를 뒤집음: 살짝 들렸다가 반대 면으로 내려앉음 */
  flipPiece(pc) {
    if (!pc || pc.state === 'held') return;
    pc.sim.flipped = !pc.sim.flipped;
    pc.target = this._flatTarget(pc.yaw ?? 0, pc.sim.flipped);
    pc.mesh.position.y += Math.min(0.12, pc.length * 0.35);
    pc.state = 'falling'; pc.vel = 0.6; pc.sim.fallT = 0.6; pc.sim.restT = 0;
  }

  /** 수평으로 눕힌 자세. flipped = 뒷면이 위 */
  _flatTarget(yaw, flipped) {
    return new THREE.Quaternion().setFromEuler(_e.set(0, yaw + (flipped ? Math.PI : 0), 0))
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(flipped ? Math.PI / 2 : -Math.PI / 2, 0, 0)));
  }

  /** 월드 좌표에서 가장 가까운 자른 종이 */
  pieceNear(worldPos, maxDist = 0.1) {
    let best = null, bd = maxDist;
    for (const pc of this.pieces) {
      const p = pc.mesh.worldToLocal(_v.copy(worldPos));
      const dx = Math.max(0, Math.abs(p.x) - pc.width / 2), dy = Math.max(0, Math.abs(p.y) - pc.length / 2);
      const d = Math.hypot(dx, dy, p.z);
      if (d < bd) { bd = d; best = pc; }
    }
    return best;
  }

  /** i번 롤을 접점에서 d 만큼 아래 지점에서 자름. 아래쪽 조각이 떨어져 나옴 */
  cut(i, d) {
    const r = this.rolls[i]; const it = this.config.interaction;
    if (!r) return null;
    d = Math.max(d, r.cutDist);
    const L = r.pull - d;
    if (L < it.minPieceLength) return null;

    const mat = createPaperMaterial('piece');
    mat.map = r.texture;
    const u = mat.userData.uniforms;
    u.uTu.value = r.Tu; u.uTv.value = r.Tv; u.uOffU.value = r.offU; u.uBack.value.copy(r.back);
    u.uM0.value = r.feed - d; u.uLen.value = L; u.uYOff.value = r.width;
    const mesh = new THREE.Mesh(makePieceGeometry(r.width, L), mat);
    mesh.frustumCulled = false;
    mesh.name = `${r.name}_CutPiece`;
    const at = this._pointAt(r, d);                 // 자른 지점과 그 구간의 방향
    mesh.position.set(0, at.y - Math.cos(at.theta) * L / 2, at.z + Math.sin(at.theta) * L / 2);
    mesh.rotation.x = -at.theta;
    r.pivot.add(mesh);
    this.root.updateMatrixWorld(true);
    const piece = { mesh, roll: i, width: r.width, length: L, state: 'falling', vel: 0, target: null, sim: null };
    initPieceSim(piece);
    this.pieces.push(piece);

    // 종이를 잡고 있던 손이 있으면 조각을 그대로 들고 있게
    let holder = null;
    for (const [hand, h] of this.holds) if (h.type === 'sheet' && h.roll === r) holder = hand;
    if (holder) {
      holder.attach(mesh); piece.state = 'held'; piece.sim.wasHeld = true;
      setAnchor(piece.sim, piece.sim.rows);   // 종이 아래 끝을 잡고 있었음
      piece.sim.grabX = 0;
      piece.sim.hand = holder; piece.sim.prevHand = null;
      this.holds.set(holder, { type: 'piece', piece });
    } else {
      this._drop(piece);
    }
    r.pull = d;                          // feed 는 그대로 → 다음 종이 무늬가 이어짐
    r.tiltTarget = r.tiltEdge;
    this._buildPath(r, false);
    r.cooldown = it.cutCooldown;
    this._trimPieces();
    this.dispatchEvent({ type: 'cut', roll: i, length: L, piece: mesh });
    return piece;
  }

  _drop(pc) {
    this.root.attach(pc.mesh);
    pc.state = 'falling'; pc.vel = 0; pc.sim.fallT = 0; pc.sim.hand = null; pc.sim.restT = 0;
    // 눕는 방향: 조각의 길이 방향(-Y)을 수평으로 투영.
    // 놓는 순간 위를 향한 면이 그대로 위로 (손목을 돌려 뒤집어 놓으면 뒷면이 위)
    const dir = _v.set(0, -1, 0).applyQuaternion(pc.mesh.quaternion); dir.y = 0;
    if (dir.lengthSq() < 0.04) dir.set(0, 0, 1);
    const up = _v2.set(0, 0, 1).applyQuaternion(pc.mesh.quaternion).y;   // 무늬 면 법선의 위쪽 성분
    let faceUp = up;
    if (Math.abs(up) < 0.35 && this.viewer) {            // 거의 세워서 들고 있었으면: 내(카메라) 쪽을 보던 면이 위로
      const toEye = this.viewer.getWorldPosition(new THREE.Vector3()).sub(pc.mesh.getWorldPosition(new THREE.Vector3())).normalize();
      faceUp = _v2.set(0, 0, 1).applyQuaternion(pc.mesh.getWorldQuaternion(new THREE.Quaternion())).dot(toEye);
    }
    pc.sim.flipped = pc.sim.wasHeld ? faceUp < 0 : !!pc.sim.flipped;
    pc.sim.wasHeld = false;
    const yaw = Math.atan2(dir.x, dir.z);
    pc.yaw = yaw;
    pc.target = this._flatTarget(yaw, pc.sim.flipped);
  }

  _removePiece(pc) {
    pc.mesh.removeFromParent();
    pc.mesh.geometry.dispose(); pc.mesh.material.dispose();
    this.pieces.splice(this.pieces.indexOf(pc), 1);
    for (const [hand, h] of this.holds) if (h.piece === pc) this.holds.delete(hand);
  }

  _trimPieces() {
    const max = this.config.interaction.maxPieces;
    while (this.pieces.length > max) {
      const old = this.pieces.find((p) => p.state === 'rest') || this.pieces[0];
      this._removePiece(old);
    }
  }


  /* -------------------------------------------------- paper path (꺾이는 종이 띠) */
  _computeEdges() {
    // 랙 앞쪽 아래 모서리(바닥판/걸레받이 앞 윗모서리): 길게 뽑은 종이가 여기를 넘어 처진다
    const rootInv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    let ey = -Infinity, ez = -Infinity;
    for (const n of ['Frame_BottomShelf', 'Frame_KickRail']) {
      const o = this.model.getObjectByName(n); if (!o?.geometry) continue;
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld));
      ey = Math.max(ey, b.max.y); ez = Math.max(ez, b.max.z);
    }
    for (const r of this.rolls) {
      const pw = this.root.worldToLocal(r.pivot.getWorldPosition(new THREE.Vector3()));
      r.pivotRootY = pw.y;
      if (!isFinite(ey)) { r.edge = null; r.tiltEdge = 0; continue; }
      const e = r.pivot.worldToLocal(this.root.localToWorld(new THREE.Vector3(0, ey + r.outset, ez + r.outset)));
      r.edge = { y: e.y, z: e.z };
      const D = Math.hypot(e.y, e.z);
      r.tiltEdge = Math.max(0, Math.atan2(e.z, -e.y) - Math.asin(Math.min(1, r.Rs / D)));   // 롤 접선이 모서리를 스치는 각도
      this._resetRoll(r);
    }
  }

  /** r.path: 피벗(롤 접점) 로컬 (y,z) 꺾은선. s = 접점에서부터 종이 길이 */
  _buildPath(r, held) {
    const L = Math.max(r.pull, 1e-4), t = r.tilt, dy = -Math.cos(t), dz = Math.sin(t);
    const R = r.R, Rs = r.Rs;
    // 1) 롤 표면을 감싸는 부분: 롤 무늬와 정확히 같은 무늬라 이음새가 안 보임, 반지름은 접점까지 서서히 Rs 로
    const path = [], WRAP = 1.0, NA = 10;
    for (let k = 0; k < NA; k++) {
      const f = k / NA, b = t + WRAP * (1 - f), rad = R + 0.0005 + (Rs - R - 0.0005) * f * f;
      path.push({ y: rad * Math.sin(b), z: rad * Math.cos(b), s: -(b - t) * R });
    }
    const T = { y: Rs * Math.sin(t), z: Rs * Math.cos(t), s: 0 };   // 접점
    path.push(T);
    const e = r.edge;
    const straight = (len) => path.push({ y: T.y + dy * len, z: T.z + dz * len, s: len });
    if (held || !e) { straight(L); r.path = path; return; }
    const surfY = this.config.surfaceY - r.pivotRootY + r.outset;
    const ct = Math.cos(t), l1 = ct > 0.01 ? (T.y - e.y) / ct : Infinity;   // 앞 아래 모서리 높이까지
    if (L <= l1) {                                   // 공중에 늘어진 상태: 끝이 살짝 앞으로 말림
      straight(L); this._curlEnd(path, Math.min(0.06, L * 0.35), 0.22);
      r.path = path; return;
    }
    const p1 = { y: e.y, z: Math.max(T.z + dz * l1, e.z), s: l1 };
    path.push(p1);
    const l2 = Math.max(0, e.y - surfY);             // 모서리 → 바닥 (앞면 따라 아래로)
    if (L - l1 <= l2) { path.push({ y: e.y - (L - l1), z: p1.z, s: L }); this._curlEnd(path, Math.min(0.05, (L - l1) * 0.4), 0.22); r.path = path; return; }
    path.push({ y: surfY, z: p1.z, s: l1 + l2 });
    path.push({ y: surfY, z: p1.z + (L - l1 - l2), s: L });   // 바닥 위로 눕기
    this._curlEnd(path, Math.min(0.05, (L - l1 - l2) * 0.5), 0.12);   // 끝이 살짝 들림
    r.path = path;
  }

  /** 경로 끝 len 구간을 반지름 rc 로 앞/위쪽으로 휘게 함 (늘어진 끝은 앞으로, 바닥의 끝은 위로 들림) */
  _curlEnd(path, len, rc) {
    if (len < 0.005) return;
    const E = path.pop(), P = path[path.length - 1];
    const segLen = E.s - P.s; len = Math.min(len, segLen * 0.9);
    const th = Math.atan2(E.z - P.z, -(E.y - P.y));
    const f = (segLen - len) / segLen;
    let y = P.y + (E.y - P.y) * f, z = P.z + (E.z - P.z) * f, s0 = P.s + segLen * f;
    path.push({ y, z, s: s0 });
    const NC = 6, ds = len / NC;
    for (let k = 1; k <= NC; k++) {
      const thk = th + (k - 0.5) * ds / rc;          // 진행 방향을 앞/위쪽으로 점점 꺾음
      y += -Math.cos(thk) * ds; z += Math.sin(thk) * ds;
      path.push({ y, z, s: s0 + k * ds });
    }
  }


  _makeStripGeometry() {
    const g = new THREE.BufferGeometry(), MAX = 40;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(MAX * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aArc', new THREE.BufferAttribute(new Float32Array(MAX * 2), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(MAX * 2 * 2), 2));
    const idx = [];
    for (let k = 0; k < MAX - 1; k++) { const a = k * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    g.setIndex(idx);
    return g;
  }

  _writeStrip(r) {
    const g = r.sheet.geometry, P = g.attributes.position, Nn = g.attributes.normal, A = g.attributes.aArc;
    const pts = r.path, hw = r.width / 2;
    for (let k = 0; k < pts.length; k++) {
      // 꼭짓점 법선 = 인접 구간 법선 평균 (구간 방향 (vy,vz) → 바깥 법선 (vz,-vy))
      let ny = 0, nz = 0;
      for (const [a, b] of [[k - 1, k], [k, k + 1]]) {
        if (a < 0 || b >= pts.length) continue;
        const vy = pts[b].y - pts[a].y, vz = pts[b].z - pts[a].z, l = Math.hypot(vy, vz) || 1;
        ny += vz / l; nz += -vy / l;
      }
      const nl = Math.hypot(ny, nz) || 1;
      for (let side = 0; side < 2; side++) {
        const vi = k * 2 + side;
        P.setXYZ(vi, side ? hw : -hw, pts[k].y, pts[k].z);
        Nn.setXYZ(vi, 0, ny / nl, nz / nl);
        A.setX(vi, pts[k].s);
      }
    }
    g.setDrawRange(0, (pts.length - 1) * 6);
    P.needsUpdate = Nn.needsUpdate = A.needsUpdate = true;
    g.computeBoundingSphere();
  }

  /** 피벗 로컬 점 p 를 종이 띠에 투영 → { d: 접점에서부터 길이, dist: 앞(+)/뒤(-) 거리, onSeg } */
  _project(r, p) {
    let best = null;
    const pts = r.path;
    for (let k = 0; k < pts.length - 1; k++) {
      const A = pts[k], B = pts[k + 1];
      const vy = B.y - A.y, vz = B.z - A.z, l2 = vy * vy + vz * vz; if (l2 < 1e-10) continue;
      const tRaw = ((p.y - A.y) * vy + (p.z - A.z) * vz) / l2, t = Math.min(1, Math.max(0, tRaw));
      const qy = A.y + vy * t, qz = A.z + vz * t, l = Math.sqrt(l2);
      const dist = ((p.y - qy) * vz + (p.z - qz) * -vy) / l;
      const off = Math.hypot(p.y - qy, p.z - qz);
      if (!best || off < best.off) best = { d: A.s + t * l, dist, off, onSeg: tRaw >= -0.02 / l && tRaw <= 1 + 0.02 / l };
    }
    return best || { d: 0, dist: Infinity, off: Infinity, onSeg: false };
  }

  /** 종이 길이 d 지점의 위치와 그 구간 기울기 theta (0 = 수직 아래, +면 앞으로) */
  _pointAt(r, d) {
    const pts = r.path;
    for (let k = 0; k < pts.length - 1; k++) {
      const A = pts[k], B = pts[k + 1];
      if (d <= B.s || k === pts.length - 2) {
        const t = (d - A.s) / ((B.s - A.s) || 1);
        return { y: A.y + (B.y - A.y) * t, z: A.z + (B.z - A.z) * t, theta: Math.atan2(B.z - A.z, -(B.y - A.y)) };
      }
    }
    return { y: 0, z: 0, theta: 0 };
  }

  /* -------------------------------------------------- guide (절취선) */
  _buildGuide() {
    const dash = makeCanvasTexture(64, 8, (g, w, h) => {
      g.clearRect(0, 0, w, h); g.fillStyle = '#ff2d2d'; g.fillRect(0, 0, w * 0.6, h);
    });
    dash.wrapS = THREE.RepeatWrapping;
    this._dashTex = dash;
    const mat = new THREE.MeshBasicMaterial({
      map: dash, transparent: true, side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, toneMapped: false,
    });
    const g = new THREE.Group(); g.name = 'CutGuide';
    const front = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.004), mat); front.position.z = 0.0015;
    const back = front.clone(); back.position.z = -0.0015;
    g.add(front, back);
    this._labelCanvas = document.createElement('canvas'); this._labelCanvas.width = 256; this._labelCanvas.height = 72;
    this._labelTex = new THREE.CanvasTexture(this._labelCanvas); this._labelTex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._labelTex, depthTest: false, toneMapped: false }));
    label.scale.set(0.085, 0.024, 1); label.renderOrder = 10;
    g.add(label);
    g.userData = { front, back, label, text: '' };
    g.visible = false;
    this._guideObj = g;
  }

  _showGuide(r, d, ready) {
    const g = this._guideObj;
    if (g.parent !== r.pivot) r.pivot.add(g);
    const W = r.width + 0.02;
    const at = this._pointAt(r, d);
    g.position.set(0, at.y, at.z);
    g.rotation.x = -at.theta;
    g.userData.front.scale.x = g.userData.back.scale.x = W;
    this._dashTex.repeat.x = W / 0.012;
    g.userData.label.position.set(r.width / 2 + 0.055, 0, 0.01);
    const text = `✂ ${((r.pull - d) * 100).toFixed(1)} cm`;
    if (text !== g.userData.text || ready !== g.userData.ready) {
      g.userData.text = text; g.userData.ready = ready;
      const c = this._labelCanvas, x = c.getContext('2d');
      x.clearRect(0, 0, c.width, c.height);
      x.fillStyle = ready ? 'rgba(200,20,20,0.92)' : 'rgba(20,20,20,0.78)';
      x.beginPath(); x.roundRect(2, 2, c.width - 4, c.height - 4, 16); x.fill();
      x.fillStyle = '#fff'; x.font = 'bold 40px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(text, c.width / 2, c.height / 2 + 2);
      this._labelTex.needsUpdate = true;
    }
    g.visible = true;
  }

  _hideGuide() { if (this._guideObj) this._guideObj.visible = false; this.guide = null; }

  /* -------------------------------------------------- per frame */
  update(dt = 1 / 60) {
    dt = Math.min(dt, 0.05);
    const it = this.config.interaction;
    this.root.updateMatrixWorld(true);

    // 종이 당기기
    for (const [hand, h] of this.holds) {
      if (h.type !== 'sheet') continue;
      const r = h.roll;
      hand.updateWorldMatrix(true, false);
      const p = r.ctrl.worldToLocal(hand.getWorldPosition(_v)).sub(r.pivot.position);
      const D = Math.max(Math.hypot(p.y, p.z), r.Rs + 1e-4);
      const dist = Math.sqrt(D * D - r.Rs * r.Rs);       // 접점 → 손 (종이가 롤에서 접선으로 나옴)
      const newPull = Math.min(it.maxPull, Math.max(r.pull, dist));
      r.feed += newPull - r.pull; r.pull = newPull;
      r.tiltTarget = THREE.MathUtils.clamp(Math.atan2(p.z, -p.y) - Math.asin(r.Rs / D), r.tiltEdge, 2.5);
    }

    for (const r of this.rolls) {
      r.cooldown = Math.max(0, r.cooldown - dt);
      const held = [...this.holds.values()].some((h) => h.roll === r);
      if (!held) r.tiltTarget = r.tiltEdge;
      if (r.retracting && !held) {
        // 되감기: 처음엔 빠르게, 끝에서는 부드럽게 멈춤. 롤도 거꾸로 돌고 무늬는 그대로 이어짐
        const rest = r.cutDist + it.startLip, extra = r.pull - rest;
        if (extra <= 0.0005) { r.retracting = false; }
        else {
          const step = Math.min(extra, Math.max(0.05, Math.min(it.retractSpeed, extra * 5)) * dt);
          r.pull -= step; r.feed -= step;
        }
      }
      r.tilt += (r.tiltTarget - r.tilt) * (1 - Math.exp(-(held ? 25 : 6) * dt));
      if (!held) r.tilt = Math.max(r.tilt, r.tiltEdge);
      this._buildPath(r, held);
      this._writeStrip(r);
      r.sheet.visible = r.pull > 0.001;
      if (r.spin) r.spin.rotation.x = r.feed / r.R;
      const su = r.sheetMat.userData.uniforms; su.uM0.value = r.feed; su.uLen.value = r.pull; su.uYOff.value = 0;
      const ru = r.rollMat.userData.uniforms; ru.uFeed.value = r.feed; ru.uT0.value = r.tilt;
      ru.uWorldToCtrl.value.copy(r.ctrl.matrixWorld).invert();
    }
    this.root.updateMatrixWorld(true);

    // 자른 종이 떨어지기 → 가상 바닥에 눕기
    for (const pc of this.pieces) {
      if (pc.state !== 'falling') continue;
      const m = pc.mesh, sm = pc.sim;
      sm.fallT += dt;
      pc.vel = Math.max(pc.vel - 9.8 * 0.3 * dt, -it.fallSpeed);
      m.position.y += pc.vel * dt;
      // 종이가 공기에 흔들리며 떨어짐: 좌우로 미끄러지고 살짝 기울어짐
      const sway = Math.min(1, sm.fallT * 2);
      m.position.x += Math.cos(sm.fallT * 2.6 + sm.phase) * 0.10 * sway * dt;
      m.position.z += Math.sin(sm.fallT * 2.1 + sm.phase * 1.7) * 0.07 * sway * dt;
      const wob = _q.setFromEuler(_e.set(Math.sin(sm.fallT * 3.3 + sm.phase) * 0.22 * sway, Math.sin(sm.fallT * 2.4 + sm.phase) * 0.15 * sway, Math.sin(sm.fallT * 2.9) * 0.25 * sway));
      m.quaternion.slerp(_m2q.copy(pc.target).multiply(wob), 1 - Math.exp(-3.5 * dt));
      // 종이의 가장 낮은 점이 바닥에 닿으면 그 자리에서 이어서 눕기 시작 (위치·각도 튀지 않음)
      pc.floor = this.config.surfaceY + 0.0004 + this._restCount * 0.0004;
      const low = this._lowestY(pc);
      if (low <= pc.floor) {
        m.position.y += pc.floor - low;
        pc.state = 'landing'; sm.landT = 0; sm.settle = 0.35; sm.restT = 0;
        this._restCount = (this._restCount + 1) % 60;
      }
    }

    // 바닥에 닿은 뒤: 남은 기울기를 부드럽게 눕히고, 가장 낮은 점이 계속 바닥에 붙어 있게
    for (const pc of this.pieces) {
      if (pc.state !== 'landing') continue;
      const m = pc.mesh, sm = pc.sim;
      sm.landT += dt;
      m.quaternion.slerp(pc.target, 1 - Math.exp(-4 * dt));
      const low = this._lowestY(pc);
      m.position.y += (pc.floor - low);
      const push = this._rackOverlap(pc);                        // 랙 바닥과 겹치면 앞으로 미끄러져 나옴
      if (push > 0) m.position.z += Math.min(push, 0.5 * dt);
      if (sm.landT > 0.8 && m.quaternion.angleTo(pc.target) < 0.01 && push <= 0) this._land(pc);
    }

    for (const pc of this.pieces) simulatePiece(pc, dt);

    // 가위 → 절취선 / 자르기
    this._updateScissors(it);
  }

  _land(pc) {
    pc.mesh.quaternion.copy(pc.target);
    pc.state = 'rest';
    this.dispatchEvent({ type: 'land', piece: pc.mesh });
  }

  /** 조각의 가장 낮은 정점 높이 (rack.root 로컬) */
  _lowestY(pc) {
    const m = pc.mesh; m.updateMatrix();
    const P = m.geometry.attributes.position, e = m.matrix.elements;
    let low = Infinity;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      low = Math.min(low, e[1] * x + e[5] * y + e[9] * z + e[13]);
    }
    return low;
  }

  /** 누운 조각이 랙 바닥 영역과 앞뒤로 얼마나 겹치는지 (m) */
  _rackOverlap(pc) {
    const m = pc.mesh, b = this._rackBox; if (b.isEmpty()) return 0;
    const hw = pc.width / 2, hl = pc.length / 2;
    const ax = _v.set(1, 0, 0).applyQuaternion(m.quaternion), ay = _v2.set(0, 1, 0).applyQuaternion(m.quaternion);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const x = m.position.x + ax.x * hw * sx + ay.x * hl * sy, z = m.position.z + ax.z * hw * sx + ay.z * hl * sy;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z);
    }
    return (maxX > b.min.x && minX < b.max.x) ? b.max.z + 0.01 - minZ : 0;
  }

  _updateScissors(it) {
    const tip = this.scissors;
    if (!tip) { this._hideGuide(); return; }
    tip.updateWorldMatrix(true, false);
    const tp = tip.getWorldPosition(_v2);
    let best = null;
    for (const r of this.rolls) {
      if (r.pull <= r.cutDist + it.minPieceLength) { r.prevZ = null; continue; }
      const p = r.pivot.worldToLocal(_v.copy(tp));
      const pr = this._project(r, p);
      let d = pr.d;
      const inside = pr.onSeg && Math.abs(p.x) <= r.width / 2 + 0.01 && d >= r.cutDist - 0.03 && d <= r.pull - it.minPieceLength;
      if (!inside) { r.prevZ = null; continue; }
      d = Math.max(d, r.cutDist);
      const crossed = r.prevZ !== null && Math.sign(r.prevZ) !== Math.sign(pr.dist) && Math.abs(r.prevZ - pr.dist) < 0.1;
      r.prevZ = pr.dist;
      const dist = Math.abs(pr.dist);
      if (dist < it.guideDistance && (!best || dist < best.dist)) best = { roll: r, d, dist, crossed };
    }
    if (!best) { this._hideGuide(); return; }
    const touching = best.dist <= it.contactDistance || best.crossed;
    this.guide = best;
    if (it.showGuide) this._showGuide(best.roll, best.d, touching);
    if (it.cutMode === 'contact' && touching && best.roll.cooldown <= 0) {
      this.cut(best.roll.index, best.d);
      this._hideGuide();
    }
  }
}
