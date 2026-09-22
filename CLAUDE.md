# 버틀러 퇴거 정산 — 프로젝트 지침

## 지금 하는 일

`docs/V2-SPEC.md` 에 따라 **v2(임대인 CRM 기반 전체 생애주기)** 를 구현합니다.
구현 순서는 그 문서 §9를 따릅니다.

**어디까지 했는지는 `docs/progress.md` 를 먼저 보세요.** 단계별 완료 상태, 설계 판단,
잡은 버그, 다음 단계로 넘긴 것이 거기 있습니다.

## 절대 규칙

1. **`server/src/engine/**` 를 수정하지 마세요.** 계산 엔진은 DB·네트워크를 모르는 순수 함수이고,
   확정된 정산서를 나중에 재계산해 검증하기 위해 이 성질이 유지되어야 합니다.
   계산식을 바꿔야 한다면 먼저 `server/test/engine.test.js` 에 테스트를 추가하고 바꾸세요.
2. **`npm test` 는 항상 전부 통과 상태**여야 합니다. 현재 11묶음 200건입니다.
   - `engine.test.js` — 계산 엔진. **깨졌다면 엔진을 건드린 것입니다.**
   - `registry.test.js` — 등기부 파서 (픽스처 기반, DB 비의존)
   - `contract-ocr.test.js` — 계약서 파서 · 한글 금액 · 마스킹
   - `share.test.js` — 공유 링크·규칙 버전 (임시 DB 사용)
   - `settlement-share.test.js` — 정산서 임차인 합의 링크
   - `tasks.test.js` — 할 일 규칙 (임시 DB 사용, 날짜는 오늘 기준 상대값)
   - `renewal.test.js` — 갱신 체인 · 기간 계산 · Rule Lock 승계
   - `inspection.test.js` — 퇴거 개시 · 점검 제출/검토 · damage_reports
   - `house-log.test.js` — 집 단위 이력 (품목 시공 · 수선). 라우터 검증을 타려고
     임시 포트에 express 를 띄워 **실제 요청**을 보냅니다.
   - `kapt.test.js` — K-apt 어댑터·적재. `globalThis.fetch` 를 스텁해
     **네트워크 없이** 돕니다. 공공데이터가 죽어도 테스트는 초록이어야 합니다.
   - `tenancy-chain.test.js` — 갱신 체인의 수선 누적 · 품목 승계 ·
     전 항목 0원 정산서의 확정. 전 구간 주행에서 잡은 결함 3건의 회귀 테스트입니다.
3. **외부 키 없이 전체 흐름이 돌아야 합니다.** K-apt·OCR 모두 키가 없으면 픽스처로 폴백합니다.
   새 외부 연동을 추가할 때도 같은 패턴(`services/kapt.js`)을 따르세요.
4. **계약 파기**라는 용어를 쓰지 마세요. 정상 종료는 **계약 만료 / 합의 해지**이고,
   UI 버튼은 **"퇴거 절차 시작"** 입니다.
5. 정산 금액은 **법적 판정이 아니라 합의 참조값**입니다. 화면 문구에서 이 포지셔닝을 유지하세요.
5-1. **임대인 CRM 에 임차인 역할을 만들지 마세요.** 임차인의 동의·이의·사진 제출은
   전부 `/t/:token` 공유 링크로만 들어옵니다. 임대인이 임차인 동의를 대신 누를 수
   있으면 합의 기록이 증거로서 의미를 잃습니다. 임대인 화면은 **현황만** 보여 줍니다.
6. **다크 모드와 모바일 대응을 넣지 마세요.** 아래 "화면 · 디자인" 참조.

## 계층과 책임

```
routes/api.js   라우팅 · 입력 검증          ← 여기에 비즈니스 로직 두지 말 것
service.js      발행 · 합의 · 확정 · 트랜잭션
repository.js   SQL 전담 · snake_case→camelCase
engine/         순수 계산 (수정 금지)
services/       외부 어댑터 · 도메인 규칙 (kapt, kapt-sync, ocr, registry, timeline, tasks)
```

