import {
  getAll, getSettings, setSettings, upsertJiraIssues, defaultJql, clearJiraIssues,
  removeJiraIssues, restoreJiraIssues,
  getJiraFetchCache, normalizeJiraFromFetch, normalizeJiraFromRest,
} from "../lib/storage.js";
import { checkJiraUrl } from "../lib/selectors.js";
import { showSnackbar } from "./snackbar.js";
import { renderPager } from "./pager.js";

let jiraPage = 1;

function $(id) { return document.getElementById(id); }

function activeTab() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then((arr) => arr[0]);
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d) { // 월요일 시작
  const x = new Date(d);
  const dow = x.getDay(); // 0=일,1=월,...
  const diff = (dow === 0 ? -6 : 1 - dow);
  return addDays(x, diff);
}
function endOfWeek(d)   { return addDays(startOfWeek(d), 7); }
function startOfMonth(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d)  { return new Date(d.getFullYear(), d.getMonth() + 1, 1); }
function startOfYear(d) { return new Date(d.getFullYear(), 0, 1); }
function endOfYear(d)   { return new Date(d.getFullYear() + 1, 0, 1); }

function presetRange(name) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  switch (name) {
    case "today":       return { start: fmtDate(now), end: fmtDate(addDays(now, 1)) };
    case "yesterday":   return { start: fmtDate(addDays(now, -1)), end: fmtDate(now) };
    case "tomorrow":    return { start: fmtDate(addDays(now, 1)), end: fmtDate(addDays(now, 2)) };
    case "thisWeek":    return { start: fmtDate(startOfWeek(now)), end: fmtDate(endOfWeek(now)) };
    case "lastWeek":    return { start: fmtDate(addDays(startOfWeek(now), -7)), end: fmtDate(startOfWeek(now)) };
    case "nextWeek":    return { start: fmtDate(endOfWeek(now)), end: fmtDate(addDays(endOfWeek(now), 7)) };
    case "prevMonth":   return { start: fmtDate(new Date(y, m - 1, 1)), end: fmtDate(new Date(y, m, 1)) };
    case "thisMonth":   return { start: fmtDate(startOfMonth(now)), end: fmtDate(endOfMonth(now)) };
    case "nextMonth":   return { start: fmtDate(new Date(y, m + 1, 1)), end: fmtDate(new Date(y, m + 2, 1)) };
    case "prevQuarter": {
      const qs = Math.floor(m / 3) * 3 - 3;
      return { start: fmtDate(new Date(y, qs, 1)), end: fmtDate(new Date(y, qs + 3, 1)) };
    }
    case "thisQuarter": {
      const qs = Math.floor(m / 3) * 3;
      return { start: fmtDate(new Date(y, qs, 1)), end: fmtDate(new Date(y, qs + 3, 1)) };
    }
    case "nextQuarter": {
      const qs = Math.floor(m / 3) * 3 + 3;
      return { start: fmtDate(new Date(y, qs, 1)), end: fmtDate(new Date(y, qs + 3, 1)) };
    }
    case "lastYear":    return { start: fmtDate(new Date(y - 1, 0, 1)), end: fmtDate(new Date(y, 0, 1)) };
    case "thisYear":    return { start: fmtDate(startOfYear(now)), end: fmtDate(endOfYear(now)) };
    case "nextYear":    return { start: fmtDate(new Date(y + 1, 0, 1)), end: fmtDate(new Date(y + 2, 0, 1)) };
  }
  return null;
}

const UNIT_MAP = {
  day:     { prev: { name: "yesterday",   label: "‹ 어제" },   this: { name: "today",       label: "오늘" },     next: { name: "tomorrow",    label: "내일 ›" } },
  week:    { prev: { name: "lastWeek",    label: "‹ 지난주" }, this: { name: "thisWeek",    label: "이번주" },   next: { name: "nextWeek",    label: "다음주 ›" } },
  month:   { prev: { name: "prevMonth",   label: "‹ 저번달" }, this: { name: "thisMonth",   label: "이번달" },   next: { name: "nextMonth",   label: "다음달 ›" } },
  quarter: { prev: { name: "prevQuarter", label: "‹ 지난분기" }, this: { name: "thisQuarter", label: "이번분기" }, next: { name: "nextQuarter", label: "다음분기 ›" } },
  year:    { prev: { name: "lastYear",    label: "‹ 작년" },   this: { name: "thisYear",    label: "올해" },     next: { name: "nextYear",    label: "내년 ›" } },
};

