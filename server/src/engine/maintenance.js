import { daysInMonth, parseDate } from './dates.js';

/**
 * 퇴거월 관리비 일할 정산
 *
 * 퇴거일까지를 임차인 부담으로 본다(실무 관행).
 * 선납액(prepaid)이 부담분보다 크면 환급(tenant_credit),
 * 작으면 미납분(landlord_deduct)이 된다.
 */
export function computeMaintenanceProrate({ moveOut, area, ratePerSqm, prepaid = 0 }) {
  const { y, m, d } = parseDate(moveOut);
  const dim = daysInMonth(y, m);
  const fullMonth = Math.round(ratePerSqm * area);
  const tenantShare = Math.round((fullMonth * d) / dim);
  const diff = prepaid - tenantShare;
  const amount = Math.abs(diff);

  /* 단가가 없으면 '0원' 이 아니라 '계산하지 못함' 이다. 관리비 단가는 아직
     공공데이터 활용신청 전이라 비어 있는 경우가 많다 (docs/progress.md). */
  const hasRate = Number(ratePerSqm) > 0;
  const status = amount !== 0 ? 'counted' : hasRate ? 'none' : 'unavailable';
  const reason = status === 'counted' ? null
    : hasRate
      ? '선납액과 퇴거월 부담분이 같아 주고받을 금액이 없습니다'
      : '이 단지의 관리비 단가가 없어 계산하지 못했습니다';

  return {
    kind: 'maintenance_prorate',
    label: diff >= 0 ? '퇴거월 관리비 과납분 환급' : '퇴거월 관리비 미납분 공제',
    direction: diff >= 0 ? 'tenant_credit' : 'landlord_deduct',
    amount,
    status,
    reason,
    basis: {
      ym: `${y}-${String(m).padStart(2, '0')}`,
      ratePerSqm,
      area,
      fullMonthEstimate: fullMonth,
      occupiedDays: d,
      daysInMonth: dim,
      tenantShare,
      prepaid,
      note: '퇴거일까지를 임차인 부담으로 산정 (부과총액 × 거주일수 / 해당월 일수)',
    },
  };
}

/** 선수관리비: 임차인이 대신 납부했다면 퇴거 시 반환 */
export function computeAdvanceFee({ tenantPaid, amount }) {
  const value = tenantPaid ? Math.round(amount) : 0;

  return {
    kind: 'advance_fee',
    label: '선수관리비 반환',
    direction: 'tenant_credit',
    amount: value,
    status: value !== 0 ? 'counted' : 'none',
    reason: value !== 0 ? null
      : tenantPaid
        ? '대납한 선수관리비가 0원으로 입력되어 있습니다'
        : '소유자가 납부한 선수관리비라 반환 대상이 아닙니다',
    basis: {
      tenantPaid: Boolean(tenantPaid),
      note: tenantPaid
        ? '임차인이 대납한 선수관리비 전액 반환'
        : '소유자가 납부한 선수관리비 → 반환 대상 아님',
    },
  };
}
