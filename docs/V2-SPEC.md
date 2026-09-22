# 버틀러 v2 빌드 스펙 — 임대인 CRM 기반 전체 생애주기

> 이 문서는 클로드 코드가 그대로 따라 구현할 수 있도록 쓴 스펙입니다.
> v1(퇴거 정산 PoC)의 계산 엔진을 **그대로 재사용**하고, 그 앞에 임대인 CRM과 계약 흐름을 붙입니다.

---

## 0. 확정된 결정 (재논의 불필요)

| 항목 | 결정 |
|---|---|
| 흐름 주체 | **임대인 고정**. 임차인은 링크로 초대되는 참여자 |
| 임대인 인증 | **없음.** 임대인은 '버틀러' 하나뿐이라 선택 화면도 세션 가드도 두지 않는다. 실제 인증은 범위 밖 |
| 초기 데이터 | **비어 있음.** 시드는 임대인 계정만 만들고, 집·계약·단지는 직접 등록한다 |
| 등기부 검증 | **실제 이미지 업로드 → OCR → 파싱 → 소유자 대조**까지 구현 |
| 등기부 입력 형식 | **이미지** (png/jpg). PDF 아님 |
| OCR | **외부 공급자 어댑터**. 키 없으면 픽스처 모드로 폴백 |
| 입주 점검 | **제외**. 퇴거 점검만 |
| Rule Lock 협상 | 임차인은 **전체 동의 / 거부(사유)**. 거부 시 임대인이 수정해 재전송 |
| 임차인 참여 경로 | **`/t/:token` 링크 전용.** 임대인 CRM 에 임차인 역할·당사자 전환을 만들지 않는다 |
| 정산 합의 | 발행 = 임대인의 제안이자 동의. **클릭하는 쪽은 임차인뿐**이고 임대인은 현황만 본다 |
| 정산서 발행 | **수동.** 할 일로 올리고 임대인이 점검 결과를 확인한 뒤 발행 (§2 주석 참조) |
| 계약 갱신 | **포함**. 2년 주기가 돌아가는 것까지 보여줌 |
| 스택 | 변경 없음 — Vue 3 + Vite / Express 5 / SQLite(better-sqlite3) / Node 22 |
| 디자인 | **`docs/DESIGN-clay.md`** (Clay 시스템). 크림 캔버스 · 채도 팔레트 6색 |
| 다크 모드 | **없음**. `prefers-color-scheme` 분기를 만들지 않는다 |
| 반응형 | **없음**. 데스크톱 전용 (`min-width: 1080px`) |

### 건드리지 말 것

- **`server/src/engine/**`** — 계산 엔진은 한 줄도 바꾸지 않습니다. 입력을 모으는 방식만 시드에서 실제 흐름으로 바뀝니다.
- **`server/test/engine.test.js` 12건** — 전부 통과 상태를 유지합니다. 깨지면 엔진을 건드린 것입니다.

### 용어

- ~~계약 파기~~ → **퇴거 절차 시작** (파기는 귀책 있는 종료를 뜻함)
- 집 카드에 표시되는 이름은 **임차인** 이름 (임대인은 보는 사람)

---

## 1. 전체 흐름

```
[집 등록]  단지 검색 → 동·호·면적 입력 → 등기부 이미지 업로드 → OCR·파싱 → 소유 검증
              ↓ 집 카드 생성 (공실)
[계약 작성]  임차인 정보 + 보증금·기간 + Rule Lock 설정 → 링크 발송
              ↓ (계약 대기)
[계약 확인]  임차인: 계약·규칙 확인 → 전체 동의 / 거부(사유)
              ├ 거부 → 임대인 CRM에 "수정 요청 도착" → 고쳐서 재전송
              └ 동의 → 계약 성립 (거주 중), 카드에 임차인·거주기간 표시
              ↓
[거주 중]    임차인 수선 신고 → 임대인 처리(비용·부담주체) → House Log 누적
              ↓
[D-180]      할 일: "갱신 여부 결정"
              ├ 갱신 → 기간 연장 · Rule Lock 승계 · 장충금 계속 누적 → 다시 [거주 중]
              └ 퇴거 → 아래로
[D-60]       ⚠️ "오늘까지 통지 안 하면 묵시적 갱신"
              ↓
[퇴거 개시]  퇴거 예정일 입력 (퇴거 진행 중) → 점검 링크 발송
              ↓
[D-30]       임차인: 구역별 사진 제출 → 임대인: 항목별 귀책비율 지정
              ↓ 할 일 "정산서를 발행해 주세요" → 임대인이 발행
[합의]       임대인: 정산 확인 링크 발송 (발행이 곧 임대인의 제안·동의)
              ├ 임차인: /t/:token 에서 항목별 동의 / 이의(사유) → 제출
              ├ 이의 → 임대인이 고쳐서 재발행 → 새 링크
              └ 임대인 CRM 에는 동의 현황만 표시 (임차인 역할 없음)
              ↓
[D-7]        "합의 마감 임박 — 미합의 N건"
              ↓
[D-Day]      전원 동의 → 확정(해시 동결) → 집 카드 (공실)
              ↓
          퇴거 시 교체한 품목의 시공일이 → 다음 계약 rule_items의 '최종 시공일'로 승계
```

