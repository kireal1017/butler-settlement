import { db } from './db.js';

/** DB row(snake_case) → 엔진 입력(camelCase) 변환 계층 */

export const getContract = (id) => db.prepare(`
  SELECT c.*, u.exclusive_area, u.dong, u.ho,
         cx.id AS complex_id, cx.name AS complex_name, cx.kapt_code, cx.address
  FROM contracts c
  JOIN units u   ON u.id = c.unit_id
  JOIN complexes cx ON cx.id = u.complex_id
  WHERE c.id = ?`).get(id);

export const listContracts = () => db.prepare(`
  SELECT c.id, c.landlord_name, c.tenant_name, c.deposit, c.monthly_rent,
         c.move_in_date, c.move_out_date, c.status,
         u.dong, u.ho, u.exclusive_area, cx.name AS complex_name
  FROM contracts c
  JOIN units u ON u.id = c.unit_id
  JOIN complexes cx ON cx.id = u.complex_id
  ORDER BY c.id`).all();

export const getRuleSet = (contractId) => db.prepare(
  `SELECT * FROM rule_sets WHERE contract_id = ? ORDER BY version DESC LIMIT 1`
).get(contractId);

export const getRuleItems = (ruleSetId) => db.prepare(
  `SELECT * FROM rule_items WHERE rule_set_id = ? ORDER BY id`).all(ruleSetId);

export const getLtrfRates = (complexId, fromYm, toYm) => db.prepare(`
  SELECT ym, rate_per_sqm AS ratePerSqm, data_source AS source
  FROM ltrf_rates WHERE complex_id = ? AND ym BETWEEN ? AND ? ORDER BY ym`
).all(complexId, fromYm, toYm);

export const getMaintenanceRate = (complexId, ym) => db.prepare(
  `SELECT rate_per_sqm AS ratePerSqm FROM maintenance_rates WHERE complex_id = ? AND ym = ?`
).get(complexId, ym);

export const getDamages = (contractId) => db.prepare(
  `SELECT * FROM damage_reports WHERE contract_id = ? ORDER BY id`).all(contractId);

export const getRepairEvents = (contractId) => db.prepare(
  `SELECT * FROM repair_events WHERE contract_id = ? ORDER BY occurred_on`).all(contractId);

/**
 * 갱신 체인 — 이 계약과 그 위의 모든 부모 계약 id.
 *
 * 갱신은 새 임대차가 아니라 **같은 임대차의 연장**이다. 그래서 입주일도 최초
 * 입주일을 그대로 가져온다(service.renewContract 주석). 그런데 수선과 미납은
 * 계약 id 로만 묶여 있어서, 4년 거주 중 2년차에 갱신하면 **첫 2년의 수선이
 * 정산서에서 통째로 사라졌다** — 같은 임대차인데 장충금은 4년치를 세고
 * 수선은 마지막 2년만 세는 상태였다.
 *
 * 퇴거 점검 결과(damage_reports)는 여기에 넣지 않는다. 점검은 임대차가 끝날 때
 * 마지막 계약에서 한 번만 일어나고, 그 항목은 그 계약의 rule_items 를 가리킨다.
 * 부모 계약의 항목을 끌어오면 가리키는 품목 id 가 어긋난다.
 */
export const contractChainIds = (contractId) => {
  const parentOf = db.prepare(`SELECT parent_contract_id FROM contracts WHERE id = ?`);
  const ids = [];
  let cur = Number(contractId);
  /* 데이터가 잘못 순환해도 멈춘다 — 체인이 깊어야 몇 단계다 */
  while (cur != null && !ids.includes(cur) && ids.length < 50) {
    ids.push(cur);
    cur = parentOf.get(cur)?.parent_contract_id ?? null;
  }
  return ids;
};

const inChain = (contractId, sql) => {
  const ids = contractChainIds(contractId);
  return db.prepare(sql.replace('@ids', ids.map(() => '?').join(','))).all(...ids);
};

/** 이 임대차 전체(갱신 포함)의 수선 이력 */
export const getRepairEventsInChain = (contractId) => inChain(contractId,
  `SELECT * FROM repair_events WHERE contract_id IN (@ids) ORDER BY occurred_on`);

