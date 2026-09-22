import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* db.js 는 import 시점에 DB_PATH 를 읽는다. 임시 DB 를 먼저 지정하고 동적 import 한다. */
const DB_PATH = path.join(os.tmpdir(), `butler-setshare-test-${process.pid}.db`);
fs.rmSync(DB_PATH, { force: true });
process.env.DB_PATH = DB_PATH;

const { db, migrate } = await import('../src/db.js');
const svc = await import('../src/service.js');

migrate();

const landlordId = db.prepare(`INSERT INTO landlords (name) VALUES ('김성호')`).run().lastInsertRowid;
const complexId = db.prepare(
  `INSERT INTO complexes (kapt_code, name, priv_area) VALUES ('A1', '테스트단지', 1000)`)
  .run().lastInsertRowid;

db.prepare(`
  INSERT INTO ltrf_rates (complex_id, ym, rate_per_sqm, data_source)
  VALUES (?, '2024-01', 200, 'seed')`).run(complexId);

/** 퇴거 직전 상태의 계약을 하나 만들고 정산서까지 발행한다 */
function makeIssued(tenant = '이지은') {
  const unitId = db.prepare(`
    INSERT INTO units (complex_id, dong, ho, exclusive_area, landlord_id)
    VALUES (?, '101동', '1204호', 84.95, ?)`).run(complexId, landlordId).lastInsertRowid;

  const contractId = db.prepare(`
    INSERT INTO contracts (unit_id, landlord_id, landlord_name, tenant_name, deposit,
                           move_in_date, move_out_date, term_months, expires_on, status)
    VALUES (?, ?, '김성호', ?, 300000000, '2024-01-01', '2024-06-30', 24, '2026-01-01', 'closing')`)
    .run(unitId, landlordId, tenant).lastInsertRowid;

  svc.saveRuleSet(contractId, {
    ltrfBurden: 'landlord', prorateEdgeMonths: 1, minorRepairThreshold: 100000,
    wallpaperGraceMonths: 24, flooringGraceMonths: 24, lateInterestRate: 5,
    tenantPaidAdvanceFee: 1, advanceFeeAmount: 550000,
    items: [{
      category: 'wallpaper', label: '전체 도배', usefulLifeYears: 6,
      lastRenewedOn: '2024-01-01', replacementCost: 2600000, graceApplicable: true,
    }],
  });

  const settlement = svc.issue(contractId);
  return { contractId, settlement };
}

/* ── 발행 ──────────────────────────────────────────────────── */

test('발행하면 임대인 쪽은 전 항목 동의로 시작한다', () => {
  const { settlement } = makeIssued();
  assert.ok(settlement.lines.length > 0);
  assert.ok(settlement.lines.every((l) => l.landlord_status === 'agreed'),
    '발행은 임대인의 제안이자 동의다');
  /* 금액이 있는 줄만 임차인이 눌러야 한다. 0원 줄(해당 없음·계산 불가)은 근거만 보여 주고
     발행 시점에 양쪽 동의로 들어간다 — 돈이 오가지 않는 줄까지 확인을 요구하면
     정작 확인해야 할 곳이 흐려진다. */
  const money = settlement.lines.filter((l) => l.amount !== 0);
  assert.ok(money.length > 0, '금액이 있는 줄이 있어야 의미 있는 검증이다');
  assert.ok(money.every((l) => l.tenant_status === 'pending'));
  assert.ok(settlement.lines.filter((l) => l.amount === 0)
    .every((l) => l.tenant_status === 'agreed'));
  assert.equal(settlement.agreement.bothAgreedAll, false, '임차인이 아직 안 봤다');
});

test('0원 줄도 정산서에 남고 왜 0원인지 적힌다', () => {
  const { settlement } = makeIssued();
  const zero = settlement.lines.filter((l) => l.amount === 0);

  assert.ok(zero.length > 0, '0원 줄을 지우지 않는다');
  for (const l of zero) {
    assert.ok(['none', 'unavailable'].includes(l.calcStatus), `${l.kind} 의 calcStatus`);
    assert.ok(l.calcReason?.trim(), `${l.kind} 에 0원인 이유가 있어야 한다`);
  }
});

