<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, won, toIsoDate } from '../api.js';

const props = defineProps({ id: { type: String, required: true } });
const router = useRouter();

const data = ref(null);
const loading = ref(true);
const error = ref('');

onMounted(async () => {
  try { data.value = await api.unit(props.id); }
  catch (e) { error.value = e.message; }
  finally { loading.value = false; }
});

/**
 * 작성하다 만 계약. 발송 전이라 집은 아직 공실이고 '계약 작성' 버튼도 살아 있다.
 * 그 버튼이 새 계약을 또 만드는 것처럼 보이면 안 되므로 문구를 바꿔 둔다
 * (같은 경로로 가고, 그 화면이 이 계약을 불러와 이어 쓴다).
 */
const draftContract = computed(() =>
  data.value?.contracts.find((c) => c.status === 'draft') ?? null);

/* 세대 상태는 verified, 문서 판정은 matched 로 용어가 다르다 */
const OWNERSHIP = {
  verified: { label: '소유 확인됨', tone: 'ok' },
  matched: { label: 'OCR 대조 일치', tone: 'ok' },
  /* 임대인이 OCR 값을 보고 고쳐 확정한 경우. matched 와 구분해 둔다 —
     "무엇을 근거로 확인했나" 가 달라서 같은 라벨을 쓰면 안 된다. */
  confirmed: { label: '임대인 확인', tone: 'ok' },
  unverified: { label: '등기부 미확인', tone: 'warn' },
  name_mismatch: { label: '소유자 이름 불일치', tone: 'warn' },
  address_mismatch: { label: '다른 집의 등기부', tone: 'no' },
  parse_failed: { label: '등기부를 읽지 못함', tone: 'warn' },
};

const VACANCY = {
  vacant: { label: '공실', tone: '' },
  contracting: { label: '계약 진행 중', tone: 'accent' },
  occupied: { label: '거주 중', tone: 'ok' },
  closing: { label: '퇴거 진행 중', tone: 'peach' },
};

const CONTRACT = {
  draft: '작성 중', pending_tenant: '임차인 확인 대기', rejected: '수정 요청됨',
  active: '거주 중', renewing: '갱신 중', closing: '퇴거 진행 중', closed: '종료',
};

const CAUSE = { wear: '통상손모', tenant_fault: '임차인 귀책', landlord_duty: '임대인 의무' };

const CONTRACT_TONE = {
  draft: '', pending_tenant: 'accent', rejected: 'warn',
  active: 'ok', renewing: 'accent', closing: 'peach', closed: '',
};

const INSPECTION = { requested: '사진 대기', submitted: '검토 대기', reviewed: '검토 완료' };

/* ── House Log 직접 입력 ────────────────────────────────────
   시공과 수선은 임차인이 아니라 집에 일어나는 일이라, 계약이 없어도 적을 수 있어야 한다.
   품목 시공 이력은 다음 계약 Rule Lock 의 '최종 시공일' 로 그대로 승계된다. */

const CATEGORIES = [
  { v: 'wallpaper', t: '도배' },
  { v: 'flooring', t: '바닥재' },
  { v: 'appliance', t: '빌트인 가전' },
  { v: 'fixture', t: '설비·집기' },
  { v: 'etc', t: '기타' },
];

const today = toIsoDate();
const logBusy = ref(false);
const logError = ref('');

const itemForm = ref(null);
const repairForm = ref(null);

const openItemForm = () => {
  logError.value = '';
  itemForm.value = {
    category: 'wallpaper', label: '', usefulLifeYears: 6,
    lastRenewedOn: today, replacementCost: 0, note: '',
  };
};

const openRepairForm = () => {
  logError.value = '';
  repairForm.value = {
    occurredOn: today, description: '', cost: 0,
    paidBy: 'landlord', cause: 'wear', contractId: '',
  };
};

/** 서버가 갱신된 이력을 통째로 돌려주므로 화면만 갈아 끼운다 */
async function submitLog(send, close) {
  logError.value = '';
  logBusy.value = true;
  try {
    const res = await send();
    Object.assign(data.value, {
      items: res.items, unitItems: res.unitItems, repairs: res.repairs,
    });
    close();
  } catch (e) { logError.value = e.message; }
  finally { logBusy.value = false; }
}

const saveItem = () => submitLog(
  () => api.addUnitItem(props.id, itemForm.value),
  () => { itemForm.value = null; });

