export function defaultJql() {
  const year = new Date().getFullYear();
  return `assignee = currentUser() AND updated >= "${year}-01-01" AND updated < "${year + 1}-01-01" order by updated DESC`;
}

function makeDefaults() {
  return {
    jiraDomain: "test.atlassian.net",
    jqlTemplate: defaultJql(),
    prefixRegex: "(?:^|\\s|\\[)([A-Z]+-\\d+)(?:\\]|\\s|$)",
    tgMyId: "",
    tgProjectId: "",
    tgPeople: [],
    tgProjects: [],
    jiraPageSize: 100,
    tgPageSize: 100,
    personJsonDraft: "",
    projectJsonDraft: "",
    activeTab: "jira",
    reportSource: "jira",
    rangeUnit: "month",
    compareDateSource: "jiraUpdated",
    syncIncludeStatuses: [],
    syncIncludeKinds: [],
  };
}

const DEFAULT_SETTINGS = makeDefaults();

export async function getAll() {
  const data = await chrome.storage.local.get(null);
  return {
    jiraIssues: data.jiraIssues ?? {},
    tgTasks: data.tgTasks ?? {},
    settings: { ...makeDefaults(), ...(data.settings ?? {}) },
  };
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...makeDefaults(), ...(settings ?? {}) };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function clearAll() {
  await chrome.storage.local.clear();
}

// Jira/TG 데이터 삭제 시 syncQueue + manualChecked도 같이 정리(진행 기록만 남는 어색함 방지).
export async function clearJiraIssues() {
  await chrome.storage.local.remove(["jiraIssues", "jiraFetchCache", "syncQueue", "manualChecked"]);
}

export async function clearTgTasks() {
  await chrome.storage.local.remove(["tgTasks", "tgFetchCache", "syncQueue", "manualChecked"]);
}

export async function exportAll() {
  return chrome.storage.local.get(null);
}

export async function importAll(json) {
  await chrome.storage.local.clear();
  await chrome.storage.local.set(json);
}

