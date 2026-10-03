import { getSettings, setSettings, recordEpicLink } from "../lib/storage.js";
import {
  EPIC_LINK_FIELDS, KIND, groupEpicsByMonth, pickDefaultEpic, normalizeLinkTarget,
  issueMonth, buildPlan, sectionOf, isSelectable, parseEpicMonth,
} from "../lib/epic-link.js";
import {
  job, snackBusy, findJiraTab, snackNoJiraTab, searchJql, applyParents, openIssue,
  resultText, announce, EV_PARENTS, EV_HISTORY,
} from "./epic-jira.js";
import { initEpicHistory, refreshEpicHistory } from "./tab-epic-history.js";
import { initEpicReport, showEpicReport } from "./epic-report.js";
import { showSnackbar } from "./snackbar.js";

// 월별 에픽 선택 상자에서 '이 달은 연결 안 함'을 뜻하는 값.
// 아직 고르지 않은 달과 구분해야, 다른 달을 고를 때 이 달이 자동으로 채워지지 않는다.
const SKIP_MONTH = "__skip";

let loaded = false;          // 한 번이라도 불러왔는지
let candidates = {};         // 월 → [{ key, summary, format }]
let chosen = {};             // 월 → 에픽 키. ""는 연결 안 함으로 고른 달, null이나 없음은 아직 고르지 않은 달
let issues = new Map();      // 키 → 연결 대상 이슈
let picked = new Set();      // 체크한 이슈 키
let results = new Map();     // 이번에 보낸 요청의 결과. 키 → { ok, error }
let shown = { link: [], move: [] };  // 표에 보이는 행 순서. Shift+클릭 범위와 묶음 체크가 쓴다
let lastClick = null;        // Shift+클릭의 기준. { table, key }

function $(id) { return document.getElementById(id); }

// ── 작은 도우미 ─────────────────────────────

function epicTitle(key) {
  if (!key) return "";
  for (const list of Object.values(candidates)) {
    const hit = list.find((c) => c.key === key);
    if (hit) return hit.summary;
  }
  return "";
}

function countBy(rows, keyOf) {
  const m = new Map();
  for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + 1);
  return m;
}

// 같은 달 안에서는 해결일 순으로 놓고, 미해결은 맨 뒤로 보낸다.
function byMonthThenDate(a, b) {
  return a.month.localeCompare(b.month)
    || (a.resolved ? 0 : 1) - (b.resolved ? 0 : 1)
    || a.resolved.localeCompare(b.resolved)
    || a.key.localeCompare(b.key, undefined, { numeric: true });
}

function currentPlan() {
  return buildPlan([...issues.values()], chosen);
}

// 분류가 바뀐 이슈만 체크를 다시 맞춘다.
// 상위 없는 이슈는 연결할 수 있게 되면 체크하고, 연결할 수 없게 되면 체크를 푼다.
// 다른 에픽에 있는 이슈는 옮길 수 있게 돼도 체크하지 않는다(직접 체크한 것만 옮긴다).
// 분류가 그대로인 이슈는 사용자가 바꿔 둔 체크를 건드리지 않는다.
function syncPicked(prevPlan, nextPlan) {
  const before = new Map(prevPlan.map((r) => [r.key, r.kind]));
  for (const r of nextPlan) {
    if (before.get(r.key) === r.kind) continue;
    if (r.kind === KIND.LINK) picked.add(r.key);
    else picked.delete(r.key);
  }
}

// ── 불러오기와 에픽 고르기 ─────────────────────────────

