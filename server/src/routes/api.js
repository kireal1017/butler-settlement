import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import * as repo from '../repository.js';
import * as svc from '../service.js';
import { isLive } from '../services/kapt.js';
import { syncComplexList, syncComplexInfo, syncLtrfRates } from '../services/kapt-sync.js';
import { contractTimeline, contractExpiry } from '../services/timeline.js';
import { listSamples, providerName, recognize } from '../services/ocr.js';
import { parseContract, anyRecognized } from '../services/contract.js';
import { refreshTasks, taskSummary } from '../services/tasks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(__dirname, '..', '..');
const UPLOAD_ROOT = path.join(SERVER_ROOT, 'uploads');
const REGISTRY_DIR = path.join(UPLOAD_ROOT, 'registry');
/** 계약서는 읽고 바로 버린다 — uploads/ 아래에 남기지 않는다 (CONTRACT-OCR-PLAN §7) */
const CONTRACT_TMP = path.join(os.tmpdir(), 'butler-contract-ocr');
const INSPECTION_DIR = path.join(UPLOAD_ROOT, 'inspections');

const r = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * 등기부 이미지 업로드.
 * 원본 파일명을 그대로 경로에 쓰지 않는다 — 난수 접두사를 붙이고 위험한 문자를 지운다.
 */
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(REGISTRY_DIR, { recursive: true });
      cb(null, REGISTRY_DIR);
    },
    filename: (_req, file, cb) => {
      const safe = path.basename(file.originalname).replace(/[^A-Za-z0-9._-]/g, '_').slice(-60);
      cb(null, `${crypto.randomBytes(6).toString('hex')}__${safe}`);
    },
  }),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

/**
 * 계약서 업로드 — 등기부와 달리 **임시 폴더**에 받는다.
 * 보관이 목적이 아니라 읽고 버리는 것이 목적이라 uploads/ 에 두지 않는다 (§7).
 * 한 번에 1장만 받는다 — 보증금·기간이 있는 1페이지만 처리한다.
 */
const contractUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(CONTRACT_TMP, { recursive: true });
      cb(null, CONTRACT_TMP);
    },
    filename: (_req, file, cb) => {
      const safe = path.basename(file.originalname).replace(/[^A-Za-z0-9._-]/g, '_').slice(-60);
      cb(null, `${crypto.randomBytes(6).toString('hex')}__${safe}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

/** 점검 사진 업로드 — 등기부와 같은 규칙 (난수 접두사 · 이미지만) */
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(INSPECTION_DIR, { recursive: true });
      cb(null, INSPECTION_DIR);
    },
    filename: (_req, file, cb) => {
      const safe = path.basename(file.originalname).replace(/[^A-Za-z0-9._-]/g, '_').slice(-60);
      cb(null, `${crypto.randomBytes(6).toString('hex')}__${safe}`);
    },
  }),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

/* ── 임대인 / 집 ────────────────────────────────────────── */
r.get('/landlords', wrap((_req, res) => res.json(repo.listLandlords())));

/** 데모 로그인 — 인증은 범위 밖이다. 존재 확인만 하고 돌려준다. */
r.post('/session', wrap((req, res) => {
  const landlord = repo.getLandlord(Number(req.body.landlordId));
  if (!landlord) return res.status(404).json({ error: '임대인을 찾을 수 없습니다' });
  res.json({ landlord });
}));

r.get('/landlords/:id/units', wrap((req, res) => {
  const landlord = repo.getLandlord(Number(req.params.id));
  if (!landlord) return res.status(404).json({ error: '임대인을 찾을 수 없습니다' });

  const units = repo.listUnitsByLandlord(landlord.id).map((u) => ({
    ...u,
    timeline: u.contractId
      ? contractTimeline({
          expires_on: u.expiresOn,
          move_out_date: u.moveOutDate,
          renewal_decision: u.renewalDecision,
        })
      : null,
  }));
  res.json({ landlord, units });
}));

/**
 * 할 일 목록. 크론이 없으므로 조회 시점에 규칙을 다시 돌려 tasks 를 갱신한다 (V2-SPEC §3).
 * 같은 데이터면 몇 번 불러도 같은 결과가 나온다.
 */
r.get('/landlords/:id/tasks', wrap((req, res) => {
  const landlord = repo.getLandlord(Number(req.params.id));
  if (!landlord) return res.status(404).json({ error: '임대인을 찾을 수 없습니다' });

  const tasks = refreshTasks(landlord.id);
  res.json({ tasks, summary: taskSummary(tasks) });
}));

r.post('/units', wrap((req, res) => {
  const { complexId, dong, ho, exclusiveArea, landlordId } = req.body;
  if (!complexId || !exclusiveArea || !landlordId)
    return res.status(400).json({ error: '단지 · 전용면적 · 임대인은 필수입니다' });
  if (!repo.getLandlord(Number(landlordId)))
    return res.status(404).json({ error: '임대인을 찾을 수 없습니다' });

  const id = db.prepare(`
    INSERT INTO units (complex_id, dong, ho, exclusive_area, landlord_id, vacancy_status)
    VALUES (?, ?, ?, ?, ?, 'vacant')`
  ).run(Number(complexId), dong ?? null, ho ?? null, Number(exclusiveArea), Number(landlordId))
    .lastInsertRowid;

  res.status(201).json(repo.getUnit(id));
}));

r.get('/units/:id', wrap((req, res) => {
  const unit = repo.getUnit(Number(req.params.id));
  if (!unit) return res.status(404).json({ error: '집을 찾을 수 없습니다' });
  res.json({ unit, ...repo.getUnitHistory(unit.id) });
}));

/**
 * 집 삭제 — 잘못 등록한 집을 지우는 경로.
 *
 * **계약이 한 건이라도 붙어 있으면 거절한다.** units 를 지우면 FK 가
 * contracts → settlements → settlement_lines 까지 연쇄 삭제하는데, 확정(sealed)
 * 정산서는 해시로 동결해 둔 근거 자료다. 집을 지우는 실수 한 번으로 그게 통째로
 * 사라지면 안 된다. 계약이 있는 집은 지우는 대신 계약을 종료시키는 것이 맞다.
 *
 * 등기부 원본 파일은 행보다 **먼저** 지운다. 순서가 반대면 행이 사라진 뒤
 * 파일 경로를 알 방법이 없어 uploads/ 에 고아 파일이 남는다.
 */
r.delete('/units/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const unit = repo.getUnit(id);
  if (!unit) return res.status(404).json({ error: '집을 찾을 수 없습니다' });

  const contracts = db.prepare(`SELECT COUNT(*) n FROM contracts WHERE unit_id = ?`).get(id).n;
  if (contracts)
    return res.status(409).json({
      error: `계약 ${contracts}건이 등록되어 있어 집을 지울 수 없습니다. `
        + '계약 이력과 정산서가 함께 지워지기 때문입니다.',
    });

  for (const doc of db.prepare(`SELECT file_path FROM registry_documents WHERE unit_id = ?`).all(id)) {
    const resolved = path.resolve(doc.file_path ?? '');
    if (resolved.startsWith(REGISTRY_DIR + path.sep)) fs.rmSync(resolved, { force: true });
  }

  db.prepare(`DELETE FROM units WHERE id = ?`).run(id);
  res.status(204).end();
}));

/* ── House Log — 집에 직접 적는 이력 ─────────────────────
 *
 * 품목 시공 이력과 수선 이력은 원래 계약에서만 나왔다. 그래서 막 등록한 집은
 * "작년에 도배했다"를 적어 둘 곳이 없었고, 첫 계약의 Rule Lock 이 빈 상태로 시작했다.
 * 시공과 수선은 임차인이 아니라 **집**에 일어나는 일이므로 집에 붙인다.
 */

const CATEGORIES = ['wallpaper', 'flooring', 'appliance', 'fixture', 'etc'];
const PAID_BY = ['landlord', 'tenant'];
const CAUSES = ['wear', 'tenant_fault', 'landlord_duty'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const unitOr404 = (req, res) => {
  const unit = repo.getUnit(Number(req.params.id));
  if (!unit) { res.status(404).json({ error: '집을 찾을 수 없습니다' }); return null; }
  return unit;
};

/** 품목 시공 이력 추가 — 다음 계약 Rule Lock 의 '최종 시공일' 로 승계된다 */
r.post('/units/:id/items', wrap((req, res) => {
  const unit = unitOr404(req, res);
  if (!unit) return;

  const { category, label, usefulLifeYears, lastRenewedOn, replacementCost, note } = req.body ?? {};
  if (!CATEGORIES.includes(category))
    return res.status(400).json({ error: `구분은 ${CATEGORIES.join(' · ')} 중 하나여야 합니다` });
  if (!String(label ?? '').trim())
    return res.status(400).json({ error: '품목 이름을 적어 주세요' });
  if (!ISO_DATE.test(String(lastRenewedOn ?? '')))
    return res.status(400).json({ error: '시공일은 YYYY-MM-DD 형식이어야 합니다' });
  if (!(Number(usefulLifeYears) > 0))
    return res.status(400).json({ error: '내용연수는 0보다 커야 합니다' });

  const id = db.prepare(`
    INSERT INTO unit_items (unit_id, category, label, useful_life_years,
      last_renewed_on, replacement_cost, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(unit.id, category, String(label).trim(), Number(usefulLifeYears),
        lastRenewedOn, Math.round(Number(replacementCost) || 0),
        String(note ?? '').trim() || null).lastInsertRowid;

  res.status(201).json({ id, ...repo.getUnitHistory(unit.id) });
}));

