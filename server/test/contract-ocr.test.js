import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseKoreanAmount, parseArabicAmount } from '../src/services/koreanAmount.js';
import { parseContract, maskSensitive, anyRecognized } from '../src/services/contract.js';

/**
 * 계약서 OCR 파서 (docs/CONTRACT-OCR-PLAN.md §12 검증 체크리스트)
 *
 * 네트워크도 DB도 쓰지 않는다. 픽스처 텍스트는 실측 OCR 원문의 잡음을 그대로 담고 있다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'fixtures', 'contracts');

const readFixture = (name) => fs.readFileSync(path.join(DIR, `${name}.png.txt`), 'utf8');
const readExpected = (name) =>
  JSON.parse(fs.readFileSync(path.join(DIR, `${name}.expected.json`), 'utf8'));

/* ── 한글 금액 (§4.3) ──────────────────────────────────── */

test('한글 금액을 정수로 바꾼다 — 실측 계약서에서 나온 값들', () => {
  assert.equal(parseKoreanAmount('사억오천만'), 450_000_000);
  assert.equal(parseKoreanAmount('사천오백만'), 45_000_000);
  assert.equal(parseKoreanAmount('사억오백만'), 405_000_000);
  assert.equal(parseKoreanAmount('일억'), 100_000_000);
  assert.equal(parseKoreanAmount('삼십만'), 300_000);
  assert.equal(parseKoreanAmount('오천만원정'), 50_000_000);
});

test('모르는 글자가 섞이면 null 을 준다 — 틀린 값을 내미느니 못 읽었다고 한다', () => {
  assert.equal(parseKoreanAmount('사억오처만'), null);
  assert.equal(parseKoreanAmount(''), null);
  assert.equal(parseKoreanAmount(null), null);
});

test('숫자 금액은 구분기호와 통화기호를 떼고 읽는다', () => {
  assert.equal(parseArabicAmount('450,000,000'), 450_000_000);
  assert.equal(parseArabicAmount('\\5,000,000'), 5_000_000);
  assert.equal(parseArabicAmount('   '), null);
});

/* ── 픽스처 대조 (§10) ─────────────────────────────────── */

for (const name of ['01-monthly-print', '02-jeonse-print', '03-handwritten', '04-photo-skewed']) {
  test(`픽스처 ${name} — 값과 신뢰도가 정답과 같다`, () => {
    const { fields } = parseContract(readFixture(name));
    for (const [key, want] of Object.entries(readExpected(name))) {
      assert.equal(fields[key].value, want.value, `${key} 값`);
      assert.equal(fields[key].confidence, want.confidence, `${key} 신뢰도`);
    }
  });
}

/* ── 안전장치 (§5 · §13) ───────────────────────────────── */

test('보증금 한글·숫자가 다르면 칸을 비우고 두 후보를 함께 준다', () => {
  const { fields, warnings } = parseContract(readFixture('03-handwritten'));

  assert.equal(fields.deposit.value, null, '하나를 골라 채우면 안 된다');
  assert.equal(fields.deposit.confidence, 'low');
  assert.equal(fields.deposit.source.hangul, '사천오백만');
  assert.equal(fields.deposit.source.arabic, '5,000,000');
  assert.ok(warnings.some((w) => w.includes('사천오백만') && w.includes('5,000,000')));
});

test('월 차임 빈칸을 전세(0원)로 단정하지 않는다', () => {
  const { fields, warnings } = parseContract(readFixture('02-jeonse-print'));

  assert.equal(fields.monthlyRent.value, null, '0 으로 채우면 인식 실패와 구분되지 않는다');
  assert.equal(fields.monthlyRent.confidence, 'low');
  assert.ok(warnings.some((w) => w.includes('전세')));
});

test('달력에 없는 날짜(2026-06-31)는 기간을 low 로 떨어뜨린다', () => {
  const { fields } = parseContract(readFixture('04-photo-skewed'));

  assert.equal(fields.termMonths.value, null);
  assert.equal(fields.termMonths.confidence, 'low');
  /* 입주일은 멀쩡히 읽혔다 — 한 필드가 깨져도 나머지는 살린다 */
  assert.equal(fields.moveInDate.value, '2022-09-01');
});

test('갱신 전 계약 금액을 이번 보증금으로 잡지 않는다', () => {
  /* 01 픽스처의 확정일자 부여현황에는 이전 계약 보증금 200,000,000 이 있다 */
  const text = readFixture('01-monthly-print');
  assert.ok(text.includes('200,000,000'), '픽스처에 함정이 들어 있어야 의미가 있다');
  assert.equal(parseContract(text).fields.deposit.value, 50_000_000);
});

test('제12조 중개보수를 금액으로 잡지 않는다', () => {
  const text = readFixture('01-monthly-print');
  assert.ok(text.includes('1,800,000'));
  const { fields } = parseContract(text);
  assert.notEqual(fields.deposit.value, 1_800_000);
  assert.notEqual(fields.monthlyRent.value, 1_800_000);
});

test('잔금·계약금 줄을 보증금으로 잡지 않는다', () => {
  /* 01 의 잔금은 사천오백만(45,000,000) 으로 보증금 오천만과 다르다 */
  const { fields } = parseContract(readFixture('01-monthly-print'));
  assert.equal(fields.deposit.value, 50_000_000);
});

test('계약 기간은 만료일 다음 날 기준으로 센다 (2022-09-01 ~ 2026-08-31 = 48개월)', () => {
  const { fields } = parseContract(readFixture('01-monthly-print'));
  assert.equal(fields.termMonths.value, 48);
  assert.equal(fields.moveInDate.value, '2022-09-01');
});

/* ── 개인정보 (§7) ─────────────────────────────────────── */

test('주민등록번호 뒷자리는 응답을 만들기 전에 지운다', () => {
  const masked = maskSensitive('임대인 김성호 720305-1234567 서울시');
  assert.ok(!/720305\s*-\s*\d{7}/.test(masked));
  assert.ok(masked.includes('720305-*******'));
});

test('파싱 결과 어디에도 주민번호 뒷자리가 남지 않는다', () => {
  const text = `${readFixture('01-monthly-print')}\n임대인 김성호 720305-1234567`;
  const json = JSON.stringify(parseContract(text));
  assert.ok(!/\d{6}-\d{7}/.test(json));
});

/* ── 폴백 (§6) ─────────────────────────────────────────── */

test('계약서가 아닌 글은 전부 low 로 떨어지고 던지지 않는다', () => {
  const { fields } = parseContract('오늘 점심은 김치찌개였다. 날씨가 좋다.');
  assert.equal(anyRecognized(fields), false);
  assert.ok(Object.values(fields).every((f) => f.confidence === 'low'));
});

test('빈 입력에도 던지지 않는다 — 수동 입력이 항상 기본값이다', () => {
  assert.doesNotThrow(() => parseContract(''));
  assert.doesNotThrow(() => parseContract(null));
});