> `kapt.js` 는 **받아오기만**, `kapt-sync.js` 가 **DB 에 앉히기**를 합니다.
> 실 단가를 쓰려면 적재가 반드시 있어야 합니다 — 이게 없어서 한동안 키를 넣어도
> 정산 숫자가 한 줄도 바뀌지 않았습니다.
> 네트워크는 `calculate()` **바깥**에서 끝냅니다. 엔진 입력을 만드는 경로가 동기 함수로
> 남아야 확정된 정산서를 나중에 그대로 재계산해 검증할 수 있습니다.

> `services/*.js` 에서 `db.prepare()` 를 모듈 최상단에 두지 마세요. ESM import 가
> `migrate()` 보다 먼저 평가되어 `no such table` 로 죽습니다.
> `repository.js` 처럼 `() => db.prepare(...)` 로 감싸세요.

바꾸려는 것별로 손댈 파일:

| 바꾸려는 것 | 손댈 곳 |
|---|---|
| 계산식 · 새 정산 항목 | `engine/*.js` + 테스트 |
| 합의 규칙 · 확정 조건 | `service.js` |
| 외부 데이터 소스 | `services/*.js` |
| 기한 · 할 일 규칙 | `services/timeline.js` (날짜) + `services/tasks.js` (규칙) |
| 새 API | `routes/api.js` + `repository.js` |
| 화면 | `client/src/views/*` |
| 색·간격·타이포 | `client/src/style.css` 토큰만. 컴포넌트에 하드코딩 금지 |

## 화면 · 디자인

디자인 시스템은 **`docs/DESIGN-clay.md`** 입니다. 화면을 만들거나 고치기 전에 읽으세요.
토큰은 `client/src/style.css` 의 `:root` 에 있습니다.

### 시스템 계약 — 어기지 말 것

1. **크림 캔버스 고정.** 바닥 `--bg` #faf5e8, 카드 `--surface` #fffaf0.
   쿨 그레이를 쓰지 마세요. 따뜻한 크림 톤이 이 시스템의 전제입니다.
2. **다크 모드 없음.** `prefers-color-scheme` 미디어 쿼리를 추가하지 마세요.
   OS가 다크여도 화면은 크림으로 유지됩니다.
3. **데스크톱 전용.** 반응형 축소·미디어 쿼리·모바일 레이아웃을 넣지 마세요.
   `body { min-width: 1080px }` 이며 그 아래로는 가로 스크롤합니다.
   그리드는 `repeat(3, 1fr)` 처럼 고정 컬럼으로 두고 `auto-fill` 을 쓰지 마세요.
   (예외: `@media print` 는 정산서 인쇄용이라 유지합니다.)
4. **그림자를 쓰지 마세요.** 깊이는 크림 바닥과 채도 높은 배지의 색 대비로 만듭니다.
   `--shadow` 는 `none` 입니다.

### 쓰는 값

- **CTA**: 근검정 `--accent` #0a0a0a. 파란 버튼을 쓰지 마세요.
- **라운드**: 버튼·입력 `--radius-md` 12px / 카드 `--radius` 16px / 배지 `--radius-pill`.
- **높이**: 버튼·입력 44px (`.btn`, `input`, `select` 에 이미 들어 있음).
- **간격**: `--sp-*` (4px 배수) 만 사용.
- **채도 팔레트 6색** — pink · teal · lavender · peach · ochre · mint.
  상태 배지에 씁니다: `.pill.ok`(mint) `.pill.accent`(lavender) `.pill.peach`
  `.pill.warn`(ochre) `.pill.pink` `.pill.teal`.
  **같은 색을 나란히 두지 마세요.** 7번째 브랜드 색을 추가하지 마세요.
- **타이포**: Inter + 한글 폴백. 디스플레이는 weight 500 + 음수 자간,
  본문은 400. weight 700 이상으로 올리지 마세요.

## 도메인 상수 (임의 변경 금지)

- 계약갱신청구권 행사 기간: 만료 **6개월 전 ~ 2개월 전**
- 만료 2개월 전까지 갱신거절 미통지 → **묵시적 갱신**
- 장기수선충당금은 **소유자 부담** (공동주택관리법 시행령 제31조 제8항) — 임차인 대납 시 퇴거 때 반환
- 원상회복 공제 = 교체비용 × max(0, 1 − 경과연수/내용연수) × 임차인 귀책비율
- 통상손모(귀책 0)는 임대인 부담
- **갱신 계약은 최초 입주일을 유지합니다.** 갱신 때 `move_in_date` 를 새로 잡으면
  엔진이 이전 기간의 장기수선충당금을 통째로 빠뜨립니다 (`service.renewContract` 주석 참조).
