import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, resetDatabase } from './db.js';
import * as svc from './service.js';

/**
 * 시연용 시드 데이터 (v2)
 *
 * V2-SPEC §8 — 시간을 기다리지 않고 전 구간을 보여주려면 계약이 각 단계에 하나씩 있어야 한다.
 * 그래서 모든 날짜를 "오늘" 기준 상대값으로 만든다. 언제 실행해도 D-일수가 유지된다.
 *
 *   계약 ①  pending_tenant           임차인 링크 확인 → 동의 / 거부
 *   계약 ②  active,  만료 D-400      거주 중 · 수선 신고 (이전 사이클 계약 ⑤ 를 물고 있음)
 *   계약 ③  active,  만료 D-150      갱신 판단
 *   계약 ④  closing, 퇴거 D-20       점검 → 정산서 → 합의 → 확정
 *   계약 ⑤  closed                   House Log — 도배 시공일이 계약 ② 로 승계된다
 *
 * ⚠ 단가는 K-apt 공개 관리비의 현실적 범위를 반영한 "샘플"이다.
 *   실 서비스에서는 services/kapt.js 가 KAPT_SERVICE_KEY로 실측값을 적재한다.
 *   (장기수선충당금 단가 실측 범위: 노후 단지 50~100원/㎡, 신축 대단지 250~400원/㎡)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'inspections');

/* ── 날짜 유틸 ─────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

const today = new Date(new Date().setHours(0, 0, 0, 0));

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

/** 말일 보정 포함 — 1/31 에 +1개월 하면 2/28(29) 이 된다 */
function addMonths(date, n) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

/* ── 계약별 기준일 ─────────────────────────────────────────── */

// ④ 퇴거 진행 중 — 48개월 거주로 장기수선충당금이 100만원대까지 쌓이는 전형 케이스
const c4MoveOut = addDays(today, 20);
const c4MoveIn = addDays(addMonths(c4MoveOut, -48), 1);

// ③ 거주 중 · 만료 D-150 → 갱신 판단 시점
const c3Expires = addDays(today, 150);
const c3MoveIn = addDays(addMonths(c3Expires, -24), 1);

// ② 거주 중 · 만료 D-400  /  ⑤ 그 직전 사이클(종료)
const c2Expires = addDays(today, 400);
const c2MoveIn = addDays(addMonths(c2Expires, -24), 1);
const c5MoveOut = addDays(c2MoveIn, -1);
const c5MoveIn = addDays(addMonths(c5MoveOut, -24), 1);

// ① 임차인 확인 대기 — 아직 입주 전
const c1MoveIn = addDays(today, 14);
const c1Expires = addDays(addMonths(c1MoveIn, 24), -1);

// 단가는 가장 이른 입주일(계약 ④)보다 앞에서 시작해야 한다
const RATE_START = addMonths(new Date(today.getFullYear(), today.getMonth(), 1), -60);
const RATE_MONTHS = 96;

/* ── 단지 ──────────────────────────────────────────────────── */

/**
 * 단지는 **실재하는 K-apt 단지**다 (2026-09-22 실 API 로 확인).
 * 가짜 단지코드를 쓰면 키를 넣어도 `POST /complexes/:id/sync` 가 아무것도 못 받아
 * "실데이터 연동"을 시연에서 보여줄 수 없다.
 *
 * `ltrfBase` 는 키가 없을 때 쓰는 시드 단가이고, 실제 2025-06 부과액을 전용면적합으로
 * 나눈 값에 맞춰 두었다. 그래서 키를 넣어 실 단가로 갈아끼워도 금액이 크게 튀지 않는다.
 */
