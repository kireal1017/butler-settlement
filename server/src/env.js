import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * .env 로더 — 의존성 없이 최소 기능만.
 *
 * Node 22.16 은 `--env-file` 은 있지만 `--env-file-if-exists` 가 없다. 그래서 npm script 에
 * 그냥 붙이면 .env 가 없는 환경(CI·새로 받은 저장소)에서 `npm start` 가 죽는다.
 * 키 없이도 전 구간이 돌아야 한다는 것이 이 프로젝트의 전제라(CLAUDE.md 절대 규칙 3),
 * 파일이 없으면 조용히 넘어가는 로더를 직접 둔다.
 *
 * **이미 셸에 설정된 값은 덮어쓰지 않는다.** 배포 환경의 주입이 파일보다 우선이다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.join(__dirname, '..', '.env');

export function loadEnv(file = process.env.ENV_FILE || DEFAULT_PATH) {
  if (!fs.existsSync(file)) return { loaded: false, keys: [] };

  const keys = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // 따옴표로 감싼 값 허용 — 키에 #, 공백이 들어갈 수 있다
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))))
      value = value.slice(1, -1);

    if (process.env[key] === undefined) {
      process.env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: true, keys };
}

loadEnv();
