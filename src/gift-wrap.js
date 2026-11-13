/**
 * GiftWrapStation — 블렌더에서 만든 배스밤 + 차킨 포장지(GiftWrap.glb)를 쓰는 포장 인터랙션
 *
 * GLB 구성 (WorkTable.blend 에서 내보냄)
 *   BathBomb  : 지름 9cm 구
 *   WrapPaper : 40cm 정사각 포장지. 셰이프 키(모프 타깃)
 *               Corner1~4_Half (꼭짓점이 반쯤 감쌈) · Corner1~4_Fold (목까지 감쌈) · Wrapped (주름·비틀린 목·부채 머리)
 *
 *   const station = new GiftWrapStation(rack, gltf.scene, { parent: workspace });
 *   // 이후 rack.grab / release / update 로 손·컨트롤러·마우스 모두 동작
 *
 * 흐름
 *   - 처음: 포장지는 없음(숨김). 배스밤만 랙 오른쪽 테이블 위에 놓여 있음
 *   - 랙에서 종이를 당겨 잘라 테이블(또는 바닥)에 내려놓은 다음, 배스밤을 그 종이 위로 옮기면
 *     그제서야 그 자리에 포장지가 나타나고(그 종이 무늬로, 40cm 정사각으로 재단) 접을 수 있게 됨
 *   - 꼭짓점(흰 점)을 잡아 배스밤 위로 들어 올리면 그 꼭짓점이 감싸며 올라옴. 충분히 올리고 놓으면 고정
 *   - 4개 다 접으면 차킨 모양으로 마무리 → 선물째로 들어 옮길 수 있음
 *   - 종이가 아직 없거나 접지 않았으면 배스밤을 자유롭게 들어 다른 종이 위로 옮길 수 있음
 * 이벤트: 'placed' | 'fold' | 'wrapped'
 */
import * as THREE from 'three';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion();
const smooth = (t) => t * t * (3 - 2 * t);

export class GiftWrapStation extends THREE.EventDispatcher {
  constructor(rack, scene, opts = {}) {
    super();
    this.rack = rack;
    this.root = opts.parent ?? rack.root.parent ?? rack.root;
    this.ball = scene.getObjectByName('BathBomb');
    this.paper = scene.getObjectByName('WrapPaper');
    this.paperMesh = this.paper.isMesh ? this.paper : this.paper.getObjectByProperty('isMesh', true);
    this.root.add(this.ball, this.paper);
    this.R = 0.045;
    this.tableY = this.paper.position.y;
    this.home = {
      paper: this.paper.position.clone(),
      // 배스밤의 처음 자리: 랙 오른쪽 (포장 자리는 블렌더 장면에서 가운데 — x만 오른쪽으로 옮김)
      ball: new THREE.Vector3(opts.ballHomeX ?? 0.4, this.ball.position.y, this.ball.position.z),
      rotY: this.paper.rotation.y,
    };
    this.foldThreshold = opts.foldThreshold ?? 0.55;
    this.auto = !!opts.auto;      // true = 자동 진행: 꼭짓점 표시·잡기 없음, wrap-flow.js 가 target[] 을 정함

    const dict = this.paperMesh.morphTargetDictionary;
    this.mHalf = [1, 2, 3, 4].map((k) => dict[`Corner${k}_Half`]);
    this.mFold = [1, 2, 3, 4].map((k) => dict[`Corner${k}_Fold`]);
    this.mWrap = dict['Wrapped'];
    this.paperMesh.frustumCulled = false;

    // 꼭짓점 정점 찾기 (기본 위치에서 네 구석) + 그 정점을 움직이는 Corner 키
    const geo = this.paperMesh.geometry, P = geo.attributes.position, M = geo.morphAttributes.position;
    this.corners = [];
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      let best = -1, bv = -Infinity;
      for (let i = 0; i < P.count; i++) { const v = P.getX(i) * sx + P.getZ(i) * sz; if (v > bv) { bv = v; best = i; } }
      let key = 0, km = -1;
      for (let k = 0; k < 4; k++) { const a = M[this.mFold[k]]; const m = Math.hypot(a.getX(best), a.getY(best), a.getZ(best)); if (m > km) { km = m; key = k; } }
      this.corners.push({ index: best, key });
    }