async function handleLoad() {
  if (job.busy) { snackBusy(); return; }
  const findJql = $("epic-find-jql").value.trim();
  const targetJql = $("epic-target-jql").value.trim();
  if (!findJql || !targetJql) {
    showSnackbar("에픽 JQL과 대상 JQL을 모두 입력하세요.", { kind: "error" });
    return;
  }
  const tab = await findJiraTab();
  if (!tab) { snackNoJiraTab(); return; }

  let message = null;
  setBusy(true, "btn-epic-load");
  try {
    const [epicResp, targetResp] = await Promise.all([
      searchJql(tab.id, findJql, ["summary"]),
      searchJql(tab.id, targetJql, EPIC_LINK_FIELDS),
    ]);
    if (!epicResp.ok) { message = { text: `에픽 조회 실패: ${epicResp.error}`, kind: "error" }; return; }
    if (!targetResp.ok) { message = { text: `대상 조회 실패: ${targetResp.error}`, kind: "error" }; return; }

    const { epicTitleFormat } = await getSettings();
    candidates = groupEpicsByMonth(epicResp.data.issues);
    issues = new Map((targetResp.data.issues ?? []).map(normalizeLinkTarget).map((it) => [it.key, it]));

    // 다시 불러와도 직접 고른 에픽과 연결 안 함으로 고른 달은 그대로 둔다.
    // 고른 에픽이 후보에서 사라진 달만 다시 고른다.
    const prevChosen = chosen;
    chosen = {};
    for (const month of new Set([...issues.values()].map((it) => issueMonth(it.resolved)))) {
      const list = candidates[month] ?? [];
      const prev = prevChosen[month];
      chosen[month] = prev === "" || list.some((c) => c.key === prev)
        ? prev
        : pickDefaultEpic(list, epicTitleFormat);
    }
    results = new Map();
    picked = new Set();
    syncPicked([], currentPlan());
    loaded = true;

    const nEpics = Object.values(candidates).reduce((n, list) => n + list.length, 0);
    const unpicked = Object.values(chosen).filter((v) => v == null).length;
    const cut = epicResp.data.truncated || targetResp.data.truncated;
    message = {
      text: `대상 ${issues.size}건, 에픽 후보 ${nEpics}개를 불러왔습니다.`
        + (unpicked ? ` 에픽을 고르지 않은 달이 ${unpicked}개 있습니다.` : "")
        + (cut ? " ⚠ 결과가 너무 많아 일부만 받았습니다. JQL을 좁혀 주세요." : ""),
      kind: cut ? "error" : "ok",
    };
  } finally {
    setBusy(false);
    render();
    if (message) showSnackbar(message.text, { kind: message.kind, duration: 8000 });
  }
}

async function onPickEpic(month, value) {
  const prevPlan = currentPlan();
  if (value === SKIP_MONTH) chosen[month] = "";
  else if (!value) chosen[month] = null;
  else {
    chosen[month] = value;
    const format = (candidates[month] ?? []).find((c) => c.key === value)?.format;
    if (format) {
      await setSettings({ epicTitleFormat: format });
      // 아직 고르지 않은 달은 같은 형식의 에픽으로 채운다.
      // 이미 에픽을 고른 달과 연결 안 함으로 고른 달은 그대로 둔다.
      for (const m of Object.keys(chosen)) {
        if (chosen[m] == null) chosen[m] = pickDefaultEpic(candidates[m] ?? [], format);
      }
    }
  }
  syncPicked(prevPlan, currentPlan());
  render();
}

// ── 그리기 ─────────────────────────────

function render() {
  $("epic-empty").classList.toggle("hidden", loaded);
  for (const id of ["epic-month-box", "epic-search-row", "epic-sec-link", "epic-sec-move", "epic-sec-skip"]) {
    $(id).classList.toggle("hidden", !loaded);
  }
  if (!loaded) return;

  const plan = currentPlan();
  renderMonthMap(plan);
  const q = $("epic-search").value.trim().toLowerCase();
  const all = { link: [], move: [], skip: [] };
  const visible = { link: [], move: [], skip: [] };
  for (const r of plan) {
    const sec = sectionOf(r);
    all[sec].push(r);
    if (!q || matchesSearch(r, q)) visible[sec].push(r);
  }
  renderLink(visible.link, all.link);
  renderMove(visible.move, all.move);
  renderSkip(visible.skip, all.skip);
}

function matchesSearch(r, q) {
  return [r.key, r.summary, r.parentKey, r.parentSummary, r.epicKey]
    .some((v) => String(v ?? "").toLowerCase().includes(q));
}

