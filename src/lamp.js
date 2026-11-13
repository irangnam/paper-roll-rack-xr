/**
 * BankerLamp — 블렌더 BankerLamp.glb (흰 오팔 갓 · 앤티크 황동). 오른쪽 당김 줄을 당기면 켜고 끄기
 *
 *   const lamp = new BankerLamp(gltf.scene, { parent: workspace, fx });
 *   rack.addGrabbable(lamp);           // 예전 방식: 줄을 잡으면(주먹·그립·드래그) 딸깍 · rack.update 가 lamp.update 를 부름
 *   flow.addTarget(() => lamp.target()) // 단순 진행: 줄을 클릭 · 가리키고 핀치 · 손가락으로 톡
 *   lamp.toggle() / lamp.setOn(true|false) / lamp.on
 *
 * 블렌더에서 분리해 둔 메시: Lamp_Bulb(전구) · Lamp_ShadeInner(갓 안쪽) · Lamp_Shade(오팔 갓) — 빛나는 정도를 켜고 끔
 *                          Lamp_PullChain(당김 줄, 원점 = 위쪽 끝) — 당기면 아래로 내려갔다 올라옴
 * 이벤트: 'toggle' { on }
 */
import * as THREE from 'three';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

export class BankerLamp extends THREE.EventDispatcher {
  constructor(scene, opts = {}) {
    super();
    this.fx = opts.fx ?? null;
    this.root = scene.getObjectByName('BankerLamp') ?? scene;
    (opts.parent ?? scene).add(this.root);
    this.root.updateMatrixWorld(true);
    this.chain = this.root.getObjectByName('Lamp_PullChain');
    this.chainHome = this.chain.position.clone();
    this.pullDist = opts.pullDistance ?? 0.015;

    // 빛나는 재질 (켜진 상태로 내보냄 → 그 세기를 기억)
    this.glow = [];
    this.root.traverse((o) => { if (o.isMesh && o.material.emissive && o.material.emissiveIntensity > 0 && o.material.emissive.getHex()) this.glow.push([o.material, o.material.emissiveIntensity]); });

    // 전구 자리 따뜻한 빛
    const bulb = this.root.getObjectByName('Lamp_Bulb');
    this.light = new THREE.PointLight(0xffd29a, opts.lightIntensity ?? 0.35, 0.9, 2);
    const bc = new THREE.Box3().setFromObject(bulb).getCenter(new THREE.Vector3());
    this.light.position.copy(this.root.worldToLocal(bc)); this.light.position.y -= 0.02;
    this.root.add(this.light);

    // 줄은 가늘어서 잡기 쉽게 보이지 않는 굵은 원통을 덧댐 (레이캐스트·터치용)
    const box = new THREE.Box3().setFromObject(this.chain);
    this.chainLen = box.max.y - box.min.y;
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, this.chainLen + 0.02, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }));
    hit.position.y = -this.chainLen / 2; hit.name = 'Lamp_PullChain_Hit';
    this.chain.add(hit); this.hit = hit;

    this.on = true; this.anim = -1;
    this.setOn(opts.on ?? true);
  }

  setOn(v) {
    this.on = !!v;
    this.light.visible = this.on;
    for (const [m, k] of this.glow) m.emissiveIntensity = this.on ? k : 0;
  }

  /** 줄 당기기: 내려갔다 올라오며 딸깍 → 켜짐/꺼짐 */
  toggle() {
    if (this.anim >= 0 && this.anim < 0.12) return false;   // 당기는 중엔 한 번만
    this.anim = 0;
    this.setOn(!this.on);
    this.fx?.unlockAudio?.(); this.fx?.playSound?.('click');
    this.dispatchEvent({ type: 'toggle', on: this.on });
    return true;
  }

  /** 줄(위 끝 → 아래 끝 선분)까지 거리 */
  distance(p) {
    this.chain.updateWorldMatrix(true, false);
    const a = this.chain.getWorldPosition(_a), b = _b.set(0, -this.chainLen, 0).applyMatrix4(this.chain.matrixWorld);
    const ab = _c.subVectors(b, a);
    const t = THREE.MathUtils.clamp(_d.subVectors(p, a).dot(ab) / ab.lengthSq(), 0, 1);
    return p.distanceTo(_d.copy(a).addScaledVector(ab, t));
  }

  /** 단순 진행(wrap-flow.js)용 고를 대상 */
  target() { return { kind: 'lamp', meshes: [this.hit], dist: (p) => this.distance(p) - 0.006, onPress: () => this.toggle() }; }

  // ---- 예전 방식: rack 잡을 수 있는 것
  grabDistance(p) { return this.distance(p) - 0.01; }
  grab() { this.toggle(); return true; }
  release() {}

  update(dt) {
    if (this.anim < 0) return;
    this.anim += dt;
    const t = this.anim, down = 0.09;
    // 빠르게 내려갔다 → 살짝 튕기며 올라옴
    const k = t < down ? t / down : Math.max(0, Math.exp(-(t - down) * 9) * Math.cos((t - down) * 18));
    this.chain.position.copy(this.chainHome); this.chain.position.y -= this.pullDist * k;
    if (t > 0.7) { this.chain.position.copy(this.chainHome); this.anim = -1; }
  }
}
