import { parseKoreanAmount, parseArabicAmount } from './koreanAmount.js';

/**
 * 주택임대차표준계약서 파서 (docs/CONTRACT-OCR-PLAN.md)
 *
 * 이 파서가 하는 일은 **타이핑을 줄이는 것**이지 계약 조건을 확정하는 것이 아니다.
 * 그래서 모든 필드에 `high | medium | low` 를 달아 돌려주고, 확신이 없으면
 * 값을 채우지 않고 비운다. 조용히 하나를 고르는 것이 가장 위험하다 (§5).
 *
 * Rule Lock 항목(도배 면제기간·지연이자율·선수관리비)은 **뽑지 않는다.**
 * 법무부 표준계약서에 해당 칸 자체가 없어서 읽을 대상이 없다 (§1 범위 밖).
 *
 * OCR 은 글자 사이 공백이 튀므로 고정 문자열 사이마다 \s* 를 넣는다
 * (registry.js 와 같은 원칙).
 */

/* ── 섹션 자르기 (§4.1) ─────────────────────────────────────
   표준계약서에는 금액처럼 보이는 것이 세 군데 더 있다. 자르지 않으면 반드시 틀린다.
     · [계약내용] 앞  — 확정일자 부여현황의 **갱신 전 계약** 보증금
     · 제12조         — 중개보수 '거래 가액의 %인 원'
     · 별지1          — 신고의무 안내 '보증금 6천만원 또는 월차임 30만원' */

const sections = (text) => {
  const src = String(text ?? '');
  const head = src.split(/\[\s*계\s*약\s*내\s*용\s*\]/);
  const front = head[0] ?? src;                      // 이름·세대는 여기서 찾는다
  const body = head[1] ?? src;
  const terms = body.split(/제\s*3\s*조/)[0] ?? body; // 제12조·별지1 제거
  const money = terms.split(/지불하기로\s*한다/)[1] ?? terms; // 제1조 제목의 '보증금' 제외
  return { front, terms, money };
};

/* ── 추출 정규식 (§4.2 · §4.4 · §4.5) ───────────────────── */

/** '보증금'에서 '금'이 탈락한 실측 사례가 있으므로 금? 로 둔다 */
const DEPOSIT = /보\s*증\s*금?\s*([^원\n]{0,40}?)\s*원\s*정\s*\(\s*[\\₩\s]*([0-9,\s]*)\)/;
const RENT = /차\s*임\s*\(\s*월\s*세\s*\)\s*[|｜]?\s*금?\s*([^원\n]{0,40}?)\s*원\s*정/;

