<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, won, toIsoDate } from '../api.js';
import { landlord } from '../session.js';

const route = useRoute();
const router = useRouter();

const unitId = Number(route.query.unitId);
const unit = ref(null);
const loading = ref(true);
const error = ref('');
const busy = ref(false);

const CATEGORIES = [
  { v: 'wallpaper', t: '도배' },
  { v: 'flooring', t: '바닥재' },
  { v: 'appliance', t: '빌트인 가전' },
  { v: 'fixture', t: '설비·집기' },
  { v: 'etc', t: '기타' },
];

const today = toIsoDate();

const form = ref({
  tenantName: '', tenantPhone: '',
  deposit: 0, monthlyRent: 0,
  moveInDate: today, termMonths: 24,
});

const rules = ref({
  ltrfBurden: 'landlord', prorateEdgeMonths: 1, minorRepairThreshold: 100000,
  wallpaperGraceMonths: 24, flooringGraceMonths: 24, lateInterestRate: 5,
  tenantPaidAdvanceFee: 0, advanceFeeAmount: 0,
});

const items = ref([]);

/* ── 계약서 OCR (docs/CONTRACT-OCR-PLAN.md) ──────────────────
   타이핑을 줄이는 기능이지 계약 조건을 확정하는 기능이 아니다.
   high 라도 저장 전에 사용자가 한 번은 눈으로 본다. */
const ocrFile = ref(null);
const ocrBusy = ref(false);
const ocrError = ref('');
const ocr = ref(null);          // { fields, warnings, provider }
const unitMismatch = ref([]);

/** low 는 칸을 비워 둔다 — 조용히 하나를 고르는 것이 가장 위험하다 (§5) */
const FILLABLE = new Set(['high', 'medium']);

async function runOcr() {
  ocrError.value = '';
  ocrBusy.value = true;
  try {
    const res = await api.contractOcr(ocrFile.value);
    ocr.value = res;
    applyOcr(res.fields);
  } catch (e) {
    /* 파싱에 실패해도 화면은 계속 진행 가능해야 한다. 수동 입력이 항상 기본값이다 (§6). */
    ocrError.value = e.message === 'parse_failed'
      ? '계약서 양식을 인식하지 못했습니다. 아래에 직접 입력해 주세요.'
      : e.message;
  } finally { ocrBusy.value = false; }
}

function applyOcr(f) {
  if (FILLABLE.has(f.tenantName.confidence)) form.value.tenantName = f.tenantName.value;
  if (FILLABLE.has(f.deposit.confidence)) form.value.deposit = f.deposit.value;
  if (FILLABLE.has(f.monthlyRent.confidence)) form.value.monthlyRent = f.monthlyRent.value;
  if (FILLABLE.has(f.moveInDate.confidence)) form.value.moveInDate = f.moveInDate.value;
  if (FILLABLE.has(f.termMonths.confidence)) form.value.termMonths = f.termMonths.value;

  /* 동·호는 채우지 않고 **대조만** 한다. 집은 이미 앞 화면에서 골랐으므로,
     계약서가 다른 집 것이면 알려 주는 쪽이 맞다.
     전용면적도 덮지 않는다 — 장기수선충당금 계산의 곱셈 인자라 K-apt·등기부 값이 우선이다 (§9-4). */
  const same = (a, b) => String(a ?? '').replace(/[^0-9]/g, '') === String(b ?? '').replace(/[^0-9]/g, '');
  const out = [];
  if (f.dong.value && !same(f.dong.value, unit.value.dong))
    out.push(`동이 다릅니다 — 계약서 ${f.dong.value}동 / 선택한 집 ${unit.value.dong}`);
  if (f.ho.value && !same(f.ho.value, unit.value.ho))
    out.push(`호가 다릅니다 — 계약서 ${f.ho.value}호 / 선택한 집 ${unit.value.ho}`);
  if (f.exclusiveArea.value && Math.abs(f.exclusiveArea.value - unit.value.exclusiveArea) > 0.5)
    out.push(`전용면적이 다릅니다 — 계약서 ${f.exclusiveArea.value}㎡ / 등록된 값 ${unit.value.exclusiveArea}㎡`);
  unitMismatch.value = out;
}

