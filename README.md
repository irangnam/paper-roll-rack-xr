# 포장지 롤 랙 — three.js / WebXR 인터랙션 모듈

## 실행
- macOS: `serve.command` 더블클릭 → http://localhost:8000
- 또는 터미널: `cd ~/PaperRollRack/web && python3 -m http.server 8000`
- (파일을 직접 더블클릭해서 열면 모듈 로딩이 막혀서 동작하지 않아요. 꼭 서버로 여세요.)
- VR 헤드셋(Quest 등): WebXR 은 https 또는 localhost 에서만 동작합니다.
  USB 연결 후 `adb reverse tcp:8000 tcp:8000` 하고 헤드셋 브라우저에서 http://localhost:8000 을 열거나, https 로 호스팅하세요.

## 파일
| 파일 | 역할 |
|---|---|
| `index.html` | **WebXR 데모** (VR 진입 버튼 + 데스크톱 마우스 조작) |
| `pattern-editor.html` | **패턴 편집기** — 롤별 이미지 교체, 무늬 크기, 종이 폭, 가로 위치, 뒷면 색, 인터랙션 수치 조정 → JSON 저장 / 데모에 적용 |
| `paper-config.json` | 설정 파일 (데모·편집기가 읽음) |
| `src/wrapping-paper.js` | **핵심 모듈** `WrappingPaperRack` (엔진 독립: 손/가위는 아무 Object3D) |
| `src/xr-input.js` | WebXR 컨트롤러 연결 `bindXRControllers()` + 가위 끝 표식 |
| `models/PaperRollRack.glb` | 블렌더에서 내보낸 랙 모델 (텍스처 WebP 내장, 5.2 MB) |
| `textures/*.jpg` | 포장지 무늬 이미지 3종 |
| `lib/three/` | three.js r187 (오프라인 동작용 로컬 사본, MIT) |
| `serve.command` | macOS 로컬 서버 실행 스크립트 |

## 높이 조절
랙과 자른 종이가 놓이는 면의 높이는 기본 0.55 m 예요. 주소 뒤에 `?h=0.4` 처럼 붙이면 바꿀 수 있어요 (예: https://irangnam.github.io/paper-roll-rack-xr/?h=0.4).

## 조작
**VR**
- 그립 또는 트리거: 종이 끝(또는 바닥에 늘어진 끝)을 잡고 당기기 / 자른 종이 잡기
- 오른손 컨트롤러 앞 9 cm = 가위 날 끝 (빨간 점). 늘어진 종이에 8 cm 이내로 가까이 가면 **절취선(빨간 점선) + 잘릴 길이**가 뜨고, 닿으면 그 위치에서 잘림
- 종이를 잡은 채로 자르면 자른 조각을 그대로 들고 있음 → 놓으면 가상 바닥으로 떨어져 무늬 면이 위로 눕고 남음 (최대 20장)

**PC**: 종이 끝 마우스 드래그 = 왼손으로 잡고 당기기 → 드래그 중 `Space` = 왼손 고정(이제 마우스 = 오른손 가위) → 종이 위에 마우스 = 절취선, 클릭 = 자르기 → `Space` = 왼손 놓기 · 고정 중 `W/A/S/D` 상하좌우, `Q/E` 앞/뒤 · `R` 리셋 · `X` 조각 지우기 · `Esc` 놓기
- 자르지 않고 놓은 종이는 롤로 다시 말려 들어갑니다 (`retractOnRelease`, `retractSpeed`).

## 게임에 넣기
```js
import { WrappingPaperRack } from './src/wrapping-paper.js';
import { bindXRControllers } from './src/xr-input.js';

const config = await fetch('paper-config.json').then(r => r.json());
const rack = new WrappingPaperRack(config, { renderer, baseUrl: './' });
await rack.load();
rack.root.position.set(0, 0.75, -0.55);    // 책상 위 등 원하는 위치
scene.add(rack.root);
bindXRControllers(renderer, scene, rack);   // 직접 입력을 처리하면 생략

// 매 프레임
rack.update(dt);

// 직접 입력 처리 시 (손/가위 = 아무 Object3D)
rack.grab(handObject) / rack.release(handObject)
rack.setScissors(scissorsTipObject)   // null 이면 해제
rack.tryCut()                         // cutMode 'trigger' 일 때
rack.addEventListener('cut',  e => { e.roll; e.length; e.piece });
rack.addEventListener('land', e => { e.piece });
rack.setPattern(0, { image: 'textures/새무늬.jpg', tileWidth: 0.15 });
rack.setPaperWidth(2, 0.40);
```
- 좌표: `rack.root` 로컬, 단위 m, 앞쪽 +Z. `surfaceY`(기본 0 = 랙 바닥면)가 자른 종이가 내려앉는 가상 바닥 높이.
- 무늬는 롤에서 풀려 나온 누적 길이 기준이라 당겨도·잘라도 무늬가 이어집니다.
- 길게 뽑은 종이는 랙 앞 아래 모서리를 넘어 처지고, 남는 부분은 바닥에 눕습니다.

## 설정 (paper-config.json)
- `rolls[i].image` 무늬 이미지 (경로 또는 data URL) · `tileWidth` 이미지 1장의 가로 크기(m), 세로는 이미지 비율 · `paperWidth` 종이 폭(m, 최대 0.47) · `offsetU` 가로 위치(0~1) · `backColor` 뒷면 색
- 무늬 이미지는 **위아래·좌우가 이어지는(seamless) 이미지**여야 이음새가 안 보입니다.
- `interaction`: `cutMode`('contact' | 'trigger'), `scissorsHand`('right' | 'left'), `guideDistance`, `contactDistance`, `grabRadius`, `maxPull`, `maxPieces`, `fallSpeed` …
