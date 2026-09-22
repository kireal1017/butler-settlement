/**
 * 등기부등본 파서 · 소유 검증
 *
 * OCR 은 글자 사이 공백이 튄다("고 유 번 호"). 그래서 고정 문자열 사이마다 \s* 를 넣는다.
 *
 * ⚠ 이 파서가 주장할 수 있는 것은 "제출된 등기부와 입력값이 일치한다" 까지다.
 *   등기부 갑구에는 성명과 주소 일부만 있고 주민번호는 마스킹되어 있어
 *   동명이인을 구분할 수 없고, 위조 이미지를 걸러낼 수도 없다.
 *   실제 본인확인은 상용 과제로 남긴다. (V2-SPEC §4.4)
 */

/* ── 섹션 분할 토큰 (§4.3) ─────────────────────────────────── */

const SEC_EXCLUSIVE = /\(\s*전\s*유\s*부\s*분\s*의\s*건\s*물\s*의\s*표\s*시\s*\)/;
const SEC_GAP = /【\s*갑\s*구\s*】/;
const SEC_EUL = /【\s*을\s*구\s*】/;

/* ── 추출 정규식 (§4.2) ────────────────────────────────────── */

const HEADER =
  /\[\s*집합건물\s*\]\s*(?<address>.+?)\s*제\s*(?<dong>[0-9가-힣]+)\s*동\s*제\s*(?<floor>[0-9]+)\s*층\s*제\s*(?<ho>[0-9]+)\s*호/;

const UNIQUE_NO = /고\s*유\s*번\s*호\s*([0-9]{4}\s*-\s*[0-9]{4}\s*-\s*[0-9]{6})/;
const ISSUED_NO = /발\s*급\s*번\s*호\s*([0-9]{4}\s*-\s*[0-9]{4}\s*-\s*[0-9]{6})/;
const AREA = /([0-9]{1,3}\.[0-9]{1,4})\s*(?:㎡|m2|m²)/;

/** 소유권보존 / 소유권이전. '소유권이전청구권가등기' 는 소유자 등기가 아니라 제외한다. */
const OWNERSHIP_ENTRY = /소\s*유\s*권\s*(?:보존|이전)(?!\s*청\s*구\s*권)/g;

/**
 * 이름은 "마스킹된 주민(법인)등록번호 바로 앞의 한글 덩어리" 로 잡는다.
 *
 * §4.2 의 `(?:소유자|공유자)\s*([가-힣]{2,5})` 를 그대로 쓰면 공유자 케이스에서 깨진다.
 * 공유자 등기는 '공유자' 다음에 이름이 아니라 '지분 2분의 1' 이 먼저 오기 때문이다.
 * 등록번호는 어느 표기에서나 이름 뒤에 붙으므로 이쪽이 훨씬 안정적이다.
 */
const OWNER_BY_ID = /([가-힣]{2,20})\s*[0-9]{6}\s*-\s*[0-9*]{1,7}/g;

const NAME_LABELS = ['소유자', '공유자', '채무자', '근저당권자', '전세권자'];

/* ── 파싱 ──────────────────────────────────────────────────── */

const clean = (v) => (v == null ? null : String(v).replace(/\s+/g, ''));

function stripLabel(name) {
  for (const label of NAME_LABELS)
    if (name.startsWith(label) && name.length > label.length) return name.slice(label.length);
  return name;
}

/**
 * 갑구에서 순위번호가 가장 큰 소유권 등기의 소유자를 읽는다.
 * 앞선 소유권보존(시행사 법인)이나 을구의 근저당권자·전세권자가 섞이면 안 된다.
 */
function extractOwners(text) {
  const gap = text.split(SEC_GAP)[1]?.split(SEC_EUL)[0];
  if (!gap) return [];

  const entries = [...gap.matchAll(OWNERSHIP_ENTRY)];
  const current = entries.length ? gap.slice(entries.at(-1).index) : gap;

  const owners = [...current.matchAll(OWNER_BY_ID)].map((m) => stripLabel(m[1].trim()));
  return [...new Set(owners)];
}

