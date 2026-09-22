import { elapsedYears, tenancyMonths } from './dates.js';

/**
 * 원상회복 공제 산출 — Rule Lock 기반
 *
 * ⚠ 설계 의도(법적 포지셔닝)
 *   이 엔진은 "법정 기준을 판정"하지 않는다. 계약 시점에 당사자가 합의해
 *   잠가둔 파라미터(내용연수·면제기간·귀책비율)를 그대로 재생할 뿐이다.
 *   판례 흐름상 통상손모는 임대인 부담이고, 원상복구 범위는 감가상각을
 *   반영한 현재가치를 넘지 못한다. 그래서 기본 계산식에 잔가율을 강제한다.
 *
 * 공제액 = 교체비용 × 잔가율 × 임차인귀책비율
 *   잔가율 = max(0, 1 − 경과연수 / 합의내용연수)
 *   단, 거주기간이 면제기간 이상이면 해당 품목은 0원
 */

const GRACE_KEY = {
  wallpaper: 'wallpaperGraceMonths',
  flooring: 'flooringGraceMonths',
};

export function computeRestoration({ moveIn, moveOut, damages, ruleItems, rules }) {
  const itemMap = new Map(ruleItems.map((i) => [i.id, i]));
  const livedMonths = tenancyMonths(moveIn, moveOut);
  const lines = [];
  let total = 0;

  for (const dmg of damages) {
    const item = itemMap.get(dmg.rule_item_id);

    // 규칙에 등록되지 않은 훼손: 견적 실비 × 귀책비율 (잔가율 적용 불가)
    if (!item) {
      const amount = Math.round((dmg.quoted_cost ?? 0) * dmg.fault_ratio);
      total += amount;
      lines.push({
        label: dmg.description,
        matchedRule: null,
        cost: dmg.quoted_cost ?? 0,
        residualRatio: 1,
        faultRatio: dmg.fault_ratio,
        exempted: false,
        amount,
        note: '규칙 미등록 품목 — 견적 실비에 귀책비율만 적용',
      });
      continue;
    }

    const graceKey = GRACE_KEY[item.category];
    const graceMonths = graceKey ? rules[graceKey] : null;
    const exempted =
      Boolean(item.grace_applicable) && graceMonths != null && livedMonths >= graceMonths;

    const cost = dmg.quoted_cost ?? item.replacement_cost;
    const yrs = elapsedYears(item.last_renewed_on, moveOut);
    const residual = Math.max(0, 1 - yrs / item.useful_life_years);
    const amount = exempted ? 0 : Math.round(cost * residual * dmg.fault_ratio);

    // 0원이 된 사유는 하나가 아니다. 어느 규칙이 작동했는지 구분해 남긴다.
    let reason;
    if (dmg.fault_ratio === 0) {
      reason = 'ordinary_wear';
    } else if (exempted) {
      reason = 'grace_period';
    } else if (residual === 0) {
      reason = 'fully_depreciated';
    } else {
      reason = 'charged';
    }

    total += amount;
    lines.push({
      label: `${item.label} — ${dmg.description}`,
      matchedRule: item.label,
      cost,
      usefulLifeYears: item.useful_life_years,
      lastRenewedOn: item.last_renewed_on,
      elapsedYears: Number(yrs.toFixed(2)),
      residualRatio: Number(residual.toFixed(4)),
      faultRatio: dmg.fault_ratio,
      exempted,
      graceMonths,
      amount,
      reason,
      note: {
        ordinary_wear: '통상손모(임차인 귀책 0%) → 임대인 부담',
        grace_period: `거주 ${livedMonths.toFixed(1)}개월 ≥ 면제기간 ${graceMonths}개월 → 원상회복 면제`,
        fully_depreciated: '내용연수 경과로 잔존가치 0 → 공제액 없음',
        charged: '교체비용 × 잔가율 × 임차인 귀책비율',
      }[reason],
    });
  }

  return {
    kind: 'restoration',
    label: '원상회복 공제',
    direction: 'landlord_deduct',
    amount: total,
    status: total !== 0 ? 'counted' : 'none',
    reason: total !== 0 ? null
      : lines.length === 0
        ? '퇴거 점검에서 지정된 항목이 없습니다'
        : '전부 통상손모 · 면제기간 · 내용연수 경과로 공제할 금액이 없습니다',
    basis: {
      tenancyMonths: Number(livedMonths.toFixed(1)),
      formula: '공제액 = 교체비용 × max(0, 1 − 경과연수/내용연수) × 임차인귀책비율',
      disclaimer:
        '법정 기준이 아니라 계약 시 양 당사자가 확정한 규칙(Rule Lock)에 따른 참조값입니다.',
      lines,
    },
  };
}

/**
 * 거주 중 수선비 정산 — 소액수선 기준(Rule Lock) 적용
 *   · 임차인이 냈는데 기준 초과 + 임차인 귀책 아님  → 임차인에게 반환
 *   · 임대인이 냈는데 기준 이하 또는 임차인 귀책     → 임차인에게서 공제
 */
export function computeRepairSettlement({ events, threshold }) {
  const credits = [];
  const deducts = [];

  for (const e of events) {
    const tenantFault = e.cause === 'tenant_fault';
    if (e.paid_by === 'tenant' && !tenantFault && e.cost > threshold) {
      credits.push({ ...e, reason: `소액기준(${threshold.toLocaleString()}원) 초과 + 임대인 수선의무` });
    } else if (e.paid_by === 'landlord' && (tenantFault || e.cost <= threshold)) {
      deducts.push({
        ...e,
        reason: tenantFault ? '임차인 귀책 수선' : `소액기준(${threshold.toLocaleString()}원) 이하`,
      });
    }
  }

  const creditTotal = credits.reduce((s, e) => s + e.cost, 0);
  const deductTotal = deducts.reduce((s, e) => s + e.cost, 0);

  /* 수선 이력 자체가 없는 것과, 있지만 이쪽에 해당하지 않는 것을 구분한다 */
  const empty = events.length === 0 ? '등록된 수선 이력이 없습니다' : null;

  return [
    {
      kind: 'repair_reimbursement',
      label: '거주 중 임차인 대납 수선비 반환',
      direction: 'tenant_credit',
      amount: creditTotal,
      status: creditTotal !== 0 ? 'counted' : 'none',
      reason: creditTotal !== 0 ? null
        : empty ?? `임차인이 낸 수선 중 소액기준(${threshold.toLocaleString()}원)을 넘는 임대인 수선의무 건이 없습니다`,
      basis: { threshold, items: credits },
    },
    {
      kind: 'repair_chargeback',
      label: '거주 중 임대인 대납 수선비 공제',
      direction: 'landlord_deduct',
      amount: deductTotal,
      status: deductTotal !== 0 ? 'counted' : 'none',
      reason: deductTotal !== 0 ? null
        : empty ?? '임대인이 낸 수선 중 임차인이 부담할 건이 없습니다',
      basis: { threshold, items: deducts },
    },
  ];
}
