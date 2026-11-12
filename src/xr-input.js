/**
 * WebXR 입력 → WrappingPaperRack
 *
 * 손 추적 (Quest 등, 컨트롤러 내려놓으면 자동 전환)
 *   - 주먹 쥐기  : 종이 끝 / 자른 종이 잡기 → 손을 펴면 놓기
 *                 (들고 손목을 돌리면 종이가 같이 뒤집히고, 놓을 때 위를 향한 면 그대로 바닥에 놓임)
 *   - 가위 손    : 검지·중지만 펴고 나머지 접기. 두 손가락 끝을 종이에 대고
 *                 벌렸다 붙이기(가위질)를 snipsToCut(기본 3)번 하면 그 자리에서 잘림
 *   - 손바닥 뒤집기 제스처 없이도, 바닥의 종이는 주먹으로 집어 손목을 돌린 뒤 놓으면 뒤집힘
 *
 * 컨트롤러
 *   - 그립 : 잡기 / 놓기
 *   - 트리거 : 가위질 1번 (scissorsHand 쪽 컨트롤러 앞 끝이 가위 날 끝)
 */
import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

/** VRButton 에 넘길 세션 옵션: 손 추적 요청 */
export const XR_SESSION_INIT = { optionalFeatures: ['hand-tracking'] };

// 손 모양 판정 기준 (m, 손목 → 손가락 끝 거리). 손 크기에 따라 조절
export const HAND = {
  curled: 0.095,        // 이보다 가까우면 접힌 손가락
  extended: 0.125,      // 이보다 멀면 편 손가락
  fistOpen: 0.115,      // 주먹을 이 이상 펴면 놓기 (히스테리시스)
  bladeOpen: 0.032,     // 검지·중지 끝 간격이 이 이상이면 '벌림'
  bladeClosed: 0.018,   // 이 이하면 '붙임' → 벌림 다음 붙임 = 가위질 1번
};

