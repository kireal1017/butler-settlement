<script setup>
import { ref, computed, onMounted } from 'vue';
import { api, won } from '../api.js';

/**
 * 계약서 — 임차인이 받은 그대로.
 *
 * 링크를 보낸 뒤 임대인이 "무엇을 보냈는지" 다시 볼 방법이 없었다. 공유 링크는
 * 임차인이 응답하면 닫히고(completed_at), 계약 상세는 지금 고칠 것들을 보여주는
 * 화면이라 '보낸 문서' 와 같지 않다. 이 화면은 읽기 전용으로 그 한 장을 보여준다.
 *
 * 임차인 화면(TenantShare)과 같은 자료를 쓰되 동의 버튼은 없다 —
 * 임대인 화면에서 임차인 동의를 대신 누르는 경로는 두지 않는다.
 */
const props = defineProps({ id: { type: String, required: true } });

const data = ref(null);
const loading = ref(true);
const error = ref('');

onMounted(async () => {
  try { data.value = await api.contract(props.id); }
  catch (e) { error.value = e.message; }
  finally { loading.value = false; }
});

const contract = computed(() => data.value?.contract);
const rules = computed(() => data.value?.rules);
const items = computed(() => data.value?.ruleItems ?? []);
const response = computed(() => data.value?.tenantResponse);

const CATEGORY = {
  wallpaper: '도배', flooring: '바닥재', appliance: '빌트인 가전',
  fixture: '설비·집기', etc: '기타',
};

const STATUS = {
  draft: '아직 보내지 않았습니다',
  pending_tenant: '임차인 확인 대기 중입니다',
  rejected: '임차인이 수정을 요청했습니다',
  active: '임차인이 동의해 성립했습니다',
  renewing: '갱신 중입니다',
  closing: '퇴거 진행 중입니다',
  closed: '종료된 계약입니다',
};

const print = () => window.print();
</script>

