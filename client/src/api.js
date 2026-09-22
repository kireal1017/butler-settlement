const BASE = '/api';

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data;
}

async function send(path, formData) {
  const res = await fetch(BASE + path, { method: 'POST', body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data;
}

export const api = {
  health: () => req('GET', '/health'),
  complexes: (q = '') => req('GET', `/complexes?q=${encodeURIComponent(q)}`),
  syncComplex: (id) => req('POST', `/complexes/${id}/sync`),

  landlords: () => req('GET', '/landlords'),
  session: (landlordId) => req('POST', '/session', { landlordId }),
  units: (landlordId) => req('GET', `/landlords/${landlordId}/units`),
  tasks: (landlordId) => req('GET', `/landlords/${landlordId}/tasks`),

  share: (token) => req('GET', `/share/${token}`),
  respondContract: (token, decision, reason) =>
    req('POST', `/share/${token}/contract-response`, { decision, reason }),

  unit: (id) => req('GET', `/units/${id}`),
  createUnit: (b) => req('POST', '/units', b),
  deleteUnit: (id) => req('DELETE', `/units/${id}`),

  /* House Log — 집에 직접 적는 이력. 계약이 없어도 남길 수 있다. */
  addUnitItem: (unitId, b) => req('POST', `/units/${unitId}/items`, b),
  deleteUnitItem: (itemId) => req('DELETE', `/unit-items/${itemId}`),
  addUnitRepair: (unitId, b) => req('POST', `/units/${unitId}/repairs`, b),
  deleteRepair: (repairId) => req('DELETE', `/repairs/${repairId}`),
  registrySamples: () => req('GET', '/registry-samples'),
  verifyRegistry: (id, { file, sample }) => {
    if (!file) return req('POST', `/units/${id}/registry`, { sample });
    const form = new FormData();
    form.append('file', file);
    return send(`/units/${id}/registry`, form);
  },

  /** OCR 값을 임대인이 고쳐 확정 — 판정이 confirmed 로 남는다 */
  confirmRegistry: (documentId, edits) =>
    req('POST', `/registry-documents/${documentId}/confirm`, edits),
  registryFileUrl: (documentId) => `/api/registry-documents/${documentId}/file`,

  contracts: () => req('GET', '/contracts'),
  contractOcr: (file) => {
    const form = new FormData();
    form.append('file', file);
    return send('/contracts/ocr', form);
  },
  contract: (id) => req('GET', `/contracts/${id}`),
  createContract: (b) => req('POST', '/contracts', b),
  sendContract: (id) => req('POST', `/contracts/${id}/send`),
  renewContract: (id, b) => req('POST', `/contracts/${id}/renew`, b),
  declineRenewal: (id) => req('POST', `/contracts/${id}/decline-renewal`, {}),

  startMoveout: (id, moveOutDate) => req('POST', `/contracts/${id}/start-moveout`, { moveOutDate }),
  requestInspection: (id) => req('POST', `/contracts/${id}/inspection`),
  inspection: (id) => req('GET', `/contracts/${id}/inspection`),
  reviewInspection: (inspectionId, items) =>
    req('POST', `/inspections/${inspectionId}/review`, { items }),
  photoUrl: (photoId) => `/api/inspection-photos/${photoId}/file`,

  uploadPhoto: (token, { file, area, note }) => {
    const form = new FormData();
    form.append('file', file);
    form.append('area', area);
    if (note) form.append('note', note);
    return send(`/share/${token}/photos`, form);
  },
  submitInspection: (token) => req('POST', `/share/${token}/inspection-submit`),
  patchContract: (id, b) => req('PATCH', `/contracts/${id}`, b),
  putRules: (id, b) => req('PUT', `/contracts/${id}/rules`, b),
  lockRules: (id, party) => req('POST', `/contracts/${id}/rules/lock`, { party }),
  addDamage: (id, b) => req('POST', `/contracts/${id}/damages`, b),
  patchDamage: (id, b) => req('PATCH', `/damages/${id}`, b),
  deleteDamage: (id) => req('DELETE', `/damages/${id}`),
  preview: (id) => req('GET', `/contracts/${id}/settlement/preview`),
  issue: (id) => req('POST', `/contracts/${id}/settlement`),
  settlement: (id) => req('GET', `/contracts/${id}/settlement`),
  sendSettlement: (id) => req('POST', `/contracts/${id}/settlement/send`),
  seal: (sid) => req('POST', `/settlements/${sid}/seal`),

  /* 임차인 — 토큰으로만. 임대인 화면에서 임차인 동의를 대신 누르는 경로는 없다. */
  respondSettlement: (token, seq, status, note) =>
    req('POST', `/share/${token}/settlement-response`, { seq, status, note }),
  submitSettlement: (token) => req('POST', `/share/${token}/settlement-submit`),
};

export const won = (n) => `${Number(n ?? 0).toLocaleString('ko-KR')}원`;

/**
 * Date → 'YYYY-MM-DD' (로컬 기준).
 * toISOString() 은 UTC 로 되돌리기 때문에 KST 에서 하루가 밀린다. 날짜에는 쓰지 말 것.
 */
export const toIsoDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
