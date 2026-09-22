<script setup>
import { computed } from 'vue';
import { won } from '../api.js';

const props = defineProps({ line: Object });
const b = computed(() => props.line.basis ?? {});
const kind = computed(() => props.line.kind);

const REASON = {
  ordinary_wear: { t: '통상손모', c: 'ok' },
  grace_period: { t: '거주기간 면제', c: 'ok' },
  fully_depreciated: { t: '잔존가치 0', c: 'ok' },
  charged: { t: '공제', c: 'no' },
};
</script>

<template>
  <div class="detail">
    <!-- 장기수선충당금 -->
    <template v-if="kind === 'ltrf'">
      <p class="lead">
        {{ b.note }}<br />
        <span class="faint">근거: {{ b.legalBasis }} · {{ b.monthsCounted }}개월 집계</span>
        <span v-if="b.imputedMonths" class="pill warn" style="margin-left:8px">
          결측 {{ b.imputedMonths }}개월 보간
        </span>
      </p>
      <div class="scroll">
        <table class="mini">
          <thead>
            <tr><th>부과월</th><th class="num">단가(원/㎡)</th><th class="num">전용(㎡)</th>
                <th class="num">점유비율</th><th class="num">금액</th></tr>
          </thead>
          <tbody>
            <tr v-for="m in b.breakdown" :key="m.ym" :class="{imputed: m.imputed}">
              <td class="mono">{{ m.ym }}</td>
              <td class="num mono">{{ m.ratePerSqm.toFixed(2) }}</td>
              <td class="num mono">{{ m.area }}</td>
              <td class="num mono">{{ (m.occupancyFactor * 100).toFixed(0) }}%</td>
              <td class="num mono">{{ m.amount.toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- 원상회복 -->
    <template v-else-if="kind === 'restoration'">
      <p class="lead">
        {{ b.formula }}<br />
        <span class="faint">거주 {{ b.tenancyMonths }}개월 기준 · {{ b.disclaimer }}</span>
      </p>
      <div v-for="(ln, i) in b.lines" :key="i" class="item">
        <div class="item-head">
          <strong>{{ ln.label }}</strong>
          <span class="pill" :class="REASON[ln.reason]?.c">{{ REASON[ln.reason]?.t ?? '—' }}</span>
          <span class="mono" :class="ln.amount ? 'deduct' : 'faint'">{{ won(ln.amount) }}</span>
        </div>
        <div class="faint">
          <template v-if="ln.reason === 'charged'">
            교체비용 {{ ln.cost.toLocaleString() }}원 × 잔가율 {{ (ln.residualRatio * 100).toFixed(1) }}%
            × 귀책 {{ (ln.faultRatio * 100).toFixed(0) }}%
            <span v-if="ln.usefulLifeYears">
              (최종시공 {{ ln.lastRenewedOn }}, 내용연수 {{ ln.usefulLifeYears }}년, 경과 {{ ln.elapsedYears }}년)
            </span>
          </template>
          <template v-else>{{ ln.note }}</template>
        </div>
      </div>
    </template>

    <!-- 관리비 일할 -->
    <template v-else-if="kind === 'maintenance_prorate'">
      <p class="lead">{{ b.note }}</p>
      <table class="mini kv">
        <tbody>
          <tr><td>대상월</td><td class="num mono">{{ b.ym }}</td></tr>
          <tr><td>월 부과 추정액</td><td class="num mono">{{ won(b.fullMonthEstimate) }}</td></tr>
          <tr><td>점유일</td><td class="num mono">{{ b.occupiedDays }} / {{ b.daysInMonth }}일</td></tr>
          <tr><td>임차인 부담분</td><td class="num mono">{{ won(b.tenantShare) }}</td></tr>
          <tr><td>기납부액</td><td class="num mono">{{ won(b.prepaid) }}</td></tr>
        </tbody>
      </table>
    </template>

    <!-- 수선비 정산 -->
    <template v-else-if="kind === 'repair_reimbursement' || kind === 'repair_chargeback'">
      <p class="lead faint">소액 수선 기준 {{ won(b.threshold) }} 적용</p>
      <table class="mini">
        <thead><tr><th>발생일</th><th>내용</th><th>사유</th><th class="num">금액</th></tr></thead>
        <tbody>
          <tr v-for="(e, i) in b.items" :key="i">
            <td class="mono">{{ e.occurred_on }}</td>
            <td>{{ e.description }}</td>
            <td class="faint">{{ e.reason }}</td>
            <td class="num mono">{{ e.cost.toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- 미납 차임 / 지연이자 -->
    <template v-else-if="kind === 'rent_arrears' || kind === 'late_interest'">
      <p v-if="b.formula" class="lead faint">{{ b.formula }} (연 {{ b.rate }}%)</p>
      <table class="mini">
        <thead><tr><th>해당월</th><th class="num">미납액</th><th class="num">연체일수</th></tr></thead>
        <tbody>
          <tr v-for="(a, i) in b.items" :key="i">
            <td class="mono">{{ a.ym }}</td>
            <td class="num mono">{{ a.amount.toLocaleString() }}</td>
            <td class="num mono">{{ a.overdue_days }}일</td>
          </tr>
        </tbody>
      </table>
    </template>

    <template v-else><p class="lead faint">{{ b.note ?? '세부 내역 없음' }}</p></template>
  </div>
</template>

<style scoped>
.detail { padding: 14px 4px 16px; }
.lead { margin: 0 0 12px; font-size: 13.5px; line-height: 1.6; }
.scroll { max-height: 260px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.mini { font-size: 12.5px; background: var(--surface); }
.mini th { position: sticky; top: 0; background: var(--surface); }
.mini th, .mini td { padding: 5px 10px; }
.mini tr.imputed td { color: var(--warn); }
.kv { border: 1px solid var(--border); border-radius: 8px; max-width: 380px; }
.kv td:first-child { color: var(--text-dim); }
.item { padding: 10px 0; border-top: 1px solid var(--border); }
.item:first-of-type { border-top: 0; }
.item-head { display: flex; align-items: center; gap: 9px; margin-bottom: 3px; flex-wrap: wrap; }
.item-head .mono { margin-left: auto; font-weight: 600; }
</style>