async function hashOf(obj) {
  const json = JSON.stringify(obj);
  const buf = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function upsertJiraIssues(incoming) {
  const { jiraIssues = {} } = await chrome.storage.local.get("jiraIssues");
  const now = new Date().toISOString();
  let added = 0, updated = 0, skipped = 0;
  for (const issue of incoming) {
    if (!issue?.key) { skipped++; continue; }
    const { key, ...rest } = issue;
    const hash = await hashOf(rest);
    const prev = jiraIssues[key];
    if (!prev) {
      jiraIssues[key] = { key, ...rest, hash, collectedAt: now };
      added++;
    } else if (prev.hash !== hash) {
      jiraIssues[key] = { ...prev, ...rest, hash, collectedAt: now };
      updated++;
    } else {
      skipped++;
    }
  }
  await chrome.storage.local.set({ jiraIssues });
  return { added, updated, skipped, total: Object.keys(jiraIssues).length };
}

export async function upsertTgTasks(incoming) {
  // incoming은 정규화된 [{id, rawTitle, jiraKey, start, end, progress, assignees}] 배열
  const { tgTasks = {} } = await chrome.storage.local.get("tgTasks");
  const now = new Date().toISOString();
  let added = 0, updated = 0, skipped = 0;
  for (const task of incoming) {
    if (task?.id == null) { skipped++; continue; }
    const key = String(task.id);
    const { id, ...rest } = task;
    const hash = await hashOf(rest);
    const prev = tgTasks[key];
    if (!prev) {
      tgTasks[key] = { id, ...rest, hash, collectedAt: now };
      added++;
    } else if (prev.hash !== hash) {
      tgTasks[key] = { ...prev, id, ...rest, hash, collectedAt: now };
      updated++;
    } else {
      skipped++;
    }
  }
  await chrome.storage.local.set({ tgTasks });
  return { added, updated, skipped, total: Object.keys(tgTasks).length };
}

// fetch 가로채기 응답(평탄화 배열 또는 { children: [...] })을 표준 task 객체로 변환.
// type=task만 통과 / resources[].type_id가 person ID (id는 resource-link 고유 ID).
export function normalizeTgFromFetch(payload, opts = {}) {
  const { prefixRegex, myTgId } = opts;
  const items = Array.isArray(payload) ? payload : (payload?.children ?? []);
  const re = prefixRegex ? new RegExp(prefixRegex) : null;
  const out = [];
  for (const it of items) {
    if (it == null || typeof it !== "object") continue;
    const type = it.type ?? (it.is_group ? "group" : "task");
    // task만 통과. group/subgroup/milestone은 제외.
    if (type !== "task") continue;
    const id = Number(it.id);
    if (!Number.isFinite(id)) continue;
    const name = String(it.name ?? "");
    const jiraKey = re ? (name.match(re)?.[1] ?? null) : null;

    const resources = []
      .concat(it.user_resources ?? [], it.resources ?? [], it.assigned_resources ?? [])
      .filter(Boolean)
      .map((r) => ({
        personId: Number(r.type_id ?? r.id ?? 0),
        name: String(r.name ?? r.full_name ?? ""),
      }));

    // 내 task만 필터. myTgId가 주어졌으면, resources가 비었거나
    // 매칭 안 되는 task는 모두 제외.
    if (myTgId) {
      if (resources.length === 0) continue;
      if (!resources.some((r) => String(r.personId) === String(myTgId))) continue;
    }

    out.push({
      id,
      rawTitle: name,
      jiraKey,
      start: it.start_date ?? null,
      end: it.end_date ?? null,
      progress: it.percent_complete ?? null,
      assignees: resources,
      projectId: it.project_id ?? null,
    });
  }
  return out;
}

export async function getTgFetchCache() {
  return (await chrome.storage.local.get("tgFetchCache")).tgFetchCache ?? {};
}

export async function clearTgFetchCache() {
  await chrome.storage.local.remove("tgFetchCache");
}

// Jira GraphQL IssueNavigator 응답 → 우리 표준 jira 객체 배열로 변환.
// 응답 구조: data.jira.jiraIssueSearchView.issues.edges[].node + .fieldSets.edges[].node.fields
export function normalizeJiraFromFetch(payload) {
  // 두 쿼리 응답 구조가 다름:
  //   - IssueNavigatorIssueSearchRefetchQuery → data.jira.jiraIssueSearchView.issues.edges
  //   - IssueNavigatorJiraListViewPaginationQuery → data.node.issues.edges (node.__typename === 'JiraListView')
  const edges =
    payload?.data?.jira?.jiraIssueSearchView?.issues?.edges
    ?? payload?.data?.node?.issues?.edges
    ?? payload?.data?.jiraIssueSearchView?.issues?.edges
    ?? [];
  if (edges.length === 0) {
    console.warn("[Jira→TeamGantt][jira-normalize] edges가 비어있음. payload 구조 확인 필요:", payload);
  }
  const out = [];
  for (const edge of edges) {
    const node = edge?.node;
    if (!node?.key) continue;
    const item = {
      key: node.key,
      summary: node.summary ?? "",
      status: "",
      assignee: "",
      reporter: "",
      priority: "",
      resolution: "",
      created: "",
      updated: "",
      dueDate: "",
      labels: [],
    };
    // fieldSets 안에서 필요한 필드만 골라 채움.
    const fieldEdges = edge?.fieldSets?.edges ?? [];
    for (const fs of fieldEdges) {
      const fsNode = fs?.node;
      const inner = fsNode?.fields?.edges?.[0]?.node;
      if (!inner) continue;
      switch (fsNode.fieldSetId) {
        case "summary":   item.summary = inner.text ?? item.summary; break;
        case "status":    item.status = inner.status?.name ?? ""; break;
        case "assignee":  item.assignee = inner.user?.name ?? ""; break;
        case "reporter":  item.reporter = inner.user?.name ?? ""; break;
        case "priority":  item.priority = inner.priority?.name ?? ""; break;
        case "resolution":item.resolution = inner.resolution?.name ?? ""; break;
        case "created":   item.created = inner.dateTime ?? ""; break;
        case "updated":   item.updated = inner.dateTime ?? ""; break;
        case "duedate":   item.dueDate = inner.date ?? ""; break;
        case "labels": {
          const ls = inner.selectedLabelsConnection?.edges ?? [];
          item.labels = ls.map((e) => e?.node?.name).filter(Boolean);
          break;
        }
      }
    }
    out.push(item);
  }
  return out;
}

export async function getJiraFetchCache() {
  return (await chrome.storage.local.get("jiraFetchCache")).jiraFetchCache ?? { pages: [] };
}

export async function clearJiraFetchCache() {
  await chrome.storage.local.remove("jiraFetchCache");
}

// 동기화 큐:
//   items: 아직 주입 안 한 대기 항목 [{key, text}]
//   pendingKey: 방금 TG 입력창에 박은 항목의 key. 사용자가 Enter로 저장하면 다음 단축키에서 doneKeys로 승격됨.
//   doneKeys: 사용자가 다음 항목을 단축키로 진행함으로써 "저장됐다고 가정" 된 키들.
//   confirmedKeys: doneKeys 중 사용자가 이름/날짜 보정까지 마쳤다고 직접 체크한 키들.
export async function getSyncQueue() {
  const { syncQueue } = await chrome.storage.local.get("syncQueue");
  const q = syncQueue ?? { items: [], pendingKey: null, doneKeys: [], confirmedKeys: [] };
  if (!q.confirmedKeys) q.confirmedKeys = [];
  return q;
}

export async function setSyncQueue(q) {
  await chrome.storage.local.set({ syncQueue: q });
}

export async function clearSyncQueue() {
  await chrome.storage.local.remove("syncQueue");
}

// 비교 탭에서 사용자가 빈 TeamGantt 셀을 직접 클릭해서 ✓ 표시한 키들.
// 동기화 큐와 무관하게 보존된다(수동 체크).
export async function getManualChecked() {
  const { manualChecked } = await chrome.storage.local.get("manualChecked");
  return new Set(manualChecked ?? []);
}

export async function setManualChecked(setOrArray) {
  const arr = Array.isArray(setOrArray) ? setOrArray : [...setOrArray];
  await chrome.storage.local.set({ manualChecked: arr });
}
