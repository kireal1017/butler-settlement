<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, won, toIsoDate } from '../api.js';

const props = defineProps({ id: { type: String, required: true } });
const router = useRouter();

const data = ref(null);
const loading = ref(true);
const error = ref('');
const busy = ref(false);
const link = ref(null);
const copied = ref(false);

async function load() {
  data.value = await api.contract(props.id);
  link.value = data.value.shareLink ?? null;
}

/* 임차인이 이미 응답한 링크는 열어도 결과 화면만 보인다. 그래도 지우지 않는 이유는
   "무엇을 보냈는지" 임대인이 되짚을 수 있어야 하기 때문이다 — 재발송하면 새 토큰이
   발급되고 이전 링크는 서버에서 버려진다(sendContractLink). */
const linkDone = computed(() => Boolean(data.value?.shareLink?.completedAt));

onMounted(async () => {
  try { await load(); }
  catch (e) { error.value = e.message; }
  finally { loading.value = false; }
});

/**
 * 계약 → 다른 계약으로 이동할 때(갱신 계약, 이전 계약) 라우트 파라미터만 바뀌고
 * 같은 컴포넌트가 재사용된다. onMounted 가 다시 돌지 않으므로 여기서 다시 읽는다.
 */
watch(() => props.id, async () => {
  loading.value = true;
  error.value = '';
  mode.value = '';
  try { await load(); }
  catch (e) { error.value = e.message; }
  finally { loading.value = false; }
});

const STATUS = {
  draft: { label: '작성 중', tone: '' },
  pending_tenant: { label: '임차인 확인 대기', tone: 'accent' },
  rejected: { label: '수정 요청됨', tone: 'warn' },
  active: { label: '거주 중', tone: 'ok' },
  renewing: { label: '갱신 중', tone: 'accent' },
  closing: { label: '퇴거 진행 중', tone: 'peach' },
  closed: { label: '종료', tone: '' },
};

const contract = computed(() => data.value?.contract);
const rules = computed(() => data.value?.rules);
const landlordLocked = computed(() => Boolean(rules.value?.lockedByLandlordAt));

const linkUrl = computed(() =>
  link.value ? `${window.location.origin}/t/${link.value.token}` : null);

async function act(fn) {
  busy.value = true;
  error.value = '';
  try { await fn(); await load(); }
  catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}

const lockLandlord = () => act(() => api.lockRules(props.id, 'landlord'));

const send = () => act(async () => { link.value = await api.sendContract(props.id); });

/* ── 갱신 ──────────────────────────────────────────────────
   갱신 결정은 계약이 거주 중이고, 만료 6개월 안으로 들어왔고, 아직 결정하지 않았을 때만
   묻는다. 같은 판단을 홈의 할 일도 하고 있고, 판단 근거(날짜)는 서버 timeline 이다. */

const renewal = computed(() => data.value?.renewal);

const renewOpen = computed(() => Boolean(
  contract.value?.status === 'active'
  && data.value?.timeline?.renewalWindowOpen
  && !renewal.value?.decision
  && !renewal.value?.childId));

/** 갱신 기간의 시작일 = 만료일 다음 날. 서버가 같은 계산을 한다 (service.renewContract). */
const renewalFrom = computed(() => {
  const expires = contract.value?.expires_on;
  if (!expires) return null;
  const d = new Date(`${expires}T00:00:00`);   // UTC 로 읽으면 하루 밀린다
  d.setDate(d.getDate() + 1);
  return toIsoDate(d);
});

const mode = ref('');          // '' | 'renew' | 'moveout' | 'edit'
const form = ref({ termMonths: 24, deposit: 0, monthlyRent: 0 });

/* ── 계약 조건 수정 ────────────────────────────────────────
   임차인이 거부하면 협상이 계속되는데, 지금까지는 Rule Lock 만 고칠 수 있고
   보증금·차임·기간을 바꿀 경로가 없어 거부당한 계약이 그대로 멈춰 있었다.
   서버도 '작성 중 · 수정 요청됨' 에서만 조건 변경을 받는다 — 임차인이 동의한 뒤에
   조건이 바뀌면 '무엇에 동의했는가' 를 말할 수 없게 되기 때문이다. */