export function bindXRControllers(renderer, scene, rack, opts = {}) {
  const it = rack.config.interaction;
  const scissorsHand = opts.scissorsHand ?? it.scissorsHand ?? 'right';
  const tipOffset = opts.tipOffset ?? new THREE.Vector3(0, -0.01, -0.09);
  const ctrlFactory = new XRControllerModelFactory();
  const handFactory = new XRHandModelFactory();
  handFactory.setPath(opts.handModelPath ?? new URL('../models/hands/', import.meta.url).href);
  const states = [];
  let activeScissors = null;          // 지금 가위 역할을 하는 Object3D

  const setScissors = (tip) => { if (activeScissors !== tip) { activeScissors = tip; rack.setScissors(tip); } };

  for (let i = 0; i < 2; i++) {
    const ray = renderer.xr.getController(i);
    const grip = renderer.xr.getControllerGrip(i);
    grip.add(ctrlFactory.createControllerModel(grip));
    const hand = renderer.xr.getHand(i);
    hand.add(handFactory.createHandModel(hand, 'mesh'));
    scene.add(ray, grip, hand);

    const tip = new THREE.Object3D(); tip.name = 'ScissorsTip'; tip.position.copy(tipOffset);
    tip.add(makeScissorsMarker());
    const st = {
      ray, grip, hand, tip, handedness: null, isHand: false, isScissors: false, grabs: 0,
      // 손 추적용
      grabPoint: new THREE.Object3D(), bladeTip: new THREE.Object3D(),
      fist: false, scissorsPose: false, bladeOpen: false, holding: false,
    };
    scene.add(st.grabPoint, st.bladeTip);
    states.push(st);

    ray.addEventListener('connected', (e) => {
      st.handedness = e.data.handedness;
      st.isHand = !!e.data.hand;
      st.isScissors = !st.isHand && st.handedness === scissorsHand;
      if (st.isScissors) { grip.add(tip); setScissors(tip); }
    });
    ray.addEventListener('disconnected', () => {
      rack.release(grip); rack.release(st.grabPoint);
      if (activeScissors === tip || activeScissors === st.bladeTip) setScissors(null);
      tip.removeFromParent();
      Object.assign(st, { isScissors: false, isHand: false, grabs: 0, fist: false, scissorsPose: false, holding: false });
    });

    // 컨트롤러 버튼 (손 추적 중에는 핀치가 select 로 들어오므로 무시)
    const grabDown = () => { if (!st.isHand && rack.grab(grip)) st.grabs++; };
    const grabUp = () => { if (!st.isHand && st.grabs > 0 && --st.grabs === 0) rack.release(grip); };
    ray.addEventListener('squeezestart', grabDown);
    ray.addEventListener('squeezeend', grabUp);
    ray.addEventListener('selectstart', () => {
      if (st.isHand) return;
      if (st.isScissors) rack.snip(); else grabDown();
    });
    ray.addEventListener('selectend', () => { if (!st.isHand && !st.isScissors) grabUp(); });
  }

  const _w = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
  const J = (hand, name) => hand.joints[name];
  const tipDist = (hand, f) => {
    const t = J(hand, `${f}-finger-tip`), w = J(hand, 'wrist');
    return t && w ? t.getWorldPosition(_a).distanceTo(w.getWorldPosition(_w)) : Infinity;
  };

  /** 매 프레임 호출: 손 모양 → 잡기/놓기, 가위질 */
  function update() {
    let scissorsCandidate = null;
    for (const st of states) {
      if (!st.isHand) continue;
      const h = st.hand, wrist = J(h, 'wrist');
      if (!wrist || !wrist.visible) {                     // 손 추적이 잠깐 끊김
        if (st.holding) { rack.release(st.grabPoint); st.holding = false; }
        continue;
      }
      const dI = tipDist(h, 'index'), dM = tipDist(h, 'middle'), dR = tipDist(h, 'ring'), dP = tipDist(h, 'pinky');

      // 잡는 점 = 손바닥 가운데, 방향 = 손목 방향 (손목을 돌리면 들고 있는 종이도 돌아감)
      const palm = J(h, 'middle-finger-metacarpal') || wrist;
      palm.getWorldPosition(st.grabPoint.position);
      wrist.getWorldQuaternion(st.grabPoint.quaternion);
      st.grabPoint.updateMatrixWorld();

      // 주먹: 검지·중지·약지 모두 접힘 / 펴면 놓기
      const fistNow = st.fist
        ? Math.max(dI, dM, dR) < HAND.fistOpen
        : dI < HAND.curled && dM < HAND.curled && dR < HAND.curled;
      if (fistNow && !st.fist) st.holding = rack.grab(st.grabPoint);
      if (!fistNow && st.fist && st.holding) { rack.release(st.grabPoint); st.holding = false; }
      st.fist = fistNow;

      // 가위 손: 검지·중지 폄, 약지·새끼 접음
      const pose = dI > HAND.extended * 0.9 && dM > HAND.extended * 0.9 && dR < HAND.curled * 1.05 && dP < HAND.curled * 1.1;
      st.scissorsPose = pose && !st.fist;
      if (st.scissorsPose) {
        const ti = J(h, 'index-finger-tip'), tm = J(h, 'middle-finger-tip');
        ti.getWorldPosition(_a); tm.getWorldPosition(_b);
        st.bladeTip.position.copy(_a).add(_b).multiplyScalar(0.5);
        st.bladeTip.updateMatrixWorld();
        const gap = _a.distanceTo(_b);
        if (!st.bladeOpen && gap > HAND.bladeOpen) st.bladeOpen = true;
        else if (st.bladeOpen && gap < HAND.bladeClosed) {   // 벌렸다 붙임 = 가위질 1번
          st.bladeOpen = false;
          setScissors(st.bladeTip); rack.update(0);         // 지금 손가락 위치로 자를 자리 갱신
          rack.snip();
        }
        if (!scissorsCandidate || st.handedness === scissorsHand) scissorsCandidate = st;
      } else {
        st.bladeOpen = false;
      }
    }
    // 손으로 가위 모양을 하고 있으면 그 손가락 끝이 가위, 아니면 컨트롤러 가위(있으면)
    const ctrl = states.find((s) => s.isScissors);
    setScissors(scissorsCandidate ? scissorsCandidate.bladeTip : ctrl ? ctrl.tip : null);
  }

  return { states, update };
}

/** 컨트롤러 가위 날 끝 표식 (실제 가위 모델 대신) */
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
