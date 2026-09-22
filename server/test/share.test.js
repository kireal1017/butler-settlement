import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* db.js 는 import 시점에 DB_PATH 를 읽는다. 임시 DB 를 먼저 지정하고 동적 import 한다. */
const DB_PATH = path.join(os.tmpdir(), `butler-share-test-${process.pid}.db`);
fs.rmSync(DB_PATH, { force: true });
process.env.DB_PATH = DB_PATH;

const { db, migrate } = await import('../src/db.js');
const svc = await import('../src/service.js');
const repo = await import('../src/repository.js');

migrate();

const RULES = {
  ltrfBurden: 'landlord', prorateEdgeMonths: 1, minorRepairThreshold: 100000,
  wallpaperGraceMonths: 24, flooringGraceMonths: 24, lateInterestRate: 5,
  tenantPaidAdvanceFee: 1, advanceFeeAmount: 550000,
  items: [{
    category: 'wallpaper', label: '전체 도배', usefulLifeYears: 6,
    lastRenewedOn: '2026-01-10', replacementCost: 2600000, graceApplicable: true,
  }],
};

const landlordId = db.prepare(`INSERT INTO landlords (name) VALUES ('김성호')`).run().lastInsertRowid;
const complexId = db.prepare(
  `INSERT INTO complexes (kapt_code, name) VALUES ('A1', '테스트 아파트')`).run().lastInsertRowid;

/** 계약 하나를 만들고 임대인 확정까지 끝낸 뒤 링크를 발급한다 */
function makeContract(tenantName, ho) {
  const unitId = db.prepare(`
    INSERT INTO units (complex_id, dong, ho, exclusive_area, landlord_id)
    VALUES (?, '101동', ?, 84.95, ?)`).run(complexId, ho, landlordId).lastInsertRowid;

  const contractId = db.prepare(`
    INSERT INTO contracts (unit_id, landlord_id, landlord_name, tenant_name, deposit,
                           move_in_date, term_months, expires_on, status)
    VALUES (?, ?, '김성호', ?, 300000000, '2026-10-01', 24, '2028-09-30', 'draft')`
  ).run(unitId, landlordId, tenantName).lastInsertRowid;

  svc.saveRuleSet(contractId, RULES);
  const ruleSet = repo.getRuleSet(contractId);
  db.prepare(`UPDATE rule_sets SET locked_by_landlord_at = datetime('now') WHERE id = ?`).run(ruleSet.id);

  const { token } = svc.sendContractLink(contractId);
  return { contractId, unitId, token };
}

const rejects = (fn, status) => {
  try { fn(); assert.fail('오류가 발생해야 한다'); }
  catch (e) { assert.equal(e.status, status, `status ${status} 여야 하는데 ${e.status}: ${e.message}`); }
};

/* ── 토큰 범위 ────────────────────────────────────────────── */

test('토큰은 자기 계약만 연다 — 다른 계약에 접근할 수 없다', () => {
  const a = makeContract('정하늘', '101호');
  const b = makeContract('한서윤', '102호');

  assert.equal(svc.readShareContext(a.token).contract.tenantName, '정하늘');
  assert.equal(svc.readShareContext(b.token).contract.tenantName, '한서윤');
  assert.notEqual(a.token, b.token);
});

test('없는 토큰은 404', () => {
  rejects(() => svc.readShareContext('존재하지않는토큰'), 404);
});

test('만료된 링크는 410', () => {
  const { contractId } = makeContract('만료', '103호');
  db.prepare(`
    INSERT INTO share_links (token, contract_id, purpose, expires_at)
    VALUES ('expired-token', ?, 'contract_review', '2020-01-01')`).run(contractId);
  rejects(() => svc.readShareContext('expired-token'), 410);
});

test('링크를 처음 열면 열람 시각이 기록된다', () => {
  const { token } = makeContract('열람', '104호');
  assert.equal(repo.getShareLinkByToken(token).firstOpenedAt, null);
  svc.readShareContext(token);
  assert.ok(repo.getShareLinkByToken(token).firstOpenedAt);
});

/* ── 응답 ─────────────────────────────────────────────────── */

test('거부하려면 사유를 적어야 한다', () => {
  const { token } = makeContract('사유없음', '105호');
  rejects(() => svc.respondToContract(token, 'rejected', '   '), 400);
});

test('decision 은 accepted / rejected 만 받는다', () => {
  const { token } = makeContract('잘못된값', '106호');
  rejects(() => svc.respondToContract(token, 'maybe', null), 400);
});

