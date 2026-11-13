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
| `pattern-editor.html` | **편집기** — 롤별 무늬·크기 + **진행 방식** + **✨ 이펙트 켜기/끄기·수치 조절·미리보기** → JSON 저장 / 데모에 적용 |
| `src/wrap-flow.js` | **단순 진행** `AutoWrapFlow` (고르기 → 자동 자르기·놓기 → 모으기 → 리본) + 입력 `bindSimpleInput()` |
| `src/lamp.js` | 램프 `BankerLamp` — 당김 줄로 켜고 끄기 (전구·갓 안쪽·오팔 갓 빛 + 조명) |
| `src/effects.js` | **게임 이펙트** `Effects` — 반짝임·연기·색종이·별·빛 고리·완성 문구·효과음 (WebAudio 합성) |
| `paper-config.json` | 설정 파일 (데모·편집기가 읽음) |
| `src/wrapping-paper.js` | **핵심 모듈** `WrappingPaperRack` (엔진 독립: 손/가위는 아무 Object3D) |
| `src/xr-input.js` | WebXR 컨트롤러 연결 `bindXRControllers()` + 가위 끝 표식 |
| `models/PaperRollRack.glb` | 블렌더에서 내보낸 랙 모델 (텍스처 WebP 내장, 약 1.1 MB) |
| `textures/*.jpg` | 포장지 무늬 이미지 3종 |
| `lib/three/` | three.js r187 (오프라인 동작용 로컬 사본, MIT) |
| `serve.command` | macOS 로컬 서버 실행 스크립트 |

