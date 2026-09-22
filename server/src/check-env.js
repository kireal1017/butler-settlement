import './env.js';
import dns from 'node:dns/promises';
import { isLive as kaptLive, ping as kaptPing } from './services/kapt.js';
import { configStatus, recognize } from './services/ocr.js';

/**
 * 키 점검 — `npm run check-env`
 *
 * 키를 넣은 직후 "이게 실제로 되는가" 를 확인하는 용도다. 실패를 삼키는 것이
 * 런타임의 기본 동작이라(화면이 죽지 않아야 하므로) 여기서만 원인을 그대로 보여 준다.
 */

const mask = (v) => (!v ? '(비어 있음)'
  : v.length <= 12 ? `${v.slice(0, 2)}…${v.slice(-2)} (${v.length}자)`
    : `${v.slice(0, 6)}…${v.slice(-4)} (${v.length}자)`);

const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => console.log(`  ✗ ${m}`);
const info = (m) => console.log(`    ${m}`);

console.log('\n버틀러 — 외부 연동 점검\n');

/* ── K-apt ─────────────────────────────────────────────────── */
console.log('K-apt (공동주택관리정보시스템)');
const kaptKey = process.env.KAPT_SERVICE_KEY || '';
info(`KAPT_SERVICE_KEY = ${mask(kaptKey)}`);

if (!kaptLive()) {
  no('키 없음 — 시드 단가로 동작합니다 (정상, 시연 가능)');
} else {
  if (/%[0-9A-Fa-f]{2}/.test(kaptKey))
    info('⚠ Encoding 키로 보입니다. 코드가 한 번 풀어 주지만 Decoding 키 권장');
  try {
    const { totalCount, sample } = await kaptPing();
    ok(`단지 목록 응답 정상 — 전국 ${totalCount.toLocaleString()}개 단지`);
    if (sample[0]) info(`예: ${sample[0].kaptName} · ${sample[0].kaptCode}`);
  } catch (err) {
    no(err.message);
    if (/등록되지 않은 서비스키|NOT_REGISTERED/.test(err.message))
      info('→ 포털 마이페이지에서 이 API 를 활용신청했는지, 키를 정확히 복사했는지 확인하세요 (발급 직후면 최대 1시간 지연)');
    if (/없거나 폐기|NO_OPENAPI_SERVICE/.test(err.message))
      info('→ 키가 아니라 경로 문제입니다. 포털 명세의 Base URL 을 확인하세요');
  }
}

/* ── OCR ───────────────────────────────────────────────────── */
console.log('\nOCR (등기부 인식)');
const status = configStatus();
info(`OCR_PROVIDER = ${process.env.OCR_PROVIDER || '(비어 있음)'}`);
info(`OCR_API_KEY  = ${mask(process.env.OCR_API_KEY || '')}`);
info(`OCR_ENDPOINT = ${process.env.OCR_ENDPOINT || '(비어 있음)'}`);

if (status.mode === 'fixture') {
  no(`픽스처 모드 — ${status.reason} (정상, 시연 가능)`);
} else {
  ok(`공급자 ${status.mode} 설정 완료`);

  /* CLOVA 콘솔은 Public / Private 두 Invoke URL 을 보여 준다. Private 쪽을 복사하면
     사설 IP(10.x·172.16~31.x·192.168.x)로 풀려 VPC 밖에서는 영원히 타임아웃이다.
     증상이 그냥 "fetch failed" 라 원인을 알기 어려워 여기서 미리 걸러 준다. */
  /* General OCR 의 URI 는 POST /general 이다. 콘솔이 복사해 주는 Invoke URL 은
     그 앞부분까지라, 그대로 넣으면 404 가 난다. */
  if (status.mode === 'clova' && !/\/(general|document|template)\b/.test(process.env.OCR_ENDPOINT))
    info('⚠ 주소 끝에 /general 이 없습니다 — General OCR 은 POST /general 입니다');

  try {
    const host = new URL(process.env.OCR_ENDPOINT).hostname;
    const { address } = await dns.lookup(host);
    const priv = /^10\.|^127\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(address);
    info(`DNS: ${host} → ${address}${priv ? '  ← 사설 IP' : ''}`);
    if (priv) {
      no('Private(내부) Invoke URL 입니다 — 외부에서 접속할 수 없습니다');
      info('→ 콘솔에서 Public Invoke URL 을 복사하세요 (https://….apigw.ntruss.com/custom/v1/…)');
    }
  } catch (err) {
    no(`엔드포인트 확인 실패 — ${err.message}`);
  }

  /* 실제 이미지가 있어야 인증까지 확인된다. 인자로 경로를 주면 한 장 돌려 본다.
     예:  npm run check-env -- ./fixtures/registry/sample-a.png            */
  const image = process.argv[2];
  if (!image) {
    info('이미지 경로를 주면 실제 호출까지 확인합니다:');
    info('npm run check-env -- ./fixtures/registry/sample-a.png');
  } else {
    const res = await recognize(image);
    if (res.provider.endsWith(':failed')) no('호출 실패 — 위 [ocr] 경고를 보세요');
    else if (!res.text) no('응답은 왔지만 인식된 글자가 없습니다');
    else {
      ok(`인식 ${res.text.length}자 · 신뢰도 ${res.confidence.toFixed(3)}`);
      info(`첫 줄: ${res.text.split('\n')[0].slice(0, 60)}`);
    }
  }
}

console.log('');
