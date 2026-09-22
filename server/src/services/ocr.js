import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * OCR 어댑터 — services/kapt.js 와 같은 패턴.
 *
 * 운영 전환 방법 -----------------------------------------------------
 *   OCR_PROVIDER=clova OCR_API_KEY=xxxxx OCR_ENDPOINT=https://... npm start
 *
 *   키가 없으면 자동으로 fixture 모드로 떨어진다. 그래서 외부 연동 없이도
 *   업로드 → OCR → 파싱 → 검증 전 구간이 끝까지 돈다.
 *
 * 공급자 선택 --------------------------------------------------------
 *   한국어 표 문서는 네이버 CLOVA OCR 또는 Upstage Document Parse 가 강하다.
 *   Google Vision 도 되고, Tesseract(kor) 는 오프라인 대안이지만 표 구조에서
 *   정확도가 떨어진다. 어느 쪽이든 recognize() 시그니처만 지키면 교체 가능하다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', '..', 'fixtures');
const FIXTURE_DIR = path.join(FIXTURE_ROOT, 'registry');

/**
 * 문서 종류마다 픽스처 폴더가 다르다 (registry / contracts).
 * recognize() 를 부르는 쪽이 `kind` 로 알려 준다 — 기본값은 등기부다.
 */
const fixtureDir = (kind) => path.join(FIXTURE_ROOT, kind || 'registry');

/**
 * 환경변수는 **호출 시점에** 읽는다 (kapt.js 와 같은 이유 — `.env` 로더보다 import 가
 * 먼저 평가되면 모듈 최상단 const 는 빈 값으로 굳는다).
 */
const provider = () => (process.env.OCR_PROVIDER || '').trim().toLowerCase();
const apiKey = () => (process.env.OCR_API_KEY || '').trim();
const endpoint = () => (process.env.OCR_ENDPOINT || '').trim();

/** CLOVA 는 시크릿만으로 부족하다 — 도메인마다 다른 invoke URL 이 함께 있어야 한다 */
export const isLive = () =>
  Boolean(provider() && provider() !== 'fixture' && apiKey() && endpoint());

export const providerName = () => (isLive() ? provider() : 'fixture');

/** 설정이 반쯤 된 상태를 화면·로그에서 구분하기 위한 진단 */
export function configStatus() {
  const p = provider();
  if (!p || p === 'fixture') return { mode: 'fixture', reason: 'OCR_PROVIDER 미설정' };
  const missing = [!apiKey() && 'OCR_API_KEY', !endpoint() && 'OCR_ENDPOINT'].filter(Boolean);
  return missing.length
    ? { mode: 'fixture', reason: `${p} 설정 미완료 — ${missing.join(', ')} 없음` }
    : { mode: p, reason: null };
}

/**
 * 픽스처 텍스트를 찾는다: 업로드 파일 옆 → fixtures/registry/ 안 같은 이름.
 * 업로드 파일은 덮어쓰기를 막으려고 `<난수>__원본이름` 으로 저장하므로,
 * 접두사를 떼어낸 이름으로도 찾아본다.
 */
function findFixture(imagePath, kind) {
  const dir = fixtureDir(kind);
  const base = path.basename(imagePath);
  const original = base.includes('__') ? base.slice(base.indexOf('__') + 2) : base;
  const stem = original.replace(/\.[^.]+$/, '');

  return [
    `${imagePath}.txt`,
    path.join(dir, `${original}.txt`),
    path.join(dir, `${stem}.png.txt`),
  ].find((p) => fs.existsSync(p)) ?? null;
}

/**
 * 이미지에서 텍스트를 뽑는다.
 * @returns {{ text: string, provider: string, confidence: number }}
 *   text 가 빈 문자열이면 인식 실패다. 호출부는 parse_failed 로 처리하고
 *   수동 입력 폴백 화면으로 보낸다.
 */
