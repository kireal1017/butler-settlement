<script setup>
import { ref, computed, onMounted } from 'vue';
import { api, won } from '../api.js';
import LineDetail from '../components/LineDetail.vue';

const props = defineProps({ token: { type: String, required: true } });

const data = ref(null);
const loading = ref(true);
const error = ref('');
const busy = ref(false);
const mode = ref('');          // '' | 'reject'
const reason = ref('');
const done = ref(null);

onMounted(async () => {
  try { data.value = await api.share(props.token); }
  catch (e) { error.value = e.message; }
  finally { loading.value = false; }
});

const contract = computed(() => data.value?.contract);
const rules = computed(() => data.value?.rules);

/**
 * 받을 돈과 공제를 갈라서 보여 준다 (임대인 화면과 같은 구조).
 * 한 표에 섞으면 `+`·`−` 하나로만 구분되어 "그래서 내가 받는 게 얼마인가"를
 * 임차인이 직접 세어 봐야 한다.
 *
 * 0원 줄은 지우지 않고 아래로 내린다. 특히 장기수선충당금은 이 제품이 대체하려는
 * "관리사무소 납부확인서" 그 자체라, 항목이 없으면 확인했다는 사실이 전달되지 않는다.
 * 대신 **금액이 있는 줄만** 동의/이의를 묻는다.
 */
const SETTLEMENT_GROUPS = [
  { dir: 'tenant_credit', title: '내가 돌려받을 돈', sign: '+', tone: 'credit' },
  { dir: 'landlord_deduct', title: '보증금에서 공제되는 돈', sign: '−', tone: 'deduct' },
];

/** 임차인이 실제로 눌러야 하는 줄 수. 예전 정산서에는 answerable 이 없어 total 로 떨어진다. */
const answerable = computed(() =>
  settlement.value?.answerable ?? settlement.value?.total ?? 0);

const settlementGroups = computed(() => {
  const lines = settlement.value?.lines ?? [];
  return SETTLEMENT_GROUPS.map((g) => {
    const rows = lines.filter((l) => l.direction === g.dir)
      .sort((a, b) => (b.amount !== 0) - (a.amount !== 0) || a.seq - b.seq);
    return { ...g, rows, subtotal: rows.reduce((sum, l) => sum + l.amount, 0) };
  });
});

/**
 * 이 링크에 대한 응답이 끝났는가.
 *
 * 계약의 최신 응답(data.response)을 그대로 보면 안 된다. 거부 후 임대인이 고쳐 보낸
 * 새 링크에는 이전 버전에 대한 거부 기록이 남아 있어서, 새 제안을 열자마자
 * "수정 요청함" 으로 보이고 동의 버튼이 사라진다.
 * 판단 기준은 이 링크가 완료되었는지(completedAt)다.
 */
const settled = computed(() =>
  done.value ?? (data.value?.completedAt ? data.value.response : null));

const CATEGORY = {
  wallpaper: '도배', flooring: '바닥재', appliance: '빌트인 가전',
  fixture: '설비·집기', etc: '기타',
};

/* ── 퇴거 점검 사진 제출 ──────────────────────────────────── */

const inspection = computed(() => data.value?.inspection);
const submitted = computed(() =>
  Boolean(data.value?.completedAt) || inspection.value?.status !== 'requested');

/** 구역별로 올라간 사진을 묶는다 */
const byArea = computed(() => {
  const map = {};
  for (const p of inspection.value?.photos ?? []) (map[p.area] ??= []).push(p);
  return map;
});

const uploading = ref('');
const notes = ref({});

async function pickPhoto(area, event) {
  const file = event.target.files?.[0];
  event.target.value = '';           // 같은 파일을 다시 고를 수 있게
  if (!file) return;

  uploading.value = area;
  error.value = '';
  try {
    await api.uploadPhoto(props.token, { file, area, note: notes.value[area] });
    notes.value[area] = '';
    data.value = await api.share(props.token);   // 목록을 서버 기준으로 다시 읽는다
  } catch (e) { error.value = e.message; }
  finally { uploading.value = ''; }
}

