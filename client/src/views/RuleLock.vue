<script setup>
import { ref, onMounted, computed } from 'vue';
import { api, won, toIsoDate } from '../api.js';

const props = defineProps({ id: String });
const contract = ref(null);
const rules = ref(null);
const items = ref([]);
const msg = ref('');
const err = ref('');
const busy = ref(false);

const CATEGORIES = [
  { v: 'wallpaper', t: '도배' },
  { v: 'flooring', t: '바닥재' },
  { v: 'appliance', t: '빌트인 가전' },
  { v: 'fixture', t: '설비·집기' },
  { v: 'etc', t: '기타' },
];

const locked = computed(() =>
  Boolean(rules.value?.lockedByLandlordAt && rules.value?.lockedByTenantAt));

async function load() {
  const d = await api.contract(props.id);
  contract.value = d.contract;
  rules.value = d.rules ?? {
    ltrfBurden: 'landlord', prorateEdgeMonths: 1, minorRepairThreshold: 100000,
    wallpaperGraceMonths: 24, flooringGraceMonths: 24, lateInterestRate: 5,
    tenantPaidAdvanceFee: 0, advanceFeeAmount: 0,
  };
  items.value = d.ruleItems.map((i) => ({
    category: i.category, label: i.label, usefulLifeYears: i.useful_life_years,
    lastRenewedOn: i.last_renewed_on, replacementCost: i.replacement_cost,
    graceApplicable: Boolean(i.grace_applicable),
  }));
}
onMounted(load);

function addItem() {
  items.value.push({
    category: 'etc', label: '', usefulLifeYears: 6,
    lastRenewedOn: toIsoDate(),
    replacementCost: 0, graceApplicable: true,
  });
}

async function save(forceNewVersion = false) {
  busy.value = true; msg.value = ''; err.value = '';
  try {
    await api.putRules(props.id, { ...rules.value, items: items.value, forceNewVersion });
    await load();
    msg.value = '규칙을 저장했습니다.';
  } catch (e) { err.value = e.message; }
  finally { busy.value = false; }
}

async function lock(party) {
  busy.value = true; err.value = '';
  try { rules.value = await api.lockRules(props.id, party); }
  catch (e) { err.value = e.message; }
  finally { busy.value = false; }
}
</script>

