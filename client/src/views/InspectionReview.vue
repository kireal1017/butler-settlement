<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, won } from '../api.js';

const props = defineProps({ id: { type: String, required: true } });
const router = useRouter();

const data = ref(null);
const loading = ref(true);
const error = ref('');
const busy = ref(false);
const saved = ref(false);

/** 화면에서 편집 중인 항목들 — 저장할 때 통째로 서버에 보낸다 */
const items = ref([]);

onMounted(async () => {
  try {
    data.value = await api.inspection(props.id);
    items.value = data.value.inspection.damages.map((d) => ({
      description: d.description,
      faultRatio: d.fault_ratio,
      quotedCost: d.quoted_cost ?? '',
      ruleItemId: d.rule_item_id ?? '',
      photoId: d.photo_id ?? '',
    }));
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
});

const inspection = computed(() => data.value?.inspection);
const contract = computed(() => data.value?.contract);

const AREA_LABEL = computed(() =>
  Object.fromEntries((inspection.value?.areas ?? []).map((a) => [a.key, a.label])));

const photoLabel = (photoId) => {
  const p = inspection.value?.photos.find((x) => x.id === photoId);
  return p ? `${AREA_LABEL.value[p.area] ?? p.area}${p.note ? ` · ${p.note}` : ''}` : '';
};

/**
 * 귀책비율 — 임차인이 얼마나 책임지는가.
 * 0 은 통상손모(임대인 부담)라는 뜻이고, 그 항목도 기록에 남긴다.
 * 빼 버리면 임차인이 "왜 이 항목은 아예 없지?" 를 묻게 되고 합의가 늦어진다.
 */
const RATIOS = [
  { value: 0, label: '0% — 통상손모 (임대인 부담)' },
  { value: 0.3, label: '30% — 일부 귀책' },
  { value: 0.5, label: '50% — 절반 귀책' },
  { value: 0.7, label: '70% — 상당 부분 귀책' },
  { value: 1, label: '100% — 전적 귀책' },
];

function addItem(photoId = '') {
  const photo = inspection.value?.photos.find((p) => p.id === photoId);
  items.value.push({
    description: photo?.note ?? '',
    faultRatio: 0,
    quotedCost: '',
    ruleItemId: '',
    photoId,
  });
  saved.value = false;
}

const removeItem = (i) => { items.value.splice(i, 1); saved.value = false; };

const incomplete = computed(() => items.value.some((it) => !it.description.trim()));

async function save() {
  busy.value = true;
  error.value = '';
  try {
    const res = await api.reviewInspection(inspection.value.id, items.value);
    data.value = { ...data.value, inspection: res };
    saved.value = true;
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
</script>

<template>
  <div v-if="loading" class="card"><div class="empty">불러오는 중…</div></div>
  <div v-else-if="!inspection" class="notice">{{ error }}</div>

  <template v-else>
    <div class="head">
      <div>
        <h1>퇴거 점검 검토</h1>
        <p class="muted">
          {{ contract.tenant_name }} · {{ contract.complex_name }}
          {{ contract.dong }} {{ contract.ho }} · 퇴거 예정 {{ contract.move_out_date }}
        </p>
      </div>
      <div class="head-right">
        <span class="pill" :class="inspection.status === 'reviewed' ? 'ok' : 'accent'">
          {{ inspection.status === 'reviewed' ? '검토 완료' : '검토 대기' }}
        </span>
        <RouterLink :to="`/contracts/${id}`"><button class="btn btn-sm">계약으로</button></RouterLink>
      </div>
    </div>

    <div v-if="error" class="notice" style="margin-bottom:16px">{{ error }}</div>

    <!-- 임차인이 올린 사진 -->
    <div class="card">
      <div class="card-head">
        <h2>임차인이 올린 사진</h2>
        <span class="faint">
          {{ inspection.photos.length }}장 · 제출 {{ inspection.submittedAt ?? '—' }}
        </span>
      </div>
      <div class="shots">
        <figure v-for="p in inspection.photos" :key="p.id">
          <img :src="api.photoUrl(p.id)" :alt="AREA_LABEL[p.area] ?? p.area" />
          <figcaption>
            <strong>{{ AREA_LABEL[p.area] ?? p.area }}</strong>
            <span v-if="p.note" class="faint">{{ p.note }}</span>
            <button class="btn btn-sm" @click="addItem(p.id)">이 사진으로 항목 추가</button>
          </figcaption>
        </figure>
      </div>
    </div>

    <!-- 항목별 귀책비율 -->
    <div class="card">
      <div class="card-head">
        <h2>항목별 책임 범위</h2>
        <span class="faint">공제액 = 교체비용 × 남은 수명 비율 × 귀책비율</span>
      </div>

      <div v-if="!items.length" class="empty">
        아직 지정한 항목이 없습니다. 위 사진에서 <strong>항목 추가</strong>를 누르거나
        아래에서 직접 추가하세요.
      </div>

      <table v-else>
        <thead>
          <tr>
            <th style="width:260px">내용</th>
            <th style="width:180px">관련 품목</th>
            <th style="width:230px">귀책비율</th>
            <th style="width:140px">견적 (선택)</th>
            <th style="width:170px">사진</th>
            <th style="width:60px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(it, i) in items" :key="i">
            <td><input v-model="it.description" placeholder="예: 거실 벽지 찢김" /></td>
            <td>
              <select v-model="it.ruleItemId">
                <option value="">해당 없음</option>
                <option v-for="ri in inspection.ruleItems" :key="ri.id" :value="ri.id">
                  {{ ri.label }}
                </option>
              </select>
            </td>
            <td>
              <select v-model.number="it.faultRatio">
                <option v-for="r in RATIOS" :key="r.value" :value="r.value">{{ r.label }}</option>
              </select>
            </td>
            <td><input v-model="it.quotedCost" type="number" class="mono" placeholder="원" /></td>
            <td>
              <select v-model.number="it.photoId">
                <option value="">없음</option>
                <option v-for="p in inspection.photos" :key="p.id" :value="p.id">
                  {{ photoLabel(p.id) }}
                </option>
              </select>
            </td>
            <td><button class="btn btn-sm" @click="removeItem(i)">삭제</button></td>
          </tr>
        </tbody>
      </table>

      <div class="card-body actions">
        <button class="btn" @click="addItem()">항목 추가</button>
        <div class="right">
          <span v-if="saved" class="pill ok">저장됨</span>
          <button class="btn btn-primary" :disabled="busy || incomplete" @click="save">
            검토 결과 저장
          </button>
        </div>
      </div>
      <p v-if="incomplete" class="notice" style="margin:0 var(--sp-lg) var(--sp-lg)">
        내용이 비어 있는 항목이 있습니다.
      </p>
    </div>

    <p class="disclaimer">
      여기서 지정한 귀책비율이 정산서의 원상회복 공제 계산에 그대로 들어갑니다.
      금액은 법적 판정이 아니라 계약 시점에 양측이 확정한 규칙에 따른
      <strong>합의 참조값</strong>입니다.
    </p>

    <div v-if="saved" class="card">
      <div class="card-body next">
        <div>
          <h3>다음 — 정산서 발행</h3>
          <p class="faint">
            지정한 항목과 Rule Lock, 공공데이터를 근거로 정산서가 계산됩니다.
          </p>
        </div>
        <button class="btn btn-primary" @click="router.push(`/contracts/${id}/settlement`)">
          정산서로
        </button>
      </div>
    </div>
  </template>
</template>

<style scoped>
.head {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--sp-lg); margin-bottom: var(--sp-lg);
}
.head .muted { margin: var(--sp-xxs) 0 0; font-size: 15px; }
.head-right { display: flex; align-items: center; gap: var(--sp-sm); flex: none; }

/* 데스크톱 고정 4열 — auto-fill 을 쓰지 않는다 */
.shots {
  display: grid; grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-md); padding: var(--sp-md) var(--sp-lg) var(--sp-lg);
}
.shots figure { margin: 0; }
.shots img {
  display: block; width: 100%; height: 150px; object-fit: cover;
  border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-2);
}
.shots figcaption { display: grid; gap: var(--sp-xxs); margin-top: var(--sp-xs); }
.shots figcaption strong { font-size: 14px; font-weight: 600; }
.shots figcaption .btn { justify-self: start; }

td input, td select { width: 100%; }

.actions { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-md); }
.actions .right { display: flex; align-items: center; gap: var(--sp-sm); }

.disclaimer {
  margin: var(--sp-md) 0; padding: 16px;
  background: var(--surface-2); border-radius: var(--radius-md);
  font-size: 13px; line-height: 1.7; color: var(--text-dim);
}

.next { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-lg); }
.next h3 { margin-bottom: 2px; }
.next p { margin: 0; }
</style>
