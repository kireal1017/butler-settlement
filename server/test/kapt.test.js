import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* db.js 는 import 시점에 DB_PATH 를 읽는다. 임시 DB 를 먼저 지정하고 동적 import 한다. */
const DB_PATH = path.join(os.tmpdir(), `butler-kapt-test-${process.pid}.db`);
fs.rmSync(DB_PATH, { force: true });
process.env.DB_PATH = DB_PATH;
process.env.KAPT_SERVICE_KEY = 'TEST-KEY';

const { db, migrate } = await import('../src/db.js');
const kapt = await import('../src/services/kapt.js');
const sync = await import('../src/services/kapt-sync.js');

migrate();

const complexId = db.prepare(
  `INSERT INTO complexes (kapt_code, name) VALUES ('A11005401', '테스트단지')`).run().lastInsertRowid;

/* ── fetch 스텁 ─────────────────────────────────────────────
   실 네트워크 없이 어댑터의 요청·응답 처리를 고정한다. 공공데이터가 죽어도
   테스트가 빨갛게 되면 안 되고, 응답 형태가 바뀌면 여기서 잡혀야 한다. */
const realFetch = globalThis.fetch;
let calls = [];

function stub(handler) {
  calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const { status = 200, body } = handler(u) ?? {};
    return { ok: status >= 200 && status < 300, status, text: async () => body ?? '' };
  };
}
const restore = () => { globalThis.fetch = realFetch; };

const ok = (payload) => ({ body: JSON.stringify({ response: { header: { resultCode: '00' }, body: payload } }) });

test.after(restore);

/* ── 월 나열 ───────────────────────────────────────────────── */