function applyUnitLabels(unit, scopeEl) {
  const map = UNIT_MAP[unit] ?? UNIT_MAP.month;
  for (const step of ["prev", "this", "next"]) {
    const btn = scopeEl.querySelector(`[data-step="${step}"]`);
    if (!btn) continue;
    btn.textContent = map[step].label;
    btn.dataset.range = map[step].name;
  }
}

// 현재 [start, end)를 단위만큼 시프트. delta가 -1이면 한 칸 과거, +1이면 한 칸 미래.
function shiftRange(unit, start, end, delta) {
  if (!start || !end) return null;
  const s = new Date(start), e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  switch (unit) {
    case "day":
      s.setDate(s.getDate() + delta);
      e.setDate(e.getDate() + delta);
      break;
    case "week":
      s.setDate(s.getDate() + 7 * delta);
      e.setDate(e.getDate() + 7 * delta);
      break;
    case "month":
      s.setMonth(s.getMonth() + delta);
      e.setMonth(e.getMonth() + delta);
      break;
    case "quarter":
      s.setMonth(s.getMonth() + 3 * delta);
      e.setMonth(e.getMonth() + 3 * delta);
      break;
    case "year":
      s.setFullYear(s.getFullYear() + delta);
      e.setFullYear(e.getFullYear() + delta);
      break;
  }
  return { start: fmtDate(s), end: fmtDate(e) };
}

// JQL 안의 updated >= "..." AND updated < "..." 부분만 교체.
function injectDates(jql, start, end) {
  let next = jql ?? "";
  const reGe = /(updated\s*>=\s*)"([^"]*)"/i;
  const reLt = /(updated\s*<\s*)"([^"]*)"/i;
  if (reGe.test(next)) next = next.replace(reGe, `$1"${start}"`);
  if (reLt.test(next)) next = next.replace(reLt, `$1"${end}"`);
  return next;
}

function extractDatesFromJql(jql) {
  const m1 = (jql ?? "").match(/updated\s*>=\s*"([0-9-]+)"/i);
  const m2 = (jql ?? "").match(/updated\s*<\s*"([0-9-]+)"/i);
  return { start: m1?.[1] ?? "", end: m2?.[1] ?? "" };
}

function buildJiraSearchUrl(s) {
  if (!s.jiraDomain || !s.jqlTemplate) return "";
  return `https://${s.jiraDomain}/issues?jql=${s.jqlTemplate}`;
}

async function handleOpenJira() {
  const s = await getSettings();
  const url = buildJiraSearchUrl(s);
  if (!url) { showSnackbar("경로와 JQL을 먼저 입력하세요.", { kind: "error" }); return; }
  chrome.tabs.create({ url });
}

