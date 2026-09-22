import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* db.js 는 import 시점에 DB_PATH 를 읽는다. 임시 DB 를 먼저 지정하고 동적 import 한다. */
const DB_PATH = path.join(os.tmpdir(), `butler-tasks-test-${process.pid}.db`);
fs.rmSync(DB_PATH, { force: true });
process.env.DB_PATH = DB_PATH;

const { db, migrate } = await import('../src/db.js');
const tasks = await import('../src/services/tasks.js');
const { shiftIso, toIso, startOfToday } = await import('../src/services/timeline.js');

migrate();

const TODAY = startOfToday();
const today = toIso(TODAY);
/** 오늘로부터 n일 뒤 (음수면 과거) */
const rel = (n) => shiftIso(today, n);

const landlordId = db.prepare(`INSERT INTO landlords (name) VALUES ('김성호')`).run().lastInsertRowid;
const complexId = db.prepare(
  `INSERT INTO complexes (kapt_code, name, address) VALUES ('A1', '테스트 아파트', '서울시')`
).run().lastInsertRowid;

let ho = 100;

/** 집 하나. ownershipStatus 기본값은 verified — 소유 검증 할 일이 섞이지 않게 한다. */
function makeUnit(ownershipStatus = 'verified') {
  ho += 1;
  return db.prepare(`
    INSERT INTO units (complex_id, dong, ho, exclusive_area, landlord_id, ownership_status)
    VALUES (?, '101동', ?, 84.95, ?, ?)`
  ).run(complexId, `${ho}호`, landlordId, ownershipStatus).lastInsertRowid;
}

/** 계약 하나. expiresOn / moveOutDate 는 오늘 기준 상대 날짜로 넣는다. */
function makeContract({ status, expiresOn = null, moveOutDate = null, renewalDecision = null,
                        tenantName = '임차인', unitId = makeUnit() } = {}) {
  const id = db.prepare(`
    INSERT INTO contracts (unit_id, landlord_id, landlord_name, tenant_name, deposit,
                           move_in_date, term_months, expires_on, move_out_date,
                           renewal_decision, status)
    VALUES (?, ?, '김성호', ?, 300000000, ?, 24, ?, ?, ?, ?)`
  ).run(unitId, landlordId, tenantName, rel(-400), expiresOn, moveOutDate, renewalDecision, status)
    .lastInsertRowid;
  return { id, unitId };
}

/** 이 계약에 붙은 할 일만 골라낸다 */
const forContract = (contractId, list) => list.filter((t) => t.contractId === contractId);
const kinds = (list) => list.map((t) => t.kind);

/* ── 갱신 ──────────────────────────────────────────────────── */

test('만료 6개월 전부터 갱신 판단 할 일이 뜬다', () => {
  const c = makeContract({ status: 'active', expiresOn: rel(150) });
  const mine = forContract(c.id, tasks.refreshTasks(landlordId));

  assert.deepEqual(kinds(mine), ['renewal_decision']);
  assert.equal(mine[0].severity, 'info');
  assert.equal(mine[0].dueOn, rel(90), '기한은 만료 60일 전이어야 한다');
  assert.equal(mine[0].daysLeft, 90);
});

test('만료 6개월보다 멀면 아직 뜨지 않는다', () => {
  const c = makeContract({ status: 'active', expiresOn: rel(400) });
  assert.deepEqual(kinds(forContract(c.id, tasks.refreshTasks(landlordId))), []);
});

test('갱신을 결정했으면 뜨지 않는다', () => {
  const c = makeContract({ status: 'active', expiresOn: rel(150), renewalDecision: 'renew' });
  assert.deepEqual(kinds(forContract(c.id, tasks.refreshTasks(landlordId))), []);
});

test('통지 기한이 지나면 urgent 로 바뀌고 묵시적 갱신을 알린다', () => {
  const c = makeContract({ status: 'active', expiresOn: rel(30) });
  const mine = forContract(c.id, tasks.refreshTasks(landlordId));

  assert.deepEqual(kinds(mine), ['renewal_deadline'], '갱신 할 일이 두 개 뜨면 안 된다');
  assert.equal(mine[0].severity, 'urgent');
  assert.match(mine[0].title, /묵시적 갱신/);
});

test('통지 기한 당일에는 아직 묵시적 갱신이 아니다', () => {
  const c = makeContract({ status: 'active', expiresOn: rel(60) });
  const mine = forContract(c.id, tasks.refreshTasks(landlordId));

  assert.deepEqual(kinds(mine), ['renewal_deadline']);
  assert.match(mine[0].title, /오늘이 갱신거절 통지 기한/);
});

