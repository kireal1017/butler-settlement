<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from './api.js';
import { landlord } from './session.js';

const route = useRoute();
const live = ref(null);

/** 임차인 화면에는 임대인 세션을 드러내지 않는다 */
const tenantView = computed(() => route.path.startsWith('/t/'));

onMounted(async () => {
  try { live.value = (await api.health()).kaptLive; } catch { live.value = null; }
});
</script>

<template>
  <header class="topbar">
    <div class="wrap bar">
      <!-- 임차인에게는 임대인 CRM 으로 가는 통로를 열지 않는다 -->
      <component :is="tenantView ? 'div' : 'RouterLink'" to="/" class="brand">
        <span class="mark">B</span>
        <span>
          <strong>버틀러</strong>
          <em>{{ tenantView ? '임대차 계약 확인' : '임대차 관리' }}</em>
        </span>
      </component>

      <div class="right">
        <span v-if="live !== null && !tenantView" class="pill" :class="live ? 'ok' : ''">
          K-apt {{ live ? '실시간 연동' : '미연동' }}
        </span>
        <span v-if="landlord && !tenantView" class="who">{{ landlord.name }}님</span>
      </div>
    </div>
  </header>
  <main class="wrap"><RouterView /></main>
</template>

<style scoped>
.topbar {
  background: var(--canvas);
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--sp-xl);
  position: sticky; top: 0; z-index: 10;
}
.bar {
  display: flex; align-items: center; justify-content: space-between;
  height: 64px; padding-bottom: 0;
}
.brand { display: flex; align-items: center; gap: 10px; color: var(--text); }
.mark {
  width: 32px; height: 32px; border-radius: var(--radius-sm);
  background: var(--accent); color: var(--on-dark);
  display: grid; place-items: center; font-weight: 600; font-size: 16px;
}
.brand strong { font-size: 16px; font-weight: 600; letter-spacing: -0.2px; }
.brand em {
  display: block; font-style: normal; font-size: 12px; font-weight: 500;
  color: var(--text-faint); margin-top: -3px;
}
.right { display: flex; align-items: center; gap: var(--sp-sm); }
.who { font-size: 13px; font-weight: 500; color: var(--text-dim); }
</style>
