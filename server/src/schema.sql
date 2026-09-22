-- =====================================================================
-- 버틀러 퇴거 정산 PoC — SQLite 스키마
-- 설계 원칙
--   1) 계산에 쓰인 "값"이 아니라 "근거"를 남긴다 (basis_json)
--   2) 규칙(rule_set)은 계약 시점에 잠기고(lock), 퇴거 시 그대로 재생된다
--   3) 정산서는 확정(seal) 시점에 스냅샷으로 동결된다
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- 1. 단지 / 공공데이터 캐시
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS complexes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kapt_code         TEXT UNIQUE NOT NULL,   -- K-apt 단지코드 (예: A13822201)
  name              TEXT NOT NULL,
  address           TEXT,
  sido              TEXT,
  sigungu           TEXT,
  total_households  INTEGER,
  built_year        INTEGER,
  data_source       TEXT NOT NULL DEFAULT 'seed'  -- 'kapt' | 'seed'
);

-- 단지별 "월별" 장기수선충당금 단가 (원/㎡)
-- K-apt는 월 단위로 공개되므로 인상 이력이 그대로 반영된다.
CREATE TABLE IF NOT EXISTS ltrf_rates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  complex_id    INTEGER NOT NULL REFERENCES complexes(id) ON DELETE CASCADE,
  ym            TEXT NOT NULL,              -- 'YYYY-MM'
  rate_per_sqm  REAL NOT NULL,              -- 원/㎡/월
  data_source   TEXT NOT NULL DEFAULT 'seed',
  UNIQUE (complex_id, ym)
);

-- 단지별 "월별" 관리비 단가 (원/㎡) — 퇴거월 일할정산 추정용
-- K-apt 에 물어봤지만 부과액이 없던 달
--
-- K-apt 는 단지·기간에 따라 `sLevy` 를 null 또는 0 으로 준다 (오류가 아니라 정상 응답).
-- 그 달을 기록해 두지 않으면 **매번 같은 빈 달을 다시 묻는다.** 한 번에 받는 개월 수에
-- 상한이 있어서, 앞쪽에 빈 달이 길게 깔린 단지는 데이터가 있는 최근 달에 영영 닿지 못한다.
-- (실측: 경희궁의아침4단지는 2024-12부터만 공개 → 2021년부터 시작하는 계약이 계속 0원)
CREATE TABLE IF NOT EXISTS ltrf_absent (
  complex_id  INTEGER NOT NULL REFERENCES complexes(id) ON DELETE CASCADE,
  ym          TEXT NOT NULL,
  checked_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (complex_id, ym)
);

CREATE TABLE IF NOT EXISTS maintenance_rates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  complex_id    INTEGER NOT NULL REFERENCES complexes(id) ON DELETE CASCADE,
  ym            TEXT NOT NULL,
  rate_per_sqm  REAL NOT NULL,              -- 공용관리비+개별사용료 합계 원/㎡/월
  data_source   TEXT NOT NULL DEFAULT 'seed',
  UNIQUE (complex_id, ym)
);

-- ---------------------------------------------------------------------
-- 2. 세대 / 계약
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS units (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  complex_id      INTEGER NOT NULL REFERENCES complexes(id) ON DELETE CASCADE,
  dong            TEXT,
  ho              TEXT,
  exclusive_area  REAL NOT NULL             -- 전용면적 ㎡
);