const BADGE = {
  high: { tone: '', label: '자동 입력' },
  medium: { tone: 'warn', label: '확인 필요' },
  low: { tone: 'no', label: '읽지 못함' },
};
/** 배지는 OCR 을 돌린 뒤에만 뜬다 */
const badge = (key) => (ocr.value ? BADGE[ocr.value.fields[key].confidence] : null);

onMounted(async () => {
  if (!unitId) { error.value = '집을 먼저 선택해 주세요'; loading.value = false; return; }
  try {
    const data = await api.unit(unitId);
    unit.value = data.unit;

    // ★ House Log 의 품목 시공 이력을 그대로 가져온다.
    //   지난 계약 퇴거 때 교체한 날짜가 이번 계약의 '최종 시공일' 이 된다.
    items.value = data.items.map((it) => ({
      category: it.category,
      label: it.label,
      usefulLifeYears: it.usefulLifeYears,
      lastRenewedOn: it.lastRenewedOn,
      replacementCost: it.replacementCost,
      graceApplicable: ['wallpaper', 'flooring'].includes(it.category),
      fromHistory: true,
    }));
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
});

/** 만료일 = 입주일 + 기간 − 1일 (표시용. 서버가 같은 식으로 다시 계산한다) */
const expiresOn = computed(() => {
  const { moveInDate, termMonths } = form.value;
  if (!moveInDate || !termMonths) return null;
  const d = new Date(`${moveInDate}T00:00:00`);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + Number(termMonths));
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  d.setDate(d.getDate() - 1);
  return toIsoDate(d);
});

const canSave = computed(() =>
  Boolean(form.value.tenantName.trim() && form.value.moveInDate && unit.value));

function addItem() {
  items.value.push({
    category: 'etc', label: '', usefulLifeYears: 6,
    lastRenewedOn: today, replacementCost: 0, graceApplicable: true, fromHistory: false,
  });
}

