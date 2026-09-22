# 인수인계 문서 — 개발팀/학생팀용

이 PoC를 이어받아 확장할 때 알아야 할 것만 정리했습니다.

---

## 1. 이 코드에서 가장 중요한 파일

**`server/src/engine/`** — 여기가 전부입니다.

DB도 네트워크도 모르는 **순수 함수**로 짰습니다. 이유는 세 가지입니다.

1. 단위 테스트가 가능합니다 (`npm test`, 12건)
2. 확정된 정산서를 나중에 **재계산해 검증**할 수 있습니다 (분쟁 시 필수)
3. 계산 규칙이 바뀌어도 DB/API를 건드리지 않습니다

엔진을 고칠 때는 **반드시 테스트를 먼저 추가**하세요. 돈 계산이라 회귀가 치명적입니다.

```js
// 단일 진입점 — 이 시그니처만 지키면 내부는 자유롭게 바꿔도 됩니다
buildSettlement({
  contract, area, rules, ruleItems,
  ltrfRates, maintenanceRate, maintenancePrepaid,
  damages, repairEvents, arrears,
}) → { lines: [...], totals: {...} }
```

## 2. 계산식 요약

| 항목 | 식 | 방향 |
|---|---|---|
| 장기수선충당금 | Σ(월단가 × 전용면적 × 점유비율) | 임차인 수령 |
| 선수관리비 | 임차인 대납 시 전액 | 임차인 수령 |
| 퇴거월 관리비 | 부과추정액 × 거주일수/월일수 − 선납액 | 부호에 따라 양방향 |
| 원상회복 | 교체비용 × max(0, 1−경과/내용연수) × 귀책비율 | 임대인 공제 |
| 거주 중 수선비 | 소액기준·귀책 여부로 분기 | 양방향 |
| 미납 차임 | 원금 + (원금×연이율×연체일/365) | 임대인 공제 |

**최종 상계** = Σ(임차인 수령) − Σ(임대인 공제)
**반환 총액** = 보증금 + 최종 상계

### 원상회복이 0원이 되는 사유는 3가지이며 구분해서 기록합니다
- `ordinary_wear` — 귀책비율 0 (통상손모, 임대인 부담)
- `grace_period` — 거주기간이 면제기간 이상
- `fully_depreciated` — 내용연수 경과로 잔존가치 0

화면에 사유를 다르게 보여주는 이유는, 임차인이 "왜 0원인지"를 이해해야 합의가 되기 때문입니다.

## 3. 지금 가짜(mock)인 부분 — 실서비스 전환 시 반드시 교체

| 부분 | 현재 상태 | 해야 할 일 |
|---|---|---|
| K-apt 단가 | 시드 데이터 (현실적 범위의 샘플) | `KAPT_SERVICE_KEY` 주입 → `services/kapt.js` 활성화 |
| **장충금 세대 단가 환산** | 단가(원/㎡)를 직접 저장 | ⚠ 아래 별도 설명 |
| 사용자 인증 | 없음 (party를 화면에서 전환) | 로그인 + 계약 참여자 권한 검증 |
| 사진 증거 | 경로 문자열만 | 업로드 + 해시 봉인 (아이디어 3) |
| 정산금 이동 | 계산만 | PG/에스크로 (전자금융거래법 검토 필요) |

### ⚠ 장기수선충당금 단가 환산 — 가장 주의할 지점

K-apt 실 API가 주는 값은 **단지 전체 월 부과총액(원)**입니다. 세대 단가(원/㎡)가 아닙니다.
환산하려면 단지 총 전용면적이 필요한데 K-apt는 이를 직접 주지 않습니다.

권장 방식:
1. 임차인에게 **관리비 고지서 1장**을 받아 실제 ㎡당 단가를 확정하고,
2. 그 단가를 기준으로 나머지 개월을 공공데이터 추세에 맞춰 채웁니다.

그래서 스키마를 `ltrf_rates(complex_id, ym, rate_per_sqm)`로 잡았습니다 —
**단가는 보정 가능한 입력값**이라는 전제입니다. 이 설계를 바꾸지 마세요.

결측월은 직전 단가로 보간하고 `imputed: true`로 표시합니다. 화면에서 주황색으로 구분됩니다.
실서비스에서는 보간 비율이 일정 수준을 넘으면 사용자에게 고지해야 합니다.

## 4. API 목록

```
GET    /api/health
GET    /api/complexes?q=                       단지 검색
GET    /api/complexes/:id/rates                월별 단가 조회
GET    /api/contracts                           계약 목록
POST   /api/contracts                           계약 생성
GET    /api/contracts/:id                       계약 + 규칙 + 점검결과
PATCH  /api/contracts/:id                       퇴거일/상태 변경
PUT    /api/contracts/:id/rules                 Rule Lock 저장
POST   /api/contracts/:id/rules/lock            규칙 잠금 서명 {party}
POST   /api/contracts/:id/damages               퇴거 점검 결과 등록
PATCH  /api/damages/:id
DELETE /api/damages/:id
GET    /api/contracts/:id/settlement/preview    미발행 미리보기
POST   /api/contracts/:id/settlement            정산서 발행
GET    /api/contracts/:id/settlement            발행된 정산서
POST   /api/settlements/:id/lines/:seq/respond  {party, status, note}
POST   /api/settlements/:id/seal                확정 (전원 동의 필요)
```

## 5. 상태 전이

```
계약    active ──► closing ──► closed
규칙    (미설정) ──► 저장됨 ──► 양측 잠금 ──► [새 버전으로만 변경 가능]
정산서  draft ◄──► agreed ──► sealed
          │          │           └─ 스냅샷 JSON + SHA-256 동결, 수정 불가
          └──────────┘
             이의 제기 시 agreed → draft 로 자동 복귀
```

## 6. 이어서 만들면 좋은 것 (우선순위 순)

1. **입주 시점 상태 봉인** — 사진 촬영 + 해시. 지금 원상회복 귀책비율은 사람이 입력하는데,
   입주 전/후 사진이 있어야 그 숫자에 근거가 생깁니다. (제안서 아이디어 3)
2. **인증·권한** — 계약 참여자만 자기 쪽 의견을 남길 수 있어야 합니다. 지금은 화면 전환으로 대체.
3. **이의 제기 → 조정 흐름** — 이의가 걸린 항목만 모아 재협상하는 화면.
4. **정산서 PDF 서버 생성** — 현재는 브라우저 인쇄. 확정본은 서버에서 고정 레이아웃으로 뽑는 게 맞습니다.
5. **공실·관리비 이상 탐지** (제안서 아이디어 4) — 같은 K-apt 데이터를 재사용할 수 있습니다.

## 7. 알려진 제약

- SQLite 단일 파일 (`server/butler.db`). 동시 쓰기가 많아지면 PostgreSQL로 이전 필요.
- `npm run seed`는 **DB를 초기화**합니다. 데이터를 넣은 뒤에는 실행하지 마세요.
- 정산서 재발행 시 기존 draft는 삭제되고 합의 상태도 초기화됩니다 (의도된 동작).
- 지연이자는 단리·일할입니다. 법정이율 적용이 필요하면 `engine/arrears.js`를 수정하세요.
