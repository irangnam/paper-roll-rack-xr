/**
 * RibbonBox — 블렌더에서 만든 나무 리본 상자(RibbonBox.glb). 뚜껑이 뒤쪽 경첩으로 열림
 *
 *   const box = new RibbonBox(rack, (await loader.loadAsync('models/RibbonBox.glb')).scene, { parent: workspace });
 *   box.toggle() / box.open() / box.close()
 *
 * 기본: 블렌더 장면처럼 활짝 열린 채로 시작.
 * 조작: 뚜껑(특히 앞쪽 걸쇠 부분)을 잡고 들어 올리면 경첩을 따라 열림.
 *       놓을 때 충분히 열려 있으면 활짝 열린 채로, 아니면 닫힘. (손 주먹 / 컨트롤러 그립 / 마우스 드래그 공통)
 * 크기: 기본 폭 0.28 × 깊이 0.16 × 높이 0.11 m (랙의 1/2 폭)
 * 이벤트: 'open', 'close'
 */
import * as THREE from 'three';

const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();

export class RibbonBox extends THREE.EventDispatcher {
  /** scene = RibbonBox.glb 의 gltf.scene (블렌더 WorkTable.blend 에서 만든 상자). 뚜껑 노드 원점 = 뒤쪽 경첩 */
  constructor(rack, scene, opts = {}) {
    super();
    this.rack = rack;
    this.root = scene.getObjectByName('RibbonBox');
    this.lid = scene.getObjectByName('RibbonBox_Lid');
    (opts.parent ?? rack.root.parent ?? rack.root).add(this.root);
    this.W = 0.28; this.D = 0.16; this.Hl = 0.032; this.Hb = this.lid.position.y;
    this.OPEN = opts.openAngle ?? THREE.MathUtils.degToRad(102);
    this.meshes = []; this.root.traverse((o) => { if (o.isMesh) this.meshes.push(o); });
    // 처음 각도 = 블렌더에서 내보낸 뚜껑 자세 (지금은 활짝 열린 채로 내보냄)
    this.angle = Math.max(0, -this.lid.rotation.x); this.vel = 0; this.target = this.angle; this.heldBy = null; this.isOpen = this.angle > 0.3;
    rack.addGrabbable(this);
  }

  getMeshes() { return this.meshes; }

  open(instant = false) { this.target = this.OPEN; if (instant) { this.angle = this.OPEN; this.vel = 0; } }
  close() { this.target = 0; }
  toggle() { this.target = this.target > 0.5 ? 0 : this.OPEN; }

  /* ------------------------------------------------ rack grabbable 인터페이스 */
  _lidLocal(worldP, out) { return this.lid.worldToLocal(out.copy(worldP)); }

  grabDistance(p) {
    this.root.updateMatrixWorld(true);
    const lp = this._lidLocal(p, _v);
    const { W, D, Hl } = this;
    // 뚜껑 몸체 안/근처를 잡으면 바로, 아니면 앞쪽 모서리(걸쇠)까지 거리
    if (Math.abs(lp.x) <= W / 2 + 0.01 && lp.y >= -0.015 && lp.y <= Hl + 0.03 && lp.z >= -0.01 && lp.z <= D + 0.03) return 0.004;
    const cx = THREE.MathUtils.clamp(lp.x, -W / 2, W / 2);
    return Math.hypot(lp.x - cx, lp.y - Hl / 2, lp.z - D);
  }

  _handAngle(hand) {
    hand.updateWorldMatrix(true, false);
    const p = this.root.worldToLocal(hand.getWorldPosition(_a));
    return Math.atan2(p.y - this.Hb, p.z - (-this.D / 2));   // 경첩에서 손까지 각도 (0 = 앞쪽 수평)
  }

  grab(hand) {
    this.heldBy = hand;
    this.grabOffset = this.angle - this._handAngle(hand);
    return true;
  }

  release(hand) {
    if (hand !== this.heldBy) return;
    this.heldBy = null;
    this.target = this.angle > 0.55 ? this.OPEN : 0;
  }

  update(dt) {
    if (this.heldBy) {
      const a = THREE.MathUtils.clamp(this._handAngle(this.heldBy) + this.grabOffset, 0, this.OPEN + 0.15);
      this.angle += (a - this.angle) * (1 - Math.exp(-20 * dt)); this.vel = 0;
    } else {
      // 스프링: 열릴 땐 부드럽게, 닫힐 땐 '탁' 하고 살짝 튕김
      this.vel += ((this.target - this.angle) * 60 - this.vel * 11) * dt;
      this.angle += this.vel * dt;
      if (this.angle < 0) { this.angle = 0; this.vel = -this.vel * 0.25; }
      if (this.angle > this.OPEN + 0.15) { this.angle = this.OPEN + 0.15; this.vel = 0; }
    }
    this.lid.rotation.x = -this.angle;
    const nowOpen = this.angle > 0.3;
    if (nowOpen !== this.isOpen) { this.isOpen = nowOpen; this.dispatchEvent({ type: nowOpen ? 'open' : 'close' }); }
  }
}
