# 버틀러 (Butler) — 퇴거 정산 PoC

아파트 임대차에서 **퇴거 시점의 돈 문제를 공공데이터로 계산하고, 양 당사자가 같은 숫자를 보고
합의하게 만드는** 임대인용 CRM PoC입니다.

계약 체결 → 거주 중 이력 관리 → 갱신·퇴거 통보 → 퇴거 점검 → 정산서 합의 → 확정까지
임대차 한 주기 전체가 동작합니다.

- **프런트엔드** Vue 3 + Vite (`:5173`)
- **백엔드** Express 5 + SQLite (`:3001`)
- **외부 연동** K-apt 공공데이터(국토교통부), CLOVA OCR — **둘 다 없어도 전 구간이 돌아갑니다**
- **테스트** `node --test` 10묶음 190건 전부 통과

---

## 검증하려는 가설

| # | 가설 | 어떻게 검증하나 |
|---|---|---|
| 1 | K-apt 공공데이터만으로 장기수선충당금 대납액을 자동 산출할 수 있는가 | 단지·전용면적·거주기간을 넣으면 **월별 근거와 함께** 금액이 나온다 |
| 2 | 양 당사자가 같은 숫자를 보면 합의에 도달하는가 | 항목별 동의/이의 → 전원 동의일 때만 확정(seal) + 해시 동결 |
| 3 | 계산할 수 없을 때 그것을 정직하게 말할 수 있는가 | 0원 줄을 지우지 않고 `status`·`reason`으로 **왜 0원인지** 항상 설명한다 |

가설 3은 구현 중에 추가됐습니다. "해당 없음", "계산했더니 0원", "계산을 못 했음"이
화면에서 전부 똑같이 보이면 정산서를 믿을 수 없기 때문입니다.

---

## 핵심 설계 — Rule Lock

기존 서비스가 쓰는 **고정 감가 테이블**이 아닙니다.
계약 시점에 당사자가 확정(Rule Lock)한 파라미터를 퇴거 시점에 **그대로 재생**하는 계산 엔진입니다.

```
계약 시점                          퇴거 시점
─────────                          ─────────
내용연수 합의                       K-apt 공공데이터 (월별 단가)
면제 거주기간 합의        ────►     +  퇴거 점검 결과 (귀책비율)
소액수선 기준 합의                  +  Rule Lock 파라미터
장충금 부담주체 합의                ─────────────────────────
        │                          = 정산서 (항목별 근거 포함)
        └── 양측 서명 후 잠금              │
                                          └── 항목별 동의 → 전원 동의 → 확정(해시 동결)
```

**법적 포지셔닝**: 이 엔진은 법정 기준을 판정하지 않습니다. 당사자가 합의한 값을 재생할 뿐이고,
UI 전반에 "합의 참조값"임을 명시합니다. 다만 판례 흐름(통상손모는 임대인 부담, 원상복구 범위는
감가상각 반영 현재가치 이내)은 계산식에 강제로 반영돼 있습니다.

---

## 실행 방법

Node 22 이상이 필요합니다. **서버를 두 개 띄웁니다.**

```bash
git clone <이 저장소>
cd butler-settlement
```

```bash
# 1) 백엔드 API — http://localhost:3001
cd server
npm install
npm run seed        # DB 초기화 — 임대인 '버틀러' 계정만 만듭니다 (집·계약 0건)
npm start
```

```bash
# 2) 프런트엔드 — http://localhost:5173   ← 화면은 여기
cd client
npm install
npm run dev
```

`:3001`을 브라우저로 열어도 화면은 없습니다. API만 제공하고, `:5173`의 개발 서버가
`/api` 요청을 `:3001`로 넘깁니다 (`client/vite.config.js`의 proxy).

> **개발 서버 전용입니다.** `vite build`는 현재 통과하지 않습니다(최상위 await).
> PoC 목적상 `npm run dev`로만 확인합니다.

### 처음 한 번 — 단지 목록 받아 오기

임대인은 '버틀러' 하나뿐이라 로그인 화면이 없고, `:5173`을 열면 바로 임대 현황입니다.
집을 추가하려면 K-apt 단지 목록이 DB에 있어야 합니다.

```bash
curl -X POST localhost:3001/api/complexes/sync-list   # 전국 약 22,000 단지, 20초 내외
```

한 번 받아 두면 DB에 남습니다. 이후 단지 검색은 **API를 부르지 않고 DB에서** 찾습니다.
키가 없으면 시드 단지 몇 개로 대신합니다.

