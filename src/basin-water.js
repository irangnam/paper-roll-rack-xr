/**
 * 수반 물 그래픽 — BasinSim 결과를 실제 수면 · 위 접시 물 · 물줄기 · 빛무리에 입히고, 거품/물방울/반짝이 입자를 그림
 *
 * 퀘스트 고려: 반사·굴절용 추가 렌더 없음. 수면 한 장의 셰이더가
 *   물결 노멀 + 잔물결 + 가짜 깊이 + 바닥 빛 무늬(코스틱) + 번지는 물감 2겹(표면·깊은 구름) + 따뜻한 방 반사 + 거품 + 반짝이
 * 를 한 번에 계산. 입자는 Points 2개 (보통 · 더하기 혼합).
 */
import * as THREE from 'three';

const NOISE = /* glsl */`
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y); }`;

const WATER_VERT = /* glsl */`
varying vec3 vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

const WATER_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uWave, uDye;
uniform vec2 uWaveT;
uniform vec3 uC; uniform float uR;
uniform float uTime, uSlope, uMilk, uTintAmt, uMagicAmt, uGlow, uGlitter;
uniform vec3 uTint, uMagic, uLightDir, uLightCol;
uniform vec4 uBomb;   // xyz 위치, w 거품 꽃 세기
uniform vec4 uFall;   // 물줄기 닿는 곳 xyz, w 반지름
uniform sampler2D uFoamTex, uVel;
uniform float uVelRes;
uniform float uBombR;
varying vec3 vW;
${NOISE}
vec2 h22(vec2 p) { return vec2(hash12(p), hash12(p + 19.19)); }
// 물 무늬: x 밝은 덩어리, y 푸른 그늘, z 가는 결 선 (둥글고 유기적, 가로로 늘이지 않음)
vec3 waterPat(vec2 P, float t) {
  vec2 q = P + (vec2(vnoise(P * 5.0 + t * 0.03), vnoise(P * 5.0 + 7.3 - t * 0.03)) - 0.5) * 0.06;
  float l1 = vnoise(q * 11.0 + vec2(t * 0.02, -t * 0.015)) * 0.65 + vnoise(q * 23.0 + 2.0) * 0.35;
  float l2 = vnoise(q * 8.0 + vec2(4.1, 1.7 - t * 0.02)) * 0.65 + vnoise(q * 17.0 + 5.0) * 0.35;
  float ln = abs(vnoise(q * 9.0 + vec2(8.0, t * 0.03)) - 0.5);
  return vec3(smoothstep(0.58, 0.66, l1), smoothstep(0.57, 0.65, l2), 1.0 - smoothstep(0.008, 0.022, ln));
}
// 거품 텍스처 두 겹 (작은 · 큰 기포, 서로 돌려 반복 티 안 나게) → rg 노멀, b 높이
vec4 foamSample(vec2 P, float t) {
  vec4 a = texture2D(uFoamTex, P * 7.5);
  vec4 b = texture2D(uFoamTex, mat2(0.8, -0.6, 0.6, 0.8) * P * 3.4 + 0.37);
  b.b *= 0.92;
  return a.b > b.b ? a : b;
}
// 부풀었다 터지는 기포 (고리 + 살짝 볼록)
float boil(vec2 p, float t, float amt) {
  vec2 ip = floor(p), fp = fract(p); float o = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j)), c = ip + g; float h = hash12(c);
    if (h > amt) continue;
    float ph = fract(t * (0.35 + 0.6 * hash12(c + 3.0)) + h * 7.0);
    float rad = (0.18 + 0.24 * hash12(c + 9.0)) * smoothstep(0.0, 0.85, ph);
    float d = length(g + h22(c) * 0.6 + 0.2 - fp);
    float ring = (1.0 - smoothstep(rad * 0.82, rad, d)) * (0.35 + 0.65 * smoothstep(rad * 0.45, rad * 0.9, d));
    o = max(o, ring * step(ph, 0.93));
  }
  return o;
}
// 빛 그물: 움직이는 보로노이의 F2-F1 (세포 테두리). 세포 모서리(교차점) 가까이일수록 선이 두꺼움
float causticNet(vec2 p, float t, float w0, float w1) {
  vec2 ip = floor(p), fp = fract(p); float f1 = 8.0, f2 = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j)), o = h22(ip + g);
    o = 0.5 + 0.42 * sin(t * 0.3 + 6.2831 * o);
    vec2 r = g + o - fp; float d = dot(r, r);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  float e = sqrt(f2) - sqrt(f1);
  float w = mix(w0, w1, smoothstep(0.35, 0.75, sqrt(f1)));
  return 1.0 - smoothstep(w * 0.4, w, e);
}
void main() {
  vec2 uv = ((vW.xz - uC.xz) / uR + 1.0) * 0.5;
  float rr = length(uv * 2.0 - 1.0);
  // 물결 노멀
  float hL = texture2D(uWave, uv - vec2(uWaveT.x, 0.0)).r, hR = texture2D(uWave, uv + vec2(uWaveT.x, 0.0)).r;
  float hB = texture2D(uWave, uv - vec2(0.0, uWaveT.y)).r, hT = texture2D(uWave, uv + vec2(0.0, uWaveT.y)).r;
  vec3 n = vec3((hL - hR) * uSlope, 1.0, (hB - hT) * uSlope);
  // 잔물결 (항상 살랑)
  vec2 q = vW.xz * 42.0; float t = uTime;
  n.xz += 0.035 * vec2(sin(q.x * 1.3 + t * 2.1) + sin(q.y * 0.7 + q.x * 0.9 - t * 1.7),
                       cos(q.y * 1.1 - t * 1.9) + cos(q.x * 0.6 - q.y * 0.8 + t * 1.3));
  n = normalize(n);
  vec3 V = normalize(cameraPosition - vW);
  float NdV = max(dot(n, V), 0.0);
  float fres = 0.03 + 0.97 * pow(1.0 - NdV, 5.0);

  // 물속: 굴절처럼 살짝 밀린 자리에서 물감 읽기 (표면 가까운 것 + 흐릿한 깊은 구름)
  vec2 ruv = uv - n.xz * 0.05;
  vec4 d1 = texture2D(uDye, ruv);
  vec4 d2 = (texture2D(uDye, ruv + vec2(0.014, 0.007)) + texture2D(uDye, ruv - vec2(0.007, 0.014)) + texture2D(uDye, ruv + vec2(-0.012, 0.010))) / 3.0;
  float depth = clamp(1.0 - rr * rr, 0.0, 1.0);

  // ---- 물빛: 은은하게 푸른, 가볍고 맑은 물. 무늬는 둥글고 유기적이며 물 흐름을 따라 흘러가고 물결에 일그러짐
  vec3 cDeep = vec3(0.30, 0.60, 0.62), cMid = vec3(0.46, 0.74, 0.73), cLight = vec3(0.80, 0.93, 0.88), cBlue = vec3(0.38, 0.58, 0.70);
  vec2 fvw = clamp(texture2D(uVel, uv).xy / uVelRes * 2.0 * uR, -0.12, 0.12);
  float fph0 = fract(t * 0.15), fph1 = fract(t * 0.15 + 0.5), fwb = abs(1.0 - 2.0 * fph0);
  vec2 wp = vW.xz + n.xz * 0.09;
  vec3 pa = waterPat(wp - fvw * fph0 * 6.0, t), pb = waterPat(wp - fvw * fph1 * 6.0 + vec2(0.043, 0.027), t);
  vec3 pt = mix(pa, pb, fwb);
  vec3 body = mix(cMid, cDeep, smoothstep(0.2, 0.95, depth) * 0.7);
  body = mix(vec3(0.78, 0.90, 0.84), body, smoothstep(0.02, 0.55, depth));
  body = mix(body, cBlue, pt.y * 0.3 * depth);
  body = mix(body, cLight, pt.x * 0.45);
  body = mix(body, vec3(0.9, 0.98, 0.95), pt.z * 0.3);
  // 녹은 배스밤이 물 전체를 물들임 (뽀얗게)
  body = mix(body, uTint, uTintAmt);
  // 번지는 물감
  float den2 = max(max(d2.r, d2.g), d2.b), den1 = max(max(d1.r, d1.g), d1.b);
  vec3 pc2 = mix(d2.rgb / max(den2, 1e-3), vec3(0.98, 0.96, 0.95), 0.5);
  body = mix(body, pc2 * 0.88, (1.0 - exp(-den2 * 1.1)) * 0.8);
  vec3 pc1 = mix(d1.rgb / max(den1, 1e-3), vec3(0.98, 0.96, 0.95), 0.45);
  body = mix(body, pc1, (1.0 - exp(-den1 * 2.0)) * 0.85);
  // 마법 빛 (가운데 금빛 + 배스밤 색 반응)
  body += vec3(1.0, 0.84, 0.52) * uGlow * depth * 0.07;
  body += uMagic * uMagicAmt * depth * 0.03;

  // 따뜻한 방 반사
  vec3 Rf = reflect(-V, n);
  vec3 env = mix(vec3(0.62, 0.72, 0.68), vec3(0.95, 0.96, 0.92), smoothstep(-0.1, 0.9, Rf.y));
  vec3 col = mix(body, env, fres * 0.4);
  float ang = atan(vW.z - uC.z, vW.x - uC.x);
  float rimR = rr + 0.012 * sin(ang * 38.0 + t * 1.3) + 0.008 * sin(ang * 71.0 - t * 2.1) + (n.x + n.z) * 0.12;
  float rimRef = smoothstep(0.86, 0.965, rimR);
  col = mix(col, vec3(0.93, 0.85, 0.70) * (0.9 + 0.1 * sin(ang * 23.0 + t)), rimRef * 0.42);
  // 빛 반짝
  vec3 H = normalize(uLightDir + V);
  vec2 gp = vec2(wp.x * 80.0, wp.y * 120.0) + n.xz * 10.0;
  float gn = vnoise(gp + vec2(t * 0.9, t * 0.35)) * 0.7 + vnoise(gp * 1.9 - vec2(t * 0.6, 0.0)) * 0.3;
  float lit = smoothstep(0.1, 0.8, pow(max(dot(n, H), 0.0), 12.0));
  float glint = smoothstep(0.74, 0.76, gn) * (0.15 + 0.85 * lit) * (1.0 - uMilk * 0.7);
  col = mix(col, vec3(1.0, 1.0, 0.96), glint * 0.92);

  // 거품
  float foam = clamp(texture2D(uDye, uv).a, 0.0, 1.0);
  // 거품 양 (물감 a 채널 + 배스밤 둘레 + 물줄기 닿는 곳)
  vec2 Pxz = vW.xz;
  float fl = 0.0;
  if (uBomb.w > 0.0) {
    vec2 bd = Pxz - uBomb.xz; float br = length(bd), ba = atan(bd.y, bd.x);
    float streak = 0.5 + 0.5 * sin(ba * 40.0 + vnoise(vec2(ba * 8.0, t * 0.1)) * 6.0);
    fl = smoothstep(uBombR * 0.8, uBombR * 1.05, br) * smoothstep(uBombR * (2.3 + 1.0 * uBomb.w), uBombR * 1.1, br) * uBomb.w;
    fl *= 0.8 + 0.2 * mix(1.0, streak, smoothstep(uBombR * 1.3, uBombR * 2.4, br));
  }
  vec2 fd = (Pxz - uFall.xz) / vec2(uFall.w * 1.6, uFall.w);
  float fz = smoothstep(1.0, 0.1, length(fd));
  float A = clamp(foam * 1.1 + fz * 0.8, 0.0, 1.0);
  if (A > 0.02) {
    // 텍스처 기포 두 겹 (작은 · 큰, 서로 돌려서 반복 티 안 나게), 아주 천천히 밀려감
    // 물 흐름을 따라 거품 무늬가 흘러감 (플로우맵: 두 위상을 엇갈려 섞어 늘어나지 않게)
    vec2 fv = clamp(texture2D(uVel, uv).xy / uVelRes * 2.0 * uR, -0.12, 0.12);
    float ph0 = fract(t * 0.2), ph1 = fract(t * 0.2 + 0.5), wb = abs(1.0 - 2.0 * ph0);
    vec2 P0 = Pxz - fv * ph0 * 5.0, P1 = Pxz - fv * ph1 * 5.0 + vec2(0.031, 0.017);
    vec4 fs0 = foamSample(P0, t), fs1 = foamSample(P1, t);
    vec4 fs = mix(fs0, fs1, wb);
    vec4 f1 = fs, f2 = fs;
    float h = fs.b;
    // 두께: 얇으면 큰 기포 꼭대기만, 두꺼우면 빈틈없이
    float T = A;
    float thr = mix(0.8, -0.25, smoothstep(0.0, 0.85, T));
    float cov = smoothstep(thr, thr + 0.1, h);
    vec3 nb = normalize(vec3((fs.r * 2.0 - 1.0) * 1.4, 1.0, (fs.g * 2.0 - 1.0) * 1.4));
    // 다중 산란: 회색 그늘 없이 늘 밝음. 틈은 물 색이 살짝 비친 크림색
    float wrapL = 0.86 + 0.14 * dot(nb, uLightDir);
    float crev = 1.0 - smoothstep(0.05, 0.4, h);
    vec3 cream = mix(vec3(1.0, 0.975, 0.955), mix(vec3(1.0, 0.97, 0.95), pc1, 0.35), clamp(den1 * 1.5, 0.0, 1.0) * crev);
    vec3 fc = cream * wrapL;
    fc += uLightCol * pow(max(dot(nb, normalize(uLightDir + V)), 0.0), 90.0) * 0.28;   // 기포 표면 반짝
    // 얇은 거품: 기포 가운데는 물이 비치고 테두리만 하얗게 → 두꺼울수록 불투명
    float rim = 1.0 - nb.y;
    float opaque = smoothstep(0.3, 0.75, T);
    float alpha = mix(0.35 + 0.65 * smoothstep(0.05, 0.35, rim), 1.0, opaque);
    col = mix(col, fc, cov * alpha * smoothstep(0.02, 0.12, T));
    // 보글보글: 거품 속에서 기포가 부풀었다가 톡 터짐
    float bo = boil(Pxz * 150.0, t, clamp(foam * 0.7, 0.0, 0.9));
    col = mix(col, vec3(1.0, 0.995, 0.985) * (0.94 + 0.12 * bo), smoothstep(0.0, 0.6, bo) * 0.55 * opaque);
  }

  float aBase = mix(0.08, 0.6, smoothstep(0.0, 0.9, depth));
  aBase = mix(aBase, 0.96, max(uMilk, clamp(den1 * 1.2, 0.0, 1.0)));
  gl_FragColor = vec4(col, max(max(mix(aBase, 1.0, fres), glint), rimRef * 0.45));
}`;