r.delete('/unit-items/:itemId', wrap((req, res) => {
  const info = db.prepare(`DELETE FROM unit_items WHERE id = ?`).run(Number(req.params.itemId));
  if (!info.changes) return res.status(404).json({ error: '시공 이력을 찾을 수 없습니다' });
  res.status(204).end();
}));

/**
 * 수선 이력 추가.
 *
 * `contractId` 를 주면 그 계약의 정산에 들어간다(소액수선 기준 적용 대상).
 * 주지 않으면 집의 이력으로만 남고 **어느 정산에도 들어가지 않는다** — 공실 기간
 * 수선을 누군가의 보증금에서 빼면 안 되기 때문이다.
 */
r.post('/units/:id/repairs', wrap((req, res) => {
  const unit = unitOr404(req, res);
  if (!unit) return;

  const { occurredOn, description, cost, paidBy, cause, contractId = null } = req.body ?? {};
  if (!ISO_DATE.test(String(occurredOn ?? '')))
    return res.status(400).json({ error: '수선일은 YYYY-MM-DD 형식이어야 합니다' });
  if (!String(description ?? '').trim())
    return res.status(400).json({ error: '어떤 수선인지 적어 주세요' });
  if (!PAID_BY.includes(paidBy))
    return res.status(400).json({ error: '부담 주체는 임대인 또는 임차인이어야 합니다' });
  if (!CAUSES.includes(cause))
    return res.status(400).json({ error: `사유는 ${CAUSES.join(' · ')} 중 하나여야 합니다` });

  /* 다른 집 계약에 수선을 붙이면 그 임차인 정산에 엉뚱한 금액이 들어간다 */
  if (contractId != null) {
    const c = repo.getContract(Number(contractId));
    if (!c || c.unit_id !== unit.id)
      return res.status(400).json({ error: '이 집의 계약이 아닙니다' });
  }

  const id = db.prepare(`
    INSERT INTO repair_events (unit_id, contract_id, occurred_on, description, cost, paid_by, cause)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(unit.id, contractId == null ? null : Number(contractId), occurredOn,
        String(description).trim(), Math.round(Number(cost) || 0), paidBy, cause).lastInsertRowid;

  res.status(201).json({ id, ...repo.getUnitHistory(unit.id) });
}));

r.delete('/repairs/:repairId', wrap((req, res) => {
  const id = Number(req.params.repairId);
  const row = db.prepare(`SELECT contract_id FROM repair_events WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: '수선 이력을 찾을 수 없습니다' });

  /* 확정된 정산서는 이 수선을 근거로 금액을 적어 두었다. 근거만 지우면 숫자를 설명할 수 없다. */
  if (row.contract_id != null) {
    const sealed = db.prepare(
      `SELECT COUNT(*) n FROM settlements WHERE contract_id = ? AND sealed_at IS NOT NULL`
    ).get(row.contract_id).n;
    if (sealed)
      return res.status(409).json({ error: '확정된 정산서의 근거라 지울 수 없습니다' });
  }

  db.prepare(`DELETE FROM repair_events WHERE id = ?`).run(id);
  res.status(204).end();
}));

