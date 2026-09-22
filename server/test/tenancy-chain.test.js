import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 전 구간 시나리오를 실제 API 로 돌리다 잡힌 세 가지.
 *
 * 셋 다 "한 번의 계약" 만 보면 드러나지 않는다. 집 한 채가 2019년부터 여러 임차인을
 * 거치며 갱신까지 하는 흐름에서만 나왔다.
 */
const DB_PATH = path.join(os.tmpdir(), `butler-chain-test-${process.pid}.db`);
fs.rmSync(DB_PATH, { force: true });
process.env.DB_PATH = DB_PATH;

const { db, migrate } = await import('../src/db.js');
const svc = await import('../src/service.js');
const repo = await import('../src/repository.js');

migrate();

const landlordId = db.prepare(`INSERT INTO landlords (name) VALUES ('버틀러')`).run().lastInsertRowid;
const complexId = db.prepare(
  `INSERT INTO complexes (kapt_code, name, address) VALUES ('A1', '테스트단지', '서울시')`
).run().lastInsertRowid;

let ho = 300;
const makeUnit = () => db.prepare(`
  INSERT INTO units (complex_id, dong, ho, exclusive_area, landlord_id)
  VALUES (?, '101동', ?, 84.95, ?)`).run(complexId, `${++ho}호`, landlordId).lastInsertRowid;

const makeContract = (unitId, over = {}) => {
  const c = {
    tenantName: '김서연', deposit: 200000000, monthlyRent: 500000,
    moveInDate: '2021-02-01', termMonths: 24, expiresOn: '2023-01-31',
    status: 'active', parentId: null, ...over,
  };
  return db.prepare(`
    INSERT INTO contracts (unit_id, landlord_id, landlord_name, tenant_name, deposit,
                           monthly_rent, move_in_date, term_months, expires_on,
                           status, parent_contract_id)
    VALUES (?, ?, '버틀러', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(unitId, landlordId, c.tenantName, c.deposit, c.monthlyRent, c.moveInDate,
         c.termMonths, c.expiresOn, c.status, c.parentId).lastInsertRowid;
};

const addRepair = (unitId, contractId, over = {}) => db.prepare(`
  INSERT INTO repair_events (unit_id, contract_id, occurred_on, description, cost, paid_by, cause)
  VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
  unitId, contractId,
  over.occurredOn ?? '2021-11-20', over.description ?? '욕실 환풍기 교체',
  over.cost ?? 300000, over.paidBy ?? 'landlord', over.cause ?? 'wear',
).lastInsertRowid;

/* ── 1. 같은 구분의 다른 품목이 서로를 덮어쓰지 않는다 ──────────────────── */

test('같은 구분(appliance)의 인덕션과 에어컨이 둘 다 승계된다', () => {
  const unitId = makeUnit();
  const ins = db.prepare(`
    INSERT INTO unit_items (unit_id, category, label, useful_life_years,
                            last_renewed_on, replacement_cost)
    VALUES (?, ?, ?, ?, ?, ?)`);
  ins.run(unitId, 'appliance', '인덕션', 8, '2021-01-10', 480000);
  ins.run(unitId, 'appliance', '에어컨', 10, '2022-06-01', 1200000);
  ins.run(unitId, 'wallpaper', '거실·방 도배', 6, '2018-12-20', 1300000);

  const labels = repo.getUnitHistory(unitId).items.map((i) => i.label).sort();
  assert.deepEqual(labels, ['거실·방 도배', '에어컨', '인덕션'],
    '구분만으로 묶으면 나중에 시공한 에어컨이 인덕션을 지워 버린다');
});

test('같은 품목을 다시 시공하면 최종 시공일 하나로 합쳐진다', () => {
  const unitId = makeUnit();
  const ins = db.prepare(`
    INSERT INTO unit_items (unit_id, category, label, useful_life_years,
                            last_renewed_on, replacement_cost)
    VALUES (?, ?, ?, ?, ?, ?)`);
  ins.run(unitId, 'wallpaper', '거실·방 도배', 6, '2018-12-20', 1300000);
  ins.run(unitId, 'wallpaper', '거실·방 도배', 6, '2024-05-01', 1500000);

  const items = repo.getUnitHistory(unitId).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].lastRenewedOn, '2024-05-01');
  assert.equal(items[0].replacementCost, 1500000, '최신 시공 기록의 교체비용이 따라와야 한다');
});

/* ── 2. 갱신 체인 — 같은 임대차의 수선은 끊기지 않는다 ─────────────────── */