const UPPER_FRAG = /* glsl */`
precision highp float;
uniform float uTime, uMagicAmt, uTintAmt; uniform vec3 uImpact, uMagic, uTint, uLightDir, uLightCol;
varying vec3 vW;
void main() {
  vec2 d = vW.xz - uImpact.xz; float r = length(d) + 1e-4; float t = uTime;
  float ring = sin(r * 150.0 - t * 10.0) * exp(-r * 14.0) + 0.5 * sin(r * 90.0 - t * 6.0 + 1.3) * exp(-r * 8.0);
  vec3 n = normalize(vec3(d / r * ring * 0.35, 1.0) .xzy);
  n.xz += 0.03 * vec2(sin(vW.x * 50.0 + t * 2.0), cos(vW.z * 46.0 - t * 1.7)); n = normalize(n);
  vec3 V = normalize(cameraPosition - vW);
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  vec3 body = mix(vec3(0.58, 0.80, 0.76), uTint, uTintAmt * 0.8) + uMagic * uMagicAmt * 0.04;
  vec3 Rf = reflect(-V, n);
  vec3 col = mix(body, mix(vec3(0.62, 0.72, 0.68), vec3(0.95, 0.96, 0.92), smoothstep(-0.1, 0.9, Rf.y)), fres * 0.4);
  col += uLightCol * pow(max(dot(n, normalize(uLightDir + V)), 0.0), 200.0) * 2.0;
  col = mix(col, vec3(1.0), smoothstep(0.03, 0.0, r) * 0.6);
  gl_FragColor = vec4(col, mix(0.35, 1.0, fres));
}`;

