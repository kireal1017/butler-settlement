import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

/* db.js 는 import 시점에 DB_PATH 를 읽는다. 임시 DB 를 먼저 지정하고 동적 import 한다. */
const DB_PATH = path.join(os.tmpdir(), `butler-houselog-test-${process.pid}.db`);
fs.rmSync(DB_PATH, { force: true });
process.env.DB_PATH = DB_PATH;

const { db, migrate } = await import('../src/db.js');
const repo = await import('../src/repository.js');
const api = (await import('../src/routes/api.js')).default;

migrate();

/**
 * 여기서 검증하는 규칙은 전부 **라우터**에 있다 (입력 검증 · 상태 가드).
 * 서비스만 부르면 지나쳐 버리므로 앱을 임시 포트에 띄워 실제 요청을 보낸다.
 */
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

const landlordId = db.prepare(`INSERT INTO landlords (name) VALUES ('김성호')`).run().lastInsertRowid;
const complexId = db.prepare(
  `INSERT INTO complexes (kapt_code, name) VALUES ('A1', '테스트단지')`).run().lastInsertRowid;

let ho = 100;
const makeUnit = () => db.prepare(`
  INSERT INTO units (complex_id, dong, ho, exclusive_area, landlord_id)
  VALUES (?, '101동', ?, 84.95, ?)`).run(complexId, `${++ho}호`, landlordId).lastInsertRowid;

const makeContract = (unitId, status = 'active') => db.prepare(`
  INSERT INTO contracts (unit_id, landlord_id, landlord_name, tenant_name, deposit, monthly_rent,
                         move_in_date, term_months, expires_on, status)
  VALUES (?, ?, '김성호', '이지은', 100000000, 500000, '2024-01-01', 24, '2025-12-31', ?)`)
  .run(unitId, landlordId, status).lastInsertRowid;

const ITEM = {
  category: 'wallpaper', label: '전체 도배', usefulLifeYears: 6,
  lastRenewedOn: '2024-03-15', replacementCost: 1200000,
};
const REPAIR = {
  occurredOn: '2025-06-01', description: '보일러 순환펌프 교체',
  cost: 180000, paidBy: 'landlord', cause: 'landlord_duty',
};

/* ── 품목 시공 이력 ───────────────────────────────────────── */

test('계약이 없어도 집에 시공 이력을 적을 수 있다', async () => {
  const unitId = makeUnit();
  const res = await call('POST', `/units/${unitId}/items`, ITEM);

  assert.equal(res.status, 201);
  assert.deepEqual(res.body.items.map((i) => [i.category, i.lastRenewedOn, i.source]),
    [['wallpaper', '2024-03-15', 'unit']]);
});

test('시공 이력은 다음 계약 Rule Lock 이 읽는 items 에 그대로 들어간다', async () => {
  const unitId = makeUnit();
  await call('POST', `/units/${unitId}/items`, ITEM);

  const { body } = await call('GET', `/units/${unitId}`);
  const wallpaper = body.items.find((i) => i.category === 'wallpaper');
  assert.equal(wallpaper.lastRenewedOn, '2024-03-15');
  assert.equal(wallpaper.usefulLifeYears, 6);
  assert.equal(wallpaper.replacementCost, 1200000);
});

test('같은 품목을 다시 시공하면 더 최근 시공일이 이긴다', async () => {
  const unitId = makeUnit();
  await call('POST', `/units/${unitId}/items`, ITEM);
  await call('POST', `/units/${unitId}/items`, { ...ITEM, lastRenewedOn: '2025-08-01' });

  const { body } = await call('GET', `/units/${unitId}`);
  const wallpaper = body.items.filter((i) => i.category === 'wallpaper');
  assert.equal(wallpaper.length, 1, '같은 품목은 한 줄로 합쳐야 한다');
  assert.equal(wallpaper[0].lastRenewedOn, '2025-08-01');
});

/**
 * 묶는 기준은 구분이 아니라 **품목명**이다.
 *
 * 예전에는 구분만으로 묶었다. 그래서 같은 'appliance' 인 인덕션과 에어컨 중
 * 나중에 시공한 하나만 남고 나머지가 사라졌고, 사라진 품목은 다음 계약의
 * Rule Lock 에 오르지 못해 퇴거 때 파손돼도 계산 근거가 없었다.
 */
test('같은 구분이라도 품목이 다르면 둘 다 남는다', async () => {
  const unitId = makeUnit();
  await call('POST', `/units/${unitId}/items`,
    { ...ITEM, category: 'appliance', label: '인덕션', lastRenewedOn: '2021-01-10' });
  await call('POST', `/units/${unitId}/items`,
    { ...ITEM, category: 'appliance', label: '에어컨', lastRenewedOn: '2022-06-01' });

  const { body } = await call('GET', `/units/${unitId}`);
  assert.deepEqual(body.items.map((i) => i.label).sort(), ['에어컨', '인덕션']);
});