CREATE TABLE IF NOT EXISTS contracts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id        INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  landlord_name  TEXT NOT NULL,
  tenant_name    TEXT NOT NULL,
  deposit        INTEGER NOT NULL DEFAULT 0,      -- 보증금(원)
  monthly_rent   INTEGER NOT NULL DEFAULT 0,      -- 월 차임(원)
  move_in_date   TEXT NOT NULL,                   -- 'YYYY-MM-DD'
  move_out_date  TEXT,                            -- 'YYYY-MM-DD' (예정 또는 확정)
  status         TEXT NOT NULL DEFAULT 'active',  -- active | closing | closed
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---------------------------------------------------------------------
-- 3. Rule Lock — 계약 시점에 확정하는 정산 규칙
--    * 여기 담긴 값이 퇴거 정산 계산의 "유일한" 파라미터 원천이다.
--    * 법정 기준을 판정하지 않는다. 당사자 합의값을 재생할 뿐이다.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rule_sets (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id             INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  version                 INTEGER NOT NULL DEFAULT 1,

  -- 장기수선충당금: 'landlord' = 원칙(소유자 부담 → 퇴거 시 임차인에게 반환)
  --                'tenant'   = 임차인 부담 특약 존재 → 반환 대상 아님
  ltrf_burden             TEXT NOT NULL DEFAULT 'landlord',

  -- 입주월/퇴거월 부분월을 일할 처리할지
  prorate_edge_months     INTEGER NOT NULL DEFAULT 1,

  -- 소액 수선 기준: 이 금액 이하의 수선은 임차인 부담, 초과는 임대인 부담
  minor_repair_threshold  INTEGER NOT NULL DEFAULT 100000,

  -- 거주기간 면제 규칙 (개월). 이 기간 이상 거주하면 해당 품목 원상회복 면제
  wallpaper_grace_months  INTEGER NOT NULL DEFAULT 24,   -- 도배
  flooring_grace_months   INTEGER NOT NULL DEFAULT 24,   -- 장판/바닥재

  -- 미납 차임 지연이자 (연 %)
  late_interest_rate      REAL NOT NULL DEFAULT 0,

  -- 선수관리비를 임차인이 납부했는지
  tenant_paid_advance_fee INTEGER NOT NULL DEFAULT 0,
  advance_fee_amount      INTEGER NOT NULL DEFAULT 0,

  -- 양측 잠금 서명
  locked_by_landlord_at   TEXT,
  locked_by_tenant_at     TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (contract_id, version)
);

-- 품목별 원상회복 규칙 (내용연수 + 시공시점 + 교체비용)
CREATE TABLE IF NOT EXISTS rule_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_set_id        INTEGER NOT NULL REFERENCES rule_sets(id) ON DELETE CASCADE,
  category           TEXT NOT NULL,      -- wallpaper | flooring | appliance | fixture | etc
  label              TEXT NOT NULL,      -- '거실/방 도배'
  useful_life_years  REAL NOT NULL,      -- 합의 내용연수
  last_renewed_on    TEXT NOT NULL,      -- 최종 시공/교체일 'YYYY-MM-DD'
  replacement_cost   INTEGER NOT NULL,   -- 전체 교체 기준 비용(원)
  grace_applicable   INTEGER NOT NULL DEFAULT 1  -- 거주기간 면제 규칙 적용 대상 여부
);

-- ---------------------------------------------------------------------
-- 4. 퇴거 점검 결과 (원상회복 공제 입력)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS damage_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id   INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  rule_item_id  INTEGER REFERENCES rule_items(id) ON DELETE SET NULL,
  description   TEXT NOT NULL,
  -- 임차인 귀책 비율 0.0(통상손모=임대인부담) ~ 1.0(전적 귀책)
  fault_ratio   REAL NOT NULL DEFAULT 0,
  quoted_cost   INTEGER,                 -- 실제 견적이 있으면 우선 적용
  photo_ref     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---------------------------------------------------------------------
-- 5. 실제 납부/미납 실적
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rent_arrears (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id  INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  ym           TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  overdue_days INTEGER NOT NULL DEFAULT 0
);