const FALL_FRAG = /* glsl */`
precision highp float;
uniform float uTime, uMagicAmt, uTintAmt, uSurfY, uCutY, uCutZ; uniform vec3 uMagic, uTint;
varying vec3 vW;
${NOISE}
void main() {
  if (vW.y < uCutY || vW.z > uCutZ) discard;
  float s = vnoise(vec2((vW.x + vW.z) * 160.0, vW.y * 16.0 + uTime * 5.0)) * 0.65 + vnoise(vec2((vW.x - vW.z) * 60.0, vW.y * 6.0 + uTime * 3.0)) * 0.35;
  vec3 col = mix(vec3(0.62, 0.90, 0.92), vec3(1.0), smoothstep(0.45, 0.9, s));
  col = mix(col, uTint, uTintAmt * 0.6) + uMagic * uMagicAmt * 0.03;
  float low = 1.0 - smoothstep(0.0, 0.05, vW.y - uSurfY);            // 수면 가까울수록 하얗게 부서짐
  float n2 = vnoise(vec2((vW.x + vW.z) * 220.0, vW.y * 90.0 + uTime * 9.0));
  col = mix(col, vec3(1.0), low * 0.75);
  float a = 0.18 + 0.4 * smoothstep(0.25, 0.85, s);
  a = mix(a, 0.55 + 0.4 * n2, low * 0.8) * smoothstep(-0.004, 0.012, vW.y - uSurfY + n2 * 0.006);
  gl_FragColor = vec4(col, a);
}`;