const COMPLEXES = [
  {
    kaptCode: 'A11005401', name: '광화문스페이스본 아파트',
    address: '서울특별시 종로구 신문로2가 1-434', sido: '서울특별시', sigungu: '종로구',
    households: 744, builtYear: 2008, privArea: 94981.45,
    ltrfBase: 472, mntBase: 2480,
  },
  {
    kaptCode: 'A46383519', name: '분당매화마을주공3단지',
    address: '경기도 성남분당구 야탑동 205', sido: '경기도', sigungu: '성남분당구',
    households: 851, builtYear: 1993, privArea: 37236.45,
    ltrfBase: 615, mntBase: 2310,
  },
  {
    kaptCode: 'A10024527', name: '더샵인천스카이타워2단지',
    address: '인천광역시 미추홀구 도화동 1002', sido: '인천광역시', sigungu: '미추홀구',
    households: 588, builtYear: 2020, privArea: 47661.61,
    ltrfBase: 229, mntBase: 2620,
  },
];

/* ── 점검 사진 플레이스홀더 ────────────────────────────────── */

const AREA_LABELS = {
  livingroom: '거실', bedroom: '침실', kitchen: '주방',
  bathroom: '욕실', balcony: '발코니', entrance: '현관',
};

/**
 * 시연용 점검 사진. 실제 사진 대신 구역명을 그린 SVG 를 둔다.
 * 임차인이 올린 사진 자리에 무엇이 들어오는지 화면에서 바로 보이게 하는 것이 목적이다.
 */
function writePhotoPlaceholder(area, index, caption) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `seed-${area}-${index}.svg`;
  const label = AREA_LABELS[area] ?? area;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
  <rect width="640" height="480" fill="#e8e6e1"/>
  <rect x="24" y="24" width="592" height="432" fill="none" stroke="#b9b4aa" stroke-width="2" stroke-dasharray="10 8"/>
  <text x="320" y="214" text-anchor="middle" font-family="sans-serif" font-size="46" fill="#5d574c">${label}</text>
  <text x="320" y="262" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#8a8377">${caption}</text>
  <text x="320" y="420" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#a39c8f">시연용 예시 이미지 (실제 사진 아님)</text>