/* ── 퇴거 · 정산 ───────────────────────────────────────────── */

test('퇴거 진행 중인데 퇴거일이 없으면 먼저 그것을 요구한다', () => {
  const c = makeContract({ status: 'closing', expiresOn: rel(500) });
  const mine = forContract(c.id, tasks.refreshTasks(landlordId));

  assert.deepEqual(kinds(mine), ['settlement_issue']);
  assert.match(mine[0].title, /퇴거 예정일/);
});

test('퇴거 30일 전이고 정산서가 없으면 발행 할 일이 뜬다', () => {
  const c = makeContract({ status: 'closing', expiresOn: rel(500), moveOutDate: rel(20) });
  const mine = forContract(c.id, tasks.refreshTasks(landlordId));

  assert.deepEqual(kinds(mine), ['settlement_issue']);
  assert.equal(mine[0].severity, 'warn');
  assert.match(mine[0].body, /20일/);
});

test('퇴거가 30일보다 멀면 아직 뜨지 않는다', () => {
  const c = makeContract({ status: 'closing', expiresOn: rel(500), moveOutDate: rel(45) });
  assert.deepEqual(kinds(forContract(c.id, tasks.refreshTasks(landlordId))), []);
});

/** 정산서 + 미합의 항목 하나를 만든다 */
function makeSettlement(contractId, status = 'draft', lineAgreed = false) {
  const ruleSetId = db.prepare(`
    INSERT INTO rule_sets (contract_id, version) VALUES (?, 1)`).run(contractId).lastInsertRowid;
  const id = db.prepare(`
    INSERT INTO settlements (contract_id, rule_set_id, status) VALUES (?, ?, ?)`
  ).run(contractId, ruleSetId, status).lastInsertRowid;
  db.prepare(`
    INSERT INTO settlement_lines (settlement_id, seq, kind, label, direction, amount, basis_json,
                                  landlord_status, tenant_status)
    VALUES (?, 1, 'ltrf', '장기수선충당금', 'tenant_credit', 100000, '{}', ?, ?)`
  ).run(id, lineAgreed ? 'agreed' : 'pending', lineAgreed ? 'agreed' : 'pending');
  return id;
}

test('퇴거 7일 전 미합의 항목이 남아 있으면 합의 마감 할 일이 뜬다', () => {
  const c = makeContract({ status: 'closing', expiresOn: rel(500), moveOutDate: rel(5) });
  makeSettlement(c.id);
  const mine = forContract(c.id, tasks.refreshTasks(landlordId));

  assert.deepEqual(kinds(mine), ['agreement_due'], '정산서가 있으면 발행 할 일은 사라진다');
  assert.equal(mine[0].severity, 'warn');
  assert.match(mine[0].title, /미합의 1건/);
});

test('전원 동의했으면 합의 마감 할 일이 뜨지 않는다', () => {
  const c = makeContract({ status: 'closing', expiresOn: rel(500), moveOutDate: rel(5) });
  makeSettlement(c.id, 'draft', true);
  assert.deepEqual(kinds(forContract(c.id, tasks.refreshTasks(landlordId))), []);
});

/* ── 임차인 대기 · 수선 ────────────────────────────────────── */

test('링크를 보낸 뒤 3일 무응답이면 임차인 대기 할 일이 뜬다', () => {
  const c = makeContract({ status: 'pending_tenant', expiresOn: rel(500), tenantName: '정하늘' });
  db.prepare(`
    INSERT INTO share_links (token, contract_id, purpose, created_at)
    VALUES (?, ?, 'contract_review', ?)`).run(`tok-${c.id}`, c.id, `${rel(-4)} 09:00:00`);

  const mine = forContract(c.id, tasks.refreshTasks(landlordId));
  assert.deepEqual(kinds(mine), ['tenant_pending']);
  assert.match(mine[0].title, /4일째/);
});

test('보낸 지 이틀밖에 안 됐으면 기다린다', () => {
  const c = makeContract({ status: 'pending_tenant', expiresOn: rel(500) });
  db.prepare(`
    INSERT INTO share_links (token, contract_id, purpose, created_at)
    VALUES (?, ?, 'contract_review', ?)`).run(`tok2-${c.id}`, c.id, `${rel(-2)} 09:00:00`);

  assert.deepEqual(kinds(forContract(c.id, tasks.refreshTasks(landlordId))), []);
});