const saveRepair = () => submitLog(
  () => api.addUnitRepair(props.id, {
    ...repairForm.value,
    contractId: repairForm.value.contractId === '' ? null : Number(repairForm.value.contractId),
  }),
  () => { repairForm.value = null; });

const removeItem = (id) => submitLog(
  async () => { await api.deleteUnitItem(id); return (await api.unit(props.id)); },
  () => {});

const removeRepair = (id) => submitLog(
  async () => { await api.deleteRepair(id); return (await api.unit(props.id)); },
  () => {});

/** 집에 직접 적은 시공 이력만 지울 수 있다 — 계약 Rule Lock 에서 승계된 줄은 그 계약 소유다 */
const unitItemId = (category) =>
  (data.value?.unitItems ?? []).find((x) => x.category === category)?.id ?? null;

/* 삭제는 되돌릴 수 없다. 버튼 하나로 바로 지우지 않고 한 번 더 묻는다. */
const confirming = ref(false);
const removing = ref(false);
const removeError = ref('');

async function removeUnit() {
  removeError.value = '';
  removing.value = true;
  try {
    await api.deleteUnit(props.id);
    router.push('/');
  } catch (e) {
    removeError.value = e.message;
    confirming.value = false;
  } finally { removing.value = false; }
}

const years = (from) => {
  if (!from) return null;
  const months = Math.floor((Date.now() - new Date(`${from}T00:00:00`)) / 2_629_800_000);
  return months < 12 ? `${months}개월 전` : `${Math.floor(months / 12)}년 ${months % 12}개월 전`;
};
</script>