// Jira GraphQL fetch 캐시에서 모든 page 응답을 합쳐 normalize → upsert.
async function handleCollectJiraFetch() {
  let cache = await getJiraFetchCache();
  let pages = cache.pages ?? [];
  if (pages.length === 0) {
    // 사이드 패널이 열려 있어도 chrome.tabs.query 결과 첫 번째가 비활성 탭일 수 있어
    // 현재 활성 Jira 탭을 우선 잡고, 없을 때만 임의의 Jira 탭으로 폴백.
    let [tab] = await chrome.tabs.query({ url: "https://*.atlassian.net/*", active: true, currentWindow: true });
    if (!tab) {
      [tab] = await chrome.tabs.query({ url: "https://*.atlassian.net/*" });
    }
    if (!tab) {
      showSnackbar("Jira 탭이 없습니다. 이슈 목록 페이지를 열어주세요.", {
        kind: "error",
        actionLabel: "Jira 열기",
        onAction: handleOpenJira,
        duration: 8000,
      });
      return;
    }
    const ok = confirm(
      "Jira 페이지 첫 진입은 API로 데이터를 노출하지 않아 수집이 불가능합니다.\n\n"
      + "Jira 페이지의 [검색] 버튼을 자동으로 클릭해 재조회할까요? (JQL 편집 중이면 그 변경사항이 발사됩니다.)"
    );
    if (!ok) return;
    let trigResp;
    try {
      trigResp = await chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_JIRA_SEARCH" });
    } catch (e) {
      console.warn("[Jira→TeamGantt] TRIGGER_JIRA_SEARCH sendMessage 실패:", e, "tab:", tab.url);
      showSnackbar(
        "Jira 페이지의 확장 스크립트가 깨어있지 않습니다. Jira 탭을 한 번 새로고침(F5) 후 다시 시도해주세요.",
        { kind: "error", duration: 8000 }
      );
      return;
    }
    if (!trigResp?.ok) {
      showSnackbar(`[검색] 버튼 자동 클릭 실패: ${trigResp?.error ?? "알 수 없는 에러"}`, { kind: "error", duration: 8000 });
      return;
    }
    // 검색 결과 GraphQL이 들어오는지 폴링. 네트워크가 느린 환경에서 1.5초로는 부족할 수 있어 최대 5초.
    const start = Date.now();
    while (Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 250));
      cache = await getJiraFetchCache();
      pages = cache.pages ?? [];
      if (pages.length > 0) break;
    }
    if (pages.length === 0) {
      showSnackbar(
        "[검색] 버튼은 눌렸지만 5초 안에 GraphQL 응답이 잡히지 않았습니다. 페이지를 새로고침 후 다시 시도해주세요.",
        { kind: "error", duration: 8000 }
      );
      return;
    }
  }
  // 모든 page의 issues를 합치되 key 중복 제거.
  const seen = new Set();
  const issues = [];
  let newest = 0;
  for (const p of pages) {
    if (p.at > newest) newest = p.at;
    const normalized = normalizeJiraFromFetch(p.data);
    for (const it of normalized) {
      if (seen.has(it.key)) continue;
      seen.add(it.key);
      issues.push(it);
    }
  }
  if (issues.length === 0) {
    showSnackbar("정규화 0건: payload 구조가 예상과 다름.", { kind: "error", duration: 6000 });
    return;
  }
  const ageMin = Math.round((Date.now() - newest) / 60000);
  const result = await upsertJiraIssues(issues);
  showSnackbar(
    `신규 ${result.added} / 갱신 ${result.updated} / 동일 ${result.skipped} · 가로채기 ${pages.length}개 응답 (캡처 ${ageMin}분 전)`,
    { kind: "ok", duration: 5000 }
  );
  await renderJiraTable();
}

async function handleCollectJira() {
  const tab = await activeTab();
  const guard = checkJiraUrl(tab?.url);
  if (!guard.ok) {
    showSnackbar(`⚠️ ${guard.reason}`, {
      kind: "error", actionLabel: "Jira 열기", onAction: handleOpenJira, duration: 6000,
    });
    return;
  }
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_JIRA" });
  } catch (e) {
    showSnackbar("Jira 페이지와 연결이 끊어졌습니다. 페이지를 새로고침해주세요.", { kind: "error" });
    return;
  }
  if (!resp?.ok) { showSnackbar(`수집 실패: ${resp?.error ?? "unknown"}`, { kind: "error" }); return; }
  const { issues, visibleCount, totalText } = resp.data;
  if (issues.length === 0) {
    showSnackbar("이슈 0건: 페이지 로딩이 끝났는지 확인하세요.", { kind: "error" });
    return;
  }
  const result = await upsertJiraIssues(issues);
  showSnackbar(
    `신규 ${result.added} / 갱신 ${result.updated} / 동일 ${result.skipped} · DOM 화면 ${visibleCount}건${totalText ? ` (${totalText})` : ""}`,
    { kind: "ok", duration: 5000 }
  );
  await renderJiraTable();
}

