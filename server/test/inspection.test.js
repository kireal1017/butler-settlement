import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* db.js 는 import 시점에 DB_PATH 를 읽는다. 임시 DB 를 먼저 지정하고 동적 import 한다. */
const DB_PATH = path.join(os.tmpdir(), `butler-inspection-test-${process.pid}.db`);
fs.rmSync(DB_PATH, { force: true });
process.env.DB_PATH = DB_PATH;

const { db, migrate } = await import('../src/db.js');
const svc = await import('../src/service.js');
const repo = await import('../src/repository.js');
const timeline = await import('../src/services/timeline.js');

migrate();

const today = timeline.toIso(timeline.startOfToday());
const rel = (n) => timeline.shiftIso(today, n);

const landlordId = db.prepare(`INSERT INTO landlords (name) VALUES ('김성호')`).run().lastInsertRowid;
const complexId = db.prepare(
  `INSERT INTO complexes (kapt_code, name, address) VALUES ('A1', '테스트 아파트', '서울시')`
).run().lastInsertRowid;

let ho = 300;

/** 거주 중 계약 + 품목 하나 */
function makeContract({ status = 'active', expiresOn = rel(30) } = {}) {
  ho += 1;
  const unitId = db.prepare(`
    INSERT INTO units (complex_id, dong, ho, exclusive_area, landlord_id, vacancy_status)
    VALUES (?, '101동', ?, 84.95, ?, 'occupied')`
  ).run(complexId, `${ho}호`, landlordId).lastInsertRowid;

  const contractId = db.prepare(`
    INSERT INTO contracts (unit_id, landlord_id, landlord_name, tenant_name, deposit,
                           move_in_date, term_months, expires_on, status)
    VALUES (?, ?, '김성호', '이지은', 300000000, ?, 24, ?, ?)`
  ).run(unitId, landlordId, rel(-700), expiresOn, status).lastInsertRowid;

  svc.saveRuleSet(contractId, {
    ltrfBurden: 'landlord', prorateEdgeMonths: 1, minorRepairThreshold: 100000,
    wallpaperGraceMonths: 24, flooringGraceMonths: 24, lateInterestRate: 5,
    tenantPaidAdvanceFee: 0, advanceFeeAmount: 0,
    items: [{
      category: 'wallpaper', label: '전체 도배', usefulLifeYears: 6,
      lastRenewedOn: rel(-700), replacementCost: 2600000, graceApplicable: true,
    }],
  });
  return { contractId, unitId };
}

const rejects = (fn, status) => {
  try { fn(); assert.fail('오류가 발생해야 한다'); }
  catch (e) { assert.equal(e.status, status, `status ${status} 여야 하는데 ${e.status}: ${e.message}`); }
};

/** 퇴거 개시 → 점검 요청 → 사진 2장 → 제출 까지 끝낸 계약을 만든다 */
function readyForReview() {
  const { contractId, unitId } = makeContract();
  svc.startMoveout(contractId, rel(20));
  const { token } = svc.requestInspection(contractId);
  svc.addInspectionPhoto(token, { area: 'livingroom', filePath: 'uploads/inspections/a.svg', note: '벽지 찢김' });
  svc.addInspectionPhoto(token, { area: 'bathroom', filePath: 'uploads/inspections/b.svg', note: null });
  svc.submitInspection(token);
  return { contractId, unitId, token };
}

/* ── 퇴거 개시 ─────────────────────────────────────────────── */

test('퇴거 절차를 시작하면 퇴거일이 확정되고 집이 퇴거 진행 중이 된다', () => {
  const { contractId, unitId } = makeContract();
  const out = svc.startMoveout(contractId, rel(20));

  assert.equal(out.status, 'closing');
  assert.equal(out.move_out_date, rel(20));
  assert.equal(repo.getUnit(unitId).vacancyStatus, 'closing');
});

test('갱신 결정을 하지 않은 채 시작하면 moveout 으로 기록된다', () => {
  const { contractId } = makeContract();
  assert.equal(svc.startMoveout(contractId, rel(20)).renewal_decision, 'moveout');
});

test('이미 갱신하지 않기로 한 결정은 덮어쓰지 않는다', () => {
  const { contractId } = makeContract();
  svc.declineRenewal(contractId);
  assert.equal(svc.startMoveout(contractId, rel(20)).renewal_decision, 'decline');
});

test('퇴거일 형식과 순서를 검사한다', () => {
  const { contractId } = makeContract();
  rejects(() => svc.startMoveout(contractId, '2026/10/12'), 400);
  rejects(() => svc.startMoveout(contractId, null), 400);
  rejects(() => svc.startMoveout(contractId, rel(-900)), 400);   // 입주일보다 빠름
});

test('거주 중이 아닌 계약은 퇴거 절차를 시작할 수 없다', () => {
  const { contractId } = makeContract({ status: 'draft' });
  rejects(() => svc.startMoveout(contractId, rel(20)), 409);
});