/** 시연용 내장 등기부 샘플 — 키 없이도 전 구간이 돌아야 한다 */
r.get('/registry-samples', wrap((_req, res) =>
  res.json({ provider: providerName(), samples: listSamples() })));

/** 등기부 업로드(multipart) 또는 내장 샘플 선택({ sample }) → OCR → 파싱 → 검증 */
r.post('/units/:id/registry', upload.single('file'), wrap(async (req, res) => {
  const filePath = req.file
    ? req.file.path
    : req.body.sample && listSamples().includes(req.body.sample)
      ? `${req.body.sample}.png`
      : null;

  if (!filePath)
    return res.status(400).json({ error: '등기부 이미지를 올리거나 샘플을 선택해 주세요' });

  res.json(await svc.verifyUnitRegistry(Number(req.params.id), filePath));
}));

/**
 * 등기부 확인 완료 — OCR 값을 임대인이 고쳐 확정한다.
 * 판정은 `confirmed` 로 남는다. OCR 이 대조해 일치한 `matched` 와 구분된다.
 */
r.post('/registry-documents/:id/confirm', wrap((req, res) =>
  res.json(svc.confirmUnitRegistry(Number(req.params.id), req.body ?? {}))));

/**
 * 업로드 원본은 정적 서빙하지 않는다 (V2-SPEC §5).
 * DB 에 등록된 문서만, 그 id 로만 꺼낸다 — 경로를 직접 받지 않으므로 경로 조작이 불가능하다.
 */
r.get('/registry-documents/:id/file', wrap((req, res) => {
  const doc = repo.getRegistryDocument(Number(req.params.id));
  if (!doc) return res.status(404).json({ error: '문서를 찾을 수 없습니다' });

  const resolved = path.resolve(doc.file_path);
  if (!resolved.startsWith(REGISTRY_DIR + path.sep) || !fs.existsSync(resolved))
    return res.status(404).json({ error: '원본 이미지가 없습니다 (샘플 또는 시드 문서)' });

  res.sendFile(resolved);
}));

/* ── 단지 ───────────────────────────────────────────────── */

/**
 * 단지 검색은 **로컬 테이블만** 본다.
 *
 * K-apt 목록 API(V4)에는 단지명 검색 파라미터가 없고 전국 목록을 페이지로만 준다.
 * 그래서 매 검색마다 실 API 를 때리면 찾는 단지가 그 페이지에 없어 0건이 나온다.
 * 대신 `POST /complexes/sync-list` 로 전국 목록을 한 번 받아 두고, 검색은 그 위에서
 * 한다 — 로컬이지만 내용은 실데이터다. 동기화 전이면 시드 3곳만 나온다.
 */
r.get('/complexes', wrap((req, res) => {
  const q = (req.query.q ?? '').trim();
  const rows = q
    ? db.prepare(`
        SELECT * FROM complexes WHERE name LIKE ? OR address LIKE ?
        ORDER BY CASE data_source WHEN 'kapt' THEN 0 ELSE 1 END, name LIMIT 50`)
        .all(`%${q}%`, `%${q}%`)
    : db.prepare(`SELECT * FROM complexes ORDER BY id LIMIT 50`).all();
  res.json({ source: rows.every((x) => x.data_source === 'kapt') ? 'kapt' : 'local', items: rows });
}));

/** 전국 단지 목록 동기화 (1,000건×약 23페이지, 30초 안팎) */
r.post('/complexes/sync-list', wrap(async (_req, res) => {
  if (!isLive()) return res.status(409).json({ error: 'K-apt 키가 설정되지 않았습니다' });
  res.json(await syncComplexList());
}));

/** 단지 하나를 실데이터로 갱신 — 기본정보(privArea) + 지정 구간 월별 단가 */
r.post('/complexes/:id/sync', wrap(async (req, res) => {
  if (!isLive()) return res.status(409).json({ error: 'K-apt 키가 설정되지 않았습니다' });
  const id = Number(req.params.id);
  const { from, to, force = false } = req.body ?? {};
  const info = await syncComplexInfo(id);
  const rates = from && to ? await syncLtrfRates(id, from, to, Boolean(force)) : null;
  res.json({ info, rates });
}));

