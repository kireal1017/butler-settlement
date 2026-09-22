import crypto from 'node:crypto';
import { db } from './db.js';
import * as repo from './repository.js';
import { buildSettlement } from './engine/index.js';
import { recognize } from './services/ocr.js';
import { parseRegistry, verifyOwnership, maskSensitive } from './services/registry.js';
import { toIso, startOfToday, shiftIso, contractExpiry } from './services/timeline.js';
import { ensureLtrfRates } from './services/kapt-sync.js';

const fail = (message, status) => {
  throw Object.assign(new Error(message), { status });
};

/**
 * 등기부 이미지 → OCR → 파싱 → 소유 검증 → 세대 상태 갱신.
 *
 * 판정이 실패해도 문서는 남긴다. 어떤 근거로 어떤 판정이 나왔는지 나중에
 * 되짚을 수 있어야 하고, OCR 을 교체한 뒤 재파싱할 원천도 필요하기 때문이다.
 */
/**
 * 등기부 확인 완료 — OCR 이 읽은 값을 임대인이 눈으로 고쳐 확정한다.
 *
 * OCR 은 표와 손글씨에서 자주 한두 칸을 놓친다(실측: 소유자 미검출). 그때마다
 * 집이 '등기부를 읽지 못함' 에 갇히면 쓸 수 없는 기능이 되므로, **사람이 보고
 * 고친 값**을 받아 확정할 수 있게 한다.
 *
 * ⚠ 이 확정은 OCR 이 검증한 것이 아니다. `match_result` 를 `matched` 로 덮지 않고
 *   **`confirmed`** 로 따로 남기고, 어떤 칸을 손으로 고쳤는지 `parsed_json.editedFields`
 *   에 적는다. 나중에 "이 집의 소유는 무엇으로 확인됐나"를 물으면
 *   "임대인이 등기부를 보고 직접 확인했다" 와 "OCR 이 대조해 일치했다" 가 구분되어야 한다.
 */
export function confirmUnitRegistry(documentId, edits = {}) {
  const doc = repo.getRegistryDocument(documentId);
  if (!doc) throw Object.assign(new Error('문서를 찾을 수 없습니다'), { status: 404 });

  const ownerName = String(edits.ownerName ?? '').trim();
  if (!ownerName)
    throw Object.assign(new Error('소유자를 입력해 주세요'), { status: 400 });

  const before = JSON.parse(doc.parsed_json ?? '{}');
  const text = (v) => (v == null || v === '' ? null : String(v).trim());
  const area = Number(edits.exclusiveArea);

  const parsed = {
    ...before,
    address: text(edits.address),
    dong: text(edits.dong),
    floor: text(edits.floor),
    ho: text(edits.ho),
    uniqueNo: text(edits.uniqueNo),
    exclusiveArea: Number.isFinite(area) && area > 0 ? area : before.exclusiveArea ?? null,
    owners: [ownerName],
  };

  /* 무엇이 OCR 값이고 무엇이 사람이 고친 값인지 남긴다 */
  const editedFields = ['address', 'dong', 'floor', 'ho', 'uniqueNo', 'exclusiveArea']
    .filter((k) => String(before[k] ?? '') !== String(parsed[k] ?? ''));
  if ((before.owners ?? [])[0] !== ownerName) editedFields.push('owners');

  /* 시각은 DB 에서 받는다 — 다른 타임스탬프가 전부 localtime 문자열이라 형식을 맞춘다 */
  const confirmedAt = db.prepare(`SELECT datetime('now','localtime') AS t`).get().t;

  return db.transaction(() => {
    db.prepare(`
      UPDATE registry_documents SET parsed_json = ?, match_result = 'confirmed' WHERE id = ?`
    ).run(JSON.stringify({ ...parsed, editedFields, confirmedAt }), documentId);

    db.prepare(`
      UPDATE units
      SET ownership_status = 'verified',
          ownership_verified_at = datetime('now','localtime'),
          registry_owner_name = ?, registry_unique_no = ?
      WHERE id = ?`).run(ownerName, parsed.uniqueNo, doc.unit_id);

    return { documentId, parsed, editedFields, unit: repo.getUnit(doc.unit_id) };
  })();
}