// 실험: 동일 출처 REST 수집. atlassian.net 탭의 콘텐트 스크립트가 쿠키 세션으로
// /rest/api/3/search/jql 을 직접 호출 → 검색버튼 꼼수 없이, GraphQL 이름 변경에도 안 깨짐.
async function handleCollectJiraRest() {
  const s = await getSettings();
  if (!s.jqlTemplate) { showSnackbar("JQL을 먼저 입력하세요.", { kind: "error" }); return; }
  // REST는 동일 출처 콘텐트 스크립트에서만 쿠키가 실리므로, 아무 Jira 탭이나 열려 있으면 된다.
  let [tab] = await chrome.tabs.query({ url: "https://*.atlassian.net/*", active: true, currentWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ url: "https://*.atlassian.net/*" });
  if (!tab) {
    showSnackbar("Jira 탭이 없습니다. 아무 Jira 페이지나 열어주세요.", {
      kind: "error", actionLabel: "Jira 열기", onAction: handleOpenJira, duration: 8000,
    });
    return;
  }
  // 수집은 전량(cap 미지정 = 무제한, 브리지의 MAX_PAGES가 안전장치).
  // 화면 테이블의 [페이지당](jiraPageSize)은 표시 단위일 뿐이라 수집 상한으로 넘기지 않는다.
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_JIRA_REST", jql: s.jqlTemplate });
  } catch (e) {
    showSnackbar("Jira 페이지와 연결이 끊겼습니다. 그 탭을 새로고침(F5) 후 다시 시도해주세요.", { kind: "error", duration: 7000 });
    return;
  }
  if (!resp?.ok) {
    showSnackbar(`REST 수집 실패: ${resp?.error ?? "알 수 없음"}`, { kind: "error", duration: 8000 });
    return;
  }
  const issues = normalizeJiraFromRest(resp.data);
  if (issues.length === 0) {
    showSnackbar(`REST 응답 0건 (${resp.endpoint}). JQL이 빈 결과이거나 권한 문제일 수 있습니다.`, { kind: "error", duration: 7000 });
    return;
  }
  // REST 직통은 요청한 fields를 API가 전부 채워주는 완전한 스냅샷이라, 빈 값도 그대로 반영한다.
  const result = await upsertJiraIssues(issues, { trustEmpty: true });
  // 몇 페이지를 돌았는지는 남긴다 — 1페이지에서 끝났을 때 그게 전량인지 상한에 걸린 건지
  // 구분할 단서가 이것뿐이다.
  const { pages, truncated, stoppedBy } = resp.data;
  const pageInfo = Number.isFinite(pages) ? ` (${pages}p)` : "";
  // 정식 경로(POST /search/jql)는 조용히, 구형 GET으로 떨어졌을 때만 표시한다.
  const fallback = resp.endpoint?.startsWith("GET") ? " · GET 폴백" : "";

  // 사라진 이슈 정리. 잘린 응답(truncated)으로 정리하면 '아직 못 받은' 이슈가
  // '삭제된' 이슈로 오인돼 지워진다 — 전량을 받았을 때만 켠다.
  let pruned = [];
  if (!truncated) {
    const range = extractDatesFromJql(s.jqlTemplate);
    const stale = await findStaleIssues(issues, range);
    const ok = stale.length === 0 || stale.length <= PRUNE_CONFIRM_THRESHOLD || confirm(
      `JQL 범위(${range.start} ~ ${range.end}) 안에 있는데 이번 결과에 없는 이슈 ${stale.length}건을 목록에서 지울까요?\n\n`
      + stale.slice(0, 10).join(", ") + (stale.length > 10 ? ` … 외 ${stale.length - 10}건` : "")
      + `\n\nJQL의 날짜 외 조건(담당자, 프로젝트 등)을 바꿨다면 [취소]하세요.`
    );
    if (ok && stale.length) pruned = await removeJiraIssues(stale);
  }
  const pruneInfo = pruned.length ? ` / 정리 ${pruned.length}` : "";

  showSnackbar(
    `신규 ${result.added} / 갱신 ${result.updated} / 동일 ${result.skipped}${pruneInfo} · ${issues.length}건 수신${pageInfo}${fallback}`
      + (truncated ? ` ⚠ 전량 아님 (${stoppedBy ?? "중단됨"})` : ""),
    {
      kind: truncated ? "error" : "ok",
      duration: (truncated || pruned.length) ? 9000 : 5000,
      // 정리가 일어났으면 되돌릴 길을 같이 준다. 자동으로 지운 것이라 사용자가
      // 의도한 삭제가 아닐 수 있다.
      ...(pruned.length ? {
        actionLabel: "정리 되돌리기",
        onAction: async () => {
          await restoreJiraIssues(pruned);
          await renderJiraTable();
          showSnackbar(`정리한 ${pruned.length}건 되돌림.`, { kind: "ok" });
        },
      } : {}),
    }
  );
  await renderJiraTable();
}