r.get('/complexes/:id/rates', wrap((req, res) => {
  const { from = '2019-01', to = '2026-12' } = req.query;
  res.json({
    ltrf: repo.getLtrfRates(Number(req.params.id), from, to),
    maintenance: db.prepare(`
      SELECT ym, rate_per_sqm AS ratePerSqm FROM maintenance_rates
      WHERE complex_id = ? AND ym BETWEEN ? AND ? ORDER BY ym`)
      .all(Number(req.params.id), from, to),
  });
}));

/* ── 계약 ───────────────────────────────────────────────── */
r.get('/contracts', wrap((_req, res) => res.json(repo.listContracts())));

r.get('/contracts/:id', wrap((req, res) => {
  const c = repo.getContract(Number(req.params.id));
  if (!c) return res.status(404).json({ error: '계약을 찾을 수 없습니다' });
  const ruleRow = repo.getRuleSet(c.id);

  // v1 화면들이 snake_case 로 읽고 있어 기존 키는 그대로 두고 v2 정보만 덧붙인다
  res.json({
    contract: c,
    rules: ruleRow ? repo.toRules(ruleRow) : null,
    ruleItems: ruleRow ? repo.getRuleItems(ruleRow.id) : [],
    damages: repo.getDamages(c.id),
    repairEvents: repo.getRepairEvents(c.id),
    arrears: repo.getArrears(c.id),

    unit: repo.getUnit(c.unit_id),
    timeline: contractTimeline(c),
    renewal: svc.renewalChain(c),
    inspection: svc.readInspection(c.id),
    inspectionLink: repo.getActiveShareLink(c.id, 'inspection'),
    shareLink: repo.getActiveShareLink(c.id, 'contract_review'),
    tenantResponse: repo.getLatestContractResponse(c.id),
    settlementId: db.prepare(
      `SELECT id FROM settlements WHERE contract_id = ? ORDER BY id DESC LIMIT 1`
    ).get(c.id)?.id ?? null,
  });
}));

/**
 * 계약서 사진 → 필드 자동 채움 (docs/CONTRACT-OCR-PLAN.md §6)
 *
 * **아무것도 저장하지 않는다.** 파싱 결과만 돌려주고 끝낸다. 계약 생성은
 * 기존 `POST /contracts` 가 그대로 담당한다. 그래서 사용자가 화면에서 값을
 * 한 번 보고 고칠 기회가 반드시 생긴다.
 *
 * 계약서 3페이지에는 주민등록번호와 연락처가 있어 등기부보다 민감하다 (§7):
 *   · 업로드 파일은 OS 임시 폴더에 잠깐 두었다가 **파싱 직후 지운다**
 *   · OCR 원문은 응답에 담지도, DB 에 넣지도 않는다
 *   · 그럼에도 파서가 주민번호 패턴을 한 번 더 마스킹한다 (2중 방어)
 */
r.post('/contracts/ocr', contractUpload.single('file'), wrap(async (req, res) => {
  if (!req.file)
    return res.status(400).json({ error: '계약서 이미지를 올려 주세요' });

  try {
    const { text, provider, confidence } = await recognize(req.file.path, { kind: 'contracts' });
    if (!text.trim())
      return res.status(422).json({
        error: 'parse_failed',
        message: '계약서를 읽지 못했습니다. 직접 입력해 주세요.',
      });

    const { fields, warnings } = parseContract(text);
    if (!anyRecognized(fields))
      return res.status(422).json({
        error: 'parse_failed',
        message: '계약서 양식을 인식하지 못했습니다. 직접 입력해 주세요.',
      });

    res.json({ provider, ocrConfidence: confidence, fields, warnings });
  } finally {
    /* 파싱이 실패해도 파일은 지운다. 남기면 주민번호가 담긴 이미지가 서버에 쌓인다. */
    fs.rmSync(req.file.path, { force: true });
  }
}));

