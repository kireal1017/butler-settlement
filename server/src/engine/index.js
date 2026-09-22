import { computeLtrf } from './ltrf.js';
import { computeMaintenanceProrate, computeAdvanceFee } from './maintenance.js';
import { computeRestoration, computeRepairSettlement } from './restoration.js';
import { computeArrears } from './arrears.js';

export * from './dates.js';
export { computeLtrf, computeMaintenanceProrate, computeAdvanceFee, computeRestoration, computeArrears };

/**
 * 퇴거 정산서 전체 산출 — 이 프로젝트의 단일 진입점.
 *
 * 입력은 전부 "이미 조회된 값"이다. DB/네트워크에 의존하지 않는 순수 함수라
 * 단위 테스트와 재현(스냅샷 재계산)이 가능하다.
 */
export function buildSettlement(input) {
  const {
    contract,       // { deposit, move_in_date, move_out_date }
    area,           // 전용면적
    rules,          // Rule Lock (camelCase)
    ruleItems,
    ltrfRates,
    maintenanceRate,
    maintenancePrepaid = 0,
    damages = [],
    repairEvents = [],
    arrears = [],
  } = input;

  const moveIn = contract.move_in_date;
  const moveOut = contract.move_out_date;

  const lines = [
    computeLtrf({
      moveIn,
      moveOut,
      area,
      rates: ltrfRates,
      prorateEdge: Boolean(rules.prorateEdgeMonths),
      burden: rules.ltrfBurden,
    }),
    computeAdvanceFee({
      tenantPaid: rules.tenantPaidAdvanceFee,
      amount: rules.advanceFeeAmount,
    }),
    computeMaintenanceProrate({
      moveOut,
      area,
      ratePerSqm: maintenanceRate,
      prepaid: maintenancePrepaid,
    }),
    computeRestoration({ moveIn, moveOut, damages, ruleItems, rules }),
    ...computeRepairSettlement({ events: repairEvents, threshold: rules.minorRepairThreshold }),
    ...computeArrears({ arrears, lateInterestRate: rules.lateInterestRate }),
  ];

  /**
   * 0원 줄을 지우지 않는다.
   *
   * 예전에는 `.filter(l => l.amount !== 0)` 로 걷어냈는데, 그러면 "해당 없음"과
   * "계산했더니 0원"과 **"계산을 못 했음"**이 전부 똑같이 화면에서 사라진다.
   * 임차인은 장기수선충당금이 왜 안 적혀 있는지 물을 수밖에 없고, 임대인도 답할 수 없다.
   * 대신 각 항목이 `status`('counted' | 'none' | 'unavailable')와 `reason` 을 들고 온다.
   *
   * 합계는 그대로다 — 0원은 더해도 0원이다.
   */

  const tenantCredit = lines
    .filter((l) => l.direction === 'tenant_credit')
    .reduce((s, l) => s + l.amount, 0);
  const landlordDeduct = lines
    .filter((l) => l.direction === 'landlord_deduct')
    .reduce((s, l) => s + l.amount, 0);

  const net = tenantCredit - landlordDeduct;

  return {
    lines: lines.map((l, i) => ({ ...l, seq: i + 1 })),
    totals: {
      tenantCredit,
      landlordDeduct,
      net,                                   // +: 임차인이 추가로 받을 돈
      deposit: contract.deposit,
      depositReturn: contract.deposit + net, // 보증금 포함 최종 반환액
    },
  };
}