test('정산서 없이 링크를 보낼 수 없다', () => {
  const unitId = db.prepare(`
    INSERT INTO units (complex_id, dong, ho, exclusive_area, landlord_id)
    VALUES (?, '102동', '101호', 60, ?)`).run(complexId, landlordId).lastInsertRowid;
  const cid = db.prepare(`
    INSERT INTO contracts (unit_id, landlord_id, landlord_name, tenant_name, deposit,
                           move_in_date, term_months, expires_on, status)
    VALUES (?, ?, '김성호', '무정산', 0, '2024-01-01', 24, '2026-01-01', 'closing')`)
    .run(unitId, landlordId).lastInsertRowid;

  assert.throws(() => svc.sendSettlementLink(cid), /정산서를 먼저 발행/);
});

/* ── 링크 ──────────────────────────────────────────────────── */

test('링크를 재발급하면 살아 있는 링크는 하나뿐이다', () => {
  const { contractId } = makeIssued();
  const first = svc.sendSettlementLink(contractId);
  const second = svc.sendSettlementLink(contractId);

  assert.notEqual(first.token, second.token);
  const alive = db.prepare(`
    SELECT COUNT(*) n FROM share_links
    WHERE contract_id = ? AND purpose = 'settlement' AND completed_at IS NULL`).get(contractId).n;
  assert.equal(alive, 1);
  assert.throws(() => svc.readShareContext(first.token), /유효하지 않습니다/);
});

test('정산서를 다시 발행하면 이전 링크는 버려진다', () => {
  const { contractId } = makeIssued();
  const link = svc.sendSettlementLink(contractId);
  svc.issue(contractId);                       // 이의를 받아 고쳐서 재발행한 상황

  assert.throws(() => svc.readShareContext(link.token), /유효하지 않습니다/,
    '옛 링크로 옛 금액에 동의하게 두면 안 된다');
});

test('제출을 마친 링크도 재발행 때 함께 버려진다', () => {
  const { contractId, settlement } = makeIssued();
  const link = svc.sendSettlementLink(contractId);
  for (const l of settlement.lines) svc.respondToSettlement(link.token, l.seq, 'agreed');
  svc.submitSettlementResponse(link.token);

  svc.issue(contractId);

  /* 남겨 두면 "확인이 제출되었습니다" 라면서 바뀐 금액을 보여 주게 된다 */
  assert.throws(() => svc.readShareContext(link.token), /유효하지 않습니다/);
  assert.equal(svc.settlementShareState(contractId), null);
});

test('토큰은 자기 계약의 정산서만 연다', () => {
  const a = makeIssued('가입차인');
  const b = makeIssued('나입차인');
  const link = svc.sendSettlementLink(a.contractId);

  const ctx = svc.readShareContext(link.token);
  assert.equal(ctx.contract.id, a.contractId);
  assert.equal(ctx.settlement.id, a.settlement.id);
  assert.notEqual(ctx.settlement.id, b.settlement.id);
});

test('용도가 다른 링크로는 정산 응답을 할 수 없다', () => {
  const { contractId } = makeIssued();
  svc.startMoveout(contractId, '2024-06-30');
  const ins = svc.requestInspection(contractId);

  assert.throws(() => svc.respondToSettlement(ins.token, 1, 'agreed'), /용도가 맞지 않습니다/);
});

/* ── 임차인 응답 ───────────────────────────────────────────── */

test('임차인 화면에는 임대인 메모와 damage 내역이 가지 않는다', () => {
  const { contractId, settlement } = makeIssued();
  svc.respond(settlement.id, 1, 'landlord', 'agreed', '내부 메모 — 보이면 안 됨');
  const link = svc.sendSettlementLink(contractId);

  const ctx = svc.readShareContext(link.token);
  const raw = JSON.stringify(ctx.settlement);
  assert.ok(!raw.includes('내부 메모'), '임대인 메모는 내부 기록이다');
  assert.ok(!raw.includes('landlord_note'));
});