// Jira 날짜 포맷(ISO / 한국어)을 "YYYY-MM-DD HH:mm"으로 통일.
function toReadableDate(s) {
  if (!s) return "";
  // ISO 8601
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${mo}-${dd} ${hh}:${mi}`;
  }
  // "2026년 4월 30일 오후 7:17" → 사람이 읽기엔 충분하니 그대로 두되 정렬 키를 위해 ISO 화 시도.
  const m = s.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*(오전|오후)\s*(\d{1,2})\s*:\s*(\d{1,2}))?/);
  if (m) {
    const [, y, mo, dd, ampm, hRaw, mi] = m;
    let h = hRaw ? Number(hRaw) : 0;
    if (ampm === "오후" && h < 12) h += 12;
    if (ampm === "오전" && h === 12) h = 0;
    return `${y}-${mo.padStart(2, "0")}-${dd.padStart(2, "0")}${hRaw ? ` ${String(h).padStart(2, "0")}:${(mi ?? "0").padStart(2, "0")}` : ""}`;
  }
  return s;
}

// 정상적으로 사라지는 이슈는 한두 건이다. 수십 건이 잡히면 JQL의 날짜 외 조건이
// 지난 수집과 달라진 경우(예: 담당자/프로젝트 필터 교체)일 가능성이 높아 확인을 받는다.
const PRUNE_CONFIRM_THRESHOLD = 5;

// JQL 날짜 범위 안에 있는데 이번 응답에는 없던 로컬 이슈 키를 골라낸다.
// TG쪽 upsertTgTasks의 prune과 같은 취지지만, 범위를 projectId가 아니라 JQL의
// updated 구간으로 잡는다 — 지라 탭은 범위를 바꿔가며 여러 번 수집해 누적하는
// 구조라(‹지난주/이번주/다음주› 버튼이 그 전제), 범위 밖까지 정리하면 작년 것처럼
// 이번 수집이 커버하지 않는 데이터가 통째로 날아간다.
// 한계 두 가지는 감당 가능한 선에서 남겨둔다:
//   - 날짜 외 조건이 지난 수집과 달라졌으면 여전히 오탐한다. 그건 '정리 대상이
//     비정상적으로 많다'로 드러나므로 호출부에서 확인을 받아 막는다.
//   - 로컬 updated는 수집 당시 값이고, 타임존 경계에서 하루 어긋날 수 있다.
//     잘못 지워져도 [되돌리기]가 있고, 해당 범위로 다시 수집하면 돌아온다.
async function findStaleIssues(incoming, range) {
  if (!range.start || !range.end) return [];  // 날짜 조건 없는 JQL — 범위를 모르니 손대지 않는다
  const seen = new Set(incoming.map((it) => it.key));
  const { jiraIssues } = await getAll();
  const stale = [];
  for (const [key, rec] of Object.entries(jiraIssues)) {
    if (seen.has(key)) continue;
    const d = toReadableDate(rec.updated).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;         // updated를 못 읽은 건은 제외
    if (d < range.start || d >= range.end) continue;        // 범위 밖 = 이번 수집 대상이 아님
    stale.push(key);
  }
  return stale;
}

// 한 건 삭제. 확인창 대신 스낵바 [되돌리기]를 준다 — 1건이라 확인창은 번거롭고,
// 원본 레코드를 그대로 들고 있으니 실수는 복구할 수 있다.
async function handleDeleteRow(key) {
  const removed = await removeJiraIssues([key]);
  if (removed.length === 0) {
    showSnackbar(`${key}은 이미 목록에 없습니다.`, { kind: "error" });
    return;
  }
  await renderJiraTable();
  showSnackbar(`${key} 삭제됨. 다시 수집하면 되돌아옵니다.`, {
    kind: "ok",
    duration: 8000,
    actionLabel: "되돌리기",
    onAction: async () => {
      await restoreJiraIssues(removed);
      await renderJiraTable();
      showSnackbar(`${key} 되돌림.`, { kind: "ok" });
    },
  });
}

async function renderJiraTable() {
  const { jiraIssues, settings } = await getAll();
  const tbody = document.querySelector("#jira-table tbody");
  tbody.replaceChildren();
  // 정렬은 정규화된 키로(같은 포맷이라야 안정적).
  const list = Object.values(jiraIssues).sort((a, b) => toReadableDate(b.updated).localeCompare(toReadableDate(a.updated)));
  const total = list.length;
  const pageSize = Number(settings.jiraPageSize) || 100;
  const slice = pageSize === 0 ? list : list.slice((jiraPage - 1) * pageSize, jiraPage * pageSize);
  for (const it of slice) {
    const tr = document.createElement("tr");
    const c = (t) => { const td = document.createElement("td"); td.textContent = t ?? ""; return td; };
    // 삭제 대상 키는 행에 심어둔다 — 위임 핸들러가 버튼에서 행으로 거슬러 올라가 읽는다.
    tr.dataset.key = it.key;
    const delCell = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "row-del";
    delBtn.textContent = "\u00d7";
    delBtn.dataset.tip = `${it.key} 삭제 (이 목록에서만)`;
    delCell.appendChild(delBtn);
    tr.append(c(it.key), c(it.summary), c(it.status), c(it.assignee), c(toReadableDate(it.updated)), delCell);
    tbody.appendChild(tr);
  }
  $("jira-status").textContent = `누적 ${total}건`;
  renderPager($("jira-pager"), total, pageSize, jiraPage, (p) => {
    jiraPage = p;
    renderJiraTable();
  });
}

async function syncFinalUrl() {
  const s = await getSettings();
  $("jira-final-url").value = buildJiraSearchUrl(s);
}

function debounce(fn, ms = 300) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export async function initJiraTab() {
  let s = await getSettings();

  // 옛 placeholder 자동 마이그레이션: {{yearStart}}/{{yearEnd}} 가 보이면 올해 기준 날짜로 박아 저장
  if (/\{\{year(Start|End)\}\}/.test(s.jqlTemplate ?? "")) {
    const fresh = defaultJql();
    await setSettings({ jqlTemplate: fresh });
    s = await getSettings();
  }

  $("jira-domain").value = s.jiraDomain ?? "";
  $("jira-jql").value = s.jqlTemplate ?? "";

  const dates = extractDatesFromJql(s.jqlTemplate);
  $("jira-date-start").value = dates.start;
  $("jira-date-end").value   = dates.end;

  await syncFinalUrl();

  const saveDomain = debounce(async () => {
    await setSettings({ jiraDomain: $("jira-domain").value.trim() });
    await syncFinalUrl();
  }, 300);
  const saveJql = debounce(async () => {
    const v = $("jira-jql").value;
    await setSettings({ jqlTemplate: v });
    const d = extractDatesFromJql(v);
    if (d.start) $("jira-date-start").value = d.start;
    if (d.end)   $("jira-date-end").value   = d.end;
    await syncFinalUrl();
  }, 300);

  $("jira-domain").addEventListener("input", saveDomain);
  $("jira-jql").addEventListener("input", saveJql);

  async function applyDatesToJql(start, end) {
    if (!start || !end) return;
    const next = injectDates($("jira-jql").value, start, end);
    if (next === $("jira-jql").value) return;
    $("jira-jql").value = next;
    await setSettings({ jqlTemplate: next });
    await syncFinalUrl();
  }

  // 단위 토글 + 메인 3버튼 라벨 적용
  const nav = document.querySelector('.range-nav[data-scope="jira"]');
  const unitMenu = document.querySelector('.range-unit-menu[data-scope="jira"]');
  const applyUnit = (unit) => {
    applyUnitLabels(unit, nav);
    unitMenu.querySelectorAll("[data-unit]").forEach((b) =>
      b.classList.toggle("active", b.dataset.unit === unit)
    );
  };
  applyUnit(s.rangeUnit ?? "month");

  unitMenu.querySelectorAll("[data-unit]").forEach((b) => {
    b.addEventListener("click", async () => {
      const unit = b.dataset.unit;
      applyUnit(unit);
      await setSettings({ rangeUnit: unit });
      const map = UNIT_MAP[unit];
      const r = presetRange(map.this.name);
      if (r) {
        $("jira-date-start").value = r.start;
        $("jira-date-end").value   = r.end;
        await applyDatesToJql(r.start, r.end);
      }
    });
  });

  // 메인 3버튼 클릭 — prev/next는 현재 범위 기준 시프트, this는 오늘 기준
  const currentUnit = () => {
    const active = unitMenu.querySelector("[data-unit].active");
    return active?.dataset.unit ?? "month";
  };
  nav.querySelectorAll("[data-step]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const step = btn.dataset.step;
      const unit = currentUnit();
      let r;
      if (step === "this") {
        r = presetRange(UNIT_MAP[unit].this.name);
      } else {
        const cur = { start: $("jira-date-start").value, end: $("jira-date-end").value };
        r = shiftRange(unit, cur.start, cur.end, step === "prev" ? -1 : 1)
          ?? presetRange(UNIT_MAP[unit][step].name);
      }
      if (!r) return;
      $("jira-date-start").value = r.start;
      $("jira-date-end").value   = r.end;
      await applyDatesToJql(r.start, r.end);
    });
  });

  // 달력 직접 수정 → 즉시 JQL 갱신
  $("jira-date-start").addEventListener("change", () => applyDatesToJql($("jira-date-start").value, $("jira-date-end").value));
  $("jira-date-end").addEventListener("change", () => applyDatesToJql($("jira-date-start").value, $("jira-date-end").value));

  // 달력 input을 어디 클릭해도 picker 열리도록 (Chrome 99+)
  for (const id of ["jira-date-start", "jira-date-end"]) {
    const el = $(id);
    el.addEventListener("click", () => { try { el.showPicker?.(); } catch {} });
    el.addEventListener("focus", () => { try { el.showPicker?.(); } catch {} });
  }

  $("btn-collect-jira").addEventListener("click", handleCollectJira);
  $("btn-collect-jira-fetch").addEventListener("click", handleCollectJiraFetch);
  $("btn-collect-jira-rest").addEventListener("click", handleCollectJiraRest);

  $("jira-page-size").value = String(s.jiraPageSize ?? 100);
  $("jira-page-size").addEventListener("change", async () => {
    const v = Number($("jira-page-size").value);
    await setSettings({ jiraPageSize: v });
    jiraPage = 1;
    await renderJiraTable();
  });

  $("btn-clear-jira").addEventListener("click", async () => {
    if (!confirm("저장된 Jira 이슈를 모두 삭제합니다. 진행할까요? (설정은 유지)")) return;
    await clearJiraIssues();
    jiraPage = 1;
    showSnackbar("Jira 이슈 전체 삭제됨.", { kind: "ok" });
    await renderJiraTable();
  });

  // 행 삭제는 tbody 이벤트 위임으로 한 번만 등록한다. [페이지당]이 최대 1000행까지
  // 그릴 수 있어, 행마다 리스너를 붙이면 렌더할 때마다 그만큼 다시 생긴다.
  document.querySelector("#jira-table tbody").addEventListener("click", (e) => {
    const btn = e.target.closest(".row-del");
    if (!btn) return;
    const key = btn.closest("tr")?.dataset.key;
    if (key) handleDeleteRow(key);
  });

  $("jira-final-url").addEventListener("click", () => {
    const v = $("jira-final-url").value;
    if (!v) { showSnackbar("경로와 JQL을 먼저 입력하세요.", { kind: "error" }); return; }
    chrome.tabs.create({ url: v });
  });

  document.querySelector('.tab-btn[data-tab="jira"]').addEventListener("click", syncFinalUrl);

  await renderJiraTable();
}