const editable = computed(() => ['draft', 'rejected'].includes(contract.value?.status));

const edit = ref({});
function openEditForm() {
  edit.value = {
    tenantName: contract.value.tenant_name,
    tenantPhone: contract.value.tenant_phone ?? '',
    deposit: contract.value.deposit,
    monthlyRent: contract.value.monthly_rent,
    moveInDate: contract.value.move_in_date,
    termMonths: contract.value.term_months ?? 24,
  };
  mode.value = 'edit';
}

const saveEdit = () => act(async () => {
  await api.patchContract(props.id, edit.value);
  mode.value = '';
});

function openRenewForm() {
  form.value = {
    termMonths: contract.value.term_months ?? 24,
    deposit: contract.value.deposit,
    monthlyRent: contract.value.monthly_rent,
  };
  mode.value = 'renew';
}

/* act() 를 쓰지 않는다 — 이동한 뒤에 옛 id 로 다시 읽으면 URL 과 화면이 어긋난다.
   새 계약 화면은 위의 watch 가 읽는다. */
async function renew() {
  busy.value = true;
  error.value = '';
  try {
    const res = await api.renewContract(props.id, form.value);
    router.push(`/contracts/${res.contract.id}`);
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}

const decline = () => act(() => api.declineRenewal(props.id));

/* ── 퇴거 개시 · 점검 ──────────────────────────────────────
   "퇴거 절차 시작" 은 계약 파기가 아니라 만료에 따른 종료 절차다. */

const inspection = computed(() => data.value?.inspection);
const inspectionLink = computed(() =>
  data.value?.inspectionLink?.completedAt ? null : data.value?.inspectionLink);

/** 기본 퇴거 예정일은 만료일 — 협의로 당기거나 미룰 수 있다 */
const moveOutDate = ref('');
function openMoveoutForm() {
  moveOutDate.value = contract.value.move_out_date ?? contract.value.expires_on ?? '';
  mode.value = 'moveout';
}

const startMoveout = () => act(async () => {
  await api.startMoveout(props.id, moveOutDate.value);
  mode.value = '';
});

const requestInspection = () => act(() => api.requestInspection(props.id));

const inspectionUrl = computed(() =>
  inspectionLink.value ? `${window.location.origin}/t/${inspectionLink.value.token}` : null);

const INSPECTION_STATUS = {
  requested: { label: '사진 대기', tone: 'accent' },
  submitted: { label: '검토 대기', tone: 'peach' },
  reviewed: { label: '검토 완료', tone: 'ok' },
};

async function copyLink(url) {
  await navigator.clipboard.writeText(url);
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 1600);
}
</script>