/* 밑줄·따옴표·물결 잡음이 숫자 앞뒤에 낀다 — 실측 그대로 허용한다 */
const HANDOVER = /상\s*태\s*로[\s_"'~]*(\d{4})\s*년[\s_"'~]*(\d{1,2})\s*월[\s_"'~]*(\d{1,2})\s*일\s*까\s*지/;
const EXPIRY = /인\s*도\s*일\s*로\s*부\s*터[\s_"'~]*(\d{4})\s*년[\s_"'~]*(\d{1,2})\s*월[\s_"'~]*(\d{1,2})[\s_"'~]*일\s*까\s*지/;

const PARTIES = /임\s*대\s*인\s*\(\s*([가-힣]{2,5})[^)]*\)\s*과?\s*임\s*차\s*인\s*\(\s*([가-힣]{2,5})/;
const UNIT = /제\s*([0-9]{1,4})\s*동\s*제\s*[0-9]+\s*층\s*제\s*([0-9]{1,5})\s*호/;
const LEASED_PART = /임\s*차\s*할\s*부\s*분/;
const AREA = /([0-9]{1,3}\.[0-9]{1,2})/;

/* ── 값 만들기 ─────────────────────────────────────────── */

const field = (value, confidence, source = {}) => ({ value, confidence, source });
const blank = (source = {}) => field(null, 'low', source);

/**
 * 보증금 — 한글값과 숫자값을 **각각** 읽어 대조한다 (§5).
 *
 * 둘이 다르면 값을 채우지 않고 두 후보를 함께 돌려준다. 실측에서 숫자 쪽
 * 앞자리가 역슬래시에 먹혀 4,500만원이 500만원이 된 적이 있다 — 그때 한쪽을
 * 골라 넣었다면 계약서가 조용히 틀린 채로 저장됐을 것이다.
 */
function readDeposit(money) {
  const m = money.match(DEPOSIT);
  if (!m) return blank();

  const hangul = m[1]?.trim() || null;
  const arabic = m[2]?.trim() || null;
  const kv = parseKoreanAmount(hangul);
  const av = parseArabicAmount(arabic);
  const source = { hangul, arabic };

  if (kv != null && av != null)
    return kv === av ? field(kv, 'high', source) : blank(source);
  if (kv != null) return field(kv, 'medium', source);
  if (av != null) return field(av, 'medium', source);
  return blank(source);
}

/**
 * 월 차임 — 괄호 병기가 없는 서식이라 한글값만 나온다.
 *
 * ⚠ 미추출을 `0(전세)` 로 단정하지 않는다. 표 안의 빈칸과 인식 실패는
 *   텍스트만으로 구분되지 않는다 (§2-④). 사용자가 보고 정해야 한다.
 */
function readRent(money) {
  const m = money.match(RENT);
  const hangul = m?.[1]?.trim() || null;
  if (!hangul) return blank();
  const v = parseKoreanAmount(hangul);
  return v == null ? blank({ hangul }) : field(v, 'high', { hangul });
}

const pad = (n) => String(n).padStart(2, '0');

/** 달력에 실재하는 날짜인가. '2026-06-31' 은 여기서 걸린다 (§4.4-1). */
function toDate(y, m, d) {
  const dt = new Date(Number(y), Number(m) - 1, Number(d));
  const ok = dt.getFullYear() === Number(y)
    && dt.getMonth() === Number(m) - 1
    && dt.getDate() === Number(d);
  return ok ? { iso: `${y}-${pad(m)}-${pad(d)}`, dt } : null;
}

const matchDate = (text, re) => {
  const m = text.match(re);
  if (!m) return { found: null, raw: null };
  return { found: toDate(m[1], m[2], m[3]), raw: m[0].replace(/\s+/g, ' ').trim() };
};

/**
 * 입주일과 계약 기간.
 *
 * 기간 역산은 **만료일 + 1일** 을 기준으로 센다. 표준계약서의 만료일은
 * 관행상 '시작일 하루 전'이라, 2022-09-01 ~ 2026-08-31 은 47개월이 아니라
 * 48개월이다. 이 프로젝트의 계약 만료일 계산(engine·NewContract)도 같은 식이라
 * 여기서 다르게 세면 저장하는 순간 만료일이 하루 어긋난다.
 *
 * ※ 계획서 §4.4 의 코드 조각은 `(ey-hy)*12 + (em-hm)` 뒤에 하루 보정을 빼는
 *   방식이라 위 예시에서 47 이 나온다. 같은 문서의 기대값(48)과 어긋나므로
 *   기대값 쪽을 따랐다.
 */
function readTerm(terms) {
  const h = matchDate(terms, HANDOVER);
  const e = matchDate(terms, EXPIRY);

  const moveInDate = h.found
    ? field(h.found.iso, 'high', { raw: h.raw })
    : blank(h.raw ? { raw: h.raw } : {});

  if (!h.found || !e.found) {
    const source = e.raw ? { expiryRaw: e.raw } : {};
    return { moveInDate, termMonths: blank(source) };
  }

  /* 만료일 다음 날이 '시작일 + N개월' 이어야 한다 */
  const end = new Date(e.found.dt);
  end.setDate(end.getDate() + 1);

  let months = (end.getFullYear() - h.found.dt.getFullYear()) * 12
    + (end.getMonth() - h.found.dt.getMonth());
  if (end.getDate() < h.found.dt.getDate()) months -= 1;

  /* 기간 상식 — 6~120개월 밖이면 어느 한쪽 숫자를 잘못 읽은 것이다 (§4.4-2) */
  const source = { expiry: e.found.iso, raw: e.raw };
  if (!(months >= 6 && months <= 120)) return { moveInDate, termMonths: blank(source) };

  /* 날짜가 딱 떨어지면 high, 단수 개월이면 눈으로 확인하게 medium */
  const exact = end.getDate() === h.found.dt.getDate();
  return { moveInDate, termMonths: field(months, exact ? 'high' : 'medium', source) };
}

/** 이름 · 동 · 호 · 전용면적 — [계약내용] 앞 구역에서만 찾는다 */
function readParties(front) {
  const p = front.match(PARTIES);
  const u = front.match(UNIT);

  /* 토지 면적(12,458.3)과 건물 면적(84.95)이 같은 구역에 있다.
     '임차할부분' 행으로 한 번 더 자른 뒤에 찾아야 한다 — 등기부와 같은 함정이다. */
  const leased = front.split(LEASED_PART)[1] ?? '';
  const area = leased.match(AREA)?.[1];

  return {
    landlordName: p ? field(p[1], 'high') : blank(),
    tenantName: p ? field(p[2], 'high') : blank(),
    dong: u ? field(u[1], 'high') : blank(),
    ho: u ? field(u[2], 'high') : blank(),
    /* 면적은 K-apt·등기부 값을 우선하므로 medium 을 넘지 않는다 (§9-4) */
    exclusiveArea: area ? field(Number(area), 'medium') : blank(),
  };
}

/* ── 개인정보 (§7) ─────────────────────────────────────── */

/** 계약서 3페이지에는 주민등록번호가 있다. 응답을 만들 때 2중으로 지운다. */
export const maskSensitive = (text) =>
  String(text ?? '').replace(/(\d{6})\s*-\s*\d{7}/g, '$1-*******');

/* ── 진입점 ────────────────────────────────────────────── */

/**
 * @param {string} text OCR 원문
 * @returns {{ fields: object, warnings: string[] }}
 *   파싱에 실패해도 던지지 않는다. 수동 입력이 항상 기본값이다 (§6).
 */
export function parseContract(text) {
  const { front, terms, money } = sections(maskSensitive(text));

  const fields = {
    deposit: readDeposit(money),
    monthlyRent: readRent(money),
    ...readTerm(terms),
    ...readParties(front),
  };

  const warnings = [];
  if (fields.deposit.confidence === 'low') {
    const { hangul, arabic } = fields.deposit.source;
    warnings.push(hangul && arabic
      ? `보증금이 한글(${hangul})과 숫자(${arabic})로 다르게 읽혔습니다. 계약서를 보고 직접 입력해 주세요.`
      : '보증금을 읽지 못했습니다. 직접 입력해 주세요.');
  }
  if (fields.monthlyRent.confidence === 'low')
    warnings.push('월 차임을 읽지 못했습니다. 전세 계약이면 0으로 두고, 아니면 직접 입력하세요.');
  if (fields.termMonths.confidence === 'low')
    warnings.push('계약 기간을 읽지 못했습니다. 만료일 숫자가 흔들린 사진에서 자주 생깁니다.');
  if (fields.moveInDate.confidence === 'low')
    warnings.push('입주일을 읽지 못했습니다.');

  return { fields, warnings };
}

/** 한 필드라도 건졌는가. 전부 실패면 라우터가 422 로 돌려준다. */
export const anyRecognized = (fields) =>
  Object.values(fields).some((f) => f.value != null);