test('갱신 계약의 정산은 이전 기간의 수선까지 본다', () => {
  const unitId = makeUnit();
  const parent = makeContract(unitId, { status: 'closed' });
  const child = makeContract(unitId, {
    parentId: parent, status: 'closing', expiresOn: '2025-01-31',
  });

  addRepair(unitId, parent, { occurredOn: '2021-11-20', cost: 300000 });
  addRepair(unitId, child, { occurredOn: '2024-03-02', cost: 200000 });

  const chain = repo.contractChainIds(child);
  assert.deepEqual(chain, [child, parent]);

  const seen = repo.getRepairEventsInChain(child).map((r) => r.cost);
  assert.deepEqual(seen, [300000, 200000],
    '갱신 전 2년의 수선이 사라지면, 장충금은 4년치인데 수선만 2년치인 정산서가 된다');
});

test('공실 기간 수선(계약 없음)은 어느 임대차에도 들어가지 않는다', () => {
  const unitId = makeUnit();
  const c = makeContract(unitId);
  addRepair(unitId, null, { occurredOn: '2021-01-10', cost: 480000, description: '공실 중 인덕션 교체' });
  addRepair(unitId, c, { cost: 300000 });

  assert.deepEqual(repo.getRepairEventsInChain(c).map((r) => r.cost), [300000]);
  assert.equal(repo.getUnitHistory(unitId).repairs.length, 2, '집 이력에는 둘 다 남는다');
});

test('다른 집 계약의 수선은 섞이지 않는다', () => {
  const a = makeUnit(); const b = makeUnit();
  const ca = makeContract(a); const cb = makeContract(b);
  addRepair(a, ca, { cost: 111000 });
  addRepair(b, cb, { cost: 222000 });
  assert.deepEqual(repo.getRepairEventsInChain(ca).map((r) => r.cost), [111000]);
});

/* ── 3. 전 항목 0원인 정산서도 확정할 수 있다 ──────────────────────────── */

const ZERO_LINES = [
  { seq: 1, amount: 0, direction: 'tenant_credit', landlord_status: 'agreed', tenant_status: 'agreed' },
  { seq: 2, amount: 0, direction: 'landlord_deduct', landlord_status: 'agreed', tenant_status: 'agreed' },
];

test('금액이 있는 줄이 하나도 없으면 합의는 완료 상태다', () => {
  const st = svc.agreementState(ZERO_LINES);
  assert.equal(st.total, 0);
  assert.equal(st.bothAgreedAll, true,
    '공제도 반환도 없는 정산서가 확정되지 않으면 계약이 closing 에 영영 남는다');
});

test('금액 줄이 하나라도 대기 중이면 확정되지 않는다', () => {
  const st = svc.agreementState([
    ...ZERO_LINES,
    { seq: 3, amount: 65000, direction: 'landlord_deduct', landlord_status: 'agreed', tenant_status: 'pending' },
  ]);
  assert.equal(st.total, 1);
  assert.equal(st.bothAgreedAll, false);
});

test('이의가 걸린 줄이 있으면 확정되지 않는다', () => {
  const st = svc.agreementState([
    { seq: 1, amount: 900000, direction: 'landlord_deduct', landlord_status: 'agreed', tenant_status: 'disputed' },
  ]);
  assert.equal(st.bothAgreedAll, false);
  assert.deepEqual(st.disputedSeqs, [1]);
});

test('전 항목 0원인 정산서를 확정하면 집이 공실로 돌아온다', () => {
  const unitId = makeUnit();
  const contractId = makeContract(unitId, { status: 'closing' });
  db.prepare(`UPDATE units SET vacancy_status = 'closing' WHERE id = ?`).run(unitId);
  db.prepare(`UPDATE contracts SET move_out_date = '2025-01-31' WHERE id = ?`).run(contractId);

  svc.saveRuleSet(contractId, { items: [] });
  const ruleSetId = repo.getRuleSet(contractId).id;
  const sid = db.prepare(`
    INSERT INTO settlements (contract_id, rule_set_id, status, net_amount, deposit_return)
    VALUES (?, ?, 'draft', 0, 200000000)`).run(contractId, ruleSetId).lastInsertRowid;
  db.prepare(`
    INSERT INTO settlement_lines (settlement_id, seq, kind, label, direction, amount,
                                  basis_json, landlord_status, tenant_status)
    VALUES (?, 1, 'ltrf', '장기수선충당금 대납액 반환', 'tenant_credit', 0, '{}', 'agreed', 'agreed')`)
    .run(sid);

  const sealed = svc.seal(sid);
  assert.equal(sealed.status, 'sealed');
  assert.equal(repo.getContract(contractId).status, 'closed');
  assert.equal(db.prepare(`SELECT vacancy_status v FROM units WHERE id = ?`).get(unitId).v, 'vacant');
});

test.after(() => { db.close(); fs.rmSync(DB_PATH, { force: true }); });
