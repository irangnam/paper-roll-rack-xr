/**
 * AutoWrapFlow — 단순화한 포장 진행 (교수님 피드백 반영)
 *
 *   ① 롤 고르기   : 롤을 가리키고 집기(핀치·트리거) / 손가락으로 톡 / 클릭
 *                  → 종이가 저절로 풀려 나오고 잘림 → 테이블 포장 자리로 날아가 '착' 놓임
 *                  → 옆에 있던 배스밤이 폴짝 뛰어 종이 위에 올라감
 *   ② 감싸 모으기 : 두 손으로 배스밤을 감싸듯 모으기 (한 손이면 배스밤을 집고 있기 / PC 는 누르고 있기)
 *                  → 꼭짓점이 저절로 올라와 차킨 포장 완성 → '포장 완성!' 축하
 *   ③ 리본 고르기 : 상자가 저절로 열림 → 리본을 고르면 날아가 선물 목에 붙음 → '선물 완성!' 축하
 *   ④ 다시 하기 버튼
 * 바닥에 떨어지는 것 없음. 자르기 가위질·주먹 잡기 같은 손동작 없음.
 *
 *   const flow = new AutoWrapFlow({ rack, station, box, ribbons, fx, workspace, cfg: config.flow, getViewer });
 *   const input = bindSimpleInput({ renderer, scene, camera, controls, flow, fx });
 *   매 프레임: input.update(dt); flow.update(dt);   (rack.update 는 그대로)
 * 이벤트: 'state' { state } · 'feedback' { strength } (컨트롤러 진동용)
 */
import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

export const DEFAULT_FLOW = {
  mode: 'auto',            // 'auto' = 단순 진행(기본) · 'manual' = 예전 방식(직접 당기고 가위질)
  speed: 1,                // 자동 연출 속도 배율
  holdTime: 1.2,           // 한 손으로 집고 있을 때 포장 완성까지 걸리는 시간 (s)
  twoHandStart: 0.36,      // 두 손 사이가 이 거리(m)부터 모으기 시작
  twoHandEnd: 0.14,        // 이 거리까지 모으면 완성
  handRadius: 0.26,        // 손이 배스밤에서 이 거리 안에 있어야 '감싸는' 것으로 봄
  touchRadius: 0.025,      // 손가락 끝이 이 거리 안이면 '톡'
  guideText: true,         // 공중에 단계 안내 문구
  boxAutoOpen: true,       // 포장이 끝나면 리본 상자가 저절로 열림
};
export function mergeFlow(u) { return { ...DEFAULT_FLOW, ...(u || {}) }; }

const PAPER = 0.40;   // GiftWrap.glb 포장지 한 변
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

/* ------------------------------------------------------------------ 공중 안내판 (캔버스 → 평면, 항상 나를 봄) */
class Panel {
  constructor(w, h, px = 1024) {
    this.canvas = document.createElement('canvas'); this.canvas.width = px; this.canvas.height = Math.round(px * h / w);
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, toneMapped: false }));
    this.mesh.renderOrder = 25; this.key = '';
  }
  draw(key, fn) { if (key === this.key) return; this.key = key; const g = this.canvas.getContext('2d'); g.clearRect(0, 0, this.canvas.width, this.canvas.height); fn(g, this.canvas.width, this.canvas.height); this.tex.needsUpdate = true; }
}
const FONT = '"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif';

/* ------------------------------------------------------------------ 바닥 그림자 (종이·선물 아래 부드러운 그림자) */
function makeSoftShadow() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  g.filter = 'blur(14px)'; g.fillStyle = 'rgba(40,25,10,0.9)';
  g.beginPath(); g.roundRect(S * 0.16, S * 0.16, S * 0.68, S * 0.68, S * 0.04); g.fill();
  const t = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0.3, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  m.rotation.x = -Math.PI / 2; m.renderOrder = 2; m.visible = false; m.name = 'PaperShadow';
  return m;
}

