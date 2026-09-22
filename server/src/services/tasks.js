/**
 * CRM 할 일 — V2-SPEC §3 규칙표
 *
 * 크론이 없다. 홈을 열 때 `refreshTasks(landlordId)` 가 현재 DB 상태에서
 * "지금 떠 있어야 하는 할 일 집합"을 계산하고, tasks 테이블을 그 집합에 맞춘다.
 * 조건이 사라진 할 일은 지운다. 그래서 같은 데이터면 몇 번 불러도 같은 결과가 나오고
 * 인프라가 필요 없다.
 *
 * 날짜 판단은 전부 `timeline.js` 를 거친다. 화면과 할 일이 다른 날짜를 보면
 * "홈은 D-60 이라는데 할 일은 안 뜬다" 같은 사고가 난다.
 *
 * severity 는 놓쳤을 때 되돌릴 수 있는지로 정한다.
 *   urgent — 지나면 법적 효과가 확정된다 (묵시적 갱신)
 *   warn   — 지나면 일정이 밀리거나 상대가 기다린다
 *   info   — 알고만 있으면 되는 것
 */

import { db } from '../db.js';
import {
  contractTimeline, daysUntil, startOfToday, toIso,
  RENEWAL_WINDOW_DAYS, RENEWAL_NOTICE_DAYS, SETTLEMENT_ISSUE_DAYS, AGREEMENT_DUE_DAYS,
} from './timeline.js';

/** 임차인 확인 링크를 보낸 뒤 이만큼 무응답이면 할 일로 올린다 */
export const TENANT_PENDING_DAYS = 3;
/** 수선 신고가 접수된 뒤 이만큼 처리되지 않으면 할 일로 올린다 */
export const REPAIR_OPEN_DAYS = 2;

/** 심각도 정렬 순서 — 목록 상단에 급한 것이 온다 */
const SEVERITY_ORDER = { urgent: 0, warn: 1, info: 2 };

const KIND_LABEL = {
  renewal_decision: '갱신 판단',
  renewal_deadline: '통지 기한',
  settlement_issue: '정산서 발행',
  agreement_due: '합의 마감',
  tenant_pending: '임차인 대기',
  repair_open: '수선 처리',
  ownership_unverified: '소유 검증',
};

export const kindLabel = (kind) => KIND_LABEL[kind] ?? kind;

const place = (row) => [row.complex_name, row.dong, row.ho].filter(Boolean).join(' ');

/** 'YYYY-MM-DD HH:MM:SS' 든 'YYYY-MM-DD' 든 날짜 부분만 본다 */
const daysSince = (timestamp, today) =>
  timestamp == null ? null : -daysUntil(String(timestamp).slice(0, 10), today);

/* ── 상태 조회 ─────────────────────────────────────────────── */

/* 조회는 전부 함수로 감싼다 — 모듈 로드 시점에 prepare 하면 migrate() 보다 먼저 돌아
   "no such table" 로 죽는다 (repository.js 와 같은 방식). */

const liveContracts = (landlordId) => db.prepare(`
  SELECT c.id, c.status, c.tenant_name, c.expires_on, c.move_out_date,
         c.renewal_decision, c.unit_id,
         u.dong, u.ho, cx.name AS complex_name,
         (SELECT sl.created_at FROM share_links sl
           WHERE sl.contract_id = c.id AND sl.purpose = 'contract_review'
             AND sl.completed_at IS NULL
           ORDER BY sl.id DESC LIMIT 1)                     AS review_sent_at,
         (SELECT s.id FROM settlements s
           WHERE s.contract_id = c.id ORDER BY s.id DESC LIMIT 1)     AS settlement_id,
         (SELECT s.status FROM settlements s
           WHERE s.contract_id = c.id ORDER BY s.id DESC LIMIT 1)     AS settlement_status
  FROM contracts c
  JOIN units u      ON u.id = c.unit_id
  JOIN complexes cx ON cx.id = u.complex_id
  WHERE c.landlord_id = ? AND c.status <> 'closed'
  ORDER BY c.id`).all(landlordId);

const openRepairs = (contractId) => db.prepare(`
  SELECT COUNT(*) AS n, MIN(reported_at) AS oldest
  FROM repair_requests WHERE contract_id = ? AND status = 'open'`).get(contractId);

/* 0원 줄은 확인을 묻지 않으므로 '미합의' 로 세지 않는다 (service.agreementState 와 같은 기준) */
const unagreedLines = (settlementId) => db.prepare(`
  SELECT COUNT(*) AS n FROM settlement_lines
  WHERE settlement_id = ? AND amount <> 0
    AND (landlord_status <> 'agreed' OR tenant_status <> 'agreed')`
).get(settlementId).n;

