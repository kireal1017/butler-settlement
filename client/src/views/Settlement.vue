<script setup>
import { ref, onMounted, computed } from 'vue';
import { api, won } from '../api.js';
import LineDetail from '../components/LineDetail.vue';

const props = defineProps({ id: String });

const data = ref(null);       // 발행된 정산서
const preview = ref(null);    // 미발행 상태의 미리보기
const open = ref(new Set());
const err = ref('');
const busy = ref(false);
const copied = ref(false);

const view = computed(() => data.value ?? preview.value);
const issued = computed(() => Boolean(data.value));
const sealed = computed(() => data.value?.status === 'sealed');

/* 키가 있다고 해서 단가가 실데이터인 것은 아니다. K-apt 가 공개하지 않은 달은
   시드 단가로 남으므로, 실제 구성을 그대로 적는다. */
const rateNote = computed(() => {
  const d = view.value?.dataSource;
  if (!d) return '';
  const { ltrfSource: s, ltrfKaptMonths: k, ltrfMonths: n } = d;
  if (s === 'kapt') return `K-apt 실 단가 ${n}개월분`;
  if (s === 'mixed') return `K-apt 실 단가 ${k}개월 + 미공개 ${n - k}개월은 직전 단가 적용`;
  if (s === 'seed') return `샘플 단가 ${n}개월분 (K-apt 미연동)`;
  return '단가 자료 없음';
});

async function load() {
  err.value = '';
  try {
    data.value = await api.settlement(props.id);
    preview.value = null;
  } catch {
    data.value = null;
    try { preview.value = await api.preview(props.id); }
    catch (e) { err.value = e.message; }
  }
}
onMounted(load);

async function issue() {
  busy.value = true; err.value = '';
  try { data.value = await api.issue(props.id); preview.value = null; }
  catch (e) { err.value = e.message; }
  finally { busy.value = false; }
}

/* 임차인 확인 링크 발급. 이 화면에는 임차인 버튼이 없다 — 임차인의 동의는
   `/t/:token` 에서만 들어온다. */
async function sendLink() {
  busy.value = true; err.value = '';
  try {
    await api.sendSettlement(props.id);
    await load();
    copied.value = false;
  } catch (e) { err.value = e.message; }
  finally { busy.value = false; }
}

const shareUrl = computed(() =>
  (data.value?.shareLink ? `${location.origin}${data.value.shareLink.url}` : ''));

async function copyLink() {
  try {
    await navigator.clipboard.writeText(shareUrl.value);
    copied.value = true;
  } catch { copied.value = false; }
}

async function seal() {
  busy.value = true; err.value = '';
  try { data.value = await api.seal(data.value.id); }
  catch (e) { err.value = e.message; }
  finally { busy.value = false; }
}

function toggle(seq) {
  const s = new Set(open.value);
  s.has(seq) ? s.delete(seq) : s.add(seq);
  open.value = s;
}

const STATUS_TXT = { pending: '확인 대기', agreed: '동의', disputed: '이의' };

/**
 * 받을 돈과 공제를 갈라서 보여 준다.
 *
 * 한 표에 섞어 두면 `+`·`−` 기호 하나로만 구분되어, 임차인이 "그래서 내가 받는 게
 * 뭐고 빼는 게 뭔가"를 세어 봐야 했다. 묶음마다 소계를 두어 합계가 어디서 나왔는지
 * 바로 읽히게 한다.
 *
 * 0원 줄은 지우지 않고 아래로 내린다 — 금액이 있는 줄이 위에 오되,
 * "장기수선충당금은 아예 안 봤나" 라는 의문이 남지 않아야 한다.
 */
const GROUPS = [
  { dir: 'tenant_credit', title: '임차인이 받을 돈', sign: '+', tone: 'credit' },
  { dir: 'landlord_deduct', title: '임대인이 공제할 돈', sign: '−', tone: 'deduct' },
];

const groups = computed(() => {
  const lines = view.value?.lines ?? [];
  return GROUPS.map((g) => {
    const rows = lines.filter((l) => l.direction === g.dir)
      .sort((a, b) => (b.amount !== 0) - (a.amount !== 0) || a.seq - b.seq);
    return { ...g, rows, subtotal: rows.reduce((sum, l) => sum + l.amount, 0) };
  });
});

/** 미리보기는 engine 의 status/reason, 발행 후에는 DB 에 저장된 calcStatus/calcReason */
const calc = (l) => ({
  status: l.calcStatus ?? l.status ?? 'counted',
  reason: l.calcReason ?? l.reason ?? null,
});
const printPage = () => window.print();

/* 임차인이 어디까지 왔는지 한 줄로. 링크를 아직 안 보냈는지, 열어는 봤는지,
   제출까지 했는지가 임대인이 실제로 궁금해하는 것이다. */
const tenantProgress = computed(() => {
  const d = data.value;
  if (!d) return '';
  const link = d.shareLink;
  if (!link) return '아직 확인 링크를 보내지 않았습니다';
  if (link.completedAt) return `임차인이 확인을 마쳤습니다 (${link.completedAt})`;
  if (link.firstOpenedAt) return `임차인이 ${link.firstOpenedAt} 에 열람했습니다 — 제출 대기`;
  return '링크를 보냈습니다 — 아직 열지 않았습니다';
});
</script>

