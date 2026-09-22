import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRegistry, verifyOwnership, maskSensitive } from '../src/services/registry.js';
import { recognize } from '../src/services/ocr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'registry');

const samples = fs.readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.expected.json'))
  .map((f) => f.replace('.expected.json', ''))
  .sort();

/* 샘플 A~D 가 각각 기대 결과와 일치하는지 (V2-SPEC §10) */
for (const name of samples) {
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.expected.json`), 'utf8'));
  const text = fs.readFileSync(path.join(FIXTURES, `${name}.png.txt`), 'utf8');

  test(`${name} — 파싱 결과가 정답과 일치한다`, () => {
    const parsed = parseRegistry(text);
    assert.equal(parsed.address, expected.address);
    assert.equal(parsed.dong, expected.dong);
    assert.equal(parsed.floor, expected.floor);
    assert.equal(parsed.ho, expected.ho);
    assert.equal(parsed.uniqueNo, expected.uniqueNo);
    assert.equal(parsed.issuedNo, expected.issuedNo);
    assert.equal(parsed.exclusiveArea, expected.exclusiveArea);
    assert.deepEqual(parsed.owners, expected.owners);
    assert.deepEqual(parsed.missing, []);
  });

  test(`${name} — 소유 검증이 ${expected.expectedMatch} 를 낸다`, () => {
    const { result } = verifyOwnership(parseRegistry(text), expected.verifyAgainst);
    assert.equal(result, expected.expectedMatch);
  });
}

test('을구의 근저당권자·전세권자를 소유자로 읽지 않는다', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'sample-d.png.txt'), 'utf8');
  const { owners } = parseRegistry(text);
  assert.deepEqual(owners, ['김성호']);
  assert.ok(!owners.includes('윤다정'), '전세권자가 소유자로 들어갔다');
});

test('갑구 앞순위 소유권보존(시행사)을 현재 소유자로 읽지 않는다', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'sample-a.png.txt'), 'utf8');
  const { owners } = parseRegistry(text);
  assert.deepEqual(owners, ['김성호']);
  assert.ok(!owners.some((o) => o.includes('대한건설')), '시행사가 소유자로 들어갔다');
});

test('1동 건물 표시의 면적이 아니라 전유부분 면적을 읽는다', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'sample-a.png.txt'), 'utf8');
  assert.equal(parseRegistry(text).exclusiveArea, 84.95);  // 611.71 이 아니다
});

test('다른 집의 등기부는 address_mismatch 로 걸러진다', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'sample-a.png.txt'), 'utf8');
  const { result, reasons } = verifyOwnership(parseRegistry(text),
    { ownerName: '김성호', dong: '7', ho: '502' });
  assert.equal(result, 'address_mismatch');
  assert.ok(reasons.length);
});

test('읽히지 않는 문서는 parse_failed 로 떨어진다', () => {
  const { result } = verifyOwnership(parseRegistry('영수증\n합계 12,000원'),
    { ownerName: '김성호', dong: '103', ho: '1204' });
  assert.equal(result, 'parse_failed');
});

test('동 표기가 제103동 / 103동 / 103 이어도 같게 본다', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'sample-d.png.txt'), 'utf8');
  const parsed = parseRegistry(text);
  for (const dong of ['305', '305동', '제305동'])
    assert.equal(verifyOwnership(parsed, { ownerName: '김성호', dong, ho: '703호' }).result, 'matched');
});

test('저장 전 마스킹 — 주민번호 뒷자리가 남지 않는다', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'sample-a.png.txt'), 'utf8');
  const masked = maskSensitive(text.replace('800101-*******', '800101-1234567'));
  assert.ok(masked.includes('800101-*******'));
  assert.ok(!masked.includes('1234567'));
});

test('키가 없으면 OCR 이 픽스처 모드로 떨어진다', async () => {
  const { text, provider } = await recognize('sample-a.png');
  assert.equal(provider, 'fixture');
  assert.ok(text.includes('집합건물'));
});

test('픽스처가 없는 파일은 빈 텍스트를 돌려준다 (→ parse_failed)', async () => {
  const { text } = await recognize('알수없는파일.png');
  assert.equal(text, '');
});
