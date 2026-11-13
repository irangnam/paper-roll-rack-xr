/**
 * AutoWrapFlow — 단순화한 포장 진행 (교수님 피드백 반영)
 *
 *   ① 포장지 당기기 : 롤을 집고(핀치·트리거·마우스 드래그) 내 쪽으로 당김
 *                    → 포장할 만큼(pullLength) 나오면 저절로 '지지직' 오른쪽 → 왼쪽으로 찢어짐 (가위질 없음)
 *                    → 포장 자리로 날아가 '착' 놓이고, 옆에 있던 배스밤이 폴짝 뛰어 종이 위에 올라감
 *   ② 포장하기     : flow.wrapNow() (HUD 의 🎁 포장하기 버튼) 또는 배스밤 클릭/톡 · VR 두 손 감싸 모으기
 *                    → 꼭짓점이 저절로 올라와 차킨 포장 → 선물 통통 + 효과음
 *   ③ 리본 고르기   : 늘 열려 있는 리본 상자(포장지 왼쪽)의 리본을 고르면 날아가 선물 목에 붙음
 *   ④ 끝나면 선물을 한 번 더 누르면 처음부터 (VR 에서 다시 하기)
 * 바닥에 떨어지는 것 없음. 파티클·빛 고리·떠 있는 안내판/버튼 없음 (움직임과 효과음만).
 *
 *   const flow = new AutoWrapFlow({ rack, station, box, ribbons, fx, workspace, cfg: config.flow, getViewer });
 *   const input = bindSimpleInput({ renderer, scene, camera, controls, flow, fx });
 *   매 프레임: input.update(dt); rack.update(dt); flow.update(dt);
 * 이벤트: 'state' { state } · 'feedback' { strength } (컨트롤러 진동용)
 */
import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

export const DEFAULT_FLOW = {
  mode: 'auto',            // 'auto' = 단순 진행(기본) · 'manual' = 예전 방식(직접 당기고 가위질)
  speed: 1,                // 자동 연출 속도 배율
  pullLength: 0.35,        // 이만큼(m) 당기면 저절로 찢어짐 (포장할 양)
  tearTime: 0.55,          // 찢어지는 시간 (s) — 오른쪽에서 왼쪽으로
  wrapTime: 1.0,           // 포장하기 버튼을 누른 뒤 감싸지는 시간 (s)
  twoHandStart: 0.36,      // (VR) 두 손 사이가 이 거리(m)부터 모으기 시작
  twoHandEnd: 0.14,        // 이 거리까지 모으면 완성
  handRadius: 0.26,        // 손이 배스밤에서 이 거리 안에 있어야 '감싸는' 것으로 봄
  touchRadius: 0.025,      // 손가락 끝이 이 거리 안이면 '톡'
};
export function mergeFlow(u) { return { ...DEFAULT_FLOW, ...(u || {}) }; }

const PAPER = 0.40;   // GiftWrap.glb 포장지 한 변
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion();

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

export class AutoWrapFlow extends THREE.EventDispatcher {
  constructor({ rack, station, box, ribbons, fx, workspace, cfg, getViewer }) {
    super();
    Object.assign(this, { rack, station, box, ribbons, fx, workspace, cfg, getViewer });
    station.auto = true;
    this.root = new THREE.Group(); this.root.name = 'AutoWrapFlow'; workspace.add(this.root);

    this.shadow = makeSoftShadow(); this.root.add(this.shadow);   // 흰 종이가 크림색 테이블보 위에서도 보이게
    this.proxy = new THREE.Object3D(); this.proxy.name = 'PullHand'; this.root.add(this.proxy);   // 당기는 손 대신 (입력 위치를 따라감)

    this.ballMat = station.ball.material;

    station.addEventListener('wrapped', () => this._onWrapped());
    ribbons.addEventListener('attached', () => this._onRibbon());

    this.hovers = new Map();   // 입력 id -> target
    this.t = 0;
    this.reset();
  }

  /* ------------------------------------------------ 상태 */
  _set(state) { this.state = state; this.stateT = 0; this.dispatchEvent({ type: 'state', state }); }

