<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api.js';

/**
 * 등기부 업로드 → OCR → 임대인이 눈으로 고쳐 확정.
 *
 * 집 추가 3단계와 집 상세의 '등기부 재인식' 이 같은 화면을 쓴다.
 *
 * OCR 결과를 읽기 전용 표로 보여 주던 때는, 한 칸이라도 못 읽으면 집이
 * '등기부를 읽지 못함' 에 갇혀 빠져나올 길이 없었다(실측: 소유자 미검출).
 * 그래서 **원본 이미지를 옆에 띄우고 값은 전부 입력칸으로** 둔다. 임대인이
 * 이미지를 보고 고친 뒤 확정한다.
 *
 * ⚠ 이 확정은 OCR 이 대조해 맞췄다는 뜻이 아니다. 서버가 판정을 `matched` 가 아닌
 *   **`confirmed`** 로 남기고 어떤 칸을 손으로 고쳤는지 함께 기록한다.
 */
const props = defineProps({ unitId: { type: [String, Number], required: true } });
const emit = defineEmits(['verified', 'confirmed']);

const ocrProvider = ref('fixture');
const file = ref(null);
const preview = ref(null);      // 업로드한 이미지의 objectURL
const verdict = ref(null);
const busy = ref(false);
const error = ref('');

/* 확정 전까지 임대인이 고치는 값. OCR 이 읽은 값으로 시작한다. */
const form = ref(null);

onMounted(async () => {
  try { ocrProvider.value = (await api.registrySamples()).provider; }
  catch { /* 공급자 표시는 부가 정보다. 못 받아도 업로드는 된다 */ }
});

/* objectURL 은 명시적으로 풀지 않으면 탭을 닫을 때까지 메모리에 남는다 */
function setPreview(f) {
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = f ? URL.createObjectURL(f) : null;
}
onBeforeUnmount(() => { if (preview.value) URL.revokeObjectURL(preview.value); });

function pick(e) {
  file.value = e.target.files[0] ?? null;
  setPreview(file.value);
}

