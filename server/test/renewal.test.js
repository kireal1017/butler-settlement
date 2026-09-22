import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* db.js 는 import 시점에 DB_PATH 를 읽는다. 임시 DB 를 먼저 지정하고 동적 import 한다. */
const DB_PATH = path.join(os.tmpdir(), `butler-renewal-test-${process.pid}.db`);
fs.rmSync(DB_PATH, { force: true });
process.env.DB_PATH = DB_PATH;

const { db, migrate } = await import('../src/db.js');
const svc = await import('../src/service.js');
const repo = await import('../src/repository.js');
const tasks = await import('../src/services/tasks.js');
const timeline = await import('../src/services/timeline.js');

migrate();

const RULES = {
  ltrfBurden: 'landlord', prorateEdgeMonths: 1, minorRepairThreshold: 100000,
  wallpaperGraceMonths: 24, flooringGraceMonths: 24, lateInterestRate: 5,
  tenantPaidAdvanceFee: 1, advanceFeeAmount: 550000,
  items: [{
    category: 'wallpaper', label: '전체 도배', usefulLifeYears: 6,
    lastRenewedOn: '2024-09-30', replacementCost: 2600000, graceApplicable: true,
  }],
};

const landlordId = db.prepare(`INSERT INTO landlords (name) VALUES ('김성호')`).run().lastInsertRowid;
const complexId = db.prepare(
  `INSERT INTO complexes (kapt_code, name, address) VALUES ('A1', '테스트 아파트', '서울시')`
).run().lastInsertRowid;

let ho = 200;

/** 거주 중(active) 계약 하나. 입주 2024-10-01, 만료 2026-09-30 (24개월). */
function makeActiveContract({ status = 'active', expiresOn = '2026-09-30' } = {}) {
  ho += 1;
  const unitId = db.prepare(`
    INSERT INTO units (complex_id, dong, ho, exclusive_area, landlord_id, vacancy_status)
    VALUES (?, '101동', ?, 84.95, ?, 'occupied')`
  ).run(complexId, `${ho}호`, landlordId).lastInsertRowid;

  const contractId = db.prepare(`
    INSERT INTO contracts (unit_id, landlord_id, landlord_name, tenant_name, tenant_phone,
                           deposit, monthly_rent, move_in_date, term_months, expires_on, status)
    VALUES (?, ?, '김성호', '한서윤', '010-0000-0000', 300000000, 0,
            '2024-10-01', 24, ?, ?)`
  ).run(unitId, landlordId, expiresOn, status).lastInsertRowid;

  svc.saveRuleSet(contractId, RULES);
  return { contractId, unitId };
}

const rejects = (fn, status) => {
  try { fn(); assert.fail('오류가 발생해야 한다'); }
  catch (e) { assert.equal(e.status, status, `status ${status} 여야 하는데 ${e.status}: ${e.message}`); }
};

/* ── 기간 계산 ─────────────────────────────────────────────── */

test('갱신 기간은 만료일 다음 날부터 시작한다', () => {
  const { contractId } = makeActiveContract();
  const res = svc.renewContract(contractId, { termMonths: 24 });

  assert.equal(res.renewedFrom, '2026-10-01', '만료 2026-09-30 의 다음 날');
  assert.equal(res.expiresOn, '2028-09-30', '24개월 뒤 하루 전');
  assert.equal(res.contract.expires_on, '2028-09-30');
});

test('갱신 기간은 12 · 36개월도 된다', () => {
  const a = makeActiveContract();
  assert.equal(svc.renewContract(a.contractId, { termMonths: 12 }).expiresOn, '2027-09-30');

  const b = makeActiveContract();
  assert.equal(svc.renewContract(b.contractId, { termMonths: 36 }).expiresOn, '2029-09-30');
});

test('기간을 주지 않으면 이전 계약과 같은 기간을 쓴다', () => {
  const { contractId } = makeActiveContract();
  const res = svc.renewContract(contractId);
  assert.equal(res.contract.term_months, 24);
  assert.equal(res.expiresOn, '2028-09-30');
});

test('말일 보정 — 2월 만료도 날짜가 밀리지 않는다', () => {
  const { contractId } = makeActiveContract({ expiresOn: '2027-02-28' });
  const res = svc.renewContract(contractId, { termMonths: 12 });

  assert.equal(res.renewedFrom, '2027-03-01');
  assert.equal(res.expiresOn, '2028-02-29', '2028년은 윤년이다');
});

test('잘못된 기간은 거절한다', () => {
  const { contractId } = makeActiveContract();
  rejects(() => svc.renewContract(contractId, { termMonths: 0 }), 400);
});