  reset() {
    if (this.drag) { this.rack.release(this.proxy); this.drag = null; }
    if (this.piece) { this._disposePiece(); }
    this.ribbons.reset();
    this.station.reset();
    this.station.ball.scale.setScalar(1);
    this.box.open(true);   // 리본 상자는 늘 열려 있음
    this.rack.resetRolls();
    this.fx.clear?.();
    this.progress = 0; this.twoHand = 0; this.roll = -1; this.hop = null; this.bounce = null; this.squash = null; this.fly = null; this.tear = null;
    this.wrapping = false; this._tickQ = 0; this.pullFrac = 0;
    this._set('pick');
  }

  /** 지금 고를 수 있는 것들 { kind, i, meshes, dist(worldP) } */
  targets() {
    const T = [], s = this.state, st = this.station;
    if (s === 'pick') this.rack.rolls.forEach((r, i) => T.push({ kind: 'roll', i, meshes: this.rack.getRollMeshes(i), dist: (p) => this.rack.rollDistance(i, p) }));
    if (s === 'gather' && !this.wrapping) {
      T.push({ kind: 'gift', meshes: [st.ball, st.paperMesh], dist: (p) => p.distanceTo(st.ball.getWorldPosition(_w)) - st.R });
    }
    if ((s === 'ribbon' || s === 'done') && this.box.angle > 0.6) {
      this.ribbons.items.forEach((it, i) => { if (it.state === 'home') T.push({ kind: 'ribbon', i, meshes: this._meshesOf(it.obj), dist: (p) => p.distanceTo(it.obj.getWorldPosition(_w)) - it.radius * 0.7 }); });
    }
    // 다 끝나면 선물을 한 번 더 누르면(톡) 처음부터 — VR 에서 다시 하기
    if (s === 'done' && this.stateT > 1) T.push({ kind: 'restart', meshes: this._meshesOf(st.gift ?? st.ball), dist: (p) => p.distanceTo(st.ball.getWorldPosition(_w)) - st.R });
    return T;
  }
  _meshesOf(o) { const a = []; o.traverse((m) => m.isMesh && a.push(m)); return a; }
  static same(a, b) { return a && b && a.kind === b.kind && a.i === b.i; }

  /** 입력 id 가 가리키는 대상 (강조 표시) */
  setHover(id, target) { if (target) this.hovers.set(id, target); else this.hovers.delete(id); }

  /** 누름(핀치·트리거·클릭·톡). 롤이면 getPoint()(입력의 현재 월드 위치)를 따라 당기기 시작 */
  press(id, target, getPoint = null) {
    if (!target) return false;
    this.fx.unlockAudio();
    const k = target.kind;
    if (k === 'roll') return getPoint ? this._startPull(id, target.i, getPoint) : false;
    if (k === 'gift') return this.wrapNow();
    if (k === 'ribbon' && (this.state === 'ribbon' || this.state === 'done')) {
      if (this.ribbons.autoAttach(target.i, 0.8 / this.cfg.speed)) {
        this.fx.play('select', this.ribbons.items[target.i].obj.getWorldPosition(new THREE.Vector3()));
        this.fx.playSound('whoosh'); this._feedback(0.4); this._set('ribbonFly'); return true;
      }
      return false;
    }
    if (k === 'restart') { this.fx.playSound('select'); this.reset(); return true; }
    return false;
  }

  /** 놓음: 다 당기기 전에 놓으면 종이는 롤로 말려 들어감 */
  release(id) {
    if (this.drag && this.drag.id === id) {
      this.rack.release(this.proxy); this.drag = null;
      if (this.state === 'pull') this._set('pick');
    }
  }

  /** 🎁 포장하기 */
  wrapNow() {
    if (this.state !== 'gather' || this.wrapping) return false;
    this.wrapping = true;
    this.fx.playSound('select');
    this._feedback(0.4);
    return true;
  }

  /** (VR) 두 손 모으기 정도 (0~1). 입력 쪽에서 매 프레임 */
  gatherTo(p) { this.twoHand = Math.max(this.twoHand, p); }
  gatherCenter(out) { return this.state === 'gather' ? this.station.ball.getWorldPosition(out) : null; }

  _feedback(strength) { this.dispatchEvent({ type: 'feedback', strength }); }
  _tableWorldY() { return this.station.root.localToWorld(_w.set(0, this.station.tableY, 0)).y; }

