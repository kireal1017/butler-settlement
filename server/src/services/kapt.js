/**
 * K-apt(공동주택관리정보시스템) 공공데이터 어댑터
 *
 * 운영 전환 방법 -----------------------------------------------------
 *   1) data.go.kr 에서 아래 세 API 활용신청 (개발계정은 자동승인)
 *        - 국토교통부_공동주택 단지 목록제공 서비스        (15057332)
 *        - 국토교통부_공동주택관리비(장기수선충당금)정보서비스 (15059160)
 *        - 국토교통부_공동주택 기본 정보제공 서비스        (15058453) — privArea(전용면적합)
 *   2) 발급받은 **일반 인증키(Decoding)** 를 `server/.env` 의 KAPT_SERVICE_KEY 로 주입
 *   3) `npm run check-env` 로 실제 응답을 확인한 뒤 fetchLtrfRates() 가 실 단가를 쓴다.
 *      키가 없거나 호출이 실패하면 DB에 적재된 시드 값을 그대로 사용한다.
 *
 * 엔드포인트는 2026-09-22 에 포털 명세(Swagger)에서 직접 확인했다.
 * **버전 접미사가 붙어 있고 구버전은 폐기된다** — v3 경로(AptListService3/…)는 현재
 * `NO_OPENAPI_SERVICE_ERROR` 로 죽는다. 호출이 400 이면 키가 아니라 경로를 먼저 의심할 것.
 *
 * ⚠ 장기수선충당금 `sLevy` 는 "단지 전체 월 부과총액(원)"이라 그대로 쓸 수 없다.
 *   엔진은 원/㎡ 단가를 받으므로 **기본정보의 `privArea`(단지 전용면적합)로 나눈다.**
 *   엔진이 세대 전용면적을 곱하므로 분모도 전용면적이어야 단위가 맞는다.
 *   실제 관리규약은 공급면적 기준으로 부과하는 곳도 있어 오차가 날 수 있다 —
 *   그래서 단가는 여전히 "관리사무소 고지서로 보정 가능한 입력값"으로 둔다.
 *   환산과 적재는 services/kapt-sync.js 가 담당한다.
 */

const BASE = 'https://apis.data.go.kr/1613000';

/**
 * 호출 속도 — 2026-09-22 실측값 기준
 *
 * data.go.kr 은 일일 한도(개발계정 5,000건)와 **별도로 초당 요청제한**을 둔다.
 * 넘으면 HTTP 429 `resultCode 23 — 초당 서비스 요청제한 횟수 초과`.
 *
 *   · 목록 API(getTotalAptList4): 1,000건씩 5페이지 연속 호출 — 전부 정상(~500ms/건)
 *   · 월부과액 API: 20회 연속은 통과, 그 직후 20회는 **전부 429**
 *   · 한 번 걸리면 **약 30초** 지나야 풀린다 (25초까지 429, 30초에 회복)
 *
 * 그래서 월 단위 반복 조회만 제한을 건다. 한 번에 다 받지 않아도 되는 이유는
 * 결측 월을 다음 조회에서 이어서 채우고, 엔진이 그동안 직전 단가를 이어 쓰기 때문이다.
 */
const GAP_MS = 300;        // 월별 호출 간격
const MAX_PER_RUN = 20;    // 한 번에 받을 최대 개월 수 (실측 안전선)
const RECOVER_SEC = 30;    // 제한 해제까지 걸리는 시간

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isThrottle = (err) => /429|요청제한/.test(err?.message ?? '');

/**
 * 환경변수는 **호출 시점에** 읽는다. 모듈 최상단에서 읽으면 `.env` 로더보다 import 가
 * 먼저 평가되는 경우에 빈 값으로 굳는다 (repository 의 db.prepare 와 같은 함정).
 */
const rawKey = () => (process.env.KAPT_SERVICE_KEY || '').trim();

/**
 * data.go.kr 은 서비스키를 **Encoding / Decoding 두 가지**로 준다.
 * `URLSearchParams` 가 값을 한 번 더 인코딩하므로 Decoding 키를 넣어야 맞다.
 * Encoding 키(`%2B`, `%2F`, `%3D` 포함)를 붙여 넣으면 `%` 가 `%25` 로 이중 인코딩되어
 * 인증이 실패한다 — 이 실수가 가장 흔해서 여기서 한 번 풀어 준다.
 */
function serviceKey() {
  const key = rawKey();
  if (!/%[0-9A-Fa-f]{2}/.test(key)) return key;
  try { return decodeURIComponent(key); } catch { return key; }
}

