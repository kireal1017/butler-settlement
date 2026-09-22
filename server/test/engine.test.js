import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enumerateMonths,
  occupancyFactor,
  tenancyMonths,
  computeLtrf,
  computeMaintenanceProrate,
  computeRestoration,
  buildSettlement,
} from '../src/engine/index.js';

test('부과월 열거 — 입주월부터 퇴거월까지 포함', () => {
  assert.deepEqual(enumerateMonths('2024-03-15', '2024-06-10'), [
    '2024-03', '2024-04', '2024-05', '2024-06',
  ]);
  assert.equal(enumerateMonths('2022-01-01', '2024-12-31').length, 36);
});

test('점유비율 — 입주월/퇴거월 일할, 중간월 1.0', () => {
  // 3월 15일 입주 → 3/15~3/31 = 17일 / 31일
  assert.equal(occupancyFactor('2024-03', '2024-03-15', '2024-06-10'), 17 / 31);
  assert.equal(occupancyFactor('2024-04', '2024-03-15', '2024-06-10'), 1);
  // 6월 10일 퇴거 → 10일 / 30일
  assert.equal(occupancyFactor('2024-06', '2024-03-15', '2024-06-10'), 10 / 30);
  // 같은 달 입퇴거
  assert.equal(occupancyFactor('2024-03', '2024-03-10', '2024-03-20'), 11 / 31);
  // 일할 해제 시 항상 1
  assert.equal(occupancyFactor('2024-03', '2024-03-15', '2024-06-10', false), 1);
});

test('장기수선충당금 — 월별 단가 × 면적 × 점유비율 합계', () => {
  const rates = [
    { ym: '2024-01', ratePerSqm: 200 },
    { ym: '2024-02', ratePerSqm: 200 },
    { ym: '2024-03', ratePerSqm: 250 },  // 인상
  ];
  const r = computeLtrf({
    moveIn: '2024-01-01',
    moveOut: '2024-03-31',
    area: 84.95,
    rates,
    prorateEdge: true,
  });
  // 1월 전월 + 2월 전월 + 3월 전월(31/31)
  const expected =
    Math.round(200 * 84.95) + Math.round(200 * 84.95) + Math.round(250 * 84.95);
  assert.equal(r.amount, expected);
  assert.equal(r.basis.breakdown.length, 3);
  assert.equal(r.direction, 'tenant_credit');
});

test('장기수선충당금 — 결측월은 직전 단가로 보간하고 imputed 표시', () => {
  const r = computeLtrf({
    moveIn: '2024-01-01',
    moveOut: '2024-03-31',
    area: 100,
    rates: [{ ym: '2024-01', ratePerSqm: 300 }], // 2,3월 결측
    prorateEdge: true,
  });
  assert.equal(r.basis.imputedMonths, 2);
  assert.equal(r.amount, 300 * 100 * 3);
});

test('장기수선충당금 — 임차인 부담 특약이면 반환액 0, 참고금액은 보존', () => {
  const r = computeLtrf({
    moveIn: '2024-01-01',
    moveOut: '2024-02-29',
    area: 100,
    rates: [{ ym: '2024-01', ratePerSqm: 300 }, { ym: '2024-02', ratePerSqm: 300 }],
    burden: 'tenant',
  });
  assert.equal(r.amount, 0);
  assert.equal(r.basis.grossIfRefundable, 60000);
  assert.equal(r.basis.refundable, false);
});

test('관리비 일할 — 선납액이 부담분보다 크면 환급 방향', () => {
  const r = computeMaintenanceProrate({
    moveOut: '2024-06-10',
    area: 84.95,
    ratePerSqm: 2500,
    prepaid: 250000,
  });
  const full = Math.round(2500 * 84.95);          // 212,375
  const share = Math.round((full * 10) / 30);     //  70,792
  assert.equal(r.basis.tenantShare, share);
  assert.equal(r.direction, 'tenant_credit');
  assert.equal(r.amount, 250000 - share);
});

test('관리비 일할 — 선납 없으면 미납분 공제 방향', () => {
  const r = computeMaintenanceProrate({
    moveOut: '2024-06-10', area: 84.95, ratePerSqm: 2500, prepaid: 0,
  });
  assert.equal(r.direction, 'landlord_deduct');
  assert.ok(r.amount > 0);
});

