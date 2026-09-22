<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';
import { landlord } from '../session.js';
import RegistryCheck from '../components/RegistryCheck.vue';

const router = useRouter();

const step = ref(1);
const error = ref('');
const busy = ref(false);

/* 1 — 단지 */
const query = ref('');
const complexes = ref([]);
const chosen = ref(null);

/* 2 — 세대 */
const form = ref({ dong: '', ho: '', exclusiveArea: '' });
const unitId = ref(null);

/* 3 단계(등기부)는 RegistryCheck 컴포넌트가 통째로 맡는다 */

onMounted(async () => {
  try { complexes.value = (await api.complexes()).items; }
  catch (e) { error.value = e.message; }
});

async function search() {
  try { complexes.value = (await api.complexes(query.value)).items; }
  catch (e) { error.value = e.message; }
}

/**
 * 전국 목록 API 는 단지코드·이름·주소만 준다. 세대수·전용면적합은 기본정보 API 에만
 * 있고, 그중 전용면적합이 없으면 나중에 장기수선충당금 단가를 환산할 수 없다.
 * 그래서 선택하는 순간 한 번 받아 둔다 — 실패해도 진행은 막지 않는다.
 */
async function pickComplex(c) {
  chosen.value = c;
  step.value = 2;
  if (c.priv_area) return;

  try {
    const { info } = await api.syncComplex(c.id);
    if (info?.synced) Object.assign(c, {
      priv_area: info.privArea, total_households: info.households,
    });
  } catch { /* 기본정보는 보조 자료다. 못 받아도 집 등록은 계속한다 */ }
}

async function createUnit() {
  error.value = '';
  busy.value = true;
  try {
    const unit = await api.createUnit({
      complexId: chosen.value.id,
      landlordId: landlord.value.id,
      dong: form.value.dong || null,
      ho: form.value.ho || null,
      exclusiveArea: Number(form.value.exclusiveArea),
    });
    unitId.value = unit.id;
    step.value = 3;
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}

</script>

<template>
  <div class="head">
    <h1>집 추가</h1>
    <ol class="steps">
      <li :class="{ on: step >= 1 }">단지</li>
      <li :class="{ on: step >= 2 }">동 · 호 · 면적</li>
      <li :class="{ on: step >= 3 }">등기부 확인</li>
    </ol>
  </div>

  <div v-if="error" class="notice" style="margin-bottom:16px">{{ error }}</div>

  <!-- 1 ─ 단지 선택 -->
  <div v-if="step === 1" class="card">
    <div class="card-head">
      <h2>단지 검색</h2>
      <span class="faint">K-apt 공공데이터 기준</span>
    </div>
    <div class="card-body">
      <div class="search">
        <input v-model="query" placeholder="단지명 또는 주소" @keyup.enter="search" />
        <button class="btn" @click="search">검색</button>
      </div>
      <table style="margin-top:16px">
        <tbody>
          <tr v-for="c in complexes" :key="c.id">
            <td>
              <div style="font-weight:600">{{ c.name }}</div>
              <div class="faint">
                {{ c.address }}
                <template v-if="c.total_households"> · {{ c.total_households }}세대</template>
                <template v-if="c.built_year"> · {{ c.built_year }}년</template>
              </div>
            </td>
            <td class="num" style="width:120px">
              <button class="btn btn-sm btn-primary" @click="pickComplex(c)">선택</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!complexes.length" class="empty">
        <template v-if="query">'{{ query }}' 에 해당하는 단지가 없습니다.</template>
        <template v-else>
          <p style="margin:0 0 6px;font-weight:600;color:var(--text)">단지 목록이 비어 있습니다</p>
          <p style="margin:0">
            K-apt 전국 단지를 한 번 받아 오세요 —
            <code class="mono">POST /api/complexes/sync-list</code>
          </p>
        </template>
      </div>
    </div>
  </div>

  <!-- 2 ─ 세대 정보 -->
  <div v-else-if="step === 2" class="card">
    <div class="card-head">
      <h2>{{ chosen.name }}</h2>
      <button class="btn btn-sm" @click="step = 1">단지 다시 고르기</button>
    </div>
    <div class="card-body">
      <div class="grid g3">
        <div>
          <label>동</label>
          <input v-model="form.dong" placeholder="예시) 100동" />
        </div>
        <div>
          <label>호</label>
          <input v-model="form.ho" placeholder="예시) 1017호" />
        </div>
        <div>
          <label>전용면적 (㎡)</label>
          <input v-model="form.exclusiveArea" type="number" step="0.01" placeholder="84.95" />
        </div>
      </div>
      <p class="faint" style="margin:16px 0 0">
        전용면적은 장기수선충당금과 관리비 일할 계산의 기준값입니다. 등기부에 적힌 값과
        다르면 다음 단계에서 알려 드립니다.
      </p>
      <div style="margin-top:24px">
        <button class="btn btn-primary" :disabled="busy || !form.exclusiveArea" @click="createUnit">
          다음 — 등기부 확인
        </button>
      </div>
    </div>
  </div>

  <!-- 3 ─ 등기부 -->
  <RegistryCheck v-else :unit-id="unitId"
                 @confirmed="router.push(`/units/${unitId}`)" />
</template>

<style scoped>
.head {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--sp-lg); margin-bottom: var(--sp-lg);
}
.steps { display: flex; gap: var(--sp-xs); list-style: none; margin: 0; padding: 0; }
.steps li {
  font-size: 13px; font-weight: 500; color: var(--text-faint);
  background: var(--surface-2); padding: 6px 14px; border-radius: var(--radius-pill);
}
.steps li.on { background: var(--accent); color: var(--on-dark); }

.search { display: flex; gap: var(--sp-sm); }
.search input { flex: 1; }
.search .btn { flex: none; }
</style>