  /* ------------------------------------------------ ① 당기기 → 지지직(오른쪽 → 왼쪽) → 날아감 → 배스밤 폴짝 */
  _startPull(id, i, getPoint) {
    if (this.state !== 'pick') return false;
    const p0 = getPoint(); if (!p0) return false;
    const end0 = this.rack.sheetEnd(i, new THREE.Vector3());
    this.proxy.position.copy(this.root.worldToLocal(end0.clone())); this.proxy.updateMatrixWorld();
    this.rack.grabSheet(i, this.proxy);
    this.drag = { id, i, getPoint, p0: p0.clone(), end0, lastTick: this.rack.rolls[i].pull };
    this.roll = i; this.pullFrac = 0;
    this.fx.play('select', end0);
    this._feedback(0.3);
    this._set('pull');
    return true;
  }

  _updatePull() {
    const d = this.drag, p = d.getPoint();
    if (p) {
      const w = _v.copy(d.end0).add(_w.copy(p).sub(d.p0));
      this._clearPath(d.i, w);
      this.proxy.position.copy(this.root.worldToLocal(w)); this.proxy.updateMatrixWorld();
    }
    const r = this.rack.rolls[d.i], got = r.pull - this.rack.restPull(d.i);
    this.pullFrac = Math.min(1, got / this.cfg.pullLength);
    if (r.pull - d.lastTick > 0.03) { d.lastTick = r.pull; this.fx.playSound('pull'); this._feedback(0.08); }
    if (got >= this.cfg.pullLength) this._startTear();
  }

  /** 당기는 점 w(월드)를 고쳐서, 롤에서 손까지 곧게 뻗은 종이가 랙 앞 아래 모서리와 테이블을 뚫지 않게 함.
   *  손까지의 거리(당긴 길이)는 그대로 두고 방향만 앞쪽으로 들어 올림 */
  _clearPath(i, w) {
    const r = this.rack.rolls[i];
    const lp = r.pivot.worldToLocal(w.clone());
    const D = Math.max(Math.hypot(lp.y, lp.z), r.Rs + 1e-3);
    let phi = Math.atan2(lp.z, -lp.y);                         // 0 = 바로 아래, + = 앞(나) 쪽
    const tw = r.Rs / D;
    phi = Math.max(phi, (r.tiltEdge ?? 0) + 0.03 + Math.asin(Math.min(1, tw)));   // 모서리 앞을 지나게
    const tableY = r.pivot.worldToLocal(new THREE.Vector3(w.x, this._tableWorldY() + 0.012, w.z)).y;
    if (D > -tableY) phi = Math.max(phi, Math.acos(THREE.MathUtils.clamp(-tableY / D, -1, 1)));   // 끝이 테이블 위에
    phi = Math.min(phi, 2.3);
    lp.y = -D * Math.cos(phi); lp.z = D * Math.sin(phi);
    w.copy(r.pivot.localToWorld(lp));
    return w;
  }

  _startTear() {
    const i = this.drag.i; this.drag = null;
    const pc = this.rack.tearOff(i);            // 손은 떼고, 쉬는 길이 아래를 조각으로 (무늬는 롤과 이어짐)
    if (!pc) { this._set('pick'); return; }
    const m = pc.mesh, W = pc.width, L = pc.length;
    m.geometry.dispose();
    m.geometry = new THREE.PlaneGeometry(W, L, 28, 2);        // 찢어지는 선이 부드럽게 보이도록 가로로 촘촘히
    this.station.root.attach(m);
    this.piece = pc;
    this.base = m.geometry.attributes.position.array.slice();
    // 오른쪽(보는 사람 기준)에서 시작: 조각의 +X 가 내 오른쪽이면 s = +1
    m.updateMatrixWorld(true);
    const xr = new THREE.Vector3(1, 0, 0).transformDirection(m.matrixWorld);
    const viewer = this.getViewer();
    const right = viewer ? new THREE.Vector3(1, 0, 0).transformDirection(viewer.matrixWorld) : new THREE.Vector3(1, 0, 0);
    const s = xr.dot(right) >= 0 ? 1 : -1;
    this.tear = { t: 0, s, W, L, dur: Math.max(0.15, this.cfg.tearTime) };
    this.fx.playSound('tear', this.tear.dur / (this.cfg.speed || 1));
    this._feedback(0.6);
    this._set('tear');
  }