/** 계약은 이미 등록된 집에 붙는다. 집 자체는 POST /units 로 만든다. */
r.post('/contracts', wrap((req, res) => {
  const {
    unitId, landlordId, tenantName, tenantPhone,
    deposit = 0, monthlyRent = 0, moveInDate, termMonths = 24, parentContractId = null,
  } = req.body;

  if (!unitId || !landlordId || !tenantName || !moveInDate)
    return res.status(400).json({ error: '집 · 임대인 · 임차인 · 입주일은 필수입니다' });

  const unit = repo.getUnit(Number(unitId));
  if (!unit) return res.status(404).json({ error: '집을 찾을 수 없습니다' });

  const landlord = repo.getLandlord(Number(landlordId));
  if (!landlord) return res.status(404).json({ error: '임대인을 찾을 수 없습니다' });

  const id = db.prepare(`
    INSERT INTO contracts (unit_id, landlord_id, landlord_name, tenant_name, tenant_phone,
                           deposit, monthly_rent, move_in_date, term_months, expires_on,
                           parent_contract_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`
  ).run(
    unit.id, landlord.id, landlord.name, tenantName, tenantPhone ?? null,
    Number(deposit), Number(monthlyRent), moveInDate, Number(termMonths),
    contractExpiry(moveInDate, Number(termMonths)), parentContractId,
  ).lastInsertRowid;

  res.status(201).json(repo.getContract(id));
}));

/** 임차인에게 계약 확인 링크 발송 */
r.post('/contracts/:id/send', wrap((req, res) =>
  res.status(201).json(svc.sendContractLink(Number(req.params.id)))));

/** 갱신 — 새 계약 생성 · parent 연결 · Rule Lock 승계. 성립은 임차인 동의 후다. */
r.post('/contracts/:id/renew', wrap((req, res) =>
  res.status(201).json(svc.renewContract(Number(req.params.id), req.body ?? {}))));

/** 갱신하지 않음 — 만료로 종료할 예정임을 기록한다 (퇴거 절차는 별도) */
r.post('/contracts/:id/decline-renewal', wrap((req, res) =>
  res.json(svc.declineRenewal(Number(req.params.id)))));

/* ── 퇴거 개시 · 점검 ───────────────────────────────────── */

/** 퇴거 절차 시작 — 계약 파기가 아니라 만료에 따른 종료 절차다 */
r.post('/contracts/:id/start-moveout', wrap((req, res) =>
  res.json(svc.startMoveout(Number(req.params.id), req.body?.moveOutDate))));

/** 점검 요청 + 임차인 링크 발급 */
r.post('/contracts/:id/inspection', wrap((req, res) =>
  res.status(201).json(svc.requestInspection(Number(req.params.id)))));

/** 점검 검토 화면이 쓰는 묶음 (사진 · 품목 · 이미 지정한 항목) */
r.get('/contracts/:id/inspection', wrap((req, res) => {
  const inspection = svc.readInspection(Number(req.params.id));
  if (!inspection) return res.status(404).json({ error: '점검이 없습니다' });
  res.json({
    inspection,
    contract: repo.getContract(Number(req.params.id)),
    shareLink: repo.getActiveShareLink(Number(req.params.id), 'inspection'),
  });
}));

/** 항목별 귀책비율 지정 → damage_reports 생성 */
r.post('/inspections/:id/review', wrap((req, res) =>
  res.json(svc.reviewInspection(Number(req.params.id), req.body?.items ?? []))));

/**
 * 점검 사진 원본. 등기부와 같은 규칙 — id 로만 꺼내고 경로를 입력으로 받지 않는다.
 * 시드 사진은 상대 경로(uploads/inspections/...)로 들어 있어 서버 루트 기준으로 푼다.
 */
r.get('/inspection-photos/:id/file', wrap((req, res) => {
  const photo = repo.getInspectionPhoto(Number(req.params.id));
  if (!photo) return res.status(404).json({ error: '사진을 찾을 수 없습니다' });

  const resolved = path.resolve(SERVER_ROOT, photo.file_path);
  if (!resolved.startsWith(INSPECTION_DIR + path.sep) || !fs.existsSync(resolved))
    return res.status(404).json({ error: '원본 이미지가 없습니다' });

  res.sendFile(resolved);
}));

/**
 * 계약 수정.
 *
 * 조건(임차인·보증금·차임·입주일·기간)은 **작성 중이거나 수정 요청을 받은 계약에서만**
 * 고칠 수 있다. 임차인이 동의한 뒤에 조건이 조용히 바뀌면 "임차인이 무엇에 동의했는가"를
 * 말할 수 없게 되고, 이미 발행된 정산서의 근거(보증금·차임)가 흔들린다.
 * 거주 중 계약의 조건을 바꾸는 정상 경로는 **갱신**이다.
 *
 * 입주일이나 기간이 바뀌면 만료일을 다시 계산한다 — 두 값을 따로 두면
 * 화면·할 일·엔진이 서로 다른 만료일을 보게 된다.
 */
