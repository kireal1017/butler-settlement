/** 날짜/기간 유틸 — 정산 계산의 모든 기간 산정은 여기를 거친다. */

export function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return { y, m, d };
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function ym(y, m) {
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** 입주일 ~ 퇴거일 사이의 부과월 목록을 만든다. */
export function enumerateMonths(moveInStr, moveOutStr) {
  const a = parseDate(moveInStr);
  const b = parseDate(moveOutStr);
  const out = [];
  let y = a.y;
  let m = a.m;
  while (y < b.y || (y === b.y && m <= b.m)) {
    out.push(ym(y, m));
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * 해당 부과월에서 임차인이 실제로 점유한 비율 (0~1).
 * 실무 관행에 맞춰 입주일과 퇴거일을 모두 "거주일"로 포함한다.
 */
export function occupancyFactor(ymStr, moveInStr, moveOutStr, prorate = true) {
  const [y, m] = ymStr.split('-').map(Number);
  const dim = daysInMonth(y, m);
  const a = parseDate(moveInStr);
  const b = parseDate(moveOutStr);

  const isFirst = y === a.y && m === a.m;
  const isLast = y === b.y && m === b.m;

  if (!prorate) return 1;
  if (isFirst && isLast) return (b.d - a.d + 1) / dim;
  if (isFirst) return (dim - a.d + 1) / dim;
  if (isLast) return b.d / dim;
  return 1;
}

/** 거주 개월 수 (소수점 포함) */
export function tenancyMonths(moveInStr, moveOutStr) {
  const a = parseDate(moveInStr);
  const b = parseDate(moveOutStr);
  const months = (b.y - a.y) * 12 + (b.m - a.m);
  const dim = daysInMonth(b.y, b.m);
  return months + (b.d - a.d) / dim;
}

/** 경과 연수 (내용연수 잔가율 계산용) */
export function elapsedYears(fromStr, toStr) {
  const from = new Date(`${fromStr}T00:00:00Z`);
  const to = new Date(`${toStr}T00:00:00Z`);
  return (to - from) / (365.25 * 24 * 3600 * 1000);
}