/* ── 입주일 승계 — 장충금이 이어져야 한다 ──────────────────── */

test('입주일은 최초 입주일을 그대로 가져온다', () => {
  const { contractId } = makeActiveContract();
  const res = svc.renewContract(contractId, { termMonths: 24 });

  /* 여기서 입주일을 새로 잡으면 엔진(ltrf.js)이 갱신 이전에 대납한 장기수선충당금을
     통째로 빼먹는다. V2-SPEC §10 체크리스트 항목. */
  assert.equal(res.contract.move_in_date, '2024-10-01');
});

test('갱신하면 장충금 누적 구간이 연장된 기간만큼 늘어난다', () => {
  const { contractId } = makeActiveContract();
  const before = repo.getContract(contractId);
  const beforeMonths = monthsBetween(before.move_in_date, before.expires_on);

  const res = svc.renewContract(contractId, { termMonths: 24 });
  const afterMonths = monthsBetween(res.contract.move_in_date, res.contract.expires_on);

  assert.equal(afterMonths - beforeMonths, 24);
});

function monthsBetween(fromIso, toIso) {
  const [fy, fm] = fromIso.split('-').map(Number);
  const [ty, tm] = toIso.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/* ── Rule Lock 승계 ────────────────────────────────────────── */

test('규칙과 품목이 그대로 승계된다', () => {
  const { contractId } = makeActiveContract();
  const res = svc.renewContract(contractId, { termMonths: 24 });

  const inherited = repo.getRuleSet(res.contract.id);
  assert.equal(inherited.version, 1, '갱신 계약의 규칙은 v1 에서 다시 시작한다');
  assert.equal(inherited.advance_fee_amount, 550000);
  assert.equal(inherited.wallpaper_grace_months, 24);

  const items = repo.getRuleItems(inherited.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].last_renewed_on, '2024-09-30', '교체한 적이 없으면 시공일도 그대로다');
  assert.equal(items[0].replacement_cost, 2600000);
});

test('승계된 규칙은 아직 잠겨 있지 않다 — 보내기 전에 고칠 수 있다', () => {
  const { contractId } = makeActiveContract();
  const res = svc.renewContract(contractId, { termMonths: 24 });

  const inherited = repo.getRuleSet(res.contract.id);
  assert.equal(inherited.locked_by_landlord_at, null);
  assert.equal(inherited.locked_by_tenant_at, null);
});

test('원본 계약의 규칙은 건드리지 않는다', () => {
  const { contractId } = makeActiveContract();
  const originalId = repo.getRuleSet(contractId).id;
  svc.renewContract(contractId, { termMonths: 24 });

  assert.equal(repo.getRuleSet(contractId).id, originalId);
  assert.equal(repo.getRuleSet(contractId).version, 1);
});

/* ── 체인과 상태 ───────────────────────────────────────────── */

test('갱신 계약은 draft 로 시작하고 parent 로 연결된다', () => {
  const { contractId } = makeActiveContract();
  const res = svc.renewContract(contractId, { termMonths: 24 });

  assert.equal(res.contract.status, 'draft', '임차인 동의 전에는 성립하지 않는다');
  assert.equal(res.contract.parent_contract_id, contractId);
  assert.equal(repo.getContract(contractId).status, 'renewing');
  assert.equal(repo.getContract(contractId).renewal_decision, 'renew');
});

test('임차인 · 집 · 임대인은 그대로 따라온다', () => {
  const { contractId, unitId } = makeActiveContract();
  const res = svc.renewContract(contractId, { termMonths: 24 });

  assert.equal(res.contract.unit_id, unitId);
  assert.equal(res.contract.tenant_name, '한서윤');
  assert.equal(res.contract.tenant_phone, '010-0000-0000');
  assert.equal(res.contract.landlord_name, '김성호');
});

test('보증금 · 월세를 올려 갱신할 수 있다', () => {
  const { contractId } = makeActiveContract();
  const res = svc.renewContract(contractId, { termMonths: 24, deposit: 330000000, monthlyRent: 200000 });

  assert.equal(res.contract.deposit, 330000000);
  assert.equal(res.contract.monthly_rent, 200000);
  assert.equal(repo.getContract(contractId).deposit, 300000000, '이전 계약은 그대로다');
});