-- 수선 이력
--
-- `unit_id` 는 항상 있고 `contract_id` 는 없을 수 있다. 공실 기간의 수선도 집의 이력이지만
-- 누구의 정산에도 들어가지 않기 때문이다. 엔진은 지금도 contract_id 로만 조회하므로,
-- 계약에 붙지 않은 수선은 정산 계산에 **들어가지 않는다** — 그게 맞다.
CREATE TABLE IF NOT EXISTS repair_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id      INTEGER REFERENCES units(id) ON DELETE CASCADE,
  contract_id  INTEGER REFERENCES contracts(id) ON DELETE CASCADE,
  occurred_on  TEXT NOT NULL,
  description  TEXT NOT NULL,
  cost         INTEGER NOT NULL,
  paid_by      TEXT NOT NULL,   -- landlord | tenant
  cause        TEXT NOT NULL    -- wear | tenant_fault | landlord_duty
);

-- 집 단위 품목 시공 이력 (House Log)
--
-- 품목 이력은 원래 rule_items(계약별 Rule Lock)에서만 나왔다. 그래서 계약이 한 번도
-- 없었던 집은 "작년에 도배했다"를 적어 둘 곳이 없었고, 첫 계약의 Rule Lock 이 늘
-- 빈 상태로 시작했다. 시공은 임차인이 아니라 **집**에 일어나는 일이므로 여기 둔다.
--
-- getUnitHistory 가 rule_items 와 합쳐 품목별 최신 시공일을 뽑고, 그 값이 다음 계약의
-- '최종 시공일' 로 승계된다.
CREATE TABLE IF NOT EXISTS unit_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id            INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  category           TEXT NOT NULL,      -- wallpaper | flooring | appliance | fixture | etc
  label              TEXT NOT NULL,
  useful_life_years  REAL NOT NULL,
  last_renewed_on    TEXT NOT NULL,      -- 최종 시공/교체일 'YYYY-MM-DD'
  replacement_cost   INTEGER NOT NULL,
  note               TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 퇴거월 관리비를 임차인이 미리 낸 금액 (있으면 환급 방향)
CREATE TABLE IF NOT EXISTS maintenance_prepaid (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id  INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  ym           TEXT NOT NULL,
  amount       INTEGER NOT NULL
);

-- ---------------------------------------------------------------------
-- 6. 정산서 / 합의
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS settlements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id    INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  rule_set_id    INTEGER NOT NULL REFERENCES rule_sets(id),
  generated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  status         TEXT NOT NULL DEFAULT 'draft',  -- draft | agreed | sealed
  net_amount     INTEGER NOT NULL DEFAULT 0,     -- +: 임차인이 받을 돈
  deposit_return INTEGER NOT NULL DEFAULT 0,     -- 보증금 포함 최종 반환액
  snapshot_json  TEXT,                           -- seal 시 동결 스냅샷
  snapshot_hash  TEXT,
  sealed_at      TEXT
);

CREATE TABLE IF NOT EXISTS settlement_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  settlement_id    INTEGER NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  kind             TEXT NOT NULL,   -- ltrf | maintenance_prorate | advance_fee
                                    -- | restoration | rent_arrears | late_interest
  label            TEXT NOT NULL,
  direction        TEXT NOT NULL,   -- tenant_credit | landlord_deduct
  amount           INTEGER NOT NULL,
  basis_json       TEXT NOT NULL,   -- 계산 근거 전체 (월별 내역/잔가율 등)
  landlord_status  TEXT NOT NULL DEFAULT 'pending', -- pending | agreed | disputed
  landlord_note    TEXT,
  tenant_status    TEXT NOT NULL DEFAULT 'pending',
  tenant_note      TEXT
);

CREATE INDEX IF NOT EXISTS idx_ltrf_complex_ym  ON ltrf_rates(complex_id, ym);
CREATE INDEX IF NOT EXISTS idx_mnt_complex_ym   ON maintenance_rates(complex_id, ym);
CREATE INDEX IF NOT EXISTS idx_lines_settlement ON settlement_lines(settlement_id, seq);

