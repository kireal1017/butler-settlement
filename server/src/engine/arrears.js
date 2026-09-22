/** 미납 차임 + 합의 지연이자 */
export function computeArrears({ arrears, lateInterestRate }) {
  const principal = arrears.reduce((s, a) => s + a.amount, 0);
  const interest = arrears.reduce(
    (s, a) => s + (a.amount * (lateInterestRate / 100) * a.overdue_days) / 365,
    0,
  );

  /* 미납 기록이 아예 없는 것과 기록은 있는데 0원인 것을 구분해 적는다 */
  const none = arrears.length === 0 ? '등록된 미납 기록이 없습니다' : '미납 금액이 없습니다';

  return [
    {
      kind: 'rent_arrears',
      label: '미납 차임 공제',
      direction: 'landlord_deduct',
      amount: principal,
      status: principal !== 0 ? 'counted' : 'none',
      reason: principal !== 0 ? null : none,
      basis: { items: arrears },
    },
    {
      kind: 'late_interest',
      label: '연체 지연이자 공제',
      direction: 'landlord_deduct',
      amount: Math.round(interest),
      status: Math.round(interest) !== 0 ? 'counted' : 'none',
      reason: Math.round(interest) !== 0 ? null
        : arrears.length === 0 ? none : '연체 일수가 없어 지연이자가 붙지 않았습니다',
      basis: {
        rate: lateInterestRate,
        formula: '미납액 × 연이율 × 연체일수 / 365',
        items: arrears,
      },
    },
  ];
}