function renderMonthMap(plan) {
  const counts = new Map();
  for (const r of plan) {
    const c = counts.get(r.month) ?? { link: 0, move: 0, skip: 0 };
    c[sectionOf(r)]++;
    counts.set(r.month, c);
  }
  const months = [...counts.keys()].sort();
  const box = $("epic-month-map");
  box.replaceChildren();
  let ready = 0;
  for (const month of months) {
    const list = candidates[month] ?? [];
    const sel = document.createElement("select");
    sel.dataset.month = month;
    sel.disabled = job.busy;
    sel.append(new Option(list.length ? "(에픽을 고르세요)" : "(이 달 에픽을 못 찾음)", ""));
    sel.append(new Option("(이 달은 연결 안 함)", SKIP_MONTH));
    for (const c of list) sel.append(new Option(`${c.key}  ${c.summary}`, c.key));
    const cur = chosen[month];
    sel.value = cur === "" ? SKIP_MONTH : (cur ?? "");
    sel.classList.toggle("needs-pick", cur == null);
    if (cur) ready++;

    const label = document.createElement("span");
    label.className = "epic-month-label";
    label.textContent = month;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "epic-month-open";
    open.textContent = "열기";
    if (cur) {
      open.dataset.open = cur;
      open.title = "고른 에픽을 Jira에서 열기";
    } else {
      open.disabled = true;
    }
    const info = document.createElement("span");
    info.className = "epic-month-count";
    const c = counts.get(month);
    info.textContent = `상위 없음 ${c.link}, 다른 에픽 ${c.move}`;
    box.append(label, sel, open, info);
  }
  $("epic-month-title").textContent = `월별 에픽 (${months.length}개월 중 ${ready}개월 고름)`;
}

function renderLink(rows, all) {
  const n = all.filter((r) => isSelectable(r.kind) && picked.has(r.key)).length;
  $("epic-link-count").textContent = `${all.length}건, 체크 ${n}건`;
  $("btn-epic-run-link").textContent = n ? `체크한 ${n}건 연결` : "체크한 항목 연결";

  const sorted = [...rows].sort(byMonthThenDate);
  shown.link = sorted;
  const tbody = document.querySelector("#epic-table-link tbody");
  tbody.replaceChildren();
  let month = null;
  for (const r of sorted) {
    if (r.month !== month) {
      month = r.month;
      const epic = chosen[month] ? `${chosen[month]} ${epicTitle(chosen[month])}` : "에픽을 고르지 않음";
      tbody.appendChild(groupRow("link", month, `${month}  →  ${epic}`, sorted.filter((x) => x.month === month), chosen[month] || null));
    }
    tbody.appendChild(issueRow(r, "link"));
  }
  if (!sorted.length) tbody.appendChild(emptyRow(5, all.length ? "검색에 맞는 이슈가 없습니다." : "상위 없는 이슈가 없습니다."));
  syncCheckAll(sorted);
}

function renderMove(rows, all) {
  const n = all.filter((r) => isSelectable(r.kind) && picked.has(r.key)).length;
  $("epic-move-count").textContent = `${all.length}건, 체크 ${n}건`;
  $("btn-epic-run-move").textContent = n ? `체크한 ${n}건 옮기기` : "체크한 항목 옮기기";

  // 원래 에픽별로 묶는다.
  // 제목에 연월이 있는 월별 에픽을 먼저 보인다.
  // 다른 달 에픽이나 다른 팀의 월별 에픽에 들어가 있는 경우가 옮길 후보로 가장 흔하다.
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.parentKey)) groups.set(r.parentKey, { key: r.parentKey, summary: r.parentSummary, rows: [] });
    groups.get(r.parentKey).rows.push(r);
  }
  const ordered = [...groups.values()].sort((a, b) =>
    (parseEpicMonth(a.summary) ? 0 : 1) - (parseEpicMonth(b.summary) ? 0 : 1)
    || b.rows.length - a.rows.length
    || a.key.localeCompare(b.key, undefined, { numeric: true }));

  const tbody = document.querySelector("#epic-table-move tbody");
  tbody.replaceChildren();
  shown.move = [];
  for (const g of ordered) {
    g.rows.sort(byMonthThenDate);
    tbody.appendChild(groupRow("move", g.key, `${g.key} ${g.summary}`, g.rows, g.key));
    for (const r of g.rows) tbody.appendChild(issueRow(r, "move"));
    shown.move.push(...g.rows);
  }
  if (!ordered.length) tbody.appendChild(emptyRow(5, all.length ? "검색에 맞는 이슈가 없습니다." : "다른 에픽에 있는 이슈가 없습니다."));
}

