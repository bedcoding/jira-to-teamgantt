// 월별 에픽 연결의 판단 로직.
// chrome API를 쓰지 않아서 node로 바로 검증할 수 있다.

// 연결 대상 이슈를 조회할 때 요청하는 필드.
// 상위(parent)와 이슈 유형은 연결할 수 있는지를, 해결일은 어느 달 에픽에 넣을지를 정한다.
export const EPIC_LINK_FIELDS = ["summary", "status", "issuetype", "parent", "resolutiondate"];

// 에픽 제목의 연월 표기.
// "26.09", "2026.09", "2026-09", "26/09", "26년 9월"을 읽는다.
// 앞뒤에 숫자가 더 붙은 경우(버전 번호 1.2.3 등)는 연월로 보지 않는다.
const MONTH_PATTERNS = [
  /(?<!\d)(\d{4}|\d{2})\s*년\s*(\d{1,2})\s*월/,
  /(?<!\d)(\d{4}|\d{2})[./-](\d{1,2})(?!\d)/,
];

export function parseEpicMonth(title) {
  const s = String(title ?? "");
  for (const re of MONTH_PATTERNS) {
    const m = s.match(re);
    if (!m) continue;
    const year = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) continue;
    return { month: `${year}-${String(month).padStart(2, "0")}`, index: m.index, length: m[0].length };
  }
  return null;
}

// 제목에서 연월 부분을 {월}로 바꾼 형식.
// "[팀] 26.09 TASKS"와 "[팀] 26.10 TASKS"는 같은 형식이고 "[다른팀] 26.09 TASK"는 다른 형식이다.
// 한 달의 에픽을 고르면 같은 형식의 에픽으로 나머지 달을 채우는 데 쓴다.
export function epicTitleFormat(title) {
  const p = parseEpicMonth(title);
  if (!p) return null;
  const s = String(title);
  return `${s.slice(0, p.index)}{월}${s.slice(p.index + p.length)}`.replace(/\s+/g, " ").trim();
}

// 에픽 검색 결과(REST 이슈 배열)를 월별 후보로 묶는다.
// 제목에서 연월을 읽지 못한 에픽은 버린다.
export function groupEpicsByMonth(restIssues) {
  const byMonth = {};
  for (const it of restIssues ?? []) {
    const summary = it?.fields?.summary ?? "";
    const parsed = parseEpicMonth(summary);
    if (!it?.key || !parsed) continue;
    (byMonth[parsed.month] ??= []).push({ key: it.key, summary, format: epicTitleFormat(summary) });
  }
  return byMonth;
}

// 그 달에 미리 골라 둘 에픽.
// 저장해 둔 형식과 같은 후보만 고르고, 후보가 하나뿐이어도 형식이 다르면 고르지 않는다.
// 다른 팀의 월별 에픽이 검색에 섞여 들어오는 일이 흔해서, 확실하지 않으면 비워 두고 사용자에게 맡긴다.
export function pickDefaultEpic(candidates, format) {
  if (!format || !candidates?.length) return null;
  return candidates.find((c) => c.format === format)?.key ?? null;
}

// REST 응답 이슈를 연결 판단에 필요한 모양으로 줄인다.
export function normalizeLinkTarget(it) {
  const f = it?.fields ?? {};
  return {
    key: it?.key ?? "",
    summary: f.summary ?? "",
    status: f.status?.name ?? "",
    resolved: f.resolutiondate ?? "",
    isSubtask: f.issuetype?.subtask === true,
    isEpic: (f.issuetype?.hierarchyLevel ?? 0) >= 1,
    parentKey: f.parent?.key ?? null,
    parentSummary: f.parent?.fields?.summary ?? "",
  };
}