async function verify() {
  error.value = '';
  busy.value = true;
  try {
    const res = await api.verifyRegistry(props.unitId, { file: file.value });
    verdict.value = res;
    form.value = {
      address: res.parsed.address ?? '',
      dong: res.parsed.dong ?? '',
      floor: res.parsed.floor ?? '',
      ho: res.parsed.ho ?? '',
      uniqueNo: res.parsed.uniqueNo ?? '',
      exclusiveArea: res.parsed.exclusiveArea ?? '',
      ownerName: res.parsed.owners?.[0] ?? '',
    };
    emit('verified', res);
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}

/* 비어 있는 칸이 하나라도 있으면 확정하지 않는다 — 빈 값으로 '확인됨' 이 되면
   나중에 무엇을 근거로 확인했는지 말할 수 없다. */
const REQUIRED = ['address', 'dong', 'ho', 'exclusiveArea', 'ownerName'];
const canConfirm = computed(() =>
  Boolean(form.value) && REQUIRED.every((k) => String(form.value[k] ?? '').trim()));

async function confirm() {
  error.value = '';
  busy.value = true;
  try {
    /* 확정하면 부모가 곧바로 집 상세로 보낸다. 여기서 '완료했습니다' 화면을 한 번 더
       띄우면 누를 것이 '집 상세로' 하나뿐이라 단계만 늘어난다. */
    emit('confirmed', await api.confirmRegistry(verdict.value.documentId, form.value));
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}

/** 다시 올릴 때 이전 파일이 남아 있으면 같은 이미지를 또 보내게 된다 */
function reset() {
  verdict.value = null;
  form.value = null;
  file.value = null;
  setPreview(null);
}

const VERDICT = {
  matched: { label: '입력값과 일치', tone: 'ok' },
  name_mismatch: { label: '소유자 이름 불일치', tone: 'warn' },
  address_mismatch: { label: '다른 집의 등기부', tone: 'no' },
  parse_failed: { label: '일부를 읽지 못함', tone: 'warn' },
};

defineExpose({ verdict, reset });
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h2>등기부등본으로 소유 확인</h2>
      <span class="pill">{{ ocrProvider === 'fixture' ? 'OCR 픽스처 모드' : `OCR ${ocrProvider}` }}</span>
    </div>

    <!-- 1 ─ 업로드 -->
    <div class="card-body" v-if="!verdict">
      <div v-if="error" class="notice" style="margin-bottom:16px">{{ error }}</div>

      <label>등기부 이미지 업로드</label>
      <input type="file" accept="image/*" @change="pick" />
      <p class="faint" style="margin-top:8px">
        집합건물 등기사항전부증명서 (png · jpg). 사진이면 정면에서 그림자 없이,
        문서가 화면을 가득 채우게 찍어 주세요.
      </p>

      <div v-if="preview" class="preview solo">
        <img :src="preview" alt="업로드한 등기부" />
      </div>

      <div style="margin-top:24px">
        <button class="btn btn-primary" :disabled="busy || !file" @click="verify">
          {{ busy ? '읽는 중…' : '등기부 확인' }}
        </button>
      </div>
    </div>

    <!-- 2 ─ 이미지 보며 값 고치기 -->
    <div class="card-body" v-else>
      <div v-if="error" class="notice" style="margin-bottom:16px">{{ error }}</div>

      <div class="verdict">
        <span class="pill" :class="VERDICT[verdict.result]?.tone ?? ''">
          {{ VERDICT[verdict.result]?.label ?? verdict.result }}
        </span>
        <span class="faint">신뢰도 {{ Math.round(verdict.confidence * 100) }}% · {{ verdict.provider }}</span>
      </div>

      <ul v-if="verdict.reasons.length" class="reasons">
        <li v-for="(reason, i) in verdict.reasons" :key="i">{{ reason }}</li>
      </ul>

      <div class="split">
        <div class="preview">
          <img v-if="preview" :src="preview" alt="업로드한 등기부" />
          <p v-else class="faint">이미지를 불러오지 못했습니다.</p>
        </div>

        <div class="fields">
          <p class="lead">
            왼쪽 이미지와 대조해 잘못 읽은 값을 고쳐 주세요.
            <strong>빈 칸이 없어야</strong> 확인을 마칠 수 있습니다.
          </p>

          <label>소재지</label>
          <input v-model="form.address" placeholder="예시) 서울특별시 강남구 대치동 977 학여울청구아파트" />

          <div class="grid g3" style="margin-top:12px">
            <div>
              <label>동</label>
              <input v-model="form.dong" class="mono" placeholder="118" />
            </div>
            <div>
              <label>층</label>
              <input v-model="form.floor" class="mono" placeholder="7" />
            </div>
            <div>
              <label>호</label>
              <input v-model="form.ho" class="mono" placeholder="715" />
            </div>
          </div>

          <div class="grid g2" style="margin-top:12px">
            <div>
              <label>고유번호</label>
              <input v-model="form.uniqueNo" class="mono" placeholder="1146-2011-004829" />
            </div>
            <div>
              <label>전용면적 (㎡)</label>
              <input v-model="form.exclusiveArea" type="number" step="0.01" class="mono" />
            </div>
          </div>

          <div style="margin-top:12px">
            <label>소유자</label>
            <input v-model="form.ownerName" placeholder="등기부 갑구의 마지막 소유권 등기 명의자" />
          </div>
        </div>
      </div>

      <p class="limit">
        <strong>확인을 마치면 이 집은 소유 확인됨으로 기록됩니다.</strong>
        이 확인은 제출된 등기부를 임대인이 보고 맞다고 한 것까지만 말합니다.
        등기부 갑구에는 성명과 주소 일부만 있고 주민번호는 마스킹되어 있어
        동명이인을 구분하거나 위조 이미지를 걸러낼 수 없습니다.
      </p>

      <div class="done">
        <button class="btn" :disabled="busy" @click="reset">다시 올리기</button>
        <button class="btn btn-primary" :disabled="busy || !canConfirm" @click="confirm">
          {{ busy ? '저장 중…' : '등기부 확인 완료' }}
        </button>
        <span v-if="!canConfirm" class="faint">비어 있는 칸을 채워 주세요</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.verdict { display: flex; align-items: center; gap: var(--sp-sm); }
.reasons { margin: var(--sp-md) 0 0; padding-left: 20px; color: var(--text-body); font-size: 14px; }
.reasons li + li { margin-top: 4px; }

/* 이미지와 입력칸을 나란히 — 눈으로 대조하는 화면이라 위아래로 두면 계속 스크롤해야 한다 */
.split {
  display: grid; grid-template-columns: minmax(320px, 440px) 1fr;
  gap: var(--sp-lg); margin-top: var(--sp-lg);
}
.preview {
  border: 1px solid var(--border); border-radius: var(--radius-md);
  background: var(--surface-2); padding: 8px; overflow: auto; max-height: 560px;
}
.preview.solo { margin-top: var(--sp-md); max-width: 440px; }
.preview img { display: block; width: 100%; height: auto; border-radius: 4px; }

.fields .lead { margin: 0 0 var(--sp-md); font-size: 14px; color: var(--text-dim); line-height: 1.6; }

.limit {
  margin: var(--sp-lg) 0 0; padding: 14px 16px;
  background: var(--surface-2); border-radius: var(--radius-md);
  font-size: 13px; line-height: 1.6; color: var(--text-dim);
}
.done { display: flex; align-items: center; gap: var(--sp-sm); margin-top: var(--sp-lg); }
</style>