const unverifiedUnits = (landlordId) => db.prepare(`
  SELECT u.id, u.dong, u.ho, u.ownership_status, cx.name AS complex_name
  FROM units u
  JOIN complexes cx ON cx.id = u.complex_id
  WHERE u.landlord_id = ? AND u.ownership_status <> 'verified'
  ORDER BY u.id`).all(landlordId);

const OWNERSHIP_REASON = {
  unverified: '등기부를 아직 올리지 않았습니다',
  name_mismatch: '등기부 소유자 이름이 임대인과 다릅니다',
  address_mismatch: '등기부 주소가 등록한 집과 다릅니다',
  parse_failed: '등기부를 읽지 못했습니다 — 다시 올려 주세요',
};

/* ── 규칙 ──────────────────────────────────────────────────── */

/**
 * 지금 떠 있어야 하는 할 일을 전부 계산한다. DB 를 쓰지 않는다.
 * 반환 항목의 (contractId, kind) 또는 (unitId, kind) 가 tasks 의 유일 키다.
 */
export function evaluateTasks(landlordId, today = startOfToday()) {
  const out = [];
  const push = (t) => out.push({ landlordId, severity: 'info', ...t });

  for (const c of liveContracts(landlordId)) {
    const t = contractTimeline(c, today);
    const where = place(c);

    /* ① 갱신 — 만료 6개월 전부터 판단, 2개월 전이 통지 기한 */
    if (c.status === 'active' && t.renewalWindowOpen && !c.renewal_decision) {
      /* 통지 기한이 남아 있는 동안은 '판단', 지나거나 임박하면 '기한'으로 넘긴다.
         두 규칙의 조건이 겹치는 구간에서 같은 계약에 갱신 할 일이 두 개 뜨지 않게 한다. */
      if (t.daysToNoticeDeadline > 0) {
        push({
          contractId: c.id, unitId: c.unit_id, kind: 'renewal_decision', severity: 'info',
          dueOn: t.noticeDeadline,
          title: `${where} — 갱신 여부를 결정해 주세요`,
          body: `${c.tenant_name}님 계약이 ${t.expiresOn} 만료입니다. `
            + `갱신거절 통지 기한은 ${t.noticeDeadline} (D-${t.daysToNoticeDeadline})입니다.`,
        });
      } else {
        push({
          contractId: c.id, unitId: c.unit_id, kind: 'renewal_deadline', severity: 'urgent',
          dueOn: t.noticeDeadline,
          title: t.impliedRenewal
            ? `${where} — 묵시적 갱신이 성립했습니다`
            : `${where} — 오늘이 갱신거절 통지 기한입니다`,
          body: t.impliedRenewal
            ? `통지 기한 ${t.noticeDeadline} 이 지났습니다. 주택임대차보호법 제6조에 따라 `
              + `같은 조건으로 갱신된 것으로 봅니다.`
            : `오늘까지 통지하지 않으면 같은 조건으로 묵시적 갱신됩니다.`,
        });
      }
    }

    /* ② 퇴거 30일 전인데 정산서가 없다 */
    if (c.status === 'closing' && !c.move_out_date) {
      push({
        contractId: c.id, unitId: c.unit_id, kind: 'settlement_issue', severity: 'warn',
        title: `${where} — 퇴거 예정일을 입력해 주세요`,
        body: '퇴거일이 없으면 정산서를 발행할 수 없습니다.',
      });
    } else if (c.status === 'closing' && !c.settlement_id
               && t.daysToMoveOut <= SETTLEMENT_ISSUE_DAYS) {
      push({
        contractId: c.id, unitId: c.unit_id, kind: 'settlement_issue', severity: 'warn',
        dueOn: c.move_out_date,
        title: `${where} — 정산서를 발행해 주세요`,
        body: t.daysToMoveOut >= 0
          ? `퇴거까지 ${t.daysToMoveOut}일 남았습니다. 점검 결과를 확인하고 발행하세요.`
          : `퇴거일이 ${-t.daysToMoveOut}일 지났습니다.`,
      });
    }

    /* ③ 합의 마감 임박 — 미합의 항목이 남아 있다 */
    if (c.settlement_id && c.settlement_status === 'draft'
        && t.daysToMoveOut !== null && t.daysToMoveOut <= AGREEMENT_DUE_DAYS) {
      const n = unagreedLines(c.settlement_id);
      if (n > 0) {
        push({
          contractId: c.id, unitId: c.unit_id, kind: 'agreement_due', severity: 'warn',
          dueOn: c.move_out_date,
          title: `${where} — 미합의 ${n}건`,
          body: t.daysToMoveOut >= 0
            ? `퇴거까지 ${t.daysToMoveOut}일입니다. 전원 동의해야 확정할 수 있습니다.`
            : `퇴거일이 지났습니다. 미합의 ${n}건을 정리해 주세요.`,
        });
      }
    }

    /* ④ 임차인이 링크를 받고도 응답하지 않는다 */
    if (c.status === 'pending_tenant') {
      const waited = daysSince(c.review_sent_at, today);
      if (waited !== null && waited >= TENANT_PENDING_DAYS) {
        push({
          contractId: c.id, unitId: c.unit_id, kind: 'tenant_pending', severity: 'info',
          title: `${where} — 임차인 확인이 ${waited}일째 없습니다`,
          body: `${c.tenant_name}님에게 보낸 계약 확인 링크에 응답이 없습니다. 연락해 보세요.`,
        });
      }
    }

    /* ⑤ 수선 신고가 방치되고 있다 — 임차인이 기다리는 중이다 */
    const repairs = openRepairs(c.id);
    const waitedRepair = daysSince(repairs.oldest, today);
    if (repairs.n > 0 && waitedRepair !== null && waitedRepair >= REPAIR_OPEN_DAYS) {
      push({
        contractId: c.id, unitId: c.unit_id, kind: 'repair_open', severity: 'warn',
        title: `${where} — 수선 신고 ${repairs.n}건 미처리`,
        body: `가장 오래된 신고가 ${waitedRepair}일째 열려 있습니다.`,
      });
    }
  }

  /* ⑥ 소유 검증 — 계약과 무관하게 집 단위로 뜬다 */
  for (const u of unverifiedUnits(landlordId)) {
    push({
      unitId: u.id, kind: 'ownership_unverified', severity: 'info',
      title: `${place(u)} — 등기부로 소유를 확인해 주세요`,
      body: OWNERSHIP_REASON[u.ownership_status] ?? '소유가 확인되지 않았습니다',
    });
  }

  return out;
}