<template>
  <div v-if="error" class="notice">{{ error }}</div>
  <div v-else-if="loading" class="card"><div class="empty">불러오는 중…</div></div>

  <template v-else>
    <div class="head">
      <div>
        <h1>{{ data.unit.complexName }} {{ data.unit.dong }} {{ data.unit.ho }}</h1>
        <p class="muted">{{ data.unit.address }} · 전용 {{ data.unit.exclusiveArea }}㎡</p>
      </div>
      <div class="badges">
        <span class="pill" :class="VACANCY[data.unit.vacancyStatus].tone">
          {{ VACANCY[data.unit.vacancyStatus].label }}
        </span>
        <span class="pill" :class="OWNERSHIP[data.unit.ownershipStatus].tone">
          {{ OWNERSHIP[data.unit.ownershipStatus].label }}
        </span>
        <RouterLink v-if="data.unit.vacancyStatus === 'vacant'" :to="`/contracts/new?unitId=${data.unit.id}`">
          <button class="btn btn-primary">{{ draftContract ? '작성 중인 계약 이어 쓰기' : '계약 작성' }}</button>
        </RouterLink>
        <RouterLink :to="`/units/${data.unit.id}/registry`">
          <button class="btn">등기부 재인식</button>
        </RouterLink>
      </div>
    </div>

    <!-- 소유 -->
    <div class="card">
      <div class="card-head"><h2>소유</h2></div>
      <div class="card-body">
        <table>
          <tbody>
            <tr><th style="width:180px">임대인</th><td>{{ data.unit.landlordName ?? '—' }}</td></tr>
            <tr>
              <th>등기부 소유자</th>
              <td>{{ data.unit.registryOwnerName ?? '등기부 미제출' }}</td>
            </tr>
            <tr><th>고유번호</th><td class="mono">{{ data.unit.registryUniqueNo ?? '—' }}</td></tr>
            <tr><th>확인일</th><td class="mono">{{ data.unit.ownershipVerifiedAt ?? '—' }}</td></tr>
          </tbody>
        </table>
        <p v-if="!data.registryDocuments.length" class="faint" style="margin:16px 0 0">
          제출된 등기부가 없습니다.
        </p>
        <table v-else style="margin-top:16px">
          <thead>
            <tr><th>제출</th><th>OCR</th><th>판정</th><th class="num">신뢰도</th></tr>
          </thead>
          <tbody>
            <tr v-for="d in data.registryDocuments" :key="d.id">
              <td class="mono">{{ d.createdAt }}</td>
              <td>{{ d.ocrProvider }}</td>
              <td>
                <span class="pill" :class="OWNERSHIP[d.matchResult]?.tone ?? ''">
                  {{ OWNERSHIP[d.matchResult]?.label ?? d.matchResult }}
                </span>
              </td>
              <td class="num mono">{{ Math.round((d.confidence ?? 0) * 100) }}%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 계약 기록 — 이 집에서 오간 문서를 한자리에 모은다 -->
    <div class="card">
      <div class="card-head">
        <h2>계약 기록</h2>
        <span class="faint">{{ data.contracts.length }}건 · 계약서와 정산서를 여기서 엽니다</span>
      </div>
      <div v-if="data.contracts.length" class="records">
        <div v-for="c in data.contracts" :key="c.id" class="record">
          <div class="record-head">
            <div>
              <RouterLink :to="`/contracts/${c.id}`" class="who">{{ c.tenantName }}</RouterLink>
              <span class="pill" :class="CONTRACT_TONE[c.status] ?? ''">
                {{ CONTRACT[c.status] ?? c.status }}
              </span>
            </div>
            <div class="terms mono">
              {{ c.moveInDate }} ~ {{ c.moveOutDate ?? c.expiresOn ?? '미정' }}
              · {{ won(c.deposit) }}<template v-if="c.monthlyRent"> / 월 {{ won(c.monthlyRent) }}</template>
            </div>
          </div>

          <div class="docs">
            <RouterLink :to="`/contracts/${c.id}/document`" class="doc">
              <strong>계약서</strong>
              <span class="faint">임차인이 받은 그대로</span>
            </RouterLink>

            <RouterLink :to="`/contracts/${c.id}/rules`" class="doc">
              <strong>Rule Lock</strong>
              <span class="faint">
                <template v-if="c.ruleSetCount > 1">규칙 {{ c.ruleSetCount }}개 버전</template>
                <template v-else-if="c.ruleSetCount">정산 규칙</template>
                <template v-else>아직 없음</template>
              </span>
            </RouterLink>

            <RouterLink v-if="c.inspectionStatus" :to="`/contracts/${c.id}/inspection`" class="doc">
              <strong>퇴거 점검</strong>
              <span class="faint">{{ INSPECTION[c.inspectionStatus] ?? c.inspectionStatus }}</span>
            </RouterLink>
            <span v-else class="doc off">
              <strong>퇴거 점검</strong>
              <span class="faint">없음</span>
            </span>

            <RouterLink v-if="c.settlementId" :to="`/contracts/${c.id}/settlement`" class="doc">
              <strong>퇴거 정산서</strong>
              <span class="faint">
                {{ c.sealedAt ? `확정 ${c.sealedAt.slice(0, 10)}` : '진행 중' }}
                <template v-if="c.depositReturn != null"> · 반환 {{ won(c.depositReturn) }}</template>
              </span>
            </RouterLink>
            <span v-else class="doc off">
              <strong>퇴거 정산서</strong>
              <span class="faint">아직 발행하지 않음</span>
            </span>
          </div>

          <p v-if="c.tenantDecision === 'rejected'" class="note">
            임차인이 수정을 요청한 계약입니다. 계약 상세에서 조건을 고쳐 다시 보내세요.
          </p>
        </div>
      </div>
      <div v-else class="empty">아직 계약이 없습니다.</div>
    </div>

    <!-- 품목 시공 이력 -->
    <div class="card">
      <div class="card-head">
        <h2>품목 시공 이력</h2>
        <div class="head-actions">
          <span class="faint">다음 계약 Rule Lock 의 '최종 시공일' 로 들어갑니다</span>
          <button v-if="!itemForm" class="btn btn-sm" @click="openItemForm">＋ 시공 추가</button>
        </div>
      </div>

      <div v-if="itemForm" class="card-body log-form">
        <div v-if="logError" class="notice" style="margin-bottom:16px">{{ logError }}</div>
        <div class="grid g3">
          <div>
            <label>구분</label>
            <select v-model="itemForm.category">
              <option v-for="c in CATEGORIES" :key="c.v" :value="c.v">{{ c.t }}</option>
            </select>
          </div>
          <div>
            <label>품목</label>
            <input v-model="itemForm.label" placeholder="예시) 전체 도배" />
          </div>
          <div>
            <label>최종 시공일</label>
            <input v-model="itemForm.lastRenewedOn" type="date" class="mono" />
          </div>
          <div>
            <label>내용연수 (년)</label>
            <input v-model.number="itemForm.usefulLifeYears" type="number" step="0.5" class="mono" />
          </div>
          <div>
            <label>교체비용 (원)</label>
            <input v-model.number="itemForm.replacementCost" type="number" class="mono" />
          </div>
          <div>
            <label>메모 (선택)</label>
            <input v-model="itemForm.note" placeholder="예시) 거실+방2" />
          </div>
        </div>
        <p class="faint" style="margin:16px 0 0">
          내용연수와 교체비용은 원상회복 공제를 계산할 때 감가 기준이 됩니다.
          같은 구분을 다시 넣으면 <strong>더 최근 시공일</strong>이 이깁니다.
        </p>
        <div class="answer">
          <button class="btn btn-primary" :disabled="logBusy || !itemForm.label.trim()" @click="saveItem">
            {{ logBusy ? '저장 중…' : '저장' }}
          </button>
          <button class="btn" :disabled="logBusy" @click="itemForm = null">취소</button>
        </div>
      </div>

      <table v-if="data.items.length">
        <thead>
          <tr>
            <th>품목</th><th>최종 시공일</th><th class="num">내용연수</th><th class="num">교체비용</th>
            <th style="width:60px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="it in data.items" :key="it.category">
            <td style="font-weight:600">
              {{ it.label }}
              <span v-if="it.source === 'contract'" class="pill accent">계약 승계</span>
            </td>
            <td class="mono">
              {{ it.lastRenewedOn }}
              <span class="faint">{{ years(it.lastRenewedOn) }}</span>
            </td>
            <td class="num mono">{{ it.usefulLifeYears }}년</td>
            <td class="num mono">{{ won(it.replacementCost) }}</td>
            <td class="num">
              <button v-if="unitItemId(it.category)" class="btn btn-sm"
                      :disabled="logBusy" @click="removeItem(unitItemId(it.category))">×</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else-if="!itemForm" class="empty">
        <p style="margin:0 0 6px;font-weight:600;color:var(--text)">등록된 품목이 없습니다</p>
        <p style="margin:0">
          도배·바닥재를 언제 시공했는지 적어 두면 첫 계약의 Rule Lock 이 그 날짜로 시작합니다.
        </p>
      </div>
    </div>

    <!-- 수선 이력 -->
    <div class="card">
      <div class="card-head">
        <h2>수선 이력</h2>
        <div class="head-actions">
          <span class="faint">{{ data.repairs.length }}건</span>
          <button v-if="!repairForm" class="btn btn-sm" @click="openRepairForm">＋ 수선 추가</button>
        </div>
      </div>

      <div v-if="repairForm" class="card-body log-form">
        <div v-if="logError" class="notice" style="margin-bottom:16px">{{ logError }}</div>
        <div class="grid g3">
          <div>
            <label>수선일</label>
            <input v-model="repairForm.occurredOn" type="date" class="mono" />
          </div>
          <div>
            <label>내용</label>
            <input v-model="repairForm.description" placeholder="예시) 보일러 순환펌프 교체" />
          </div>
          <div>
            <label>비용 (원)</label>
            <input v-model.number="repairForm.cost" type="number" class="mono" />
          </div>
          <div>
            <label>부담 주체</label>
            <select v-model="repairForm.paidBy">
              <option value="landlord">임대인</option>
              <option value="tenant">임차인</option>
            </select>
          </div>
          <div>
            <label>사유</label>
            <select v-model="repairForm.cause">
              <option value="wear">통상손모</option>
              <option value="tenant_fault">임차인 귀책</option>
              <option value="landlord_duty">임대인 의무</option>
            </select>
          </div>
          <div>
            <label>정산에 반영할 계약</label>
            <select v-model="repairForm.contractId">
              <option value="">반영하지 않음 (집 이력으로만)</option>
              <option v-for="c in data.contracts" :key="c.id" :value="c.id">
                {{ c.tenantName }} ({{ c.moveInDate }}~)
              </option>
            </select>
          </div>
        </div>
        <p class="faint" style="margin:16px 0 0">
          계약을 고르면 그 임차인의 <strong>퇴거 정산</strong>에 소액수선 기준이 적용되어 들어갑니다.
          공실 기간 수선이라면 <strong>반영하지 않음</strong>으로 두세요 — 집의 이력으로만 남습니다.
        </p>
        <div class="answer">
          <button class="btn btn-primary"
                  :disabled="logBusy || !repairForm.description.trim()" @click="saveRepair">
            {{ logBusy ? '저장 중…' : '저장' }}
          </button>
          <button class="btn" :disabled="logBusy" @click="repairForm = null">취소</button>
        </div>
      </div>

      <table v-if="data.repairs.length">
        <thead>
          <tr>
            <th>일자</th><th>내용</th><th class="num">비용</th><th>부담</th><th>사유</th>
            <th style="width:60px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="rp in data.repairs" :key="rp.id">
            <td class="mono">{{ rp.occurredOn }}</td>
            <td>
              {{ rp.description }}
              <div class="faint">{{ rp.tenantName ? `${rp.tenantName} 계약` : '정산 미반영' }}</div>
            </td>
            <td class="num mono">{{ won(rp.cost) }}</td>
            <td>{{ rp.paidBy === 'landlord' ? '임대인' : '임차인' }}</td>
            <td class="faint">{{ CAUSE[rp.cause] ?? rp.cause }}</td>
            <td class="num">
              <button class="btn btn-sm" :disabled="logBusy" @click="removeRepair(rp.id)">×</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else-if="!repairForm" class="empty">수선 이력이 없습니다.</div>
    </div>

    <!-- 집 삭제 — 되돌릴 수 없으므로 맨 아래, 한 단계 더 눌러야 실행된다 -->
    <div class="card danger">
      <div class="card-head"><h2>집 삭제</h2></div>
      <div class="card-body">
        <div v-if="removeError" class="notice" style="margin-bottom:16px">{{ removeError }}</div>

        <p class="faint" style="margin:0 0 16px">
          <template v-if="data.contracts.length">
            계약 {{ data.contracts.length }}건이 등록되어 있어 지울 수 없습니다.
            계약 이력과 정산서가 함께 사라지기 때문입니다.
          </template>
          <template v-else>
            이 집과 제출된 등기부가 지워집니다. 되돌릴 수 없습니다.
          </template>
        </p>

        <template v-if="!data.contracts.length">
          <button v-if="!confirming" class="btn" @click="confirming = true">집 삭제</button>
          <div v-else class="confirm">
            <span>{{ data.unit.dong }} {{ data.unit.ho }} 를 정말 지울까요?</span>
            <button class="btn" :disabled="removing" @click="confirming = false">취소</button>
            <button class="btn btn-danger" :disabled="removing" @click="removeUnit">
              {{ removing ? '지우는 중…' : '삭제' }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </template>
</template>

<style scoped>
.head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: var(--sp-lg); margin-bottom: var(--sp-lg);
}
.head .muted { margin: var(--sp-xxs) 0 0; font-size: 15px; }
.badges { display: flex; align-items: center; gap: var(--sp-xs); flex: none; }
td a { text-decoration: underline; text-underline-offset: 3px; }