async function save() {
  busy.value = true;
  error.value = '';
  try {
    const contract = await api.createContract({
      unitId,
      landlordId: landlord.value.id,
      tenantName: form.value.tenantName.trim(),
      tenantPhone: form.value.tenantPhone.trim() || null,
      deposit: Number(form.value.deposit),
      monthlyRent: Number(form.value.monthlyRent),
      moveInDate: form.value.moveInDate,
      termMonths: Number(form.value.termMonths),
    });
    await api.putRules(contract.id, { ...rules.value, items: items.value });
    router.push(`/contracts/${contract.id}`);
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
</script>

<template>
  <div v-if="loading" class="card"><div class="empty">불러오는 중…</div></div>
  <div v-else-if="!unit" class="notice">{{ error }}</div>

  <template v-else>
    <div class="head">
      <div>
        <h1>계약 작성</h1>
        <p class="muted">
          {{ unit.complexName }} {{ unit.dong }} {{ unit.ho }} · 전용 {{ unit.exclusiveArea }}㎡
        </p>
      </div>
      <RouterLink :to="`/units/${unit.id}`"><button class="btn">집 상세로</button></RouterLink>
    </div>

    <div v-if="error" class="notice" style="margin-bottom:16px">{{ error }}</div>

    <!-- 계약서 OCR -->
    <div class="card">
      <div class="card-head">
        <h2>계약서 사진으로 채우기</h2>
        <span class="faint">선택 사항 — 아래 항목을 직접 입력해도 됩니다</span>
      </div>
      <div class="card-body">
        <div v-if="ocrError" class="notice" style="margin-bottom:16px">{{ ocrError }}</div>

        <div class="drop">
          <input type="file" accept="image/*" @change="ocrFile = $event.target.files[0]" />
          <button class="btn btn-primary" :disabled="ocrBusy || !ocrFile" @click="runOcr">
            {{ ocrBusy ? '읽는 중…' : '계약서 읽기' }}
          </button>
        </div>

        <p class="faint" style="margin:12px 0 0">
          보증금·기간이 있는 <strong>1페이지</strong> 한 장만 올려 주세요.
          스캔본이 가장 정확하고, 사진이면 정면에서 그림자 없이 찍어 주세요.
          계약서는 읽은 뒤 <strong>바로 삭제</strong>되며 원문을 저장하지 않습니다.
        </p>

        <template v-if="ocr">
          <ul v-if="ocr.warnings.length" class="warns">
            <li v-for="(w, i) in ocr.warnings" :key="i">{{ w }}</li>
          </ul>
          <ul v-if="unitMismatch.length" class="warns mismatch">
            <li v-for="(w, i) in unitMismatch" :key="i">{{ w }}</li>
          </ul>
          <p v-if="ocr.fields.deposit.confidence === 'low' && ocr.fields.deposit.source.hangul"
             class="candidates">
            보증금 후보 —
            한글 <strong class="mono">{{ ocr.fields.deposit.source.hangul }}</strong> ·
            숫자 <strong class="mono">{{ ocr.fields.deposit.source.arabic }}</strong>
          </p>
          <p class="faint" style="margin:12px 0 0">
            자동 입력은 참고용입니다. <strong>저장 전에 값을 확인해 주세요.</strong>
            읽은 공급자: {{ ocr.provider }}
          </p>
        </template>
      </div>
    </div>

    <!-- 계약 조건 -->
    <div class="card">
      <div class="card-head"><h2>임차인 · 계약 조건</h2></div>
      <div class="card-body">
        <div class="grid g2">
          <div>
            <label>임차인 이름 <span v-if="badge('tenantName')" class="pill" :class="badge('tenantName').tone">{{ badge('tenantName').label }}</span></label>
            <input v-model="form.tenantName" placeholder="홍길동" />
          </div>
          <div>
            <label>연락처</label>
            <input v-model="form.tenantPhone" placeholder="010-0000-0000" />
          </div>
          <div>
            <label>보증금 (원) <span v-if="badge('deposit')" class="pill" :class="badge('deposit').tone">{{ badge('deposit').label }}</span></label>
            <input class="mono" type="number" v-model.number="form.deposit" />
            <p class="faint" style="margin:6px 0 0">{{ won(form.deposit) }}</p>
          </div>
          <div>
            <label>월 차임 (원) — 전세면 0 <span v-if="badge('monthlyRent')" class="pill" :class="badge('monthlyRent').tone">{{ badge('monthlyRent').label }}</span></label>
            <input class="mono" type="number" v-model.number="form.monthlyRent" />
            <p class="faint" style="margin:6px 0 0">{{ won(form.monthlyRent) }}</p>
          </div>
          <div>
            <label>입주일 <span v-if="badge('moveInDate')" class="pill" :class="badge('moveInDate').tone">{{ badge('moveInDate').label }}</span></label>
            <input type="date" v-model="form.moveInDate" />
          </div>
          <div>
            <label>계약 기간 (개월) <span v-if="badge('termMonths')" class="pill" :class="badge('termMonths').tone">{{ badge('termMonths').label }}</span></label>
            <input class="mono" type="number" step="12" v-model.number="form.termMonths" />
            <p class="faint" style="margin:6px 0 0">
              만료 예정 <strong class="mono">{{ expiresOn ?? '—' }}</strong> ·
              갱신거절 통지 기한은 만료 2개월 전입니다
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Rule Lock -->
    <div class="card">
      <div class="card-head">
        <h2>Rule Lock — 계약 시점에 확정하는 정산 규칙</h2>
      </div>
      <div class="card-body">
        <div class="notice" style="margin-bottom:20px">
          여기서 정한 값은 <strong>법적 기준이 아니라 당사자 합의값</strong>입니다.
          퇴거 정산은 이 규칙을 그대로 재생해 계산됩니다.
        </div>
        <div class="grid g3">
          <div>
            <label>장기수선충당금 부담 주체</label>
            <select v-model="rules.ltrfBurden">
              <option value="landlord">임대인 부담 (원칙 · 퇴거 시 반환)</option>
              <option value="tenant">임차인 부담 특약 (반환 없음)</option>
            </select>
            <p class="faint" style="margin:6px 0 0">공동주택관리법 시행령 제31조 제8항</p>
          </div>
          <div>
            <label>입주월·퇴거월 일할 계산</label>
            <select v-model.number="rules.prorateEdgeMonths">
              <option :value="1">일할 적용</option>
              <option :value="0">월 단위 전액</option>
            </select>
          </div>
          <div>
            <label>소액 수선 기준 (원)</label>
            <input class="mono" type="number" v-model.number="rules.minorRepairThreshold" />
            <p class="faint" style="margin:6px 0 0">이하는 임차인, 초과는 임대인 부담</p>
          </div>
          <div>
            <label>도배 원상회복 면제 거주기간 (개월)</label>
            <input class="mono" type="number" v-model.number="rules.wallpaperGraceMonths" />
          </div>
          <div>
            <label>바닥재 원상회복 면제 거주기간 (개월)</label>
            <input class="mono" type="number" v-model.number="rules.flooringGraceMonths" />
          </div>
          <div>
            <label>연체 지연이자 (연 %)</label>
            <input class="mono" type="number" step="0.1" v-model.number="rules.lateInterestRate" />
          </div>
          <div>
            <label>선수관리비 납부자</label>
            <select v-model.number="rules.tenantPaidAdvanceFee">
              <option :value="0">소유자 납부 (반환 없음)</option>
              <option :value="1">임차인 대납 (퇴거 시 반환)</option>
            </select>
          </div>
          <div>
            <label>선수관리비 금액 (원)</label>
            <input class="mono" type="number" v-model.number="rules.advanceFeeAmount"
                   :disabled="!rules.tenantPaidAdvanceFee" />
          </div>
        </div>
      </div>
    </div>

    <!-- 품목 -->
    <div class="card">
      <div class="card-head">
        <h2>품목별 원상회복 기준</h2>
        <button class="btn btn-sm" @click="addItem">＋ 품목 추가</button>
      </div>
      <div class="card-body" style="padding:0">
        <p v-if="items.some((i) => i.fromHistory)" class="carried">
          이 집의 <strong>품목 시공 이력</strong>에서 최종 시공일을 가져왔습니다.
          지난 계약 퇴거 때 교체한 날짜가 이번 계약의 감가 기준이 됩니다.
        </p>
        <table v-if="items.length">
          <thead>
            <tr>
              <th style="width:130px">구분</th>
              <th>품목</th>
              <th class="num" style="width:110px">내용연수(년)</th>
              <th style="width:170px">최종 시공일</th>
              <th class="num" style="width:140px">교체비용(원)</th>
              <th style="width:90px">면제규칙</th>
              <th style="width:50px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(it, i) in items" :key="i">
              <td>
                <select v-model="it.category">
                  <option v-for="c in CATEGORIES" :key="c.v" :value="c.v">{{ c.t }}</option>
                </select>
              </td>
              <td>
                <input v-model="it.label" placeholder="예: 전체 도배" />
                <span v-if="it.fromHistory" class="pill accent" style="margin-top:6px">이력 승계</span>
              </td>
              <td><input class="mono" type="number" step="0.5" v-model.number="it.usefulLifeYears" /></td>
              <td><input type="date" v-model="it.lastRenewedOn" /></td>
              <td><input class="mono" type="number" v-model.number="it.replacementCost" /></td>
              <td style="text-align:center">
                <input type="checkbox" v-model="it.graceApplicable" style="width:auto" />
              </td>
              <td class="num">
                <button class="btn btn-sm" @click="items.splice(i, 1)">×</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">등록된 품목이 없습니다. 품목을 추가해 주세요.</div>
      </div>
    </div>

    <div class="card">
      <div class="card-body save">
        <p class="faint" style="margin:0">
          저장하면 <strong>작성 중</strong> 상태로 만들어집니다.
          임대인 확정과 임차인 발송은 다음 화면에서 합니다.
        </p>
        <button class="btn btn-primary" :disabled="busy || !canSave" @click="save">
          {{ busy ? '저장 중…' : '계약 저장' }}
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

.carried {
  margin: 0; padding: 14px var(--sp-lg);
  background: var(--surface-2); font-size: 13px; color: var(--text-dim); line-height: 1.6;
}
td input, td select { height: 36px; padding: 0 10px; font-size: 14px; }
td .pill { display: inline-flex; }

.save { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-lg); }

.drop { display: flex; align-items: center; gap: var(--sp-sm); }
.drop input { flex: 1; }
.drop .btn { flex: none; }

.warns { margin: var(--sp-md) 0 0; padding-left: 20px; font-size: 14px; color: var(--text-body); }
.warns li + li { margin-top: 4px; }
.warns.mismatch { color: var(--brand-coral); }

.candidates {
  margin: var(--sp-sm) 0 0; padding: 12px 16px;
  background: var(--surface-2); border-radius: var(--radius-md); font-size: 14px;
}
label .pill { margin-left: 6px; vertical-align: middle; }
</style>