    // 재질: 앞면(처음 위) = 흰 종이, 뒷면 = 무늬 (포장하면 무늬가 바깥)
    this.mat = this._paperMaterial();
    this.paperMesh.material = this.mat;

    const hm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false });
    this.hints = [0, 1, 2, 3].map(() => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.007, 12, 8), hm); this.root.add(m); return m; });

    rack.addGrabbable(this);
    this.reset();
  }

  _paperMaterial() {
    const uniforms = { uRep: { value: new THREE.Vector2(1, 1) }, uBack: { value: new THREE.Color('#efe9df') } };
    const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.6, map: new THREE.Texture() });
    m.userData.uniforms = uniforms;
    m.customProgramCacheKey = () => 'giftwrap-paper';
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec2 uRep; uniform vec3 uBack;')
        .replace('#include <map_fragment>', 'diffuseColor *= gl_FrontFacing ? vec4(uBack, 1.0) : texture2D(map, vMapUv * uRep);');
    };
    return m;
  }

  /** 포장지 무늬·뒷면 색 = 랙 i번 롤과 같게 (무늬 크기도 같게) */
  _setPattern(i) {
    const r = this.rack.rolls[i]; if (!r) return;
    this.mat.map = r.texture; this.mat.needsUpdate = true;
    this.mat.userData.uniforms.uRep.value.set(0.40 / r.Tu, 0.40 / r.Tv);
    this.mat.userData.uniforms.uBack.value.copy(r.back);   // 뒷면(위로 보이는 면) 색도 그 롤의 뒷면 색으로
  }

  reset() {
    if (this.heldBy) { const h = this.heldBy; this.heldBy = null; this.rack.release(h); }
    if (this.gift) { this.root.attach(this.paper); this.root.attach(this.ball); this.gift.removeFromParent(); this.gift = null; }
    this.paper.position.copy(this.home.paper); this.paper.rotation.set(0, this.home.rotY, 0);
    this.paper.visible = false;   // 종이는 잘라서 배스밤을 올려놓기 전까지 없음
    this.hasSheet = false;
    this.ball.position.copy(this.home.ball); this.ball.quaternion.identity();
    this.f = [0, 0, 0, 0]; this.target = [0, 0, 0, 0]; this.locked = [false, false, false, false];
    this.kWrap = 0; this.corner = -1; this.vel = 0;
    this.state = 'free';   // 배스밤만 홀더 오른쪽에 놓인 상태 — 자유롭게 들어 옮길 수 있음
    this._applyMorph();
  }

  get folded() { return this.locked.filter(Boolean).length; }
  getMeshes() { return [this.ball, this.paperMesh]; }

  _applyMorph() {
    const I = this.paperMesh.morphTargetInfluences, kw = this.kWrap;
    for (let k = 0; k < 4; k++) {
      const f = this.f[k];
      I[this.mHalf[k]] = (f <= 0.5 ? 2 * f : 2 - 2 * f) * (1 - kw);
      I[this.mFold[k]] = Math.max(0, 2 * f - 1) * (1 - kw);
    }
    I[this.mWrap] = smooth(kw);
  }

  /** 꼭짓점 c 의 현재 위치 (this.root 로컬) */
  _cornerPos(c, out) {
    const geo = this.paperMesh.geometry, P = geo.attributes.position, M = geo.morphAttributes.position, I = this.paperMesh.morphTargetInfluences;
    out.set(P.getX(c.index), P.getY(c.index), P.getZ(c.index));
    for (let t = 0; t < I.length; t++) if (I[t]) { out.x += M[t].getX(c.index) * I[t]; out.y += M[t].getY(c.index) * I[t]; out.z += M[t].getZ(c.index) * I[t]; }
    this.paperMesh.updateWorldMatrix(true, false);
    return this.root.worldToLocal(this.paperMesh.localToWorld(out));
  }

  _ballFree() { return this.folded === 0 && this.f.every((x) => x < 0.05); }

  /* ------------------------------------------------ rack grabbable */
  grabDistance(p) {
    if (this.auto) return null;   // 자동 진행(wrap-flow.js)에서는 잡기 대신 선택/모으기로 조작
    const lp = this.root.worldToLocal(_v.copy(p));
    if (this.state === 'wrapped') return lp.distanceTo(_w.copy(this.gift.position).setY(this.tableY + this.R)) - this.R - 0.03;
    if (this.state === 'free' || this.state === 'falling') return lp.distanceTo(this.ball.position) - this.R;
    if (this.state === 'onPaper') {
      let best = Infinity;
      if (this.ballOnSheet()) this.corners.forEach((c) => { if (!this.locked[c.key]) best = Math.min(best, lp.distanceTo(this._cornerPos(c, _w)) - 0.012); });
      if (this._ballFree()) best = Math.min(best, lp.distanceTo(this.ball.position) - this.R);
      return best;
    }
    return null;
  }

  grab(hand, p) {
    const lp = this.root.worldToLocal(_v.copy(p));
    if (this.state === 'wrapped') { hand.attach(this.gift); this.state = 'giftHeld'; this.heldBy = hand; return true; }
    if (this.state === 'onPaper') {
      let bc = null, bd = Infinity;
      if (this.ballOnSheet()) this.corners.forEach((c) => { if (this.locked[c.key]) return; const d = lp.distanceTo(this._cornerPos(c, _w)); if (d < bd) { bd = d; bc = c; } });
      const dBall = this._ballFree() ? lp.distanceTo(this.ball.position) - this.R : Infinity;
      if (bc && bd - 0.012 <= dBall) { this.corner = bc.key; this.heldBy = hand; this.state = 'folding'; return true; }
      if (dBall === Infinity) return false;
    }
    if (this.state === 'free' || this.state === 'falling' || this.state === 'onPaper') {
      hand.attach(this.ball); this.state = 'held'; this.heldBy = hand; return true;
    }
    return false;
  }

  release(hand) {
    if (hand !== this.heldBy) return;
    this.heldBy = null;
    if (this.state === 'held') { this.root.attach(this.ball); this.state = 'falling'; this.vel = 0; }
    else if (this.state === 'giftHeld') { this.root.attach(this.gift); this.state = 'giftFalling'; this.vel = 0; }
    else if (this.state === 'folding') {
      const k = this.corner;
      this.target[k] = this.f[k] >= this.foldThreshold ? 1 : 0;
      this.locked[k] = this.target[k] === 1;
      this.corner = -1; this.state = 'onPaper';
      if (this.locked[k]) this.dispatchEvent({ type: 'fold', corner: k, count: this.folded });
    }
  }

  /* ------------------------------------------------ 매 프레임 */
  update(dt) {
    if (this.state === 'falling') {
      this.vel = Math.min(this.vel + 9.8 * dt, 3);
      this.ball.position.y -= this.vel * dt;
      const floor = this.tableY + this.R + 0.0006;
      if (this.ball.position.y <= floor) {
        this.ball.position.y = floor; this.vel = 0;
        const pc = this.rack.restingPieceAt(this.root.localToWorld(_v.copy(this.ball.position)));
        if (pc) this._moveSheetTo(pc);
        this.state = (pc || this._overSheet()) ? 'placing' : 'free';
      }
    } else if (this.state === 'placing') {
      const c = this.paper.position, k = 1 - Math.exp(-7 * dt), before = _w.copy(this.ball.position);
      this.ball.position.x += (c.x - this.ball.position.x) * k;
      this.ball.position.z += (c.z - this.ball.position.z) * k;
      const mv = _v.subVectors(this.ball.position, before);
      if (mv.lengthSq() > 1e-10) this.ball.quaternion.premultiply(_q.setFromAxisAngle(_w.set(mv.z, 0, -mv.x).normalize(), mv.length() / this.R));
      if (Math.hypot(this.ball.position.x - c.x, this.ball.position.z - c.z) < 0.001) { this.state = 'onPaper'; this.dispatchEvent({ type: 'placed' }); }
    } else if (this.state === 'giftFalling') {
      this.vel = Math.min(this.vel + 9.8 * dt, 3);
      this.gift.position.y -= this.vel * dt;
      this.gift.quaternion.slerp(_q.identity(), 1 - Math.exp(-6 * dt));
      if (this.gift.position.y <= this.tableY) { this.gift.position.y = this.tableY; this.state = 'wrapped'; }
    }

    if (this.state === 'onPaper' || this.state === 'folding') {
      if (this.state === 'folding' && this.heldBy) {
        this.heldBy.updateWorldMatrix(true, false);
        const hp = this.root.worldToLocal(this.heldBy.getWorldPosition(_v));
        this.target[this.corner] = THREE.MathUtils.clamp((hp.y - this.tableY) / (2 * this.R + 0.05), 0, 1);
      }
      for (let k = 0; k < 4; k++) this.f[k] += (this.target[k] - this.f[k]) * (1 - Math.exp(-(k === this.corner ? 16 : 7) * dt));
      if (this.locked.every(Boolean) && this.f.every((x) => x > 0.98)) this.kWrap = Math.min(1, this.kWrap + dt / 0.8);
      this._applyMorph();
      if (this.kWrap >= 1) this._finish();
    }
    const show = !this.auto && (this.state === 'onPaper') && this.ballOnSheet();
    this.corners.forEach((c, i) => { const h = this.hints[i]; h.visible = show && !this.locked[c.key]; if (h.visible) this._cornerPos(c, h.position); });
  }

  ballOnSheet() { return this.hasSheet && Math.hypot(this.ball.position.x - this.paper.position.x, this.ball.position.z - this.paper.position.z) < 0.01; }
  _overSheet() {
    if (!this.hasSheet) return false;   // 종이가 아직 없으면 그 자리에 놓아도 포장 시작되지 않음
    const lp = this.paper.worldToLocal(this.root.localToWorld(_v.copy(this.ball.position)));
    return this._ballFree() && Math.abs(lp.x) < 0.2 && Math.abs(lp.z) < 0.2;
  }

  /** 잘라서 테이블에 놓은 종이로 포장지 교체 (그 자리·방향·무늬로 / 40cm 정사각으로 재단) — 이때 처음으로 종이가 나타남 */
  _moveSheetTo(pc) {
    if (!this._ballFree()) return;
    const c = this.root.worldToLocal(pc.mesh.getWorldPosition(new THREE.Vector3()));
    const ex = new THREE.Vector3(1, 0, 0).applyQuaternion(pc.mesh.getWorldQuaternion(new THREE.Quaternion()));
    this.paper.position.set(c.x, this.tableY, c.z);
    this.paper.rotation.set(0, -Math.atan2(ex.z, ex.x), 0);
    this.paper.visible = true; this.hasSheet = true;
    this._setPattern(pc.roll);
    this.rack.takePiece(pc); pc.mesh.removeFromParent(); pc.mesh.geometry.dispose(); pc.mesh.material.dispose();
  }

  _finish() {
    const g = new THREE.Group(); g.name = 'Gift';
    g.position.set(this.ball.position.x, this.tableY, this.ball.position.z);
    this.root.add(g); g.attach(this.paper); g.attach(this.ball);
    this.gift = g; this.state = 'wrapped';
    this.hints.forEach((h) => (h.visible = false));
    this.dispatchEvent({ type: 'wrapped', gift: g });
  }
}