  /** 찢어진 쪽(앞머리 frontX 바깥)이 앞머리를 축으로 아래로 처지고 살짝 앞으로 말림. k = 변형 정도 */
  _deformPiece(frontX, k) {
    const T = this.tear, P = this.piece.mesh.geometry.attributes.position, A = P.array, B = this.base;
    const slope = 0.42 * k, curl = 0.5 * k, topY = T.L / 2;
    for (let j = 0; j < P.count; j++) {
      const x = B[j * 3], y = B[j * 3 + 1];
      const u = (x - frontX) * T.s;                          // >0 이면 이미 찢어진 쪽
      if (u <= 0 || k <= 0) { A[j * 3] = x; A[j * 3 + 1] = y; A[j * 3 + 2] = 0; continue; }
      // 앞머리(frontX, topY)를 축으로 회전 (작은 각도) + 끝이 살짝 말림
      const a = -T.s * slope * Math.min(1, u / 0.04);
      const dx = x - frontX, dy = y - topY;
      A[j * 3] = frontX + dx * Math.cos(a) - dy * Math.sin(a);
      A[j * 3 + 1] = topY + dx * Math.sin(a) + dy * Math.cos(a);
      A[j * 3 + 2] = u * u * curl * (0.4 + 0.6 * (topY - y) / T.L);
    }
    // 처진 쪽이 테이블을 뚫지 않게: 테이블보 위에 닿으면 거기서 멈춰 눕는 것처럼
    const m = this.piece.mesh, minY = this._tableWorldY() + 0.002, v = _w;
    m.updateMatrixWorld(true);
    for (let j = 0; j < P.count; j++) {
      v.set(A[j * 3], A[j * 3 + 1], A[j * 3 + 2]).applyMatrix4(m.matrixWorld);
      if (v.y < minY) { v.y = minY; m.worldToLocal(v); A[j * 3] = v.x; A[j * 3 + 1] = v.y; A[j * 3 + 2] = v.z; }
    }
    P.needsUpdate = true; m.geometry.computeVertexNormals();
  }

  /** 날아가는 조각의 가장 낮은 점이 테이블보 아래로 내려가면 그만큼 들어 올림 */
  _keepAboveTable(m) {
    const P = m.geometry.attributes.position, v = _w, minY = this._tableWorldY() + 0.002;
    m.updateMatrixWorld(true);
    let low = Infinity;
    for (let j = 0; j < P.count; j++) low = Math.min(low, v.fromBufferAttribute(P, j).applyMatrix4(m.matrixWorld).y);
    if (low < minY) { m.position.y += minY - low; m.updateMatrixWorld(true); }
  }