.head-actions { display: flex; align-items: center; gap: var(--sp-sm); }

/* ── 계약 기록 ─────────────────────────────────────────── */
.records { padding: 0; }
.record { padding: var(--sp-md) var(--sp-lg); border-top: 1px solid var(--border); }
.record:first-child { border-top: 0; }

.record-head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: var(--sp-md); margin-bottom: 12px;
}
.record-head .who {
  font-weight: 600; font-size: 16px; margin-right: 8px;
  text-decoration: underline; text-underline-offset: 3px;
}
.record-head .terms { font-size: 13.5px; color: var(--text-dim); }

.docs { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--sp-sm); }
.doc {
  display: grid; gap: 3px; padding: 12px 14px; color: var(--text);
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-md); transition: border-color .12s, background-color .12s;
}
a.doc:hover { border-color: var(--text); background: var(--canvas); }
.doc strong { font-size: 14px; font-weight: 600; }
.doc .faint { font-size: 12.5px; }
/* 아직 만들어지지 않은 문서 — 자리는 두되 누를 수 없다는 것이 보여야 한다 */
.doc.off { opacity: .55; }

.record .note {
  margin: 12px 0 0; padding: 10px 14px;
  background: var(--warn-soft); border-radius: var(--radius-md);
  font-size: 13.5px; color: var(--text);
}
.log-form { border-bottom: 1px solid var(--border); background: var(--surface-2); }
.log-form .answer { display: flex; gap: var(--sp-sm); margin-top: var(--sp-lg); }
td .pill { margin-left: 6px; }

.danger { border-color: var(--brand-coral); }
.confirm { display: flex; align-items: center; gap: var(--sp-sm); font-size: 14px; }
.confirm span { margin-right: var(--sp-xxs); font-weight: 600; }
.btn-danger {
  background: var(--brand-coral); border-color: var(--brand-coral); color: var(--on-dark);
}
.btn-danger:hover:not(:disabled) { filter: brightness(0.93); }
</style>
