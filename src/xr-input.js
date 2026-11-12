/**
 * WebXR 컨트롤러 → WrappingPaperRack 연결
 *   - 그립(squeeze) 또는 트리거(select): 종이 끝 / 자른 종이 잡기, 놓으면 바닥으로 떨어짐
 *   - scissorsHand 쪽 컨트롤러 앞 끝 = 가위 날 끝 (가위 모델은 없고 작은 표식만 표시)
 *       cutMode 'contact' : 날 끝이 늘어진 종이에 닿으면 자름
 *       cutMode 'trigger' : 절취선이 떠 있을 때 트리거로 자름
 */
import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

export function bindXRControllers(renderer, scene, rack, opts = {}) {
  const it = rack.config.interaction;
  const scissorsHand = opts.scissorsHand ?? it.scissorsHand ?? 'right';
  const tipOffset = opts.tipOffset ?? new THREE.Vector3(0, -0.01, -0.09);
  const factory = opts.showControllerModels === false ? null : new XRControllerModelFactory();
  const hands = [];

  for (let i = 0; i < 2; i++) {
    const ray = renderer.xr.getController(i);
    const grip = renderer.xr.getControllerGrip(i);
    if (factory) grip.add(factory.createControllerModel(grip));
    scene.add(ray, grip);

    const tip = new THREE.Object3D(); tip.name = 'ScissorsTip'; tip.position.copy(tipOffset);
    tip.add(makeScissorsMarker());
    const state = { ray, grip, tip, handedness: null, isScissors: false, grabs: 0 };
    hands.push(state);

    ray.addEventListener('connected', (e) => {
      state.handedness = e.data.handedness;
      state.isScissors = state.handedness === scissorsHand;
      if (state.isScissors) { grip.add(tip); rack.setScissors(tip); }
    });
    ray.addEventListener('disconnected', () => {
      rack.release(grip);
      if (state.isScissors) { tip.removeFromParent(); rack.setScissors(null); }
      state.isScissors = false; state.grabs = 0;
    });

    const down = (kind) => {
      if (kind === 'select' && state.isScissors && it.cutMode === 'trigger' && rack.tryCut()) return;
      if (rack.grab(grip)) state.grabs++;
    };
    const up = () => { if (state.grabs > 0 && --state.grabs === 0) rack.release(grip); };
    ray.addEventListener('squeezestart', () => down('squeeze'));
    ray.addEventListener('squeezeend', up);
    ray.addEventListener('selectstart', () => down('select'));
    ray.addEventListener('selectend', up);
  }
  return { hands };
}

/** 가위 날 끝 표식 (실제 가위 모델 대신) */
export function makeScissorsMarker() {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xff3b3b, toneMapped: false });
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.005, 12, 8), mat));
  const bladeMat = new THREE.MeshBasicMaterial({ color: 0xd9dde3, toneMapped: false });
  for (const s of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.0015, 0.07), bladeMat);
    b.position.set(0, 0, 0.035); b.rotation.y = s * 0.12; g.add(b);
  }
  return g;
}