  _startFly() {
    const st = this.station, m = this.piece.mesh;
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), st.home.rotY);
    // 눕힌 자세: 무늬 면(+Z)이 아래, 흰 면이 위 (포장하면 무늬가 바깥)
    const flat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0)));
    let to = yaw.clone().multiply(flat);
    const alt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI).multiply(to);
    if (m.quaternion.angleTo(alt) < m.quaternion.angleTo(to)) to = alt;     // 덜 도는 쪽으로
    const pos = st.home.paper.clone(); pos.y = st.tableY + 0.0015;
    this.fly = { from: { pos: m.position.clone(), quat: m.quaternion.clone(), scale: m.scale.clone() },
                 to: { pos, quat: to, scale: new THREE.Vector3(PAPER / this.piece.width, PAPER / this.piece.length, 1) }, t: 0, dur: 0.85 };
    this.fx.playSound('whoosh');
    this._set('fly');
  }

  _disposePiece() {
    const m = this.piece.mesh; m.removeFromParent(); m.geometry.dispose(); m.material.dispose();
    this.piece = null;
  }

  /** 날아온 조각 → 포장지(GiftWrap.glb, 같은 무늬)로 바꿔 놓음 */
  _placePaper() {
    const st = this.station, P = st.paper;
    this._disposePiece();
    st._setPattern(this.roll);
    st.f = [0, 0, 0, 0]; st.target = [0, 0, 0, 0]; st.locked = [false, false, false, false]; st.kWrap = 0; st._applyMorph();
    P.visible = true; st.hasSheet = true;
    P.position.copy(st.home.paper); P.rotation.set(0, st.home.rotY, 0); P.scale.set(1, 1, 1);
    this.fx.play('land', P.getWorldPosition(new THREE.Vector3()), { radius: 0.17 });
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

    if (this.state === 'pull' && this.drag) this._updatePull();

    // 지지직: 찢어지는 앞머리가 오른쪽 끝 → 왼쪽 끝으로
    if (this.state === 'tear' && this.tear) {
      const T = this.tear, m = this.piece.mesh;
      T.t = Math.min(1, T.t + dt * sp / T.dur);
      const e = T.t * (0.85 + 0.15 * T.t);                   // 거의 일정한 속도, 끝에서 살짝 빨라짐
      const frontX = T.s * (T.W / 2 - T.W * e);
      this._deformPiece(frontX, 1);
      if (T.t >= 1) {
        T.done = true; T.relax = 1;
        m.position.y -= 0.004;                                // 완전히 떨어지는 순간 살짝 툭
        this._startFly();
      }
    }

    // 조각 날아가기 (앞으로 먼저 → 포물선 → 흰 면이 위로 눕기 → 포장지 크기로)
    if (this.state === 'fly' && this.fly) {
      const f = this.fly, m = this.piece.mesh, T = this.tear;
      f.t = Math.min(1, f.t + dt * sp / f.dur);
      const t = f.t, e = easeInOut(t), eh = easeOut(Math.min(1, t * 1.1));
      m.position.set(f.from.pos.x + (f.to.pos.x - f.from.pos.x) * eh, f.from.pos.y + (f.to.pos.y - f.from.pos.y) * e + Math.sin(Math.PI * t) * 0.14, f.from.pos.z + (f.to.pos.z - f.from.pos.z) * eh);
      m.quaternion.slerpQuaternions(f.from.quat, f.to.quat, easeInOut(Math.min(1, t * 1.15)));
      m.quaternion.multiply(_q.setFromAxisAngle(_v.set(0, 1, 0), Math.sin(Math.PI * t) * 0.3 * (1 - t)));   // 살랑
      m.scale.lerpVectors(f.from.scale, f.to.scale, easeOut(Math.min(1, t * 1.4)));
      if (T) this._deformPiece(-T.s * T.W / 2, Math.max(0, 1 - t / 0.45));   // 처진 모양이 펴지며 날아감
      this._keepAboveTable(m);
      if (!this.hop && t > 0.62) this._startHop();
      if (t >= 1) { this.fly = null; this.tear = null; this._placePaper(); this._set('hop'); }
    }

    // 배스밤 폴짝 → 종이 가운데 착지 (찌그러졌다 펴짐)
    if (this.hop) {
      const h = this.hop, b = st.ball;
      const prev = b.position.clone();
      h.t = Math.min(1, h.t + dt * sp / h.dur);
      b.position.lerpVectors(h.from, h.to, easeInOut(h.t)); b.position.y += Math.sin(Math.PI * h.t) * 0.15;
      const mv = _v.subVectors(b.position, prev); mv.y = 0;
      if (mv.lengthSq() > 1e-10) b.quaternion.premultiply(_q.setFromAxisAngle(_w.set(mv.z, 0, -mv.x).normalize(), mv.length() / st.R));
      if (h.t >= 1 && !this.fly) {
        b.position.copy(h.to); this.hop = null;
        this.squash = { t: 0 };
        this.fx.play('land', b.getWorldPosition(new THREE.Vector3()).setY(this._tableWorldY() + 0.01), { radius: 0.045 });
        this._feedback(0.5);
        st.state = 'onPaper';
        this.progress = 0; this.twoHand = 0; this.wrapping = false;
        this._set('gather');
      }
    }
    if (this.squash) {
      const q = this.squash; q.t += dt;
      const k = Math.exp(-q.t * 7) * Math.cos(q.t * 22) * 0.16;
      st.ball.scale.set(1 + k * 0.6, 1 - k, 1 + k * 0.6);
      if (q.t > 0.8) { st.ball.scale.setScalar(1); this.squash = null; }
    }

    // ② 포장하기 (버튼) / 두 손 모으기
    if (this.state === 'gather') {
      const before = this.progress;
      if (this.wrapping) this.progress += dt * sp / Math.max(0.2, this.cfg.wrapTime);
      if (this.twoHand > this.progress) this.progress += Math.min(this.twoHand - this.progress, dt * 2.5);
      this.twoHand = 0;
      this.progress = Math.min(1, this.progress);
      const p = this.progress;
      for (let k = 0; k < 4; k++) {
        const tk = THREE.MathUtils.clamp((p - k * 0.06) / 0.82, 0, 1);
        st.target[k] = tk; st.locked[k] = tk >= 1;
      }
      if (p > before) {
        const q = Math.floor(p * 4);
        if (q > this._tickQ) { this._tickQ = q; this.fx.playSound('tick'); this._feedback(0.15); }
      }
      if (p >= 1) this._set('finishing');
    }

    if (this.state === 'celebrate' && this.stateT > 0.9 / sp) {
      this._set('ribbon');
    }

    if (this.bounce && st.gift) {
      const b = this.bounce; b.t += dt;
      const k = Math.sin(b.t * 16) * Math.exp(-b.t * 4.5) * b.amt;
      st.gift.scale.set(1 - k * 0.5, 1 + k, 1 - k * 0.5);
      if (b.t > 1.4) { st.gift.scale.setScalar(1); this.bounce = null; }
    }

    this._updateShadow();
    this._updateHighlights();
  }

  _updateShadow() {
    const st = this.station, P = st.paper, sh = this.shadow;
    sh.visible = P.visible;
    if (!sh.visible) return;
    const src = st.gift ?? P;
    sh.position.set(src.position.x, st.tableY - 0.0003, src.position.z);   // 포장지 바로 아래, 테이블보 위
    sh.rotation.set(-Math.PI / 2, 0, st.gift ? 0 : st.home.rotY);
    const ws = st.gift ? 0.16 : PAPER * 1.47;              // 캔버스 가장자리 여백 보정
    sh.scale.set(ws, ws, 1);
    sh.material.opacity = st.gift ? 0.45 : 0.3;
  }

  _updateHighlights() {
    const h = this.fx.cfg?.hover, on = this.fx.on && h?.enabled !== false;
    const col = h?.color ?? '#ffd98a', base = h?.intensity ?? 0.35;
    const k = base * (0.75 + 0.25 * Math.sin(this.t * 7));
    const hov = [...this.hovers.values()];
    const is = (kind, i) => on && hov.some((t) => t.kind === kind && (i === undefined || t.i === i));
    this.rack.rolls.forEach((r, i) => this.rack.setHighlight(i, col, (is('roll', i) || this.drag?.i === i) ? k : 0));
    this.ribbons.items.forEach((it, i) => { if (is('ribbon', i) || it.mats) this.ribbons.setHighlight(i, col, is('ribbon', i) ? k : 0); });
    if (this.ballMat?.emissive) { this.ballMat.emissive.set(col); this.ballMat.emissiveIntensity = (is('gift') || is('restart')) ? k * 0.8 : 0; }
  }

}

