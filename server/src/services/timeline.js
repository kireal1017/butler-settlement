/**
 * 법정 · 서비스 타임라인 — 단일 진실 원천
 *
 * 주택임대차보호법 제6조의3 기준이다. 이 상수를 임의로 바꾸지 말 것.
 * 화면과 할 일(tasks) 규칙이 같은 날짜를 보게 하려고 계산을 여기 한 곳에 모았다.
 *
 * ⚠ v1 논의에서 나온 "만료 1주일 전 알림"은 틀린 설계다.
 *   그 시점엔 이미 묵시적 갱신이 끝나 있다.
 */

/** 만료 6개월 전 — 계약갱신청구권 행사 가능 기간 시작 */
export const RENEWAL_WINDOW_DAYS = 180;
/** 만료 2개월 전 — 이 날까지 갱신거절을 통지하지 않으면 묵시적 갱신 */
export const RENEWAL_NOTICE_DAYS = 60;
/** 퇴거 30일 전 — 정산서 발행 + 점검 링크 발송 (서비스 정책) */
export const SETTLEMENT_ISSUE_DAYS = 30;
/** 퇴거 7일 전 — 합의 마감 임박 (서비스 정책) */
export const AGREEMENT_DUE_DAYS = 7;

const DAY = 86_400_000;

const pad = (n) => String(n).padStart(2, '0');

export const toIso = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const startOfToday = () => new Date(new Date().setHours(0, 0, 0, 0));

/** 'YYYY-MM-DD' 를 로컬 자정으로 해석한다 (Date.parse 는 UTC 로 읽어 하루가 밀린다) */
const parseLocal = (isoDate) => new Date(`${isoDate}T00:00:00`);

/** 오늘로부터 해당 날짜까지 남은 일수. 지났으면 음수. */
export function daysUntil(isoDate, today = startOfToday()) {
  if (!isoDate) return null;
  return Math.round((parseLocal(isoDate) - today) / DAY);
}

export function shiftIso(isoDate, days) {
  const d = parseLocal(isoDate);
  d.setDate(d.getDate() + days);
  return toIso(d);
}

/** 말일 보정 포함 — 1/31 에 +1개월 하면 2/28(29) 이 된다 */
export function addMonthsIso(isoDate, months) {
  const d = parseLocal(isoDate);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return toIso(d);
}

/** 계약 만료일 = 입주일 + 기간(개월) − 1일 */
export const contractExpiry = (moveInDate, termMonths) =>
  shiftIso(addMonthsIso(moveInDate, termMonths), -1);

/**
 * 계약 하나의 시점 판단을 한 번에 계산한다.
 * contract 는 DB row(snake_case) 를 그대로 받는다.
 */
export function contractTimeline(contract, today = startOfToday()) {
  const expiresOn = contract.expires_on ?? null;
  const moveOutDate = contract.move_out_date ?? null;

  const noticeDeadline = expiresOn ? shiftIso(expiresOn, -RENEWAL_NOTICE_DAYS) : null;
  const daysToNoticeDeadline = daysUntil(noticeDeadline, today);
  const daysToExpiry = daysUntil(expiresOn, today);
  const decided = Boolean(contract.renewal_decision);

  return {
    expiresOn,
    daysToExpiry,
    moveOutDate,
    daysToMoveOut: daysUntil(moveOutDate, today),

    /** 갱신 여부를 결정해야 하는 기간에 들어왔는가 (만료 6개월 전부터) */
    renewalWindowOpen: daysToExpiry !== null && daysToExpiry <= RENEWAL_WINDOW_DAYS,
    /** 갱신거절 통지 기한 */
    noticeDeadline,
    daysToNoticeDeadline,
    /** 기한이 지났는데 아직 결정이 없으면 묵시적 갱신이 성립한다 */
    impliedRenewal: daysToNoticeDeadline !== null && daysToNoticeDeadline < 0 && !decided,
  };
}
