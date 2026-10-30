// 스토어 스크린샷용 가짜 chrome API와 가상 데이터.
// capture.mjs가 페이지 스크립트보다 먼저 실행되도록 Playwright addInitScript로 넣는다.
// window.__SHOT에 장면 이름이 들어 있고, 장면마다 처음 저장소 상태를 조금씩 바꾼다.
(() => {
  const SHOT = window.__SHOT ?? "jira";
  const HISTORY = SHOT === "epic-history" || SHOT === "epic-report";
  const ME = "김개발";

  const EPICS = {
    "DEV-1000": "[개발팀] 26.07 TASKS",
    "DEV-1001": "[개발팀] 26.08 TASKS",
    "DEV-1002": "[개발팀] 26.09 TASKS",
    "DEV-1003": "[개발팀] 26.10 TASKS",
    "DSN-300": "[디자인팀] 26.09 TASKS",
    "DEV-1010": "[개발팀] 하반기 잡무 모음",
  };

  // [키, 제목, 상태, 생성, 업데이트, 해결, 상위, 유형]
  const ISSUES = [
    ["DEV-1201", "월요일 아침 회의를 비동기 메모로 대체", "완료", "2026-07-01T10:12", "2026-07-08T17:40", "2026-07-08T17:40", null],
    ["DEV-1205", "탕비실 커피머신 원두 자동 주문 연동", "완료", "2026-07-03T09:30", "2026-07-15T16:05", "2026-07-15T16:05", "DEV-1000"],
    ["DEV-1209", "점심 메뉴 추천 알고리즘 고도화", "완료", "2026-07-10T11:00", "2026-07-28T18:22", "2026-07-28T18:22", null],
    ["DEV-1213", "슬랙 알림 폭탄 줄이기", "완료", "2026-07-29T14:10", "2026-08-04T15:31", "2026-08-04T15:31", null],
    ["DEV-1218", "금요일 오후 배포 금지 규칙 문서화", "완료", "2026-08-05T10:45", "2026-08-12T13:08", "2026-08-12T13:08", null],
    ["DEV-1220", "회의실 에어컨 온도 분쟁 중재안 작성", "완료", "2026-08-07T09:20", "2026-08-19T19:47", "2026-08-19T19:47", "DEV-1010"],
    ["DEV-1224", "퇴근 버튼 반응 속도 개선", "완료", "2026-08-18T16:00", "2026-08-27T18:59", "2026-08-27T18:59", null],
    ["DEV-1230", "AI 구독료 인하 협상 자료 준비", "완료", "2026-08-28T10:00", "2026-09-03T17:15", "2026-09-03T17:15", null],
    ["DEV-1233", "레거시 코드 발굴 조사 보고서", "완료", "2026-08-20T13:30", "2026-09-09T15:42", "2026-09-09T15:42", "DEV-1001"],
    ["DEV-1236", "버그를 기능으로 재분류하는 기준 마련", "완료", "2026-09-04T11:11", "2026-09-16T14:03", "2026-09-16T14:03", null],
    ["DEV-1238", "사내 고양이 사진 채널 자동 분류", "완료", "2026-09-08T10:05", "2026-09-22T16:48", "2026-09-22T16:48", "DEV-1010"],
    ["DEV-1240", "야근 식대 정산 화면 개편", "완료", "2026-09-10T09:40", "2026-09-25T18:31", "2026-09-25T18:31", null],
    ["DEV-1244", "주 4일제 시범 운영 계획 수립", "진행 중", "2026-09-14T10:20", "2026-09-29T10:55", "", null],
    ["DEV-1246", "회의록 자동 요약 봇 만들기", "진행 중", "2026-09-15T13:00", "2026-09-29T11:42", "", "DEV-1002"],
    ["DEV-1247", "회의록 요약 문구 다듬기", "해야 할 일", "2026-09-16T15:30", "2026-09-26T09:10", "", "DEV-1246", "subtask"],
    ["DEV-1250", "팀 회식 장소 투표 기능 추가", "진행 중", "2026-09-17T10:00", "2026-09-28T17:20", "", "DEV-1002"],
    ["DEV-1251", "키보드 소음 민원 대응 가이드", "해야 할 일", "2026-09-18T14:25", "2026-09-24T10:02", "", "DEV-1002"],
    ["DEV-1252", "탕비실 간식 재고 대시보드", "진행 중", "2026-09-18T16:40", "2026-09-28T15:06", "", "DEV-1002"],
    ["DEV-1253", "몰래 다크 모드 적용하기", "검토 중", "2026-09-21T09:15", "2026-09-28T19:33", "", "DEV-1002"],
    ["DEV-1254", "휴가 신청 결재 단계 줄이기", "해야 할 일", "2026-09-22T11:50", "2026-09-23T13:27", "", "DEV-1002"],
    ["DEV-1255", "콘솔 로그 대청소", "완료", "2026-09-07T10:30", "2026-09-24T17:58", "2026-09-24T17:58", "DEV-1002"],
    ["DEV-1256", "잠자는 TODO 주석 깨우기", "진행 중", "2026-09-23T10:10", "2026-09-27T14:44", "", "DEV-1002"],
    ["DEV-1257", "의자 바퀴 삐걱거림 원인 분석", "해야 할 일", "2026-09-24T15:00", "2026-09-25T11:18", "", "DEV-1002"],
    ["DEV-1258", "엘리베이터 대기 시간 측정", "검토 중", "2026-09-25T09:35", "2026-09-28T10:21", "", "DEV-1002"],
  ];
  const iso = (s) => (s ? `${s}:00.000+09:00` : "");
  const issueObjs = ISSUES.map(([key, summary, status, created, updated, resolved, parent, type]) => ({
    key, summary, status, created: iso(created), updated: iso(updated), resolved: iso(resolved), type: type ?? "task",
  }));
  // Jira 쪽 지금 상위다.
  // 쓰기 요청을 받으면 바꾼다.
  const parentOf = new Map(ISSUES.map((r) => [r[0], r[6]]));
  const summaryOf = (key) => EPICS[key] ?? issueObjs.find((i) => i.key === key)?.summary ?? "";

  // ── 처음 저장소 ─────────────────────────────
  const jiraIssues = {};
  for (const it of issueObjs) {
    jiraIssues[it.key] = {
      key: it.key, summary: it.summary, status: it.status, assignee: ME, reporter: "이기획",
      priority: "Medium", resolution: it.resolved ? "완료" : "", created: it.created, updated: it.updated,
      dueDate: "", labels: [], hash: "seed", collectedAt: "2026-09-29T05:20:00.000Z",
    };
  }

  // TeamGantt에 이미 있는 작업
  const IN_TG = ["DEV-1201", "DEV-1205", "DEV-1209", "DEV-1213", "DEV-1218", "DEV-1220", "DEV-1224",
    "DEV-1230", "DEV-1233", "DEV-1236", "DEV-1238", "DEV-1246", "DEV-1255"];
  const tgTasks = {};
  let tid = 880100;
  for (const key of IN_TG) {
    const it = issueObjs.find((i) => i.key === key);
    const id = tid++;
    tgTasks[id] = {
      id, rawTitle: `[${key}] ${it.summary}`, jiraKey: key,
      start: it.created.slice(0, 10), end: (it.resolved || "2026-10-02").slice(0, 10),
      progress: it.resolved ? 100 : 60, assignees: [{ personId: 1001, name: ME }],
      projectId: 2001, parentGroupId: 502, source: "api", hash: "seed", collectedAt: "2026-09-29T05:21:00.000Z",
    };
  }
  tgTasks[880200] = {
    id: 880200, rawTitle: "[DEV-1199] 상반기 회고 발표 자료", jiraKey: "DEV-1199", start: "2026-06-22", end: "2026-06-30",
    progress: 100, assignees: [{ personId: 1001, name: ME }], projectId: 2001, parentGroupId: 502, source: "api",
  };
  tgTasks[880201] = {
    id: 880201, rawTitle: "팀 워크숍 준비물 챙기기", jiraKey: null, start: "2026-09-21", end: "2026-09-30",
    progress: 30, assignees: [{ personId: 1001, name: ME }], projectId: 2001, parentGroupId: 502, source: "api",
  };

  const settings = {
    jiraDomain: "test.atlassian.net",
    tgMyId: "1001",
    tgProjectId: "2001",
    tgPeople: [{ id: 1001, name: "김개발" }, { id: 1002, name: "이기획" }, { id: 1003, name: "박디자인" }],
    tgProjects: [{ id: 2001, name: "2026 사내 생산성 개선" }, { id: 2002, name: "2026 탕비실 혁신" }],
    compareMode: "api",
    favoriteGroupIds: [502],
    tgCreateGroupId: 502,
    epicTitleFormat: "[개발팀] {월} TASKS",
    reportSource: "jira",
    rangeUnit: SHOT === "jira" ? "year" : "month",
    activeTab: { compare: "compare", "epic-link": "epic", "epic-history": "epic", "epic-report": "epic", tg: "tg", report: "report" }[SHOT] ?? "jira",
    epicMode: HISTORY ? "history" : "link",
  };

  const store = {
    settings, jiraIssues, tgTasks,
    apiSelectedKeys: ["DEV-1250", "DEV-1252", "DEV-1253", "DEV-1256"],
    apiCreatedKeys: ["DEV-1240"],
    manualChecked: ["DEV-1247"],
  };

  // 변경 기록 장면은 연결과 옮기기를 한 번씩 한 뒤 한 건을 취소한 상태로 시작한다.
  if (HISTORY) {
    const item = (key, to, revertedAt) => {
      const from = parentOf.get(key);
      const it = { key, summary: summaryOf(key), from, fromSummary: from ? summaryOf(from) : "", to, toSummary: summaryOf(to) };
      if (revertedAt) it.revertedAt = revertedAt;
      return it;
    };
    const moveRun = {
      id: "1790660000000", at: "2026-09-29T14:31:10.000+09:00", kind: "move",
      items: [item("DEV-1233", "DEV-1002"), item("DEV-1238", "DEV-1002", "2026-09-29T14:40:05.000+09:00")],
    };
    const linkRun = {
      id: "1790660300000", at: "2026-09-29T14:36:42.000+09:00", kind: "link",
      items: [
        item("DEV-1201", "DEV-1000"), item("DEV-1209", "DEV-1000"),
        item("DEV-1213", "DEV-1001"), item("DEV-1218", "DEV-1001"), item("DEV-1224", "DEV-1001"),
        item("DEV-1230", "DEV-1002"),
        item("DEV-1236", "DEV-1002"), item("DEV-1240", "DEV-1002"), item("DEV-1244", "DEV-1002"),
      ],
    };
    store.epicRunIds = [moveRun.id, linkRun.id];
    store[`epicRun:${moveRun.id}`] = moveRun;
    store[`epicRun:${linkRun.id}`] = linkRun;
  }

  // ── chrome API 대역 ─────────────────────────────
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const local = {
    async get(keys) {
      if (keys == null) return clone(store);
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in store) out[k] = clone(store[k]);
      if (keys && typeof keys === "object" && !Array.isArray(keys)) {
        for (const [k, v] of Object.entries(keys)) if (!(k in out)) out[k] = v;
      }
      return out;
    },
    async set(obj) { Object.assign(store, clone(obj)); },
    async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
    async clear() { for (const k of Object.keys(store)) delete store[k]; },
  };

  const TABS = [
    { id: 11, url: "https://test.atlassian.net/issues/?jql=assignee%20%3D%20currentUser()", active: true },
    { id: 22, url: "https://app.teamgantt.com/projects/list?companyResourceIds=1001&ids=2001", active: false },
  ];
  const glob = (pattern, url) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(url);

  function restIssue(it, fields) {
    const f = {};
    const parent = parentOf.get(it.key);
    if (fields.includes("summary")) f.summary = it.summary;
    if (fields.includes("status")) f.status = { name: it.status };
    if (fields.includes("issuetype")) f.issuetype = { subtask: it.type === "subtask", hierarchyLevel: it.type === "subtask" ? -1 : 0 };
    if (fields.includes("parent")) f.parent = parent ? { key: parent, fields: { summary: summaryOf(parent) } } : null;
    if (fields.includes("resolutiondate")) f.resolutiondate = it.resolved ? it.resolved.replace(":00.000+09:00", ":00.000+0900") : null;
    return { key: it.key, fields: f };
  }

  function collectRest(msg) {
    const fields = msg.fields ?? ["summary", "status", "assignee"];
    const jql = String(msg.jql ?? "");
    let issues;
    if (/issuetype\s*=\s*Epic/i.test(jql)) {
      issues = Object.entries(EPICS).filter(([, s]) => s.includes("TASKS")).map(([key, summary]) => ({ key, fields: { summary } }));
    } else if (/^\s*key\s*(in|=)/i.test(jql)) {
      const keys = jql.match(/[A-Z]+-\d+/g) ?? [];
      issues = issueObjs.filter((it) => keys.includes(it.key)).map((it) => restIssue(it, fields));
    } else {
      issues = issueObjs.map((it) => restIssue(it, fields));
    }
    return { ok: true, endpoint: "POST /search/jql", data: { issues, pages: 1, truncated: false, fields } };
  }

  const noopEvent = { addListener() {}, removeListener() {} };
  window.chrome = {
    storage: { local, onChanged: noopEvent },
    runtime: { onMessage: noopEvent, sendMessage: async () => ({}), getURL: (p) => p, id: "shots" },
    commands: { getAll: async () => [{ name: "inject-next-task", shortcut: "⇧⌘X" }] },
    downloads: { download: async () => 1 },
    tabs: {
      onActivated: noopEvent,
      onUpdated: noopEvent,
      async query(q = {}) {
        return TABS.filter((t) => (!q.url || glob(q.url, t.url)) && (q.active == null || t.active === q.active)).map(clone);
      },
      async get(id) { return clone(TABS.find((t) => t.id === id)); },
      async create() { return { id: 99 }; },
      async reload() {},
      async sendMessage(tabId, msg) {
        if (msg?.type === "COLLECT_JIRA_REST") return collectRest(msg);
        if (msg?.type === "GET_TG_TOKEN") return { auth: "Bearer shots" };
        return { ok: true };
      },
    },
    scripting: {
      async executeScript({ args }) {
        const a = args?.[0] ?? {};
        await new Promise((r) => setTimeout(r, 40));
        parentOf.set(a.key, a.parentKey ?? null);
        return [{ result: { ok: true, status: 204 } }];
      },
    },
  };

  window.confirm = () => true;
  window.alert = () => {};

  // TeamGantt 그룹 목록
  const GROUPS = [
    { id: 500, name: "2026 하반기" },
    { id: 501, name: "9월", parent_group_id: 500 },
    { id: 502, name: "개발", parent_group_id: 501 },
    { id: 503, name: "기획", parent_group_id: 501 },
    { id: 504, name: "10월", parent_group_id: 500 },
    { id: 505, name: "개발", parent_group_id: 504 },
  ];
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://api.teamgantt.com/v1/groups")) {
      return new Response(JSON.stringify(GROUPS), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith("https://api.teamgantt.com/")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(input, init);
  };
})();