## 높이 조절
랙과 자른 종이가 놓이는 면의 높이는 기본 0.55 m 예요. 주소 뒤에 `?h=0.4` 처럼 붙이면 바꿀 수 있어요 (예: https://irangnam.github.io/paper-roll-rack-xr/?h=0.4).

## 조작 — 단순 진행 (기본)
교수님 피드백 반영: 사소한 동작은 자동으로, 손동작은 **당기기** · **고르기(누르기)** 두 가지만.

| 단계 | VR 손 | VR 컨트롤러 | PC |
|---|---|---|---|
| ① 포장지 당기기 | 롤을 **핀치**(엄지·검지 붙이기)한 채 내 쪽으로 당기기 (가리키고 핀치해도 됨) | 트리거/그립 누른 채 당기기 | 롤을 **누른 채 아래로 드래그** |
| → 자동 | 포장할 만큼(기본 35 cm) 나오면 **지지직** 저절로 끊어짐 — 항상 **오른쪽 → 왼쪽**으로 찢어짐 → 포장 자리로 날아가 '착' → 배스밤이 폴짝 올라감 | | |
| ② 🎁 포장하기 | 배스밤을 톡 / 핀치 · 두 손으로 감싸 모으기 | 배스밤 가리키고 트리거 | 화면 아래 **🎁 포장하기** 버튼 · 배스밤 클릭 |
| → 자동 | 꼭짓점이 올라와 차킨 포장 → 선물 통통 + 효과음 | | |
| ③ 리본 고르기 | 포장지 왼쪽 **열린 리본 상자**의 리본을 가리키고 핀치 / 톡 | 트리거 | 리본 클릭 |
| → 자동 | 리본이 날아가 선물 목에 붙음 → 선물 통통 + 효과음 · 선물을 한 번 더 누르면 처음부터 | | |

- 가위질 없음. 다 당기기 전에 놓으면 종이는 롤로 말려 들어감. 바닥에 떨어지는 것 없음.
- PC `R` / ↺ 처음부터 버튼 = 처음부터.
- 편집기 **진행 방식**: 당길 길이, 찢어지는 시간, 포장 시간, 연출 속도 등.
- 예전 방식(직접 당기고 가위질)은 편집기의 **진행 방식 → 예전 방식** 또는 주소 `?mode=manual`.

## 🔊 효과음 · 움직임 (편집기에서 켜기/끄기 · 바꾸기)
화면 효과(파티클·빛 고리·떠 있는 안내판/버튼·완성 문구)는 넣지 않고, **움직임**(찢어짐·날아가기·폴짝·찌그러짐·선물 통통·리본 날아가기)과 **효과음**만.
- 편집기 **🔊 효과음 · 움직임**: 전체 켜기 · 전체 음량 · 가리킬 때 빛남 · 포장 완성 / 리본까지 완성 때 선물 통통·완성 효과음
- **효과음마다**(당김 드르륵 · 지지직 · 휙 · 폴짝 · 착지 · 포장되는 중 · 포장 완성 · 리본 완성 · 램프 딸깍 · 고를 때 · 가위): 켜기 · 음량 · 음 높이 · ▶ 듣기
  - **파일 올리기**: 내 소리(mp3 · wav · ogg, 1.5 MB 이하)로 바꿈 — 설정 안에 함께 저장됨
  - 또는 **경로**를 적기 (예: `sounds/tear.mp3` — 저장소에 `sounds/` 폴더를 만들어 넣으면 모든 기기에서 같은 소리)
  - **원래대로**: 기본 합성음 · 음량 1 · 음 높이 1
- **데모에 적용** 누르면 이 브라우저의 데모가 그 설정을 씀 · 다운로드한 JSON 의 `effects.sounds` 로 모든 기기에 적용

## 조작 — 예전 방식 (`?mode=manual`)
**VR — 손 추적** (컨트롤러를 내려놓으면 자동으로 손 인식)
- **주먹 쥐기** = 종이 끝 / 바닥의 자른 종이 잡기, **손 펴기** = 놓기
- **가위 손** (검지·중지만 펴고 약지·새끼는 접기)으로 늘어진 종이에 손가락 끝을 대고 **벌렸다 붙이기 3번** = 그 자리에서 자르기
- 종이를 들고 **손목을 돌린 뒤 놓으면** 그때 위를 향한 면 그대로 바닥에 놓임 (세워서 들고 있었으면 내 쪽을 보던 면이 위로)
- 자르지 않고 놓은 종이는 롤로 말려 들어감 · 절취선 가이드는 없음 (`showGuide: true` 로 다시 켤 수 있음)

**VR — 컨트롤러**: 그립 = 잡기/놓기 · 오른손 트리거 = 가위질 1번 (3번에 잘림)

**PC**: 종이 끝 마우스 드래그 = 왼손으로 잡기 → 드래그 중 `Space` = 왼손 고정(마우스 = 가위) → 종이 위에서 **클릭 3번** = 자르기 → `Space` = 놓기 · `F` = 뒤집기(들고 있는 종이 / 마우스 아래 바닥 종이) · 고정 중 `W/A/S/D` 상하좌우, `Q/E` 앞뒤 · `R` 리셋 · `X` 조각 지우기 · `Esc` 놓기

손 모양 판정 기준(손가락 접힘/폄 거리, 가위 벌림 간격)은 `src/xr-input.js` 의 `HAND` 에서 조절할 수 있어요.

## 작업 공간 (블렌더 WorkTable.blend 그대로)
테이블(윗면 1.0 m, `?h=0.8` 처럼 높이 변경) 위에 뒤쪽 롤 랙, 앞쪽 가운데 포장 자리, **랙 왼쪽에 나란히 뚜껑이 활짝 열린 리본 상자**(12° 돌려 가운데를 봄, 블렌더에서 열린 자세로 배치·내보냄), 오른쪽에 배스밤, **랙 오른쪽에 은행원 램프**(흰 오팔 유리 갓 · 앤티크 황동, 블렌더 `BankerLamp.glb`, 켜진 상태). **오른쪽 당김 줄을 클릭 / 가리키고 핀치 / 손가락으로 톡**(예전 방식은 잡기)하면 줄이 내려갔다 올라오며 딸깍 켜고 꺼짐 — `src/lamp.js`, 코드로는 `app.lamp.toggle()` · `setOn()`. 테이블보 폭 32 cm.
- 포장지는 테이블보(울퉁불퉁한 가장 높은 곳 1.0023 m)보다 위(1.0035 m)에 놓임.
- 당길 때 종이가 랙 앞 아래 모서리·다른 롤·테이블을 뚫지 않도록 당기는 방향을 앞쪽으로 들어 올림 (당긴 길이는 그대로). 찢어지거나 날아가는 종이도 테이블 위로만 움직임.
모델: `models/WorkTable.glb`, `models/PaperRollRack.glb`, `models/GiftWrap.glb`, `models/RibbonBox.glb`

## 🎁 배스밤 포장 (GiftWrap.glb — 블렌더 셰이프 키)
- 포장지 꼭짓점(흰 점) 4개를 하나씩 잡아 배스밤 위로 들어 올렸다 놓기 → 충분히 올리면 고정, 4개 다 하면 차킨(복주머니) 모양으로 마무리 → 선물째로 들 수 있음
- 셰이프 키: `Corner1~4_Half`, `Corner1~4_Fold`, `Wrapped` — 블렌더에서 모양을 고치고 다시 내보내면 그대로 반영
- 접기 전에는 배스밤을 들어 옮길 수 있고, 잘라서 테이블에 놓은 종이 위에 놓으면 그 무늬로 포장지가 바뀜(40 cm 정사각)
- `B` / '배스밤 리셋' = 처음 상태로 · 코드: `src/gift-wrap.js`

## 📦 리본 상자 (RibbonBox.glb)
폭 28 × 깊이 16 × 높이 11 cm (랙의 1/2 폭). 뚜껑을 잡아 들어 올리면 뒤 경첩을 따라 열리고, 충분히 연 뒤 놓으면 열린 채로, 덜 열고 놓으면 닫힘. PC 는 뚜껑 드래그 또는 `O`. 코드: `src/ribbon-box.js`

## 자른 종이가 놓이는 곳
- 테이블 윗면(테이블보 위) 안: 테이블에 놓임 · 모서리 밖으로 나간 부분은 모서리를 감싸며 아래로 처짐
- 가운데가 테이블 밖: 모서리에 걸쳐 바깥으로 미끄러진 뒤 방 바닥으로 떨어짐 · 닿는 순간 조금 미끄러지다 멈춤
- 설정: `rack.setSurfaces({ table: {minX,maxX,minZ,maxZ,y}, floorY })` (index.html)

## 🧵 테이블보
테이블 길이 방향으로 깐 리넨 런너(40 cm 폭) — 가운데 솔잎·호랑가시 가랜드 자수와 벨벳 리본 아플리케, 양 끝은 붉은 벨벳 띠로 테이블 밖으로 늘어짐 (WorkTable.glb 의 `TableRunner`)

## 🎀 리본 (Ribbons.js + Ribbon_0N.glb)
상자 뚜껑을 연 뒤 안의 리본을 잡아 꺼내고, 포장 완료된 선물의 목 근처에서 놓으면 목 앞에 붙음 (선물을 들면 같이 움직임). 다른 곳에 놓으면 상자로 돌아가고, 붙은 리본을 다시 잡으면 떼어 바꿀 수 있음.
- Ribbon_01: 와인색 벨벳 리본 + 금색 구슬 테두리 + 방울 (블렌더 텍스트 `Ribbon01_Build.py` 로 재생성)
- 재질: 테이블 = 호두나무 판재, 상자 = 마호가니(래커), 랙 = 오크, 상자 안감·리본 = 벨벳(Sheen)

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
rack.snip()                           // 가위질 1번 (snipsToCut 번이면 잘림)
rack.flipPiece(piece)                 // 바닥 종이 뒤집기
rack.tryCut()                         // 바로 자르기
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