<template>
  <div v-if="!contract" class="card"><div class="empty">불러오는 중…</div></div>
  <template v-else>
    <div class="head">
      <div>
        <h1>계약 시점 규칙 확정 — Rule Lock</h1>
        <p class="muted" style="margin:4px 0 0">
          {{ contract.complex_name }} {{ contract.dong }} {{ contract.ho }} ·
          {{ contract.landlord_name }} / {{ contract.tenant_name }}
        </p>
      </div>
      <RouterLink :to="`/contracts/${id}`">
        <button class="btn">계약 상세로</button>
      </RouterLink>
    </div>

    <div class="notice" style="margin-bottom:16px">
      여기서 정한 값은 <strong>법정 기준이 아니라 당사자 합의값</strong>입니다.
      퇴거 정산은 이 규칙을 그대로 재생해 계산되며, 양측이 잠근 뒤에는 새 버전으로만 변경됩니다.
    </div>

    <div class="card">
      <div class="card-head">
        <h2>기본 규칙</h2>
        <span class="pill" :class="locked ? 'ok' : 'warn'">
          {{ locked ? `v${rules.version} 확정됨` : '미확정' }}
        </span>
      </div>
      <div class="card-body">
        <div class="grid g3">
          <div>
            <label>장기수선충당금 부담 주체</label>
            <select v-model="rules.ltrfBurden" :disabled="locked">
              <option value="landlord">임대인 부담 (원칙 · 퇴거 시 반환)</option>
              <option value="tenant">임차인 부담 특약 (반환 없음)</option>
            </select>
            <p class="faint" style="margin:6px 0 0">공동주택관리법 시행령 제31조 제8항</p>
          </div>
          <div>
            <label>입주월·퇴거월 일할 계산</label>
            <select v-model.number="rules.prorateEdgeMonths" :disabled="locked">
              <option :value="1">일할 적용</option>
              <option :value="0">월 단위 전액</option>
            </select>
          </div>
          <div>
            <label>소액 수선 기준 (원)</label>
            <input type="number" v-model.number="rules.minorRepairThreshold" :disabled="locked" />
            <p class="faint" style="margin:6px 0 0">이하는 임차인, 초과는 임대인 부담</p>
          </div>
          <div>
            <label>도배 원상회복 면제 거주기간 (개월)</label>
            <input type="number" v-model.number="rules.wallpaperGraceMonths" :disabled="locked" />
          </div>
          <div>
            <label>바닥재 원상회복 면제 거주기간 (개월)</label>
            <input type="number" v-model.number="rules.flooringGraceMonths" :disabled="locked" />
          </div>
          <div>
            <label>연체 지연이자 (연 %)</label>
            <input type="number" step="0.1" v-model.number="rules.lateInterestRate" :disabled="locked" />
          </div>
          <div>
            <label>선수관리비 납부자</label>
            <select v-model.number="rules.tenantPaidAdvanceFee" :disabled="locked">
              <option :value="0">소유자 납부 (반환 없음)</option>
              <option :value="1">임차인 대납 (퇴거 시 반환)</option>
            </select>
          </div>
          <div>
            <label>선수관리비 금액 (원)</label>
            <input type="number" v-model.number="rules.advanceFeeAmount"
                   :disabled="locked || !rules.tenantPaidAdvanceFee" />
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>품목별 원상회복 기준</h2>
        <button class="btn btn-sm" @click="addItem" :disabled="locked">＋ 품목 추가</button>
      </div>
      <div class="card-body" style="padding:0">
        <table v-if="items.length">
          <thead>
            <tr>
              <th style="width:120px">구분</th>
              <th>품목</th>
              <th class="num" style="width:110px">내용연수(년)</th>
              <th style="width:150px">최종 시공일</th>
              <th class="num" style="width:140px">교체비용(원)</th>
              <th style="width:90px">면제규칙</th>
              <th style="width:40px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(it, i) in items" :key="i">
              <td>
                <select v-model="it.category" :disabled="locked">
                  <option v-for="c in CATEGORIES" :key="c.v" :value="c.v">{{ c.t }}</option>
                </select>
              </td>
              <td><input v-model="it.label" :disabled="locked" placeholder="예: 전체 도배" /></td>
              <td><input class="mono" type="number" step="0.5" v-model.number="it.usefulLifeYears" :disabled="locked" /></td>
              <td><input type="date" v-model="it.lastRenewedOn" :disabled="locked" /></td>
              <td><input class="mono" type="number" v-model.number="it.replacementCost" :disabled="locked" /></td>
              <td style="text-align:center">
                <input type="checkbox" v-model="it.graceApplicable" :disabled="locked" style="width:auto" />
              </td>
              <td class="num">
                <button class="btn btn-sm" @click="items.splice(i,1)" :disabled="locked">×</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">등록된 품목이 없습니다.</div>
      </div>
    </div>

    <div class="card">
      <div class="card-body actions">
        <div>
          <div v-if="msg" class="pill ok">{{ msg }}</div>
          <div v-if="err" class="pill no">{{ err }}</div>
          <div class="faint" style="margin-top:6px">
            임대인 서명 {{ rules.lockedByLandlordAt ?? '—' }} /
            임차인 서명 {{ rules.lockedByTenantAt ?? '—' }}
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" @click="save(false)" :disabled="busy || locked">저장</button>
          <button class="btn" @click="save(true)" :disabled="busy || !locked">새 버전으로 변경</button>
          <!-- 임차인 확정은 여기서 하지 않는다. 공유 링크로 전체 동의/거부를 받는다 (V2-SPEC §0) -->
          <button class="btn" :class="{'btn-primary': !rules.lockedByLandlordAt}"
                  @click="lock('landlord')" :disabled="busy || locked">임대인 확정</button>
        </div>
      </div>
    </div>
  </template>
</template>

<style scoped>
.head { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:18px; }
.actions { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; }
td input, td select { padding: 5px 8px; font-size: 13.5px; }
</style>