</svg>`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), svg, 'utf8');
  return `uploads/inspections/${name}`;
}

/* ── 등기부 문서 (소유 검증 완료 세대의 감사 추적) ─────────── */

function registryText(unit, ownerName) {
  return [
    `[집합건물] ${unit.address} 제${unit.dong.replace('동', '')}동 제${unit.floor}층 제${unit.ho.replace('호', '')}호`,
    `고유번호  ${unit.uniqueNo}`,
    `【 표 제 부 】 ( 전유부분의 건물의 표시 )`,
    `철근콘크리트조 ${unit.exclusiveArea}㎡`,
    `【 갑 구 】 ( 소유권에 관한 사항 )`,
    `2 소유권이전 소유자 ${ownerName} 800101-*******`,
  ].join('\n');
}

/* ── 시드 ──────────────────────────────────────────────────── */

function seed() {
  resetDatabase();
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });

  /* 임대인 ------------------------------------------------- */
  const insLandlord = db.prepare(`INSERT INTO landlords (name, phone) VALUES (?, ?)`);
  const L1 = insLandlord.run('김성호', '010-2841-7730').lastInsertRowid;
  const L2 = insLandlord.run('박정훈', '010-5512-9084').lastInsertRowid;

  /* 단지 + 월별 단가 --------------------------------------- */
  const insComplex = db.prepare(`
    INSERT INTO complexes (kapt_code, name, address, sido, sigungu, total_households, built_year,
                           priv_area, data_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'seed')`);
  const insLtrf = db.prepare(
    `INSERT INTO ltrf_rates (complex_id, ym, rate_per_sqm, data_source) VALUES (?, ?, ?, 'seed')`);
  const insMnt = db.prepare(
    `INSERT INTO maintenance_rates (complex_id, ym, rate_per_sqm, data_source) VALUES (?, ?, ?, 'seed')`);

  const complexIds = [];
  for (const c of COMPLEXES) {
    const cid = insComplex.run(
      c.kaptCode, c.name, c.address, c.sido, c.sigungu,
      c.households, c.builtYear, c.privArea).lastInsertRowid;
    complexIds.push(cid);

    for (let i = 0; i < RATE_MONTHS; i += 1) {
      const month = addMonths(RATE_START, i);
      const key = ym(month);
      const yearsIn = i / 12;

      // 장기수선충당금은 연 1회 규약 개정 시 계단식 인상
      const ltrf = Math.round(c.ltrfBase * (1 + 0.035 * Math.floor(yearsIn)) * 100) / 100;
      insLtrf.run(cid, key, ltrf);

      // 관리비는 계절(냉난방) 변동이 큼
      const m = month.getMonth() + 1;
      const seasonal = [1, 2, 12].includes(m) ? 1.45 : [7, 8].includes(m) ? 1.22 : 1.0;
      insMnt.run(cid, key, Math.round(c.mntBase * (1 + 0.028 * yearsIn) * seasonal * 100) / 100);
    }
  }

  /* 세대 --------------------------------------------------- */
  const insUnit = db.prepare(`
    INSERT INTO units (complex_id, dong, ho, exclusive_area, landlord_id,
                       ownership_status, ownership_verified_at, registry_owner_name,
                       registry_unique_no, vacancy_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const UNITS = [
    { complex: 0, dong: '103동', ho: '1204호', floor: 12, area: 84.95, landlord: L1,
      owner: '김성호', uniqueNo: '1146-2019-003812', vacancy: 'closing' },
    { complex: 0, dong: '107동', ho: '502호', floor: 5, area: 59.88, landlord: L1,
      owner: '김성호', uniqueNo: '1146-2019-004507', vacancy: 'occupied' },
    { complex: 1, dong: '201동', ho: '1801호', floor: 18, area: 101.82, landlord: L1,
      owner: '김성호', uniqueNo: '1355-2011-008820', vacancy: 'occupied' },
    { complex: 2, dong: '305동', ho: '703호', floor: 7, area: 74.52, landlord: L1,
      owner: '김성호', uniqueNo: '2745-2018-001164', vacancy: 'contracting' },
    // 등기부 미제출 — ownership_unverified 할 일이 생기는 세대
    { complex: 0, dong: '110동', ho: '901호', floor: 9, area: 112.35, landlord: L1,
      owner: null, uniqueNo: null, vacancy: 'vacant' },
    { complex: 1, dong: '204동', ho: '302호', floor: 3, area: 84.77, landlord: L2,
      owner: '박정훈', uniqueNo: '1355-2011-009431', vacancy: 'vacant' },
  ];

  const insRegistry = db.prepare(`
    INSERT INTO registry_documents (unit_id, file_path, ocr_provider, raw_text,
                                    parsed_json, match_result, confidence)
    VALUES (?, ?, 'fixture', ?, ?, 'matched', 0.97)`);

  const unitIds = UNITS.map((u) => {
    const verified = Boolean(u.owner);
    const id = insUnit.run(
      complexIds[u.complex], u.dong, u.ho, u.area, u.landlord,
      verified ? 'verified' : 'unverified',
      verified ? iso(addDays(today, -30)) : null,
      u.owner, u.uniqueNo, u.vacancy,
    ).lastInsertRowid;

    if (verified) {
      const address = COMPLEXES[u.complex].address;
      const parsed = {
        address,
        dong: u.dong.replace('동', ''),
        floor: String(u.floor),
        ho: u.ho.replace('호', ''),
        uniqueNo: u.uniqueNo,
        exclusiveArea: u.area,
        owners: [u.owner],
      };
      insRegistry.run(
        id,
        `fixtures/registry/seed-unit-${id}.png`,
        registryText({ ...u, address, exclusiveArea: u.area }, u.owner),
        JSON.stringify(parsed),
      );
    }
    return id;
  });

  /* 공통 prepared statements ------------------------------- */
  const insContract = db.prepare(`
    INSERT INTO contracts (unit_id, landlord_id, landlord_name, tenant_name, tenant_phone,
                           deposit, monthly_rent, move_in_date, move_out_date,
                           term_months, expires_on, parent_contract_id, renewal_decision, status)
    VALUES (@unitId, @landlordId, @landlordName, @tenantName, @tenantPhone,
            @deposit, @monthlyRent, @moveInDate, @moveOutDate,
            @termMonths, @expiresOn, @parentContractId, @renewalDecision, @status)`);

  const insRuleSet = db.prepare(`
    INSERT INTO rule_sets (contract_id, version, ltrf_burden, prorate_edge_months,
      minor_repair_threshold, wallpaper_grace_months, flooring_grace_months,
      late_interest_rate, tenant_paid_advance_fee, advance_fee_amount,
      locked_by_landlord_at, locked_by_tenant_at)
    VALUES (@contractId, 1, @ltrfBurden, 1, @minorRepairThreshold,
            @wallpaperGrace, @flooringGrace, @lateInterestRate,
            @tenantPaidAdvanceFee, @advanceFeeAmount, @lockedByLandlord, @lockedByTenant)`);

  const insRuleItem = db.prepare(`
    INSERT INTO rule_items (rule_set_id, category, label, useful_life_years,
      last_renewed_on, replacement_cost, grace_applicable)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  const insDamage = db.prepare(`
    INSERT INTO damage_reports (contract_id, rule_item_id, description, fault_ratio,
                                quoted_cost, photo_ref, inspection_id, photo_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  const insRepairEvent = db.prepare(`
    INSERT INTO repair_events (contract_id, occurred_on, description, cost, paid_by, cause)
    VALUES (?, ?, ?, ?, ?, ?)`);

  const insRepairRequest = db.prepare(`
    INSERT INTO repair_requests (contract_id, description, photo_path, reported_at, status, repair_event_id)
    VALUES (?, ?, ?, ?, ?, ?)`);

  const insShareLink = db.prepare(`
    INSERT INTO share_links (token, contract_id, purpose, expires_at, first_opened_at, created_at,
                             completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  const insArrears = db.prepare(
    `INSERT INTO rent_arrears (contract_id, ym, amount, overdue_days) VALUES (?, ?, ?, ?)`);
  const insPrepaid = db.prepare(
    `INSERT INTO maintenance_prepaid (contract_id, ym, amount) VALUES (?, ?, ?)`);

  const insInspection = db.prepare(`
    INSERT INTO inspections (contract_id, kind, status, requested_at, submitted_at)
    VALUES (?, 'moveout', ?, ?, ?)`);
  const insPhoto = db.prepare(
    `INSERT INTO inspection_photos (inspection_id, area, file_path, note) VALUES (?, ?, ?, ?)`);

  const token = () => crypto.randomBytes(16).toString('base64url');

  /* ⑤ 종료된 이전 사이클 — House Log 의 출발점 ------------- */
  const c5Id = insContract.run({
    unitId: unitIds[1], landlordId: L1, landlordName: '김성호',
    tenantName: '오세진', tenantPhone: '010-3377-1120',
    deposit: 240_000_000, monthlyRent: 0,
    moveInDate: iso(c5MoveIn), moveOutDate: iso(c5MoveOut),
    termMonths: 24, expiresOn: iso(c5MoveOut),
    parentContractId: null, renewalDecision: 'moveout', status: 'closing',
  }).lastInsertRowid;

  const rs5 = insRuleSet.run({
    contractId: c5Id, ltrfBurden: 'landlord', minorRepairThreshold: 100_000,
    wallpaperGrace: 36, flooringGrace: 36, lateInterestRate: 5.0,
    tenantPaidAdvanceFee: 0, advanceFeeAmount: 0,
    lockedByLandlord: `${iso(addDays(c5MoveIn, -7))} 10:20:00`,
    lockedByTenant: `${iso(addDays(c5MoveIn, -7))} 15:05:00`,
  }).lastInsertRowid;

  const rs5Wallpaper = insRuleItem
    .run(rs5, 'wallpaper', '전체 도배', 6, iso(addMonths(c5MoveIn, -2)), 2_800_000, 1).lastInsertRowid;
  insDamage.run(c5Id, rs5Wallpaper, '침실 벽면 오염 및 흠집', 0.6, null, null, null, null);

  // 종료된 계약이므로 정산서를 실제로 발행·합의·확정까지 돌려 둔다 (해시 동결 상태를 재현)
  const s5 = svc.issue(c5Id);
  for (const line of s5.lines) {
    svc.respond(s5.id, line.seq, 'landlord', 'agreed', null);
    svc.respond(s5.id, line.seq, 'tenant', 'agreed', null);
  }
  svc.seal(s5.id);

  // 퇴거 시 도배를 새로 시공했다 → 이 날짜가 계약 ② 의 rule_items 로 승계된다
  insRepairEvent.run(c5Id, iso(c5MoveOut), '퇴거 후 전체 도배 재시공', 2_800_000, 'landlord', 'wear');

  /* ② 거주 중 · 만료 D-400 ------------------------------- */
  const c2Id = insContract.run({
    unitId: unitIds[1], landlordId: L1, landlordName: '김성호',
    tenantName: '한서윤', tenantPhone: '010-8842-2019',
    deposit: 280_000_000, monthlyRent: 0,
    moveInDate: iso(c2MoveIn), moveOutDate: null,
    termMonths: 24, expiresOn: iso(c2Expires),
    parentContractId: null, renewalDecision: null, status: 'active',
  }).lastInsertRowid;

  const rs2 = insRuleSet.run({
    contractId: c2Id, ltrfBurden: 'landlord', minorRepairThreshold: 100_000,
    wallpaperGrace: 24, flooringGrace: 24, lateInterestRate: 5.0,
    tenantPaidAdvanceFee: 1, advanceFeeAmount: 480_000,
    lockedByLandlord: `${iso(addDays(c2MoveIn, -5))} 09:40:00`,
    lockedByTenant: `${iso(addDays(c2MoveIn, -5))} 18:12:00`,
  }).lastInsertRowid;

  // ★ 도배 최종 시공일 = 계약 ⑤ 퇴거일. 고리가 닫히는 지점.
  insRuleItem.run(rs2, 'wallpaper', '전체 도배', 6, iso(c5MoveOut), 2_800_000, 1);
  insRuleItem.run(rs2, 'flooring', '거실·침실 강마루', 10, iso(addMonths(c5MoveIn, -18)), 4_200_000, 1);
  insRuleItem.run(rs2, 'fixture', '욕실 세면대·수전', 12, iso(addMonths(c5MoveIn, -40)), 780_000, 0);

  const ev2 = insRepairEvent
    .run(c2Id, iso(addDays(today, -168)), '싱크대 배수 트랩 교체', 72_000, 'landlord', 'wear').lastInsertRowid;
  insRepairRequest.run(c2Id, '싱크대 아래에서 물이 새요', null, iso(addDays(today, -172)), 'done', ev2);
  // 2일 넘게 방치된 신고 → repair_open 할 일이 생긴다
  insRepairRequest.run(c2Id, '안방 창틀에 곰팡이가 생기고 실리콘이 들떴어요', null, iso(addDays(today, -4)), 'open', null);

  /* ③ 거주 중 · 만료 D-150 → 갱신 판단 -------------------- */
  const c3Id = insContract.run({
    unitId: unitIds[2], landlordId: L1, landlordName: '김성호',
    tenantName: '최민서', tenantPhone: '010-4419-6673',
    deposit: 100_000_000, monthlyRent: 2_200_000,
    moveInDate: iso(c3MoveIn), moveOutDate: null,
    termMonths: 24, expiresOn: iso(c3Expires),
    parentContractId: null, renewalDecision: null, status: 'active',
  }).lastInsertRowid;

  const rs3 = insRuleSet.run({
    contractId: c3Id, ltrfBurden: 'landlord', minorRepairThreshold: 50_000,
    wallpaperGrace: 36, flooringGrace: 36, lateInterestRate: 6.0,
    tenantPaidAdvanceFee: 1, advanceFeeAmount: 620_000,
    lockedByLandlord: `${iso(addDays(c3MoveIn, -5))} 11:00:00`,
    lockedByTenant: `${iso(addDays(c3MoveIn, -5))} 11:25:00`,
  }).lastInsertRowid;

  insRuleItem.run(rs3, 'wallpaper', '전체 도배', 6, iso(addDays(c3MoveIn, -10)), 3_100_000, 1);
  insRuleItem.run(rs3, 'flooring', '거실 강마루', 10, iso(addMonths(c3MoveIn, -30)), 5_900_000, 1);
  insRuleItem.run(rs3, 'appliance', '빌트인 식기세척기', 8, iso(addMonths(c3MoveIn, -14)), 1_180_000, 0);

  /* ④ 퇴거 진행 중 · D-20 — 점검 제출 완료, 검토 대기 ----- */
  const c4Id = insContract.run({
    unitId: unitIds[0], landlordId: L1, landlordName: '김성호',
    tenantName: '이지은', tenantPhone: '010-7028-3345',
    deposit: 450_000_000, monthlyRent: 0,
    moveInDate: iso(c4MoveIn), moveOutDate: iso(c4MoveOut),
    termMonths: 48, expiresOn: iso(c4MoveOut),
    parentContractId: null, renewalDecision: 'moveout', status: 'closing',
  }).lastInsertRowid;

  const rs4 = insRuleSet.run({
    contractId: c4Id, ltrfBurden: 'landlord', minorRepairThreshold: 100_000,
    wallpaperGrace: 24, flooringGrace: 24, lateInterestRate: 5.0,
    tenantPaidAdvanceFee: 0, advanceFeeAmount: 0,
    lockedByLandlord: `${iso(addDays(c4MoveIn, -7))} 14:02:00`,
    lockedByTenant: `${iso(addDays(c4MoveIn, -7))} 14:40:00`,
  }).lastInsertRowid;

  insRuleItem.run(rs4, 'wallpaper', '전체 도배', 6, iso(addDays(c4MoveIn, -12)), 2_400_000, 1);
  insRuleItem.run(rs4, 'flooring', '거실·침실 강마루', 10, iso(addMonths(c4MoveIn, -54)), 5_600_000, 1);
  insRuleItem.run(rs4, 'appliance', '빌트인 인덕션', 8, iso(addMonths(c4MoveIn, -16)), 1_350_000, 0);
  insRuleItem.run(rs4, 'fixture', '욕실 세면대·수전', 12, iso(addMonths(c4MoveIn, -70)), 900_000, 0);

  insRepairEvent.run(c4Id, iso(addMonths(c4MoveOut, -34)), '보일러 순환펌프 교체', 380_000, 'tenant', 'wear');
  insRepairEvent.run(c4Id, iso(addMonths(c4MoveOut, -27)), '싱크대 배수 트랩 교체', 65_000, 'landlord', 'wear');
  insRepairEvent.run(c4Id, iso(addMonths(c4MoveOut, -19)), '현관 도어락 배터리·기판', 92_000, 'landlord', 'wear');

  insArrears.run(c4Id, ym(addMonths(c4MoveOut, -1)), 0, 0);
  insPrepaid.run(c4Id, ym(c4MoveOut), 0);

  // 점검: 임차인이 사진을 제출한 상태. 귀책비율 지정(검토)은 시연에서 임대인이 한다.
  const insp4 = insInspection.run(
    c4Id, 'submitted', iso(addDays(today, -6)), iso(addDays(today, -2))).lastInsertRowid;

  const PHOTOS = [
    ['livingroom', '벽면 변색 · 못자국', '거실 벽면 전반 변색, 액자 못자국 6개'],
    ['livingroom', '강마루 눌림 자국', '소파·장식장 하중에 의한 눌림'],
    ['kitchen', '인덕션 상판 균열', '조리기구 낙하로 상판 균열'],
    ['bathroom', '수전 레버 파손', '세면대 수전 레버가 헐거워져 고정 안 됨'],
    ['bedroom', '상태 양호', '특이사항 없음'],
    ['balcony', '상태 양호', '특이사항 없음'],
  ];
  PHOTOS.forEach(([area, caption, note], i) => {
    insPhoto.run(insp4, area, writePhotoPlaceholder(area, i + 1, caption), note);
  });

  /* 점검은 이미 제출된 상태다 — 링크도 닫혀 있어야 화면과 어긋나지 않는다 */
  insShareLink.run(
    token(), c4Id, 'inspection', iso(addDays(c4MoveOut, 7)),
    iso(addDays(today, -5)), `${iso(addDays(today, -6))} 17:30:00`,
    `${iso(addDays(today, -2))} 19:10:00`);

  /* ① 임차인 확인 대기 ------------------------------------- */
  const c1Id = insContract.run({
    unitId: unitIds[3], landlordId: L1, landlordName: '김성호',
    tenantName: '정하늘', tenantPhone: '010-2255-8890',
    deposit: 320_000_000, monthlyRent: 0,
    moveInDate: iso(c1MoveIn), moveOutDate: null,
    termMonths: 24, expiresOn: iso(c1Expires),
    parentContractId: null, renewalDecision: null, status: 'pending_tenant',
  }).lastInsertRowid;

  const rs1 = insRuleSet.run({
    contractId: c1Id, ltrfBurden: 'landlord', minorRepairThreshold: 100_000,
    wallpaperGrace: 24, flooringGrace: 24, lateInterestRate: 5.0,
    tenantPaidAdvanceFee: 1, advanceFeeAmount: 550_000,
    lockedByLandlord: `${iso(addDays(today, -4))} 13:15:00`,
    lockedByTenant: null,
  }).lastInsertRowid;

  insRuleItem.run(rs1, 'wallpaper', '전체 도배', 6, iso(addDays(today, -21)), 2_600_000, 1);
  insRuleItem.run(rs1, 'flooring', '거실·침실 강마루', 10, iso(addDays(today, -21)), 4_800_000, 1);
  insRuleItem.run(rs1, 'appliance', '빌트인 인덕션', 8, iso(addMonths(today, -8)), 1_290_000, 0);

  // 4일 전 발송 후 무응답 → tenant_pending 할 일이 생긴다
  const c1Token = token();
  insShareLink.run(
    c1Token, c1Id, 'contract_review', iso(addDays(today, 10)), null,
    `${iso(addDays(today, -4))} 13:20:00`, null);

  /* 요약 --------------------------------------------------- */
  const count = (sql) => db.prepare(sql).get().n;
  console.log('✓ seed 완료');
  console.log(`  임대인 2명 · 단지 ${COMPLEXES.length}곳 · 세대 ${unitIds.length}곳 · 단가 ${RATE_MONTHS}개월분`);
  console.log(`  계약 ${count('SELECT COUNT(*) n FROM contracts')}건`);
  console.log('');
  console.log(`  ① #${c1Id} 정하늘   pending_tenant  입주 예정 ${iso(c1MoveIn)} (D+14)`);
  console.log(`  ② #${c2Id} 한서윤   active          만료 ${iso(c2Expires)} (D-400) · 수선 신고 1건 대기`);
  console.log(`  ③ #${c3Id} 최민서   active          만료 ${iso(c3Expires)} (D-150) · 갱신 판단`);
  console.log(`  ④ #${c4Id} 이지은   closing         퇴거 ${iso(c4MoveOut)} (D-20) · 점검 제출 완료`);
  console.log(`  ⑤ #${c5Id} 오세진   closed          정산 확정 (해시 동결) — House Log`);
  console.log('');
  console.log(`  임차인 계약 확인 링크:  /t/${c1Token}`);
}

seed();