test('항목별 동의가 기록되고 전원 동의하면 상태가 agreed 로 바뀐다', () => {
  const { contractId, settlement } = makeIssued();
  const link = svc.sendSettlementLink(contractId);

  /* 합의는 **금액이 있는 줄** 기준이다. 0원 줄은 '확인 불필요' 로 나가 누를 버튼이 없다. */
  const money = settlement.lines.filter((l) => l.amount !== 0);
  for (const l of money) svc.respondToSettlement(link.token, l.seq, 'agreed');

  const after = svc.read(settlement.id);
  assert.equal(after.agreement.tenantAgreed, money.length);
  assert.equal(after.agreement.bothAgreedAll, true, '0원 줄 때문에 막히면 안 된다');
  assert.equal(after.status, 'agreed');
});

test('0원 줄 때문에 제출이 막히지 않는다', () => {
  const { contractId, settlement } = makeIssued();
  const link = svc.sendSettlementLink(contractId);

  const money = settlement.lines.filter((l) => l.amount !== 0);
  const zero = settlement.lines.filter((l) => l.amount === 0);
  assert.ok(zero.length > 0, '0원 줄이 있어야 의미 있는 검증이다');

  /* 임차인은 금액이 있는 줄만 누른다 — 0원 줄에는 화면에 버튼 자체가 없다 */
  for (const l of money) svc.respondToSettlement(link.token, l.seq, 'agreed');

  assert.doesNotThrow(() => svc.submitSettlementResponse(link.token),
    '확인 불필요한 줄이 남아 있다고 제출을 막으면 임차인이 손쓸 방법이 없다');
});

test('임차인 화면은 확인이 필요한 줄 수만 센다', () => {
  const { contractId, settlement } = makeIssued();
  const link = svc.sendSettlementLink(contractId);
  const view = svc.readShareContext(link.token).settlement;

  assert.equal(view.answerable, settlement.lines.filter((l) => l.amount !== 0).length);
  assert.ok(view.answerable < view.lines.length, '0원 줄은 보여 주되 세지는 않는다');
  assert.equal(view.answered, 0);
});

test('이의는 사유 없이 넣을 수 없다', () => {
  const { contractId } = makeIssued();
  const link = svc.sendSettlementLink(contractId);

  assert.throws(() => svc.respondToSettlement(link.token, 1, 'disputed', '  '), /사유를 적어/);
  assert.throws(() => svc.respondToSettlement(link.token, 1, 'disputed'), /사유를 적어/);
});

test('이의가 하나라도 있으면 확정할 수 없다', () => {
  const { contractId, settlement } = makeIssued();
  const link = svc.sendSettlementLink(contractId);

  for (const l of settlement.lines) svc.respondToSettlement(link.token, l.seq, 'agreed');
  svc.respondToSettlement(link.token, settlement.lines[0].seq, 'disputed', '금액이 다릅니다');

  const after = svc.read(settlement.id);
  assert.equal(after.status, 'draft', '동의였다가 이의로 바뀌면 되돌아간다');
  assert.throws(() => svc.seal(settlement.id), /모든 항목에 양측이 동의/);
});

/* ── 제출 ──────────────────────────────────────────────────── */

test('확인하지 않은 항목이 남으면 제출할 수 없다', () => {
  const { contractId, settlement } = makeIssued();
  const link = svc.sendSettlementLink(contractId);
  svc.respondToSettlement(link.token, settlement.lines[0].seq, 'agreed');

  assert.throws(() => svc.submitSettlementResponse(link.token), /확인하지 않은 항목/);
});

test('제출하면 링크가 닫히고 더 고칠 수 없다', () => {
  const { contractId, settlement } = makeIssued();
  const link = svc.sendSettlementLink(contractId);
  const money = settlement.lines.filter((l) => l.amount !== 0);
  for (const l of money) svc.respondToSettlement(link.token, l.seq, 'agreed');

  const res = svc.submitSettlementResponse(link.token);
  assert.equal(res.agreed, money.length);

  assert.throws(() => svc.submitSettlementResponse(link.token), /이미 제출/);
  assert.throws(() => svc.respondToSettlement(link.token, 1, 'disputed', '늦었다'), /이미 제출/);
});