const SKIP_GROUPS = [
  [KIND.ALREADY, "이미 그 달 에픽에 있음"],
  [KIND.MONTH_OFF, "연결하지 않기로 고른 달"],
  [KIND.SUBTASK, "하위 작업 (상위가 일반 이슈라 에픽에 넣을 수 없음)"],
  [KIND.EPIC, "에픽 (다른 에픽 아래로 넣을 수 없음)"],
];

function renderSkip(rows, all) {
  $("epic-skip-count").textContent = `${all.length}건`;
  const tbody = document.querySelector("#epic-table-skip tbody");
  tbody.replaceChildren();
  for (const [kind, label] of SKIP_GROUPS) {
    const list = rows.filter((r) => r.kind === kind).sort(byMonthThenDate);
    if (!list.length) continue;
    const tr = document.createElement("tr");
    tr.className = "epic-group";
    const td = document.createElement("td");
    td.colSpan = 4;
    td.textContent = `${label} (${list.length}건)`;
    tr.appendChild(td);
    tbody.appendChild(tr);
    for (const r of list) tbody.appendChild(issueRow(r, "skip"));
  }
  if (!rows.length) tbody.appendChild(emptyRow(4, all.length ? "검색에 맞는 이슈가 없습니다." : "없습니다."));
}

// 묶음 머리 행이고, 체크박스로 그 묶음의 이슈를 한꺼번에 고른다.
// openKey를 주면 머리 글자를 눌러 그 에픽을 Jira에서 연다.
function groupRow(table, group, label, rows, openKey = null) {
  const tr = document.createElement("tr");
  tr.className = "epic-group";
  const tdC = document.createElement("td");
  tdC.className = "col-check";
  const pickable = rows.filter((r) => isSelectable(r.kind));
  if (pickable.length) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "epic-group-pick";
    cb.dataset.group = group;
    cb.title = table === "link" ? "이 달 이슈 전체 선택/해제" : "이 에픽의 이슈 전체 선택/해제";
    const on = pickable.filter((r) => picked.has(r.key)).length;
    cb.checked = on === pickable.length;
    cb.indeterminate = on > 0 && on < pickable.length;
    cb.disabled = job.busy;
    tdC.appendChild(cb);
  }
  const td = document.createElement("td");
  td.colSpan = 4;
  td.textContent = `${label} (${rows.length}건)`;
  if (openKey) {
    td.dataset.open = openKey;
    td.classList.add("clickable");
    td.title = "이 에픽을 Jira에서 열기";
  }
  tr.append(tdC, td);
  return tr;
}

function issueRow(r, table) {
  const tr = document.createElement("tr");
  tr.dataset.key = r.key;
  const res = results.get(r.key);
  if (res && !res.ok) tr.classList.add("is-fail");
  if (r.kind === KIND.NO_EPIC) tr.classList.add("is-off");

  if (table !== "skip") {
    const td = document.createElement("td");
    td.className = "col-check";
    if (isSelectable(r.kind)) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "epic-pick";
      cb.checked = picked.has(r.key);
      cb.disabled = job.busy;
      td.appendChild(cb);
    }
    tr.appendChild(td);
  }
  const key = cell(r.key, "col-key clickable");
  key.title = "Jira에서 열기";
  const date = cell(r.resolved ? r.resolved.slice(0, 10) : "미해결", "col-date");
  date.title = r.status;
  const note = cell(noteText(r, table, res), "col-note");
  if (table === "move" && r.epicKey) note.title = epicTitle(r.epicKey);
  tr.append(key, cell(r.summary, "col-summary"), date, note);
  return tr;
}