test('renewalChain 이 양쪽에서 체인을 복원한다', () => {
  const { contractId } = makeActiveContract();
  const res = svc.renewContract(contractId, { termMonths: 24 });

  const parent = svc.renewalChain(repo.getContract(contractId));
  assert.equal(parent.childId, res.contract.id);
  assert.equal(parent.decision, 'renew');
  assert.equal(parent.parentId, null);

  const child = svc.renewalChain(repo.getContract(res.contract.id));
  assert.equal(child.parentId, contractId);
  assert.equal(child.renewedFrom, '2026-10-01', '저장하지 않고 부모 만료일에서 계산한다');
  assert.equal(child.childId, null);
});

/* ── 가드 ──────────────────────────────────────────────────── */

test('거주 중인 계약만 갱신할 수 있다', () => {
  const { contractId } = makeActiveContract({ status: 'draft' });
  rejects(() => svc.renewContract(contractId), 409);
});

test('두 번 갱신할 수 없다', () => {
  const { contractId } = makeActiveContract();
  svc.renewContract(contractId, { termMonths: 24 });
  rejects(() => svc.renewContract(contractId, { termMonths: 24 }), 409);
});

test('없는 계약은 404', () => {
  rejects(() => svc.renewContract(999999), 404);
});

/* ── 임차인 동의로 성립 ────────────────────────────────────── */

test('임차인이 동의하면 갱신 계약이 성립하고 이전 계약이 닫힌다', () => {
  const { contractId, unitId } = makeActiveContract();
  const res = svc.renewContract(contractId, { termMonths: 24 });
  const childId = res.contract.id;

  const ruleSet = repo.getRuleSet(childId);
  db.prepare(`UPDATE rule_sets SET locked_by_landlord_at = datetime('now') WHERE id = ?`).run(ruleSet.id);
  const { token } = svc.sendContractLink(childId);

  /* 발송 중에도 집은 거주 중이다 — 임차인이 이미 살고 있다 */
  assert.equal(repo.getUnit(unitId).vacancyStatus, 'occupied');

  svc.respondToContract(token, 'accepted', null);

  assert.equal(repo.getContract(childId).status, 'active');
  assert.equal(repo.getContract(contractId).status, 'closed', '이전 계약은 정산 없이 닫힌다');
  assert.equal(repo.getUnit(unitId).vacancyStatus, 'occupied');
  assert.ok(repo.getRuleSet(childId).locked_by_tenant_at);
});

test('임차인이 거부하면 이전 계약은 그대로 살아 있다', () => {
  const { contractId } = makeActiveContract();
  const res = svc.renewContract(contractId, { termMonths: 24 });
  const childId = res.contract.id;

  const ruleSet = repo.getRuleSet(childId);
  db.prepare(`UPDATE rule_sets SET locked_by_landlord_at = datetime('now') WHERE id = ?`).run(ruleSet.id);
  const { token } = svc.sendContractLink(childId);
  svc.respondToContract(token, 'rejected', '보증금 인상은 어렵습니다');

  assert.equal(repo.getContract(childId).status, 'rejected');
  assert.equal(repo.getContract(contractId).status, 'renewing', '이전 계약을 닫으면 안 된다');
});

/* ── 갱신하지 않음 ─────────────────────────────────────────── */

test('갱신하지 않기로 하면 기록만 남고 계약은 계속된다', () => {
  const { contractId } = makeActiveContract();
  const out = svc.declineRenewal(contractId);

  assert.equal(out.renewal_decision, 'decline');
  assert.equal(out.status, 'active', '만료일까지는 거주가 계속된다');
});

test('갱신 계약을 이미 만들었으면 갱신하지 않음을 고를 수 없다', () => {
  const { contractId } = makeActiveContract();
  svc.renewContract(contractId, { termMonths: 24 });
  rejects(() => svc.declineRenewal(contractId), 409);
});

/* ── 할 일과의 연결 ────────────────────────────────────────── */

test('갱신을 결정하면 갱신 할 일이 사라진다', () => {
  /* 만료가 6개월 안으로 들어온 계약을 따로 만든다 (오늘 기준 상대 날짜) */
  const today = timeline.toIso(timeline.startOfToday());
  const { contractId } = makeActiveContract({ expiresOn: timeline.shiftIso(today, 150) });

  const kinds = () => tasks.refreshTasks(landlordId)
    .filter((t) => t.contractId === contractId).map((t) => t.kind);
  assert.deepEqual(kinds(), ['renewal_decision']);

  svc.declineRenewal(contractId);
  assert.deepEqual(kinds(), [], '결정했으면 더 묻지 않는다');
});

test.after(() => {
  db.close();
  fs.rmSync(DB_PATH, { force: true });
  fs.rmSync(`${DB_PATH}-shm`, { force: true });
  fs.rmSync(`${DB_PATH}-wal`, { force: true });
});