/** 이 임대차 전체(갱신 포함)의 미납 기록 */
export const getArrearsInChain = (contractId) => inChain(contractId,
  `SELECT ym, amount, overdue_days FROM rent_arrears
   WHERE contract_id IN (@ids) AND amount > 0 ORDER BY ym`);

export const getArrears = (contractId) => db.prepare(
  `SELECT ym, amount, overdue_days FROM rent_arrears WHERE contract_id = ? AND amount > 0`
).all(contractId);

export const getPrepaid = (contractId, ym) => db.prepare(
  `SELECT amount FROM maintenance_prepaid WHERE contract_id = ? AND ym = ?`).get(contractId, ym);

/* ── v2 · 임대인 CRM ──────────────────────────────────────────
   신규 조회는 camelCase 로 내보낸다 (V2-SPEC §6 의 API 예시 형식).   */

export const listLandlords = () => db.prepare(
  `SELECT id, name, phone FROM landlords ORDER BY id`).all();

export const getLandlord = (id) => db.prepare(
  `SELECT id, name, phone FROM landlords WHERE id = ?`).get(id);

/**
 * 임대인이 소유한 집 + 각 집의 "현재" 계약 요약 (카드용).
 * 현재 계약 = 종료되지 않은 계약 중 가장 최근 것. 없으면 공실이다.
 */
export const listUnitsByLandlord = (landlordId) => db.prepare(`
  SELECT u.id                  AS id,
         u.dong                AS dong,
         u.ho                  AS ho,
         u.exclusive_area      AS exclusiveArea,
         u.ownership_status    AS ownershipStatus,
         u.registry_owner_name AS registryOwnerName,
         u.vacancy_status      AS vacancyStatus,
         cx.name               AS complexName,
         cx.address            AS address,
         c.id                  AS contractId,
         c.tenant_name         AS tenantName,
         c.status              AS contractStatus,
         c.move_in_date        AS moveInDate,
         c.move_out_date       AS moveOutDate,
         c.expires_on          AS expiresOn,
         c.deposit             AS deposit,
         c.monthly_rent        AS monthlyRent,
         c.renewal_decision    AS renewalDecision,
         (SELECT COUNT(*) FROM contracts h WHERE h.unit_id = u.id)        AS contractCount,
         (SELECT COUNT(*) FROM repair_requests rq
           WHERE rq.contract_id = c.id AND rq.status = 'open')            AS openRepairs,
         (SELECT sl.created_at FROM share_links sl
           WHERE sl.contract_id = c.id AND sl.purpose = 'contract_review'
           ORDER BY sl.id DESC LIMIT 1)                                   AS reviewSentAt
  FROM units u
  JOIN complexes cx ON cx.id = u.complex_id
  LEFT JOIN contracts c ON c.id = (
    SELECT id FROM contracts WHERE unit_id = u.id AND status <> 'closed'
    ORDER BY id DESC LIMIT 1
  )
  WHERE u.landlord_id = ?
  ORDER BY u.id`).all(landlordId);

export const getUnit = (id) => db.prepare(`
  SELECT u.id                  AS id,
         u.dong                AS dong,
         u.ho                  AS ho,
         u.exclusive_area      AS exclusiveArea,
         u.ownership_status    AS ownershipStatus,
         u.ownership_verified_at AS ownershipVerifiedAt,
         u.registry_owner_name AS registryOwnerName,
         u.registry_unique_no  AS registryUniqueNo,
         u.vacancy_status      AS vacancyStatus,
         u.landlord_id         AS landlordId,
         cx.id                 AS complexId,
         cx.name               AS complexName,
         cx.address            AS address,
         l.name                AS landlordName
  FROM units u
  JOIN complexes cx ON cx.id = u.complex_id
  LEFT JOIN landlords l ON l.id = u.landlord_id
  WHERE u.id = ?`).get(id);

/**
 * House Log — 이 집에서 일어난 일 전부.
 * 10년 뒤 매도용 기록이 아니라 다음 계약의 입력값이 되는 자료다.
 */
