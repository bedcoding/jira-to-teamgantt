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
    projectApiDraft: "",
    personApiDraft: "",
    activeTab: "jira",
    reportSource: "jira",
    rangeUnit: "month",
    compareDateSource: "jiraUpdated",
    // 비교 탭 하위 모드: api(그룹 일괄 등록) | manual(단축키 반자동).
    // 기본은 주력인 api. 사용자가 '수동 동기화'를 고르면 그 선택이 여기 저장돼 유지된다.
    compareMode: "api",
    favoriteGroupIds: [],   // 등록 대상으로 자주 쓰는 TG 그룹 — select 최상단에 고정
    syncIncludeStatuses: [],
    syncIncludeKinds: [],
  };
}

const DEFAULT_SETTINGS = makeDefaults();

// 필요한 키만 읽는다. get(null)로 전체를 읽으면 화면에 쓰지도 않는 jiraFetchCache /
// tgFetchCache(가로챈 API 응답 원본, unlimitedStorage라 수 MB까지 자람)까지 매번
// 역직렬화해서 패널 초기 렌더가 눈에 띄게 느려진다.
// ※ 백업은 전체가 필요하므로 exportAll()이 따로 get(null)을 쓴다.
export async function getAll() {
  const data = await chrome.storage.local.get(["jiraIssues", "tgTasks", "settings"]);
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

// read-modify-write를 직렬화해 동시 호출(예: draft 자동저장 debounce와 병합 적용)이
// 서로의 patch를 덮어쓰지 않게 한다.
let settingsChain = Promise.resolve();
export function setSettings(patch) {
  const run = settingsChain.then(async () => {
    const current = await getSettings();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ settings: next });
    return next;
  });
  settingsChain = run.catch(() => {});
  return run;
}

export async function clearAll() {
  await chrome.storage.local.clear();
}

// Jira/TG 데이터 삭제 시 syncQueue + manualChecked도 같이 정리(진행 기록만 남는 어색함 방지).
export async function clearJiraIssues() {
  await chrome.storage.local.remove(["jiraIssues", "jiraFetchCache", "syncQueue", "manualChecked", "apiSelectedKeys", "apiCreatedKeys"]);
}

export async function clearTgTasks() {
  await chrome.storage.local.remove(["tgTasks", "tgFetchCache", "syncQueue", "manualChecked", "apiSelectedKeys", "apiCreatedKeys"]);
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

function isBlank(v) {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0);
}