test('갱신 계약이 있는 계약은 퇴거 절차를 시작할 수 없다', () => {
  const { contractId } = makeContract({ expiresOn: rel(100) });
  svc.renewContract(contractId, { termMonths: 24 });
  rejects(() => svc.startMoveout(contractId, rel(20)), 409);
});

/* ── 점검 요청 ─────────────────────────────────────────────── */

test('퇴거 절차를 시작해야 점검을 요청할 수 있다', () => {
  const { contractId } = makeContract();
  rejects(() => svc.requestInspection(contractId), 409);
});

test('점검을 요청하면 점검과 링크가 만들어진다', () => {
  const { contractId } = makeContract();
  svc.startMoveout(contractId, rel(20));
  const res = svc.requestInspection(contractId);

  assert.ok(res.token);
  assert.equal(res.status, 'requested');
  assert.equal(repo.getInspection(contractId).status, 'requested');
});

test('다시 요청해도 점검은 하나이고 사진을 잃지 않는다', () => {
  const { contractId } = makeContract();
  svc.startMoveout(contractId, rel(20));
  const first = svc.requestInspection(contractId);
  svc.addInspectionPhoto(first.token, { area: 'kitchen', filePath: 'uploads/inspections/k.svg' });

  const second = svc.requestInspection(contractId);
  assert.equal(second.inspectionId, first.inspectionId);
  assert.notEqual(second.token, first.token, '새 링크가 나와야 한다');
  assert.equal(repo.getInspectionPhotos(first.inspectionId).length, 1, '사진이 남아 있어야 한다');

  const open = db.prepare(`
    SELECT COUNT(*) n FROM share_links
    WHERE contract_id = ? AND purpose = 'inspection' AND completed_at IS NULL`).get(contractId);
  assert.equal(open.n, 1, '살아 있는 점검 링크는 하나여야 한다');
});

/* ── 임차인 제출 ───────────────────────────────────────────── */

test('구역 값이 올바르지 않으면 거절한다', () => {
  const { contractId } = makeContract();
  svc.startMoveout(contractId, rel(20));
  const { token } = svc.requestInspection(contractId);
  rejects(() => svc.addInspectionPhoto(token, { area: '거실', filePath: 'x.svg' }), 400);
});

test('사진 없이 제출할 수 없다', () => {
  const { contractId } = makeContract();
  svc.startMoveout(contractId, rel(20));
  const { token } = svc.requestInspection(contractId);
  rejects(() => svc.submitInspection(token), 400);
});

test('제출하면 점검이 submitted 가 되고 링크가 닫힌다', () => {
  const { contractId, token } = readyForReview();

  assert.equal(repo.getInspection(contractId).status, 'submitted');
  assert.ok(repo.getShareLinkByToken(token).completedAt);
});

test('제출한 뒤에는 그 링크로 사진을 더 올릴 수 없다', () => {
  const { token } = readyForReview();
  rejects(() => svc.addInspectionPhoto(token, { area: 'etc', filePath: 'c.svg' }), 409);
  rejects(() => svc.submitInspection(token), 409);
});

test('재요청하면 다시 열리고 올라온 사진은 남는다', () => {
  const { contractId } = readyForReview();
  const reopened = svc.requestInspection(contractId);

  assert.equal(reopened.status, 'requested');
  assert.equal(repo.getInspection(contractId).submitted_at, null);
  assert.equal(repo.getInspectionPhotos(reopened.inspectionId).length, 2, '사진은 그대로다');

  svc.addInspectionPhoto(reopened.token, { area: 'etc', filePath: 'uploads/inspections/c.svg' });
  svc.submitInspection(reopened.token);
  assert.equal(repo.getInspectionPhotos(reopened.inspectionId).length, 3);
});

test('검토가 끝난 점검도 다시 받을 수 있고, 다시 검토하면 항목이 갈아끼워진다', () => {
  const { contractId } = readyForReview();
  const inspectionId = repo.getInspection(contractId).id;
  svc.reviewInspection(inspectionId, [{ description: '1차 판단', faultRatio: 0.5 }]);

  const reopened = svc.requestInspection(contractId);
  assert.equal(reopened.status, 'requested');
  assert.equal(repo.getDamages(contractId).length, 1, '검토 결과는 남아 있다');

  svc.submitInspection(reopened.token);
  svc.reviewInspection(inspectionId, [{ description: '2차 판단', faultRatio: 0.7 }]);
  assert.deepEqual(repo.getDamages(contractId).map((d) => d.description), ['2차 판단']);
});

test('임차인 화면에는 사진만 가고 임대인의 귀책비율은 가지 않는다', () => {
  const { contractId } = makeContract();
  svc.startMoveout(contractId, rel(20));
  const { token } = svc.requestInspection(contractId);
  svc.addInspectionPhoto(token, { area: 'livingroom', filePath: 'uploads/inspections/a.svg' });

  const ctx = svc.readShareContext(token);
  assert.equal(ctx.purpose, 'inspection');
  assert.equal(ctx.inspection.photos.length, 1);
  assert.equal(ctx.inspection.damages, undefined, 'damage_reports 는 내보내지 않는다');
  assert.equal(ctx.inspection.photos[0].file_path, undefined, '파일 경로도 내보내지 않는다');
});