/* ------------------------------------------------------------------ 진행 고리 (배스밤 둘레 테이블 위) */
function makeProgressRing() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uP: { value: 0 }, uColor: { value: new THREE.Color('#ffd166') }, uT: { value: 0 }, uA: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform float uP; uniform vec3 uColor; uniform float uT; uniform float uA; varying vec2 vUv;
      void main() {
        vec2 p = vUv * 2.0 - 1.0; float r = length(p);
        float band = smoothstep(0.80, 0.84, r) * (1.0 - smoothstep(0.96, 1.0, r));
        float a = atan(p.x, p.y) / 6.28318530718 + 0.5;                 // 0~1, 앞쪽에서 시작
        float filled = step(a, uP);
        float breathe = 0.25 + 0.15 * sin(uT * 4.0);
        float alpha = band * mix(breathe, 0.95, filled) * uA;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(mix(vec3(1.0), uColor, filled) * (1.0 + filled * 0.6), alpha);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.rotation.x = -Math.PI / 2; m.renderOrder = 9; m.visible = false; m.name = 'GatherRing';
  return m;
}

export class AutoWrapFlow extends THREE.EventDispatcher {
  constructor({ rack, station, box, ribbons, fx, workspace, cfg, getViewer }) {
    super();
    Object.assign(this, { rack, station, box, ribbons, fx, workspace, cfg, getViewer });
    station.auto = true;
    this.root = new THREE.Group(); this.root.name = 'AutoWrapFlow'; workspace.add(this.root);

    // 안내판: 랙 위쪽 / 다시 하기 버튼: 포장 자리 오른쪽
    this.guide = new Panel(0.46, 0.115); this.root.add(this.guide.mesh);
    const rp = rack.root.position;
    this.guide.mesh.position.set(rp.x, rp.y + 0.5, rp.z + 0.06);
    this.button = new Panel(0.15, 0.055, 512); this.root.add(this.button.mesh);
    this.button.mesh.position.set(station.home.paper.x + 0.3, station.tableY + 0.13, station.home.paper.z + 0.08);
    this.button.draw('btn', (g, w, h) => {
      g.fillStyle = '#e8590c'; g.beginPath(); g.roundRect(6, 6, w - 12, h - 12, h / 2 - 6); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 6; g.stroke();
      g.fillStyle = '#fff'; g.font = `800 ${Math.round(h * 0.5)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('↺ 다시 하기', w / 2, h / 2 + 4);
    });
    this.button.mesh.visible = false;

    this.ring = makeProgressRing(); this.root.add(this.ring);
    this.shadow = makeSoftShadow(); this.root.add(this.shadow);   // 흰 종이가 크림색 테이블보 위에서도 보이게

    // 상자 뚜껑은 몸통과 재질을 같이 쓰므로 강조용으로 복제
    this.lidMats = [];
    box.lid.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); this.lidMats.push(o.material); } });
    this.ballMat = station.ball.material;

    station.addEventListener('wrapped', () => this._onWrapped());
    ribbons.addEventListener('attached', () => this._onRibbon());

    this.hovers = new Map();   // 입력 id -> target
    this.holds = new Set();    // 배스밤을 집고 있는 입력 id
    this.t = 0;
    this.reset();
  }

  /* ------------------------------------------------ 상태 */
  _set(state) { this.state = state; this.stateT = 0; this.dispatchEvent({ type: 'state', state }); }

  reset() {
    this.ribbons.reset();
    this.station.reset();
    this.station.ball.scale.setScalar(1);
    this.box.close();
    this.rack.resetRolls();
    this.fx.clear?.();
    this.progress = 0; this.twoHand = 0; this.roll = -1; this.anim = null; this.hop = null; this.bounce = null; this.squash = null;
    this.holds.clear(); this._tickQ = 0;
    this.ring.visible = false; this.button.mesh.visible = false;
    this._set('pick');
  }

  get busy() { return ['dispense', 'fly', 'hop', 'finishing', 'celebrate'].includes(this.state); }

  /** 지금 고를 수 있는 것들 { kind, i, meshes, dist(worldP) } */
  targets() {
    const T = [], s = this.state, st = this.station;
    const rollOk = s === 'pick' || (s === 'gather' && this.progress < 0.04);
    if (rollOk) this.rack.rolls.forEach((r, i) => T.push({ kind: 'roll', i, meshes: this.rack.getRollMeshes(i), dist: (p) => this.rack.rollDistance(i, p) }));
    if (s === 'gather') T.push({ kind: 'gift', meshes: [st.ball, st.paperMesh], dist: (p) => p.distanceTo(st.ball.getWorldPosition(_w)) - st.R });
    if ((s === 'ribbon' || s === 'done') && this.box.angle > 0.6) {
      this.ribbons.items.forEach((it, i) => { if (it.state === 'home') T.push({ kind: 'ribbon', i, meshes: this._meshesOf(it.obj), dist: (p) => p.distanceTo(it.obj.getWorldPosition(_w)) - it.radius * 0.7 }); });
    }
    if (this.button.mesh.visible) T.push({ kind: 'button', meshes: [this.button.mesh], dist: (p) => this.button.mesh.worldToLocal(_w.copy(p)).set(Math.max(0, Math.abs(_w.x) - 0.075), Math.max(0, Math.abs(_w.y) - 0.0275), _w.z).length() });
    T.push({ kind: 'lid', meshes: this.box.getMeshes(), dist: (p) => this.box.grabDistance(p) });
    return T;
  }
  _meshesOf(o) { const a = []; o.traverse((m) => m.isMesh && a.push(m)); return a; }
  static same(a, b) { return a && b && a.kind === b.kind && a.i === b.i; }

  /** 입력 id 가 가리키는 대상 (강조 표시) */
  setHover(id, target) { if (target) this.hovers.set(id, target); else this.hovers.delete(id); }

  /** 누름(핀치·트리거·클릭·톡): 배스밤이면 '집고 있기' 시작, 나머지는 바로 선택 */
  press(id, target) {
    if (!target) return false;
    this.fx.unlockAudio();
    if (target.kind === 'gift') { if (this.state === 'gather') { this.holds.add(id); this._feedback(0.3); return true; } return false; }
    return this.select(target);
  }
  release(id) { this.holds.delete(id); }

  select(target) {
    const k = target.kind;
    if (k === 'roll') return this._pickRoll(target.i);
    if (k === 'ribbon' && (this.state === 'ribbon' || this.state === 'done')) {
      if (this.ribbons.autoAttach(target.i, 0.8 / this.cfg.speed)) {
        this.fx.play('select', this.ribbons.items[target.i].obj.getWorldPosition(new THREE.Vector3()));
        this.fx.playSound('whoosh'); this._feedback(0.4); this._set('ribbonFly'); return true;
      }
      return false;
    }
    if (k === 'lid') { this.box.toggle(); this.fx.playSound('select'); return true; }
    if (k === 'button') { this.fx.play('select', this.button.mesh.getWorldPosition(new THREE.Vector3())); this.reset(); return true; }
    return false;
  }

  /** 두 손 모으기 정도 (0~1). 입력 쪽에서 매 프레임 */
  gatherTo(p) { this.twoHand = Math.max(this.twoHand, p); }
  gatherCenter(out) { return this.state === 'gather' ? this.station.ball.getWorldPosition(out) : null; }

  _feedback(strength) { this.dispatchEvent({ type: 'feedback', strength }); }

  /* ------------------------------------------------ ① 롤 고르기 → 풀림 → 잘림 → 날아감 → 배스밤 폴짝 */
  _pickRoll(i) {
    const r = this.rack.rolls[i]; if (!r) return false;
    if (this.state === 'gather') {                       // 아직 안 모았으면 다른 무늬로 바꾸기
      if (i === this.roll) return false;
      this.roll = i; this.station._setPattern(i);
      this.rack.pullTo(i, this.rack.restPull(i) + 0.05); r.retracting = true;
      this.fx.play('swap', this.station.paper.getWorldPosition(new THREE.Vector3()).setY(this.station.ball.getWorldPosition(_w).y));
      this._feedback(0.3);
      return true;
    }
    if (this.state !== 'pick') return false;
    this.roll = i;
    const rest = this.rack.restPull(i);
    const hang = THREE.MathUtils.clamp(this.rack.freeHangLength(i) - 0.012, 0.06, 0.2);
    this.anim = { i, from: r.pull, to: rest + Math.max(0.05, hang - this.rack.config.interaction.startLip), t: 0 };
    this.fx.play('select', r.pivot.getWorldPosition(new THREE.Vector3()));
    this._feedback(0.4);
    this._set('dispense');
    return true;
  }

  _startFly(info) {
    const st = this.station, P = st.paper, root = st.root;
    root.updateMatrixWorld(true);
    // 시작 자세: 잘린 종이 자리(세워진 채, 무늬가 나를 봄) · 크기도 잘린 종이 크기
    const X = info.axis.clone().normalize();
    let Y = new THREE.Vector3().crossVectors(info.down, X).normalize();
    const viewer = this.getViewer()?.getWorldPosition(new THREE.Vector3()) ?? info.mid.clone().add(new THREE.Vector3(0, 0, 1));
    if (Y.dot(viewer.clone().sub(info.mid)) > 0) Y.negate();               // 흰 면(+Y)은 뒤로, 무늬 면이 나를 봄
    const Z = new THREE.Vector3().crossVectors(X, Y);
    const qW = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
    const rootQ = root.getWorldQuaternion(new THREE.Quaternion()).invert();
    const from = { pos: root.worldToLocal(info.mid.clone()), quat: rootQ.multiply(qW), scale: new THREE.Vector3(info.width / PAPER, 1, info.length / PAPER) };
    const to = { pos: st.home.paper.clone(), quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), st.home.rotY), scale: new THREE.Vector3(1, 1, 1) };
    st._setPattern(this.roll);
    st.f = [0, 0, 0, 0]; st.target = [0, 0, 0, 0]; st.locked = [false, false, false, false]; st.kWrap = 0; st._applyMorph();
    P.visible = true; st.hasSheet = true;
    P.position.copy(from.pos); P.quaternion.copy(from.quat); P.scale.copy(from.scale);
    this.fly = { from, to, t: 0, dur: 0.85 };
    this.fx.play('cut', info.cut, { axis: info.axis, width: info.width });
    this.fx.playSound('whoosh');
    this._set('fly');
  }

  _startHop() {
    const st = this.station, b = st.ball;
    const to = st.home.paper.clone(); to.y = st.tableY + st.R + 0.0006;
    this.hop = { from: b.position.clone(), to, t: 0, dur: 0.6 };
    this.fx.playSound('hop');
  }

  /* ------------------------------------------------ ② 포장 완성 / ③ 리본 */
  _onWrapped() {
    if (!this.station.auto) return;
    const pos = this.station.ball.getWorldPosition(new THREE.Vector3());
    const amt = this.fx.celebrate('complete', pos);
    if (amt) this.bounce = { t: 0, amt };
    this.ring.visible = false;
    this._feedback(1);
    this._set('celebrate');
  }

  _onRibbon() {
    if (!this.station.auto) return;
    const pos = this.station.ball.getWorldPosition(new THREE.Vector3()); pos.y += 0.03;
    const amt = this.fx.celebrate('ribbon', pos);
    if (amt) this.bounce = { t: 0, amt };
    this._feedback(1);
    this._set('done');
  }

  /* ------------------------------------------------ 매 프레임 */
  update(dt) {
    dt = Math.min(dt, 0.05);
    const sp = this.cfg.speed || 1, st = this.station;
    this.t += dt; this.stateT += dt;

    // 롤 풀림 → 잘림
    if (this.state === 'dispense' && this.anim) {
      const a = this.anim; a.t = Math.min(1, a.t + dt * sp / 0.5);
      this.rack.pullTo(a.i, a.from + (a.to - a.from) * easeOut(a.t));
      if (a.t >= 1 && (a.hold = (a.hold ?? 0) + dt * sp) > 0.12) {
        const info = this.rack.cutAway(a.i, this.rack.restPull(a.i));
        this.anim = null;
        if (info) this._startFly(info); else this._set('pick');
      }
    }

    // 종이 날아가기 (포물선 + 뒤집히며 눕기 + 원래 크기로)
    if (this.state === 'fly' && this.fly) {
      const f = this.fly, P = st.paper;
      f.t = Math.min(1, f.t + dt * sp / f.dur);
      const t = f.t, e = easeInOut(t);
      // 앞으로는 빨리(랙에서 먼저 떨어지게), 높이는 포물선
      const eh = easeOut(Math.min(1, t * 1.1));
      P.position.set(f.from.pos.x + (f.to.pos.x - f.from.pos.x) * eh, f.from.pos.y + (f.to.pos.y - f.from.pos.y) * e + Math.sin(Math.PI * t) * 0.16, f.from.pos.z + (f.to.pos.z - f.from.pos.z) * eh);
      P.quaternion.slerpQuaternions(f.from.quat, f.to.quat, easeInOut(Math.min(1, t * 1.15)));
      P.quaternion.multiply(_q.setFromAxisAngle(_v.set(0, 0, 1), Math.sin(Math.PI * t) * 0.35 * (1 - t)));   // 살랑
      P.scale.lerpVectors(f.from.scale, f.to.scale, easeOut(Math.min(1, t * 1.6)));
      if (!this.hop && t > 0.62) this._startHop();
      if (t >= 1) {
        P.position.copy(f.to.pos); P.quaternion.copy(f.to.quat); P.scale.set(1, 1, 1);
        this.fx.play('land', P.getWorldPosition(new THREE.Vector3()), { radius: 0.17 });
        this.fly = null;
        this._set('hop');
      }
    }

    // 배스밤 폴짝 → 종이 가운데 착지 (찌그러졌다 펴짐)
    if (this.hop) {
      const h = this.hop, b = st.ball;
      const prev = b.position.clone();
      h.t = Math.min(1, h.t + dt * sp / h.dur);
      const e = easeInOut(h.t);
      b.position.lerpVectors(h.from, h.to, e); b.position.y += Math.sin(Math.PI * h.t) * 0.15;
      const mv = _v.subVectors(b.position, prev); mv.y = 0;
      if (mv.lengthSq() > 1e-10) b.quaternion.premultiply(_q.setFromAxisAngle(_w.set(mv.z, 0, -mv.x).normalize(), mv.length() / st.R));
      if (h.t >= 1) {
        b.position.copy(h.to); this.hop = null;
        this.squash = { t: 0 };
        this.fx.play('land', b.getWorldPosition(new THREE.Vector3()).setY(st.root.localToWorld(_v.set(0, st.tableY, 0)).y + 0.01), { radius: 0.045 });
        this._feedback(0.5);
        st.state = 'onPaper';
        this.progress = 0; this.twoHand = 0;
        if (this.state === 'hop' || this.state === 'fly') this._set('gather');
      }
    }
    if (this.squash) {                                    // 착지 찌그러짐 (위치는 바닥 기준)
      const q = this.squash; q.t += dt;
      const k = Math.exp(-q.t * 7) * Math.cos(q.t * 22) * 0.16;
      st.ball.scale.set(1 + k * 0.6, 1 - k, 1 + k * 0.6);
      if (q.t > 0.8) { st.ball.scale.setScalar(1); this.squash = null; }
    }

    // ② 모으기
    if (this.state === 'gather') {
      const before = this.progress;
      if (this.holds.size) this.progress += dt / Math.max(0.2, this.cfg.holdTime);
      if (this.twoHand > this.progress) this.progress += Math.min(this.twoHand - this.progress, dt * 2.5);
      this.twoHand = 0;
      this.progress = Math.min(1, this.progress);
      const p = this.progress;
      for (let k = 0; k < 4; k++) {
        const tk = THREE.MathUtils.clamp((p - k * 0.06) / 0.82, 0, 1);
        st.target[k] = tk; st.locked[k] = tk >= 1;
      }
      const ballW = st.ball.getWorldPosition(new THREE.Vector3());
      if (p > before) {
        this.fx.gather(ballW, p, dt, st.R + 0.02);
        const q = Math.floor(p * 4);
        if (q > this._tickQ) { this._tickQ = q; this.fx.playSound('tick'); this._feedback(0.15); }
      }
      // 진행 고리
      const rc = this.fx.cfg?.gather;
      this.ring.visible = !!(this.fx.on && rc?.enabled !== false && rc?.ring);
      if (this.ring.visible) {
        this.ring.position.set(st.paper.position.x, st.tableY + 0.004, st.paper.position.z);
        this.ring.scale.setScalar(0.26);
        const u = this.ring.material.uniforms; u.uP.value = p; u.uT.value = this.t; u.uColor.value.set(rc.ringColor || '#ffd166');
      }
      if (p >= 1) this._set('finishing');
    }

    // 축하 후 → 상자 열고 리본 단계
    if (this.state === 'celebrate' && this.stateT > 0.9 / sp) {
      if (this.cfg.boxAutoOpen) this.box.open();
      this._set('ribbon');
    }
    if (this.state === 'done' && this.stateT > 1.2) this.button.mesh.visible = true;

    // 선물 통통
    if (this.bounce && st.gift) {
      const b = this.bounce; b.t += dt;
      const k = Math.sin(b.t * 16) * Math.exp(-b.t * 4.5) * b.amt;
      st.gift.scale.set(1 - k * 0.5, 1 + k, 1 - k * 0.5);
      if (b.t > 1.4) { st.gift.scale.setScalar(1); this.bounce = null; }
    }

    this._updateShadow();
    this._updateHighlights();
    this._updateGuide();
    const viewer = this.getViewer();
    if (viewer) {
      viewer.getWorldPosition(_v);
      for (const m of [this.guide.mesh, this.button.mesh]) if (m.visible) m.lookAt(_v);
    }
  }

  _updateShadow() {
    const st = this.station, P = st.paper, sh = this.shadow;
    sh.visible = P.visible;
    if (!sh.visible) return;
    const src = st.gift ?? P;
    const h = Math.max(0, P.getWorldPosition(_v).y - st.root.localToWorld(_w.set(0, st.tableY, 0)).y);
    const ws = st.gift ? 0.16 : PAPER * 1.47;              // 캔버스 가장자리 여백 보정
    const k = st.gift ? 1 : Math.max(P.scale.x, 0.2);
    sh.position.set(src.position.x, st.tableY + 0.0012, src.position.z);
    sh.rotation.set(-Math.PI / 2, 0, st.gift ? 0 : this._yawOf(P));
    sh.scale.set(ws * k * (1 + h * 1.5), ws * (st.gift ? 1 : Math.max(P.scale.z, 0.2)) * (1 + h * 1.5), 1);
    sh.material.opacity = (st.gift ? 0.45 : 0.3) * Math.max(0.15, 1 - h * 4);
  }
  _yawOf(o) { const ex = _v.set(1, 0, 0).applyQuaternion(o.quaternion); return Math.atan2(-ex.z, ex.x); }

  _updateHighlights() {
    const h = this.fx.cfg?.hover, on = this.fx.on && h?.enabled !== false;
    const col = h?.color ?? '#ffd98a', base = h?.intensity ?? 0.35;
    const k = base * (0.75 + 0.25 * Math.sin(this.t * 7));
    const hov = [...this.hovers.values()];
    const is = (kind, i) => on && hov.some((t) => t.kind === kind && (i === undefined || t.i === i));
    this.rack.rolls.forEach((r, i) => this.rack.setHighlight(i, col, is('roll', i) ? k : 0));
    this.ribbons.items.forEach((it, i) => { if (is('ribbon', i) || it.mats) this.ribbons.setHighlight(i, col, is('ribbon', i) ? k : 0); });
    for (const m of this.lidMats) { m.emissive.set(col); m.emissiveIntensity = is('lid') ? k * 0.6 : 0; }
    if (this.ballMat?.emissive) { this.ballMat.emissive.set(col); this.ballMat.emissiveIntensity = (is('gift') || this.holds.size) ? k * 0.8 : 0; }
    const bs = is('button') ? 1.1 : 1; this.button.mesh.scale.setScalar(bs);
  }

  _updateGuide() {
    const show = this.cfg.guideText !== false;
    this.guide.mesh.visible = show;
    if (!show) return;
    const L = {
      pick: ['포장지 롤을 골라요', '가리키고 집기 · 손가락으로 톡 · 클릭'],
      dispense: ['포장지 준비 중…', ''], fly: ['포장지 준비 중…', ''], hop: ['포장지 준비 중…', ''],
      gather: ['두 손으로 감싸 모아요', '또는 배스밤을 집고 있기 · 누르고 있기'],
      finishing: ['착착…', ''], celebrate: ['포장 완성!', ''],
      ribbon: ['리본을 골라요 🎀', '상자 안 리본을 가리키고 집기 · 톡'], ribbonFly: ['리본을 다는 중…', ''],
      done: ['완성! 🎉', '‘다시 하기’로 처음부터'],
    }[this.state] || ['', ''];
    this.guide.draw(L.join('|'), (g, w, h) => {
      if (!L[0]) return;
      g.fillStyle = 'rgba(20,22,28,0.72)'; g.beginPath(); g.roundRect(8, 8, w - 16, h - 16, 40); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `800 ${Math.round(h * (L[1] ? 0.3 : 0.38))}px ${FONT}`;
      g.fillText(L[0], w / 2, L[1] ? h * 0.38 : h / 2);
      if (L[1]) { g.fillStyle = '#ffd98a'; g.font = `600 ${Math.round(h * 0.17)}px ${FONT}`; g.fillText(L[1], w / 2, h * 0.74); }
    });
  }
}

/* ================================================================== 입력: PC 마우스 + VR 손/컨트롤러
 * 손동작은 두 가지뿐
 *   - 고르기   : 가리키고 집기(핀치 = 엄지·검지 붙이기 / 컨트롤러 트리거·그립) 또는 손가락 끝으로 톡 / 클릭
 *   - 모으기   : 두 손으로 배스밤을 감싸듯 모으기 (또는 배스밤을 집고 있기 / 누르고 있기)
 */
export function bindSimpleInput({ renderer, scene, camera, controls, flow, fx }) {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const dom = renderer.domElement;

  const pick = () => {
    const T = flow.targets(), map = new Map(), meshes = [];
    for (const t of T) for (const m of t.meshes) { if (!m.visible) continue; map.set(m, t); meshes.push(m); }
    const hit = ray.intersectObjects(meshes, false)[0];
    return hit ? { target: map.get(hit.object), dist: hit.distance } : null;
  };

  // ---------------- PC
  let mouseDown = false;
  const setMouseRay = (e) => { const r = dom.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); };
  dom.addEventListener('pointermove', (e) => {
    if (renderer.xr.isPresenting) return;
    setMouseRay(e); const h = pick(); flow.setHover('mouse', h?.target ?? null);
    dom.style.cursor = h ? 'pointer' : '';
  });
  dom.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || renderer.xr.isPresenting) return;
    fx.unlockAudio();
    setMouseRay(e); const h = pick();
    if (h && flow.press('mouse', h.target)) {
      mouseDown = true; controls.enabled = false;
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, true);
  addEventListener('pointerup', () => { if (mouseDown) { flow.release('mouse'); mouseDown = false; controls.enabled = true; } });

  // ---------------- VR
  const ctrlFactory = new XRControllerModelFactory();
  const handFactory = new XRHandModelFactory();
  handFactory.setPath(new URL('../models/hands/', import.meta.url).href);
  const sources = [];
  const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  for (let i = 0; i < 2; i++) {
    const rayObj = renderer.xr.getController(i), grip = renderer.xr.getControllerGrip(i), hand = renderer.xr.getHand(i);
    grip.add(ctrlFactory.createControllerModel(grip));
    hand.add(handFactory.createHandModel(hand, 'mesh'));
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, toneMapped: false }));
    line.visible = false; rayObj.add(line);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffe08a, toneMapped: false, depthTest: false }));
    dot.renderOrder = 40; dot.visible = false; scene.add(dot);
    scene.add(rayObj, grip, hand);
    const s = { i, id: `xr${i}`, rayObj, grip, hand, line, dot, src: null, isHand: false, connected: false, hover: null, touch: null, pressed: false, tip: new THREE.Vector3(), palm: new THREE.Vector3(), hasPalm: false };
    sources.push(s);
    rayObj.addEventListener('connected', (e) => { s.src = e.data; s.isHand = !!e.data.hand; s.connected = true; fx.unlockAudio(); });
    rayObj.addEventListener('disconnected', () => { flow.release(s.id); flow.release(s.id + 't'); flow.setHover(s.id, null); Object.assign(s, { connected: false, src: null, hover: null, touch: null, pressed: false }); line.visible = dot.visible = false; });
    const down = () => {
      if (s.pressed) return; s.pressed = true;
      const t = s.touch || s.hover;                       // 손가락으로 대고 있는 것 우선, 아니면 가리키는 것
      if (t) flow.press(s.id, t);
    };
    const up = () => { if (!s.pressed) return; s.pressed = false; flow.release(s.id); };
    rayObj.addEventListener('selectstart', down); rayObj.addEventListener('selectend', up);
    rayObj.addEventListener('squeezestart', down); rayObj.addEventListener('squeezeend', up);
  }
  flow.addEventListener('feedback', (e) => {
    for (const s of sources) s.src?.gamepad?.hapticActuators?.[0]?.pulse?.(Math.min(1, e.strength), 30 + e.strength * 90);
  });
  renderer.xr.addEventListener('sessionstart', () => fx.unlockAudio());

  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _d = new THREE.Vector3();
  function update() {
    if (!renderer.xr.isPresenting) { for (const s of sources) s.line.visible = s.dot.visible = false; return; }
    const T = flow.targets();
    for (const s of sources) {
      if (!s.connected) continue;
      // 가리키기
      s.rayObj.updateMatrixWorld();
      _m.identity().extractRotation(s.rayObj.matrixWorld);
      ray.ray.origin.setFromMatrixPosition(s.rayObj.matrixWorld);
      ray.ray.direction.set(0, 0, -1).applyMatrix4(_m);
      const h = pick();
      s.hover = h?.target ?? null;
      // 손가락 끝(손) / 컨트롤러 앞 끝으로 톡
      s.hasPalm = false;
      if (s.isHand) {
        const tip = s.hand.joints?.['index-finger-tip'], palm = s.hand.joints?.['middle-finger-metacarpal'];
        if (tip?.visible) tip.getWorldPosition(s.tip); else s.tip.set(1e5, 1e5, 1e5);
        if (palm?.visible) { palm.getWorldPosition(s.palm); s.hasPalm = true; }
      } else {
        s.grip.updateMatrixWorld();
        s.tip.set(0, -0.01, -0.07).applyMatrix4(s.grip.matrixWorld);
        s.palm.setFromMatrixPosition(s.grip.matrixWorld); s.hasPalm = true;
      }
      const tr = flow.cfg.touchRadius * (s.isHand ? 1 : 1.4);
      let touch = null, td = tr;
      for (const t of T) { const d = t.dist(s.tip); if (d < td) { td = d; touch = t; } }
      if (!AutoWrapFlow.same(touch, s.touch)) {
        if (s.touch) flow.release(s.id + 't');
        s.touch = touch;
        if (touch) flow.press(s.id + 't', touch);           // 새로 닿으면 톡 = 고르기 (배스밤이면 닿아 있는 동안 집고 있기)
      }
      flow.setHover(s.id, s.touch || s.hover);
      // 레이 표시: 컨트롤러는 항상(흐리게), 손은 무언가를 가리킬 때만
      const len = h ? h.dist : 0.6;
      s.line.scale.z = len; s.line.visible = !s.isHand || !!h;
      s.line.material.opacity = h ? 0.9 : 0.25;
      s.dot.visible = !!h; if (h) s.dot.position.copy(ray.ray.origin).addScaledVector(ray.ray.direction, h.dist);
    }
    // 두 손 모으기
    const c = flow.gatherCenter(_p);
    const hs = sources.filter((s) => s.connected && s.hasPalm);
    if (c && hs.length === 2) {
      const R = flow.cfg.handRadius;
      if (hs[0].palm.distanceTo(c) < R && hs[1].palm.distanceTo(c) < R) {
        const d = hs[0].palm.distanceTo(hs[1].palm), a = flow.cfg.twoHandStart, b = flow.cfg.twoHandEnd;
        flow.gatherTo(THREE.MathUtils.clamp((a - d) / (a - b), 0, 1));
      }
    }
  }
  return { update, sources };
}
