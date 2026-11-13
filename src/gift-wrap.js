/**
 * GiftWrapStation — 배스밤을 포장지로 싸는 인터랙션 (WrappingPaperRack 에 붙여 씀)
 *
 *   const station = new GiftWrapStation(rack, { radius: 0.045 });
 *   // 이후 rack.grab / rack.release / rack.update 만 쓰면 됨 (손·컨트롤러·마우스 공통)
 *
 * 흐름
 *   1. 배스밤을 잡아서 바닥(테이블)에 놓인 자른 포장지 위에서 놓으면 → 종이 가운데로 자리 잡음
 *   2. 종이 꼭짓점을 잡아 배스밤 위로 들어 올리면 종이가 구를 감싸며 올라옴
 *      충분히 올린 뒤 놓으면 그 꼭짓점은 접힌 채 고정 (덜 올리면 다시 펴짐)
 *   3. 꼭짓점 4개를 모두 접으면 포장 완료 → 위에 리본, 선물째로 들고 옮길 수 있음
 *   - 아직 아무 꼭짓점도 안 접었으면 배스밤을 다시 들어 내릴 수 있음
 *
 * 이벤트: station.addEventListener('placed' | 'fold' | 'wrapped', e => ...)
 */
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion();
const smooth = (t) => t * t * (3 - 2 * t);

function bathBombTexture(hue) {
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = `hsl(${hue}, 55%, 78%)`; g.fillRect(0, 0, S, S);
  // 가루 얼룩 + 알갱이
  for (let i = 0; i < 260; i++) {
    const r = 6 + Math.random() * 40;
    g.fillStyle = `hsla(${hue + (Math.random() - 0.5) * 30}, 50%, ${70 + Math.random() * 20}%, 0.25)`;
    g.beginPath(); g.arc(Math.random() * S, Math.random() * S, r, 0, Math.PI * 2); g.fill();
  }
  const sprinkle = [(hue + 150) % 360, (hue + 40) % 360, 50];
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `hsl(${sprinkle[i % 3]}, 70%, ${55 + Math.random() * 25}%)`;
    g.fillRect(Math.random() * S, Math.random() * S, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function bumpTexture() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), d = g.createImageData(S, S);
  for (let i = 0; i < S * S; i++) { const v = 120 + Math.random() * 100; d.data.set([v, v, v, 255], i * 4); }
  g.putImageData(d, 0, 0);
  return new THREE.CanvasTexture(c);
}