### 시연용 데이터

```bash
cd server && npm run seed:demo    # 집·계약·점검이 들어간 상태로 되돌립니다
```

### 테스트

```bash
cd server && npm test             # 10묶음 190건
```

| 묶음 | 무엇을 지키나 |
|---|---|
| `engine.test.js` | 계산 엔진. **깨졌다면 엔진을 건드린 것입니다** |
| `registry.test.js` | 등기부 파서 (픽스처 기반, DB 비의존) |
| `contract-ocr.test.js` | 계약서 파서 · 한글 금액 파싱 · 마스킹 |
| `share.test.js` / `settlement-share.test.js` | 공유 링크, 규칙 버전, 합의·확정 |
| `tasks.test.js` | 할 일 규칙 (날짜는 오늘 기준 상대값) |
| `renewal.test.js` / `inspection.test.js` | 갱신·거절, 퇴거 점검 |
| `house-log.test.js` | 집 단위 이력 (품목·수선) |
| `kapt.test.js` | 공공데이터 어댑터 (네트워크 스텁) |

---

## 외부 연동 (선택)

**키가 하나도 없어도 전 구간이 동작합니다.** 없으면 픽스처·시드 모드로 자동 폴백합니다.

```bash
cp server/.env.example server/.env    # 값이 무엇이고 어디서 나오는지 전부 적혀 있습니다
cd server && npm run check-env        # 무엇이 켜졌고 무엇이 폴백인지 확인
```

### K-apt (공공데이터포털)

`KAPT_SERVICE_KEY` 하나로 **세 API**를 씁니다. 키는 계정당 1개지만 **활용신청은 API마다 따로** 해야 합니다.

| API | 쓰는 값 |
|---|---|
| 공동주택 단지 목록제공 서비스 | 전국 단지 코드·이름·주소 |
| 공동주택관리비(장기수선충당금)정보서비스 | 단지 월 부과총액 `sLevy` |
| 공동주택 기본 정보제공 서비스 | 전용면적합 `privArea` |

```
단가(원/㎡) = sLevy ÷ privArea
```

두 번째 API가 주는 값은 단지 **전체 총액**이라 세 번째 API의 면적으로 나눠야 세대 단가가 됩니다.

> **일반 인증키(Decoding)** 를 넣으세요. Encoding 키(`%2B`가 보이는 쪽)를 넣으면 인증이 깨집니다.
> 개발계정은 하루 5,000회 + 초당 제한이 따로 있어, 동기화는 300ms 간격으로 한 번에 20건씩만 부릅니다.

### CLOVA OCR (등기부·계약서 인식)

```
OCR_PROVIDER=clova
OCR_API_KEY=<Secret Key>
OCR_ENDPOINT=https://<고유값>.apigw.ntruss.com/custom/v1/<도메인ID>/<키>/general
```

끝에 **`/general`** 을 붙여야 합니다. `clovaocr-api-kr.ncloud.com` 쪽 고유 InvokeURL은
사설 IP로 풀려 VPC 밖에서 연결되지 않으니 반드시 API Gateway 주소를 쓰세요.
`OCR_PROVIDER`를 비우면 `server/fixtures/`의 텍스트 픽스처로 돌아갑니다.

---

## 아키텍처

### 전체 구조

```
브라우저 :5173 ── /api proxy ──► Express :3001 ──► SQLite (butler.db)
   │                                  │
   │                                  ├──► K-apt 공공데이터 (단지·장충금·면적)
   │                                  └──► CLOVA OCR (등기부·계약서)
   │
   ├── 임대인 화면  /            로그인 없음, 임대인은 '버틀러' 하나
   └── 임차인 화면  /t/:token    계정 없음, 링크 하나로만 참여
```

### 계층

```
routes/api.js      HTTP. 검증하고 service를 부른다. 비즈니스 규칙 없음
service.js         유스케이스. 트랜잭션 · 상태 전이 · 공유 링크 발급 · 확정(seal)
repository.js      데이터 접근. snake_case → camelCase 변환만
engine/            ★ 순수 계산. DB도 네트워크도 모른다
services/          외부 어댑터 (kapt · ocr · registry · contract) + tasks · timeline
```

**`engine/`은 순수 함수입니다.** 확정된 정산서를 나중에 다시 계산해 검증할 수 있어야 하기 때문에
이 성질을 깨지 않습니다. 계산식을 바꿔야 하면 `test/engine.test.js`에 테스트를 먼저 추가합니다.