-- =====================================================================
-- v2 — 임대인 CRM 기반 전체 생애주기
--
-- 기존 테이블(units / contracts / damage_reports)에 추가되는 컬럼은
-- 이 파일이 아니라 db.js 의 COLUMN_PATCHES 가 ALTER 로 붙인다.
-- (CREATE TABLE IF NOT EXISTS 는 이미 있는 테이블에 컬럼을 추가하지 못하므로,
--  기존 butler.db 를 쓰던 환경에서도 깨지지 않게 하려면 ALTER 경로가 필요하다.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 7. 임대인 — 흐름의 주체
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS landlords (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---------------------------------------------------------------------
-- 8. 등기부 문서 — 소유 검증의 감사 추적 · 재파싱 원천
--    raw_text 는 주민번호 마스킹 후 저장한다 (V2-SPEC §5)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS registry_documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id      INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  file_path    TEXT NOT NULL,
  ocr_provider TEXT NOT NULL,   -- clova | upstage | vision | tesseract | fixture
  raw_text     TEXT,
  parsed_json  TEXT,
  match_result TEXT NOT NULL,   -- matched | name_mismatch | address_mismatch | parse_failed
  confidence   REAL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---------------------------------------------------------------------
-- 9. 임차인 공유 링크 — 인증 없이 토큰으로만 접근
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS share_links (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token           TEXT UNIQUE NOT NULL,
  contract_id     INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  purpose         TEXT NOT NULL,   -- contract_review | repair_report | inspection | settlement
  expires_at      TEXT,
  first_opened_at TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 계약 + 규칙에 대한 임차인의 전체 동의 / 거부(사유)
CREATE TABLE IF NOT EXISTS contract_responses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id  INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  rule_set_id  INTEGER NOT NULL REFERENCES rule_sets(id),
  decision     TEXT NOT NULL,   -- accepted | rejected
  reason       TEXT,
  responded_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---------------------------------------------------------------------
-- 10. 퇴거 점검 — 임차인이 사진 제출, 임대인이 귀책비율 지정
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inspections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id  INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'moveout',
  status       TEXT NOT NULL DEFAULT 'requested',  -- requested | submitted | reviewed
  requested_at TEXT,
  submitted_at TEXT,
  reviewed_at  TEXT
);

CREATE TABLE IF NOT EXISTS inspection_photos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  area          TEXT NOT NULL,   -- entrance | livingroom | bedroom | kitchen | bathroom | balcony | etc
  file_path     TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---------------------------------------------------------------------
-- 11. 거주 중 수선 신고 — 처리되면 repair_events 로 확정된다
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS repair_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id     INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  photo_path      TEXT,
  reported_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  status          TEXT NOT NULL DEFAULT 'open',   -- open | scheduled | done | rejected
  repair_event_id INTEGER REFERENCES repair_events(id)
);

-- ---------------------------------------------------------------------
-- 12. CRM 할 일 — 크론 없이 홈 조회 시 refreshTasks() 가 갱신한다
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  landlord_id INTEGER NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  contract_id INTEGER REFERENCES contracts(id) ON DELETE CASCADE,
  unit_id     INTEGER REFERENCES units(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'info',   -- info | warn | urgent
  due_on      TEXT,
  title       TEXT NOT NULL,
  body        TEXT,
  done_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 같은 계약에 같은 종류 할 일이 중복 생성되지 않게 한다.
-- 계약이 없는 할 일(ownership_unverified)은 세대 단위로 유일해야 하므로 부분 인덱스로 나눈다.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_contract_kind
  ON tasks(contract_id, kind) WHERE contract_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_unit_kind
  ON tasks(unit_id, kind) WHERE contract_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_share_token ON share_links(token);
CREATE INDEX IF NOT EXISTS idx_photos_insp ON inspection_photos(inspection_id);
-- units(landlord_id) 인덱스는 컬럼을 ALTER 로 붙인 뒤에야 만들 수 있어 db.js 에 있다.