**고리가 닫히는 지점이 이 설계의 요지입니다.** House Log가 10년 뒤 매도용 기록이 아니라
2년 뒤 다음 계약에서 즉시 쓰이는 입력값이 됩니다.

---

## 2. 법정 타임라인 (임의로 바꾸지 말 것)

주택임대차보호법 제6조의3 기준입니다.

| 시점 | 근거 | CRM 동작 |
|---|---|---|
| 만료 **6개월 전** | 계약갱신청구권 행사 가능 기간 시작 | `renewal_decision` 할 일 생성 (info) |
| 만료 **2개월 전** | 이 날까지 갱신거절 통지 안 하면 **묵시적 갱신** | `renewal_deadline` 할 일 (urgent) |
| 퇴거 **30일 전** | (서비스 정책) | 점검 링크 발송 + `settlement_issue` 할 일 (발행은 임대인이) |
| 퇴거 **7일 전** | (서비스 정책) | `agreement_due` 할 일 (warn) — 미합의 항목 수 |
| 퇴거일 | | 확정 · 보증금 반환 |

> ⚠️ v1 논의에서 나온 "만료 1주일 전 알림"은 **틀린 설계**입니다. 그 시점엔 이미 묵시적 갱신이 끝나 있습니다.

> **정산서는 자동 발행하지 않습니다.** 초안에는 D-30 자동 발행으로 적혀 있었으나,
> 같은 시점이 점검 요청 시점이라 귀책비율이 아직 비어 있습니다. 그대로 자동 발행하면
> **원상회복 0원짜리 정산서가 임차인에게 갑니다.** 할 일로 올리고 임대인이 점검 결과를
> 확인한 뒤 발행합니다. (할 일 계산은 크론이 아니라 홈을 열 때 reconcile 합니다 — §3)

---

## 3. 데이터 모델 델타

기존 13개 테이블은 유지하고 아래를 추가·확장합니다.

