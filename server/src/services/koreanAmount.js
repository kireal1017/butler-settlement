/**
 * 한글 금액 → 정수 (docs/CONTRACT-OCR-PLAN.md §4.3)
 *
 * 왜 한글을 읽는가 -----------------------------------------------------
 * 표준계약서는 금액을 한글과 숫자로 **병기**한다. 실측에서 숫자 쪽이 깨졌다:
 *
 *     계약금  금 사천오백만  원정(\\5,000,000  )은 계약시에 지불하고
 *
 * `45,000,000` 의 앞자리 4 가 역슬래시에 먹혀 `5,000,000` 이 되었다. 4,500만원이
 * 500만원이 된다. 그런데 한글 "사천오백만"은 정확히 살아남았다.
 * 그래서 두 값을 **각각** 읽어 대조하는 것이 이 기능의 안전장치다 (§5).
 *
 * 순수 함수다 — 네트워크도 DB도 보지 않는다.
 */

const DIGIT = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const SMALL = { 십: 10, 백: 100, 천: 1000 };
const BIG = { 만: 1e4, 억: 1e8, 조: 1e12 };

/**
 * '사억오천만' → 450000000.
 *
 * OCR 잡음이 한 글자라도 섞이면 **null 을 돌려준다.** 모르는 글자를 건너뛰고
 * 계속 읽으면 '사억오처만'(처=오인식) 이 4억으로 조용히 해석되는데,
 * 이건 틀린 값을 맞는 값처럼 내미는 것이라 못 읽는 것보다 나쁘다.
 *
 * @param {string} raw
 * @returns {number|null}
 */
export function parseKoreanAmount(raw) {
  /* '원정'·'원'을 먼저 떼지 않으면 한글이라 살아남아 파싱이 깨진다 */
  const s = String(raw ?? '')
    .replace(/원\s*정|원|정/g, '')
    .replace(/[^가-힣]/g, '');
  if (!s) return null;

  let total = 0;
  let section = 0;
  let cur = 0;

  for (const ch of s) {
    if (DIGIT[ch] != null) cur = DIGIT[ch];
    else if (SMALL[ch] != null) { section += (cur || 1) * SMALL[ch]; cur = 0; }
    else if (BIG[ch] != null) { total += (section + cur) * BIG[ch]; section = 0; cur = 0; }
    else return null;
  }

  return total + section + cur;
}

/**
 * '450,000,000' · '\\5,000,000' → 정수.
 *
 * ⚠ 앞에 붙은 `\`·`₩`·공백을 버릴 때 **숫자 한 자리가 함께 사라질 수 있다**는 것을
 *   전제한다. 그래서 이 값 하나만으로는 절대 금액을 확정하지 않는다 — 한글값과
 *   대조하는 쪽이 판단한다.
 */
export function parseArabicAmount(raw) {
  const digits = String(raw ?? '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}
