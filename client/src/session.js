import { ref } from 'vue';
import { api } from './api.js';

/**
 * 임대인 세션.
 *
 * 임대인은 '버틀러' 하나뿐이라 **고르는 화면이 없습니다.** 앱이 뜰 때 서버가 가진
 * 임대인을 그대로 가져옵니다. 실제 인증은 범위 밖입니다 (V2-SPEC §0).
 */

export const landlord = ref(null);
export const sessionError = ref('');

export async function loadLandlord() {
  try {
    const rows = await api.landlords();
    landlord.value = rows[0] ?? null;
    if (!landlord.value)
      sessionError.value = '임대인 계정이 없습니다. server 에서 `npm run seed` 를 한 번 실행하세요.';
  } catch (e) {
    sessionError.value = `API 서버에 연결하지 못했습니다 (:3001) — ${e.message}`;
  }
}