- **장기수선충당금 단가 = K-apt 월 부과총액(`sLevy`) ÷ 단지 전용면적합(`privArea`).**
  엔진이 세대 전용면적을 곱하므로 분모도 전용면적이어야 단위가 맞습니다.
- **한 단지의 단가는 실데이터든 시드든 하나로 통일합니다.** 섞으면 실측 236원/㎡ 옆에
  시드 555원/㎡ 이 끼어 그 달만 금액이 두 배로 뛰는데, 화면에는 둘 다 그냥 "단가"로
  보여 설명할 수 없습니다. 적재에 성공하면 그 단지의 시드 단가는 지웁니다.
  빠진 달은 엔진이 직전 실단가를 이어 쓰고 `imputed` 로 표시합니다.

## 개인정보

등기부·점검 사진에는 민감정보가 있습니다.
- `registry_documents.raw_text` 는 주민번호 마스킹 후 저장
- `server/uploads/**` 는 정적 서빙 대상에서 제외
- 업로드 파일은 **id 로만** 꺼냅니다 (`/registry-documents/:id/file`,
  `/inspection-photos/:id/file`). 경로를 입력으로 받는 엔드포인트를 만들지 마세요.
  API 응답에 `file_path` 를 담지 마세요.

## 실행

```bash
cd server && npm install && npm run seed && npm start   # :3001 — API 전용
cd client && npm install && npm run dev                 # :5173 — 화면은 여기
cd server && npm test                                   # 엔진 · 파서 · 공유링크
```

### 데이터는 비어 있는 상태에서 시작합니다

`npm run seed` 는 **임대인 '버틀러' 계정 하나만** 만듭니다. 집·계약·단지·단가는
화면에서 직접 등록합니다. 샘플 데이터를 심지 않는 이유는 화면의 숫자가 실제로 들어온
값인지 시드가 넣어 둔 값인지 구분되어야 하기 때문입니다.

- **로그인 화면이 없습니다.** 임대인이 하나뿐이라 시작 화면이 바로 임대 현황입니다.
  세션 가드도, 당사자 전환도 없습니다 (절대 규칙 5-1).
- 단지 목록은 K-apt 에서 받습니다 — `POST /api/complexes/sync-list` (약 20초).
- 예전 시연용 데이터(계약 5건 · 단지 3곳 · 96개월 단가)는 `src/seed-demo.js` 에
  남아 있습니다. `npm run seed:demo` 로 되돌릴 수 있습니다.

> **`:3001` 은 화면을 서빙하지 않습니다.** `:5173` 의 Vite 개발 서버가 `/api` 만
> `:3001` 로 프록시합니다. 예전에는 `client/dist` 가 있으면 정적 서빙했는데,
> 빌드가 낡으면 `:3001` 에 몇 단계 전 화면이 남아 "고쳤는데 왜 그대로냐"가 됩니다.
> 정적 서빙을 다시 넣지 마세요.

> `npm run seed` 출력을 `Select-Object -First N` 같은 것으로 자르지 마세요.
> PowerShell 이 파이프라인을 조기 종료시켜 시드가 중간에 끊깁니다.

### 외부 연동 키

`server/.env` 에 넣습니다 (`.env.example` 복사). 없으면 픽스처·시드 모드로 자동 폴백합니다.

```bash
cd server && npm run check-env      # 키가 실제로 먹히는지 확인
```

| 변수 | 용도 |
|---|---|
| `KAPT_SERVICE_KEY` | data.go.kr — 계정당 1개. 아래 **세 API 를 전부 활용신청**해야 합니다 |
| `OCR_PROVIDER` | `clova` \| `upstage` \| 빈값(픽스처) |
| `OCR_API_KEY` | CLOVA Secret Key / Upstage API Key |
| `OCR_ENDPOINT` | CLOVA APIGW Invoke URL — **도메인마다 다름**, 시크릿만으론 부족 |