// trustEmpty: 이 수집 경로가 "완전한 스냅샷"인지. REST 직통은 요청한 fields를 API가 전부
// 채워주므로 빈 값도 진실(= 실제로 비어 있음)이라 그대로 반영해야 한다(레이블 삭제 등).
// 반대로 가로채기(GraphQL fieldSets에 온 필드만 채움)와 DOM 추출(화면에 보이는 컬럼만)은
// 빈 값이 "이번 경로가 못 가져옴"을 뜻하므로, 이전에 잘 수집해둔 값을 덮으면 안 된다.
// TG 쪽 upsertTgTasks의 start/end null 폴백과 같은 취지.
export async function upsertJiraIssues(incoming, opts = {}) {
  const { trustEmpty = false } = opts;
  const { jiraIssues = {} } = await chrome.storage.local.get("jiraIssues");
  const now = new Date().toISOString();
  let added = 0, updated = 0, skipped = 0;
  for (const issue of incoming) {
    if (!issue?.key) { skipped++; continue; }
    const { key, ...rest } = issue;
    const prev = jiraIssues[key];
    // 폴백을 hash 계산 '전에' 적용해야, 같은 경로를 두 번 눌러도 hash가 안정적이라
    // 불필요한 "갱신"으로 잡히지 않는다.
    if (prev && !trustEmpty) {
      for (const k of Object.keys(rest)) {
        if (isBlank(rest[k]) && !isBlank(prev[k])) rest[k] = prev[k];
      }
    }
    const hash = await hashOf(rest);
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

// read-modify-write를 직렬화한다. 여러 수집 버튼(가로채기/직통/DOM)이 동시에 눌려
// 같은 스냅샷을 읽고 한쪽 set이 다른 쪽 결과를 덮는 lost-update를 막는다.
let tgTasksChain = Promise.resolve();
// opts.prune: 이 수집이 '완전한 스냅샷'일 때만 true. 응답에 없는 task를 삭제된 것으로
//   보고 로컬에서도 지운다. TeamGantt에서 작업을 지웠는데 로컬에 남으면 비교 탭에서
//   계속 '매칭됨'으로 보여, 실제로는 누락인데 누락으로 잡히지 않는다.
//   ※ API 직통(프로젝트 전량)에서만 켠다. DOM 추출은 화면에 보이는 행만 오고,
//     가로채기는 오래된 캐시일 수 있어 켜면 멀쩡한 데이터를 지운다.
// opts.projectId: prune 범위. 다른 프로젝트에서 수집해둔 task를 건드리지 않게 한다.
export function upsertTgTasks(incoming, opts = {}) {
  const { prune = false, projectId = null } = opts;
  // incoming은 정규화된 [{id, rawTitle, jiraKey, start, end, progress, assignees}] 배열
  const run = tgTasksChain.then(async () => {
    const { tgTasks = {} } = await chrome.storage.local.get("tgTasks");
    const now = new Date().toISOString();
    let added = 0, updated = 0, skipped = 0, removed = 0;
    const removedJiraKeys = [];
    for (const task of incoming) {
      if (task?.id == null) { skipped++; continue; }
      const key = String(task.id);
      const { id, ...rest } = task;
      const prev = tgTasks[key];
      // DOM 수집은 보이는 행만 날짜가 그려져서 안 보이는 행의 start/end가 null로 들어옴.
      // 이걸 그대로 prev에 덮으면 이전에 API로 잘 수집해둔 날짜를 날려버리므로, null은 prev 값으로 폴백.
      if (prev) {
        if (rest.start == null && prev.start != null) rest.start = prev.start;
        if (rest.end   == null && prev.end   != null) rest.end   = prev.end;
      }
      const hash = await hashOf(rest);
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
    // 이번 응답에 없는 task 정리. 0건 수집(권한 오류·필터 실수 등)일 때 전부 지우는
    // 사고를 막으려고 incoming이 비면 건너뛴다.
    if (prune && incoming.length > 0 && projectId != null) {
      const seen = new Set(incoming.map((t) => String(t.id)));
      for (const [key, task] of Object.entries(tgTasks)) {
        if (String(task.projectId) !== String(projectId)) continue;  // 다른 프로젝트는 그대로
        if (seen.has(key)) continue;
        if (task.jiraKey) removedJiraKeys.push(task.jiraKey);
        delete tgTasks[key];
        removed++;
      }
    }
    await chrome.storage.local.set({ tgTasks });

    // TG에서 사라진 작업의 등록 이력도 지운다. 안 그러면 '이미 등록됨'으로 체크박스가
    // 잠긴 채라 다시 등록할 수 없다(TG에 없는데도).
    if (removedJiraKeys.length) await removeApiCreated(removedJiraKeys);

    return { added, updated, skipped, removed, total: Object.keys(tgTasks).length };
  });
  tgTasksChain = run.catch(() => {});
  return run;
}

// fetch 가로채기 응답(평탄화 배열 또는 { children: [...] })을 표준 task 객체로 변환.
// type=task만 통과 / resources[].type_id가 person ID (id는 resource-link 고유 ID).
export function normalizeTgFromFetch(payload, opts = {}) {
  const { prefixRegex, myTgId } = opts;
  const items = Array.isArray(payload) ? payload : (payload?.children ?? []);
  const re = prefixRegex ? new RegExp(prefixRegex) : null;
  const out = [];

  // 기본 children URL 응답은 group 노드 안에 task가 중첩된 트리일 수 있어 재귀로 내려간다.
  // 평탄화 응답(가로채기 캐시)에서는 task에 children이 없어 재귀가 no-op이라 기존 동작 불변.
  function walk(nodes) {
    for (const it of nodes) {
      if (it == null || typeof it !== "object") continue;
      const type = it.type ?? (it.is_group ? "group" : "task");
      if (type === "task") {
        const id = Number(it.id);
        if (Number.isFinite(id)) {
          const name = String(it.name ?? "");
          const jiraKey = re ? (name.match(re)?.[1] ?? null) : null;

          const resources = []
            .concat(it.user_resources ?? [], it.resources ?? [], it.assigned_resources ?? [])
            .filter(Boolean)
            .map((r) => ({
              personId: Number(r.type_id ?? r.id ?? 0),
              name: String(r.name ?? r.full_name ?? ""),
            }));

          // 내 task만 필터. myTgId가 주어졌으면, resources가 비었거나 매칭 안 되면 제외.
          const mine = !myTgId
            || (resources.length > 0 && resources.some((r) => String(r.personId) === String(myTgId)));
          if (mine) {
            out.push({
              id,
              rawTitle: name,
              jiraKey,
              start: it.start_date ?? null,
              end: it.end_date ?? null,
              progress: it.percent_complete ?? null,
              assignees: resources,
              projectId: it.project_id ?? null,
              // 이 task가 어느 그룹에 들어 있는지. 등록 대상 그룹을 고를 때
              // '내 작업이 이미 있는 그룹'을 위로 올려주는 데 쓴다.
              parentGroupId: it.parent_group_id ?? it.group_id ?? null,
            });
          }
        }
      }
      // group/subgroup이든 task든 children이 있으면 그 안으로 내려간다(중첩 트리 대비).
      if (Array.isArray(it.children)) walk(it.children);
    }
  }
  walk(items);
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

// Jira 공개 REST(/rest/api/3/search/jql 또는 /search) 응답 → 우리 표준 jira 객체 배열로 변환.
// GraphQL 가로채기(normalizeJiraFromFetch)와 결과 키를 동일하게 맞춘다(저장/렌더 호환).
// REST 응답 구조: { issues: [{ key, fields: { summary, status.name, assignee.displayName, ... } }] }
export function normalizeJiraFromRest(payload) {
  const issues = Array.isArray(payload?.issues) ? payload.issues : [];
  const out = [];
  for (const it of issues) {
    if (!it?.key) continue;
    const f = it.fields ?? {};
    out.push({
      key: it.key,
      summary: f.summary ?? "",
      status: f.status?.name ?? "",
      assignee: f.assignee?.displayName ?? "",
      reporter: f.reporter?.displayName ?? "",
      priority: f.priority?.name ?? "",
      resolution: f.resolution?.name ?? "",
      created: f.created ?? "",
      updated: f.updated ?? "",
      dueDate: f.duedate ?? "",
      labels: Array.isArray(f.labels) ? f.labels : [],
    });
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

// '그룹에 일괄 등록' 탭에서 체크한 등록 대상 키들. manualChecked(수동 처리 완료 표시)와
// 일부러 분리해 둔다 — 등록은 되돌리기 어려우므로, 다른 탭에서 눌러둔 체크가 실수로
// 등록 대상이 되는 일이 없어야 한다.
export async function getApiSelected() {
  const { apiSelectedKeys } = await chrome.storage.local.get("apiSelectedKeys");
  return new Set(apiSelectedKeys ?? []);
}

// 스냅샷을 통째로 저장하면 등록 루프(수 초~수십 초)가 도는 동안 사용자가 누른 체크가
// 사라진다. 항상 '최신 값을 읽어 변경'하고, 동시 호출은 직렬화한다.
let apiSelectedChain = Promise.resolve();
export function updateApiSelected(mutate) {
  const run = apiSelectedChain.then(async () => {
    const cur = await getApiSelected();
    mutate(cur);
    await chrome.storage.local.set({ apiSelectedKeys: [...cur] });
    return cur;
  });
  apiSelectedChain = run.catch(() => {});
  return run;
}

// API로 실제 생성한 키들. syncQueue.doneKeys와 반드시 분리해야 한다 —
// doneKeys는 [동기화 시작]이 매번 []로 초기화하는 '세션' 기록이라, 거기에 얹으면
// 동기화를 새로 시작하는 순간 등록 이력이 사라져 같은 이슈가 TeamGantt에 중복 생성된다.
export async function getApiCreated() {
  const { apiCreatedKeys } = await chrome.storage.local.get("apiCreatedKeys");
  return new Set(apiCreatedKeys ?? []);
}

// 등록 성공분은 루프 도중에도 즉시 커밋한다(패널이 닫혀도 이력이 남게).
let apiCreatedChain = Promise.resolve();
export function addApiCreated(keys) {
  const run = apiCreatedChain.then(async () => {
    const cur = await getApiCreated();
    for (const k of keys) cur.add(k);
    await chrome.storage.local.set({ apiCreatedKeys: [...cur] });
    return cur;
  });
  apiCreatedChain = run.catch(() => {});
  return run;
}

// 등록 이력 해제. TeamGantt에서 해당 작업을 지웠거나 다른 그룹에 다시 넣고 싶을 때
// 사용자가 명시적으로 되돌리는 경로다(= 다시 등록 대상이 된다).
export function removeApiCreated(keys) {
  const run = apiCreatedChain.then(async () => {
    const cur = await getApiCreated();
    for (const k of keys) cur.delete(k);
    await chrome.storage.local.set({ apiCreatedKeys: [...cur] });
    return cur;
  });
  apiCreatedChain = run.catch(() => {});
  return run;
}