### 계산 엔진

`buildSettlement()`이 단일 진입점이고, 항목별 계산기를 순서대로 부릅니다.

| 파일 | 계산 |
|---|---|
| `engine/dates.js` | 기간·점유비율 |
| `engine/ltrf.js` | 장기수선충당금 (월별 단가 × 전용면적 × 거주월) |
| `engine/maintenance.js` | 관리비 일할 · 선수관리비 |
| `engine/restoration.js` | 원상회복 감가상각 · 수선비 정산 |
| `engine/arrears.js` | 미납 차임 · 지연이자 |

모든 계산기는 금액과 함께 **`status`·`reason`** 을 돌려줍니다.

| `status` | 뜻 |
|---|---|
| `counted` | 계산했다 |
| `partial` | 일부 기간만 계산했다 (공공데이터가 나머지를 공개하지 않음) |
| `unavailable` | **계산하지 못했다** — 이유를 화면에 적는다 |
| `none` | 해당 없음 (특약으로 제외됐거나 부과액이 0) |

0원 줄을 **지우지 않습니다.** 지우면 위 네 가지가 화면에서 전부 똑같이 사라집니다.
합계는 어차피 같습니다 — 0원은 더해도 0원입니다.

### 데이터 모델 (23개 테이블)

```
landlords ─┬─ units ─┬─ contracts ─┬─ rule_sets ── rule_items      ← Rule Lock 파라미터
           │         │             ├─ damage_reports               ← 퇴거 점검 결과
           │         │             ├─ rent_arrears
           │         │             ├─ inspections ── inspection_photos
           │         │             ├─ share_links                  ← 임차인 참여 경로
           │         │             ├─ contract_responses
           │         │             └─ settlements ── settlement_lines
           │         ├─ unit_items                                 ← 품목 시공 이력
           │         ├─ repair_events                              ← 수선 이력
           │         └─ registry_documents                         ← 등기부 OCR 결과
           └─ tasks                                                ← 할 일 (규칙으로 생성)

complexes ─┬─ ltrf_rates          단지 월별 장충금 단가
           ├─ ltrf_absent         공개되지 않은 달 — 다시 묻지 않으려고 기록
           └─ maintenance_rates
```

마이그레이션은 `db.js`가 기동 때 수행합니다. 컬럼 추가는 `COLUMN_PATCHES`로,
SQLite가 못 바꾸는 제약(NOT NULL 해제 등)은 테이블 재작성으로 처리합니다.

### 상태 전이

```
집     vacant ──► contracting ──► occupied ──► closing ──► vacant
                  (계약서 발송)   (임차인 동의)  (퇴거 통보)   (정산 확정)

계약   draft ──► sent ──► active ──► closing ──► closed
          ▲        │
          └────────┘  임차인이 수정 요청(rejected)하면 다시 고칠 수 있다
```

집이 공실로 돌아오는 시점은 **퇴거일이 아니라 정산 확정 시점**입니다. 퇴거일이 지나도
정산이라는 할 일이 남아 있고, 다음 임차인 계약이 이미 있으면 되돌리지 않습니다.

### 임차인 참여 — 계정 없이 링크로만

임차인 역할이 시스템에 **없습니다.** 임차인은 `/t/:token` 한 경로로만 들어옵니다.

| `share_links.purpose` | 임차인이 하는 일 |
|---|---|
| `contract_review` | 계약 내용 확인 → 동의 또는 수정 요청 |
| `repair_report` | 수선 신고 |
| `inspection` | 퇴거 점검 사진 제출 |
| `settlement` | 정산 항목별 동의/이의 제기 |

토큰은 용도를 검사하므로 정산 링크로 계약을 고칠 수 없습니다.

### 할 일 (tasks)

`services/tasks.js` 한 파일이 **할 일이 나타나는 모든 경우의 수**입니다.
DB에 쌓아 두지 않고 규칙으로 그때그때 계산합니다.

`ownership_unverified` · `tenant_pending` · `renewal_decision` · `renewal_deadline` ·
`repair_open` · `settlement_issue` · `agreement_due`

---

## 화면