async function finishInspection() {
  busy.value = true;
  error.value = '';
  try {
    await api.submitInspection(props.token);
    data.value = await api.share(props.token);
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}

async function respond(decision) {
  busy.value = true;
  error.value = '';
  try {
    await api.respondContract(props.token, decision, reason.value);
    done.value = { decision, reason: reason.value };
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}

/* ── 퇴거 정산서 확인 ─────────────────────────────────────── */

const settlement = computed(() => data.value?.settlement);
const settlementDone = computed(() => Boolean(data.value?.completedAt));

const openLines = ref(new Set());
function toggleLine(seq) {
  const s = new Set(openLines.value);
  s.has(seq) ? s.delete(seq) : s.add(seq);
  openLines.value = s;
}

const disputeFor = ref(null);   // 이의 사유를 적는 중인 seq
const disputeNote = ref('');

async function answerLine(seq, status) {
  /* 이의는 사유가 있어야 임대인이 무엇을 고칠지 안다. 먼저 입력칸을 연다. */
  if (status === 'disputed' && disputeFor.value !== seq) {
    disputeFor.value = seq;
    disputeNote.value = '';
    return;
  }

  busy.value = true;
  error.value = '';
  try {
    await api.respondSettlement(props.token, seq, status,
      status === 'disputed' ? disputeNote.value : null);
    data.value = await api.share(props.token);
    disputeFor.value = null;
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}

async function finishSettlement() {
  busy.value = true;
  error.value = '';
  try {
    await api.submitSettlement(props.token);
    data.value = await api.share(props.token);
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="sheet">
    <div v-if="loading" class="card"><div class="empty">불러오는 중…</div></div>
    <div v-else-if="!data" class="card">
      <div class="empty">{{ error }}</div>
    </div>

    <!-- 계약 확인 -->
    <template v-else-if="data.purpose === 'contract_review'">
      <div class="head">
        <h1>계약 내용 확인</h1>
        <p class="muted">
          {{ contract.landlordName }}님이 보낸 임대차 계약입니다.
          내용과 정산 규칙을 확인하고 동의 여부를 알려 주세요.
        </p>
      </div>

      <div v-if="error" class="notice" style="margin-bottom:16px">{{ error }}</div>

      <!-- 이미 응답한 경우 -->
      <div v-if="settled" class="card result">
        <div class="card-body">
          <span class="pill" :class="settled.decision === 'accepted' ? 'ok' : 'warn'">
            {{ settled.decision === 'accepted' ? '동의 완료' : '수정 요청함' }}
          </span>
          <h2 v-if="settled.decision === 'accepted'">계약이 성립되었습니다</h2>
          <h2 v-else>수정 요청을 보냈습니다</h2>
          <p v-if="settled.decision === 'accepted'" class="muted">
            이 규칙은 퇴거 정산 때 그대로 재생됩니다. 지금부터는 양측 합의 없이 바뀌지 않습니다.
          </p>
          <p v-else class="muted">
            임대인이 내용을 고쳐 다시 보내면 새 링크로 안내됩니다.
          </p>
          <p v-if="settled.reason" class="reason">{{ settled.reason }}</p>
        </div>
      </div>

      <!-- 집 · 계약 조건 -->
      <div class="card">
        <div class="card-head"><h2>계약 조건</h2></div>
        <table>
          <tbody>
            <tr><th style="width:200px">집</th>
              <td>{{ data.unit.complexName }} {{ data.unit.dong }} {{ data.unit.ho }}
                <div class="faint">{{ data.unit.address }} · 전용 {{ data.unit.exclusiveArea }}㎡</div></td></tr>
            <tr><th>임대인</th><td>{{ contract.landlordName }}</td></tr>
            <tr><th>임차인</th><td>{{ contract.tenantName }}</td></tr>
            <tr><th>보증금</th>
              <td class="mono">{{ won(contract.deposit) }}
                <span v-if="contract.monthlyRent" class="faint">/ 월 {{ won(contract.monthlyRent) }}</span></td></tr>
            <tr><th>입주일</th><td class="mono">{{ contract.moveInDate }}</td></tr>
            <tr><th>계약 기간</th>
              <td class="mono">{{ contract.termMonths }}개월 · 만료 {{ contract.expiresOn }}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Rule Lock -->
      <div class="card">
        <div class="card-head">
          <h2>퇴거 정산 규칙</h2>
          <span class="faint">퇴거할 때 이 규칙 그대로 계산됩니다</span>
        </div>
        <table v-if="rules">
          <tbody>
            <tr>
              <th style="width:280px">장기수선충당금</th>
              <td>
                {{ rules.ltrfBurden === 'landlord'
                  ? '임대인 부담 — 내가 대신 낸 금액은 퇴거 때 돌려받습니다'
                  : '임차인 부담 특약 — 돌려받지 않습니다' }}
                <div class="faint">공동주택관리법 시행령 제31조 제8항은 소유자 부담으로 정하고 있습니다</div>
              </td>
            </tr>
            <tr>
              <th>입주월·퇴거월 관리비</th>
              <td>{{ rules.prorateEdgeMonths ? '거주한 날짜만큼만 일할 계산' : '월 단위 전액' }}</td>
            </tr>
            <tr>
              <th>소액 수선 기준</th>
              <td class="mono">{{ won(rules.minorRepairThreshold) }}
                <div class="faint">이하는 임차인, 초과는 임대인 부담</div></td>
            </tr>
            <tr>
              <th>원상회복 면제 거주기간</th>
              <td class="mono">도배 {{ rules.wallpaperGraceMonths }}개월 · 바닥재 {{ rules.flooringGraceMonths }}개월
                <div class="faint">이 기간 이상 살면 해당 품목은 공제하지 않습니다</div></td>
            </tr>
            <tr>
              <th>차임 연체 지연이자</th>
              <td class="mono">연 {{ rules.lateInterestRate }}%</td>
            </tr>
            <tr>
              <th>선수관리비</th>
              <td>{{ rules.tenantPaidAdvanceFee
                ? `임차인 대납 ${won(rules.advanceFeeAmount)} — 퇴거 때 반환`
                : '소유자 납부 — 반환 없음' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 품목 -->
      <div class="card">
        <div class="card-head">
          <h2>원상회복 기준 품목</h2>
          <span class="faint">공제액 = 교체비용 × 남은 수명 비율 × 내 책임 비율</span>
        </div>
        <table v-if="data.ruleItems.length">
          <thead>
            <tr>
              <th>품목</th><th>최종 시공일</th>
              <th class="num">내용연수</th><th class="num">교체비용</th><th>거주기간 면제</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in data.ruleItems" :key="it.id">
              <td>
                <strong>{{ it.label }}</strong>
                <div class="faint">{{ CATEGORY[it.category] ?? it.category }}</div>
              </td>
              <td class="mono">{{ it.last_renewed_on }}</td>
              <td class="num mono">{{ it.useful_life_years }}년</td>
              <td class="num mono">{{ won(it.replacement_cost) }}</td>
              <td>{{ it.grace_applicable ? '적용' : '미적용' }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">등록된 품목이 없습니다.</div>
      </div>

      <p class="disclaimer">
        이 금액들은 <strong>법적 판정이 아니라 양 당사자가 확정한 합의 참조값</strong>입니다.
        퇴거 정산서는 이 규칙과 공공데이터를 근거로 자동 계산되며, 항목별로 다시 확인하실 수 있습니다.
      </p>

      <!-- 응답 -->
      <div v-if="!settled" class="card">
        <div class="card-body">
          <template v-if="mode !== 'reject'">
            <h2>이 내용에 동의하시나요?</h2>
            <p class="muted" style="margin:6px 0 0">
              동의하면 계약이 성립하고, 이 규칙은 양측 합의 없이 바뀌지 않습니다.
            </p>
            <div class="answer">
              <button class="btn btn-primary" :disabled="busy" @click="respond('accepted')">
                전체 동의
              </button>
              <button class="btn" :disabled="busy" @click="mode = 'reject'">
                수정 요청
              </button>
            </div>
          </template>

          <template v-else>
            <h2>어디를 고쳐야 할까요?</h2>
            <p class="muted" style="margin:6px 0 12px">
              적어 주신 내용이 임대인에게 그대로 전달됩니다.
            </p>
            <input v-model="reason" placeholder="예: 도배 면제 거주기간을 24개월로 낮춰 주세요" />
            <div class="answer">
              <button class="btn btn-primary" :disabled="busy || !reason.trim()"
                      @click="respond('rejected')">수정 요청 보내기</button>
              <button class="btn" :disabled="busy" @click="mode = ''; reason = ''">취소</button>
            </div>
          </template>
        </div>
      </div>
    </template>

    <!-- 퇴거 점검 사진 제출 -->
    <template v-else-if="data.purpose === 'inspection'">
      <div class="head">
        <h1>퇴거 점검 사진</h1>
        <p class="muted">
          {{ data.unit.complexName }} {{ data.unit.dong }} {{ data.unit.ho }} ·
          퇴거 예정 {{ contract.moveOutDate }}
        </p>
        <p class="muted">
          구역별로 현재 상태를 찍어 올려 주세요. 올리신 사진은 임대인이 확인하고
          항목별로 책임 범위를 정하는 근거가 됩니다.
        </p>
      </div>

      <div v-if="error" class="notice" style="margin-bottom:16px">{{ error }}</div>

      <div v-if="submitted" class="card result">
        <div class="card-body">
          <span class="pill ok">제출 완료</span>
          <h2>사진을 제출했습니다</h2>
          <p class="muted">
            임대인이 확인한 뒤 정산서에 항목별로 반영됩니다.
            이의가 있는 항목은 정산서에서 다시 표시하실 수 있습니다.
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>구역별 사진</h2>
          <span class="faint">{{ inspection?.photos?.length ?? 0 }}장 올림</span>
        </div>
        <div class="areas">
          <section v-for="a in inspection?.areas ?? []" :key="a.key" class="area">
            <div class="area-head">
              <strong>{{ a.label }}</strong>
              <span class="faint">{{ (byArea[a.key] ?? []).length }}장</span>
            </div>

            <div v-if="(byArea[a.key] ?? []).length" class="shots">
              <figure v-for="p in byArea[a.key]" :key="p.id">
                <img :src="api.photoUrl(p.id)" :alt="`${a.label} 사진`" />
                <figcaption v-if="p.note" class="faint">{{ p.note }}</figcaption>
              </figure>
            </div>
            <p v-else class="faint empty-area">아직 올린 사진이 없습니다.</p>

            <div v-if="!submitted" class="area-add">
              <input v-model="notes[a.key]" placeholder="설명 (선택) — 예: 벽지 모서리 들뜸" />
              <label class="btn file">
                {{ uploading === a.key ? '올리는 중…' : '사진 올리기' }}
                <input type="file" accept="image/*" :disabled="Boolean(uploading)"
                       @change="pickPhoto(a.key, $event)" />
              </label>
            </div>
          </section>
        </div>
      </div>

      <p class="disclaimer">
        사진은 임대인과 임차인 양측의 <strong>합의 근거</strong>로만 쓰입니다.
        정산 금액은 법적 판정이 아니라 양 당사자가 확정한 규칙에 따른 참조값입니다.
      </p>

      <div v-if="!submitted" class="card">
        <div class="card-body">
          <h2>다 올리셨나요?</h2>
          <p class="muted" style="margin:6px 0 0">
            제출하면 이 링크는 닫히고 임대인 확인으로 넘어갑니다.
          </p>
          <div class="answer">
            <button class="btn btn-primary"
                    :disabled="busy || !(inspection?.photos?.length)"
                    @click="finishInspection">점검 사진 제출</button>
          </div>
        </div>
      </div>
    </template>

    <!-- 퇴거 정산서 확인 -->
    <template v-else-if="data.purpose === 'settlement' && settlement">
      <div class="head">
        <h1>퇴거 정산서 확인</h1>
        <p class="muted">
          {{ data.unit.complexName }} {{ data.unit.dong }} {{ data.unit.ho }} ·
          {{ contract.tenantName }} 님
        </p>
      </div>

      <div v-if="error" class="notice" style="margin-bottom:16px">{{ error }}</div>

      <div v-if="settlementDone" class="card result">
        <div class="card-body">
          <h2>확인이 제출되었습니다</h2>
          <p class="muted">
            {{ settlement.agreed }}건 동의
            <template v-if="settlement.total - settlement.agreed">
              · 이의 {{ settlement.total - settlement.agreed }}건
            </template>
            — 임대인이 내용을 확인합니다.
          </p>
        </div>
      </div>

      <!-- 최종 금액 -->
      <div class="card">
        <div class="card-body">
          <div class="faint">돌려받게 되는 금액 (보증금 {{ won(settlement.totals.deposit) }} 포함)</div>
          <div class="big-money">{{ won(settlement.totals.depositReturn) }}</div>
          <p class="muted" style="margin:10px 0 0">
            내가 돌려받을 항목 {{ won(settlement.totals.tenantCredit) }} −
            임대인이 공제하는 항목 {{ won(settlement.totals.landlordDeduct) }}
          </p>
        </div>
      </div>

      <!-- 항목별 확인 -->
      <div class="card">
        <div class="card-head">
          <h2>항목별로 확인해 주세요</h2>
          <span class="faint">{{ settlement.answered }}/{{ answerable }} 확인함</span>
        </div>
        <div class="card-body" style="padding:0">
          <div v-for="g in settlementGroups" :key="g.dir" class="lgroup">
            <div class="lgroup-head">
              <h3 :class="g.tone">{{ g.title }}</h3>
              <span class="mono" :class="g.subtotal ? g.tone : 'faint'">
                <template v-if="g.subtotal">{{ g.sign }}</template>{{ won(g.subtotal) }}
              </span>
            </div>
            <p v-if="!g.rows.length" class="lgroup-empty">해당하는 항목이 없습니다.</p>
          <table v-else>
            <tbody v-for="l in g.rows" :key="l.seq">
              <tr class="row" :class="{ zero: l.amount === 0 }" @click="toggleLine(l.seq)">
                <td>
                  <div style="font-weight:600">{{ l.label }}</div>
                  <div class="faint" :class="{ 'why-warn': l.calcStatus === 'partial' }">
                    <template v-if="l.calcReason">
                      <template v-if="l.calcStatus === 'partial'">⚠ </template>{{ l.calcReason }}
                    </template>
                    <template v-else>
                      {{ l.direction === 'tenant_credit' ? '내가 돌려받는 금액' : '보증금에서 공제되는 금액' }}
                      · 눌러서 계산 근거 보기
                    </template>
                  </div>
                  <div v-if="l.note" class="my-note">내가 남긴 이의: {{ l.note }}</div>
                </td>
                <td class="num mono" style="width:150px"
                    :class="l.amount === 0 ? 'faint' : g.tone">
                  <template v-if="l.amount === 0">0원</template>
                  <template v-else>{{ g.sign }}{{ won(l.amount) }}</template>
                </td>
                <td style="width:190px" @click.stop>
                  <!-- 돈이 오가지 않는 줄은 확인을 묻지 않는다 — 정작 볼 곳이 흐려진다 -->
                  <span v-if="l.amount === 0" class="faint">확인 불필요</span>
                  <template v-else-if="!settlementDone">
                    <button class="btn btn-sm" :class="{ 'btn-primary': l.status === 'agreed' }"
                            :disabled="busy" @click="answerLine(l.seq, 'agreed')">동의</button>
                    <button class="btn btn-sm" style="margin-left:6px"
                            :class="{ 'btn-primary': l.status === 'disputed' }"
                            :disabled="busy" @click="answerLine(l.seq, 'disputed')">이의</button>
                  </template>
                  <span v-else class="pill" :class="{ ok: l.status === 'agreed' }">
                    {{ l.status === 'agreed' ? '동의' : '이의' }}
                  </span>
                </td>
              </tr>
              <tr v-if="disputeFor === l.seq && !settlementDone">
                <td colspan="3" style="background:var(--surface-2)">
                  <label class="faint">어떤 점이 맞지 않는지 적어 주세요</label>
                  <textarea v-model="disputeNote" rows="3"
                            placeholder="예: 인덕션은 입주 전부터 고장나 있었습니다"></textarea>
                  <div class="answer dispute-actions">
                    <button class="btn btn-sm" @click="disputeFor = null">취소</button>
                    <button class="btn btn-sm btn-primary" style="margin-left:6px"
                            :disabled="busy || !disputeNote.trim()"
                            @click="answerLine(l.seq, 'disputed')">이의 제출</button>
                  </div>
                </td>
              </tr>
              <tr v-if="openLines.has(l.seq)">
                <td colspan="3" style="background:var(--surface-2)">
                  <LineDetail :line="l" />
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
      </div>

      <p class="disclaimer">
        이 금액은 계약할 때 양측이 확정한 규칙과 공공데이터에 근거한
        <strong>합의 참조값</strong>이며 법적 판정이 아닙니다. 이견이 계속되면
        주택임대차분쟁조정위원회의 조정 절차를 이용할 수 있습니다.
      </p>

      <div v-if="!settlementDone" class="card">
        <div class="card-body">
          <h2>다 확인하셨나요?</h2>
          <p class="muted" style="margin:6px 0 0">
            제출하면 이 링크는 닫히고 임대인에게 결과가 전달됩니다.
          </p>
          <div class="answer">
            <!-- 확인을 물은 줄(=금액이 있는 줄)만 센다. `total` 은 0원 줄까지 포함한
                 전체 항목 수라, 그걸로 막으면 화면에 '확인 불필요' 라고 적어 둔 줄 때문에
                 영원히 제출할 수 없다. -->
            <button class="btn btn-primary"
                    :disabled="busy || settlement.answered < answerable"
                    @click="finishSettlement">
              {{ settlement.answered < answerable
                ? `아직 ${answerable - settlement.answered}건 남았습니다`
                : '확인 제출' }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- 아직 만들지 않은 용도 -->
    <div v-else class="card">
      <div class="empty">이 링크는 아직 열 수 없습니다. ({{ data.purpose }})</div>
    </div>
  </div>
</template>

<style scoped>
.sheet { max-width: 820px; margin: 0 auto; }
.head { margin-bottom: var(--sp-lg); }
.head .muted { margin: var(--sp-xs) 0 0; font-size: 16px; }

.row { cursor: pointer; }
.row:hover { background: var(--surface-2); }
.big-money {
  margin-top: var(--sp-xxs); font-size: 34px; font-weight: 500;
  letter-spacing: -0.02em; font-variant-numeric: tabular-nums;
}
.my-note { margin-top: 6px; font-size: 13px; color: var(--deduct); }

.result { border-color: var(--text); }
.result h2 { margin: var(--sp-sm) 0 var(--sp-xxs); font-size: 20px; }
.result .muted { margin: 0; }
.reason {
  margin: var(--sp-sm) 0 0; padding: 14px 16px;
  background: var(--surface-2); border-radius: var(--radius-md); font-size: 15px;
}

.disclaimer {
  margin: var(--sp-md) 0; padding: 16px;
  background: var(--surface-2); border-radius: var(--radius-md);
  font-size: 13px; line-height: 1.7; color: var(--text-dim);
}

.answer { display: flex; gap: var(--sp-sm); margin-top: var(--sp-lg); }

/* ── 점검 사진 ────────────────────────────────────────── */
.areas { padding: var(--sp-sm) var(--sp-lg) var(--sp-lg); }
.area { padding: var(--sp-md) 0; }
.area + .area { border-top: 1px solid var(--border); }

.dispute-actions { margin-top: 10px; }

.lgroup + .lgroup { border-top: 8px solid var(--surface-2); }
.lgroup-head {
  display: flex; align-items: baseline; justify-content: space-between;
  padding: 14px var(--sp-lg) 10px;
}
.lgroup-head h3 { margin: 0; font-size: 15px; font-weight: 600; }
.lgroup-head .mono { font-size: 15px; font-weight: 600; }
.lgroup-empty {
  margin: 0; padding: 0 var(--sp-lg) 16px; font-size: 13.5px; color: var(--text-faint);
}
.row.zero td { color: var(--text-dim); }
.why-warn { color: var(--warn); font-weight: 500; }
.area-head { display: flex; align-items: baseline; gap: var(--sp-sm); margin-bottom: var(--sp-sm); }
.area-head strong { font-size: 15px; font-weight: 600; }

/* 데스크톱 고정 4열 — auto-fill 을 쓰지 않는다 */
.shots { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--sp-sm); }
.shots figure { margin: 0; }
.shots img {
  display: block; width: 100%; height: 132px; object-fit: cover;
  border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-2);
}
.shots figcaption { margin-top: var(--sp-xxs); }

.empty-area { margin: 0; }

.area-add { display: flex; gap: var(--sp-sm); margin-top: var(--sp-sm); }
.area-add input[type="text"], .area-add input:not([type]) { flex: 1; }
.btn.file { position: relative; overflow: hidden; flex: none; cursor: pointer; }
.btn.file input[type="file"] { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
</style>
