import { getAll, getSettings, setSettings } from "../lib/storage.js";
import { showSnackbar } from "./snackbar.js";

function $(id) { return document.getElementById(id); }

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d) {
  const x = new Date(d);
  const dow = x.getDay();
  const diff = (dow === 0 ? -6 : 1 - dow);
  return addDays(x, diff);
}
function endOfWeek(d) { return addDays(startOfWeek(d), 7); }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 1); }
function startOfYear(d) { return new Date(d.getFullYear(), 0, 1); }
function endOfYear(d) { return new Date(d.getFullYear() + 1, 0, 1); }

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

function shiftRange(unit, start, end, delta) {
  if (!start || !end) return null;
  const s = new Date(start), e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  switch (unit) {
    case "day":     s.setDate(s.getDate() + delta);     e.setDate(e.getDate() + delta);     break;
    case "week":    s.setDate(s.getDate() + 7 * delta); e.setDate(e.getDate() + 7 * delta); break;
    case "month":   s.setMonth(s.getMonth() + delta);   e.setMonth(e.getMonth() + delta);   break;
    case "quarter": s.setMonth(s.getMonth() + 3 * delta); e.setMonth(e.getMonth() + 3 * delta); break;
    case "year":    s.setFullYear(s.getFullYear() + delta); e.setFullYear(e.getFullYear() + delta); break;
  }
  return { start: fmtDate(s), end: fmtDate(e) };
}

function currentSource() {
  const checked = document.querySelector('input[name="report-source"]:checked');
  return checked?.value ?? "jira";
}

function inRange(dateStr, start, end) {
  if (!dateStr) return false;
  // start <= date < end (end 는 다음달 1일이라 exclusive)
  return dateStr >= start && dateStr < end;
}

// "2026년 5월 28일 오후 4:16" 같은 한국어 텍스트나 ISO 문자열을 "YYYY-MM-DD" 로 정규화
function toIsoDate(s) {
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return "";
}

function buildJiraText(jiraIssues, start, end) {
  const list = Object.values(jiraIssues)
    .map((it) => ({ ...it, _iso: toIsoDate(it.updated) }))
    .filter((it) => inRange(it._iso, start, end))
    .sort((a, b) => a._iso.localeCompare(b._iso));
  const lines = list.map((it) => `[${it.key}] ${it.summary ?? ""}`);
  return { count: list.length, text: lines.join("\n") };
}

function buildTgText(tgTasks, start, end) {
  const list = Object.values(tgTasks)
    .filter((it) => inRange(it.start, start, end) || inRange(it.end, start, end))
    .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
  const lines = list.map((it) => {
    const range = [it.start, it.end].filter(Boolean).join(" ~ ");
    const prefix = it.jiraKey ? `[${it.jiraKey}] ` : "";
    return `${prefix}${it.rawTitle ?? ""}${range ? ` (${range})` : ""}`;
  });
  return { count: list.length, text: lines.join("\n") };
}

async function runReport() {
  const start = $("report-start").value;
  const end = $("report-end").value;
  if (!start || !end) {
    showSnackbar("기간을 먼저 선택하세요.", { kind: "error" });
    return;
  }
  const source = currentSource();
  const { jiraIssues, tgTasks } = await getAll();
  const result = source === "jira"
    ? buildJiraText(jiraIssues, start, end)
    : buildTgText(tgTasks, start, end);

  $("report-output").value = result.text;
  $("report-count").textContent = result.count === 0
    ? `${source === "jira" ? "Jira" : "TeamGantt"} · 해당 기간에 항목이 없습니다.`
    : `${source === "jira" ? "Jira" : "TeamGantt"} · ${result.count}건`;
}

export async function initReportTab() {
  // 마지막 선택한 소스 복원
  const s = await getSettings();
  const target = s.reportSource ?? "jira";
  const radio = document.querySelector(`input[name="report-source"][value="${target}"]`);
  if (radio) radio.checked = true;

  // 단위 토글 + 메인 3버튼 라벨 적용 + 기본 범위 채움
  const nav = document.querySelector('.range-nav[data-scope="report"]');
  const unitMenu = document.querySelector('.range-unit-menu[data-scope="report"]');
  const applyUnit = (unit) => {
    applyUnitLabels(unit, nav);
    unitMenu.querySelectorAll("[data-unit]").forEach((b) =>
      b.classList.toggle("active", b.dataset.unit === unit)
    );
  };
  const initialUnit = s.rangeUnit ?? "month";
  applyUnit(initialUnit);
  const r0 = presetRange(UNIT_MAP[initialUnit].this.name);
  $("report-start").value = r0.start;
  $("report-end").value = r0.end;

  unitMenu.querySelectorAll("[data-unit]").forEach((b) => {
    b.addEventListener("click", async () => {
      const unit = b.dataset.unit;
      applyUnit(unit);
      await setSettings({ rangeUnit: unit });
      const r = presetRange(UNIT_MAP[unit].this.name);
      if (r) {
        $("report-start").value = r.start;
        $("report-end").value = r.end;
        runReport();
      }
    });
  });

  const currentUnit = () => {
    const active = unitMenu.querySelector("[data-unit].active");
    return active?.dataset.unit ?? "month";
  };
  nav.querySelectorAll("[data-step]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const step = btn.dataset.step;
      const unit = currentUnit();
      let r;
      if (step === "this") {
        r = presetRange(UNIT_MAP[unit].this.name);
      } else {
        const cur = { start: $("report-start").value, end: $("report-end").value };
        r = shiftRange(unit, cur.start, cur.end, step === "prev" ? -1 : 1)
          ?? presetRange(UNIT_MAP[unit][step].name);
      }
      if (!r) return;
      $("report-start").value = r.start;
      $("report-end").value = r.end;
      runReport();
    });
  });

  $("report-start").addEventListener("change", runReport);
  $("report-end").addEventListener("change", runReport);
  document.querySelectorAll('input[name="report-source"]').forEach((r) =>
    r.addEventListener("change", async () => {
      await setSettings({ reportSource: r.value });
      runReport();
    })
  );

  $("btn-report-copy").addEventListener("click", async () => {
    const v = $("report-output").value;
    if (!v) { showSnackbar("복사할 내용이 없습니다.", { kind: "error" }); return; }
    await navigator.clipboard.writeText(v);
    showSnackbar(`${v.split("\n").length}줄 복사됨.`, { kind: "ok", duration: 2000 });
  });

  document.querySelector('.tab-btn[data-tab="report"]').addEventListener("click", runReport);

  // 첫 진입 시 자동 조회
  await runReport();
}
