<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';
import RegistryCheck from '../components/RegistryCheck.vue';

/**
 * 등기부 재인식.
 *
 * 집 추가 3단계에서 판정이 `parse_failed` 로 끝나도 집은 이미 만들어진 상태라
 * 그대로 집 상세로 넘어간다. 그때 다시 읽힐 경로가 없어서 '등기부를 읽지 못했습니다'
 * 가 할 일에 영영 남았다. 이 화면이 그 출구다.
 */
const props = defineProps({ id: { type: String, required: true } });
const router = useRouter();

const unit = ref(null);
const error = ref('');

onMounted(async () => {
  try { unit.value = (await api.unit(props.id)).unit; }
  catch (e) { error.value = e.message; }
});

const OWNERSHIP = {
  verified: '소유 확인됨', matched: 'OCR 대조 일치', confirmed: '임대인 확인',
  unverified: '등기부 미확인', name_mismatch: '소유자 이름 불일치',
  address_mismatch: '다른 집의 등기부', parse_failed: '등기부를 읽지 못함',
};
</script>

<template>
  <div v-if="error" class="notice">{{ error }}</div>

  <template v-else-if="unit">
    <div class="head">
      <div>
        <h1>등기부 재인식</h1>
        <p class="muted">
          {{ unit.complexName }} {{ unit.dong }} {{ unit.ho }} · 전용 {{ unit.exclusiveArea }}㎡
        </p>
      </div>
      <button class="btn" @click="router.push(`/units/${id}`)">집 상세로</button>
    </div>

    <p class="prev">
      현재 판정은 <strong>{{ OWNERSHIP[unit.ownershipStatus] ?? unit.ownershipStatus }}</strong> 입니다.
      새로 읽은 결과가 이전 판정을 대체합니다.
    </p>

    <RegistryCheck :unit-id="id" @confirmed="router.push(`/units/${id}`)" />
  </template>
</template>

<style scoped>
.head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: var(--sp-lg); margin-bottom: var(--sp-md);
}
.head .muted { margin: var(--sp-xxs) 0 0; font-size: 15px; }
.prev {
  margin: 0 0 var(--sp-md); padding: 12px 16px;
  background: var(--surface-2); border-radius: var(--radius-md);
  font-size: 14px; color: var(--text-dim);
}
</style>
