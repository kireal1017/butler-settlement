import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'butler.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * v2 에서 기존 테이블에 추가된 컬럼.
 * schema.sql 의 CREATE TABLE IF NOT EXISTS 는 이미 존재하는 테이블에 컬럼을 넣지 못하므로,
 * v1 스키마로 만들어진 butler.db 도 그대로 이어서 쓸 수 있도록 여기서 ALTER 로 붙인다.
 * 컬럼 선언이 한 곳에만 있도록 schema.sql 쪽에는 중복해 적지 않는다.
 */
const COLUMN_PATCHES = {
  complexes: [
    // 단지 전용면적합(㎡). K-apt 의 월 부과"총액"을 원/㎡ 로 나누는 분모다.
    ['priv_area', `REAL`],
    ['bjd_code', `TEXT`],
    ['synced_at', `TEXT`],
  ],
  units: [
    ['landlord_id', `INTEGER REFERENCES landlords(id)`],
    ['ownership_status', `TEXT NOT NULL DEFAULT 'unverified'`],
    ['ownership_verified_at', `TEXT`],
    ['registry_owner_name', `TEXT`],
    ['registry_unique_no', `TEXT`],
    ['vacancy_status', `TEXT NOT NULL DEFAULT 'vacant'`],
  ],
  contracts: [
    ['landlord_id', `INTEGER REFERENCES landlords(id)`],
    ['parent_contract_id', `INTEGER REFERENCES contracts(id)`],
    ['term_months', `INTEGER NOT NULL DEFAULT 24`],
    ['expires_on', `TEXT`],
    ['tenant_phone', `TEXT`],
    ['renewal_decision', `TEXT`],
  ],
  settlement_lines: [
    /* 0원 줄이 왜 0원인지 — 'counted' | 'none' | 'unavailable' 과 그 사유.
       예전에는 0원 줄을 아예 만들지 않아 필요 없던 칸이다. */
    ['calc_status', `TEXT NOT NULL DEFAULT 'counted'`],
    ['calc_reason', `TEXT`],
  ],
  damage_reports: [
    ['inspection_id', `INTEGER REFERENCES inspections(id)`],
    ['photo_id', `INTEGER REFERENCES inspection_photos(id)`],
  ],
};

function applyColumnPatches() {
  for (const [table, columns] of Object.entries(COLUMN_PATCHES)) {
    const existing = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((r) => r.name);
    for (const [column, ddl] of columns)
      if (!existing.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/**
 * repair_events 를 집 단위로 넓힌다.
 *
 * 원래 `contract_id NOT NULL` 이라 수선은 반드시 계약에 붙어야 했다. 그래서 계약이 아직
 * 없는 집이나 공실 기간의 수선을 적어 둘 곳이 없었다. SQLite 는 ALTER 로 NOT NULL 을
 * 풀지 못하므로 테이블을 다시 만들어 옮긴다.
 *
 * 기존 행의 unit_id 는 계약에서 끌어온다 — 이미 있는 수선은 전부 계약에 붙어 있었다.
 * 엔진 쪽 조회(contract_id 기준)는 그대로 두므로 정산 결과는 바뀌지 않는다.
 */
function migrateRepairEvents() {
  const cols = db.prepare(`SELECT name FROM pragma_table_info('repair_events')`).all().map((r) => r.name);
  if (!cols.length || cols.includes('unit_id')) return;

  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE repair_events__new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        unit_id      INTEGER REFERENCES units(id) ON DELETE CASCADE,
        contract_id  INTEGER REFERENCES contracts(id) ON DELETE CASCADE,
        occurred_on  TEXT NOT NULL,
        description  TEXT NOT NULL,
        cost         INTEGER NOT NULL,
        paid_by      TEXT NOT NULL,
        cause        TEXT NOT NULL
      );
      INSERT INTO repair_events__new (id, unit_id, contract_id, occurred_on, description, cost, paid_by, cause)
        SELECT re.id, c.unit_id, re.contract_id, re.occurred_on, re.description, re.cost, re.paid_by, re.cause
        FROM repair_events re LEFT JOIN contracts c ON c.id = re.contract_id;
      DROP TABLE repair_events;
      ALTER TABLE repair_events__new RENAME TO repair_events;`);
  })();
  db.pragma('foreign_keys = ON');
}

export function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  applyColumnPatches();
  migrateRepairEvents();
  db.exec(`CREATE INDEX IF NOT EXISTS idx_units_landlord ON units(landlord_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_repairs_unit ON repair_events(unit_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_unit_items_unit ON unit_items(unit_id)`);
}

export function resetDatabase() {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((r) => r.name);
  db.pragma('foreign_keys = OFF');
  for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t}"`);
  db.pragma('foreign_keys = ON');
  migrate();
}

export default db;