test('집에 적은 시공 이력만 지울 수 있게 id 를 따로 돌려준다', async () => {
  const unitId = makeUnit();
  const { body } = await call('POST', `/units/${unitId}/items`, ITEM);
  assert.equal(body.unitItems.length, 1);

  assert.equal((await call('DELETE', `/unit-items/${body.unitItems[0].id}`)).status, 204);
  assert.deepEqual((await call('GET', `/units/${unitId}`)).body.items, []);
});

test('모르는 구분과 잘못된 입력은 거절한다', async () => {
  const unitId = makeUnit();
  assert.equal((await call('POST', `/units/${unitId}/items`, { ...ITEM, category: 'door' })).status, 400);
  assert.equal((await call('POST', `/units/${unitId}/items`, { ...ITEM, lastRenewedOn: '2024/3/15' })).status, 400);
  assert.equal((await call('POST', `/units/${unitId}/items`, { ...ITEM, label: '   ' })).status, 400);
  assert.equal((await call('POST', `/units/${unitId}/items`, { ...ITEM, usefulLifeYears: 0 })).status, 400);
});

test('없는 집에는 적을 수 없다', async () => {
  assert.equal((await call('POST', '/units/99999/items', ITEM)).status, 404);
});

/* ── 수선 이력 ────────────────────────────────────────────── */

test('계약을 지정하지 않은 수선은 집 이력으로만 남고 정산에 들어가지 않는다', async () => {
  const unitId = makeUnit();
  const contractId = makeContract(unitId);
  const res = await call('POST', `/units/${unitId}/repairs`, REPAIR);

  assert.equal(res.status, 201);
  assert.equal(res.body.repairs[0].contractId, null);

  /* 엔진은 contract_id 로만 조회한다 — 공실 기간 수선이 누군가의 보증금에서 빠지면 안 된다 */
  assert.deepEqual(repo.getRepairEvents(contractId), []);
});

test('계약을 지정한 수선은 그 계약의 정산 입력이 된다', async () => {
  const unitId = makeUnit();
  const contractId = makeContract(unitId);
  await call('POST', `/units/${unitId}/repairs`, { ...REPAIR, contractId });

  const rows = repo.getRepairEvents(contractId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost, 180000);
});

test('다른 집 계약에는 수선을 붙일 수 없다', async () => {
  const otherContract = makeContract(makeUnit());
  const res = await call('POST', `/units/${makeUnit()}/repairs`,
    { ...REPAIR, contractId: otherContract });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /이 집의 계약이 아닙니다/);
});

test('부담 주체와 사유는 정해진 값만 받는다', async () => {
  const unitId = makeUnit();
  assert.equal((await call('POST', `/units/${unitId}/repairs`, { ...REPAIR, paidBy: 'agent' })).status, 400);
  assert.equal((await call('POST', `/units/${unitId}/repairs`, { ...REPAIR, cause: 'unknown' })).status, 400);
  assert.equal((await call('POST', `/units/${unitId}/repairs`, { ...REPAIR, description: ' ' })).status, 400);
});

test('확정된 정산서의 근거인 수선은 지울 수 없다', async () => {
  const unitId = makeUnit();
  const contractId = makeContract(unitId);
  const { body } = await call('POST', `/units/${unitId}/repairs`, { ...REPAIR, contractId });

  const ruleSetId = db.prepare(
    `INSERT INTO rule_sets (contract_id, version) VALUES (?, 1)`).run(contractId).lastInsertRowid;
  db.prepare(`
    INSERT INTO settlements (contract_id, rule_set_id, status, sealed_at)
    VALUES (?, ?, 'sealed', datetime('now','localtime'))`).run(contractId, ruleSetId);

  const res = await call('DELETE', `/repairs/${body.id}`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /확정된 정산서/);
});

/* ── 등기부 확인 완료 (사람이 고쳐 확정) ──────────────────── */

/** OCR 이 일부를 놓친 상태의 등기부 문서 한 건 */
function makeDocument(unitId, parsed) {
  return db.prepare(`
    INSERT INTO registry_documents (unit_id, file_path, ocr_provider, raw_text, parsed_json,
                                    match_result, confidence)
    VALUES (?, 'x.png', 'clova', '...', ?, 'parse_failed', 0.77)`)
    .run(unitId, JSON.stringify(parsed)).lastInsertRowid;
}