<template>
  <div v-if="loading" class="card"><div class="empty">불러오는 중…</div></div>
  <div v-else-if="!contract" class="notice">{{ error }}</div>

  <template v-else>
    <div class="head">
      <div>
        <h1>{{ contract.tenant_name }}</h1>
        <p class="muted">
          {{ contract.complex_name }} {{ contract.dong }} {{ contract.ho }} ·
          전용 {{ contract.exclusive_area }}㎡
        </p>
      </div>
      <div class="head-right">
        <span class="pill" :class="STATUS[contract.status]?.tone">
          {{ STATUS[contract.status]?.label ?? contract.status }}
        </span>
        <RouterLink :to="`/contracts/${id}/document`">
          <button class="btn btn-sm">계약서 보기</button>
        </RouterLink>
        <RouterLink :to="`/units/${contract.unit_id}`"><button class="btn btn-sm">집 상세</button></RouterLink>
      </div>
    </div>

    <div v-if="error" class="notice" style="margin-bottom:16px">{{ error }}</div>

    <!-- 임차인이 거부한 경우 가장 먼저 보여준다 -->
    <div v-if="data.tenantResponse?.decision === 'rejected'" class="card reject">
      <div class="card-body">
        <h2>임차인이 수정을 요청했습니다</h2>
        <p class="reason">{{ data.tenantResponse.reason || '사유가 적혀 있지 않습니다.' }}</p>
        <p class="faint">{{ data.tenantResponse.respondedAt }}</p>
      </div>
    </div>

    <!-- 갱신 체인 -->
    <div v-if="renewal?.parentId" class="card chain">
      <div class="card-body">
        <h2>갱신 계약입니다</h2>
        <p class="muted">
          {{ renewal.renewedFrom }}부터 이어지는 기간입니다.
          입주일은 최초 입주일({{ contract.move_in_date }})을 그대로 둡니다 —
          거주가 끊기지 않았으므로 <strong>장기수선충당금이 계속 누적</strong>됩니다.
        </p>
        <RouterLink :to="`/contracts/${renewal.parentId}`">
          <button class="btn btn-sm">이전 계약 보기</button>
        </RouterLink>
      </div>
    </div>

    <!-- 계약 조건 -->
    <div class="card">
      <div class="card-head">
        <h2>계약 조건</h2>
        <button v-if="editable && mode !== 'edit'" class="btn btn-sm" @click="openEditForm">
          조건 수정
        </button>
        <span v-else-if="!editable" class="faint">
          성립한 계약의 조건은 갱신으로만 바뀝니다
        </span>
      </div>

      <div v-if="mode === 'edit'" class="card-body edit-form">
        <div class="grid g3">
          <div>
            <label>임차인 이름</label>
            <input v-model="edit.tenantName" />
          </div>
          <div>
            <label>연락처</label>
            <input v-model="edit.tenantPhone" placeholder="010-0000-0000" />
          </div>
          <div>
            <label>입주일</label>
            <input v-model="edit.moveInDate" type="date" class="mono" />
          </div>
          <div>
            <label>보증금 (원)</label>
            <input v-model.number="edit.deposit" type="number" class="mono" />
            <p class="faint" style="margin:6px 0 0">{{ won(edit.deposit) }}</p>
          </div>
          <div>
            <label>월 차임 (원) — 전세면 0</label>
            <input v-model.number="edit.monthlyRent" type="number" class="mono" />
            <p class="faint" style="margin:6px 0 0">{{ won(edit.monthlyRent) }}</p>
          </div>
          <div>
            <label>계약 기간 (개월)</label>
            <input v-model.number="edit.termMonths" type="number" step="12" class="mono" />
          </div>
        </div>
        <p class="faint" style="margin:16px 0 0">
          만료일은 입주일과 기간에서 다시 계산됩니다.
          규칙(Rule Lock)은 따로 <strong>규칙 보기 · 수정</strong>에서 고칩니다.
          고친 뒤에는 <strong>임대인 확정 → 재발송</strong>을 다시 거쳐야 임차인에게 전달됩니다.
        </p>
        <div class="answer">
          <button class="btn btn-primary"
                  :disabled="busy || !edit.tenantName?.trim()" @click="saveEdit">
            {{ busy ? '저장 중…' : '저장' }}
          </button>
          <button class="btn" :disabled="busy" @click="mode = ''">취소</button>
        </div>
      </div>

      <table>
        <tbody>
          <tr><th style="width:200px">임차인</th>
            <td>{{ contract.tenant_name }} <span class="faint">{{ contract.tenant_phone ?? '' }}</span></td></tr>
          <tr><th>보증금</th>
            <td class="mono">{{ won(contract.deposit) }}
              <span v-if="contract.monthly_rent" class="faint">/ 월 {{ won(contract.monthly_rent) }}</span></td></tr>
          <tr><th>입주일</th><td class="mono">{{ contract.move_in_date }}</td></tr>
          <tr><th>계약 기간</th><td class="mono">{{ contract.term_months }}개월</td></tr>
          <tr>
            <th>만료 예정일</th>
            <td class="mono">
              {{ contract.expires_on ?? '—' }}
              <span v-if="data.timeline?.daysToExpiry != null" class="faint">
                D-{{ data.timeline.daysToExpiry }}
              </span>
            </td>
          </tr>
          <tr v-if="data.timeline?.noticeDeadline">
            <th>갱신거절 통지 기한</th>
            <td class="mono">
              {{ data.timeline.noticeDeadline }}
              <span class="faint">이 날까지 통지하지 않으면 묵시적 갱신</span>
            </td>
          </tr>
          <tr v-if="contract.move_out_date">
            <th>퇴거 예정일</th><td class="mono">{{ contract.move_out_date }}</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Rule Lock -->
    <div class="card">
      <div class="card-head">
        <h2>Rule Lock</h2>
        <RouterLink :to="`/contracts/${id}/rules`"><button class="btn btn-sm">규칙 보기 · 수정</button></RouterLink>
      </div>
      <div class="card-body" v-if="!rules">
        <p class="muted" style="margin:0">아직 규칙이 설정되지 않았습니다.</p>
      </div>
      <table v-else>
        <tbody>
          <tr><th style="width:200px">장기수선충당금</th>
            <td>{{ rules.ltrfBurden === 'landlord' ? '임대인 부담 — 퇴거 시 임차인에게 반환' : '임차인 부담 특약' }}</td></tr>
          <tr><th>소액 수선 기준</th><td class="mono">{{ won(rules.minorRepairThreshold) }}</td></tr>
          <tr><th>원상회복 면제 거주기간</th>
            <td class="mono">도배 {{ rules.wallpaperGraceMonths }}개월 · 바닥재 {{ rules.flooringGraceMonths }}개월</td></tr>
          <tr><th>연체 지연이자</th><td class="mono">연 {{ rules.lateInterestRate }}%</td></tr>
          <tr><th>선수관리비</th>
            <td>{{ rules.tenantPaidAdvanceFee ? `임차인 대납 ${won(rules.advanceFeeAmount)}` : '소유자 납부' }}</td></tr>
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

    <!-- 액션 -->
    <div class="card">
      <div class="card-head"><h2>다음 할 일</h2></div>
      <div class="card-body">
        <!-- 0) 갱신 판단 — 만료 6개월 안으로 들어온 거주 중 계약 -->
        <template v-if="renewOpen">
          <div v-if="mode !== 'renew'" class="step">
            <div>
              <h3>갱신 여부를 결정해 주세요</h3>
              <p class="faint">
                갱신거절 통지 기한은 <strong class="mono">{{ data.timeline.noticeDeadline }}</strong>
                (D-{{ data.timeline.daysToNoticeDeadline }})입니다.
                이 날까지 통지하지 않으면 같은 조건으로 묵시적 갱신됩니다.
              </p>
            </div>
            <div class="answer">
              <button class="btn btn-primary" :disabled="busy" @click="openRenewForm">갱신하기</button>
              <button class="btn" :disabled="busy" @click="decline">갱신하지 않음</button>
            </div>
          </div>

          <div v-else>
            <h3>갱신 조건</h3>
            <p class="faint" style="margin:2px 0 0">
              새 계약이 <strong>{{ renewalFrom }}</strong>부터 시작됩니다.
              규칙(Rule Lock)은 그대로 승계되고, 보내기 전에 고칠 수 있습니다.
            </p>
            <div class="form">
              <label>
                <span>갱신 기간</span>
                <select v-model.number="form.termMonths">
                  <option :value="12">12개월</option>
                  <option :value="24">24개월</option>
                  <option :value="36">36개월</option>
                </select>
              </label>
              <label>
                <span>보증금</span>
                <input v-model.number="form.deposit" type="number" class="mono" />
              </label>
              <label>
                <span>월 차임</span>
                <input v-model.number="form.monthlyRent" type="number" class="mono" />
              </label>
            </div>
            <div class="answer">
              <button class="btn btn-primary" :disabled="busy" @click="renew">갱신 계약 만들기</button>
              <button class="btn" :disabled="busy" @click="mode = ''">취소</button>
            </div>
          </div>
        </template>

        <!-- 종료된 계약 — 갱신으로 닫힌 경우도 여기로 온다 -->
        <div v-else-if="contract.status === 'closed'" class="step">
          <div>
            <h3>종료된 계약입니다</h3>
            <p class="faint">
              <template v-if="renewal?.childId">갱신 계약이 성립해 이 계약은 닫혔습니다.</template>
              <template v-else>기록은 집 상세의 House Log 에 남습니다.</template>
            </p>
          </div>
          <RouterLink v-if="renewal?.childId" :to="`/contracts/${renewal.childId}`">
            <button class="btn">갱신 계약 보기</button>
          </RouterLink>
        </div>

        <!-- 갱신 계약을 만들어 두고 아직 성립하지 않은 경우 -->
        <div v-else-if="renewal?.childId" class="step">
          <div>
            <h3>갱신 계약을 만들었습니다</h3>
            <p class="faint">
              임대인 확정 → 발송 → 임차인 동의를 거쳐야 성립합니다.
              성립하는 시점에 이 계약이 종료됩니다.
            </p>
          </div>
          <RouterLink :to="`/contracts/${renewal.childId}`">
            <button class="btn btn-primary">갱신 계약으로 이동</button>
          </RouterLink>
        </div>

        <!-- 퇴거 진행 중 — 점검 -->
        <template v-else-if="contract.status === 'closing'">
          <div class="step">
            <div>
              <h3>퇴거 점검</h3>
              <p class="faint">
                퇴거 예정 <strong class="mono">{{ contract.move_out_date }}</strong>.
                임차인이 구역별 사진을 올리면 항목별 책임 범위를 정하고, 그 결과가
                정산서의 원상회복 공제로 들어갑니다.
              </p>
            </div>
            <div class="answer">
              <span v-if="inspection" class="pill" :class="INSPECTION_STATUS[inspection.status].tone">
                {{ INSPECTION_STATUS[inspection.status].label }}
              </span>
              <RouterLink v-if="inspection && inspection.status !== 'requested'"
                          :to="`/contracts/${id}/inspection`">
                <button class="btn btn-primary">점검 검토</button>
              </RouterLink>
              <button v-else class="btn btn-primary" :disabled="busy" @click="requestInspection">
                {{ inspection ? '점검 링크 재발송' : '점검 요청 보내기' }}
              </button>
            </div>
          </div>

          <div v-if="inspection" class="facts">
            <span>사진 {{ inspection.photos.length }}장</span>
            <span>지정한 항목 {{ inspection.damages.length }}건</span>
            <span v-if="inspection.submittedAt">제출 {{ inspection.submittedAt }}</span>
          </div>

          <!-- 제출이 끝나면 링크는 의미가 없다 -->
          <div v-if="inspectionUrl && inspection?.status === 'requested'" class="link">
            <label>퇴거 점검 링크</label>
            <div class="link-row">
              <input class="mono" :value="inspectionUrl" readonly />
              <button class="btn" @click="copyLink(inspectionUrl)">{{ copied ? '복사됨' : '복사' }}</button>
            </div>
            <p class="faint" style="margin:8px 0 0">
              임차인이 이 링크로 구역별 사진을 올립니다. 제출하면 링크가 닫힙니다.
            </p>
          </div>
        </template>

        <!-- 갱신하지 않기로 함 → 퇴거 절차 시작 -->
        <template v-else-if="renewal?.decision === 'decline'">
          <div v-if="mode !== 'moveout'" class="step">
            <div>
              <h3>갱신하지 않기로 했습니다</h3>
              <p class="faint">
                <strong class="mono">{{ contract.expires_on }}</strong> 만료로 종료할 예정입니다.
                임차인은 만료일까지 거주합니다. 퇴거일이 정해지면 절차를 시작하세요.
              </p>
            </div>
            <button class="btn btn-primary" :disabled="busy" @click="openMoveoutForm">
              퇴거 절차 시작
            </button>
          </div>

          <div v-else>
            <h3>퇴거 예정일</h3>
            <p class="faint" style="margin:2px 0 0">
              기본값은 만료일입니다. 협의로 당기거나 미룰 수 있습니다.
              이 날짜를 기준으로 정산서 발행(D-30)과 합의 마감(D-7)을 안내합니다.
            </p>
            <div class="form">
              <label>
                <span>퇴거 예정일</span>
                <input v-model="moveOutDate" type="date" class="mono" />
              </label>
            </div>
            <div class="answer">
              <button class="btn btn-primary" :disabled="busy || !moveOutDate" @click="startMoveout">
                퇴거 절차 시작
              </button>
              <button class="btn" :disabled="busy" @click="mode = ''">취소</button>
            </div>
          </div>
        </template>

        <!-- 성립한 계약은 만료가 다가올 때까지 할 일이 없다 -->
        <div v-else-if="contract.status === 'active'" class="step">
          <div>
            <h3>거주 중입니다</h3>
            <p class="faint">
              만료 6개월 전이 되면 갱신 여부를 묻습니다.
              현재 만료까지 {{ data.timeline.daysToExpiry }}일 남았습니다.
            </p>
          </div>
        </div>

        <!-- 1) 임대인 확정 -->
        <div v-else-if="!landlordLocked" class="step">
          <div>
            <h3>임대인 확정</h3>
            <p class="faint">확정해야 임차인에게 보낼 수 있습니다. 확정 후에도 새 버전으로 변경할 수 있습니다.</p>
          </div>
          <button class="btn btn-primary" :disabled="busy || !rules" @click="lockLandlord">임대인 확정</button>
        </div>

        <!-- 2) 발송 -->
        <div v-else class="step">
          <div>
            <h3>{{ contract.status === 'pending_tenant' ? '임차인 확인 대기 중' : '임차인에게 보내기' }}</h3>
            <p class="faint">
              임차인은 링크로 계약과 규칙을 확인하고 <strong>전체 동의 또는 거부</strong>를 선택합니다.
              거부하면 사유와 함께 이 화면으로 돌아옵니다.
            </p>
          </div>
          <button class="btn btn-primary" :disabled="busy" @click="send">
            {{ contract.status === 'pending_tenant' ? '링크 재발송' : '임차인에게 보내기' }}
          </button>
        </div>

        <div v-if="linkUrl" class="link">
          <label>임차인 확인 링크</label>
          <div class="link-row">
            <input class="mono" :value="linkUrl" readonly />
            <button class="btn" @click="copyLink(linkUrl)">{{ copied ? '복사됨' : '복사' }}</button>
          </div>
          <p class="faint" style="margin:8px 0 0">
            <template v-if="linkDone">
              임차인이 이미 응답한 링크입니다. 열면 응답 결과가 보입니다 —
              조건을 고쳐 다시 보내면 새 링크가 발급되고 이 링크는 버려집니다.
            </template>
            <template v-else>
              창을 하나 더 띄워 이 링크를 열면 임차인 화면을 나란히 볼 수 있습니다.
            </template>
          </p>
        </div>
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