export async function verifyUnitRegistry(unitId, filePath) {
  const unit = repo.getUnit(unitId);
  if (!unit) throw Object.assign(new Error('집을 찾을 수 없습니다'), { status: 404 });
  if (!unit.landlordName)
    throw Object.assign(new Error('임대인이 지정되지 않은 집입니다'), { status: 409 });

  const { text, provider, confidence } = await recognize(filePath);
  const parsed = parseRegistry(text);
  const { result, reasons } = verifyOwnership(parsed, {
    ownerName: unit.landlordName,
    dong: unit.dong,
    ho: unit.ho,
    exclusiveArea: unit.exclusiveArea,
  });

  return db.transaction(() => {
    const documentId = db.prepare(`
      INSERT INTO registry_documents
        (unit_id, file_path, ocr_provider, raw_text, parsed_json, match_result, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      unitId, filePath, provider,
      maskSensitive(text),                 // ⚠ 주민번호 마스킹 후 저장 (V2-SPEC §5)
      JSON.stringify(parsed), result, confidence,
    ).lastInsertRowid;

    if (result === 'matched') {
      db.prepare(`
        UPDATE units
        SET ownership_status = 'verified',
            ownership_verified_at = datetime('now','localtime'),
            registry_owner_name = ?, registry_unique_no = ?
        WHERE id = ?`).run(parsed.owners[0], parsed.uniqueNo, unitId);
    } else {
      db.prepare(`UPDATE units SET ownership_status = ? WHERE id = ?`).run(result, unitId);
    }

    return { documentId, result, reasons, parsed, provider, confidence, unit: repo.getUnit(unitId) };
  })();
}

/**
 * 임차인에게 계약 확인 링크를 보낸다.
 *
 * 링크를 보내는 시점에 계약이 '임차인 확인 대기' 로 넘어가고 집은 '계약 진행 중' 이 된다.
 * 재전송하면 이전 링크는 버린다 — 살아 있는 확인 링크가 둘이면 어느 쪽 응답이 유효한지
 * 알 수 없어진다.
 */
export function sendContractLink(contractId) {
  const contract = repo.getContract(contractId);
  if (!contract) throw Object.assign(new Error('계약을 찾을 수 없습니다'), { status: 404 });
  if (contract.status === 'closed')
    throw Object.assign(new Error('종료된 계약입니다'), { status: 409 });

  const ruleRow = repo.getRuleSet(contractId);
  if (!ruleRow)
    throw Object.assign(new Error('Rule Lock을 먼저 설정해 주세요'), { status: 409 });
  if (!ruleRow.locked_by_landlord_at)
    throw Object.assign(new Error('임대인 확정을 먼저 해주세요'), { status: 409 });

  const token = crypto.randomBytes(16).toString('base64url');

  return db.transaction(() => {
    db.prepare(`
      DELETE FROM share_links
      WHERE contract_id = ? AND purpose = 'contract_review' AND completed_at IS NULL`
    ).run(contractId);

    db.prepare(`
      INSERT INTO share_links (token, contract_id, purpose, expires_at)
      VALUES (?, ?, 'contract_review', date('now','localtime','+14 day'))`
    ).run(token, contractId);

    db.prepare(`UPDATE contracts SET status = 'pending_tenant' WHERE id = ?`).run(contractId);

    /* 갱신 계약은 임차인이 이미 살고 있는 상태에서 오간다. 집을 '계약 진행 중' 으로
       되돌리면 카드에서 거주 중이던 집이 빈집처럼 보인다. */
    if (!contract.parent_contract_id)
      db.prepare(`UPDATE units SET vacancy_status = 'contracting' WHERE id = ?`)
        .run(contract.unit_id);

    return { token, url: `/t/${token}`, sentAt: new Date().toISOString() };
  })();
}

/**
 * Rule Lock 저장.
 *
 * 규칙을 고칠 때 기존 rule_set 을 지우고 다시 넣으면 안 되는 경우가 있다.
 * 임차인의 응답(contract_responses)과 발행된 정산서(settlements)가 자기가 본 버전을
 * 가리키고 있기 때문이다. "임차인이 v1 을 거부했다" 는 기록은 v1 이 남아 있어야 말이 된다.
 *
 * 그래서 참조가 있으면 새 버전을 만들고, 없으면(작성 중 반복 저장) 같은 버전을 덮어쓴다.
 */
export function saveRuleSet(contractId, body) {
  const prev = repo.getRuleSet(contractId);
  if (prev?.locked_by_landlord_at && prev?.locked_by_tenant_at && !body.forceNewVersion)
    fail('이미 양측이 잠근 규칙입니다. 변경하려면 새 버전을 만드세요.', 409);

  const referenced = prev && Boolean(
    db.prepare(`SELECT 1 FROM contract_responses WHERE rule_set_id = ? LIMIT 1`).get(prev.id) ||
    db.prepare(`SELECT 1 FROM settlements WHERE rule_set_id = ? LIMIT 1`).get(prev.id));

  const replaceInPlace = prev && !body.forceNewVersion && !referenced;
  const version = prev ? (replaceInPlace ? prev.version : prev.version + 1) : 1;

  return db.transaction(() => {
    if (replaceInPlace) db.prepare(`DELETE FROM rule_sets WHERE id = ?`).run(prev.id);

    const ruleSetId = db.prepare(`
      INSERT INTO rule_sets (contract_id, version, ltrf_burden, prorate_edge_months,
        minor_repair_threshold, wallpaper_grace_months, flooring_grace_months,
        late_interest_rate, tenant_paid_advance_fee, advance_fee_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      contractId, version,
      body.ltrfBurden ?? 'landlord',
      body.prorateEdgeMonths ? 1 : 0,
      body.minorRepairThreshold ?? 100000,
      body.wallpaperGraceMonths ?? 24,
      body.flooringGraceMonths ?? 24,
      body.lateInterestRate ?? 0,
      body.tenantPaidAdvanceFee ? 1 : 0,
      body.advanceFeeAmount ?? 0,
    ).lastInsertRowid;

    const insItem = db.prepare(`
      INSERT INTO rule_items (rule_set_id, category, label, useful_life_years,
        last_renewed_on, replacement_cost, grace_applicable)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const item of body.items ?? [])
      insItem.run(ruleSetId, item.category, item.label, item.usefulLifeYears,
        item.lastRenewedOn, item.replacementCost, item.graceApplicable ? 1 : 0);

    return { rules: repo.toRules(repo.getRuleSet(contractId)), items: repo.getRuleItems(ruleSetId) };
  })();
}

/* ── 임차인 공유 링크 ─────────────────────────────────────────
   인증이 없다. 토큰 하나가 계약 하나에만 대응하므로, 토큰으로 접근 가능한 범위는
   그 계약으로 한정된다. 계약 id 를 파라미터로 받는 경로를 임차인 쪽에 열어두지 말 것. */

function openLink(token, expectedPurpose) {
  const link = repo.getShareLinkByToken(token);
  if (!link) fail('링크가 유효하지 않습니다', 404);
  if (link.expiresAt && link.expiresAt < toIso(startOfToday()))
    fail('링크가 만료되었습니다. 임대인에게 재발송을 요청해 주세요', 410);
  if (expectedPurpose && link.purpose !== expectedPurpose) fail('링크 용도가 맞지 않습니다', 409);
  return link;
}

/** 토큰으로 화면에 필요한 것만 돌려준다 (용도별) */
export function readShareContext(token) {
  const link = openLink(token);

  if (!link.firstOpenedAt)
    db.prepare(`UPDATE share_links SET first_opened_at = datetime('now','localtime') WHERE id = ?`)
      .run(link.id);

  const contract = repo.getContract(link.contractId);
  const ruleRow = repo.getRuleSet(contract.id);

  return {
    purpose: link.purpose,
    completedAt: link.completedAt,
    contract: {
      id: contract.id,
      landlordName: contract.landlord_name,
      tenantName: contract.tenant_name,
      deposit: contract.deposit,
      monthlyRent: contract.monthly_rent,
      moveInDate: contract.move_in_date,
      moveOutDate: contract.move_out_date,
      termMonths: contract.term_months,
      expiresOn: contract.expires_on,
      status: contract.status,
    },
    unit: {
      complexName: contract.complex_name,
      address: contract.address,
      dong: contract.dong,
      ho: contract.ho,
      exclusiveArea: contract.exclusive_area,
    },
    rules: ruleRow ? repo.toRules(ruleRow) : null,
    ruleItems: ruleRow ? repo.getRuleItems(ruleRow.id) : [],
    response: repo.getLatestContractResponse(contract.id),

    /* 점검 링크에만 붙인다. 임대인이 매긴 귀책비율(damage_reports)은 넣지 않는다 —
       그것은 정산서에서 항목별 근거와 함께 보여줄 것이다. */
    inspection: link.purpose === 'inspection' ? inspectionForTenant(contract.id) : null,

    settlement: link.purpose === 'settlement' ? settlementForTenant(contract.id) : null,
  };
}

function inspectionForTenant(contractId) {
  const inspection = repo.getInspection(contractId);
  if (!inspection) return null;
  return {
    id: inspection.id,
    status: inspection.status,
    submittedAt: inspection.submitted_at,
    areas: INSPECTION_AREAS,
    photos: repo.getInspectionPhotos(inspection.id),
  };
}

/**
 * 임차인의 계약 응답 — 전체 동의 또는 거부(사유).
 *
 * 항목별 협상은 하지 않는다(V2-SPEC §0). 거부하면 임대인이 규칙을 고쳐 재전송하고,
 * 그때 새 링크가 발급된다.
 */
export function respondToContract(token, decision, reason) {
  if (!['accepted', 'rejected'].includes(decision))
    fail('decision 은 accepted 또는 rejected 여야 합니다', 400);
  if (decision === 'rejected' && !reason?.trim())
    fail('어디를 고쳐야 하는지 적어 주세요', 400);

  const link = openLink(token, 'contract_review');
  if (link.completedAt) fail('이미 응답하신 계약입니다', 409);

  const contract = repo.getContract(link.contractId);
  const ruleRow = repo.getRuleSet(contract.id);
  if (!ruleRow) fail('규칙이 설정되지 않은 계약입니다', 409);

  return db.transaction(() => {
    db.prepare(`
      INSERT INTO contract_responses (contract_id, rule_set_id, decision, reason)
      VALUES (?, ?, ?, ?)`
    ).run(contract.id, ruleRow.id, decision, reason?.trim() ?? null);

    db.prepare(`UPDATE share_links SET completed_at = datetime('now','localtime') WHERE id = ?`)
      .run(link.id);

    if (decision === 'accepted') {
      // 양측이 잠근 시점부터 규칙은 새 버전으로만 바뀐다
      db.prepare(`UPDATE rule_sets SET locked_by_tenant_at = datetime('now','localtime') WHERE id = ?`)
        .run(ruleRow.id);
      db.prepare(`UPDATE contracts SET status = 'active' WHERE id = ?`).run(contract.id);
      db.prepare(`UPDATE units SET vacancy_status = 'occupied' WHERE id = ?`).run(contract.unit_id);

      /* 갱신 계약이 성립하면 이전 계약은 여기서 닫힌다.
         정산 없이 닫히는 유일한 경우다 — 거주가 이어지므로 보증금을 돌려주지 않는다. */
      if (contract.parent_contract_id)
        db.prepare(`UPDATE contracts SET status = 'closed' WHERE id = ?`)
          .run(contract.parent_contract_id);
    } else {
      // 협상이 계속되므로 집은 '계약 진행 중' 으로 둔다
      db.prepare(`UPDATE contracts SET status = 'rejected' WHERE id = ?`).run(contract.id);
    }

    return { decision, contractStatus: decision === 'accepted' ? 'active' : 'rejected' };
  })();
}

/* ── 갱신 ─────────────────────────────────────────────────────
   갱신은 "같은 임대차의 연장"이지 새 임대차가 아니다. 이 구분이 계산에 그대로 영향을 준다.
   아래 renewContract 의 주석을 참고할 것. */

/** 이 계약에서 갈라져 나온 갱신 계약 (있으면) */
const childOf = (contractId) => db.prepare(
  `SELECT id, status FROM contracts WHERE parent_contract_id = ? ORDER BY id DESC LIMIT 1`
).get(contractId);

/**
 * 갱신 — 새 contract 를 만들고 parent 로 연결한 뒤 Rule Lock 을 승계한다.
 *
 * ⚠ **입주일(move_in_date)을 새로 잡지 않고 최초 입주일을 그대로 가져온다.**
 *   엔진은 장기수선충당금을 `move_in_date ~ move_out_date` 구간의 월별 단가로 누적한다
 *   (`engine/ltrf.js`). 갱신 때 입주일을 다시 잡으면 그 이전에 임차인이 대납한 장충금이
 *   정산에서 통째로 사라진다. 실제로도 갱신은 거주가 끊기지 않은 하나의 임대차다.
 *   V2-SPEC §10 "갱신 후 장충금 누적 개월이 연장된 기간만큼 늘어남" 이 이것을 말한다.
 *
 *   그래서 "이번 갱신 기간이 언제부터인가"는 저장하지 않고 부모의 만료일에서 계산한다
 *   (`renewedFrom = 부모 만료일 + 1일`). 컬럼을 늘리지 않아도 체인으로 복원된다.
 *
 * 임차인 동의는 기존 계약 확인 링크를 그대로 쓴다. 새 계약이 `draft` 로 만들어지고,
 * 임대인 확정 → 발송 → 임차인 동의를 거쳐 `active` 가 된다. 그 시점에 부모가 닫힌다
 * (respondToContract 참조). 갱신도 양측이 합의해야 성립한다는 뜻이다.
 */
export function renewContract(contractId, body = {}) {
  const prev = repo.getContract(contractId);
  if (!prev) fail('계약을 찾을 수 없습니다', 404);
  if (prev.status !== 'active') fail('거주 중인 계약만 갱신할 수 있습니다', 409);
  if (!prev.expires_on) fail('만료 예정일이 없는 계약입니다', 409);
  if (childOf(contractId)) fail('이미 갱신 계약이 만들어져 있습니다', 409);

  const termMonths = Number(body.termMonths ?? prev.term_months ?? 24);
  if (!Number.isInteger(termMonths) || termMonths < 1)
    fail('갱신 기간(개월)이 올바르지 않습니다', 400);

  const renewedFrom = shiftIso(prev.expires_on, 1);
  const expiresOn = contractExpiry(renewedFrom, termMonths);

  const prevRules = repo.getRuleSet(contractId);

  return db.transaction(() => {
    const childId = db.prepare(`
      INSERT INTO contracts (unit_id, landlord_id, landlord_name, tenant_name, tenant_phone,
                             deposit, monthly_rent, move_in_date, term_months, expires_on,
                             parent_contract_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`
    ).run(
      prev.unit_id, prev.landlord_id, prev.landlord_name, prev.tenant_name, prev.tenant_phone,
      Number(body.deposit ?? prev.deposit), Number(body.monthlyRent ?? prev.monthly_rent),
      prev.move_in_date, termMonths, expiresOn, prev.id,
    ).lastInsertRowid;

    /* Rule Lock 승계 — 그대로 복사한다. 교체한 품목이 없으면 최종 시공일도 그대로이고,
       임대인이 갱신을 계기로 고치고 싶으면 발송 전에 규칙 화면에서 바꾸면 된다. */
    if (prevRules) {
      const ruleSetId = db.prepare(`
        INSERT INTO rule_sets (contract_id, version, ltrf_burden, prorate_edge_months,
          minor_repair_threshold, wallpaper_grace_months, flooring_grace_months,
          late_interest_rate, tenant_paid_advance_fee, advance_fee_amount)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        childId, prevRules.ltrf_burden, prevRules.prorate_edge_months,
        prevRules.minor_repair_threshold, prevRules.wallpaper_grace_months,
        prevRules.flooring_grace_months, prevRules.late_interest_rate,
        prevRules.tenant_paid_advance_fee, prevRules.advance_fee_amount,
      ).lastInsertRowid;

      const insItem = db.prepare(`
        INSERT INTO rule_items (rule_set_id, category, label, useful_life_years,
          last_renewed_on, replacement_cost, grace_applicable)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const it of repo.getRuleItems(prevRules.id))
        insItem.run(ruleSetId, it.category, it.label, it.useful_life_years,
          it.last_renewed_on, it.replacement_cost, it.grace_applicable);
    }

    db.prepare(`UPDATE contracts SET renewal_decision = 'renew', status = 'renewing' WHERE id = ?`)
      .run(prev.id);

    return {
      contract: repo.getContract(childId),
      parentId: prev.id,
      renewedFrom,
      expiresOn,
      rulesInherited: Boolean(prevRules),
    };
  })();
}

/**
 * 갱신하지 않음 — 만료로 종료할 예정임을 기록한다.
 *
 * 계약을 여기서 끝내지는 않는다. 임차인은 만료일까지 거주하고, 퇴거 절차는 8단계에서
 * 별도로 시작한다. 이 기록의 역할은 갱신 할 일을 해제하는 것이다.
 * (용어: 파기가 아니라 **계약 만료**다.)
 */
export function declineRenewal(contractId) {
  const contract = repo.getContract(contractId);
  if (!contract) fail('계약을 찾을 수 없습니다', 404);
  if (contract.status !== 'active') fail('거주 중인 계약만 선택할 수 있습니다', 409);
  if (childOf(contractId)) fail('이미 갱신 계약이 만들어져 있습니다', 409);

  db.prepare(`UPDATE contracts SET renewal_decision = 'decline' WHERE id = ?`).run(contractId);
  return repo.getContract(contractId);
}

/* ── 퇴거 개시 · 점검 ─────────────────────────────────────── */

/** 점검 사진 구역 — 화면과 서버가 같은 목록을 본다 */
export const INSPECTION_AREAS = [
  { key: 'entrance', label: '현관' },
  { key: 'livingroom', label: '거실' },
  { key: 'kitchen', label: '주방' },
  { key: 'bedroom', label: '침실' },
  { key: 'bathroom', label: '욕실' },
  { key: 'balcony', label: '발코니' },
  { key: 'etc', label: '기타' },
];
const AREA_KEYS = new Set(INSPECTION_AREAS.map((a) => a.key));

/**
 * 퇴거 절차 시작 — 퇴거 예정일을 확정하고 계약을 `closing` 으로 옮긴다.
 *
 * ⚠ 이것은 **계약 파기가 아니라 만료에 따른 종료 절차**다. 귀책이 있는 해지를 뜻하지 않는다.
 *   화면 문구도 "퇴거 절차 시작" 으로 유지할 것.
 *
 * 퇴거일을 정하는 것이 이 단계의 전부다. 정산 계산이 `move_out_date` 없이는
 * 시작되지 않고(`calculate`), 할 일 규칙도 이 날짜에서 D-30 · D-7 을 잰다.
 */
export function startMoveout(contractId, moveOutDate) {
  const contract = repo.getContract(contractId);
  if (!contract) fail('계약을 찾을 수 없습니다', 404);
  if (!['active', 'closing'].includes(contract.status))
    fail('거주 중인 계약만 퇴거 절차를 시작할 수 있습니다', 409);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(moveOutDate ?? '')))
    fail('퇴거 예정일을 YYYY-MM-DD 로 주세요', 400);
  if (moveOutDate < contract.move_in_date)
    fail('퇴거 예정일이 입주일보다 빠릅니다', 400);
  if (childOf(contractId)) fail('갱신 계약이 있는 계약입니다', 409);

  return db.transaction(() => {
    db.prepare(`
      UPDATE contracts
      SET move_out_date = ?, status = 'closing',
          renewal_decision = COALESCE(renewal_decision, 'moveout')
      WHERE id = ?`).run(moveOutDate, contractId);
    db.prepare(`UPDATE units SET vacancy_status = 'closing' WHERE id = ?`).run(contract.unit_id);
    return repo.getContract(contractId);
  })();
}

/**
 * 퇴거 점검 요청 + 링크 발급.
 *
 * 점검은 계약당 하나만 둔다. 다시 요청하면 같은 점검의 링크만 새로 낸다 —
 * 이미 올라온 사진을 잃지 않기 위해서다.
 */
export function requestInspection(contractId) {
  const contract = repo.getContract(contractId);
  if (!contract) fail('계약을 찾을 수 없습니다', 404);
  if (contract.status !== 'closing')
    fail('퇴거 절차를 먼저 시작해 주세요', 409);

  const token = crypto.randomBytes(16).toString('base64url');

  return db.transaction(() => {
    let inspection = repo.getInspection(contractId);
    if (!inspection) {
      db.prepare(`
        INSERT INTO inspections (contract_id, kind, status, requested_at)
        VALUES (?, 'moveout', 'requested', date('now','localtime'))`).run(contractId);
    } else {
      /* 재요청은 "사진을 더 받겠다" 는 뜻이다. 이미 제출·검토된 점검도 다시 열어 준다.
         올라온 사진과 지정한 항목은 그대로 두고, 다시 검토하면 항목이 갈아끼워진다. */
      db.prepare(`
        UPDATE inspections SET status = 'requested', submitted_at = NULL,
                               requested_at = date('now','localtime')
        WHERE id = ?`).run(inspection.id);
    }
    inspection = repo.getInspection(contractId);

    db.prepare(`
      DELETE FROM share_links
      WHERE contract_id = ? AND purpose = 'inspection' AND completed_at IS NULL`).run(contractId);

    db.prepare(`
      INSERT INTO share_links (token, contract_id, purpose, expires_at)
      VALUES (?, ?, 'inspection', date('now','localtime','+30 day'))`).run(token, contractId);

    return { token, url: `/t/${token}`, inspectionId: inspection.id, status: inspection.status };
  })();
}

/** 임차인이 구역 사진을 한 장 올린다 */
export function addInspectionPhoto(token, { area, filePath, note }) {
  const link = openLink(token, 'inspection');
  if (link.completedAt) fail('이미 제출한 점검입니다', 409);
  if (!AREA_KEYS.has(area)) fail('구역 값이 올바르지 않습니다', 400);
  if (!filePath) fail('사진 파일이 필요합니다', 400);

  const inspection = repo.getInspection(link.contractId);
  if (!inspection) fail('점검 요청이 없습니다', 409);

  const id = db.prepare(`
    INSERT INTO inspection_photos (inspection_id, area, file_path, note)
    VALUES (?, ?, ?, ?)`).run(inspection.id, area, filePath, note?.trim() || null).lastInsertRowid;

  const photo = repo.getInspectionPhoto(id);
  return { id: photo.id, area: photo.area, note: photo.note, createdAt: photo.created_at };
}

/** 임차인이 제출을 마친다 — 링크가 닫히고 임대인 검토로 넘어간다 */
export function submitInspection(token) {
  const link = openLink(token, 'inspection');
  if (link.completedAt) fail('이미 제출한 점검입니다', 409);

  const inspection = repo.getInspection(link.contractId);
  if (!inspection) fail('점검 요청이 없습니다', 409);
  if (!repo.getInspectionPhotos(inspection.id).length)
    fail('사진을 한 장 이상 올려 주세요', 400);

  return db.transaction(() => {
    db.prepare(`
      UPDATE inspections SET status = 'submitted', submitted_at = date('now','localtime')
      WHERE id = ?`).run(inspection.id);
    db.prepare(`UPDATE share_links SET completed_at = datetime('now','localtime') WHERE id = ?`)
      .run(link.id);
    return { status: 'submitted', photos: repo.getInspectionPhotos(inspection.id).length };
  })();
}

/**
 * 임대인 검토 — 사진을 보고 항목별 귀책비율을 지정하면 `damage_reports` 가 만들어진다.
 * 여기가 **점검과 계산 엔진이 만나는 지점**이다. 엔진은 damage_reports 만 읽는다.
 *
 * 귀책비율 0 은 "통상손모 — 임대인 부담" 이라는 뜻이고, 그 항목도 기록에 남긴다.
 * 빼면 임차인 입장에서 "왜 이 항목은 아예 없지?" 가 되고, 합의 화면에서 다툼이 된다.
 *
 * 다시 검토하면 이 점검이 만든 damage_reports 를 갈아끼운다. 손으로 추가한
 * (inspection_id 가 없는) 항목은 건드리지 않는다.
 */
export function reviewInspection(inspectionId, items) {
  const inspection = repo.getInspectionById(inspectionId);
  if (!inspection) fail('점검을 찾을 수 없습니다', 404);
  if (inspection.status === 'requested') fail('아직 제출되지 않은 점검입니다', 409);
  if (!Array.isArray(items)) fail('items 는 배열이어야 합니다', 400);

  for (const it of items) {
    const ratio = Number(it.faultRatio ?? 0);
    if (!(ratio >= 0 && ratio <= 1)) fail('귀책비율은 0 ~ 1 사이여야 합니다', 400);
    if (!String(it.description ?? '').trim()) fail('항목 설명을 적어 주세요', 400);
  }

  return db.transaction(() => {
    db.prepare(`DELETE FROM damage_reports WHERE inspection_id = ?`).run(inspectionId);

    const ins = db.prepare(`
      INSERT INTO damage_reports (contract_id, rule_item_id, description, fault_ratio,
                                  quoted_cost, photo_ref, inspection_id, photo_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const it of items) {
      const photo = it.photoId ? repo.getInspectionPhoto(Number(it.photoId)) : null;
      ins.run(
        inspection.contract_id,
        it.ruleItemId ? Number(it.ruleItemId) : null,
        String(it.description).trim(),
        Number(it.faultRatio ?? 0),
        it.quotedCost == null || it.quotedCost === '' ? null : Number(it.quotedCost),
        photo?.area ?? null,
        inspectionId,
        photo?.id ?? null,
      );
    }

    db.prepare(`
      UPDATE inspections SET status = 'reviewed', reviewed_at = date('now','localtime')
      WHERE id = ?`).run(inspectionId);

    return readInspection(inspection.contract_id);
  })();
}

/** 점검 화면(임대인·임차인 공통)이 쓰는 묶음 */
export function readInspection(contractId) {
  const inspection = repo.getInspection(contractId);
  if (!inspection) return null;

  const ruleRow = repo.getRuleSet(contractId);
  return {
    id: inspection.id,
    status: inspection.status,
    requestedAt: inspection.requested_at,
    submittedAt: inspection.submitted_at,
    reviewedAt: inspection.reviewed_at,
    areas: INSPECTION_AREAS,
    photos: repo.getInspectionPhotos(inspection.id),
    damages: repo.getDamages(contractId),
    ruleItems: ruleRow ? repo.getRuleItems(ruleRow.id) : [],
  };
}

/** 계약 상세가 보여줄 갱신 체인 정보 */
export function renewalChain(contract) {
  const parent = contract.parent_contract_id
    ? repo.getContract(contract.parent_contract_id) : null;
  const child = childOf(contract.id);

  return {
    decision: contract.renewal_decision ?? null,
    parentId: parent?.id ?? null,
    /** 이번 갱신 기간의 시작일 — 부모의 만료일 다음 날 (컬럼으로 저장하지 않는다) */
    renewedFrom: parent?.expires_on ? shiftIso(parent.expires_on, 1) : null,
    childId: child?.id ?? null,
    childStatus: child?.status ?? null,
  };
}

/**
 * 정산 계산 직전에 K-apt 실 단가를 확보한다. 라우트가 calculate/issue 앞에서 부른다.
 *
 * calculate() 를 async 로 만들지 않은 이유: 엔진 입력을 만드는 경로는 DB 만 보는
 * 동기 함수로 남아야 확정된 정산서를 나중에 그대로 재계산해 검증할 수 있다.
 * 네트워크는 그 바깥에서 끝내고, 여기서는 DB 에 앉은 값만 읽는다.
 *
 * 키가 없거나 공공데이터가 죽어도 조용히 넘어간다 — 있는 단가로 계산된다.
 */
export async function ensureRates(contractId) {
  const contract = repo.getContract(contractId);
  if (!contract?.move_out_date) return null;
  return ensureLtrfRates(
    contract.complex_id,
    contract.move_in_date.slice(0, 7),
    contract.move_out_date.slice(0, 7),
  );
}

/** 계약 하나에 대해 정산서를 계산한다 (DB 저장 없음, 미리보기용) */
export function calculate(contractId) {
  const contract = repo.getContract(contractId);
  if (!contract) throw Object.assign(new Error('계약을 찾을 수 없습니다'), { status: 404 });
  if (!contract.move_out_date)
    throw Object.assign(new Error('퇴거예정일이 설정되지 않았습니다'), { status: 400 });

  const ruleRow = repo.getRuleSet(contractId);
  if (!ruleRow)
    throw Object.assign(new Error('Rule Lock이 설정되지 않았습니다'), { status: 409 });

  const rules = repo.toRules(ruleRow);
  const fromYm = contract.move_in_date.slice(0, 7);
  const toYm = contract.move_out_date.slice(0, 7);

  const ltrfRates = repo.getLtrfRates(contract.complex_id, fromYm, toYm);
  const mntRow = repo.getMaintenanceRate(contract.complex_id, toYm);
  const prepaid = repo.getPrepaid(contractId, toYm);

  const result = buildSettlement({
    contract,
    area: contract.exclusive_area,
    rules,
    ruleItems: repo.getRuleItems(ruleRow.id),
    ltrfRates,
    maintenanceRate: mntRow?.ratePerSqm ?? 0,
    maintenancePrepaid: prepaid?.amount ?? 0,
    damages: repo.getDamages(contractId),
    /* 갱신 체인 전체를 본다. 장충금은 최초 입주일부터 세면서 수선만 마지막 계약에서
       세면, 같은 임대차인데 기간이 두 개인 정산서가 된다. */
    repairEvents: repo.getRepairEventsInChain(contractId),
    arrears: repo.getArrearsInChain(contractId),
  });

  return {
    contract: {
      id: contract.id,
      complexName: contract.complex_name,
      kaptCode: contract.kapt_code,
      address: contract.address,
      dong: contract.dong,
      ho: contract.ho,
      exclusiveArea: contract.exclusive_area,
      landlordName: contract.landlord_name,
      tenantName: contract.tenant_name,
      deposit: contract.deposit,
      monthlyRent: contract.monthly_rent,
      moveInDate: contract.move_in_date,
      moveOutDate: contract.move_out_date,
      status: contract.status,
    },
    rules,
    /* 실 단가와 시드 단가가 한 정산서에 섞일 수 있다(공개되지 않은 달이 있으면).
       첫 행만 보고 판단하면 "실데이터"라고 표시해 놓고 속은 시드인 경우가 생긴다. */
    dataSource: {
      ltrfMonths: ltrfRates.length,
      ltrfKaptMonths: ltrfRates.filter((r) => r.source === 'kapt').length,
      ltrfSource: ltrfRates.length
        ? (ltrfRates.every((r) => r.source === 'kapt') ? 'kapt'
          : ltrfRates.some((r) => r.source === 'kapt') ? 'mixed' : 'seed')
        : 'none',
      live: Boolean((process.env.KAPT_SERVICE_KEY || '').trim()),
    },
    ...result,
  };
}

/** 계산 결과를 정산서로 발행(draft). 기존 미확정 정산서는 교체한다. */
export function issue(contractId) {
  const calc = calculate(contractId);
  const ruleRow = repo.getRuleSet(contractId);

  return db.transaction(() => {
    const existing = db.prepare(
      `SELECT id, status FROM settlements WHERE contract_id = ? ORDER BY id DESC LIMIT 1`
    ).get(contractId);
    if (existing && existing.status === 'sealed')
      throw Object.assign(new Error('이미 확정된 정산서가 있습니다'), { status: 409 });
    if (existing) db.prepare(`DELETE FROM settlements WHERE id = ?`).run(existing.id);

    const sid = db.prepare(`
      INSERT INTO settlements (contract_id, rule_set_id, status, net_amount, deposit_return)
      VALUES (?, ?, 'draft', ?, ?)`
    ).run(contractId, ruleRow.id, calc.totals.net, calc.totals.depositReturn).lastInsertRowid;

    /* 발행은 임대인이 내놓는 제안이다. 그러니 임대인 쪽은 발행 시점에 동의로 둔다.
       임대인이 자기 정산서에 다시 '동의' 를 누르게 하는 것은 v1 에서 한 화면으로
       양쪽을 흉내 내던 흔적이고, 임차인 동의를 임대인이 대신 누를 수 있게 되면
       합의 기록 자체가 의미를 잃는다. 이의가 들어오면 고쳐서 다시 발행한다. */
    /* 0원 줄은 **합의 대상이 아니다.** 돈이 오가지 않는 줄까지 임차인이 하나씩 눌러야
       제출되면, 확인해야 할 것이 어디인지 오히려 흐려진다. 그래서 양쪽 모두 동의로
       두고 화면에서는 근거만 보여 준다 (제출 게이트·'미합의 N건' 할 일도 같은 칸을 본다). */
    const insLine = db.prepare(`
      INSERT INTO settlement_lines (settlement_id, seq, kind, label, direction, amount,
                                    basis_json, calc_status, calc_reason,
                                    landlord_status, tenant_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'agreed', ?)`);
    for (const l of calc.lines)
      insLine.run(sid, l.seq, l.kind, l.label, l.direction, l.amount, JSON.stringify(l.basis),
        l.status ?? 'counted', l.reason ?? null, l.amount === 0 ? 'agreed' : 'pending');

    /* 이전 정산서를 가리키던 링크는 **제출을 마친 것까지** 전부 버린다.
       링크는 계약에만 매여 있고 정산서 id 를 들고 있지 않아서, 남겨 두면 옛 링크가
       새 정산서를 열어 준다 — 화면에는 "확인이 제출되었습니다" 라면서 바뀐 금액이
       보이는 상태가 된다. 옛 정산서는 위에서 지워졌으니 그 응답 기록도 이미 없다. */
    db.prepare(`DELETE FROM share_links WHERE contract_id = ? AND purpose = 'settlement'`)
      .run(contractId);

    return read(sid);
  })();
}

export function read(settlementId) {
  const s = db.prepare(`SELECT * FROM settlements WHERE id = ?`).get(settlementId);
  if (!s) throw Object.assign(new Error('정산서를 찾을 수 없습니다'), { status: 404 });
  const lines = db.prepare(
    `SELECT * FROM settlement_lines WHERE settlement_id = ? ORDER BY seq`).all(settlementId);
  const contract = repo.getContract(s.contract_id);
  const ruleRow = db.prepare(`SELECT * FROM rule_sets WHERE id = ?`).get(s.rule_set_id);

  const parsed = lines.map((l) => ({
    ...l,
    basis: JSON.parse(l.basis_json),
    basis_json: undefined,
    calcStatus: l.calc_status ?? 'counted',
    calcReason: l.calc_reason ?? null,
  }));
  const tenantCredit = parsed.filter((l) => l.direction === 'tenant_credit')
    .reduce((a, l) => a + l.amount, 0);
  const landlordDeduct = parsed.filter((l) => l.direction === 'landlord_deduct')
    .reduce((a, l) => a + l.amount, 0);

  return {
    id: s.id,
    contractId: s.contract_id,
    status: s.status,
    generatedAt: s.generated_at,
    sealedAt: s.sealed_at,
    snapshotHash: s.snapshot_hash,
    contract: {
      complexName: contract.complex_name, dong: contract.dong, ho: contract.ho,
      exclusiveArea: contract.exclusive_area, address: contract.address,
      landlordName: contract.landlord_name, tenantName: contract.tenant_name,
      deposit: contract.deposit, monthlyRent: contract.monthly_rent,
      moveInDate: contract.move_in_date, moveOutDate: contract.move_out_date,
    },
    rules: repo.toRules(ruleRow),
    lines: parsed,
    totals: {
      tenantCredit, landlordDeduct,
      net: tenantCredit - landlordDeduct,
      deposit: contract.deposit,
      depositReturn: contract.deposit + (tenantCredit - landlordDeduct),
    },
    agreement: agreementState(parsed),
  };
}

/**
 * 합의 현황.
 *
 * **금액이 있는 줄만 본다.** 0원 줄(해당 없음 · 계산 불가)은 화면에서 '확인 불필요' 로
 * 나가 누를 버튼 자체가 없다. 발행할 때 양쪽 동의로 넣어 두긴 하지만, 그 불변식이
 * 한 줄의 INSERT 에만 걸려 있어 쉽게 깨진다. 여기서도 같은 기준으로 세어 둔다 —
 * 아니면 아무도 손쓸 수 없는 줄 하나 때문에 정산서가 영영 확정되지 않는다.
 */
export function agreementState(allLines) {
  const lines = allLines.filter((l) => l.amount !== 0);
  const total = lines.length;
  const landlordAgreed = lines.filter((l) => l.landlord_status === 'agreed').length;
  const tenantAgreed = lines.filter((l) => l.tenant_status === 'agreed').length;
  const disputed = lines.filter(
    (l) => l.landlord_status === 'disputed' || l.tenant_status === 'disputed');
  return {
    total,
    landlordAgreed,
    tenantAgreed,
    disputedCount: disputed.length,
    disputedSeqs: disputed.map((l) => l.seq),
    /**
     * 금액이 있는 줄이 하나도 없으면(전 항목 0원) **합의할 것이 없으므로 확정할 수 있다.**
     *
     * 예전에는 `total > 0` 을 달아 두어서, 공제도 반환도 없는 정산서가 영영 확정되지
     * 않았다. 그러면 계약이 `closing` 에 남고 집도 공실로 돌아오지 못해, 임대인이
     * 손쓸 방법 없이 그 집이 잠겼다. 실제로 4년 거주 계약에서 이 상태가 나왔다.
     *
     * 이 경우 보증금은 전액 반환이고 임차인이 눌러야 할 항목도 없다.
     */
    bothAgreedAll: landlordAgreed === total && tenantAgreed === total
      && disputed.length === 0,
  };
}

/** 항목별 동의 / 이의제기 */
export function respond(settlementId, seq, party, status, note) {
  if (!['landlord', 'tenant'].includes(party))
    throw Object.assign(new Error('party는 landlord 또는 tenant'), { status: 400 });
  if (!['agreed', 'disputed', 'pending'].includes(status))
    throw Object.assign(new Error('status는 agreed | disputed | pending'), { status: 400 });

  const s = db.prepare(`SELECT status FROM settlements WHERE id = ?`).get(settlementId);
  if (!s) throw Object.assign(new Error('정산서를 찾을 수 없습니다'), { status: 404 });
  if (s.status === 'sealed')
    throw Object.assign(new Error('확정된 정산서는 수정할 수 없습니다'), { status: 409 });

  const col = party === 'landlord' ? 'landlord_status' : 'tenant_status';
  const noteCol = party === 'landlord' ? 'landlord_note' : 'tenant_note';
  const info = db.prepare(
    `UPDATE settlement_lines SET ${col} = ?, ${noteCol} = ? WHERE settlement_id = ? AND seq = ?`
  ).run(status, note ?? null, settlementId, seq);
  if (info.changes === 0)
    throw Object.assign(new Error('해당 항목이 없습니다'), { status: 404 });

  const updated = read(settlementId);
  if (updated.agreement.bothAgreedAll && updated.status === 'draft') {
    db.prepare(`UPDATE settlements SET status = 'agreed' WHERE id = ?`).run(settlementId);
    updated.status = 'agreed';
  } else if (!updated.agreement.bothAgreedAll && updated.status === 'agreed') {
    db.prepare(`UPDATE settlements SET status = 'draft' WHERE id = ?`).run(settlementId);
    updated.status = 'draft';
  }
  return updated;
}

/* ── 정산서 합의 — 임차인 링크 ─────────────────────────────────
   계약 확인·점검과 같은 패턴이다. 임대인 화면에는 임차인 버튼을 두지 않고,
   임차인의 동의는 토큰으로만 들어온다. */

/** 정산서 확인 링크 발급. 재발송하면 이전 링크는 버린다. */
export function sendSettlementLink(contractId) {
  const s = latestSettlement(contractId);
  if (!s) fail('정산서를 먼저 발행해 주세요', 409);
  if (s.status === 'sealed') fail('이미 확정된 정산서입니다', 409);

  const token = crypto.randomBytes(16).toString('base64url');

  return db.transaction(() => {
    db.prepare(`
      DELETE FROM share_links
      WHERE contract_id = ? AND purpose = 'settlement' AND completed_at IS NULL`
    ).run(contractId);

    db.prepare(`
      INSERT INTO share_links (token, contract_id, purpose, expires_at)
      VALUES (?, ?, 'settlement', date('now','localtime','+30 day'))`
    ).run(token, contractId);

    return { token, url: `/t/${token}`, settlementId: s.id, sentAt: new Date().toISOString() };
  })();
}

const latestSettlement = (contractId) => db.prepare(
  `SELECT id, status FROM settlements WHERE contract_id = ? ORDER BY id DESC LIMIT 1`
).get(contractId);

/**
 * 임차인에게 보내는 정산서.
 * 임대인의 메모(`landlord_note`)는 넣지 않는다 — 내부 기록이고, 맥락 없이 보이면
 * 불필요한 다툼이 된다. 금액과 계산 근거는 그대로 보여 준다(§ 같은 숫자를 본다).
 */
function settlementForTenant(contractId) {
  const row = latestSettlement(contractId);
  if (!row) return null;
  const s = read(row.id);

  return {
    id: s.id,
    status: s.status,
    generatedAt: s.generatedAt,
    sealedAt: s.sealedAt,
    totals: s.totals,
    /* ⚠ landlord_note 는 임대인 내부 메모다. 임차인 payload 에 절대 담지 않는다. */
    lines: s.lines.map((l) => ({
      seq: l.seq, kind: l.kind, label: l.label, direction: l.direction,
      amount: l.amount, basis: l.basis,
      calcStatus: l.calcStatus, calcReason: l.calcReason,
      status: l.tenant_status, note: l.tenant_note,
    })),
    /* 0원 줄은 발행 시점에 동의로 들어가 있다. 임차인이 실제로 눌러야 하는 것은
       금액이 있는 줄뿐이라, 진행도도 그 기준으로 센다. */
    answerable: s.lines.filter((l) => l.amount !== 0).length,
    answered: s.lines.filter((l) => l.amount !== 0 && l.tenant_status !== 'pending').length,
    agreed: s.agreement.tenantAgreed,
    total: s.agreement.total,
  };
}

/** 항목 하나에 대한 임차인의 동의 / 이의 */
export function respondToSettlement(token, seq, status, note) {
  const link = openLink(token, 'settlement');
  if (link.completedAt) fail('이미 제출을 마친 링크입니다', 409);

  const s = latestSettlement(link.contractId);
  if (!s) fail('정산서가 없습니다', 409);

  /* 이의는 사유가 있어야 임대인이 무엇을 고쳐야 할지 안다 (계약 거부와 같다) */
  if (status === 'disputed' && !String(note ?? '').trim())
    fail('이의 사유를 적어 주세요', 400);

  respond(s.id, Number(seq), 'tenant', status, note);
  return settlementForTenant(link.contractId);
}

/** 전 항목을 확인한 뒤 제출 — 링크가 닫힌다 */
export function submitSettlementResponse(token) {
  const link = openLink(token, 'settlement');
  if (link.completedAt) fail('이미 제출했습니다', 409);

  const s = latestSettlement(link.contractId);
  if (!s) fail('정산서가 없습니다', 409);

  /* 0원 줄은 화면에서 '확인 불필요' 로 나가 누를 버튼 자체가 없다. 그런 줄까지 세면
     임차인이 손쓸 방법 없이 제출이 막힌다 — 금액이 있는 줄만 본다. */
  const pending = db.prepare(`
    SELECT COUNT(*) n FROM settlement_lines
    WHERE settlement_id = ? AND amount <> 0 AND tenant_status = 'pending'`).get(s.id).n;
  if (pending > 0) fail(`아직 확인하지 않은 항목이 ${pending}건 있습니다`, 400);

  db.prepare(`UPDATE share_links SET completed_at = datetime('now','localtime') WHERE id = ?`)
    .run(link.id);

  return settlementForTenant(link.contractId);
}

/** 임대인 화면이 보는 임차인 동의 현황 (링크 상태 포함) */
export function settlementShareState(contractId) {
  const link = db.prepare(`
    SELECT token, first_opened_at, completed_at, expires_at FROM share_links
    WHERE contract_id = ? AND purpose = 'settlement'
    ORDER BY id DESC LIMIT 1`).get(contractId);
  if (!link) return null;
  return {
    token: link.token,
    url: `/t/${link.token}`,
    firstOpenedAt: link.first_opened_at,
    completedAt: link.completed_at,
    expiresAt: link.expires_at,
  };
}

/** 양측 전원 동의 시 확정 — 스냅샷 동결 + 해시 */
export function seal(settlementId) {
  const cur = read(settlementId);
  if (cur.status === 'sealed')
    throw Object.assign(new Error('이미 확정되었습니다'), { status: 409 });
  if (!cur.agreement.bothAgreedAll)
    throw Object.assign(
      new Error('모든 항목에 양측이 동의해야 확정할 수 있습니다'), { status: 409 });

  const snapshot = JSON.stringify(cur);
  const hash = crypto.createHash('sha256').update(snapshot).digest('hex');
  db.prepare(`
    UPDATE settlements
    SET status = 'sealed', snapshot_json = ?, snapshot_hash = ?,
        sealed_at = datetime('now','localtime')
    WHERE id = ?`).run(snapshot, hash, settlementId);
  db.prepare(`UPDATE contracts SET status = 'closed' WHERE id = ?`).run(cur.contractId);

  /**
   * 집을 공실로 돌려놓는다.
   *
   * 상태 전이가 `contracting → occupied → closing` 까지만 있고 **되돌아오는 길이
   * 없었다.** 그래서 정산을 확정해 계약이 닫힌 뒤에도 집은 영영 '퇴거 진행 중' 이었고,
   * 홈 화면에서 공실로 세어지지도, 새 계약을 쓸 수도 없었다.
   *
   * 퇴거일이 지나는 것만으로는 바꾸지 않는다 — 그때는 정산이라는 할 일이 남아 있고,
   * '퇴거 진행 중' 이 그 사실을 알려 주기 때문이다. 임대차가 끝났다고 말할 수 있는
   * 시점은 정산서를 확정한 순간이다.
   *
   * ⚠ 다음 임차인 계약이 이미 시작된 집은 건드리지 않는다. 이전 계약의 정산이 늦게
   *   확정되면 '계약 진행 중' 이나 '거주 중' 인 집을 공실로 되돌려 버린다.
   */
  const live = db.prepare(`
    SELECT COUNT(*) n FROM contracts
    WHERE unit_id = (SELECT unit_id FROM contracts WHERE id = ?)
      AND id <> ? AND status <> 'closed'`).get(cur.contractId, cur.contractId).n;

  if (!live)
    db.prepare(`
      UPDATE units SET vacancy_status = 'vacant'
      WHERE id = (SELECT unit_id FROM contracts WHERE id = ?)`).run(cur.contractId);

  return read(settlementId);
}