/* ── 임대인 검토 → damage_reports ──────────────────────────── */

test('귀책비율을 지정하면 damage_reports 가 만들어진다', () => {
  const { contractId } = readyForReview();
  const inspectionId = repo.getInspection(contractId).id;
  const photos = repo.getInspectionPhotos(inspectionId);
  const ruleItemId = repo.getRuleItems(repo.getRuleSet(contractId).id)[0].id;

  const out = svc.reviewInspection(inspectionId, [
    { description: '거실 벽지 찢김', faultRatio: 0.5, ruleItemId, photoId: photos[0].id },
    { description: '욕실 타일 줄눈 변색', faultRatio: 0, photoId: photos[1].id },
  ]);

  assert.equal(out.status, 'reviewed');
  const damages = repo.getDamages(contractId);
  assert.equal(damages.length, 2);
  assert.equal(damages[0].fault_ratio, 0.5);
  assert.equal(damages[0].rule_item_id, ruleItemId);
  assert.equal(damages[0].inspection_id, inspectionId);
  assert.equal(damages[0].photo_id, photos[0].id);
  assert.equal(damages[0].photo_ref, 'livingroom', '사진의 구역이 근거로 남는다');
});

test('귀책 0(통상손모)도 항목으로 남긴다', () => {
  const { contractId } = readyForReview();
  const inspectionId = repo.getInspection(contractId).id;
  svc.reviewInspection(inspectionId, [{ description: '통상손모', faultRatio: 0 }]);

  /* 빼 버리면 임차인이 "왜 이 항목은 아예 없지?" 를 묻게 된다 */
  assert.equal(repo.getDamages(contractId).length, 1);
  assert.equal(repo.getDamages(contractId)[0].fault_ratio, 0);
});

test('다시 검토하면 이 점검이 만든 항목만 갈아끼운다', () => {
  const { contractId } = readyForReview();
  const inspectionId = repo.getInspection(contractId).id;

  // 점검과 무관하게 손으로 넣은 항목
  db.prepare(`
    INSERT INTO damage_reports (contract_id, description, fault_ratio) VALUES (?, '손으로 추가', 1)`
  ).run(contractId);

  svc.reviewInspection(inspectionId, [{ description: '1차', faultRatio: 0.3 }]);
  svc.reviewInspection(inspectionId, [{ description: '2차', faultRatio: 0.7 }]);

  const descs = repo.getDamages(contractId).map((d) => d.description);
  assert.deepEqual(descs.sort(), ['2차', '손으로 추가'], '1차만 사라져야 한다');
});

test('귀책비율은 0 ~ 1 범위여야 한다', () => {
  const { contractId } = readyForReview();
  const inspectionId = repo.getInspection(contractId).id;

  rejects(() => svc.reviewInspection(inspectionId, [{ description: 'x', faultRatio: 1.5 }]), 400);
  rejects(() => svc.reviewInspection(inspectionId, [{ description: 'x', faultRatio: -1 }]), 400);
  rejects(() => svc.reviewInspection(inspectionId, [{ description: '  ', faultRatio: 0.5 }]), 400);
});

test('검사에 걸리면 아무것도 저장되지 않는다', () => {
  const { contractId } = readyForReview();
  const inspectionId = repo.getInspection(contractId).id;

  rejects(() => svc.reviewInspection(inspectionId, [
    { description: '정상 항목', faultRatio: 0.5 },
    { description: '', faultRatio: 0.5 },
  ]), 400);

  assert.equal(repo.getDamages(contractId).length, 0, '앞 항목도 들어가면 안 된다');
  assert.equal(repo.getInspection(contractId).status, 'submitted');
});

test('제출하지 않은 점검은 검토할 수 없다', () => {
  const { contractId } = makeContract();
  svc.startMoveout(contractId, rel(20));
  svc.requestInspection(contractId);
  const inspectionId = repo.getInspection(contractId).id;

  rejects(() => svc.reviewInspection(inspectionId, []), 409);
});

/* ── 할 일과의 연결 ────────────────────────────────────────── */

test('퇴거 절차를 시작하면 정산서 발행 할 일이 뜬다', async () => {
  const tasks = await import('../src/services/tasks.js');
  const { contractId } = makeContract();
  svc.startMoveout(contractId, rel(20));

  const kinds = tasks.refreshTasks(landlordId)
    .filter((t) => t.contractId === contractId).map((t) => t.kind);
  assert.deepEqual(kinds, ['settlement_issue']);
});

test.after(() => {
  db.close();
  fs.rmSync(DB_PATH, { force: true });
  fs.rmSync(`${DB_PATH}-shm`, { force: true });
  fs.rmSync(`${DB_PATH}-wal`, { force: true });
});