function noteText(r, table, res) {
  if (res && !res.ok) return res.skipped ? res.error : `실패: ${res.error}`;
  if (table === "skip") {
    if (r.kind === KIND.ALREADY) return res?.ok ? `✓ 방금 넣음 (${r.parentKey})` : `✓ ${r.parentKey}`;
    if (r.kind === KIND.SUBTASK) return r.parentKey ? `상위 이슈 ${r.parentKey}` : "";
    if (r.kind === KIND.MONTH_OFF) return r.parentKey ? `${r.parentKey} ${r.parentSummary}` : "상위 없음";
    return "";
  }
  if (r.kind === KIND.NO_EPIC) return "그 달 에픽을 고르지 않음";
  if (table === "move") return `→ ${r.month}  ${r.epicKey}`;
  return picked.has(r.key) ? "연결 예정" : "건너뜀";
}

function cell(text, cls) {
  const td = document.createElement("td");
  td.className = cls;
  td.textContent = text ?? "";
  return td;
}

function emptyRow(cols, text) {
  const tr = document.createElement("tr");
  tr.className = "epic-none";
  const td = document.createElement("td");
  td.colSpan = cols;
  td.textContent = text;
  tr.appendChild(td);
  return tr;
}

function syncCheckAll(rows) {
  const all = $("epic-check-all");
  const pickable = rows.filter((r) => isSelectable(r.kind));
  const on = pickable.filter((r) => picked.has(r.key)).length;
  all.checked = pickable.length > 0 && on === pickable.length;
  all.indeterminate = on > 0 && on < pickable.length;
  all.disabled = job.busy || pickable.length === 0;
}

// 실행 중에는 표를 다시 그리지 않고 상태 칸만 바꾼다.
// 다 끝난 뒤 다시 그리면 넣은 이슈가 '건드리지 않는 이슈'로 넘어간다.
function markRow(key, res) {
  for (const tr of document.querySelectorAll(`.epic-table tr[data-key="${CSS.escape(key)}"]`)) {
    const note = tr.querySelector(".col-note");
    if (note) note.textContent = res.ok ? "✓ 완료" : res.skipped ? res.error : `실패: ${res.error}`;
    tr.classList.toggle("is-done", res.ok);
    tr.classList.toggle("is-fail", !res.ok);
  }
}

// ── 체크 ─────────────────────────────

function setPicked(rows, on) {
  for (const r of rows) {
    if (!isSelectable(r.kind)) continue;
    if (on) picked.add(r.key);
    else picked.delete(r.key);
  }
  render();
}

function groupOf(r, table) {
  return table === "link" ? r.month : r.parentKey;
}

function onRowPick(table, key, on, shift) {
  const list = shown[table];
  let rows = list.filter((r) => r.key === key);
  // Shift+클릭은 같은 표 안에서 직전에 누른 행부터 이 행까지를 같은 상태로 맞춘다.
  if (shift && lastClick?.table === table) {
    const a = list.findIndex((r) => r.key === lastClick.key);
    const b = list.findIndex((r) => r.key === key);
    if (a >= 0 && b >= 0) rows = list.slice(Math.min(a, b), Math.max(a, b) + 1);
  }
  lastClick = { table, key };
  setPicked(rows, on);
}

function onTableClick(table, e) {
  const pick = e.target.closest("input.epic-pick");
  if (pick) {
    onRowPick(table, pick.closest("tr").dataset.key, pick.checked, e.shiftKey);
    return;
  }
  const group = e.target.closest("input.epic-group-pick");
  if (group) {
    setPicked(shown[table].filter((r) => groupOf(r, table) === group.dataset.group), group.checked);
    return;
  }
  const open = e.target.closest("td[data-open]");
  if (open) {
    openIssue(open.dataset.open);
    return;
  }
  const key = e.target.closest("td.col-key")?.closest("tr")?.dataset.key;
  if (key) openIssue(key);
}

// ── 실행 ─────────────────────────────

const RUN_BUTTONS = ["btn-epic-load", "btn-epic-run-link", "btn-epic-run-move"];

function setBusy(on, activeId = null) {
  job.busy = on;
  job.stop = false;
  for (const id of RUN_BUTTONS) {
    $(id).disabled = on;
    $(id).classList.toggle("is-loading", on && id === activeId);
  }
  const stop = $("btn-epic-stop");
  stop.classList.toggle("hidden", !on || activeId === "btn-epic-load");
  stop.disabled = false;
  stop.textContent = "중지";
  if (on) {
    // 실행 중에는 체크와 에픽 선택을 잠근다.
    // 도중에 바꾸면 화면과 실제로 보내는 요청이 어긋난다.
    for (const el of document.querySelectorAll("#epic-link-view .epic-table input, #epic-month-map select")) el.disabled = true;
  }
}