export function parseRegistry(text) {
  const header = text.match(HEADER)?.groups ?? {};

  // 1동 건물 표시에도 면적이 잔뜩 나온다. 전유부분 섹션을 먼저 잘라낸 뒤 찾아야 한다.
  const exclusiveSection = text.split(SEC_EXCLUSIVE)[1] ?? '';
  const area = exclusiveSection.match(AREA)?.[1];

  const parsed = {
    address: header.address?.trim() ?? null,
    dong: header.dong ?? null,
    floor: header.floor ?? null,
    ho: header.ho ?? null,
    uniqueNo: clean(text.match(UNIQUE_NO)?.[1]),
    issuedNo: clean(text.match(ISSUED_NO)?.[1]),
    exclusiveArea: area ? Number(area) : null,
    owners: extractOwners(text),
  };

  parsed.missing = ['address', 'ho', 'exclusiveArea']
    .filter((k) => parsed[k] == null)
    .concat(parsed.owners.length ? [] : ['owners']);

  return parsed;
}

/* ── 검증 (§4.4) ───────────────────────────────────────────── */

/** '제103동' '103동' '103' 을 모두 '103' 으로 맞춘다 */
const normalizeUnitNo = (v) => String(v ?? '').replace(/[제동호\s]/g, '');
const normalizeName = (v) => String(v ?? '').replace(/\s+/g, '');

/**
 * @param parsed   parseRegistry() 결과
 * @param expected { ownerName, dong, ho, exclusiveArea? } — 임대인이 입력한 값
 * @returns { result, reasons[] }
 *   matched | name_mismatch | address_mismatch | parse_failed
 */
export function verifyOwnership(parsed, expected) {
  const reasons = [];

  // 필수 필드를 못 읽었으면 판정하지 않는다 → 수동 입력 폴백
  if (!parsed.address || !parsed.ho || !parsed.owners.length) {
    const labels = { address: '주소', ho: '호', exclusiveArea: '전용면적', owners: '소유자' };
    return {
      result: 'parse_failed',
      reasons: [`등기부에서 ${parsed.missing.map((k) => labels[k] ?? k).join(' · ')}를 읽지 못했습니다`],
    };
  }

  // 다른 집의 등기부를 낸 경우를 먼저 걸러낸다
  const dongMatches = normalizeUnitNo(parsed.dong) === normalizeUnitNo(expected.dong);
  const hoMatches = normalizeUnitNo(parsed.ho) === normalizeUnitNo(expected.ho);
  if (!dongMatches || !hoMatches) {
    if (!dongMatches) reasons.push(`동이 다릅니다 — 등기부 ${parsed.dong}동 / 입력 ${expected.dong}`);
    if (!hoMatches) reasons.push(`호가 다릅니다 — 등기부 ${parsed.ho}호 / 입력 ${expected.ho}`);
    return { result: 'address_mismatch', reasons };
  }

  const owners = parsed.owners.map(normalizeName);
  if (!owners.includes(normalizeName(expected.ownerName))) {
    return {
      result: 'name_mismatch',
      reasons: [`등기부 소유자는 ${parsed.owners.join(' · ')}입니다 (입력: ${expected.ownerName})`],
    };
  }

  // 면적 차이는 판정을 바꾸지 않는다. 등기부와 단지 공시 면적이 미세하게 다를 수 있어
  // 반려 사유로 쓰기엔 위험하고, 입력 오타일 수도 있어 알려는 준다.
  if (expected.exclusiveArea && parsed.exclusiveArea &&
      Math.abs(expected.exclusiveArea - parsed.exclusiveArea) > 0.5)
    reasons.push(`전용면적이 다릅니다 — 등기부 ${parsed.exclusiveArea}㎡ / 입력 ${expected.exclusiveArea}㎡`);

  if (parsed.owners.length > 1)
    reasons.push(`공유자 ${parsed.owners.length}인 — ${parsed.owners.join(' · ')}`);

  return { result: 'matched', reasons };
}

/* ── 개인정보 (§5) ─────────────────────────────────────────── */

/** raw_text 를 저장하기 전에 주민번호 뒷자리를 지운다 */
export const maskSensitive = (text) =>
  String(text ?? '').replace(/([0-9]{6})\s*-\s*[0-9*]{1,7}/g, '$1-*******');