export class GiftWrapStation extends THREE.EventDispatcher {
  constructor(rack, opts = {}) {
    super();
    this.rack = rack;
    this.R = opts.radius ?? 0.045;
    this.spawn = opts.spawn ?? new THREE.Vector3(0.40, 0, 0.22);      // rack.root 로컬 (y 는 테이블 위로 자동)
    this.grid = opts.grid ?? 56;
    this.foldThreshold = opts.foldThreshold ?? 0.55;
    this.root = rack.root;
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(this.R, 48, 32),
      new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, bumpScale: 1.2 }));
    this.ball.name = 'BathBomb';
    this.ball.material.bumpMap = bumpTexture();
    this.root.add(this.ball);
    this.hints = [];
    const hm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false });
    for (let k = 0; k < 4; k++) { const m = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), hm); m.visible = false; this.root.add(m); this.hints.push(m); }
    rack.addGrabbable(this);
    this.reset();
  }

  get tableY() { return this.rack.config.surfaceY; }

  /** 처음 상태로: 진행 중인 포장은 종이를 원래대로 돌리고, 완성된 선물은 지운 뒤 새 배스밤 */
  reset() {
    if (this.heldBy) { this.rack.release(this.heldBy); this.heldBy = null; }
    if (this.gift) {
      this.gift.traverse((o) => { if (o.isMesh && o !== this.ball) o.geometry.dispose(); });
      if (this.wrap) { this.wrap.piece.mesh.material.dispose(); this.wrap.piece.mesh.geometry.dispose(); this.wrap = null; }
      this.root.attach(this.ball); this.gift.removeFromParent(); this.gift = null;
    } else if (this.wrap) this._disposeWrap(true);
    if (this.ball.parent !== this.root) this.root.attach(this.ball);
    this.ball.material.map?.dispose();
    this.ball.material.map = bathBombTexture(Math.floor(Math.random() * 360)); this.ball.material.needsUpdate = true;
    this.ball.position.set(this.spawn.x, this.tableY + this.R + 0.001, this.spawn.z);
    this.ball.quaternion.identity();
    this.state = 'free';            // free | held | falling | placing | onPaper | wrapped | giftHeld | giftFalling
    this.vel = 0; this.heldBy = null; this.corner = -1;
  }

  /** 마우스 레이캐스트용 */
  getMeshes() { return [this.ball, ...(this.wrap ? [this.wrap.mesh] : []), ...(this.gift ? [this.gift] : [])].filter(Boolean); }

  /* ------------------------------------------------ rack grabbable 인터페이스 */
  grabDistance(p) {
    const lp = this.root.worldToLocal(_v.copy(p));
    if (this.state === 'wrapped') return lp.distanceTo(this.gift.position) - this.R - 0.02;
    if (this.state === 'free' || this.state === 'falling') return lp.distanceTo(this.ball.position) - this.R;
    if (this.state === 'onPaper') {
      let best = Infinity;
      this.wrap.corners.forEach((c, k) => {
        if (this.wrap.locked[k]) return;
        best = Math.min(best, lp.distanceTo(this._vertexPos(c.index, _w)) - 0.01);
      });
      if (this.wrap.folded() === 0) best = Math.min(best, lp.distanceTo(this.ball.position) - this.R);
      return best;
    }
    return null;
  }

  grab(hand, p) {
    const lp = this.root.worldToLocal(_v.copy(p));
    if (this.state === 'wrapped') {
      hand.attach(this.gift); this.state = 'giftHeld'; this.heldBy = hand; return true;
    }
    if (this.state === 'onPaper') {
      // 가장 가까운 꼭짓점 vs 배스밤
      let bk = -1, bd = Infinity;
      this.wrap.corners.forEach((c, k) => { if (this.wrap.locked[k]) return; const d = lp.distanceTo(this._vertexPos(c.index, _w)); if (d < bd) { bd = d; bk = k; } });
      const dBall = this.wrap.folded() === 0 ? lp.distanceTo(this.ball.position) - this.R : Infinity;
      if (bk >= 0 && bd - 0.01 <= dBall) { this.corner = bk; this.heldBy = hand; this.state = 'folding'; return true; }
      if (dBall < Infinity) { this._disposeWrap(true); }          // 배스밤 다시 들기 → 종이는 원래대로
      else return false;
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
      const k = this.corner, w = this.wrap;
      w.target[k] = w.f[k] >= this.foldThreshold ? 1 : 0;
      w.locked[k] = w.target[k] === 1;
      this.corner = -1; this.state = 'onPaper';
      if (w.locked[k]) this.dispatchEvent({ type: 'fold', corner: k, count: w.locked.filter(Boolean).length });
    }
  }

  /* ------------------------------------------------ 매 프레임 */
  update(dt) {
    const g = 9.8;
    if (this.state === 'falling') {
      this.vel = Math.min(this.vel + g * dt, 3);
      this.ball.position.y -= this.vel * dt;
      const pc = this.rack.restingPieceAt(this.root.localToWorld(_v.copy(this.ball.position)));
      const floor = (pc ? pc.mesh.position.y : this.tableY) + this.R + 0.001;
      if (this.ball.position.y <= floor) {
        this.ball.position.y = floor;
        if (pc) this._startWrap(pc); else { this.state = 'free'; this.vel = 0; }
      }
    } else if (this.state === 'placing') {
      // 종이 가운데로 굴러가 자리 잡기
      const w = this.wrap, k = 1 - Math.exp(-7 * dt);
      const before = _w.copy(this.ball.position);
      this.ball.position.x += (w.center.x - this.ball.position.x) * k;
      this.ball.position.z += (w.center.z - this.ball.position.z) * k;
      const mv = _v.subVectors(this.ball.position, before);
      if (mv.lengthSq() > 1e-10) {                       // 굴러가는 회전
        const axis = _w.crossVectors(UP, mv).normalize();
        this.ball.quaternion.premultiply(_q.setFromAxisAngle(axis, mv.length() / this.R));
      }
      if (this.ball.position.distanceTo(_w.set(w.center.x, this.ball.position.y, w.center.z)) < 0.001) {
        this.state = 'onPaper'; this.dispatchEvent({ type: 'placed' });
      }
    } else if (this.state === 'giftFalling') {
      this.vel = Math.min(this.vel + g * dt, 3);
      this.gift.position.y -= this.vel * dt;
      this.gift.quaternion.slerp(_q.identity(), 1 - Math.exp(-6 * dt));
      const floor = this.tableY + this.R + 0.003;
      if (this.gift.position.y <= floor) { this.gift.position.y = floor; this.state = 'wrapped'; }
    }

    if (this.wrap && this.wrap.mesh.parent && this.state !== 'wrapped' && this.state !== 'giftHeld' && this.state !== 'giftFalling') {
      const w = this.wrap;
      if (this.state === 'folding' && this.heldBy) {
        // 손 높이로 접힘 정도: 테이블에서 배스밤 꼭대기 위까지 들어 올리면 1
        this.heldBy.updateWorldMatrix(true, false);
        const hp = this.root.worldToLocal(this.heldBy.getWorldPosition(_v));
        w.target[this.corner] = THREE.MathUtils.clamp((hp.y - this.tableY) / (2 * this.R + 0.05), 0, 1);
      }
      for (let k = 0; k < 4; k++) w.f[k] += (w.target[k] - w.f[k]) * (1 - Math.exp(-(this.state === 'folding' && k === this.corner ? 18 : 7) * dt));
      this._shapeWrap();
      // 꼭짓점 힌트: 손/마우스가 가까울 때만 은은하게
      w.corners.forEach((c, k) => {
        const h = this.hints[k]; h.visible = !w.locked[k] && this.state === 'onPaper';
        if (h.visible) this._vertexPos(c.index, h.position);
      });
      if (w.locked.every(Boolean) && w.f.every((f) => f > 0.985)) this._finishWrap();
    } else this.hints.forEach((h) => (h.visible = false));
  }

  /* ------------------------------------------------ 포장 시트 */
  _startWrap(pc) {
    this.rack.takePiece(pc);
    pc.mesh.visible = false;
    const T = pc.mesh.position.y, N = this.grid;
    const geo = new THREE.BufferGeometry();
    const n = (N + 1) * (N + 1), flat = new Float32Array(n * 3), pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), idx = [];
    pc.mesh.updateMatrix();
    for (let r = 0; r <= N; r++) for (let c = 0; c <= N; c++) {
      const i = r * (N + 1) + c;
      _v.set((c / N - 0.5) * pc.width, pc.length / 2 - (r / N) * pc.length, 0).applyMatrix4(pc.mesh.matrix);
      flat[i * 3] = _v.x; flat[i * 3 + 1] = T; flat[i * 3 + 2] = _v.z;
      uv[i * 2] = c / N; uv[i * 2 + 1] = 1 - r / N;
    }
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const a = r * (N + 1) + c, b = a + N + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, pc.mesh.material);
    mesh.name = 'WrapSheet'; mesh.frustumCulled = false;
    this.root.add(mesh);
    // 종이 가운데 (평면)
    _v.set(0, 0, 0).applyMatrix4(pc.mesh.matrix);
    const center = new THREE.Vector3(_v.x, T, _v.z);
    const cornersIdx = [0, N, (N + 1) * N, (N + 1) * (N + 1) - 1];
    const ex = new THREE.Vector3(1, 0, 0).applyQuaternion(pc.mesh.quaternion).setY(0).normalize();
    const ey = new THREE.Vector3(0, 1, 0).applyQuaternion(pc.mesh.quaternion).setY(0).normalize();
    this.wrap = {
      piece: pc, mesh, flat, N, T, center, ex, ey, hw: pc.width / 2, hl: pc.length / 2,
      fanAxis: Math.atan2(ex.z, ex.x),
      corners: cornersIdx.map((index) => ({ index })),
      f: [0, 0, 0, 0], target: [0, 0, 0, 0], locked: [false, false, false, false],
      folded() { return this.locked.filter(Boolean).length + (this.f.some((x) => x > 0.05) ? 0.001 : 0); },
    };
    this.ball.position.y = T + this.R + 0.001;
    this.state = 'placing';
    this._shapeWrap();
  }

  /** 차킨 포장(茶巾包み) 단면 — 배스밤 중심 기준 (ρ = 수평 거리, h = 높이)
   *  ① 아래: 구를 감쌈  ② 접점→목: 곧게 모이며 비틀림  ③ 목 위 머리: 부채처럼 퍼짐
   *  머리 테두리는 '모서리를 안으로 접은' 것처럼 어느 방향이든 같은 높이 (남는 길이는 주름 깊이로 흡수)
   *  sMax = 이 방향으로 종이 가장자리까지 거리, phi = 방향각 */
  _profile(s, Rw, sMax = s, phi = 0) {
    const P = this._prof || (this._prof = {});
    const hN = this.R + 0.016, neckR = 0.006;
    const th1 = Math.PI - Math.acos(Math.min(0.999, Rw / Math.hypot(hN, neckR)));
    const A = th1 * Rw;
    const tx = Rw * Math.sin(th1), ty = -Rw * Math.cos(th1);
    const B = Math.hypot(neckR - tx, hN - ty);
    P.th1 = th1; P.A = A; P.B = B; P.hN = hN; P.neckR = neckR;
    if (s <= A) { const t = s / Rw; P.r = Rw * Math.sin(t); P.h = -Rw * Math.cos(t); P.zone = 0; P.q = t / th1; return P; }
    if (s <= A + B) { const t = (s - A) / B; P.r = tx + (neckR - tx) * t; P.h = ty + (hN - ty) * t; P.zone = 1; P.q = t; return P; }
    const tot = Math.max(0.02, sMax - A - B), q = THREE.MathUtils.clamp((s - A - B) / tot, 0, 1);
    const H = 0.085;                                        // 머리 길이 (테두리 높이 고정)
    const u = H * q, a = 0.12 + 0.5 * smooth(q), aAvg = (0.12 + a) / 2;   // 거의 위로 서서 조금씩 벌어짐
    const c2 = Math.cos(2 * (phi - (this.wrap?.fanAxis ?? 0)));
    const fan = 1 + 0.8 * c2;                                // 납작한 부채: 한 축으로 넓고 다른 축으로 얇음
    P.r = neckR + u * Math.sin(aAvg) * fan + 0.004 * q * Math.max(0, c2);
    P.h = hN + u * Math.cos(aAvg) * (1 - 0.06 * c2);
    P.zone = 2; P.q = q; P.excess = tot;
    return P;
  }

  _shapeWrap() {
    const w = this.wrap, { flat, N } = w, Pa = w.mesh.geometry.attributes.position;
    const C = this.ball.position, Rb = this.R;
    const ca = w.corners.map((c) => Math.atan2(flat[c.index * 3 + 2] - C.z, flat[c.index * 3] - C.x));
    const order = [0, 1, 3, 2].sort((a, b) => ca[a] - ca[b]);
    const n = (N + 1) * (N + 1), PLEATS = 11;
    for (let i = 0; i < n; i++) {
      const dx = flat[i * 3] - C.x, dz = flat[i * 3 + 2] - C.z;
      const s = Math.hypot(dx, dz), ux = s > 1e-6 ? dx / s : 1, uz = s > 1e-6 ? dz / s : 0;
      const phi = Math.atan2(dz, dx);
      let a = order[3], b = order[0], t;
      for (let j = 0; j < 4; j++) { const A = order[j], B = order[(j + 1) % 4]; const lo = ca[A]; let hi = ca[B]; if (j === 3) hi += Math.PI * 2;
        let ph = phi; if (j === 3 && ph < lo) ph += Math.PI * 2;
        if (ph >= lo && ph <= hi) { a = A; b = B; t = (ph - lo) / (hi - lo || 1); break; } }
      if (t === undefined) t = 0;
      const wv = w.f[a] + (w.f[b] - w.f[a]) * smooth(t);
      const Rw = Rb + 0.0022 + 0.0006 * Math.min(1, s / 0.3);
      // 이 방향으로 종이 가장자리까지 거리
      const de = Math.abs(ux * w.ex.x + uz * w.ex.z), dl = Math.abs(ux * w.ey.x + uz * w.ey.z);
      const sMax = Math.min(de > 1e-4 ? w.hw / de : 9, dl > 1e-4 ? w.hl / dl : 9);

      // (1) 접는 중: 구를 Θ 까지 감싸고 나머지는 접선 방향 직선
      const pr = this._profile(s, Rw, sMax, phi), th1 = pr.th1;
      const fin = { r: pr.r, h: pr.h, zone: pr.zone, q: pr.q, excess: pr.excess };
      const Th = th1 * Math.min(1, wv / 0.85);
      let r0, h0;
      if (s / Rw <= Th) { r0 = Rw * Math.sin(s / Rw); h0 = -Rw * Math.cos(s / Rw); }
      else { const e = s - Th * Rw; r0 = Rw * Math.sin(Th) + Math.cos(Th) * e; h0 = -Rw * Math.cos(Th) + Math.sin(Th) * e; }
      // (2) 완성 모양으로 (거의 다 접었을 때 목이 조여지고 머리가 퍼짐)
      const k = smooth(THREE.MathUtils.clamp((wv - 0.72) / 0.28, 0, 1));
      let r = r0 + (fin.r - r0) * k, h = h0 + (fin.h - h0) * k;
      // (3) 주름: 목 쪽은 촘촘하게, 머리는 크고 부드러운 아코디언 주름. 남는 종이가 많은 방향일수록 깊게.
      //     바깥쪽으로만 밀어서 배스밤을 뚫지 않음
      const fine = Math.sin(14 * phi + 0.5 * Math.sin(5 * phi));
      const wide = Math.sin(8 * phi + 0.6 * Math.sin(3 * phi + 1.3));
      let amp = 0, wave = fine;
      if (fin.zone === 0) amp = 0.0016 * smooth(THREE.MathUtils.clamp((fin.q - 0.6) / 0.4, 0, 1));
      else if (fin.zone === 1) amp = 0.0012 + 0.0022 * fin.q;
      else {
        const deep = THREE.MathUtils.clamp(fin.excess / 0.12, 0.6, 2.2);
        amp = (0.004 + 0.014 * smooth(fin.q)) * deep;
        const m = smooth(Math.min(1, fin.q * 2.5)); wave = fine * (1 - m) + wide * m;
      }
      amp *= k;
      r += amp * (0.55 + 0.45 * wave);
      if (fin.zone === 2) h += k * 0.005 * fin.q * Math.cos(8 * phi + 0.9);                   // 테두리 살짝 물결
      // (4) 목 비틀림: 목으로 갈수록 돌아가고 머리는 그 각도 유지
      const tw = 0.55 * k * (fin.zone === 0 ? 0 : fin.zone === 1 ? smooth(fin.q) : 1);
      const ang = phi + tw;
      Pa.setXYZ(i, C.x + r * Math.cos(ang), Math.max(C.y + h, w.T + 0.0003), C.z + r * Math.sin(ang));
    }
    Pa.needsUpdate = true; w.mesh.geometry.computeVertexNormals(); w.mesh.geometry.computeBoundingSphere();
  }

  _vertexPos(i, out) { const P = this.wrap.mesh.geometry.attributes.position; return out.set(P.getX(i), P.getY(i), P.getZ(i)); }

  _finishWrap() {
    const w = this.wrap, C = this.ball.position.clone();
    const gift = new THREE.Group(); gift.name = 'Gift'; gift.position.copy(C);
    this.root.add(gift);
    w.mesh.geometry.translate(-C.x, -C.y, -C.z); w.mesh.position.set(0, 0, 0); gift.add(w.mesh);
    gift.attach(this.ball);
    this.gift = gift; this.state = 'wrapped';
    this.hints.forEach((h) => (h.visible = false));
    this.dispatchEvent({ type: 'wrapped', gift });
  }

  _disposeWrap(restore) {
    const w = this.wrap; if (!w) return;
    w.mesh.removeFromParent(); w.mesh.geometry.dispose();
    if (restore) { w.piece.mesh.visible = true; this.rack.restorePiece(w.piece); }
    else { w.piece.mesh.material.dispose(); w.piece.mesh.geometry.dispose(); }
    this.wrap = null; this.hints.forEach((h) => (h.visible = false));
    if (this.state !== 'held') this.state = 'free';
  }

  clearGift() { this.reset(); }
}