function showProgress(verb, n, total, failed) {
  $("epic-status").textContent = `${verb} ${n}/${total}${failed ? `, 실패 ${failed}` : ""}`;
}

function confirmText(table, targets) {
  const lines = table === "link"
    ? [`상위가 없는 ${targets.length}건을 해결한 달의 에픽 아래로 넣습니다.`]
    : [`다른 에픽에 있는 ${targets.length}건을 옮깁니다.`, "옮긴 이슈는 원래 에픽에서 빠집니다."];
  lines.push("", "넣을 에픽");
  for (const [month, n] of [...countBy(targets, (r) => r.month)].sort()) {
    const epicKey = targets.find((r) => r.month === month).epicKey;
    lines.push(`- ${month}  ${epicKey} ${epicTitle(epicKey)} (${n}건)`);
  }
  if (table === "move") {
    const from = [...countBy(targets, (r) => r.parentKey)].sort((a, b) => b[1] - a[1]);
    lines.push("", "빠지는 에픽");
    for (const [key, n] of from.slice(0, 8)) {
      lines.push(`- ${key} ${targets.find((r) => r.parentKey === key).parentSummary} (${n}건)`);
    }
    if (from.length > 8) lines.push(`- 그 밖에 에픽 ${from.length - 8}개`);
  }
  lines.push(
    "", "알림 메일은 끄고 보내 봅니다. 권한이 없어 거절되면 다시 묻습니다.",
    "바꾼 내용은 [변경 기록]에 남고, 거기서 언제든 취소할 수 있습니다.", "", "진행할까요?",
  );
  return lines.join("\n");
}

async function handleRun(table) {
  if (job.busy) { snackBusy(); return; }
  const targets = currentPlan().filter((r) => sectionOf(r) === table && isSelectable(r.kind) && picked.has(r.key));
  if (!targets.length) {
    showSnackbar(
      table === "link" ? "연결할 이슈를 체크하세요." : "옮길 이슈를 체크하세요. 이 영역은 직접 체크한 것만 옮깁니다.",
      { kind: "error" },
    );
    return;
  }
  if (!confirm(confirmText(table, targets))) return;
  const tab = await findJiraTab();
  if (!tab) { snackNoJiraTab(); return; }

  const verb = table === "link" ? "연결" : "옮기기";
  const run = { id: String(Date.now()), at: new Date().toISOString(), kind: table, items: [] };
  // 변경 기록에 그대로 남길 모양이다.
  // 나중에 기록만 보고도 무엇을 어디서 어디로 옮겼는지 알 수 있게 제목까지 담는다.
  // expect는 불러올 때 본 상위다.
  // 그 뒤 누군가 이 이슈를 다른 에픽에 넣었으면 브리지가 쓰지 않고 건너뛴다.
  const items = targets.map((r) => ({
    key: r.key, summary: r.summary,
    from: r.parentKey, fromSummary: r.parentSummary,
    to: r.epicKey, toSummary: epicTitle(r.epicKey),
    expect: r.parentKey,
  }));
  const succeeded = [];
  let failed = 0, skipped = 0;
  let out = { notified: false, error: null };
  setBusy(true, table === "link" ? "btn-epic-run-link" : "btn-epic-run-move");
  try {
    out = await applyParents(tab.id, items, async (item, res) => {
      results.set(item.key, res);
      if (res.ok) {
        succeeded.push(item);
        const { expect, ...record } = item;
        await recordEpicLink(run, record);
        // 다시 불러오지 않아도 '이미 그 달 에픽에 있음'으로 보이게 화면 쪽 이슈도 바꿔 둔다.
        const it = issues.get(item.key);
        if (it) {
          it.parentKey = item.to;
          it.parentSummary = item.toSummary;
        }
        picked.delete(item.key);
      } else if (res.skipped) {
        skipped++;
        // 화면을 지금 상위로 맞춰서, 다시 불러오지 않아도 바뀐 자리에 보이게 한다.
        const it = issues.get(item.key);
        if (it && !res.missing) {
          it.parentKey = res.current ?? null;
          it.parentSummary = res.currentSummary ?? "";
        }
        picked.delete(item.key);
      } else {
        failed++;
      }
      markRow(item.key, res);
      showProgress(verb, succeeded.length + failed + skipped, items.length, failed);
    });
  } finally {
    setBusy(false);
    render();
    const done = succeeded.length;
    const left = items.length - done - failed - skipped;
    const text = resultText(verb, done, failed, left, out, skipped);
    $("epic-status").textContent = text;
    if (done) {
      announce(EV_HISTORY);
      // 넣은 게 있으면 결과를 에픽별로 정리해 보여 준다(팀장 보고용).
      // 잘못 넣었으면 [변경 기록 보기]에서 이 묶음을 바로 취소할 수 있다.
      showEpicReport({
        title: `${verb} 결과`,
        lead: text,
        items: succeeded,
        showHistory: () => showMode("history"),
      });
    } else {
      showSnackbar(text, { kind: "error", duration: 9000 });
    }
  }
}

