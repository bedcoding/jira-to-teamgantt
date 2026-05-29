import { getAll, getSettings, setSettings, upsertJiraIssues, defaultJql, clearJiraIssues } from "../lib/storage.js";
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

// 현재 [start, end) 를 단위만큼 시프트. delta 가 -1 이면 한 칸 과거, +1 이면 한 칸 미래.
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
    showSnackbar(`수집 실패: content script 응답 없음 (${e.message}). 페이지를 새로고침해 보세요.`, { kind: "error" });
    return;
  }
  if (!resp?.ok) { showSnackbar(`수집 실패: ${resp?.error ?? "unknown"}`, { kind: "error" }); return; }
  const { issues, visibleCount, totalText } = resp.data;
  if (issues.length === 0) {
    showSnackbar("수집된 이슈가 0건입니다. 페이지 로딩이 끝났는지 확인하세요.", { kind: "error" });
    return;
  }
  const result = await upsertJiraIssues(issues);
  showSnackbar(
    `Jira 수집: 신규 ${result.added} / 갱신 ${result.updated} / 동일 ${result.skipped} · 누적 ${result.total} (이번 화면 ${visibleCount}${totalText ? `, ${totalText}` : ""})`,
    { kind: "ok", duration: 5000 }
  );
  await renderJiraTable();
}

async function renderJiraTable() {
  const { jiraIssues, settings } = await getAll();
  const tbody = document.querySelector("#jira-table tbody");
  tbody.replaceChildren();
  const list = Object.values(jiraIssues).sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
  const total = list.length;
  const pageSize = Number(settings.jiraPageSize) || 100;
  const slice = pageSize === 0 ? list : list.slice((jiraPage - 1) * pageSize, jiraPage * pageSize);
  for (const it of slice) {
    const tr = document.createElement("tr");
    const c = (t) => { const td = document.createElement("td"); td.textContent = t ?? ""; return td; };
    tr.append(c(it.key), c(it.summary), c(it.status), c(it.assignee), c(it.updated));
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

  // 메인 3버튼 클릭 — prev/next 는 현재 범위 기준 시프트, this 는 오늘 기준
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

  // 달력 input 을 어디 클릭해도 picker 열리도록 (Chrome 99+)
  for (const id of ["jira-date-start", "jira-date-end"]) {
    const el = $(id);
    el.addEventListener("click", () => { try { el.showPicker?.(); } catch {} });
    el.addEventListener("focus", () => { try { el.showPicker?.(); } catch {} });
  }

  $("btn-collect-jira").addEventListener("click", handleCollectJira);

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

  $("jira-final-url").addEventListener("click", () => {
    const v = $("jira-final-url").value;
    if (!v) { showSnackbar("경로와 JQL을 먼저 입력하세요.", { kind: "error" }); return; }
    chrome.tabs.create({ url: v });
  });

  document.querySelector('.tab-btn[data-tab="jira"]').addEventListener("click", syncFinalUrl);

  await renderJiraTable();
}
