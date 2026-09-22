import { enumerateMonths, occupancyFactor } from './dates.js';

/**
 * 장기수선충당금 대납액 산출
 *
 * 법적 근거: 공동주택관리법 제30조 / 동법 시행령 제31조 제8항
 *   - 부담 주체는 소유자(임대인)
 *   - 관리규약에 따라 임차인이 관리비와 함께 대납하는 것이 일반적
 *   - 임대차 종료 시 임차인은 소유자에게 반환을 청구할 수 있음
 *
 * 이 함수가 대체하는 것: "이사 당일 관리사무소에서 납부확인서 발급받기"
 *   → K-apt 월별 공개단가 × 전용면적 × 점유월 로 자동 재구성한다.
 *
 * @param {object} p
 * @param {string} p.moveIn   'YYYY-MM-DD'
 * @param {string} p.moveOut  'YYYY-MM-DD'
 * @param {number} p.area     전용면적(㎡)
 * @param {Array<{ym:string, ratePerSqm:number}>} p.rates 월별 단가
 * @param {boolean} p.prorateEdge 입주월/퇴거월 일할 여부
 * @param {'landlord'|'tenant'} p.burden 특약상 부담 주체
 */
export function computeLtrf({ moveIn, moveOut, area, rates, prorateEdge = true, burden = 'landlord' }) {
  const rateMap = new Map(rates.map((r) => [r.ym, Number(r.ratePerSqm)]));
  const months = enumerateMonths(moveIn, moveOut);

  // 특정 월의 단가가 비면 직전에 확인된 단가를 이어 쓴다(K-apt 결측 대비).
  let lastKnown = null;
  const breakdown = [];
  let total = 0;
  let imputedCount = 0;

  for (const m of months) {
    let rate = rateMap.get(m);
    let imputed = false;
    if (rate == null) {
      if (lastKnown == null) continue;
      rate = lastKnown;
      imputed = true;
      imputedCount += 1;
    } else {
      lastKnown = rate;
    }

    const factor = occupancyFactor(m, moveIn, moveOut, prorateEdge);
    const amount = Math.round(rate * area * factor);
    total += amount;
    breakdown.push({
      ym: m,
      ratePerSqm: Number(rate.toFixed(2)),
      area,
      occupancyFactor: Number(factor.toFixed(4)),
      amount,
      imputed,
    });
  }

  // 임차인 부담 특약이 있으면 반환 대상이 아니다 (금액은 참고용으로 보존).
  const refundable = burden === 'landlord';
  const amount = refundable ? total : 0;

  /**
   * 0원일 때 **왜** 0원인지 남긴다.
   *
   * 예전에는 0원 줄을 화면에서 통째로 지웠는데, 그러면 세 가지가 구분되지 않는다:
   * 해당 없음 / 계산했더니 0원 / **계산을 못 했음**.
   * 이 항목은 이 제품이 대체하려는 "관리사무소 납부확인서" 그 자체라, 항목이 사라지면
   * 확인했다는 사실 자체가 전달되지 않는다.
   *
   * K-apt 는 단지에 따라 월 부과액을 `sLevy: 0` 으로 공개한다(임대·공공 단지에서 잦다).
   * 오류가 아니라 정상 응답이라 호출 쪽에서는 구분이 안 되고, 결과만 보면 "단가 없음"이다.
   */
  /**
   * ⚠ **부분 집계를 완전한 숫자처럼 내놓지 않는다.**
   *
   * K-apt 는 단지에 따라 최근 몇 년치만 공개한다. 거주 60개월 중 16개월만 단가가
   * 있으면 합계는 그 16개월분일 뿐인데, 화면에는 그냥 '장기수선충당금 반환'으로
   * 보인다. 임차인이 덜 받고도 알 수 없는 상태라, 금액이 나와도 구간이 모자라면
   * 그 사실을 함께 내보낸다.
   */
  const partial = amount !== 0 && breakdown.length < months.length;

  const status = amount !== 0 ? (partial ? 'partial' : 'counted')
    : !refundable ? 'none'
      : breakdown.length === 0 ? 'unavailable' : 'none';

  const reason = status === 'counted' ? null
    : partial
      ? `거주 ${months.length}개월 중 ${breakdown.length}개월분만 계산했습니다 — `
        + `K-apt 가 ${months[0]}부터의 부과액을 공개하지 않습니다. `
        + '나머지 기간은 관리사무소 고지서로 확인해 주세요.'
      : !refundable ? '임차인 부담 특약이라 반환 대상이 아닙니다'
        : breakdown.length === 0
          ? 'K-apt 가 이 단지의 월 부과액을 공개하지 않아(0원) 계산하지 못했습니다. '
            + '관리사무소 고지서의 단가를 넣으면 반영됩니다.'
          : '거주 기간 동안 부과된 금액이 없습니다';

  return {
    kind: 'ltrf',
    label: '장기수선충당금 대납액 반환',
    direction: 'tenant_credit',
    amount,
    status,
    reason,
    basis: {
      legalBasis: '공동주택관리법 시행령 제31조 제8항',
      burden,
      refundable,
      monthsCounted: breakdown.length,
      tenancyMonths: months.length,
      imputedMonths: imputedCount,
      grossIfRefundable: total,
      note: refundable
        ? 'K-apt 월별 공개 단가 × 전용면적 × 점유비율의 합계'
        : '임차인 부담 특약이 설정되어 반환 대상에서 제외됨',
      breakdown,
    },
  };
}