export const isLive = () => Boolean(rawKey());

async function callApi(pathname, params) {
  const url = new URL(`${BASE}${pathname}`);
  url.searchParams.set('serviceKey', serviceKey());
  url.searchParams.set('_type', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });

  /**
   * data.go.kr 은 인증 실패·할당량 초과·폐기된 경로에 **본문에만 원인을 담아** 준다
   * (`_type=json` 을 붙여도 XML 로 올 때가 있고, HTTP 200 으로 올 때도 있다).
   * 상태코드만 보고 먼저 던지면 "K-apt API 400" 만 남아 진짜 원인이 사라진다 —
   * 실제로 이 때문에 "경로 폐기(NO_OPENAPI_SERVICE_ERROR)"를 키 문제로 오진했다.
   * 그래서 상태코드와 무관하게 본문을 먼저 읽고 메시지를 꺼낸다.
   */
  const body = await res.text();
  const fault = body.match(/<returnAuthMsg>([^<]*)</)?.[1]
    ?? body.match(/"returnAuthMsg"\s*:\s*"([^"]*)"/)?.[1]
    ?? body.match(/<errMsg>([^<]*)</)?.[1]
    ?? body.match(/"errMsg"\s*:\s*"([^"]*)"/)?.[1];

  if (!res.ok) {
    throw new Error(`K-apt API ${res.status}${fault ? ` — ${fault}` : ''}`);
  }

  if (!body.trim().startsWith('{')) {
    const msg = body.match(/<returnAuthMsg>([^<]*)</)?.[1]
      ?? body.match(/<errMsg>([^<]*)</)?.[1]
      ?? body.match(/<resultMsg>([^<]*)</)?.[1]
      ?? body.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`K-apt API 응답이 JSON 이 아닙니다 — ${msg}`);
  }

  const json = JSON.parse(body);
  const header = json?.response?.header;
  const code = header?.resultCode;
  if (code != null && String(code) !== '00')
    throw new Error(`K-apt API ${code} — ${header?.resultMsg ?? '알 수 없는 오류'}`);

  return json?.response?.body ?? null;
}

/** 응답의 items 는 배열(V4) 또는 `{item: …}`(구버전) 두 형태로 온다. 한 쪽으로 눕힌다. */
const rows = (body) => {
  const items = body?.items ?? [];
  const list = Array.isArray(items) ? items : (items.item ?? []);
  return (Array.isArray(list) ? list : [list]).filter(Boolean);
};

/**
 * 연동 확인용 최소 호출. 키워드가 필요 없어 "키가 살아 있는가"만 순수하게 본다.
 * 실패는 그대로 던진다 — 부르는 쪽(check-env)이 원인을 보여주는 것이 목적이다.
 */
export async function ping() {
  const body = await callApi('/AptListService4/getTotalAptList4', { numOfRows: 3, pageNo: 1 });
  return { totalCount: Number(body?.totalCount ?? 0), sample: rows(body) };
}

/**
 * 단지 기본정보. 미연동이면 null, 조회 실패면 예외.
 * `privArea` 가 단지 전용면적합이고, 총액 → 원/㎡ 환산의 분모다.
 */
export async function fetchComplexInfo(kaptCode) {
  if (!isLive()) return null;
  const body = await callApi('/AptBasisInfoServiceV5/getAphusBassInfoV5', { kaptCode });
  const it = body?.item ?? rows(body)[0];
  if (!it) return null;

  const num = (v) => (v == null || v === '' ? null : Number(v));
  const usedate = String(it.kaptUsedate ?? '');

  return {
    kaptCode: it.kaptCode,
    name: it.kaptName,
    address: it.kaptAddr ?? it.doroJuso ?? null,
    bjdCode: it.bjdCode ?? null,
    households: num(it.kaptdaCnt),
    builtYear: usedate.length >= 4 ? Number(usedate.slice(0, 4)) : null,
    privArea: num(it.privArea),     // 단지 전용면적합 (환산 분모)
    mgmtArea: num(it.kaptMarea),    // 관리비부과면적 (참고)
  };
}