const TERM_FIELDS = {
  tenantName: 'tenant_name',
  tenantPhone: 'tenant_phone',
  deposit: 'deposit',
  monthlyRent: 'monthly_rent',
  moveInDate: 'move_in_date',
  termMonths: 'term_months',
};

r.patch('/contracts/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const before = repo.getContract(id);
  if (!before) return res.status(404).json({ error: '계약을 찾을 수 없습니다' });

  const { moveOutDate, status } = req.body;
  const fields = [];
  const vals = [];
  const touchedTerms = Object.keys(TERM_FIELDS).filter((k) => req.body[k] !== undefined);

  if (touchedTerms.length) {
    if (!['draft', 'rejected'].includes(before.status))
      return res.status(409).json({
        error: '작성 중이거나 수정 요청을 받은 계약에서만 조건을 고칠 수 있습니다. '
          + '거주 중 계약은 갱신으로 조건을 바꿉니다.',
      });

    if (req.body.tenantName !== undefined && !String(req.body.tenantName).trim())
      return res.status(400).json({ error: '임차인 이름은 비울 수 없습니다' });

    for (const k of touchedTerms) {
      const raw = req.body[k];
      const v = ['deposit', 'monthlyRent', 'termMonths'].includes(k)
        ? Number(raw)
        : (typeof raw === 'string' ? raw.trim() || null : raw);
      if (typeof v === 'number' && !Number.isFinite(v))
        return res.status(400).json({ error: `${k} 값이 올바르지 않습니다` });
      fields.push(`${TERM_FIELDS[k]} = ?`);
      vals.push(v);
    }

    const moveIn = req.body.moveInDate ?? before.move_in_date;
    const months = Number(req.body.termMonths ?? before.term_months);
    if (moveIn && months > 0) { fields.push('expires_on = ?'); vals.push(contractExpiry(moveIn, months)); }
  }

  if (moveOutDate !== undefined) { fields.push('move_out_date = ?'); vals.push(moveOutDate); }
  if (status !== undefined) { fields.push('status = ?'); vals.push(status); }
  if (!fields.length) return res.status(400).json({ error: '변경할 항목이 없습니다' });

  vals.push(id);
  db.prepare(`UPDATE contracts SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  res.json(repo.getContract(id));
}));

/* ── Rule Lock ──────────────────────────────────────────── */
r.put('/contracts/:id/rules', wrap((req, res) =>
  res.json(svc.saveRuleSet(Number(req.params.id), req.body))));

/** 규칙 잠금 서명 */
r.post('/contracts/:id/rules/lock', wrap((req, res) => {
  const party = req.body.party;
  if (!['landlord', 'tenant'].includes(party))
    return res.status(400).json({ error: 'party는 landlord 또는 tenant' });
  const rs = repo.getRuleSet(Number(req.params.id));
  if (!rs) return res.status(404).json({ error: '규칙이 없습니다' });
  const col = party === 'landlord' ? 'locked_by_landlord_at' : 'locked_by_tenant_at';
  db.prepare(`UPDATE rule_sets SET ${col} = datetime('now','localtime') WHERE id = ?`).run(rs.id);
  res.json(repo.toRules(repo.getRuleSet(Number(req.params.id))));
}));

/* ── 임차인 (토큰 기반, 인증 없음) ──────────────────────── */
r.get('/share/:token', wrap((req, res) => res.json(svc.readShareContext(req.params.token))));

r.post('/share/:token/contract-response', wrap((req, res) =>
  res.json(svc.respondToContract(req.params.token, req.body.decision, req.body.reason))));

/** 점검 사진 제출 (구역별 1장씩) */
r.post('/share/:token/photos', photoUpload.single('file'), wrap((req, res) => {
  if (!req.file) return res.status(400).json({ error: '사진 파일이 필요합니다' });
  res.status(201).json(svc.addInspectionPhoto(req.params.token, {
    area: req.body.area,
    filePath: path.relative(SERVER_ROOT, req.file.path),
    note: req.body.note,
  }));
}));

/** 점검 제출 완료 — 링크가 닫히고 임대인 검토로 넘어간다 */
r.post('/share/:token/inspection-submit', wrap((req, res) =>
  res.json(svc.submitInspection(req.params.token))));

/** 정산서 항목별 동의 / 이의 — 임차인의 응답은 이 경로로만 들어온다 */
r.post('/share/:token/settlement-response', wrap((req, res) =>
  res.json(svc.respondToSettlement(
    req.params.token, req.body.seq, req.body.status, req.body.note))));

/** 정산서 확인 제출 — 전 항목을 확인해야 닫힌다 */
r.post('/share/:token/settlement-submit', wrap((req, res) =>
  res.json(svc.submitSettlementResponse(req.params.token))));

/* ── 퇴거 점검 결과 ─────────────────────────────────────── */
r.post('/contracts/:id/damages', wrap((req, res) => {
  const { ruleItemId, description, faultRatio = 0, quotedCost = null, photoRef = null } = req.body;
  const id = db.prepare(`
    INSERT INTO damage_reports (contract_id, rule_item_id, description, fault_ratio, quoted_cost, photo_ref)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(Number(req.params.id), ruleItemId ?? null, description, faultRatio, quotedCost, photoRef)
    .lastInsertRowid;
  res.status(201).json(db.prepare(`SELECT * FROM damage_reports WHERE id = ?`).get(id));
}));