test('monthsBetween 은 양끝을 포함하고 해를 넘긴다', () => {
  assert.deepEqual(sync.monthsBetween('2025-11', '2026-02'),
    ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(sync.monthsBetween('2026-03', '2026-03'), ['2026-03']);
});

test('publishedThrough 는 전월을 가리킨다 (K-apt 공개 지연)', () => {
  assert.equal(sync.publishedThrough(new Date(2026, 8, 22)), '2026-08');
  assert.equal(sync.publishedThrough(new Date(2026, 0, 5)), '2025-12');
});

/* ── 응답 파싱 ─────────────────────────────────────────────── */

test('fetchComplexInfo 는 privArea 와 사용승인 연도를 꺼낸다', async () => {
  stub(() => ok({ item: {
    kaptCode: 'A11005401', kaptName: '광화문스페이스본',
    kaptAddr: '서울특별시 종로구', kaptdaCnt: '744',
    kaptUsedate: '20080711', privArea: '94981.45', kaptMarea: 120000, bjdCode: '1111011700',
  } }));
  const info = await kapt.fetchComplexInfo('A11005401');
  restore();

  assert.equal(info.privArea, 94981.45);
  assert.equal(info.households, 744);
  assert.equal(info.builtYear, 2008);
  assert.equal(info.bjdCode, '1111011700');
});

test('fetchComplexPage 는 items 가 배열인 V4 형태를 읽는다', async () => {
  stub(() => ok({
    totalCount: '22322',
    items: [{ kaptCode: 'A1', kaptName: '가단지', as1: '서울특별시', as2: '종로구', as3: '신문로' }],
  }));
  const page = await kapt.fetchComplexPage(1, 10);
  restore();

  assert.equal(page.totalCount, 22322);
  assert.equal(page.items[0].sido, '서울특별시');
  assert.equal(page.items[0].address, '서울특별시 종로구 신문로');
});

test('fetchLtrfRates 는 sLevy 를 읽고 0 이하인 달은 버린다', async () => {
  stub((u) => {
    const ym = u.searchParams.get('searchDate');
    return ok({ item: { sLevy: ym === '202502' ? 0 : 1000000 } });
  });
  const { rates, failed } = await kapt.fetchLtrfRates('A1', ['2025-01', '2025-02', '2025-03']);
  restore();

  assert.deepEqual(rates.map((r) => r.ym), ['2025-01', '2025-03']);
  assert.equal(rates[0].totalAmount, 1000000);
  assert.equal(failed, 0, '공개되지 않은 달은 실패가 아니다');
});

test('호출이 막힌 달은 실패로 세어 공개 안 된 달과 구분한다', async () => {
  stub((u) => {
    if (u.searchParams.get('searchDate') === '202502') return { status: 500, body: 'boom' };
    return ok({ item: { sLevy: 1000000 } });
  });
  const { rates, failed } = await kapt.fetchLtrfRates('A1', ['2025-01', '2025-02', '2025-03']);
  restore();

  assert.equal(rates.length, 2);
  assert.equal(failed, 1);
});

test('초당 요청제한(429)에 걸리면 즉시 멈추고 더 쏘지 않는다', async () => {
  let n = 0;
  stub(() => {
    n += 1;
    return n <= 2
      ? ok({ item: { sLevy: 1000000 } })
      : { status: 429, body: JSON.stringify({ response: { header: {
          resultCode: '23', resultMsg: '초당 서비스 요청제한 횟수 초과 에러' } } }) };
  });
  const res = await kapt.fetchLtrfRates('A1', ['2023-01', '2023-02', '2023-03', '2023-04', '2023-05']);
  restore();

  assert.equal(res.rates.length, 2, '걸리기 전까지 받은 것은 살린다');
  assert.equal(res.throttled, true);
  assert.equal(calls.length, 3, '429 를 만난 뒤로는 호출하지 않는다');
});

test('한 번에 받는 개월 수에 상한이 있다', async () => {
  stub(() => ok({ item: { sLevy: 1000 } }));
  const many = sync.monthsBetween('2020-01', '2023-12');      // 48개월
  const res = await kapt.fetchLtrfRates('A1', many, { gapMs: 0 });
  restore();

  assert.ok(calls.length <= 20, `한 번에 20회를 넘지 않는다 (실제 ${calls.length})`);
  assert.ok(res.remaining > 0, '남은 달은 다음 조회에서 이어 받는다');
});

test('상한에 걸릴 때는 **최근 달부터** 묻는다', async () => {
  stub(() => ok({ item: { sLevy: 1000 } }));
  const many = sync.monthsBetween('2020-01', '2023-12');      // 48개월
  await kapt.fetchLtrfRates('A1', many, { gapMs: 0 });
  restore();

  /* K-apt 가 최근 몇 년치만 공개하는 단지가 있다. 오래된 달부터 물으면 그 20개월이
     전부 빈손이라, 데이터가 있는 구간에 영영 닿지 못한다 (실측: 경희궁의아침4단지). */
  const asked = calls.map((u) => new URL(u).searchParams.get('searchDate'));
  assert.equal(asked[0], '202312', '가장 최근 달부터');
  assert.ok(!asked.includes('202001'), '가장 오래된 달은 이번 차례가 아니다');
});

test('결과는 받은 순서가 아니라 시간순으로 돌려준다', async () => {
  stub(() => ok({ item: { sLevy: 1000 } }));
  const res = await kapt.fetchLtrfRates('A1', ['2025-01', '2025-02', '2025-03'], { gapMs: 0 });
  restore();

  assert.deepEqual(res.rates.map((r) => r.ym), ['2025-01', '2025-02', '2025-03'],
    '호출 전략(최근 우선)이 결과 순서로 새어 나오면 안 된다');
});

test('공개되지 않은 달을 기억해 다시 묻지 않는다', async () => {
  const c = db.prepare(
    `INSERT INTO complexes (kapt_code, name, priv_area) VALUES ('A88', '최근만공개', 1000)`)
    .run().lastInsertRowid;

  /* 2025-03 만 값이 있고 나머지는 K-apt 가 비워서 준다 */
  stub((url) => {
    const ym = new URL(url).searchParams.get('searchDate');
    return ok({ item: ym === '202503' ? { sLevy: 2000 } : { sLevy: null } });
  });
  const first = await sync.syncLtrfRates(c, '2025-01', '2025-03');
  const firstCalls = calls.length;

  calls.length = 0;
  const second = await sync.syncLtrfRates(c, '2025-01', '2025-03');
  restore();

  assert.equal(first.filled, 1);
  assert.equal(firstCalls, 3);
  assert.equal(second.filled, 0);
  assert.equal(calls.length, 0,
    '값이 있는 달은 적재됐고 나머지는 없다고 확인됐으니 다시 부를 것이 없다');
});

test('전부 실패하면 이유에 호출 실패라고 적는다', async () => {
  const c = db.prepare(
    `INSERT INTO complexes (kapt_code, name, priv_area) VALUES ('A77', '막힌단지', 1000)`)
    .run().lastInsertRowid;

  stub(() => ({ status: 500, body: 'boom' }));
  const res = await sync.syncLtrfRates(c, '2025-01', '2025-03');
  restore();

  assert.equal(res.filled, 0);
  assert.equal(res.failed, 3);
  assert.match(res.reason, /호출 3건이 실패/);
});

/* ── 에러 전달 ─────────────────────────────────────────────── */

test('폐기된 경로(400 + XML)는 원인 문구를 그대로 올린다', async () => {
  stub(() => ({
    status: 400,
    body: '<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>해당 오픈API 서비스가 없거나 폐기됨</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>',
  }));
  await assert.rejects(kapt.ping(), /없거나 폐기됨/);
  restore();
});

test('HTTP 200 인데 resultCode 가 00 이 아니면 실패로 본다', async () => {
  stub(() => ({ body: JSON.stringify({
    response: { header: { resultCode: '30', resultMsg: '등록되지 않은 서비스키' } } }) }));
  await assert.rejects(kapt.ping(), /등록되지 않은 서비스키/);
  restore();
});

/* ── 적재 ──────────────────────────────────────────────────── */

test('syncLtrfRates 는 월부과총액을 전용면적합으로 나눠 원/㎡ 로 적재한다', async () => {
  db.prepare(`UPDATE complexes SET priv_area = 1000 WHERE id = ?`).run(complexId);
  stub(() => ok({ item: { sLevy: 250000 } }));
  const res = await sync.syncLtrfRates(complexId, '2025-01', '2025-03');
  restore();

  assert.equal(res.filled, 3);
  const rows = db.prepare(
    `SELECT ym, rate_per_sqm, data_source FROM ltrf_rates WHERE complex_id = ? ORDER BY ym`)
    .all(complexId);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].rate_per_sqm, 250);          // 250,000 ÷ 1,000㎡
  assert.equal(rows[0].data_source, 'kapt');
});