```sql
-- ── 임대인 ────────────────────────────────────────────
CREATE TABLE landlords (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ── units 확장: 소유 검증 + 공실 상태 ──────────────────
ALTER TABLE units ADD COLUMN landlord_id           INTEGER REFERENCES landlords(id);
ALTER TABLE units ADD COLUMN ownership_status      TEXT NOT NULL DEFAULT 'unverified';
       -- unverified | verified | name_mismatch | address_mismatch | parse_failed
ALTER TABLE units ADD COLUMN ownership_verified_at TEXT;
ALTER TABLE units ADD COLUMN registry_owner_name   TEXT;   -- 등기부 갑구에서 추출한 소유자명
ALTER TABLE units ADD COLUMN registry_unique_no    TEXT;   -- 고유번호
ALTER TABLE units ADD COLUMN vacancy_status        TEXT NOT NULL DEFAULT 'vacant';
       -- vacant | contracting | occupied | closing

-- ── 등기부 문서 (감사 추적 · 재파싱용) ──────────────────
CREATE TABLE registry_documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id      INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  file_path    TEXT NOT NULL,
  ocr_provider TEXT NOT NULL,        -- clova | upstage | vision | tesseract | fixture
  raw_text     TEXT,                 -- ⚠ 주민번호 마스킹 후 저장 (§5 참조)
  parsed_json  TEXT,
  match_result TEXT NOT NULL,        -- matched | name_mismatch | address_mismatch | parse_failed
  confidence   REAL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ── contracts 확장: 갱신 체인 + 만료일 ──────────────────
ALTER TABLE contracts ADD COLUMN landlord_id        INTEGER REFERENCES landlords(id);
ALTER TABLE contracts ADD COLUMN parent_contract_id INTEGER REFERENCES contracts(id);
ALTER TABLE contracts ADD COLUMN term_months        INTEGER NOT NULL DEFAULT 24;
ALTER TABLE contracts ADD COLUMN expires_on         TEXT;   -- 만료 예정일 (갱신 판단 기준)
ALTER TABLE contracts ADD COLUMN tenant_phone       TEXT;
-- status 값 확장: draft | pending_tenant | rejected | active | renewing | closing | closed

-- ── 임차인 공유 링크 ───────────────────────────────────
CREATE TABLE share_links (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token           TEXT UNIQUE NOT NULL,          -- crypto.randomUUID() 또는 22자 난수
  contract_id     INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  purpose         TEXT NOT NULL,                 -- contract_review | repair_report | inspection | settlement
  expires_at      TEXT,
  first_opened_at TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ── 계약 동의 / 거부 ───────────────────────────────────
CREATE TABLE contract_responses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id  INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  rule_set_id  INTEGER NOT NULL REFERENCES rule_sets(id),
  decision     TEXT NOT NULL,      -- accepted | rejected
  reason       TEXT,
  responded_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ── 퇴거 점검 ─────────────────────────────────────────
CREATE TABLE inspections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id  INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'moveout',
  status       TEXT NOT NULL DEFAULT 'requested',  -- requested | submitted | reviewed
  requested_at TEXT,
  submitted_at TEXT,
  reviewed_at  TEXT
);

CREATE TABLE inspection_photos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  area          TEXT NOT NULL,   -- entrance | livingroom | bedroom | kitchen | bathroom | balcony | etc
  file_path     TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- damage_reports 를 점검 결과와 연결
ALTER TABLE damage_reports ADD COLUMN inspection_id INTEGER REFERENCES inspections(id);
ALTER TABLE damage_reports ADD COLUMN photo_id      INTEGER REFERENCES inspection_photos(id);

-- ── 거주 중 수선 신고 ──────────────────────────────────
CREATE TABLE repair_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id     INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  photo_path      TEXT,
  reported_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  status          TEXT NOT NULL DEFAULT 'open',   -- open | scheduled | done | rejected
  repair_event_id INTEGER REFERENCES repair_events(id)  -- 처리 완료 시 연결
);

-- ── CRM 할 일 ─────────────────────────────────────────
CREATE TABLE tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  landlord_id INTEGER NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  contract_id INTEGER REFERENCES contracts(id) ON DELETE CASCADE,
  unit_id     INTEGER REFERENCES units(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,   -- renewal_decision | renewal_deadline | settlement_issue
                               -- | agreement_due | repair_open | tenant_pending | ownership_unverified
  severity    TEXT NOT NULL DEFAULT 'info',   -- info | warn | urgent
  due_on      TEXT,
  title       TEXT NOT NULL,
  body        TEXT,
  done_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (contract_id, kind)   -- 같은 계약에 같은 종류 할 일 중복 생성 방지
);
```

### 할 일 생성 규칙

크론 없이 **CRM 홈 조회 시 `refreshTasks(landlordId)` 를 호출해 갱신**합니다.
데모에서 결정적으로 재현되고, 인프라가 필요 없습니다.

```js
// server/src/services/tasks.js
// 각 규칙은 (계약 상태, 기준일, 오늘) → 할 일 생성/해제
renewal_decision    : status=active   && today >= expires_on - 180d  && 갱신 미결정
renewal_deadline    : status=active   && today >= expires_on -  60d  && 갱신 미결정  (urgent)
settlement_issue    : status=closing  && today >= move_out_date - 30d && 정산서 미발행
agreement_due       : 정산서 draft    && today >= move_out_date -  7d              (warn)
tenant_pending      : status=pending_tenant && 링크 발송 후 3일 무응답
repair_open         : repair_requests.status='open' 이고 2일 경과
ownership_unverified: units.ownership_status != 'verified'
```

---

## 4. 등기부 OCR · 파싱

