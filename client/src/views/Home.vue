<script setup>
import { ref, computed, onMounted } from 'vue';
import { api, won } from '../api.js';
import { landlord, sessionError } from '../session.js';

const units = ref([]);
const tasks = ref([]);
const taskSummary = ref(null);
const loading = ref(true);
const error = ref(sessionError.value);

onMounted(async () => {
  /* 시드를 한 번도 돌리지 않았거나 API 가 죽어 있으면 임대인이 없다 */
  if (!landlord.value) { loading.value = false; return; }

  try {
    /* 할 일은 조회 시점에 서버가 규칙을 다시 돌려 갱신한다 (크론 없음) */
    const [unitsRes, tasksRes] = await Promise.all([
      api.units(landlord.value.id),
      api.tasks(landlord.value.id),
    ]);
    units.value = unitsRes.units;
    tasks.value = tasksRes.tasks;
    taskSummary.value = tasksRes.summary;
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
});

/* 심각도 → 채도 팔레트. 같은 색을 나란히 두지 않으려고 세 단계에 다른 계열을 쓴다 */
const SEVERITY = {
  urgent: { tone: 'pink', label: '지금' },
  warn: { tone: 'warn', label: '임박' },
  info: { tone: 'teal', label: '확인' },
};

/**
 * 모르는 심각도가 와도 화면이 죽지 않게 한다.
 * `SEVERITY[t.severity].tone` 을 직접 읽다가 서버가 빈 문자열을 보낸 적이 있는데,
 * 그때 임대 현황 **전체**가 렌더링되지 않았다 — 할 일 배지 하나 때문에 집 목록까지
 * 사라지는 것은 너무 비싸다.
 */
const severity = (v) => SEVERITY[v] ?? { tone: '', label: '확인' };

/** 할 일을 누르면 그 일이 걸려 있는 화면으로 간다 */
const taskLink = (t) => (t.contractId ? `/contracts/${t.contractId}` : `/units/${t.unitId}`);

const dueText = (t) => {
  if (t.daysLeft === null) return '';
  if (t.daysLeft > 0) return `D-${t.daysLeft}`;
  if (t.daysLeft === 0) return '오늘';
  return `${-t.daysLeft}일 지남`;
};

/* 채도 팔레트를 상태 구분에 쓴다 — 같은 색을 나란히 두지 않는다 (DESIGN-clay.md) */
const VACANCY = {
  vacant: { label: '공실', tone: '' },
  contracting: { label: '계약 진행 중', tone: 'accent' },
  occupied: { label: '거주 중', tone: 'ok' },
  closing: { label: '퇴거 진행 중', tone: 'peach' },
};

const summary = computed(() => {
  const by = (s) => units.value.filter((u) => u.vacancyStatus === s).length;
  return { total: units.value.length, occupied: by('occupied'), vacant: by('vacant'), closing: by('closing') };
});

function daysSince(timestamp) {
  const from = new Date(`${timestamp.slice(0, 10)}T00:00:00`);
  const today = new Date(new Date().setHours(0, 0, 0, 0));
  return Math.round((today - from) / 86_400_000);
}

/** 카드 하단 한 줄 — 이 집에서 지금 시간이 걸려 있는 것 */
function statusOf(u) {
  if (!u.contractId) return { text: '임차인이 없습니다', tone: 'faint' };

  if (u.contractStatus === 'draft')
    return { text: '작성 중 — 아직 보내지 않았습니다', tone: 'faint' };

  if (u.contractStatus === 'rejected')
    return { text: '임차인이 수정을 요청했습니다', tone: 'warn' };

  if (u.contractStatus === 'pending_tenant') {
    const days = u.reviewSentAt ? daysSince(u.reviewSentAt) : null;
    return {
      text: days === null ? '임차인 확인 대기' : `임차인 확인 대기 · 발송 후 ${days}일`,
      tone: 'accent',
    };
  }

  const t = u.timeline;
  if (u.contractStatus === 'closing') {
    return t.daysToMoveOut >= 0
      ? { text: `퇴거까지 ${t.daysToMoveOut}일`, tone: 'warn' }
      : { text: `퇴거일 ${-t.daysToMoveOut}일 경과`, tone: 'warn' };
  }

  if (t.impliedRenewal) return { text: '묵시적 갱신 성립 — 갱신거절 통지 기한이 지났습니다', tone: 'warn' };
  if (t.renewalWindowOpen)
    return { text: `갱신 여부 결정 · 통지 기한 D-${t.daysToNoticeDeadline}`, tone: 'warn' };
  return { text: `만료까지 ${t.daysToExpiry}일`, tone: 'faint' };
}
</script>

<template>
  <div class="head">
    <div>
      <h1>{{ landlord?.name ?? '버틀러' }}님의 임대 현황</h1>
      <p class="muted" v-if="!loading && units.length">
        전체 {{ summary.total }}곳 · 거주 중 {{ summary.occupied }} · 공실 {{ summary.vacant }}
        <span v-if="summary.closing"> · 퇴거 진행 {{ summary.closing }}</span>
      </p>
    </div>
    <RouterLink v-if="landlord" to="/units/new">
      <button class="btn btn-primary">집 추가</button>
    </RouterLink>
  </div>

  <div v-if="error" class="notice" style="margin-bottom:16px">{{ error }}</div>
  <div v-if="loading" class="card"><div class="empty">불러오는 중…</div></div>

  <!-- 할 일 — 법정 기한이 걸린 것이 위로 온다 -->
  <section v-if="!loading && tasks.length" class="card todo">
    <div class="card-head">
      <h2>할 일 {{ tasks.length }}</h2>
      <span v-if="taskSummary.urgent" class="faint">
        기한이 임박한 것 {{ taskSummary.urgent }}건
      </span>
    </div>
    <ul>
      <li v-for="t in tasks" :key="t.id">
        <RouterLink :to="taskLink(t)">
          <span class="pill" :class="severity(t.severity).tone">{{ severity(t.severity).label }}</span>
          <span class="body">
            <strong>{{ t.title }}</strong>
            <span v-if="t.body" class="faint">{{ t.body }}</span>
          </span>
          <span class="meta">
            <span class="kind faint">{{ t.kindLabel }}</span>
            <span v-if="t.dueOn" class="due mono" :class="{ over: t.daysLeft < 0 }">
              {{ dueText(t) }}
            </span>
          </span>
        </RouterLink>
      </li>
    </ul>
  </section>

  <div v-if="!loading && landlord && !units.length" class="card">
    <div class="empty">
      <p style="margin:0 0 6px;font-weight:600;color:var(--text)">아직 등록된 집이 없습니다</p>
      <p style="margin:0">
        <strong>집 추가</strong>로 단지를 고르고 동·호·전용면적을 넣으면 시작합니다.
      </p>
    </div>
  </div>

  <div v-else-if="!loading" class="units">
    <RouterLink v-for="u in units" :key="u.id" :to="`/units/${u.id}`" class="card unit">
      <div class="unit-head">
        <div>
          <h2>{{ u.complexName }}</h2>
          <p class="faint">{{ u.dong }} {{ u.ho }} · 전용 {{ u.exclusiveArea }}㎡</p>
        </div>
        <span class="pill" :class="VACANCY[u.vacancyStatus].tone">
          {{ VACANCY[u.vacancyStatus].label }}
        </span>
      </div>

      <div class="unit-body">
        <template v-if="u.contractId">
          <div class="tenant">
            <strong>{{ u.tenantName }}</strong>
            <span v-if="u.openRepairs" class="pill pink">수선 신고 {{ u.openRepairs }}</span>
          </div>
          <dl>
            <div>
              <dt>거주</dt>
              <dd class="mono">{{ u.moveInDate }} ~ {{ u.moveOutDate ?? u.expiresOn }}</dd>
            </div>
            <div>
              <dt>보증금</dt>
              <dd class="mono">
                {{ won(u.deposit) }}
                <span v-if="u.monthlyRent" class="faint">/ 월 {{ won(u.monthlyRent) }}</span>
              </dd>
            </div>
          </dl>
        </template>
        <p v-else class="vacant">계약을 작성해 임차인에게 보낼 수 있습니다.</p>
      </div>

      <div class="unit-foot">
        <span class="status" :class="statusOf(u).tone">{{ statusOf(u).text }}</span>
        <span v-if="u.ownershipStatus !== 'verified'" class="pill warn">등기부 미확인</span>
      </div>
    </RouterLink>
  </div>
</template>

<style scoped>
.head {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--sp-lg); margin-bottom: var(--sp-lg);
}
.head .muted { margin: var(--sp-xs) 0 0; font-size: 16px; }

