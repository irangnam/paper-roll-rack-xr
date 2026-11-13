/**
 * Ribbons — 리본 상자 안의 리본(블렌더 Ribbon_0N.glb)을 꺼내 포장된 선물의 목에 다는 인터랙션
 *
 *   const ribbons = new Ribbons(rack, box, station, [{ scene: gltf.scene, slot: { pos: [x,y,z], rot: [x,y,z] } }]);
 *
 * - 상자 뚜껑이 열려 있을 때 리본을 잡아 꺼낼 수 있음 (손 주먹 / 컨트롤러 그립 / 마우스 드래그)
 * - 포장 완료된 선물의 목 근처에서 놓으면 목 앞쪽에 '착' 붙음 (선물을 들면 같이 움직임)
 * - 다른 곳에서 놓으면 원래 칸으로 돌아감 · 붙은 리본을 다시 잡으면 떼어 다른 리본으로 바꿀 수 있음
 */
import * as THREE from 'three';

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

export class Ribbons extends THREE.EventDispatcher {
  constructor(rack, box, station, defs) {
    super();
    this.rack = rack; this.box = box; this.station = station;
    this.items = defs.map((d, i) => {
      const obj = d.scene.getObjectByName(`Ribbon_0${i + 1}`) || d.scene.children[0];
      obj.position.fromArray(d.slot.pos); obj.rotation.fromArray(d.slot.rot);
      box.root.add(obj);
      const it = { i, obj, home: { pos: obj.position.clone(), quat: obj.quaternion.clone() }, state: 'home', hand: null, anim: 0 };
      obj.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(obj);
      it.radius = bb.getSize(_v).length() / 2;
      return it;
    });
    this.onGift = null;
    rack.addGrabbable(this);
  }

  getMeshes() { const a = []; for (const it of this.items) it.obj.traverse((o) => o.isMesh && a.push(o)); return a; }

  _center(it, out) { return it.obj.getWorldPosition(out); }

  grabDistance(p) {
    let best = Infinity;
    for (const it of this.items) {
      if (it.state === 'held') continue;
      if (it.state === 'home' && this.box.angle < 0.9) continue;          // 뚜껑이 열려야 꺼낼 수 있음
      best = Math.min(best, p.distanceTo(this._center(it, _v)) - it.radius * 0.7);
    }
    return best;
  }

  grab(hand, p) {
    let bi = null, bd = Infinity;
    for (const it of this.items) {
      if (it.state === 'held' || (it.state === 'home' && this.box.angle < 0.9)) continue;
      const d = p.distanceTo(this._center(it, _v)) - it.radius * 0.7;
      if (d < bd) { bd = d; bi = it; }
    }
    if (!bi) return false;
    if (bi.state === 'onGift') this.onGift = null;
    hand.attach(bi.obj); bi.state = 'held'; bi.hand = hand; this.held = bi;
    return true;
  }

  /** 선물의 목 앞 (월드) 위치·방향: 리본 앞면이 바깥(보는 쪽)을 향하게 */
  _neckFrame(gift) {
    const st = this.station, R = st.R;
    const by = st.ball.position.y;                      // 선물 안에서 배스밤 중심 높이
    const pos = gift.localToWorld(new THREE.Vector3(0, by + R + 0.012, 0));
    const ctr = gift.localToWorld(new THREE.Vector3(0, by + R, 0));
    let out = (this.rack.viewer ? this.rack.viewer.getWorldPosition(new THREE.Vector3()) : ctr.clone().add(new THREE.Vector3(0, 0, 1))).sub(ctr);
    out.y = 0; if (out.lengthSq() < 1e-6) out.set(0, 0, 1); out.normalize();
    pos.addScaledVector(out, 0.016);
    // 리본 로컬: +Z = 앞면(방울), +Y = 위(고리), -Y = 꼬리 → 앞면이 바깥, 위가 위로
    const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0).cross(out).normalize(), new THREE.Vector3(0, 1, 0), out));
    quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.55));   // 아래쪽(꼬리·방울)이 배스밤 곡면을 따라 바깥으로
    return { pos, quat };
  }

  release(hand) {
    const it = this.items.find((x) => x.hand === hand); if (!it) return;
    it.hand = null; this.held = null;
    const gift = this.station.gift;
    if (gift && (this.station.state === 'wrapped' || this.station.state === 'giftHeld')) {
      const f = this._neckFrame(gift);
      if (this._center(it, _v).distanceTo(f.pos) < 0.12) {
        if (this.onGift && this.onGift !== it) this._sendHome(this.onGift);
        gift.attach(it.obj);
        it.target = { pos: gift.worldToLocal(f.pos.clone()), quat: gift.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(f.quat) };
        it.target.scale = 0.72;                          // 배스밤 크기에 맞게
        it.state = 'attaching'; it.anim = 0; this.onGift = it;
        this.dispatchEvent({ type: 'attached', ribbon: it.i });
        return;
      }
    }
    this._sendHome(it);
  }

  _sendHome(it) {
    this.box.root.attach(it.obj);
    it.target = { pos: it.home.pos, quat: it.home.quat, scale: 1 }; it.state = 'returning'; it.anim = 0;
    if (this.onGift === it) this.onGift = null;
  }

  update(dt) {
    for (const it of this.items) {
      if (it.state !== 'attaching' && it.state !== 'returning') continue;
      const k = 1 - Math.exp(-(it.state === 'attaching' ? 14 : 8) * dt);
      it.obj.position.lerp(it.target.pos, k); it.obj.quaternion.slerp(it.target.quat, k);
      it.obj.scale.setScalar(it.obj.scale.x + ((it.target.scale ?? 1) - it.obj.scale.x) * k);
      it.anim += dt;
      if (it.anim > 0.6) { it.obj.position.copy(it.target.pos); it.obj.quaternion.copy(it.target.quat); it.obj.scale.setScalar(it.target.scale ?? 1); it.state = it.state === 'attaching' ? 'onGift' : 'home'; }
    }
  }

  /** 선물이 리셋되면 붙어 있던 리본은 상자로 */
  reset() { for (const it of this.items) if (it.state !== 'home') { if (it.hand) this.rack.release(it.hand); this._sendHome(it); it.obj.position.copy(it.home.pos); it.obj.quaternion.copy(it.home.quat); it.obj.scale.setScalar(1); it.state = 'home'; } }
}
