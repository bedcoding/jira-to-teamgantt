// TeamGantt 쓰기(작업 생성 / 그룹 조회 / 담당자 할당) API 헬퍼.
//
// 확장은 토큰을 저장하지 않으므로, 열려 있는 TeamGantt 탭의 MAIN 훅이 가로챈
// Authorization 토큰을 받아(GET_TG_TOKEN), host_permissions로 CORS가 면제되는
// 사이드패널에서 api.teamgantt.com 을 직접 호출한다. (프로젝트/사용자 "읽기"에서
// 이미 쓰던 경로와 동일하고, 여기서는 메서드를 POST까지 확장.)
//
// 동료 CLI(jira2tg) src/teamgantt.ts 의 createTask / listGroups(+flattenGroups) /
// assignResource 를 옮긴 것.

const API_BASE = "https://api.teamgantt.com/v1";

// 열린 TG 탭에서 가로챈 Authorization 토큰을 받아온다.
// 성공: { auth, tab } / 실패: { error: "no-tab"|"no-content-script"|"no-token", tab? }
export async function resolveTgToken() {
  const tabs = await chrome.tabs.query({ url: "https://app.teamgantt.com/*" });
  const tab = tabs.find((t) => t.active) ?? tabs[0];
  if (!tab) return { error: "no-tab" };
  let tokenResp;
  try {
    tokenResp = await chrome.tabs.sendMessage(tab.id, { type: "GET_TG_TOKEN" });
  } catch {
    return { error: "no-content-script", tab };
  }
  if (!tokenResp?.auth) return { error: "no-token", tab };
  return { auth: tokenResp.auth, tab };
}

// 공통 fetch. { ok, status, json }. 네트워크 예외만 throw.
async function apiFetch(path, auth, { method = "GET", body } = {}) {
  const headers = { Authorization: auth, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  if (text) {
    try { json = JSON.parse(text); } catch { json = text; }
  }
  return { ok: res.ok, status: res.status, json };
}

function unwrapList(r) {
  if (Array.isArray(r)) return r;
  if (Array.isArray(r?.data)) return r.data;
  return [];
}
function unwrapItem(r) {
  if (r && typeof r === "object" && "data" in r && r.data) return r.data;
  return r;
}

// 프로젝트 그룹 목록 → 깊이 들여쓰기된 평면 리스트. (CLI flattenGroups 이식)
// 중첩 배열(groups/children)과 parent_group_id 평면 리스트 두 형태 모두 처리.
export function flattenGroups(groups) {
  const label = (g) => g.name ?? `group ${g.id}`;
  const out = [];

  const hasNested = groups.some((g) => (g.groups?.length ?? 0) > 0 || (g.children?.length ?? 0) > 0);
  if (hasNested) {
    const walk = (list, depth, path) => {
      for (const g of list) {
        const sub = g.groups ?? g.children ?? [];
        out.push({ id: g.id, name: label(g), depth, path, hasChildren: sub.length > 0 });
        if (sub.length) walk(sub, depth + 1, [...path, label(g)]);
      }
    };
    walk(groups, 0, []);
    return out;
  }

  const ids = new Set(groups.map((g) => g.id));
  const childrenByParent = new Map();
  for (const g of groups) {
    if (g.parent_group_id != null && ids.has(g.parent_group_id)) {
      const arr = childrenByParent.get(g.parent_group_id) ?? [];
      arr.push(g);
      childrenByParent.set(g.parent_group_id, arr);
    }
  }
  const seen = new Set();
  const walk = (g, depth, path) => {
    if (seen.has(g.id)) return;
    seen.add(g.id);
    const children = childrenByParent.get(g.id) ?? [];
    out.push({ id: g.id, name: label(g), depth, path, hasChildren: children.length > 0 });
    for (const c of children) walk(c, depth + 1, [...path, label(g)]);
  };
  const roots = groups.filter((g) => g.parent_group_id == null || !ids.has(g.parent_group_id));
  for (const r of roots) walk(r, 0, []);
  for (const g of groups) if (!seen.has(g.id)) out.push({ id: g.id, name: label(g), depth: 0, path: [], hasChildren: false });
  return out;
}

// 프로젝트의 그룹을 조회해 평면 리스트로. (쿼리형 우선, 실패 시 경로형 폴백 — CLI listGroups와 동일)
export async function listGroupsFlat(projectId, auth) {
  let r = await apiFetch(`/groups?project_ids[]=${projectId}`, auth);
  if (!r.ok) r = await apiFetch(`/projects/${projectId}/groups`, auth);
  if (!r.ok) return { ok: false, status: r.status, error: `그룹 조회 실패 (HTTP ${r.status})` };
  return { ok: true, groups: flattenGroups(unwrapList(r.json)) };
}

// task 1건 생성. 단건 형식이 400/422면 벌크 형식 { project_id, tasks:[payload] }로 재시도. (CLI createTask)
// 성공: { ok:true, task } / 실패: { ok:false, status, error }
export async function createTask(payload, auth) {
  const r = await apiFetch(`/tasks`, auth, { method: "POST", body: payload });
  if (r.ok) return { ok: true, task: unwrapItem(r.json) };
  if (r.status === 400 || r.status === 422) {
    const r2 = await apiFetch(`/tasks`, auth, {
      method: "POST",
      body: { project_id: payload.project_id, tasks: [payload] },
    });
    if (r2.ok) {
      const list = Array.isArray(r2.json) ? r2.json : unwrapList(r2.json);
      const created = list[0] ?? unwrapItem(r2.json);
      if (created) return { ok: true, task: created };
    }
    return { ok: false, status: r2.status, error: `생성 실패 (단건 ${r.status} → 벌크 ${r2.status})` };
  }
  return { ok: false, status: r.status, error: `생성 실패 (HTTP ${r.status})` };
}

// 기존 task 수정. 호출부가 "변경된 필드만" 담은 payload를 보내므로 color 등 안 건드린 필드는
// 그대로 보존된다(= CLI의 수동편집 보존과 같은 효과). (CLI updateTask = PATCH /tasks/{id})
export async function updateTask(taskId, payload, auth) {
  const r = await apiFetch(`/tasks/${taskId}`, auth, { method: "PATCH", body: payload });
  if (r.ok) return { ok: true, task: unwrapItem(r.json) };
  return { ok: false, status: r.status, error: `수정 실패 (HTTP ${r.status})` };
}

// 담당자(리소스) 할당. 베스트에포트 — 실패해도 생성 자체는 성공으로 본다. (CLI assignResource)
export async function assignResource(taskId, typeId, type, auth) {
  const r = await apiFetch(`/tasks/resources/bulk/create`, auth, {
    method: "POST",
    body: { task_ids: [taskId], resource: { type_id: typeId, type } },
  });
  return { ok: r.ok, status: r.status };
}