/** 전국 단지 목록 한 페이지. 1000건까지가 안전하다 (5000건은 10초, 그 이상은 타임아웃) */
export async function fetchComplexPage(pageNo, numOfRows = 1000) {
  if (!isLive()) return null;
  const body = await callApi('/AptListService4/getTotalAptList4', { numOfRows, pageNo });
  return {
    totalCount: Number(body?.totalCount ?? 0),
    items: rows(body).map((it) => ({
      kaptCode: it.kaptCode,
      name: it.kaptName,
      sido: it.as1 ?? null,
      sigungu: it.as2 ?? null,
      address: `${it.as1 ?? ''} ${it.as2 ?? ''} ${it.as3 ?? ''} ${it.as4 ?? ''}`.replace(/\s+/g, ' ').trim(),
      bjdCode: it.bjdCode ?? null,
    })),
  };
}

/**
 * 월별 장기수선충당금 **단지 전체 월 부과총액(원)**. 미연동 시 null
 * `sLevy` 가 월부과액이다 (포털 명세 getHsmpMonthFeeInfoV3 에서 확인).
 *
 * @returns {{rates: Array<{ym:string,totalAmount:number}>, failed:number}}
 *   월 단위 실패는 건너뛰되 개수를 돌려준다 — 공개되지 않은 달(정상)과
 *   호출이 막힌 것(문제)을 부르는 쪽이 구분할 수 있어야 한다.
 */
export async function fetchLtrfRates(kaptCode, ymList, { gapMs = GAP_MS, max = MAX_PER_RUN } = {}) {
  if (!isLive()) return null;
  const out = [];
  const absent = [];
  const errors = [];
  let throttled = false;

  /**
   * **최근 달부터 묻는다.**
   *
   * 예전에는 `ymList.slice(0, max)` 로 앞(=오래된) 20개월만 물었다. K-apt 가 최근 몇 년치만
   * 공개하는 단지에서는 그 20개월이 전부 빈손이라 한 건도 못 받고, 다음 조회도 같은 달을
   * 다시 물어 **데이터가 있는 구간에 영영 닿지 못했다**
   * (실측: 경희궁의아침4단지는 2024-12부터 공개 → 2021년 입주 계약이 계속 0원).
   *
   * 최근 달이 존재할 확률이 높고, 엔진이 직전 단가를 이어 쓰므로(`engine/ltrf.js` 의
   * lastKnown) 최근 달부터 채우는 편이 화면에 먼저 의미 있는 숫자를 만든다.
   */
  const batch = [...ymList].sort((a, b) => b.localeCompare(a)).slice(0, max);

  for (const [i, ym] of batch.entries()) {
    if (i > 0) await sleep(gapMs);
    try {
      const body = await callApi('/AptRepairsCostServiceV3/getHsmpMonthFeeInfoV3', {
        kaptCode,
        searchDate: ym.replace('-', ''),
      });
      const item = body?.item ?? rows(body)[0];
      const total = Number(item?.sLevy);
      if (Number.isFinite(total) && total > 0) out.push({ ym, totalAmount: total });
      /* 공개되지 않은 달 — 부르는 쪽이 기록해 두었다가 다시 묻지 않는다 */
      else absent.push(ym);
    } catch (err) {
      /* 제한에 걸렸으면 더 쏘지 않는다. 계속 두드려도 전부 429 로 돌아오고,
         그 사이 성공할 수 있었던 달까지 실패로 만든다. */
      if (isThrottle(err)) { throttled = true; break; }
      errors.push(err.message);
    }
  }

  /* 월 단위 실패는 건너뛰지만 **조용히** 넘기지는 않는다.
     공개되지 않은 달(정상)과 호출이 막힌 것(문제)은 둘 다 "빈손"으로 끝나서,
     세어 보지 않으면 구분할 수 없다. 연속 호출이 많으면 data.go.kr 이 중간부터
     막는 일이 있는데, 그때 단가가 왜 일부만 들어왔는지 여기서만 알 수 있다. */
  if (errors.length)
    console.warn(`[kapt] 월부과액 ${batch.length}건 중 ${errors.length}건 실패 — 예: ${errors[0]}`);
  if (throttled)
    console.warn(`[kapt] 초당 요청제한에 걸려 중단했습니다 (${out.length}건 확보). `
      + `약 ${RECOVER_SEC}초 뒤 남은 달을 이어서 받습니다.`);

  /* 받는 순서(최근→과거)는 호출 전략일 뿐이다. 결과는 시간순으로 돌려준다 —
     부르는 쪽이 전략을 알아야 할 이유가 없다. */
  return {
    rates: out.sort((a, b) => a.ym.localeCompare(b.ym)),
    absent: absent.sort(),
    failed: errors.length,
    throttled,
    remaining: ymList.length - batch.length + (throttled ? batch.length - out.length - errors.length : 0),
  };
}