export const getUnitHistory = (unitId) => ({
  contracts: db.prepare(`
    SELECT c.id            AS id,
           c.tenant_name   AS tenantName,
           c.status        AS status,
           c.move_in_date  AS moveInDate,
           c.move_out_date AS moveOutDate,
           c.expires_on    AS expiresOn,
           c.deposit       AS deposit,
           c.monthly_rent  AS monthlyRent,
           s.id            AS settlementId,
           s.status        AS settlementStatus,
           s.deposit_return AS depositReturn,
           s.sealed_at     AS sealedAt,
           /* 이 계약에 어떤 기록이 붙어 있는지 — 집 화면의 '계약 기록' 목록이 쓴다.
              문서마다 따로 조회하면 계약 수만큼 질의가 늘어난다. */
           (SELECT COUNT(*) FROM rule_sets rs WHERE rs.contract_id = c.id)         AS ruleSetCount,
           (SELECT i.status FROM inspections i
             WHERE i.contract_id = c.id ORDER BY i.id DESC LIMIT 1)                AS inspectionStatus,
           (SELECT cr.decision FROM contract_responses cr
             WHERE cr.contract_id = c.id ORDER BY cr.id DESC LIMIT 1)              AS tenantDecision
    FROM contracts c
    LEFT JOIN settlements s ON s.id = (
      SELECT id FROM settlements WHERE contract_id = c.id ORDER BY id DESC LIMIT 1
    )
    WHERE c.unit_id = ?
    -- 갱신 계약은 입주일이 원 계약과 같다. 같은 날짜면 최근 계약이 위로 온다.
    ORDER BY c.move_in_date DESC, c.id DESC`).all(unitId),

  /* 계약에 붙은 수선과 공실 기간 수선을 한 줄기로 본다.
     예전 행은 unit_id 가 비어 있을 수 있어 계약 쪽에서도 집을 끌어온다. */
  repairs: db.prepare(`
    SELECT re.id          AS id,
           re.occurred_on AS occurredOn,
           re.description AS description,
           re.cost        AS cost,
           re.paid_by     AS paidBy,
           re.cause       AS cause,
           re.contract_id AS contractId,
           c.tenant_name  AS tenantName
    FROM repair_events re
    LEFT JOIN contracts c ON c.id = re.contract_id
    WHERE COALESCE(re.unit_id, c.unit_id) = ?
    ORDER BY re.occurred_on DESC, re.id DESC`).all(unitId),

  /**
   * 품목별 최신 시공일 — 다음 계약 Rule Lock 의 '최종 시공일' 로 승계된다.
   *
   * 출처가 둘이다: 집에 직접 적은 시공 이력(unit_items)과 지난 계약의 Rule Lock(rule_items).
   * 같은 품목이면 **가장 최근에 시공한 쪽**이 이긴다 — 이력을 적어 둔 뒤 계약을 맺든,
   * 계약 중에 교체하든, 화면에 남아야 하는 것은 마지막 시공일 하나다.
   *
   * ⚠ 묶는 기준은 **구분 + 품목명**이다. 예전에는 구분만으로 묶어서, 같은 'appliance'
   *   인 인덕션과 에어컨 중 나중에 시공한 하나만 살아남고 나머지가 통째로 사라졌다.
   *   사라진 품목은 다음 계약의 Rule Lock 에 오르지 못하고, 그러면 퇴거 점검에서
   *   그 품목이 파손돼도 내용연수·잔가율을 적용할 근거가 없어 원상회복 계산에서 빠진다.
   *
   * ⚠ SQLite 의 bare column 규칙에 기댄다: MAX() 를 쓴 GROUP BY 행에서는 집계되지 않은
   *   컬럼이 **그 최댓값 행의 값**으로 온다. 그래서 label·내용연수·교체비용이 최신 시공
   *   기록의 것으로 따라온다. 다른 DB 로 옮긴다면 이 쿼리는 다시 써야 한다.
   */
  items: db.prepare(`
    SELECT category, label, MAX(lastRenewedOn) AS lastRenewedOn,
           usefulLifeYears, replacementCost, source
    FROM (
      SELECT ui.category, ui.label, ui.last_renewed_on AS lastRenewedOn,
             ui.useful_life_years AS usefulLifeYears, ui.replacement_cost AS replacementCost,
             'unit' AS source, ui.id AS id
      FROM unit_items ui WHERE ui.unit_id = ?
      UNION ALL
      SELECT ri.category, ri.label, ri.last_renewed_on,
             ri.useful_life_years, ri.replacement_cost,
             'contract', ri.id
      FROM rule_items ri
      JOIN rule_sets rs ON rs.id = ri.rule_set_id
      JOIN contracts c  ON c.id = rs.contract_id
      WHERE c.unit_id = ?
    )
    GROUP BY category, label
    ORDER BY category, label`).all(unitId, unitId),

  /** 집에 직접 적은 시공 이력만 — 지울 수 있는 것은 이쪽뿐이다 */
  unitItems: db.prepare(`
    SELECT id, category, label,
           useful_life_years  AS usefulLifeYears,
           last_renewed_on    AS lastRenewedOn,
           replacement_cost   AS replacementCost,
           note
    FROM unit_items WHERE unit_id = ? ORDER BY last_renewed_on DESC, id DESC`).all(unitId),

  registryDocuments: db.prepare(`
    SELECT id, ocr_provider AS ocrProvider, match_result AS matchResult,
           confidence, created_at AS createdAt
    FROM registry_documents WHERE unit_id = ? ORDER BY id DESC`).all(unitId),
});