// ── 두 화면 오가기 ─────────────────────────────

function showMode(mode, { save = true } = {}) {
  for (const b of document.querySelectorAll("#epic-mode-tabs [data-emode]")) {
    b.classList.toggle("active", b.dataset.emode === mode);
  }
  $("epic-link-view").classList.toggle("hidden", mode !== "link");
  $("epic-history-view").classList.toggle("hidden", mode !== "history");
  if (mode === "history") refreshEpicHistory();
  if (save) setSettings({ epicMode: mode });
}

// 변경 기록에서 취소하면 그 이슈의 상위가 바뀐다.
// 연결 화면을 다시 불러오지 않아도 바뀐 상위대로 보이게 맞춘다.
// 취소로 상위가 없어진 이슈는 체크하지 않은 채로 '상위 없는 이슈'에 돌아온다.
function onParentsChanged(e) {
  for (const c of e.detail ?? []) {
    const it = issues.get(c.key);
    if (!it) continue;
    it.parentKey = c.parentKey ?? null;
    it.parentSummary = c.parentSummary ?? "";
    results.delete(c.key);
  }
  render();
}

export async function initEpicTab() {
  const s = await getSettings();
  $("epic-find-jql").value = s.epicFindJql ?? "";
  $("epic-target-jql").value = s.epicTargetJql ?? "";
  for (const [id, key] of [["epic-find-jql", "epicFindJql"], ["epic-target-jql", "epicTargetJql"]]) {
    let timer = null;
    $(id).addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => setSettings({ [key]: $(id).value }), 300);
    });
  }

  $("btn-epic-load").addEventListener("click", handleLoad);
  $("btn-epic-run-link").addEventListener("click", () => handleRun("link"));
  $("btn-epic-run-move").addEventListener("click", () => handleRun("move"));
  $("btn-epic-stop").addEventListener("click", () => {
    job.stop = true;
    $("btn-epic-stop").disabled = true;
    $("btn-epic-stop").textContent = "멈추는 중";
  });
  $("epic-month-map").addEventListener("click", (e) => {
    const open = e.target.closest("button[data-open]");
    if (open) openIssue(open.dataset.open);
  });
  $("epic-month-map").addEventListener("change", (e) => {
    const sel = e.target.closest("select[data-month]");
    if (sel) onPickEpic(sel.dataset.month, sel.value);
  });
  $("epic-check-all").addEventListener("click", (e) => setPicked(shown.link, e.target.checked));
  let searchTimer = null;
  $("epic-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 150);
  });
  for (const table of ["link", "move", "skip"]) {
    document.querySelector(`#epic-table-${table} tbody`).addEventListener("click", (e) => onTableClick(table, e));
  }
  $("epic-mode-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-emode]");
    if (b) showMode(b.dataset.emode);
  });
  document.addEventListener(EV_PARENTS, onParentsChanged);

  render();
  initEpicReport();
  await initEpicHistory();
  showMode(s.epicMode === "history" ? "history" : "link", { save: false });
}