| 경로 | 내용 |
|---|---|
| `/` | 임대 현황 — 집 목록 + 할 일 |
| `/units/new` | 집 추가 (단지 → 동·호·면적 → 등기부 확인) |
| `/units/:id` | 집 상세 — 계약 기록, 품목·수선 이력 |
| `/units/:id/registry` | 등기부 재인식 |
| `/contracts/new` | 계약 작성 (계약서 OCR로 초안 채우기) |
| `/contracts/:id` | 계약 상세 |
| `/contracts/:id/document` | 보낸 계약서 다시 보기 |
| `/contracts/:id/rules` | **Rule Lock** — 계약 시점 규칙 확정 |
| `/contracts/:id/inspection` | 퇴거 점검 검토 |
| `/contracts/:id/settlement` | **퇴거 정산서** — 근거 + 양측 합의 |
| `/t/:token` | **임차인 화면** — 계정 없이 링크로만 |

---

## 개인정보·보안에서 지키는 것

- `server/.env`는 **절대 커밋하지 않습니다.** 저장소에는 `.env.example`만 있습니다.
- 외부 키는 모듈 import 시점이 아니라 **호출 시점에** 읽습니다 (`.env` 로딩 순서 때문).
- `registry_documents.raw_text`는 **마스킹해서** 저장합니다 — 주민번호 뒷자리를 남기지 않습니다.
- 업로드 원본(`server/uploads/`)은 **정적으로 서빙하지 않습니다.** DB id로만 꺼냅니다.
  저장소에도 올리지 않습니다.
- **계약서 OCR은 아무것도 저장하지 않습니다.** DB 행도, 원문도 남기지 않고 업로드 파일은
  `finally`에서 지웁니다. 주민번호 마스킹은 2차 방어입니다.
- 임대인 응답 경로는 `party` 파라미터를 받지 않습니다. 임대인이 임차인인 척할 수 없습니다.
- `landlord_note`는 임차인 응답에 절대 포함되지 않습니다.

---

## 디자인

화면은 **[docs/DESIGN-clay.md](docs/DESIGN-clay.md)** (Clay 디자인 시스템)를 따릅니다.
토큰은 `client/src/style.css`의 `:root` 한 곳에 있습니다.

- 크림 캔버스 고정 — 바닥 `#faf5e8` / 카드 `#fffaf0`. 쿨 그레이를 쓰지 않습니다.
- **다크 모드 없음 · 반응형 없음** (데스크톱 전용, `min-width: 1080px`).
- 그림자 없음. 깊이는 채도 팔레트 6색(pink · teal · lavender · peach · ochre · mint)의
  상태 배지 대비로 만듭니다.
- CTA는 근검정 `#0a0a0a`, 버튼·입력 높이 44px, 라운드 12px / 카드 16px.

---

## 아직 안 된 것

- **관리사무소 고지서 단가 직접 입력** — K-apt가 0을 주는 단지에서 손으로 단가를 넣을 칸이 없습니다.
  화면 문구는 그 방법을 안내하고 있는데 입력칸이 아직 없습니다. 가장 우선순위가 높습니다.
- `maintenance_rates`가 비어 있어 퇴거월 관리비는 항상 `unavailable`입니다 (활용신청 필요).
- 수선 신고·처리 경로가 미구현이라 `repair_open` 할 일이 실제로 뜨지 않습니다.
- 계약서 OCR에서 K-apt 단지 자동 매칭, CLOVA `boundingPoly` 줄 재조립이 남아 있습니다.
- `vite build`가 최상위 await 때문에 실패합니다. 개발 서버로만 확인하고 있습니다.

---

## 문서

| 문서 | 내용 |
|---|---|
| [docs/POC-SUMMARY.md](docs/POC-SUMMARY.md) | **구조 요약** — 유스케이스 · 아키텍처 · 파일별 책임 · 주행 검증 결과 |
| [docs/V2-SPEC.md](docs/V2-SPEC.md) | 전체 명세 — 구현 순서는 여기 §9 |
| [docs/progress.md](docs/progress.md) | **어디까지 했는지.** 단계별 상태 · 설계 판단 · 잡은 버그 |
| [docs/CONTRACT-OCR-PLAN.md](docs/CONTRACT-OCR-PLAN.md) | 계약서 OCR 설계 |
| [docs/DESIGN-clay.md](docs/DESIGN-clay.md) | 디자인 시스템 |
| [docs/HANDOFF.md](docs/HANDOFF.md) | 인수인계 |

`docs/samples/`에 OCR 시험용 더미 등기부(PDF)가 있습니다. **시험용 예시**로 표시돼 있고
실재하지 않는 내용입니다.