test('원상회복 — 잔가율이 공제액을 깎는다 (판례 흐름 반영)', () => {
  const ruleItems = [{
    id: 1, category: 'wallpaper', label: '전체 도배',
    useful_life_years: 6, last_renewed_on: '2019-01-01',
    replacement_cost: 1_000_000, grace_applicable: 1,
  }];
  // 경과 5년 → 잔가율 1/6, 귀책 100%
  const r = computeRestoration({
    moveIn: '2023-06-01',
    moveOut: '2024-01-01',
    damages: [{ rule_item_id: 1, description: '낙서 훼손', fault_ratio: 1, quoted_cost: null }],
    ruleItems,
    rules: { wallpaperGraceMonths: 24, flooringGraceMonths: 24 },
  });
  const line = r.basis.lines[0];
  assert.ok(Math.abs(line.residualRatio - 1 / 6) < 0.01);
  assert.ok(r.amount > 150_000 && r.amount < 180_000);  // 100만 × 약 1/6
});

test('원상회복 — 면제기간 이상 거주하면 0원', () => {
  const ruleItems = [{
    id: 1, category: 'wallpaper', label: '전체 도배',
    useful_life_years: 6, last_renewed_on: '2023-01-01',
    replacement_cost: 1_000_000, grace_applicable: 1,
  }];
  const r = computeRestoration({
    moveIn: '2023-01-01',
    moveOut: '2025-02-01',   // 25개월 거주 ≥ 면제 24개월
    damages: [{ rule_item_id: 1, description: '생활 변색', fault_ratio: 1, quoted_cost: null }],
    ruleItems,
    rules: { wallpaperGraceMonths: 24, flooringGraceMonths: 24 },
  });
  assert.equal(r.amount, 0);
  assert.equal(r.basis.lines[0].exempted, true);
});

test('원상회복 — 통상손모(귀책 0)는 공제되지 않는다', () => {
  const ruleItems = [{
    id: 1, category: 'flooring', label: '장판',
    useful_life_years: 6, last_renewed_on: '2024-01-01',
    replacement_cost: 800_000, grace_applicable: 0,
  }];
  const r = computeRestoration({
    moveIn: '2024-01-01', moveOut: '2024-12-01',
    damages: [{ rule_item_id: 1, description: '가구자국', fault_ratio: 0, quoted_cost: null }],
    ruleItems,
    rules: { wallpaperGraceMonths: 24, flooringGraceMonths: 24 },
  });
  assert.equal(r.amount, 0);
});

test('전체 정산 — 상계 결과와 보증금 반환액이 일치한다', () => {
  const out = buildSettlement({
    contract: { deposit: 300_000_000, move_in_date: '2022-09-01', move_out_date: '2024-08-31' },
    area: 84.95,
    rules: {
      ltrfBurden: 'landlord',
      prorateEdgeMonths: 1,
      minorRepairThreshold: 100_000,
      wallpaperGraceMonths: 24,
      flooringGraceMonths: 24,
      lateInterestRate: 5,
      tenantPaidAdvanceFee: 0,
      advanceFeeAmount: 0,
    },
    ruleItems: [],
    ltrfRates: Array.from({ length: 24 }, (_, i) => {
      const d = new Date(Date.UTC(2022, 8 + i, 1));
      return {
        ym: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
        ratePerSqm: 210,
      };
    }),
    maintenanceRate: 2500,
    maintenancePrepaid: 0,
    damages: [],
    repairEvents: [],
    arrears: [{ ym: '2024-07', amount: 1_200_000, overdue_days: 40 }],
  });

  const { totals } = out;
  assert.equal(totals.net, totals.tenantCredit - totals.landlordDeduct);
  assert.equal(totals.depositReturn, totals.deposit + totals.net);
  // 24개월 × 210원/㎡ × 84.95㎡ ≈ 428,148원
  const ltrf = out.lines.find((l) => l.kind === 'ltrf');
  assert.ok(ltrf.amount > 420_000 && ltrf.amount < 435_000);
  // 미납차임 + 지연이자가 공제 항목으로 잡혀야 한다
  assert.ok(out.lines.some((l) => l.kind === 'rent_arrears'));
  assert.ok(out.lines.some((l) => l.kind === 'late_interest'));
});

test('거주기간 — 개월 수 계산', () => {
  assert.ok(Math.abs(tenancyMonths('2022-09-01', '2024-08-31') - 23.97) < 0.05);
});
