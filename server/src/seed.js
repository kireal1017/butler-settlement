import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, resetDatabase } from './db.js';

/**
 * 초기화 — 임대인 '버틀러' 계정 하나만 만든다.
 *
 * 집·계약·단지·단가는 **전부 직접 등록**합니다. 샘플 데이터를 넣지 않는 이유는
 * 화면에 보이는 숫자가 실제로 들어온 값인지 시드가 심어 둔 값인지 구분되어야 하기
 * 때문입니다. 단지는 K-apt 실 API 로 받아옵니다:
 *
 *   curl -X POST localhost:3001/api/complexes/sync-list   # 전국 22,322 단지
 *
 * 예전 시연용 데이터(계약 5건 · 단지 3곳 · 96개월 단가)는 `seed-demo.js` 에 남겨
 * 두었습니다. 필요하면 `node src/seed-demo.js` 로 되돌릴 수 있습니다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

/** PoC 의 유일한 임대인. 계정만 있고 소유한 집은 없다. */
export const LANDLORD_NAME = '버틀러';

function seed() {
  resetDatabase();

  /* 업로드된 등기부·점검 사진은 DB 와 짝이 맞아야 한다. 행을 지웠으면 파일도 지운다. */
  fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true });

  const id = db.prepare(`INSERT INTO landlords (name) VALUES (?)`)
    .run(LANDLORD_NAME).lastInsertRowid;

  console.log('✓ 초기화 완료');
  console.log(`  임대인 ${LANDLORD_NAME} (id ${id}) — 집 0곳 · 계약 0건`);
  console.log('');
  console.log('  다음 단계');
  console.log('    1) 단지 목록 받기   curl -X POST localhost:3001/api/complexes/sync-list');
  console.log('    2) 화면에서 집 추가  http://localhost:5173');
  console.log('');
}

seed();