<template>
  <div v-if="err && !view" class="notice">{{ err }}</div>
  <div v-else-if="!view" class="card"><div class="empty">불러오는 중…</div></div>

  <template v-else>
    <div class="head">
      <div>
        <h1>퇴거 정산서</h1>
        <p class="muted" style="margin:4px 0 0">
          {{ view.contract.complexName }} {{ view.contract.dong }} {{ view.contract.ho }} ·
          전용 {{ view.contract.exclusiveArea }}㎡ ·
          {{ view.contract.moveInDate }} ~ {{ view.contract.moveOutDate }}
        </p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <RouterLink :to="`/contracts/${id}/rules`"><button class="btn btn-sm">규칙 보기</button></RouterLink>
        <button class="btn btn-sm" @click="printPage">인쇄 / PDF</button>
      </div>
    </div>

    <div v-if="err" class="notice" style="margin-bottom:14px">{{ err }}</div>

    <!-- 요약 -->
    <div class="card summary">
      <div class="sum-grid">
        <div>
          <div class="faint">임차인이 받을 돈</div>
          <div class="big credit mono">{{ won(view.totals.tenantCredit) }}</div>
        </div>
        <div class="op">−</div>
        <div>
          <div class="faint">임대인이 공제할 돈</div>
          <div class="big deduct mono">{{ won(view.totals.landlordDeduct) }}</div>
        </div>
        <div class="op">=</div>
        <div>
          <div class="faint">최종 상계</div>
          <div class="big mono" :class="view.totals.net >= 0 ? 'credit' : 'deduct'">
            {{ view.totals.net >= 0 ? '+' : '' }}{{ won(view.totals.net) }}
          </div>
        </div>
      </div>
      <div class="sum-foot">
        <span class="muted">보증금 {{ won(view.totals.deposit) }} 포함, 임차인에게 반환할 총액</span>
        <strong class="mono" style="font-size:19px">{{ won(view.totals.depositReturn) }}</strong>
      </div>
    </div>

    <!-- 발행 전 -->
    <div v-if="!issued" class="card">
      <div class="card-body actions">
        <div>
          <strong>아직 발행되지 않은 미리보기입니다.</strong>
          <div class="faint" style="margin-top:4px">
            장기수선충당금은 {{ rateNote }} 기준으로 계산되었습니다.
          </div>
        </div>
        <button class="btn btn-primary" @click="issue" :disabled="busy">정산서 발행하고 합의 시작</button>
      </div>
    </div>

    <!-- 발행 후 — 임차인 동의 현황 -->
    <div v-else class="card">
      <div class="card-body actions">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span class="pill" :class="sealed ? 'ok' : view.status === 'agreed' ? 'accent' : 'warn'">
            {{ sealed ? '확정 완료' : view.status === 'agreed' ? '합의 완료 — 확정 대기' : '합의 진행 중' }}
          </span>
          <span class="faint mono">
            임차인 동의 {{ view.agreement.tenantAgreed }}/{{ view.agreement.total }}
            <template v-if="view.agreement.disputedCount">
              · 이의 {{ view.agreement.disputedCount }}건
            </template>
          </span>
        </div>
        <button class="btn btn-primary" @click="seal"
                :disabled="busy || sealed || !view.agreement.bothAgreedAll">
          정산 확정
        </button>
      </div>

      <!-- 임차인 확인 링크 -->
      <div v-if="!sealed" class="card-body share">
        <div>
          <strong>임차인 {{ view.contract.tenantName }} 님에게 보낼 확인 링크</strong>
          <div class="faint" style="margin-top:4px">{{ tenantProgress }}</div>
          <div v-if="data.shareLink" class="linkbox mono">{{ shareUrl }}</div>
        </div>
        <div style="display:flex;gap:8px;white-space:nowrap">
          <button v-if="data.shareLink" class="btn btn-sm" @click="copyLink">
            {{ copied ? '복사됨' : '링크 복사' }}
          </button>
          <button class="btn btn-sm btn-primary" @click="sendLink" :disabled="busy">
            {{ data.shareLink ? '새 링크 발급' : '확인 링크 발급' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 항목 -->
    <div class="card">
      <div class="card-head">
        <h2>정산 항목</h2>
        <span class="faint">금액을 누르면 계산 근거가 펼쳐집니다</span>
      </div>
      <div class="card-body" style="padding:0">
        <div v-for="g in groups" :key="g.dir" class="group">
          <div class="group-head">
            <h3 :class="g.tone">{{ g.title }}</h3>
            <!-- 0원에 부호를 붙이면 '−0원' 이 되어 읽는 사람이 한 번 멈춘다 -->
            <span class="mono" :class="g.subtotal ? g.tone : 'faint'">
              <template v-if="g.subtotal">{{ g.sign }}</template>{{ won(g.subtotal) }}
            </span>
          </div>

          <!-- 이 정산서가 만들어지기 전에 발행된 것이면 0원 줄이 저장되어 있지 않다.
               빈 표만 남으면 고장으로 보이므로 왜 비었는지 적는다. -->
          <p v-if="!g.rows.length" class="group-empty">
            해당하는 항목이 없습니다.
            <template v-if="issued">예전 양식으로 발행된 정산서라면 <strong>정산 재발행</strong> 후 전 항목이 표시됩니다.</template>
          </p>

          <table v-else>
            <thead>
              <tr>
                <th style="width:34px"></th>
                <th>항목</th>
                <th class="num" style="width:150px">금액</th>
                <th v-if="issued" style="width:130px">임차인</th>
              </tr>
            </thead>
            <template v-for="l in g.rows" :key="l.seq">
              <tbody>
                <tr class="row" :class="{ zero: l.amount === 0 }" @click="toggle(l.seq)">
                  <td class="faint mono">{{ l.seq }}</td>
                  <td>
                    <span :class="g.tone">{{ l.amount === 0 ? '·' : (g.sign === '+' ? '▲' : '▼') }}</span>
                    {{ l.label }}
                    <div v-if="calc(l).reason" class="why"
                         :class="{ warn: calc(l).status === 'partial' }">
                      <template v-if="calc(l).status === 'partial'">⚠ </template>{{ calc(l).reason }}
                    </div>
                  </td>
                  <td class="num mono" :class="l.amount === 0 ? 'faint' : g.tone">
                    <template v-if="l.amount === 0">0원</template>
                    <template v-else>{{ g.sign }}{{ won(l.amount) }}</template>
                  </td>
                  <td v-if="issued">
                    <span v-if="l.amount === 0" class="faint">—</span>
                    <span v-else class="pill"
                          :class="{ok: l.tenant_status==='agreed', no: l.tenant_status==='disputed'}">
                      {{ STATUS_TXT[l.tenant_status] }}
                    </span>
                  </td>
                </tr>
                <tr v-if="open.has(l.seq)">
                  <td></td>
                  <td :colspan="issued ? 3 : 2" style="background:var(--surface-2)">
                    <LineDetail :line="l" />
                    <div v-if="l.tenant_note" class="notes">
                      <div>임차인 의견: {{ l.tenant_note }}</div>
                    </div>
                  </td>
                </tr>
              </tbody>
            </template>
          </table>
        </div>
      </div>
    </div>

    <div v-if="sealed" class="card">
      <div class="card-body">
        <div class="pill ok">확정 {{ data.sealedAt }}</div>
        <p class="faint" style="margin:10px 0 0">
          확정 시점의 정산 내용이 동결되었습니다. 무결성 해시
          <code class="mono">{{ data.snapshotHash }}</code>
        </p>
      </div>
    </div>

    <p class="faint disclaimer">
      본 정산서의 금액은 계약 시 양 당사자가 확정한 규칙(Rule Lock)과 공공데이터에 근거한
      <strong>합의 참조값</strong>이며, 법적 판정이 아닙니다. 이견이 지속될 경우
      주택임대차분쟁조정위원회 조정 절차를 이용할 수 있습니다.
    </p>
  </template>
</template>

<style scoped>
.head { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:18px; }
.summary { padding: 20px; }
.sum-grid {
  display: grid; grid-template-columns: 1fr auto 1fr auto 1fr;
  gap: 14px; align-items: center;
}
.op { font-size: 20px; color: var(--text-faint); }
.big { font-size: 24px; font-weight: 600; letter-spacing: -0.3px; margin-top: 2px; }
.sum-foot {
  margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.group + .group { border-top: 8px solid var(--surface-2); }
.group-head {
  display: flex; align-items: baseline; justify-content: space-between;
  padding: 14px var(--sp-lg) 10px;
}
.group-head h3 { margin: 0; font-size: 15px; font-weight: 600; }
.group-head .mono { font-size: 15px; font-weight: 600; }

.row { cursor: pointer; }
.row:hover { background: var(--surface-2); }
/* 0원 줄 — 지우지는 않되 금액이 있는 줄보다 뒤로 물러나 보여야 한다 */
.row.zero td { color: var(--text-dim); }
.group-empty {
  margin: 0; padding: 0 var(--sp-lg) 16px;
  font-size: 13.5px; color: var(--text-faint); line-height: 1.6;
}
.why { margin-top: 3px; font-size: 12.5px; color: var(--text-faint); line-height: 1.5; }
/* 금액은 나왔는데 구간이 모자란 경우 — 완전한 숫자로 오해하면 안 된다 */
.why.warn { color: var(--warn); font-weight: 500; }
.actions { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; }
.share {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  border-top: 1px solid var(--border);
}
.linkbox {
  margin-top: 8px; padding: 9px 12px; font-size: 12.5px; word-break: break-all;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.notes { margin-top: 10px; font-size: 13px; color: var(--deduct); }
.disclaimer { margin-top: 18px; line-height: 1.6; }
code { font-size: 11.5px; word-break: break-all; }
@media print {
  .btn, .actions button, .share { display: none !important; }
}
</style>