K-apt 는 서비스가 셋으로 나뉘어 있고 **하나만 신청하면 나머지는 403** 입니다.

| 서비스 | 경로 | 쓰는 값 |
|---|---|---|
| 단지 목록 (15057332) | `AptListService4/getTotalAptList4` | 전국 단지코드·이름 |
| 장기수선충당금 (15059160) | `AptRepairsCostServiceV3/getHsmpMonthFeeInfoV3` | `sLevy` 월 부과총액 |
| 기본 정보 (15058453) | `AptBasisInfoServiceV5/getAphusBassInfoV5` | `privArea` 전용면적합 |

### 실데이터 전환

```bash
curl -X POST localhost:3001/api/complexes/sync-list     # 전국 22,322 단지 (약 20초)
curl -X POST localhost:3001/api/complexes/1/sync        # 단지 기본정보(privArea)
```

단가는 정산 미리보기·발행 때 `svc.ensureRates()` 가 **결측 월만** 지연 적재합니다.
전 구간을 매번 받으면 호출 한도(개발계정 5,000/일)를 금방 씁니다.
이번 달·미래는 K-apt 가 아직 공개하지 않았으므로 요청 자체를 하지 않습니다.

### 호출 제한 — 일일 한도보다 **초당 제한**이 먼저 걸립니다

2026-09-22 실측입니다. 넘으면 HTTP 429 · `resultCode 23 — 초당 서비스 요청제한 횟수 초과`.

| 대상 | 실측 |
|---|---|
| 목록 API 1,000건 × 5페이지 연속 | 전부 정상 (~500ms/건) — 전국 동기화 23회는 안전 |
| 월부과액 API 20회 연속 | 통과 |
| 그 직후 20회 | **전부 429** |
| 회복까지 | **약 30초** (25초까지 429, 30초에 정상) |

그래서 `fetchLtrfRates` 는 **한 번에 20개월까지만**, 300ms 간격으로 받고,
429 를 만나면 **즉시 멈춥니다.** 계속 두드리면 전부 429 로 돌아오고 그 사이
성공할 수 있었던 달까지 잃습니다. 남은 달은 다음 조회에서 이어 받습니다 —
그동안 엔진이 직전 단가를 이어 쓰고 `imputed` 로 표시합니다.

> 전국 목록 동기화(`sync-list`)는 23회뿐이라 가볍습니다. 다만 **사용자 동작마다
> 부르지 마세요.** 한 번 받아 두고 로컬에서 검색하는 것이 이 설계의 전제입니다.

단지 검색은 **로컬 테이블만** 봅니다. 목록 API 에 단지명 검색 파라미터가 없어서,
매번 실 API 를 때리면 찾는 단지가 그 페이지에 없어 0건이 나옵니다.
`sync-list` 로 한 번 받아 두고 그 위에서 검색합니다 — 로컬이지만 내용은 실데이터입니다.

실제로 밟은 함정 두 가지입니다.

- **K-apt 경로에는 버전 접미사가 붙고 구버전은 폐기됩니다.** 현재는
  `AptListService4/getTotalAptList4`, `AptRepairsCostServiceV3/getHsmpMonthFeeInfoV3`
  (월부과액 필드는 `sLevy`). 400 `NO_OPENAPI_SERVICE_ERROR` 는 키가 아니라 **경로**가
  없다는 뜻입니다 — 경로 검사가 키 검사보다 먼저라 키가 틀려도 같은 에러가 납니다.
  포털 명세 페이지의 `Base URL` 을 확인하세요.
- **CLOVA 콘솔은 Public / Private Invoke URL 을 둘 다 보여 줍니다.** Private 을 넣으면
  사설 IP(`10.x`)로 풀려 VPC 밖에서는 타임아웃만 납니다. Public(`https://….apigw.ntruss.com/…`)
  을 넣으세요. `check-env` 가 DNS 를 찍어 미리 걸러 줍니다.

> `services/*.js` 에서 환경변수를 **모듈 최상단 const 로 읽지 마세요.** `.env` 로더보다
> import 가 먼저 평가되면 빈 값으로 굳습니다. `() => process.env.X` 로 감싸세요.
> (`db.prepare()` 와 같은 함정입니다.)