### 4.1 어댑터 구조 (kapt.js 패턴을 그대로 따름)

```
server/src/services/ocr.js
  recognize(imagePath) → { text, provider, confidence }
    · OCR_PROVIDER 환경변수로 공급자 선택: clova | upstage | vision | tesseract | fixture
    · 키가 없으면 자동으로 fixture 모드
    · fixture 모드: 같은 경로의 <파일명>.txt 를 읽어 OCR 결과인 척 반환
      → 네트워크 없이 전체 데모가 돌아감. v1의 K-apt 폴백과 같은 원리.

server/src/services/registry.js
  parseRegistry(text)  → { address, dong, floor, ho, uniqueNo, exclusiveArea, owners[], issuedNo }
  verifyOwnership(parsed, expected) → { result, reasons[] }
```

**공급자 추천**: 한국어 표 문서는 네이버 CLOVA OCR 또는 Upstage Document Parse가 강합니다.
Google Vision도 가능하고, Tesseract(kor)는 오프라인 대안이지만 표 구조에서 정확도가 떨어집니다.
**어느 쪽이든 `recognize()` 시그니처만 지키면 교체 가능합니다.**

### 4.2 추출 대상과 정규식

OCR은 글자 사이 공백이 튀므로 **모든 고정 문자열 사이에 `\s*`** 를 넣습니다.

**① 헤더 한 줄 — 가장 견고한 1순위 타깃**

```
[집합건물] 서울특별시 OO구 OO동 300-130 제17동 제1층 제101호
```
```js
/\[\s*집합건물\s*\]\s*(?<address>.+?)\s*제\s*(?<dong>[0-9가-힣]+)\s*동\s*제\s*(?<floor>[0-9]+)\s*층\s*제\s*(?<ho>[0-9]+)\s*호/
```
> 동 표기는 `제17동` / `제101동` / `제가동` 모두 가능하므로 `[0-9가-힣]+`.

**② 고유번호**
```js
/고\s*유\s*번\s*호\s*([0-9]{4}\s*-\s*[0-9]{4}\s*-\s*[0-9]{6})/
```

**③ 전용면적 — 반드시 섹션을 먼저 자를 것**

1동 건물 표시에도 `611.71㎡` 같은 값이 잔뜩 나옵니다. **전유부분 섹션을 먼저 잘라낸 뒤** 찾아야 합니다.

```js
const sec = text.split(/\(\s*전\s*유\s*부\s*분\s*의\s*건\s*물\s*의\s*표\s*시\s*\)/)[1] ?? '';
const area = sec.match(/([0-9]{1,3}\.[0-9]{1,4})\s*(?:㎡|m2|m²)/)?.[1];
```

**④ 소유자 — 갑구에서, 순위번호가 가장 큰 소유권 등기**

```js
const gap = text.split(/【\s*갑\s*구\s*】/)[1]?.split(/【\s*을\s*구\s*】/)[0] ?? '';
// 공유자(지분)면 여러 명이 나옴 → 배열로 수집
const owners = [...gap.matchAll(/(?:소\s*유\s*자|공\s*유\s*자)\s*([가-힣]{2,5})/g)].map(m => m[1]);
```

### 4.3 섹션 분할 토큰

```js
/【\s*표\s*제\s*부\s*】/        // 2회 등장: 1동 건물 / 전유부분
/\(\s*전유부분의\s*건물의\s*표시\s*\)/
/【\s*갑\s*구\s*】/
/【\s*을\s*구\s*】/
```

### 4.4 검증 규칙

| 조건 | 결과 |
|---|---|
| `owners` 에 임대인 이름 포함 | `matched` → `ownership_status='verified'` |
| 이름 불일치 | `name_mismatch` |
| 주소·동·호 불일치 | `address_mismatch` |
| 필수 필드(주소/호/소유자) 추출 실패 | `parse_failed` → **수동 입력 폴백 화면** |

> **한계를 UI에 명시할 것**: 등기부 갑구에는 성명과 주소 일부만 있고 주민번호는 마스킹됩니다.
> 따라서 **동명이인을 구분할 수 없고, 위조 이미지를 걸러낼 수 없습니다.**
> PoC에서는 "제출된 등기부와 입력값이 일치함"까지만 주장하고, 실제 본인확인은 상용 과제로 둡니다.