test('수선 신고가 2일 넘게 열려 있으면 할 일이 뜬다', () => {
  const c = makeContract({ status: 'active', expiresOn: rel(500) });
  db.prepare(`
    INSERT INTO repair_requests (contract_id, description, reported_at, status)
    VALUES (?, '보일러 온수가 안 나옵니다', ?, 'open')`).run(c.id, `${rel(-3)} 20:00:00`);

  const mine = forContract(c.id, tasks.refreshTasks(landlordId));
  assert.deepEqual(kinds(mine), ['repair_open']);
  assert.match(mine[0].title, /수선 신고 1건/);
});

test('처리된 수선 신고는 세지 않는다', () => {
  const c = makeContract({ status: 'active', expiresOn: rel(500) });
  db.prepare(`
    INSERT INTO repair_requests (contract_id, description, reported_at, status)
    VALUES (?, '처리 완료', ?, 'done')`).run(c.id, `${rel(-9)} 20:00:00`);

  assert.deepEqual(kinds(forContract(c.id, tasks.refreshTasks(landlordId))), []);
});

/* ── 소유 검증 ─────────────────────────────────────────────── */

test('등기부가 확인되지 않은 집은 계약과 무관하게 뜬다', () => {
  const unitId = makeUnit('unverified');
  const mine = tasks.refreshTasks(landlordId)
    .filter((t) => t.unitId === unitId && t.contractId === null);

  assert.deepEqual(kinds(mine), ['ownership_unverified']);
  assert.match(mine[0].body, /올리지 않았습니다/);
});

test('소유자 이름이 다르면 그 이유가 그대로 보인다', () => {
  const unitId = makeUnit('name_mismatch');
  const mine = tasks.refreshTasks(landlordId)
    .filter((t) => t.unitId === unitId && t.contractId === null);

  assert.match(mine[0].body, /소유자 이름이 임대인과 다릅니다/);
});

/* ── 반영 규칙 ─────────────────────────────────────────────── */

test('여러 번 불러도 같은 결과다 — 중복 생성되지 않는다', () => {
  const c = makeContract({ status: 'active', expiresOn: rel(150) });
  tasks.refreshTasks(landlordId);
  const first = forContract(c.id, tasks.refreshTasks(landlordId));
  const second = forContract(c.id, tasks.refreshTasks(landlordId));

  assert.equal(first.length, 1);
  assert.deepEqual(first.map((t) => t.id), second.map((t) => t.id), 'id 가 유지되어야 한다');
});

test('조건이 사라지면 할 일도 사라진다', () => {
  const c = makeContract({ status: 'active', expiresOn: rel(150) });
  assert.equal(forContract(c.id, tasks.refreshTasks(landlordId)).length, 1);

  db.prepare(`UPDATE contracts SET renewal_decision = 'renew' WHERE id = ?`).run(c.id);
  assert.deepEqual(kinds(forContract(c.id, tasks.refreshTasks(landlordId))), []);
});

test('조건이 다시 성립하면 다시 만들어진다 — done 으로 남겨 두면 유일 인덱스에 걸린다', () => {
  const c = makeContract({ status: 'active', expiresOn: rel(150) });
  tasks.refreshTasks(landlordId);

  db.prepare(`UPDATE contracts SET renewal_decision = 'renew' WHERE id = ?`).run(c.id);
  tasks.refreshTasks(landlordId);
  db.prepare(`UPDATE contracts SET renewal_decision = NULL WHERE id = ?`).run(c.id);

  assert.deepEqual(kinds(forContract(c.id, tasks.refreshTasks(landlordId))), ['renewal_decision']);
});

test('종료된 계약은 할 일을 만들지 않는다', () => {
  const c = makeContract({ status: 'closed', expiresOn: rel(30) });
  assert.deepEqual(kinds(forContract(c.id, tasks.refreshTasks(landlordId))), []);
});

test('급한 것이 위로 온다', () => {
  makeContract({ status: 'active', expiresOn: rel(30) });   // urgent
  makeContract({ status: 'active', expiresOn: rel(150) });  // info
  const list = tasks.refreshTasks(landlordId);

  const order = ['urgent', 'warn', 'info'];
  const seen = list.map((t) => order.indexOf(t.severity));
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), '심각도 순으로 정렬되어야 한다');
});

test('다른 임대인의 할 일은 섞이지 않는다', () => {
  const other = db.prepare(`INSERT INTO landlords (name) VALUES ('박지훈')`).run().lastInsertRowid;
  assert.deepEqual(tasks.refreshTasks(other), []);
  assert.ok(tasks.refreshTasks(landlordId).length > 0, '원래 임대인 할 일은 지워지지 않아야 한다');
});

test.after(() => {
  db.close();
  fs.rmSync(DB_PATH, { force: true });
  fs.rmSync(`${DB_PATH}-shm`, { force: true });
  fs.rmSync(`${DB_PATH}-wal`, { force: true });
});