/* ── 반영 ──────────────────────────────────────────────────── */

const keyOf = (t) => `${t.contractId ?? `u${t.unitId}`}:${t.kind}`;

const insert = (...args) => db.prepare(`
  INSERT INTO tasks (landlord_id, contract_id, unit_id, kind, severity, due_on, title, body)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...args);

const update = (...args) => db.prepare(`
  UPDATE tasks SET severity = ?, due_on = ?, title = ?, body = ?, done_at = NULL WHERE id = ?`
).run(...args);

const remove = (id) => db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);

/**
 * tasks 테이블을 지금 상태에 맞춘다.
 *
 * 이미 있는 할 일은 문구만 갱신한다 (created_at 을 보존해서 "며칠 전부터 떠 있는지"가 남는다).
 * 조건이 사라진 할 일은 지운다 — done 으로 남겨 두면 다음에 같은 조건이 다시 성립했을 때
 * 유일 인덱스에 걸려 새로 못 만든다.
 */
export function refreshTasks(landlordId, today = startOfToday()) {
  const wanted = evaluateTasks(landlordId, today);
  const wantedKeys = new Set(wanted.map(keyOf));

  const apply = db.transaction(() => {
    const existing = new Map(
      db.prepare(`SELECT id, contract_id, unit_id, kind FROM tasks WHERE landlord_id = ?`)
        .all(landlordId)
        .map((row) => [keyOf({ contractId: row.contract_id, unitId: row.unit_id, kind: row.kind }), row]),
    );

    for (const [key, row] of existing)
      if (!wantedKeys.has(key)) remove(row.id);

    for (const t of wanted) {
      const prev = existing.get(keyOf(t));
      if (prev) update(t.severity, t.dueOn ?? null, t.title, t.body ?? null, prev.id);
      else insert(landlordId, t.contractId ?? null, t.unitId ?? null, t.kind,
                      t.severity, t.dueOn ?? null, t.title, t.body ?? null);
    }
  });
  apply();

  return listTasks(landlordId, today);
}

/** 급한 것 → 기한 가까운 것 → 만든 순 */
export function listTasks(landlordId, today = startOfToday()) {
  const rows = db.prepare(`
    SELECT t.id, t.kind, t.severity, t.due_on AS dueOn, t.title, t.body,
           t.contract_id AS contractId, t.unit_id AS unitId, t.created_at AS createdAt
    FROM tasks t WHERE t.landlord_id = ? ORDER BY t.id`).all(landlordId);

  return rows
    .map((row) => ({
      ...row,
      kindLabel: kindLabel(row.kind),
      daysLeft: row.dueOn ? daysUntil(row.dueOn, today) : null,
    }))
    .sort((a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
      || (a.dueOn ?? '9999-12-31').localeCompare(b.dueOn ?? '9999-12-31')
      || a.id - b.id);
}

/** 화면에서 쓰는 요약 — 뱃지 숫자 */
export const taskSummary = (tasks) => ({
  total: tasks.length,
  urgent: tasks.filter((t) => t.severity === 'urgent').length,
  warn: tasks.filter((t) => t.severity === 'warn').length,
  today: toIso(startOfToday()),
  windowDays: { renewal: RENEWAL_WINDOW_DAYS, notice: RENEWAL_NOTICE_DAYS },
});