test('동의하면 계약이 성립하고 집이 거주 중으로 바뀐다', () => {
  const { token, contractId, unitId } = makeContract('동의', '107호');
  svc.respondToContract(token, 'accepted', null);

  assert.equal(repo.getContract(contractId).status, 'active');
  assert.equal(repo.getUnit(unitId).vacancyStatus, 'occupied');
  assert.ok(repo.getRuleSet(contractId).locked_by_tenant_at, '임차인 서명이 찍혀야 한다');
});

test('같은 링크로 두 번 응답할 수 없다', () => {
  const { token } = makeContract('중복', '108호');
  svc.respondToContract(token, 'accepted', null);
  rejects(() => svc.respondToContract(token, 'rejected', '역시 아니에요'), 409);
});

/* ── 거부 → 수정 → 재전송 루프 ────────────────────────────── */

test('거부하면 계약이 rejected 가 되고 사유가 남는다', () => {
  const { token, contractId } = makeContract('거부', '109호');
  svc.respondToContract(token, 'rejected', '선수관리비를 확인해 주세요');

  assert.equal(repo.getContract(contractId).status, 'rejected');
  assert.equal(repo.getLatestContractResponse(contractId).reason, '선수관리비를 확인해 주세요');
});

test('거부된 규칙을 고치면 새 버전이 생기고 거부 기록은 보존된다', () => {
  const { token, contractId } = makeContract('수정', '110호');
  const v1 = repo.getRuleSet(contractId).id;
  svc.respondToContract(token, 'rejected', '선수관리비를 확인해 주세요');

  // 회귀 방지: 예전에는 기존 rule_set 을 지워서 FOREIGN KEY constraint failed 로 죽었다
  svc.saveRuleSet(contractId, { ...RULES, tenantPaidAdvanceFee: 0, advanceFeeAmount: 0 });

  const v2 = repo.getRuleSet(contractId);
  assert.equal(v2.version, 2);
  assert.notEqual(v2.id, v1);
  assert.equal(v2.tenant_paid_advance_fee, 0);
  assert.ok(db.prepare(`SELECT 1 FROM rule_sets WHERE id = ?`).get(v1), '거부된 버전이 남아 있어야 한다');
  assert.equal(repo.getLatestContractResponse(contractId).decision, 'rejected');
});

test('아무도 참조하지 않는 규칙은 같은 버전에 덮어쓴다', () => {
  const { contractId } = makeContract('덮어쓰기', '111호');
  svc.saveRuleSet(contractId, { ...RULES, minorRepairThreshold: 70000 });

  const rules = repo.getRuleSet(contractId);
  assert.equal(rules.version, 1, '작성 중 반복 저장이 버전을 늘리면 안 된다');
  assert.equal(rules.minor_repair_threshold, 70000);
});

test('재전송하면 이전 링크는 버려진다', () => {
  const { contractId, token } = makeContract('재전송', '112호');
  svc.respondToContract(token, 'rejected', '다시 봐주세요');
  svc.saveRuleSet(contractId, { ...RULES, advanceFeeAmount: 0 });

  const ruleSet = repo.getRuleSet(contractId);
  db.prepare(`UPDATE rule_sets SET locked_by_landlord_at = datetime('now') WHERE id = ?`).run(ruleSet.id);
  const resent = svc.sendContractLink(contractId);

  const open = db.prepare(`
    SELECT COUNT(*) n FROM share_links
    WHERE contract_id = ? AND purpose = 'contract_review' AND completed_at IS NULL`).get(contractId);
  assert.equal(open.n, 1, '살아 있는 확인 링크는 하나여야 한다');
  assert.notEqual(resent.token, token);
  assert.equal(repo.getContract(contractId).status, 'pending_tenant');
});

/* ── 발송 가드 ────────────────────────────────────────────── */

test('임대인이 확정하지 않으면 보낼 수 없다', () => {
  const unitId = db.prepare(`
    INSERT INTO units (complex_id, dong, ho, exclusive_area, landlord_id)
    VALUES (?, '101동', '113호', 84.95, ?)`).run(complexId, landlordId).lastInsertRowid;
  const contractId = db.prepare(`
    INSERT INTO contracts (unit_id, landlord_id, landlord_name, tenant_name, deposit,
                           move_in_date, term_months, expires_on, status)
    VALUES (?, ?, '김성호', '미확정', 300000000, '2026-10-01', 24, '2028-09-30', 'draft')`
  ).run(unitId, landlordId).lastInsertRowid;

  rejects(() => svc.sendContractLink(contractId), 409);   // 규칙 없음
  svc.saveRuleSet(contractId, RULES);
  rejects(() => svc.sendContractLink(contractId), 409);   // 임대인 미확정
});

test.after(() => {
  db.close();
  fs.rmSync(DB_PATH, { force: true });
  fs.rmSync(`${DB_PATH}-shm`, { force: true });
  fs.rmSync(`${DB_PATH}-wal`, { force: true });
});