/* ================================================================== 입력: PC 마우스 + VR 손/컨트롤러
 *   - 당기기   : 롤을 집고(핀치 = 엄지·검지 붙이기 / 컨트롤러 트리거·그립 / 마우스 누르기) 그대로 내 쪽으로 움직이기
 *   - 고르기   : 가리키고 집기 · 손가락 끝으로 톡 · 클릭 (포장하기 버튼, 리본, 다시 하기)
 *   - (VR 덤) 두 손으로 배스밤 감싸 모으기
 */
export function bindSimpleInput({ renderer, scene, camera, controls, flow, fx }) {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const dom = renderer.domElement;

  const pick = () => {
    const T = flow.targets(), map = new Map(), meshes = [];
    for (const t of T) for (const m of t.meshes) { if (!m.visible) continue; map.set(m, t); meshes.push(m); }
    const hit = ray.intersectObjects(meshes, false)[0];
    return hit ? { target: map.get(hit.object), dist: hit.distance, point: hit.point } : null;
  };

  // ---------------- PC: 누른 채로 드래그 = 당기기 (화면을 향한 면 위에서 마우스를 따라감)
  let mouseDown = false;
  const dragPlane = new THREE.Plane(), mousePt = new THREE.Vector3();
  const setMouseRay = (e) => { const r = dom.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); };
  dom.addEventListener('pointermove', (e) => {
    if (renderer.xr.isPresenting) return;
    setMouseRay(e);
    if (mouseDown) { ray.ray.intersectPlane(dragPlane, mousePt); return; }
    const h = pick(); flow.setHover('mouse', h?.target ?? null);
    dom.style.cursor = h ? (h.target.kind === 'roll' ? 'grab' : 'pointer') : '';
  });
  dom.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || renderer.xr.isPresenting) return;
    fx.unlockAudio();
    setMouseRay(e); const h = pick(); if (!h) return;
    mousePt.copy(h.point);
    dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()).negate(), h.point);
    if (flow.press('mouse', h.target, () => mousePt)) {
      mouseDown = true; controls.enabled = false; dom.style.cursor = h.target.kind === 'roll' ? 'grabbing' : '';
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, true);
  addEventListener('pointerup', () => { if (mouseDown) { flow.release('mouse'); mouseDown = false; controls.enabled = true; dom.style.cursor = ''; } });

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
    const s = { i, id: `xr${i}`, rayObj, grip, hand, line, dot, src: null, isHand: false, connected: false, hover: null, hoverDist: 0, touch: null, pressed: false,
      tip: new THREE.Vector3(), palm: new THREE.Vector3(), hasPalm: false, rayO: new THREE.Vector3(), rayD: new THREE.Vector3(0, 0, -1), pt: new THREE.Vector3() };
    sources.push(s);
    rayObj.addEventListener('connected', (e) => { s.src = e.data; s.isHand = !!e.data.hand; s.connected = true; fx.unlockAudio(); });
    rayObj.addEventListener('disconnected', () => { flow.release(s.id); flow.release(s.id + 't'); flow.setHover(s.id, null); Object.assign(s, { connected: false, src: null, hover: null, touch: null, pressed: false }); line.visible = dot.visible = false; });
    const down = () => {
      if (s.pressed) return; s.pressed = true;
      const t = s.touch || s.hover;                       // 손가락으로 대고 있는 것 우선, 아니면 가리키는 것
      if (!t) return;
      // 당기기 위치: 대고 있으면 손가락 끝 / 가리키고 있으면 레이를 따라 같은 거리
      const near = !!s.touch, d0 = s.hoverDist;
      flow.press(s.id, t, () => (near ? s.pt.copy(s.tip) : s.pt.copy(s.rayO).addScaledVector(s.rayD, d0)));
    };
    const up = () => { if (!s.pressed) return; s.pressed = false; flow.release(s.id); };
    rayObj.addEventListener('selectstart', down); rayObj.addEventListener('selectend', up);
    rayObj.addEventListener('squeezestart', down); rayObj.addEventListener('squeezeend', up);
  }
  flow.addEventListener('feedback', (e) => {
    for (const s of sources) s.src?.gamepad?.hapticActuators?.[0]?.pulse?.(Math.min(1, e.strength), 30 + e.strength * 90);
  });
  renderer.xr.addEventListener('sessionstart', () => fx.unlockAudio());

  const _m = new THREE.Matrix4(), _p = new THREE.Vector3();
  function update() {
    if (!renderer.xr.isPresenting) { for (const s of sources) s.line.visible = s.dot.visible = false; return; }
    const T = flow.targets();
    for (const s of sources) {
      if (!s.connected) continue;
      // 가리키기
      s.rayObj.updateMatrixWorld();
      _m.identity().extractRotation(s.rayObj.matrixWorld);
      s.rayO.setFromMatrixPosition(s.rayObj.matrixWorld); s.rayD.set(0, 0, -1).applyMatrix4(_m);
      ray.ray.origin.copy(s.rayO); ray.ray.direction.copy(s.rayD);
      const h = pick();
      s.hover = h?.target ?? null; if (h) s.hoverDist = h.dist;
      // 손가락 끝(손) / 컨트롤러 앞 끝
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
      // 톡: 새로 닿으면 고르기 (롤은 톡으로는 시작하지 않음 — 집어서 당겨야 함)
      const tr = flow.cfg.touchRadius * (s.isHand ? 1 : 1.4);
      let touch = null, td = tr;
      for (const t of T) { const d = t.dist(s.tip); if (d < td) { td = d; touch = t; } }
      if (!AutoWrapFlow.same(touch, s.touch)) {
        s.touch = touch;
        if (touch && touch.kind !== 'roll') flow.press(s.id + 't', touch);
      }
      flow.setHover(s.id, s.touch || s.hover);
      const len = h ? h.dist : 0.6;
      s.line.scale.z = len; s.line.visible = !s.isHand || !!h;
      s.line.material.opacity = h ? 0.9 : 0.25;
      s.dot.visible = !!h; if (h) s.dot.position.copy(ray.ray.origin).addScaledVector(ray.ray.direction, h.dist);
    }
    // (덤) 두 손으로 감싸 모으기
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