<template>
  <div v-if="loading" class="card"><div class="empty">불러오는 중…</div></div>
  <div v-else-if="!contract" class="notice">{{ error }}</div>

  <template v-else>
    <div class="head no-print">
      <div>
        <h1>계약서</h1>
        <p class="muted">임차인이 링크에서 본 것과 같은 내용입니다. 이 화면에서는 고칠 수 없습니다.</p>
      </div>
      <div class="head-right">
        <button class="btn" @click="print">인쇄</button>
        <RouterLink :to="`/contracts/${id}`"><button class="btn">계약 상세로</button></RouterLink>
      </div>
    </div>

    <div class="card state no-print">
      <div class="card-body">
        <strong>{{ STATUS[contract.status] ?? contract.status }}</strong>
        <p v-if="response" class="faint" style="margin:6px 0 0">
          {{ response.respondedAt }} —
          {{ response.decision === 'accepted' ? '동의' : '수정 요청' }}
          <template v-if="response.reason">· {{ response.reason }}</template>
        </p>
      </div>
    </div>

    <!-- 집 · 계약 조건 -->
    <div class="card">
      <div class="card-head"><h2>계약 조건</h2></div>
      <table>
        <tbody>
          <tr><th style="width:200px">집</th>
            <td>{{ contract.complex_name }} {{ contract.dong }} {{ contract.ho }}
              <div class="faint">{{ data.unit?.address }} · 전용 {{ contract.exclusive_area }}㎡</div></td></tr>
          <tr><th>임대인</th><td>{{ data.unit?.landlordName ?? '—' }}</td></tr>
          <tr><th>임차인</th>
            <td>{{ contract.tenant_name }}
              <span class="faint">{{ contract.tenant_phone ?? '' }}</span></td></tr>
          <tr><th>보증금</th>
            <td class="mono">{{ won(contract.deposit) }}
              <span v-if="contract.monthly_rent" class="faint">/ 월 {{ won(contract.monthly_rent) }}</span></td></tr>
          <tr><th>입주일</th><td class="mono">{{ contract.move_in_date }}</td></tr>
          <tr><th>계약 기간</th>
            <td class="mono">{{ contract.term_months }}개월 · 만료 {{ contract.expires_on ?? '—' }}</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Rule Lock -->
    <div class="card">
      <div class="card-head">
        <h2>퇴거 정산 규칙</h2>
        <span class="faint">퇴거할 때 이 규칙 그대로 계산됩니다</span>
      </div>
      <div v-if="!rules" class="card-body">
        <p class="muted" style="margin:0">규칙이 설정되지 않았습니다.</p>
      </div>
      <table v-else>
        <tbody>
          <tr><th style="width:280px">장기수선충당금</th>
            <td>{{ rules.ltrfBurden === 'landlord'
              ? '임대인 부담 — 퇴거할 때 임차인이 낸 만큼 돌려받습니다'
              : '임차인 부담 특약 — 돌려받지 않습니다' }}</td></tr>
          <tr><th>입주월·퇴거월 관리비</th>
            <td>{{ rules.prorateEdgeMonths ? '거주한 날짜만큼만 일할 계산' : '월 단위 전액' }}</td></tr>
          <tr><th>소액 수선 기준</th>
            <td class="mono">{{ won(rules.minorRepairThreshold) }}
              <span class="faint">이하는 임차인, 초과는 임대인 부담</span></td></tr>
          <tr><th>원상회복 면제 거주기간</th>
            <td class="mono">도배 {{ rules.wallpaperGraceMonths }}개월 · 바닥재 {{ rules.flooringGraceMonths }}개월
              <span class="faint">이 기간을 넘겨 살면 통상손모로 봅니다</span></td></tr>
          <tr><th>연체 지연이자</th><td class="mono">연 {{ rules.lateInterestRate }}%</td></tr>
          <tr><th>선수관리비</th>
            <td>{{ rules.tenantPaidAdvanceFee
              ? `임차인 대납 ${won(rules.advanceFeeAmount)} — 퇴거 때 반환`
              : '소유자 납부 — 반환 없음' }}</td></tr>
          <tr>
            <th>확정 서명</th>
            <td>
              <span class="pill" :class="rules.lockedByLandlordAt ? 'ok' : ''">
                임대인 {{ rules.lockedByLandlordAt ?? '미확정' }}
              </span>
              <span class="pill" :class="rules.lockedByTenantAt ? 'ok' : ''" style="margin-left:8px">
                임차인 {{ rules.lockedByTenantAt ?? '미확정' }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 품목 -->
    <div class="card">
      <div class="card-head">
        <h2>품목별 원상회복 기준</h2>
        <span class="faint">최종 시공일부터 내용연수만큼 감가합니다</span>
      </div>
      <table v-if="items.length">
        <thead>
          <tr>
            <th style="width:130px">구분</th><th>품목</th>
            <th class="num" style="width:110px">내용연수</th>
            <th style="width:150px">최종 시공일</th>
            <th class="num" style="width:150px">교체비용</th>
            <th style="width:100px">면제규칙</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="it in items" :key="it.id">
            <td>{{ CATEGORY[it.category] ?? it.category }}</td>
            <td style="font-weight:600">{{ it.label }}</td>
            <td class="num mono">{{ it.useful_life_years }}년</td>
            <td class="mono">{{ it.last_renewed_on }}</td>
            <td class="num mono">{{ won(it.replacement_cost) }}</td>
            <td>{{ it.grace_applicable ? '적용' : '미적용' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">등록된 품목이 없습니다.</div>
    </div>
  </template>
</template>

<style scoped>
.head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: var(--sp-lg); margin-bottom: var(--sp-md);
}
.head .muted { margin: var(--sp-xxs) 0 0; font-size: 15px; }
.head-right { display: flex; gap: var(--sp-sm); flex: none; }
.state { margin-bottom: var(--sp-md); }

@media print {
  .no-print { display: none; }
}
</style>