const PARTIAL = {
  address: '서울특별시 강남구 대치동 977 학여울청구아파트',
  dong: '118', floor: '7', ho: '715', uniqueNo: '1146-2011-004829',
  exclusiveArea: null, owners: [],
};

test('OCR 이 놓친 칸을 사람이 채워 확정하면 집이 소유 확인됨이 된다', async () => {
  const unitId = makeUnit();
  const documentId = makeDocument(unitId, PARTIAL);

  const res = await call('POST', `/registry-documents/${documentId}/confirm`,
    { ...PARTIAL, exclusiveArea: 19, ownerName: '버틀러' });

  assert.equal(res.status, 200);
  assert.equal(res.body.unit.ownershipStatus, 'verified');
  assert.equal(res.body.unit.registryOwnerName, '버틀러');
  assert.equal(res.body.unit.registryUniqueNo, '1146-2011-004829');
});

test('확정 판정은 matched 가 아니라 confirmed 로 남는다', async () => {
  const unitId = makeUnit();
  const documentId = makeDocument(unitId, PARTIAL);
  await call('POST', `/registry-documents/${documentId}/confirm`,
    { ...PARTIAL, exclusiveArea: 19, ownerName: '버틀러' });

  const doc = db.prepare(`SELECT match_result FROM registry_documents WHERE id = ?`).get(documentId);
  /* "OCR 이 대조해 일치했다" 와 "임대인이 보고 맞다고 했다" 는 근거가 다르다 */
  assert.equal(doc.match_result, 'confirmed');
});

test('손으로 고친 칸이 무엇인지 기록한다', async () => {
  const unitId = makeUnit();
  const documentId = makeDocument(unitId, PARTIAL);
  await call('POST', `/registry-documents/${documentId}/confirm`,
    { ...PARTIAL, ho: '716', exclusiveArea: 19, ownerName: '버틀러' });

  const saved = JSON.parse(
    db.prepare(`SELECT parsed_json FROM registry_documents WHERE id = ?`).get(documentId).parsed_json);

  assert.deepEqual(saved.editedFields.sort(), ['exclusiveArea', 'ho', 'owners']);
  assert.ok(saved.confirmedAt, '언제 확정했는지 남아야 한다');
  assert.equal(saved.address, PARTIAL.address, '고치지 않은 칸은 그대로다');
});

test('소유자를 비운 채로는 확정할 수 없다', async () => {
  const unitId = makeUnit();
  const documentId = makeDocument(unitId, PARTIAL);

  const res = await call('POST', `/registry-documents/${documentId}/confirm`,
    { ...PARTIAL, exclusiveArea: 19, ownerName: '   ' });

  assert.equal(res.status, 400);
  assert.equal(db.prepare(`SELECT ownership_status FROM units WHERE id = ?`).get(unitId).ownership_status,
    'unverified', '거절됐으면 집 상태도 그대로여야 한다');
});

test('없는 문서는 확정할 수 없다', async () => {
  assert.equal((await call('POST', '/registry-documents/99999/confirm', { ownerName: '버틀러' })).status, 404);
});

/* ── 계약 조건 수정 ───────────────────────────────────────── */

test('수정 요청을 받은 계약은 조건을 고칠 수 있고 만료일이 다시 계산된다', async () => {
  const contractId = makeContract(makeUnit(), 'rejected');
  const res = await call('PATCH', `/contracts/${contractId}`,
    { deposit: 200000000, moveInDate: '2024-03-01', termMonths: 24 });

  assert.equal(res.status, 200);
  assert.equal(res.body.deposit, 200000000);
  assert.equal(res.body.expires_on, '2026-02-28', '입주일 + 24개월 − 1일');
});

test('거주 중 계약의 조건은 고칠 수 없다 — 바꾸려면 갱신이다', async () => {
  const contractId = makeContract(makeUnit(), 'active');
  const res = await call('PATCH', `/contracts/${contractId}`, { deposit: 1 });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /갱신/);
});

test('거주 중 계약도 퇴거 예정일은 넣을 수 있다 — 조건 변경이 아니다', async () => {
  const contractId = makeContract(makeUnit(), 'active');
  const res = await call('PATCH', `/contracts/${contractId}`, { moveOutDate: '2025-12-31' });

  assert.equal(res.status, 200);
  assert.equal(res.body.move_out_date, '2025-12-31');
});

test('임차인 이름은 비울 수 없다', async () => {
  const contractId = makeContract(makeUnit(), 'draft');
  assert.equal((await call('PATCH', `/contracts/${contractId}`, { tenantName: '  ' })).status, 400);
});

test.after(() => {
  server.close();
  db.close();
  for (const suffix of ['', '-shm', '-wal']) fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
});