### 4.5 샘플 이미지 요구사항 ← **지금 만드실 것**

각 샘플은 **한 장 안에(또는 연속 페이지로) 아래 셋을 모두** 포함해야 파서를 완성할 수 있습니다.

1. **헤더 줄** — `[집합건물] <주소> 제N동 제N층 제N호` + `고유번호`
2. **【표제부】( 전유부분의 건물의 표시 )** — 전용면적 `㎡` 포함
3. **【갑구】** — `소유자 <성명>` 이 들어간 소유권이전 행

만들어 주시면 좋은 변형 4종 (파서 강건성 테스트용):

| 샘플 | 내용 | 기대 결과 |
|---|---|---|
| A | 단독 소유, 정상 | `matched` |
| B | 공유자 2인 (지분 표기) | `matched` (지분 표시) |
| C | 소유자가 임대인과 다른 이름 | `name_mismatch` |
| D | 을구에 근저당 포함 (노이즈) | `matched` |

- 해상도: **가로 1600px 이상**, 그레이스케일 이상
- 저장 위치: `server/fixtures/registry/sample-a.png`
- 각 샘플마다 **정답 JSON** 을 같이 만들어 주세요 → `sample-a.expected.json`
  (파서 테스트가 자동화됩니다)
- 외부 OCR 없이 돌릴 **픽스처 텍스트** → `sample-a.png.txt`
  (실제 OCR을 한 번 돌려 나온 원문을 저장해 두면 그 뒤로는 무료·오프라인으로 테스트 가능)

---

## 5. 개인정보 처리

등기부에는 **소유자 성명·주소·주민번호 앞자리**가 있습니다. PoC라도 그대로 쌓지 마세요.

```js
// raw_text 저장 전 마스킹
text.replace(/([0-9]{6})\s*-\s*[0-9*]{1,7}/g, '$1-*******')
```

- `registry_documents.raw_text` 는 **마스킹 후** 저장
- 업로드 원본 이미지는 `server/uploads/registry/` 에 두되, **정적 서빙 대상에서 제외**하고 인증된 요청에만 스트리밍
- 점검 사진(`server/uploads/inspections/`)도 동일

---

## 6. API 추가분

기존 17개는 유지하고 아래를 추가합니다.

```
# 임대인 / 집
POST   /api/session                      데모 로그인 {landlordId}
GET    /api/landlords/:id/units          소유 집 + 현재 계약 요약 (카드용)
GET    /api/landlords/:id/tasks          refreshTasks 후 할 일 목록
POST   /api/units                        집 추가 {complexId, dong, ho, exclusiveArea}
POST   /api/units/:id/registry           등기부 이미지 업로드 → OCR → 파싱 → 검증
GET    /api/units/:id                    집 상세 (House Log: 계약·수선·품목 이력)

# 계약
POST   /api/contracts                    (확장) landlordId, termMonths, expiresOn
POST   /api/contracts/:id/send           임차인 링크 생성 → {url, token}
POST   /api/contracts/:id/renew          갱신 — 새 contract 생성, parent 연결, rule_set 승계
POST   /api/contracts/:id/start-moveout  퇴거 절차 시작 {moveOutDate}

# 임차인 (토큰 기반, 인증 없음)
GET    /api/share/:token                 용도별 컨텍스트 반환
POST   /api/share/:token/contract-response  {decision, reason}
POST   /api/share/:token/repair          수선 신고 {description, photo}
POST   /api/share/:token/photos          점검 사진 업로드 {area, file}
POST   /api/share/:token/inspection-submit   점검 제출 완료 → 링크 닫힘
POST   /api/share/:token/settlement-response {seq, status, note}  항목별 동의/이의
POST   /api/share/:token/settlement-submit   정산 확인 제출 → 링크 닫힘

# 점검
POST   /api/contracts/:id/inspection     점검 요청 생성 + 링크 발급
POST   /api/inspections/:id/review       항목별 귀책비율 지정 → damage_reports 생성

# 정산 합의
POST   /api/contracts/:id/settlement         정산서 발행 (임대인 쪽은 전 항목 동의로 시작)
POST   /api/contracts/:id/settlement/send    정산 확인 링크 발급 → {url, token}
GET    /api/contracts/:id/settlement         정산서 + shareLink(발급·열람·제출 시각)
POST   /api/settlements/:id/lines/:seq/respond  **임대인 전용** — party 를 받지 않는다
POST   /api/settlements/:id/seal             전원 동의 시 확정(해시 동결)

# 수선
POST   /api/repair-requests/:id/resolve  {cost, paidBy, cause} → repair_events 기록
```