const HALO_VERT = /* glsl */`
varying vec3 vW; varying vec3 vN;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const HALO_FRAG = /* glsl */`
precision highp float;
uniform float uTime, uY0, uY1, uBoost, uMagicAmt; uniform vec3 uC, uMagic;
varying vec3 vW; varying vec3 vN;
void main() {
  float h = clamp((vW.y - uY0) / (uY1 - uY0), 0.0, 1.0);
  float a = smoothstep(0.0, 0.08, h) * pow(1.0 - h, 1.8);
  vec3 V = normalize(cameraPosition - vW);
  a *= pow(abs(dot(normalize(vN), V)), 1.6);                 // 윤곽은 사라짐 → 통처럼 안 보임
  float ang = atan(vW.z - uC.z, vW.x - uC.x);
  float rays = 0.55 + 0.45 * sin(ang * 13.0 + vW.y * 7.0 - uTime * 1.2) * sin(ang * 7.0 - uTime * 0.7 + 1.7);
  vec3 col = mix(vec3(1.0, 0.80, 0.48), uMagic, uMagicAmt);
  gl_FragColor = vec4(col * a * rays * (0.07 + 0.12 * uBoost), 1.0);
}`;

const PT_VERT = /* glsl */`
attribute float aSize; attribute float aAlpha; attribute float aKind;
varying vec3 vCol; varying float vA; varying float vKind;
uniform float uScale;
void main() {
  vCol = color; vA = aAlpha; vKind = aKind;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale * projectionMatrix[1][1] / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const PT_FRAG = /* glsl */`
precision mediump float;
varying vec3 vCol; varying float vA; varying float vKind;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0; float r = length(p);
  if (r > 1.0) discard;
  float a;
  if (vKind < 0.5) {            // 거품: 고리 + 빛점
    float z = sqrt(max(0.0, 1.0 - r * r));
    gl_FragColor = vec4(vCol * (0.78 + 0.22 * z + 0.25 * smoothstep(0.45, 0.0, length(p - vec2(-0.35, 0.4)))), smoothstep(1.0, 0.8, r) * vA);
    return;
  } else if (vKind < 1.5) {     // 물방울
    a = smoothstep(1.0, 0.5, r) + 0.6 * smoothstep(0.4, 0.0, length(p - vec2(-0.3, 0.3)));
  } else {                      // 반짝이 · 빛 알갱이 (더하기)
    a = exp(-r * r * 5.0) + 0.5 * exp(-abs(p.x * p.y) * 60.0) * (1.0 - r);
  }
  gl_FragColor = vec4(vCol, a * vA);
}`;


/**
 * 거품 텍스처 (시작할 때 한 번 생성, 이어 붙여도 이음새 없음)
 * 크기가 제각각인 둥근 기포를 서로 겹치지 않게 빽빽이 채운 높이 맵 → 노멀(RG) + 높이(B)
 * 큰 기포 둘레를 잔기포가 채우는 실제 거품 구조
 */
export function makeFoamTexture(size = 512) {
  const H = new Float32Array(size * size);
  const placed = [];
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const grid = new Map(), CELL = 40;
  const key = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  const tryPlace = (r) => {
    for (let k = 0; k < 30; k++) {
      const x = rnd() * size, y = rnd() * size;
      let ok = true;
      for (let gx = -2; gx <= 2 && ok; gx++) for (let gy = -2; gy <= 2 && ok; gy++) {
        const list = grid.get(key(x + gx * CELL, y + gy * CELL)); if (!list) continue;
        for (const b of list) {
          let dx = Math.abs(b.x - x); dx = Math.min(dx, size - dx);
          let dy = Math.abs(b.y - y); dy = Math.min(dy, size - dy);
          if (Math.hypot(dx, dy) < (b.r + r) * 0.93) { ok = false; break; }
        }
      }
      if (ok) {
        const b = { x, y, r }; placed.push(b);
        const kk = key(((x % size) + size) % size, ((y % size) + size) % size);
        // 경계 넘는 이웃 검사를 위해 감싼 위치에도 등록
        for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
          const k2 = key(x + ox, y + oy); if (!grid.has(k2)) grid.set(k2, []); grid.get(k2).push(b);
        }
        return true;
      }
    }
    return false;
  };
  for (const [r0, r1, n] of [[22, 30, 14], [12, 20, 70], [6, 11, 420], [3, 6, 2600], [1.6, 3, 6000]]) {
    for (let i = 0; i < n; i++) tryPlace(r0 + (r1 - r0) * rnd());
  }
  for (const b of placed) {
    const hmax = 0.35 + 0.65 * Math.sqrt(b.r / 30);
    const r = b.r, x0 = Math.floor(b.x - r), x1 = Math.ceil(b.x + r), y0 = Math.floor(b.y - r), y1 = Math.ceil(b.y + r);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d2 = (x + 0.5 - b.x) ** 2 + (y + 0.5 - b.y) ** 2; if (d2 >= r * r) continue;
      const h = hmax * Math.sqrt(1 - d2 / (r * r));
      const i = (((y % size) + size) % size) * size + (((x % size) + size) % size);
      if (h > H[i]) H[i] = h;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => H[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * 6, dy = (at(x, y + 1) - at(x, y - 1)) * 6;
    const l = Math.hypot(dx, dy, 1), i = (y * size + x) * 4;
    data[i] = (-dx / l * 0.5 + 0.5) * 255; data[i + 1] = (-dy / l * 0.5 + 0.5) * 255; data[i + 2] = at(x, y) * 255; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}

/** CPU 로 움직이는 간단한 입자 묶음 */
export class Particles {
  constructor(capacity, additive) {
    this.cap = capacity; this.n = 0;
    this.p = new Float32Array(capacity * 3); this.v = new Float32Array(capacity * 3);
    this.c = new Float32Array(capacity * 3); this.size = new Float32Array(capacity); this.alpha = new Float32Array(capacity);
    this.kind = new Float32Array(capacity); this.life = new Float32Array(capacity); this.max = new Float32Array(capacity);
    this.grav = new Float32Array(capacity); this.drag = new Float32Array(capacity); this.size0 = new Float32Array(capacity);
    this.floorY = new Float32Array(capacity);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.c, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aKind', new THREE.BufferAttribute(this.kind, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: PT_VERT, fragmentShader: PT_FRAG, vertexColors: true, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, uniforms: { uScale: { value: 600 } },
    });
    this.points = new THREE.Points(g, this.mat); this.points.frustumCulled = false; this.points.renderOrder = 5;
  }
  /** kind: 0 거품 1 물방울 2 반짝이 */
  spawn(x, y, z, vx, vy, vz, { color = [1, 1, 1], size = 0.006, life = 1, kind = 0, grav = 0, drag = 0, floorY = -1e9 } = {}) {
    if (this.n >= this.cap) return;
    const i = this.n++, i3 = i * 3;
    this.p[i3] = x; this.p[i3 + 1] = y; this.p[i3 + 2] = z; this.v[i3] = vx; this.v[i3 + 1] = vy; this.v[i3 + 2] = vz;
    this.c[i3] = color[0]; this.c[i3 + 1] = color[1]; this.c[i3 + 2] = color[2];
    this.size0[i] = size; this.life[i] = 0; this.max[i] = life; this.kind[i] = kind; this.grav[i] = grav; this.drag[i] = drag; this.floorY[i] = floorY;
  }
  update(dt, time) {
    let i = 0;
    while (i < this.n) {
      this.life[i] += dt;
      const i3 = i * 3;
      if (this.life[i] >= this.max[i] || this.p[i3 + 1] < this.floorY[i]) { this._kill(i); continue; }
      const k = Math.exp(-this.drag[i] * dt);
      this.v[i3] *= k; this.v[i3 + 1] = (this.v[i3 + 1] - this.grav[i] * dt) * k; this.v[i3 + 2] *= k;
      if (this.kind[i] === 2) { this.v[i3] += Math.sin(time * 2 + i) * 0.02 * dt; this.v[i3 + 2] += Math.cos(time * 1.7 + i * 1.3) * 0.02 * dt; }
      this.p[i3] += this.v[i3] * dt; this.p[i3 + 1] += this.v[i3 + 1] * dt; this.p[i3 + 2] += this.v[i3 + 2] * dt;
      const f = this.life[i] / this.max[i];
      if (this.kind[i] === 0) { this.alpha[i] = 0.85 * (1 - f * f); this.size[i] = this.size0[i] * (0.6 + 0.6 * f); }
      else if (this.kind[i] === 1) { this.alpha[i] = 0.75 * (1 - f); this.size[i] = this.size0[i]; }
      else { this.alpha[i] = Math.sin(Math.PI * f) * (0.65 + 0.35 * Math.sin(time * 9 + i * 2.3)); this.size[i] = this.size0[i]; }
      i++;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, this.n);
    for (const k of ['position', 'color', 'aSize', 'aAlpha', 'aKind']) { const a = g.attributes[k]; a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, this.n * a.itemSize); }
  }
  _kill(i) {
    const j = --this.n; if (i === j) return;
    const i3 = i * 3, j3 = j * 3;
    for (let k = 0; k < 3; k++) { this.p[i3 + k] = this.p[j3 + k]; this.v[i3 + k] = this.v[j3 + k]; this.c[i3 + k] = this.c[j3 + k]; }
    for (const a of [this.size, this.alpha, this.kind, this.life, this.max, this.grav, this.drag, this.size0, this.floorY]) a[i] = a[j];
  }
}