test('확정된 정산서에는 응답할 수 없다', () => {
  const { contractId, settlement } = makeIssued();
  const link = svc.sendSettlementLink(contractId);
  for (const l of settlement.lines.filter((x) => x.amount !== 0))
    svc.respondToSettlement(link.token, l.seq, 'agreed');
  svc.seal(settlement.id);

  assert.throws(() => svc.respondToSettlement(link.token, 1, 'disputed', '뒤늦게'),
    /확정된 정산서는 수정할 수 없습니다/);
  assert.throws(() => svc.sendSettlementLink(contractId), /이미 확정된 정산서/);
});

/* ── 확정 후 집 상태 ───────────────────────────────────────── */

/** 금액이 있는 줄에 임차인 동의를 채워 확정까지 간다 */
function sealIt(contractId, settlement) {
  const link = svc.sendSettlementLink(contractId);
  for (const l of settlement.lines.filter((x) => x.amount !== 0))
    svc.respondToSettlement(link.token, l.seq, 'agreed');
  svc.seal(settlement.id);
}

test('정산을 확정하면 집이 공실로 돌아온다', () => {
  const { contractId, settlement } = makeIssued();
  const unitId = db.prepare(`SELECT unit_id FROM contracts WHERE id = ?`).get(contractId).unit_id;
  db.prepare(`UPDATE units SET vacancy_status = 'closing' WHERE id = ?`).run(unitId);

  sealIt(contractId, settlement);

  /* 상태 전이가 contracting → occupied → closing 까지만 있고 돌아오는 길이 없어서,
     확정한 집이 영영 '퇴거 진행 중' 으로 남아 공실로 세어지지도 않았다. */
  assert.equal(db.prepare(`SELECT vacancy_status v FROM units WHERE id = ?`).get(unitId).v,
    'vacant');
  assert.equal(db.prepare(`SELECT status FROM contracts WHERE id = ?`).get(contractId).status,
    'closed');
});

test('다음 임차인 계약이 이미 있으면 공실로 되돌리지 않는다', () => {
  const { contractId, settlement } = makeIssued();
  const unitId = db.prepare(`SELECT unit_id FROM contracts WHERE id = ?`).get(contractId).unit_id;

  /* 이전 계약의 정산이 늦게 확정되는 사이 새 임차인이 들어온 경우 */
  db.prepare(`
    INSERT INTO contracts (unit_id, landlord_id, landlord_name, tenant_name, deposit,
                           move_in_date, term_months, expires_on, status)
    VALUES (?, ?, '김성호', '다음임차인', 100000000, '2024-07-01', 24, '2026-06-30', 'active')`)
    .run(unitId, landlordId);
  db.prepare(`UPDATE units SET vacancy_status = 'occupied' WHERE id = ?`).run(unitId);

  sealIt(contractId, settlement);

  assert.equal(db.prepare(`SELECT vacancy_status v FROM units WHERE id = ?`).get(unitId).v,
    'occupied', '거주 중인 집을 공실로 되돌리면 안 된다');
});

/* ── 임대인 현황 ───────────────────────────────────────────── */

test('임대인은 링크 상태로 임차인이 어디까지 왔는지 본다', () => {
  const { contractId, settlement } = makeIssued();
  assert.equal(svc.settlementShareState(contractId), null, '보내기 전에는 없다');

  const link = svc.sendSettlementLink(contractId);
  let state = svc.settlementShareState(contractId);
  assert.equal(state.token, link.token);
  assert.equal(state.firstOpenedAt, null);
  assert.equal(state.completedAt, null);

  svc.readShareContext(link.token);                 // 임차인이 열어 봄
  state = svc.settlementShareState(contractId);
  assert.ok(state.firstOpenedAt, '열람 시각이 기록된다');
  assert.equal(state.completedAt, null);

  for (const l of settlement.lines) svc.respondToSettlement(link.token, l.seq, 'agreed');
  svc.submitSettlementResponse(link.token);
  assert.ok(svc.settlementShareState(contractId).completedAt, '제출 시각이 기록된다');
});