// 이 이슈를 넣을 달.
// Jira는 날짜에 사용자 타임존 오프셋을 붙여 준다(예: +0900).
// 그래서 문자열 앞 7자가 곧 사용자 기준 연월이다.
// Date로 바꾸면 브라우저 타임존으로 다시 계산돼서 월말 자정 근처 이슈가 옆 달로 넘어갈 수 있다.
// 해결일이 없으면(진행 중) 이번 달로 본다.
export function issueMonth(resolved, now = new Date()) {
  if (/^\d{4}-\d{2}/.test(resolved ?? "")) return resolved.slice(0, 7);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export const KIND = {
  LINK: "link",           // 상위 없음
  MOVE: "move",           // 다른 에픽 아래에 있음
  ALREADY: "already",     // 이미 그 달 에픽 아래에 있음
  SUBTASK: "subtask",     // 하위 작업은 상위가 일반 이슈라 에픽 아래로 갈 수 없다
  EPIC: "epic",           // 에픽은 다른 에픽 아래로 갈 수 없다
  NO_EPIC: "no-epic",     // 그 달 에픽을 아직 고르지 않았다
  MONTH_OFF: "month-off", // 그 달은 연결하지 않기로 골랐다
};

// epicKey는 그 달에 고른 에픽 키다.
// 빈 문자열은 그 달을 연결하지 않기로 고른 것이고, null은 아직 고르지 않은 것이다.
export function classify(issue, epicKey) {
  if (issue.isSubtask) return KIND.SUBTASK;
  if (issue.isEpic) return KIND.EPIC;
  if (epicKey === "") return KIND.MONTH_OFF;
  if (issue.parentKey && issue.parentKey === epicKey) return KIND.ALREADY;
  if (!epicKey) return KIND.NO_EPIC;
  if (issue.parentKey) return KIND.MOVE;
  return KIND.LINK;
}

export function isSelectable(kind) {
  return kind === KIND.LINK || kind === KIND.MOVE;
}

// 이슈마다 넣을 달, 에픽, 분류를 붙인다.
// epicByMonth는 { "2026-09": "ABC-123" } 모양이다.
// 빈 문자열은 그 달을 연결하지 않기로 고른 것이고, 빠져 있거나 null이면 아직 고르지 않은 것이다.
export function buildPlan(issues, epicByMonth, now = new Date()) {
  return issues.map((it) => {
    const month = issueMonth(it.resolved, now);
    const picked = epicByMonth?.[month] ?? null;
    return { ...it, month, epicKey: picked || null, kind: classify(it, picked) };
  });
}

// 화면에서 어느 영역에 보일지.
// link는 상위가 없는 이슈, move는 다른 에픽 아래에 있는 이슈, skip은 손댈 필요가 없거나 손댈 수 없는 이슈다.
// 영역은 지금 상위가 있는지로 나눈다.
// 그 달 에픽을 아직 고르지 않았으면 상위 유무에 따라 link나 move에 남고, 고르면 바로 연결할 수 있게 된다.
// 연결하지 않기로 고른 달의 이슈는 skip으로 보낸다.
export function sectionOf(row) {
  const skip = [KIND.SUBTASK, KIND.EPIC, KIND.ALREADY, KIND.MONTH_OFF];
  if (skip.includes(row.kind)) return "skip";
  return row.parentKey ? "move" : "link";
}

// 변경 기록을 Jira의 지금 상태와 맞춘다.
// 이슈마다 가장 나중 기록 하나만 본다.
// 같은 이슈를 여러 번 바꿨으면 앞선 기록은 이미 뒤 기록에 덮였기 때문이다.
// 취소했다고 적었는데 아직 그 에픽 아래에 있으면 적용 중으로 되돌린다(취소가 Jira에 반영되지 않은 경우).
// 적용 중인데 지금 상위가 다르면 사유만 적고, 맞으면 예전 사유를 지운다(null).
// 조회되지 않은 이슈는 건드리지 않는다.
// runs는 먼저 실행한 묶음이 앞에 오는 배열이고, currentParent는 Map<키, 지금 상위 키 또는 null>이다.
// 돌려주는 값은 Map<묶음 id, { restore: [키], notes: Map<키, 사유 또는 null> }>다.
export function reconcileRuns(runs, currentParent) {
  const latest = new Map();
  for (const run of runs ?? []) for (const it of run.items ?? []) latest.set(it.key, { runId: run.id, it });
  const out = new Map();
  const slot = (id) => {
    if (!out.has(id)) out.set(id, { restore: [], notes: new Map() });
    return out.get(id);
  };
  for (const [key, { runId, it }] of latest) {
    if (!currentParent.has(key)) continue;
    const now = currentParent.get(key);
    if (it.revertedAt) {
      if (now !== it.to) continue;
      const s = slot(runId);
      s.restore.push(key);
      s.notes.set(key, "취소했지만 Jira에 반영되지 않아서 적용 중으로 되돌렸습니다");
    } else if (now !== it.to) {
      slot(runId).notes.set(key, now ? `Jira에서 상위가 바뀌었습니다 (지금 상위 ${now})` : "Jira에서 상위가 비워졌습니다");
    } else if (it.note) {
      slot(runId).notes.set(key, null);
    }
  }
  return out;
}

// 변경 기록 여러 묶음을 이슈 하나당 한 건으로 합친다.
// 같은 이슈를 여러 번 바꿨으면 처음 상위(from)와 마지막 상위(to)만 남겨서, 보고 건수가 부풀지 않게 한다.
// 취소한 건은 빼고, 돌고 돌아 처음 상위로 돌아온 건도 바뀐 게 없으니 뺀다.
// runs는 먼저 실행한 묶음이 앞에 오는 배열이다.
export function mergeChanges(runs) {
  const byKey = new Map();
  for (const run of runs ?? []) {
    for (const it of run.items ?? []) {
      if (it.revertedAt) continue;
      const prev = byKey.get(it.key);
      byKey.set(it.key, prev ? { ...it, from: prev.from, fromSummary: prev.fromSummary } : { ...it });
    }
  }
  return [...byKey.values()].filter((it) => it.from !== it.to);
}

// 정리 글에 쓸 에픽 이름.
// 제목에서 읽은 달로 "1월 에픽"처럼 줄여 쓰고, 여러 해가 섞이면 "26년 1월 에픽"처럼 해까지 쓴다.
// 제목에 연월이 없거나 같은 달 에픽이 둘 이상이면 헷갈리지 않게 제목을 그대로 쓴다.
// groups는 [{ key, summary }]이고, 달 순서(연월 없는 에픽은 맨 뒤)로 정렬한 사본에 label과 month를 붙여 돌려준다.
function labelEpics(groups) {
  const rows = groups.map((g) => ({ ...g, month: parseEpicMonth(g.summary)?.month ?? null }));
  const years = new Set(rows.filter((r) => r.month).map((r) => r.month.slice(0, 4)));
  const perMonth = new Map();
  for (const r of rows) if (r.month) perMonth.set(r.month, (perMonth.get(r.month) ?? 0) + 1);
  for (const r of rows) {
    if (!r.month || perMonth.get(r.month) > 1) {
      r.label = r.summary || r.key;
      continue;
    }
    const month = Number(r.month.slice(5));
    r.label = years.size > 1 ? `${r.month.slice(2, 4)}년 ${month}월 에픽` : `${month}월 에픽`;
  }
  return rows.sort((a, b) => (a.month ?? "9999").localeCompare(b.month ?? "9999") || a.label.localeCompare(b.label));
}

// 에픽 키별로 항목을 묶는다.
function groupByEpic(items, keyOf, summaryOf) {
  const map = new Map();
  for (const it of items) {
    const key = keyOf(it);
    if (!map.has(key)) map.set(key, { key, summary: summaryOf(it) ?? "", items: [] });
    map.get(key).items.push(it);
  }
  return [...map.values()];
}

// 넣은 내역 정리 글.
// 들어간 에픽별로 "* 1월 에픽: 19건 추가"처럼 세고, 다른 에픽에서 옮겨 온 건은 아래에 따로 센다.
export function formatEpicReport(items) {
  if (!items?.length) return "";
  const lines = labelEpics(groupByEpic(items, (it) => it.to, (it) => it.toSummary))
    .map((g) => `* ${g.label}: ${g.items.length}건 추가`);
  lines.push(`합계 ${items.length}건`);
  const moved = groupByEpic(items.filter((it) => it.from), (it) => it.from, (it) => it.fromSummary);
  if (moved.length) {
    lines.push("", "다른 에픽에서 옮겨 온 이슈");
    for (const m of moved.sort((a, b) => b.items.length - a.items.length)) {
      lines.push(`* ${m.summary || m.key}에서 ${m.items.length}건`);
    }
  }
  return lines.join("\n");
}

// 지금 취소된 상태인 변경을 이슈 하나당 한 건으로 모은다.
// 같은 이슈의 가장 나중 기록이 취소함일 때만 넣는다.
// 취소한 뒤 다시 넣었으면 지금은 넣은 상태라서 뺀다.
// runs는 먼저 실행한 묶음이 앞에 오는 배열이다.
export function latestReverted(runs) {
  const latest = new Map();
  for (const run of runs ?? []) for (const it of run.items ?? []) latest.set(it.key, it);
  return [...latest.values()].filter((it) => it.revertedAt);
}

// 취소 내역 정리 글.
// 위에는 에픽별 취소 건수를, 아래에는 무엇을 취소했는지 이슈 목록을 적는다.
// 다른 에픽에서 옮겼다가 취소한 건은 돌아간 원래 상위를 옆에 적는다.
export function formatRevertReport(items) {
  if (!items?.length) return "";
  const groups = labelEpics(groupByEpic(items, (it) => it.to, (it) => it.toSummary));
  const lines = groups.map((g) => `* ${g.label}: ${g.items.length}건 취소`);
  lines.push(`합계 ${items.length}건 취소`, "", "취소한 이슈");
  for (const g of groups) {
    lines.push(`* ${g.label}`);
    const sorted = [...g.items].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    for (const it of sorted) {
      const back = it.from ? ` (원래 상위 ${it.fromSummary || it.from})` : "";
      lines.push(`  - ${it.key} ${it.summary ?? ""}${back}`.trimEnd());
    }
  }
  return lines.join("\n");
}