export const getRegistryDocument = (id) => db.prepare(
  `SELECT * FROM registry_documents WHERE id = ?`).get(id);

/* ── 퇴거 점검 ─────────────────────────────────────────────── */

/** 계약당 점검은 하나다 (최신 것) */
export const getInspection = (contractId) => db.prepare(
  `SELECT * FROM inspections WHERE contract_id = ? ORDER BY id DESC LIMIT 1`).get(contractId);

export const getInspectionById = (id) => db.prepare(
  `SELECT * FROM inspections WHERE id = ?`).get(id);

export const getInspectionPhotos = (inspectionId) => db.prepare(`
  SELECT id, area, note, created_at AS createdAt
  FROM inspection_photos WHERE inspection_id = ? ORDER BY id`).all(inspectionId);

/** 파일 경로는 스트리밍 라우트만 쓴다 — 목록에는 내보내지 않는다 (V2-SPEC §5) */
export const getInspectionPhoto = (id) => db.prepare(
  `SELECT * FROM inspection_photos WHERE id = ?`).get(id);

export const getShareLinkByToken = (token) => db.prepare(`
  SELECT id, token, contract_id AS contractId, purpose, expires_at AS expiresAt,
         first_opened_at AS firstOpenedAt, completed_at AS completedAt, created_at AS createdAt
  FROM share_links WHERE token = ?`).get(token);

export const getActiveShareLink = (contractId, purpose) => db.prepare(`
  SELECT token, purpose, expires_at AS expiresAt, first_opened_at AS firstOpenedAt,
         completed_at AS completedAt, created_at AS createdAt
  FROM share_links
  WHERE contract_id = ? AND purpose = ?
  ORDER BY id DESC LIMIT 1`).get(contractId, purpose);

export const getLatestContractResponse = (contractId) => db.prepare(`
  SELECT decision, reason, responded_at AS respondedAt
  FROM contract_responses
  WHERE contract_id = ? ORDER BY id DESC LIMIT 1`).get(contractId);

/** rule_sets row → 엔진 rules 객체 */
export function toRules(row) {
  return {
    ltrfBurden: row.ltrf_burden,
    prorateEdgeMonths: row.prorate_edge_months,
    minorRepairThreshold: row.minor_repair_threshold,
    wallpaperGraceMonths: row.wallpaper_grace_months,
    flooringGraceMonths: row.flooring_grace_months,
    lateInterestRate: row.late_interest_rate,
    tenantPaidAdvanceFee: row.tenant_paid_advance_fee,
    advanceFeeAmount: row.advance_fee_amount,
    lockedByLandlordAt: row.locked_by_landlord_at,
    lockedByTenantAt: row.locked_by_tenant_at,
    version: row.version,
    id: row.id,
  };
}
