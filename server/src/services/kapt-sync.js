import { db } from '../db.js';
import { isLive, fetchComplexInfo, fetchComplexPage, fetchLtrfRates } from './kapt.js';

/**
 * K-apt 실데이터 적재 계층
 *
 * kapt.js 는 "바깥에서 받아오는" 것만 하고, 이 파일이 "DB 에 앉히는" 것을 한다.
 * 이 계층이 없어서 그동안 키를 넣어도 정산 숫자가 한 줄도 바뀌지 않았다.
 *
 * 설계 ---------------------------------------------------------------
 *  · 단가는 **결측 월만** 채운다. 전 구간을 매번 다시 받으면 호출 한도(개발계정
 *    5,000/일)를 금방 쓰고, 이미 확정된 정산서의 근거가 흔들린다.
 *  · 실 단가(`kapt`)는 시드 단가(`seed`)를 덮어쓴다. 반대는 없다.
 *  · `ensureLtrfRates` 는 **절대 던지지 않는다.** 정산 조회 도중 공공데이터가
 *    죽으면 화면이 통째로 멈추는 대신 있는 단가로 계산되어야 한다 (절대 규칙 3).
 *
 * ⚠ 모듈 최상단에서 db.prepare() 를 부르지 말 것 — import 가 migrate() 보다 먼저
 *   평가되어 `no such table` 로 죽는다. 전부 () => 로 감싼다.
 */

const selComplex = () => db.prepare(`SELECT * FROM complexes WHERE id = ?`);

const updComplex = () => db.prepare(`
  UPDATE complexes
     SET name = ?, address = ?, sido = ?, sigungu = ?,
         total_households = COALESCE(?, total_households),
         built_year       = COALESCE(?, built_year),
         priv_area        = COALESCE(?, priv_area),
         bjd_code         = COALESCE(?, bjd_code),
         data_source = 'kapt',
         synced_at   = datetime('now','localtime')
   WHERE id = ?`);

const upsertRate = () => db.prepare(`
  INSERT INTO ltrf_rates (complex_id, ym, rate_per_sqm, data_source)
  VALUES (?, ?, ?, 'kapt')
  ON CONFLICT(complex_id, ym) DO UPDATE
    SET rate_per_sqm = excluded.rate_per_sqm, data_source = 'kapt'`);

const dropSeedRates = () => db.prepare(
  `DELETE FROM ltrf_rates WHERE complex_id = ? AND data_source <> 'kapt'`);

const existingYms = () => db.prepare(`
  SELECT ym FROM ltrf_rates
   WHERE complex_id = ? AND ym BETWEEN ? AND ? AND data_source = 'kapt'`);

/** 물어봤지만 부과액이 없던 달 — 다시 묻지 않는다 */
const absentYms = () => db.prepare(
  `SELECT ym FROM ltrf_absent WHERE complex_id = ? AND ym BETWEEN ? AND ?`);

const markAbsent = () => db.prepare(
  `INSERT OR IGNORE INTO ltrf_absent (complex_id, ym) VALUES (?, ?)`);

const upsertComplexByCode = () => db.prepare(`
  INSERT INTO complexes (kapt_code, name, address, sido, sigungu, bjd_code, data_source, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, 'kapt', datetime('now','localtime'))
  ON CONFLICT(kapt_code) DO UPDATE
    SET name = excluded.name, address = excluded.address,
        sido = excluded.sido, sigungu = excluded.sigungu,
        bjd_code = COALESCE(excluded.bjd_code, complexes.bjd_code),
        data_source = 'kapt', synced_at = excluded.synced_at`);