/**
 * GLB 의 수반 물 메시들에 셰이더를 입히고 시뮬레이션과 연결
 */
export class BasinWaterFX {
  /**
   * @param {THREE.Object3D} basin  Basin.glb 의 루트 (월드에 놓인 뒤)
   * @param {import('./basin-sim.js').BasinSim} sim
   */
  constructor(basin, sim) {
    this.sim = sim; this.time = 0;
    const get = (n) => basin.getObjectByName(n);
    this.magic = new THREE.Color(1, 0.8, 0.5); this.tint = new THREE.Color(0.9, 0.9, 0.9);
    this.state = { magicAmt: 0, tintAmt: 0, milk: 0, boost: 0, glitter: 0.6 };
    const lightDir = new THREE.Vector3(0.35, 0.9, 0.45).normalize(), lightCol = new THREE.Color(1.0, 0.86, 0.66);

    const water = get('Basin_Water');
    this.surfaceY = sim.center.y;
    this.waterMat = new THREE.ShaderMaterial({
      vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, transparent: true, depthWrite: true,
      uniforms: {
        uWave: { value: null }, uDye: { value: null }, uWaveT: { value: new THREE.Vector2() },
        uC: { value: sim.center }, uR: { value: sim.radius }, uTime: { value: 0 }, uSlope: { value: 26 },
        uMilk: { value: 0 }, uTintAmt: { value: 0 }, uMagicAmt: { value: 0 }, uGlow: { value: 1 }, uGlitter: { value: 0.6 },
        uTint: { value: this.tint }, uMagic: { value: this.magic }, uLightDir: { value: lightDir }, uLightCol: { value: lightCol },
        uBomb: { value: new THREE.Vector4() }, uBombR: { value: 0.03 }, uFall: { value: new THREE.Vector4(0, -9, 0, 0.03) }, uFoamTex: { value: makeFoamTexture() }, uVel: { value: null }, uVelRes: { value: 128 },
      },
    });
    water.material = this.waterMat; water.renderOrder = 2;

    const upper = get('Basin_WaterUpper');
    if (upper) {
      const impact = new THREE.Vector3();
      get('Basin_SpoutTip')?.getWorldPosition(impact);
      impact.z += 0.02;
      this.upperMat = new THREE.ShaderMaterial({
        vertexShader: WATER_VERT, fragmentShader: UPPER_FRAG, transparent: true,
        uniforms: { uTime: { value: 0 }, uMagicAmt: { value: 0 }, uTintAmt: { value: 0 }, uImpact: { value: impact },
          uMagic: { value: this.magic }, uTint: { value: this.tint }, uLightDir: { value: lightDir }, uLightCol: { value: lightCol } },
      });
      upper.material = this.upperMat; upper.renderOrder = 2;
    }

    const fall = get('Basin_WaterFall');
    if (fall) {
      this.fallMat = new THREE.ShaderMaterial({
        vertexShader: WATER_VERT, fragmentShader: FALL_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { uTime: { value: 0 }, uMagicAmt: { value: 0 }, uTintAmt: { value: 0 }, uSurfY: { value: this.surfaceY }, uCutY: { value: -1e9 }, uCutZ: { value: 1e9 }, uMagic: { value: this.magic }, uTint: { value: this.tint } },
      });
      fall.material = this.fallMat; fall.renderOrder = 3;
      // 물줄기가 아래 수면에 닿는 곳 (가장 낮은 정점들의 평균)
      const pos = fall.geometry.attributes.position, v = new THREE.Vector3(); let minY = 1e9;
      fall.updateWorldMatrix(true, false);
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(fall.matrixWorld); minY = Math.min(minY, v.y); }
      const acc = new THREE.Vector3(); let k = 0;
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(fall.matrixWorld); if (v.y < minY + 0.01) { acc.add(v); k++; } }
      // 위 접시에서 아래 그릇으로 떨어지는 물 커튼은 없앰 (토출구 → 위 접시 물줄기만 남김)
      if (upper) {
        const ub = new THREE.Box3().setFromObject(upper);
        this.fallMat.uniforms.uCutY.value = ub.max.y - 0.004;
        const tip = new THREE.Vector3(); get('Basin_SpoutTip')?.getWorldPosition(tip);
        this.fallMat.uniforms.uCutZ.value = tip.z + 0.045;   // 토출구 물줄기보다 앞(위 접시 가장자리 커튼)은 자름
      }
      this.fallPoint = null;
    }

    const halo = get('Basin_Halo');
    if (halo) {
      halo.geometry.computeBoundingBox();
      const bb = halo.geometry.boundingBox.clone().applyMatrix4(halo.matrixWorld);
      this.haloMat = new THREE.ShaderMaterial({
        vertexShader: HALO_VERT, fragmentShader: HALO_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 }, uY0: { value: bb.min.y }, uY1: { value: bb.max.y }, uBoost: { value: 0 }, uMagicAmt: { value: 0 },
          uC: { value: sim.center }, uMagic: { value: this.magic } },
      });
      halo.material = this.haloMat; halo.renderOrder = 6;
      this.haloTop = bb.max.y;
    }

    this.bubbles = new Particles(700, false);
    this.sparks = new Particles(500, true);
    basin.parent.add(this.bubbles.points, this.sparks.points);
    this._u = new THREE.Vector2();
  }

  /** 배스밤이 녹으며 물 전체를 물들임 */
  addTint(color, amt) {
    const a = this.state.tintAmt;
    const w = amt / Math.max(1e-3, a + amt);
    this.tint.lerp(color, w);
    this.state.tintAmt = Math.min(0.55, a + amt);
    this.state.milk = Math.min(0.8, this.state.milk + amt * 1.3);
  }
  pulseMagic(color, amt) {
    this.magic.lerp(color, 0.15);
    this.state.magicAmt = Math.min(1, Math.max(this.state.magicAmt, amt));
    this.state.boost = Math.min(1.2, Math.max(this.state.boost, amt));
  }
  /** 녹는 중인 배스밤 (거품 꽃 위치). null 이면 끔 */
  setBomb(p, r = 0.03, rate = 1) {
    const U = this.waterMat.uniforms;
    if (!p) { U.uBomb.value.w = Math.max(0, U.uBomb.value.w - 0.02); return; }
    U.uBomb.value.set(p.x, p.y, p.z, Math.min(1, U.uBomb.value.w + 0.03)); U.uBombR.value = r;
  }
  reset() { this.waterMat.uniforms.uBomb.value.w = 0;
    Object.assign(this.state, { magicAmt: 0, tintAmt: 0, milk: 0, boost: 0 }); }

  update(dt, renderer) {
    this.time += dt; const t = this.time, S = this.state, sim = this.sim;
    // 물줄기가 떨어지는 곳: 계속 잔물결 + 바깥으로 흐름 + 약간의 거품
    if (this.fallPoint) {
      const u = sim.toUv(this.fallPoint.x, this.fallPoint.z, this._u);
      sim.addWave(u.x + (Math.random() - 0.5) * 0.01, u.y + (Math.random() - 0.5) * 0.01, 0.012, -0.012 * (0.6 + Math.random() * 0.8));
      if (Math.random() < 0.5) sim.addVel(u.x, u.y, 0.05, 0, 0.05);
      sim.addDye(u.x, u.y, 0.035, 0, 0, 0, 0.06 * dt * 60);
      if (Math.random() < 0.6) {
        const a = Math.random() * Math.PI * 2, r = 0.006 + Math.random() * 0.012;
        this.bubbles.spawn(this.fallPoint.x + Math.cos(a) * r, this.surfaceY + 0.002, this.fallPoint.z + Math.sin(a) * r,
          Math.cos(a) * 0.03, 0, Math.sin(a) * 0.03 + 0.02, { size: 0.003 + Math.random() * 0.003, life: 0.4 + Math.random() * 0.6, kind: 0, drag: 1.5 });
      }
      for (let k = 0; k < 2; k++) if (Math.random() < 0.7) {                     // 튀어 오르는 잔 물보라
        const a = Math.random() * Math.PI * 2, v = 0.12 + Math.random() * 0.25;
        this.bubbles.spawn(this.fallPoint.x + (Math.random() - 0.5) * 0.04, this.surfaceY + 0.004, this.fallPoint.z + (Math.random() - 0.5) * 0.02,
          Math.cos(a) * v * 0.5, 0.25 + Math.random() * 0.35, Math.sin(a) * v * 0.5,
          { color: [0.9, 0.97, 1], size: 0.0018 + Math.random() * 0.0022, life: 0.6, kind: 1, grav: 9.8, floorY: this.surfaceY - 0.003 });
      }
    }
    // 은은한 빛 알갱이 (늘)
    if (Math.random() < dt * 1.5) {
      const a = Math.PI + Math.random() * Math.PI, r = Math.random() * sim.radius * 0.85;
      const col = S.magicAmt > 0.1 ? [this.magic.r, this.magic.g, this.magic.b] : [1, 0.82, 0.5];
      this.sparks.spawn(sim.center.x + Math.cos(a) * r, this.surfaceY + 0.02, sim.center.z - Math.sin(a) * r * 0.9 + 0.02,
        0, 0.03 + Math.random() * 0.04, 0, { color: [col[0] * 0.5, col[1] * 0.45, col[2] * 0.35], size: 0.003 + Math.random() * 0.003, life: 3 + Math.random() * 3, kind: 2 });
    }
    S.magicAmt = Math.max(0, S.magicAmt - dt * 0.12);
    S.boost = Math.max(0, S.boost - dt * 0.25);
    const breathe = 0.85 + 0.15 * Math.sin(t * 1.3);

    const W = this.waterMat.uniforms;
    W.uWave.value = sim.waveTexture; W.uDye.value = sim.dyeTexture; W.uVel.value = sim.vel.read.texture; W.uVelRes.value = sim.vel.size; W.uWaveT.value.copy(sim.waveTexel);
    W.uTime.value = t; W.uMilk.value = S.milk; W.uTintAmt.value = S.tintAmt; W.uMagicAmt.value = S.magicAmt; W.uGlow.value = breathe;
    W.uGlitter.value = S.glitter;
    for (const m of [this.upperMat, this.fallMat]) if (m) { m.uniforms.uTime.value = t; m.uniforms.uMagicAmt.value = S.magicAmt; m.uniforms.uTintAmt.value = S.tintAmt; }
    if (this.haloMat) { const H = this.haloMat.uniforms; H.uTime.value = t; H.uBoost.value = S.boost * breathe; H.uMagicAmt.value = Math.min(1, S.magicAmt * 1.2); }

    // 입자 크기: 화면(눈) 해상도 기준
    let h = 900;
    if (renderer.xr.isPresenting) h = renderer.xr.getBaseLayer?.()?.framebufferHeight ?? 1800;
    else h = renderer.getDrawingBufferSize(this._sz ??= new THREE.Vector2()).y;
    this.bubbles.mat.uniforms.uScale.value = this.sparks.mat.uniforms.uScale.value = h * 0.5;
    this.bubbles.update(dt, t); this.sparks.update(dt, t);
  }
}
