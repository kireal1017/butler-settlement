import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Home from './views/Home.vue';
import NewUnit from './views/NewUnit.vue';
import UnitDetail from './views/UnitDetail.vue';
import UnitRegistry from './views/UnitRegistry.vue';
import RuleLock from './views/RuleLock.vue';
import Settlement from './views/Settlement.vue';
import NewContract from './views/NewContract.vue';
import ContractDetail from './views/ContractDetail.vue';
import ContractDocument from './views/ContractDocument.vue';
import InspectionReview from './views/InspectionReview.vue';
import TenantShare from './views/TenantShare.vue';
import { loadLandlord } from './session.js';
import './style.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: Home },
    { path: '/units/new', component: NewUnit },
    { path: '/units/:id', component: UnitDetail, props: true },
    { path: '/units/:id/registry', component: UnitRegistry, props: true },
    { path: '/contracts/new', component: NewContract },
    { path: '/contracts/:id', component: ContractDetail, props: true },
    { path: '/contracts/:id/document', component: ContractDocument, props: true },
    { path: '/contracts/:id/rules', component: RuleLock, props: true },
    { path: '/contracts/:id/inspection', component: InspectionReview, props: true },
    { path: '/contracts/:id/settlement', component: Settlement, props: true },
    { path: '/t/:token', component: TenantShare, props: true },

    /* 없는 경로(지워진 /login 포함)는 빈 화면 대신 임대 현황으로 */
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

/* 임대인이 하나뿐이라 로그인 화면도 세션 가드도 없다. 시작 화면은 바로 임대 현황이다.
   임차인 화면(/t/:token)은 토큰만으로 열리므로 임대인 정보를 필요로 하지 않는다. */
await loadLandlord();

createApp(App).use(router).mount('#app');