.edit-form { border-bottom: 1px solid var(--border); background: var(--surface-2); }
.edit-form .answer { margin-top: var(--sp-lg); }

.reject { border-color: var(--brand-ochre); }
.reject h2 { margin-bottom: var(--sp-xs); }
.reason {
  margin: 0 0 var(--sp-xs); padding: 14px 16px;
  background: var(--warn-soft); border-radius: var(--radius-md);
  font-size: 15px; color: var(--text);
}

.chain { border-color: var(--brand-lavender); }
.chain h2 { margin-bottom: var(--sp-xs); }
.chain .muted { margin: 0 0 var(--sp-md); max-width: 760px; }

.step { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-lg); }
.step h3 { margin-bottom: 2px; }
.step p { margin: 0; max-width: 620px; }

/* 갱신 조건 · 퇴거일 입력 — 데스크톱 고정 3열 */
.form {
  display: grid; grid-template-columns: 200px 1fr 1fr; gap: var(--sp-md);
  margin: var(--sp-md) 0 0; max-width: 760px;
}
.form label { display: grid; gap: var(--sp-xxs); }
.form label > span { font-size: 13px; color: var(--text-faint); font-weight: 500; }

.answer { display: flex; gap: var(--sp-sm); flex: none; margin-top: var(--sp-lg); }
.step .answer { margin-top: 0; }

.facts {
  display: flex; gap: var(--sp-lg); margin-top: var(--sp-md);
  padding-top: var(--sp-md); border-top: 1px solid var(--border);
  font-size: 14px; color: var(--text-dim);
}

.link { margin-top: var(--sp-lg); padding-top: var(--sp-lg); border-top: 1px solid var(--border); }
.link-row { display: flex; gap: var(--sp-sm); }
.link-row input { flex: 1; font-size: 14px; }
.link-row .btn { flex: none; }
</style>