/* ── 할 일 ────────────────────────────────────────────── */
.todo { margin-bottom: var(--sp-md); }
.todo ul { list-style: none; margin: 0; padding: 0; }
.todo li + li { border-top: 1px solid var(--border); }

.todo a {
  display: grid; grid-template-columns: 52px 1fr 170px; align-items: center;
  gap: var(--sp-md); padding: 14px var(--sp-lg); color: var(--text);
  transition: background-color .12s;
}
.todo a:hover { background: var(--surface-2); }

.todo .body { display: grid; gap: 2px; }
.todo .body strong { font-size: 15px; font-weight: 600; }
.todo .body .faint { font-size: 13px; }

.todo .meta { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-sm); }
.todo .kind { font-size: 13px; }
.todo .due { font-size: 14px; font-weight: 600; color: var(--text); }
.todo .due.over { color: var(--warn); }

/* 데스크톱 고정 3열 — 반응형 축소 없음 */
.units { display: grid; gap: var(--sp-md); grid-template-columns: repeat(3, 1fr); }
.unit {
  display: flex; flex-direction: column; color: var(--text);
  transition: border-color .12s;
}
.unit:hover { border-color: var(--text); }
.unit + .unit { margin-top: 0; }

.unit-head {
  padding: var(--sp-lg) var(--sp-lg) var(--sp-md);
  display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-sm);
}
.unit-head h2 { font-size: 18px; letter-spacing: -0.2px; }
.unit-head p { margin: var(--sp-xxs) 0 0; }

.unit-body { padding: 0 var(--sp-lg) var(--sp-lg); flex: 1; }
.tenant { display: flex; align-items: center; gap: var(--sp-xs); margin-bottom: var(--sp-sm); }
.tenant strong { font-size: 16px; font-weight: 600; }

dl { margin: 0; display: grid; gap: var(--sp-xxs); }
dl > div { display: flex; gap: var(--sp-sm); font-size: 14px; }
dt { color: var(--text-faint); width: 52px; flex: none; font-weight: 500; }
dd { margin: 0; color: var(--text-body); }

.vacant { margin: 0; color: var(--text-faint); font-size: 14px; }

.unit-foot {
  padding: var(--sp-sm) var(--sp-lg); border-top: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-sm);
  background: var(--surface-2); border-radius: 0 0 var(--radius) var(--radius);
}
.status { font-size: 14px; font-weight: 600; color: var(--text); }
.status.warn { color: var(--warn); }
.status.accent { color: var(--text); }
.status.faint { color: var(--text-dim); font-weight: 500; }
</style>