> **임차인의 응답은 `/api/share/:token/…` 으로만 들어옵니다.**
> `POST /settlements/:id/lines/:seq/respond` 는 `party` 를 받지 않고 항상 임대인으로
> 기록합니다. 임대인이 임차인 동의를 대신 누를 수 있으면 합의 기록이 증거로서
> 의미를 잃습니다. 계약 확인·점검·정산 모두 같은 원칙입니다.

---

## 7. 화면

디자인은 **`docs/DESIGN-clay.md`** 를 따릅니다. 토큰은 `client/src/style.css` 의 `:root` 에 있고,
컴포넌트에서 색·간격·라운드를 하드코딩하지 않습니다.

- 크림 캔버스 고정 (바닥 #faf5e8 / 카드 #fffaf0). 쿨 그레이 금지.
- 다크 모드 없음 · 반응형 없음 (데스크톱 전용, `min-width: 1080px`).
- 그림자 없음. 깊이는 채도 높은 상태 배지의 색 대비로 만든다.
- CTA 는 근검정 #0a0a0a, 버튼·입력 높이 44px, 라운드 12px / 카드 16px.

### 임대인
| 경로 | 내용 |
|---|---|
| `/` | **시작 화면 = CRM 홈** — "버틀러님의 임대 현황". 상단 할 일, 하단 집 카드 목록 |
| `/units/new` | 집 추가 (단지 검색 → 동·호·면적 → 등기부 업로드 → 검증 결과) |
| `/units/:id` | 집 상세 = **House Log** (계약 이력 · 수선 이력 · 품목 시공 이력) |
| `/contracts/new?unitId=` | 계약 작성 + Rule Lock (v1 `RuleLock.vue` 재사용) |
| `/contracts/:id` | 계약 상세 — 상태별 액션 |
| `/contracts/:id/inspection` | 점검 검토 — 사진 보며 귀책비율 지정 |
| `/contracts/:id/settlement` | 정산서 — 발행 · 확인 링크 발급/복사 · **임차인 동의 현황** · 확정 |

> **임대인 화면에 임차인 역할을 만들지 마세요.** v1 의 당사자 전환 토글은
> 제거했습니다. 이 화면이 보여 주는 것은 *임차인이 어디까지 왔는가* 뿐입니다 —
> 링크 미발송 / 발송함 / 열람함 / 제출함, 항목별 동의·이의와 그 사유.

### 임차인 — 단일 진입점
| 경로 | 분기 |
|---|---|
| `/t/:token` | `purpose` 에 따라: 계약 확인 / 수선 신고 / 사진 제출 / 정산 합의 |

정산 합의 분기는 이렇게 동작합니다.

1. 최종 반환액을 먼저 크게 보여 준다 (보증금 포함)
2. 항목마다 **동의 / 이의** — 금액을 누르면 계산 근거가 펼쳐진다
3. **이의에는 사유가 필수** — 없으면 임대인이 무엇을 고칠지 모른다
4. 전 항목을 확인해야 **제출** 버튼이 열리고, 제출하면 링크가 닫힌다
5. 임대인이 고쳐서 재발행하면 **그 계약의 정산 링크는 전부 폐기**된다
   (제출을 마친 것까지. 남겨 두면 옛 링크가 새 정산서를 열어, 화면에는
   "확인이 제출되었습니다" 라면서 바뀐 금액이 보인다)

> 데모에서는 **창을 두 개 띄워** 임대인·임차인을 나란히 보여주는 편이
> 역할 전환 토글보다 훨씬 설득력 있습니다.

---

## 8. 시드 — 데모를 위해 4개 계약을 각 단계에 배치

시간을 기다리지 않고 전 구간을 보여주려면 시드가 각 단계에 하나씩 있어야 합니다.

| # | 상태 | 보여주는 것 |
|---|---|---|
| 1 | `pending_tenant` | 임차인 링크 확인 → 동의/거부 |
| 2 | `active`, 만료 D-400 | 거주 중 · 수선 신고/처리 |
| 3 | `active`, 만료 **D-150** | **갱신 판단** 할 일 + D-60 경고 |
| 4 | `closing`, 퇴거 **D-20** | 점검 → 정산서 → 합의 → 확정 |

추가로 **`closed` 계약 1건**을 2번 집에 물려 두면, House Log에 이전 사이클이 남아
"지난번 도배 시공일"이 이번 Rule Lock에 자동으로 들어오는 것을 보여줄 수 있습니다.

---

## 9. 구현 순서 (이 순서대로 진행 권장)

1. **스키마 마이그레이션 + 시드 재작성** — §3, §8. 여기서 전체 구조가 고정됩니다.
2. **CRM 홈 + 집 카드 목록** — 계산 엔진과 무관, 화면 뼈대 먼저.
3. **집 추가 + OCR 어댑터(fixture) + 파서 + 파서 테스트** — 샘플 이미지 도착 전에도 `.txt` 픽스처로 진행 가능.
4. **계약 작성 + Rule Lock + 링크 발송** — v1 `RuleLock.vue` 재사용.
5. **임차인 링크 화면 (contract_review)** + 거부→수정→재전송 루프.
6. **tasks 규칙 + 홈 표시** — §3 규칙표 그대로.
7. **갱신** — 새 contract 생성 · parent 연결 · rule_set 승계.
8. **퇴거 개시 + 점검 요청/제출/검토** → `damage_reports` 생성.
9. **정산서 연결** — 계산 입력을 실제 데이터로 바꾸고, 합의를 임차인 공유 링크로 분리.
   임대인 화면은 발행 · 링크 발송 · 동의 현황 · 확정까지만 맡습니다.
10. **실제 OCR 공급자 연결** — 마지막. 앞 단계가 전부 픽스처로 돌아가야 합니다.

---

## 10. 완료 검증 체크리스트

- [ ] `npm test` — 기존 엔진 테스트 12건 전부 통과 (엔진 무변경 확인)
- [ ] 파서 테스트 — 샘플 A~D가 각각 기대 결과(`*.expected.json`)와 일치
- [ ] `KAPT_SERVICE_KEY`, `OCR_PROVIDER` 둘 다 없이 **전체 흐름이 끝까지 진행됨**
- [ ] 집 추가 → 계약 → 임차인 동의 → 수선 1건 → 갱신 → 퇴거 → 점검 → 정산 → 확정까지 한 번에 통과
- [ ] 갱신 후 장기수선충당금 누적 개월이 **연장된 기간만큼 늘어남**
- [ ] 확정된 정산서를 다시 열었을 때 해시가 동일 (동결 검증)
- [ ] 임차인 토큰으로 **다른 계약에 접근 불가**
- [ ] 임대인 화면에서 **임차인 동의를 대신 누를 수 없음** (당사자 전환 토글 없음,
      `POST /settlements/:id/lines/:seq/respond` 가 `party` 를 받지 않음)
- [ ] 정산서를 다시 발행하면 **이전 정산 링크가 전부 폐기**됨 (제출 완료분 포함)
- [ ] 임차인 응답 payload 에 `landlord_note` 가 없음
- [ ] `registry_documents.raw_text` 에 주민번호 원문이 없음
- [ ] OS 를 다크 모드로 두어도 화면이 크림으로 유지됨 (다크 분기 없음)
- [ ] `client/src/**` 에 `prefers-color-scheme` · `max-width` 미디어 쿼리가 없음
      (`@media print` 는 예외)

---

## 부록 · v1에서 그대로 가져오는 것

| 파일 | 상태 |
|---|---|
| `server/src/engine/**` | **무변경** |
| `server/src/service.js` | 정산 발행·합의·확정 로직 유지, 입력 소스만 교체 |
| `server/src/repository.js` | 신규 테이블 접근 함수 추가 |
| `client/src/views/Settlement.vue` | **임대인 전용**으로 재사용. 임차인 쪽은 `TenantShare.vue` 의 `settlement` 분기 (계산 근거 `LineDetail.vue` 는 양쪽이 공유) |
| `client/src/views/RuleLock.vue` | 계약 작성 화면에 흡수 |
| `client/src/components/LineDetail.vue` | 재사용 |