test('실 단가는 시드 단가를 덮어쓴다', async () => {
  db.prepare(`
    INSERT INTO ltrf_rates (complex_id, ym, rate_per_sqm, data_source)
    VALUES (?, '2025-06', 999, 'seed')`).run(complexId);

  stub(() => ok({ item: { sLevy: 100000 } }));
  await sync.syncLtrfRates(complexId, '2025-06', '2025-06');
  restore();

  const row = db.prepare(
    `SELECT rate_per_sqm, data_source FROM ltrf_rates WHERE complex_id = ? AND ym = '2025-06'`)
    .get(complexId);
  assert.equal(row.rate_per_sqm, 100);
  assert.equal(row.data_source, 'kapt');
});

test('이미 받아 둔 달은 다시 호출하지 않는다', async () => {
  stub(() => ok({ item: { sLevy: 250000 } }));
  const res = await sync.syncLtrfRates(complexId, '2025-01', '2025-03');
  restore();

  assert.equal(res.filled, 0);
  assert.equal(calls.length, 0, '네트워크 호출이 없어야 한다');
});

test('아직 공개되지 않은 이번 달·미래는 요청하지 않는다', async () => {
  const future = sync.monthsBetween(sync.publishedThrough(), '2099-12');
  stub(() => ok({ item: { sLevy: 250000 } }));
  await sync.syncLtrfRates(complexId, future[1], '2099-12');
  restore();

  assert.equal(calls.length, 0, '미공개 구간은 호출 자체를 하지 않는다');
});