export async function recognize(imagePath, { kind = 'registry' } = {}) {
  if (isLive()) {
    try {
      return await callProvider(imagePath);
    } catch (err) {
      /* 공급자 장애·키 오류로 업로드 화면 전체가 죽으면 안 된다. 인식 실패로 처리해
         파서가 parse_failed 를 내고 수동 입력 폴백으로 이어진다 (V2-SPEC §4.4).
         픽스처가 있으면(시연 중 샘플) 그것으로 이어 붙인다. */
      console.warn(`[ocr] ${provider()} 호출 실패 — ${err.message}`);
      return { ...readFixture(imagePath, kind), provider: `${provider()}:failed` };
    }
  }
  return readFixture(imagePath, kind);
}

function readFixture(imagePath, kind) {
  const fixture = findFixture(imagePath, kind);
  if (!fixture) return { text: '', provider: 'fixture', confidence: 0 };

  return {
    text: fs.readFileSync(fixture, 'utf8'),
    provider: 'fixture',
    confidence: 0.97,
  };
}

/** 실 공급자 호출. 응답 형태만 공급자별로 다르고 나머지는 동일하다. */
async function callProvider(imagePath) {
  const name = provider();
  const adapter = PROVIDERS[name];
  if (!adapter) throw new Error(`지원하지 않는 OCR 공급자: ${name}`);

  const res = await fetch(endpoint(), {
    method: 'POST',
    ...adapter.request(imagePath, apiKey()),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok)
    throw new Error(`OCR ${name} ${res.status} — ${(await res.text()).slice(0, 200)}`);

  return { ...adapter.parse(await res.json()), provider: name };
}

const PROVIDERS = {
  /**
   * 네이버 CLOVA OCR (General)
   *
   * ⚠ 이미지를 그대로 body 에 넣으면 안 된다. `images[].data` 에 **base64** 로 담은
   *   JSON 을 보내야 하고 `version` · `requestId` · `timestamp` 가 모두 필수다.
   *   `OCR_ENDPOINT` 는 NCP 콘솔에서 도메인을 만들 때 나오는 **APIGW Invoke URL** 이다.
   */
  clova: {
    request: (imagePath, key) => ({
      headers: { 'X-OCR-SECRET': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 'V2',
        requestId: crypto.randomUUID(),
        timestamp: Date.now(),
        images: [{
          format: path.extname(imagePath).slice(1).toLowerCase() || 'png',
          name: path.basename(imagePath),
          data: fs.readFileSync(imagePath).toString('base64'),
        }],
      }),
    }),
    parse: (json) => {
      const fields = json?.images?.[0]?.fields ?? [];
      /* 등기부 파서는 줄바꿈에 의존하지 않지만(registry.js 는 전부 \s*), 사람이 원문을
         되짚을 때 줄이 살아 있어야 읽힌다. CLOVA 의 lineBreak 로 줄을 복원한다. */
      const text = fields
        .map((f) => f.inferText + (f.lineBreak ? '\n' : ' '))
        .join('')
        .trim();
      return {
        text,
        confidence: fields.length
          ? fields.reduce((sum, f) => sum + (f.inferConfidence ?? 0), 0) / fields.length
          : 0,
      };
    },
  },

  /** Upstage Document Parse — 멀티파트 업로드 + Bearer 인증 */
  upstage: {
    request: (imagePath, key) => {
      const form = new FormData();
      form.append('document', new Blob([fs.readFileSync(imagePath)]), path.basename(imagePath));
      return { headers: { Authorization: `Bearer ${key}` }, body: form };
    },
    parse: (json) => ({
      text: json?.content?.text ?? json?.text ?? '',
      confidence: json?.confidence ?? 0.9,
    }),
  },
};

/** 시연에서 고를 수 있는 내장 샘플 목록 */
export function listSamples() {
  if (!fs.existsSync(FIXTURE_DIR)) return [];
  return fs.readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.png.txt'))
    .map((f) => f.replace('.png.txt', ''))
    .sort();
}
