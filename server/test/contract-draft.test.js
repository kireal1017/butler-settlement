import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

/**
 * 발송 전 계약은 한 집에 하나뿐이다.
 *
 * 계약을 저장하면 `draft` 로 남지만 집은 아직 **공실**이다 — '계약 진행 중' 은 임차인에게
 * 보낸 뒤의 상태다. 그래서 집 화면의 '계약 작성' 버튼이 그대로 살아 있는데, 막지 않으면
 * 누를 때마다 작성 중 계약이 하나씩 쌓였다. 집은 공실인데 계약은 임차인 확인을
 * 기다리는 모순된 상태가 된다.
 *
 * 화면은 이 경우 기존 계약을 불러와 이어 쓴다(NewContract.vue). 그 규칙이 화면에만
 * 있으면 쉽게 깨지므로 라우터에서도 막는다.
 */
const DB_PATH = path.join(os.tmpdir(), `butler-draft-test-${process.pid}.db`);
fs.rmSync(DB_PATH, { force: true });
process.env.DB_PATH = DB_PATH;

const { db, migrate } = await import('../src/db.js');
const svc = await import('../src/service.js');
const repo = await import('../src/repository.js');
const api = (await import('../src/routes/api.js')).default;

migrate();

const app = express();
app.use(express.json());
app.use('/api', api);
app.use((err, _req, res, _next) =>
  res.status(err.status ?? 500).json({ error: err.message ?? '서버 오류' }));

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}/api`;

const call = async (method, p, body) => {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

const landlordId = db.prepare(`INSERT INTO landlords (name) VALUES ('버틀러')`).run().lastInsertRowid;
const complexId = db.prepare(
  `INSERT INTO complexes (kapt_code, name, address) VALUES ('A1', '테스트단지', '서울시')`
).run().lastInsertRowid;

let ho = 400;
const makeUnit = () => db.prepare(`
  INSERT INTO units (complex_id, dong, ho, exclusive_area, landlord_id)
  VALUES (?, '101동', ?, 84.95, ?)`).run(complexId, `${++ho}호`, landlordId).lastInsertRowid;

const draftBody = (unitId, over = {}) => ({
  unitId, landlordId,
  tenantName: '김서연', tenantPhone: '010-0000-0001',
  deposit: 200000000, monthlyRent: 500000,
  moveInDate: '2026-01-01', termMonths: 24, ...over,
});

/* ── 한 집에 작성 중 계약은 하나 ────────────────────────────── */

test('작성 중 계약이 있는 집에 새 계약을 또 만들지 않는다', async () => {
  const unitId = makeUnit();
  const first = await call('POST', '/contracts', draftBody(unitId));
  assert.equal(first.status, 201);

  const second = await call('POST', '/contracts', draftBody(unitId, { tenantName: '박준호' }));
  assert.equal(second.status, 409);
  assert.equal(second.body.contractId, first.body.id,
    '이어 쓸 계약이 무엇인지 알려 줘야 화면이 그리로 보낼 수 있다');

  assert.equal(
    db.prepare(`SELECT COUNT(*) n FROM contracts WHERE unit_id = ?`).get(unitId).n, 1);
});

test('작성 중 계약은 조건을 고쳐 이어 쓴다', async () => {
  const unitId = makeUnit();
  const { body: c } = await call('POST', '/contracts', draftBody(unitId));

  const patched = await call('PATCH', `/contracts/${c.id}`, {
    tenantName: '최유진', deposit: 250000000, termMonths: 12,
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.tenant_name, '최유진');
  assert.equal(patched.body.deposit, 250000000);
  assert.equal(patched.body.expires_on, '2026-12-31', '기간이 바뀌면 만료일도 다시 계산한다');

  assert.equal(
    db.prepare(`SELECT COUNT(*) n FROM contracts WHERE unit_id = ?`).get(unitId).n, 1);
});

test('규칙을 다시 저장해도 새 버전이 생기지 않는다', async () => {
  const unitId = makeUnit();
  const { body: c } = await call('POST', '/contracts', draftBody(unitId));

  const rules = { ltrfBurden: 'landlord', minorRepairThreshold: 100000, items: [] };
  await call('PUT', `/contracts/${c.id}/rules`, rules);
  await call('PUT', `/contracts/${c.id}/rules`, { ...rules, minorRepairThreshold: 200000 });

  const sets = db.prepare(`SELECT version FROM rule_sets WHERE contract_id = ?`).all(c.id);
  assert.equal(sets.length, 1, '아무도 보지 않은 규칙은 덮어써도 된다');
  assert.equal(repo.getRuleSet(c.id).minor_repair_threshold, 200000);
});

/* ── 막는 것은 '작성 중이 둘' 뿐이다 ────────────────────────── */

test('발송한 계약이 있으면 막지 않는다 — 작성 중이 아니기 때문이다', async () => {
  const unitId = makeUnit();
  const { body: c } = await call('POST', '/contracts', draftBody(unitId));
  await call('PUT', `/contracts/${c.id}/rules`, { ltrfBurden: 'landlord', items: [] });
  await call('POST', `/contracts/${c.id}/rules/lock`, { party: 'landlord' });
  await call('POST', `/contracts/${c.id}/send`);

  assert.equal(repo.getContract(c.id).status, 'pending_tenant');
  const next = await call('POST', '/contracts', draftBody(unitId, { tenantName: '오세훈' }));
  assert.equal(next.status, 201);
});

test('지난 계약이 끝난 집에는 새 계약을 만들 수 있다', async () => {
  const unitId = makeUnit();
  const { body: c } = await call('POST', '/contracts', draftBody(unitId));
  db.prepare(`UPDATE contracts SET status = 'closed' WHERE id = ?`).run(c.id);

  const next = await call('POST', '/contracts', draftBody(unitId, { tenantName: '윤하늘' }));
  assert.equal(next.status, 201);
  assert.notEqual(next.body.id, c.id);
});

test('갱신 계약은 이 규칙에 걸리지 않는다', async () => {
  const unitId = makeUnit();
  const { body: c } = await call('POST', '/contracts', draftBody(unitId));
  await call('PUT', `/contracts/${c.id}/rules`, { ltrfBurden: 'landlord', items: [] });
  db.prepare(`UPDATE contracts SET status = 'active' WHERE id = ?`).run(c.id);

  /* 갱신은 POST /contracts 를 거치지 않고 서비스가 직접 넣는다 */
  const child = svc.renewContract(c.id, { termMonths: 24 });
  assert.equal(child.contract.status, 'draft');
  assert.equal(child.contract.parent_contract_id, c.id);
  assert.equal(child.contract.move_in_date, '2026-01-01', '갱신은 최초 입주일을 유지한다');
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(DB_PATH, { force: true });
});