/** 'YYYY-MM' 두 값 사이의 월을 모두 나열한다 (양끝 포함). */
export function monthsBetween(fromYm, toYm) {
  const out = [];
  let [y, m] = fromYm.split('-').map(Number);
  const [ey, em] = toYm.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** K-apt 가 공개를 마친 마지막 달('YYYY-MM'). 공개가 한 달가량 늦으므로 전월로 본다. */
export function publishedThrough(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 단지 기본정보를 받아 complexes 행을 실데이터로 갱신한다. privArea 가 핵심이다. */
export async function syncComplexInfo(complexId) {
  const row = selComplex().get(complexId);
  if (!row) throw Object.assign(new Error('단지를 찾을 수 없습니다'), { status: 404 });
  if (!isLive()) return { synced: false, reason: 'K-apt 키가 없습니다' };

  const info = await fetchComplexInfo(row.kapt_code);
  if (!info) return { synced: false, reason: '단지 정보를 받지 못했습니다' };

  /* 목록 API 가 시도/시군구를 주고 기본정보 API 는 전체 주소를 준다.
     이미 들어 있는 값을 빈 값으로 덮지 않도록 기존 값을 살린다. */
  updComplex().run(
    info.name ?? row.name,
    info.address ?? row.address,
    row.sido, row.sigungu,
    info.households, info.builtYear, info.privArea, info.bjdCode,
    complexId,
  );

  return { synced: true, privArea: info.privArea, households: info.households };
}

/**
 * 월별 장기수선충당금을 실 API 에서 받아 원/㎡ 로 환산해 적재한다.
 *
 * @param {number} complexId
 * @param {string} fromYm 'YYYY-MM'
 * @param {string} toYm   'YYYY-MM'
 * @param {boolean} [force] 이미 kapt 로 받은 달도 다시 받을지
 */
export async function syncLtrfRates(complexId, fromYm, toYm, force = false) {
  const row = selComplex().get(complexId);
  if (!row) throw Object.assign(new Error('단지를 찾을 수 없습니다'), { status: 404 });
  if (!isLive()) return { filled: 0, reason: 'K-apt 키가 없습니다' };

  /* 분모가 없으면 환산 자체가 불가능하다. 기본정보를 먼저 받아 둔다. */
  let privArea = Number(row.priv_area);
  if (!(privArea > 0)) {
    const info = await syncComplexInfo(complexId);
    privArea = Number(info.privArea);
    if (!(privArea > 0))
      return { filled: 0, reason: '단지 전용면적합(privArea)을 받지 못해 환산할 수 없습니다' };
  }

  /* K-apt 는 지난 달치를 한 달 정도 늦게 공개한다. 이번 달과 앞으로의 달은 물어봐야
     항상 빈손이라 요청 자체를 하지 않는다 — 퇴거예정일이 미래인 계약은 정산 구간이
     늘 미래를 포함하므로, 막지 않으면 미리보기를 열 때마다 헛호출이 쌓인다.
     빠진 달은 엔진이 직전에 확인된 단가를 이어 쓴다(engine/ltrf.js 의 lastKnown). */
  const lastPublished = publishedThrough();
  const cap = toYm < lastPublished ? toYm : lastPublished;

  const want = fromYm > cap ? [] : monthsBetween(fromYm, cap);

  /* 이미 받은 달과 **없다고 확인된 달**을 모두 건너뛴다. 후자를 기억하지 않으면
     한 번에 받는 개월 수 상한에 걸려 같은 빈 달만 반복해서 묻게 된다. */
  const have = force
    ? new Set()
    : new Set([
      ...existingYms().all(complexId, fromYm, cap).map((r) => r.ym),
      ...absentYms().all(complexId, fromYm, cap).map((r) => r.ym),
    ]);
  const missing = want.filter((ym) => !have.has(ym));
  if (!missing.length) return { filled: 0, skipped: want.length, privArea };

  const res = await fetchLtrfRates(row.kapt_code, missing);
  const totals = res?.rates ?? [];
  const failed = res?.failed ?? 0;
  const { throttled = false, remaining = 0, absent = [] } = res ?? {};

  /* 성공 여부와 무관하게 '없는 달' 은 먼저 기록한다 — 이게 빠지면 다음 조회가
     같은 달을 또 묻고, 데이터가 있는 구간까지 내려가지 못한다. */
  if (absent.length) {
    const mark = db.transaction((list) => {
      for (const ym of list) markAbsent().run(complexId, ym);
    });
    mark(absent);
  }

  if (!totals.length) {
    return {
      filled: 0, requested: missing.length, failed, throttled, remaining, privArea,
      reason: throttled
        ? '초당 요청제한에 걸렸습니다 — 약 30초 뒤 다시 열면 이어서 받습니다'
        : failed
          ? `호출 ${failed}건이 실패했습니다`
          : `K-apt 가 이 구간(${absent[0] ?? fromYm}~${absent[absent.length - 1] ?? cap})의 `
            + '월부과액을 공개하지 않습니다',
    };
  }

  const write = db.transaction((list) => {
    for (const { ym, totalAmount } of list)
      upsertRate().run(complexId, ym, totalAmount / privArea);

    /* 한 단지 안에서 실 단가와 시드 단가를 섞지 않는다.
       실측 236원/㎡ 옆에 시드 555원/㎡ 이 끼면 정산서가 그 달만 두 배로 뛰는데,
       화면에는 둘 다 그냥 "단가"로 보여 근거를 설명할 수 없다.
       빠진 달은 엔진이 직전에 확인된 실 단가를 이어 쓰고 `imputed` 로 표시한다 —
       "추정했다"가 눈에 보이는 편이 조용히 가짜 숫자를 쓰는 것보다 낫다. */
    dropSeedRates().run(complexId);
  });
  write(totals);

  return {
    filled: totals.length,
    requested: missing.length,
    failed,
    throttled,
    remaining,
    privArea,
    sample: { ym: totals[0].ym, ratePerSqm: Number((totals[0].totalAmount / privArea).toFixed(2)) },
  };
}

/**
 * 정산 계산 직전에 부르는 지연 적재. 실패해도 조용히 넘어간다.
 * 이미 받아 둔 달은 건너뛰므로 두 번째 조회부터는 호출이 없다.
 */
export async function ensureLtrfRates(complexId, fromYm, toYm) {
  if (!isLive()) return null;
  try {
    return await syncLtrfRates(complexId, fromYm, toYm);
  } catch (err) {
    console.warn(`[kapt] 단가 적재 실패 — 있는 단가로 계산합니다: ${err.message}`);
    return null;
  }
}

/**
 * 전국 단지 목록을 받아 complexes 에 캐시한다.
 *
 * 목록 API 에는 단지명 검색 파라미터가 없어서, 실데이터로 검색하려면 한 번 받아
 * 두는 수밖에 없다. 1,000건씩 약 23페이지, 20초 안팎이 걸린다.
 *
 * 호출 수로 보면 가벼운 편이다 — 전국을 다 받아도 **23회**로, 개발계정 일일 한도
 * 5,000건의 0.5% 다. 페이지당 응답이 0.5초쯤 걸려 그 자체가 속도 조절이 되고,
 * 연속 5페이지를 실측했을 때 초당 요청제한에 걸리지 않았다 (2026-09-22).
 * 다만 **사용자 동작마다 부르지 말 것** — 한 번 받아 두고 로컬에서 검색한다.
 */
export async function syncComplexList({ maxPages = 40, pageSize = 1000, onProgress } = {}) {
  if (!isLive()) return { synced: 0, reason: 'K-apt 키가 없습니다' };

  let page = 1;
  let synced = 0;
  let totalCount = 0;

  while (page <= maxPages) {
    const res = await fetchComplexPage(page, pageSize);
    if (!res?.items.length) break;
    totalCount = res.totalCount;

    const write = db.transaction((items) => {
      for (const it of items)
        upsertComplexByCode().run(it.kaptCode, it.name, it.address, it.sido, it.sigungu, it.bjdCode);
    });
    write(res.items);

    synced += res.items.length;
    onProgress?.({ page, synced, totalCount });
    if (synced >= totalCount) break;
    page += 1;
  }

  return { synced, totalCount };
}