test('전용면적합이 없으면 환산하지 않고 이유를 돌려준다', async () => {
  const bare = db.prepare(
    `INSERT INTO complexes (kapt_code, name) VALUES ('A99', '면적없음')`).run().lastInsertRowid;

  stub(() => ok({ item: { kaptCode: 'A99', kaptName: '면적없음' } })); // privArea 없음
  const res = await sync.syncLtrfRates(bare, '2025-01', '2025-02');
  restore();

  assert.equal(res.filled, 0);
  assert.match(res.reason, /privArea/);
  assert.equal(
    db.prepare(`SELECT COUNT(*) n FROM ltrf_rates WHERE complex_id = ?`).get(bare).n, 0);
});

test('공공데이터가 죽어도 정산 조회는 멈추지 않는다', async () => {
  stub(() => { throw new Error('ECONNRESET'); });
  const res = await sync.ensureLtrfRates(complexId, '2024-01', '2024-02');
  restore();

  /* 월 단위 장애는 어댑터가 이미 삼키므로 "채운 게 없다"로 돌아온다 */
  assert.equal(res.filled, 0);
  assert.equal(
    db.prepare(`SELECT COUNT(*) n FROM ltrf_rates WHERE complex_id = ? AND ym LIKE '2024-%'`)
      .get(complexId).n, 0);
});

test('ensureLtrfRates 는 내부 예외도 삼키고 null 을 준다', async () => {
  stub(() => ok({ item: { sLevy: 1 } }));
  const res = await sync.ensureLtrfRates(999_999, '2024-01', '2024-02'); // 없는 단지 → 404 throw
  restore();
  assert.equal(res, null);
});

test('키가 없으면 호출하지 않고 이유만 돌려준다', async () => {
  const saved = process.env.KAPT_SERVICE_KEY;
  process.env.KAPT_SERVICE_KEY = '';
  stub(() => ok({ item: { sLevy: 1 } }));

  const res = await sync.syncLtrfRates(complexId, '2024-01', '2024-02');
  assert.equal(res.filled, 0);
  assert.match(res.reason, /키/);
  assert.equal(calls.length, 0);
  assert.equal(await sync.ensureLtrfRates(complexId, '2024-01', '2024-02'), null);

  restore();
  process.env.KAPT_SERVICE_KEY = saved;
});

test('syncComplexList 는 전국 목록을 kapt_code 기준으로 upsert 한다', async () => {
  let page = 0;
  stub(() => {
    page += 1;
    return ok(page === 1
      ? { totalCount: '2', items: [
          { kaptCode: 'A11005401', kaptName: '이름이바뀐단지', as1: '서울특별시', as2: '종로구' },
          { kaptCode: 'B0001', kaptName: '새단지', as1: '부산광역시', as2: '해운대구' }] }
      : { totalCount: '2', items: [] });
  });
  const res = await sync.syncComplexList({ pageSize: 2 });
  restore();

  assert.equal(res.synced, 2);

  /* 기존 행은 id 를 유지한 채 이름만 갱신된다 — 세대·계약이 붙어 있으므로 */
  const existing = db.prepare(`SELECT * FROM complexes WHERE kapt_code = 'A11005401'`).get();
  assert.equal(existing.id, complexId);
  assert.equal(existing.name, '이름이바뀐단지');
  assert.equal(existing.data_source, 'kapt');

  assert.ok(db.prepare(`SELECT 1 FROM complexes WHERE kapt_code = 'B0001'`).get());
});