r.patch('/damages/:id', wrap((req, res) => {
  const { faultRatio, quotedCost, description } = req.body;
  const f = []; const v = [];
  if (faultRatio !== undefined) { f.push('fault_ratio = ?'); v.push(faultRatio); }
  if (quotedCost !== undefined) { f.push('quoted_cost = ?'); v.push(quotedCost); }
  if (description !== undefined) { f.push('description = ?'); v.push(description); }
  if (!f.length) return res.status(400).json({ error: '변경할 항목이 없습니다' });
  v.push(Number(req.params.id));
  db.prepare(`UPDATE damage_reports SET ${f.join(', ')} WHERE id = ?`).run(...v);
  res.json(db.prepare(`SELECT * FROM damage_reports WHERE id = ?`).get(Number(req.params.id)));
}));

r.delete('/damages/:id', wrap((req, res) => {
  db.prepare(`DELETE FROM damage_reports WHERE id = ?`).run(Number(req.params.id));
  res.status(204).end();
}));

/* ── 정산서 ─────────────────────────────────────────────── */
/* 계산 전에 K-apt 실 단가를 확보한다. 키가 없으면 즉시 통과한다. */
r.get('/contracts/:id/settlement/preview', wrap(async (req, res) => {
  const id = Number(req.params.id);
  await svc.ensureRates(id);
  res.json(svc.calculate(id));
}));

r.post('/contracts/:id/settlement', wrap(async (req, res) => {
  const id = Number(req.params.id);
  await svc.ensureRates(id);
  res.status(201).json(svc.issue(id));
}));

r.get('/contracts/:id/settlement', wrap((req, res) => {
  const contractId = Number(req.params.id);
  const row = db.prepare(
    `SELECT id FROM settlements WHERE contract_id = ? ORDER BY id DESC LIMIT 1`
  ).get(contractId);
  if (!row) return res.status(404).json({ error: '발행된 정산서가 없습니다' });
  res.json({ ...svc.read(row.id), shareLink: svc.settlementShareState(contractId) });
}));

/** 정산서 확인 링크 발급 (재발송하면 이전 링크는 버려진다) */
r.post('/contracts/:id/settlement/send', wrap((req, res) =>
  res.status(201).json(svc.sendSettlementLink(Number(req.params.id)))));

r.get('/settlements/:id', wrap((req, res) => res.json(svc.read(Number(req.params.id)))));

/**
 * 임대인 쪽 항목 응답. **party 를 받지 않는다** — 임차인의 동의는 토큰 경로
 * (`/share/:token/settlement-response`)로만 들어와야 한다. 임대인이 대신 눌러 줄 수
 * 있으면 합의 기록이 증거로서 의미를 잃는다.
 */
r.post('/settlements/:id/lines/:seq/respond', wrap((req, res) =>
  res.json(svc.respond(
    Number(req.params.id), Number(req.params.seq),
    'landlord', req.body.status, req.body.note))));

r.post('/settlements/:id/seal', wrap((req, res) =>
  res.json(svc.seal(Number(req.params.id)))));

export default r;
