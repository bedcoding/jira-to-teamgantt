// 에픽 탭의 변경 기록 화면.
// 에픽에 연결하거나 옮긴 기록을 묶음별로 보여 주고, 한 건이나 에픽 단위나 묶음 전체로 취소한다.
// 취소는 그 이슈의 상위를 바꾸기 전으로 돌리는 것이고, 기록은 지우지 않고 취소한 시각을 남긴다.
import { getEpicRuns, markEpicRun, pruneEpicRuns } from "../lib/storage.js";
import { mergeChanges, reconcileRuns, latestReverted, formatRevertReport } from "../lib/epic-link.js";
import {
  job, snackBusy, findJiraTab, snackNoJiraTab, applyParents, fetchCurrentParents, openIssue,
  fmtTime, resultText, announce, EV_PARENTS, EV_HISTORY,
} from "./epic-jira.js";
import { showSnackbar } from "./snackbar.js";
import { showEpicReport } from "./epic-report.js";

const KIND_LABEL = { link: "연결", move: "옮기기" };

let runs = [];             // 기록 묶음. 나중에 실행한 것이 앞에 온다
let seen = null;           // 지난번에 그린 묶음 id. 새로 생긴 묶음을 펼쳐 보이는 데 쓴다
let opened = new Set();    // 펼쳐 둔 묶음 id. 다시 그려도 펼침 상태를 유지한다

function $(id) { return document.getElementById(id); }

function isActive(it) { return !it.revertedAt; }

function query() {
  return $("epic-history-search").value.trim().toLowerCase();
}

function matches(it, q) {
  return [it.key, it.summary, it.from, it.fromSummary, it.to, it.toSummary]
    .some((v) => String(v ?? "").toLowerCase().includes(q));
}

// 검색에 맞는 항목.
// 묶음이나 에픽 단위 취소는 이 범위 안에서만 한다.
// 팀장이 "이 에픽 건만 아니다"라고 하면 그 에픽으로 걸러 놓고 그것만 취소할 수 있게 하려는 것이다.
function visibleItems(run) {
  const q = query();
  return q ? run.items.filter((it) => matches(it, q)) : run.items;
}

function countBy(list, keyOf) {
  const m = new Map();
  for (const it of list) m.set(keyOf(it), (m.get(keyOf(it)) ?? 0) + 1);
  return m;
}

// ── 그리기 ─────────────────────────────

export async function refreshEpicHistory() {
  runs = (await getEpicRuns()).reverse();
  // 처음 그릴 때는 가장 최근 묶음을, 그 뒤로는 새로 생긴 묶음을 펼쳐 둔다.
  const ids = runs.map((r) => r.id);
  const fresh = seen ? ids.filter((id) => !seen.has(id)) : ids.slice(0, 1);
  for (const id of fresh) opened.add(id);
  seen = new Set(ids);
  render();
}

function render() {
  const active = runs.reduce((n, r) => n + r.items.filter(isActive).length, 0);
  const badge = $("epic-history-badge");
  badge.textContent = String(active);
  badge.classList.toggle("hidden", active === 0);
  $("btn-epic-history-report").disabled = active === 0;
  $("btn-epic-history-revert-report").disabled = !runs.some((r) => r.items.some((it) => !isActive(it)));
  $("btn-epic-history-reconcile").disabled = job.busy || runs.length === 0;
  $("btn-epic-history-prune").disabled = job.busy || !runs.some((r) => r.items.some((it) => !isActive(it)));
  $("btn-epic-history-clear").disabled = job.busy || runs.length === 0;

  const list = $("epic-history-list");
  list.replaceChildren();
  $("epic-history-empty").classList.toggle("hidden", runs.length > 0);
  const q = query();
  let hits = 0;
  for (const run of runs) {
    const items = visibleItems(run);
    if (q && !items.length) continue;
    hits++;
    list.appendChild(runBox(run, items));
  }
  if (q && !hits) {
    const none = document.createElement("div");
    none.className = "empty-note epic-empty";
    none.textContent = "검색에 맞는 기록이 없습니다.";
    list.appendChild(none);
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function actionButton(cls, label, data) {
  const b = el("button", `epic-act ${cls}`, label);
  b.type = "button";
  b.disabled = job.busy;
  Object.assign(b.dataset, data);
  return b;
}

function runBox(run, items) {
  const box = el("details", "epic-box epic-run");
  box.dataset.run = run.id;
  box.open = opened.has(run.id);
  const filtered = Boolean(query());
  const active = items.filter(isActive);
  const reverted = run.items.filter((it) => !isActive(it)).length;

  const summary = el("summary", null, `${fmtTime(run.at)}  ${KIND_LABEL[run.kind] ?? "변경"} ${run.items.length}건`);
  const counts = [`적용 중 ${run.items.length - reverted}건`];
  if (reverted) counts.push(`취소함 ${reverted}건`);
  if (filtered) counts.push(`검색에 맞는 ${items.length}건`);
  summary.appendChild(el("span", "epic-sec-count", counts.join(", ")));
  box.appendChild(summary);

  const bar = el("div", "epic-sec-bar");
  bar.appendChild(el("span", "epic-sec-desc", run.kind === "move"
    ? "다른 에픽에서 옮긴 묶음이고, 취소하면 원래 에픽으로 돌아갑니다."
    : "상위가 없던 이슈를 연결한 묶음이고, 취소하면 상위가 다시 비워집니다."));
  if (active.length) {
    // 내역은 읽기만 하므로 다른 작업이 도는 중에도 누를 수 있게 둔다.
    const report = el("button", "btn-report-run", "내역");
    report.type = "button";
    report.dataset.run = run.id;
    report.title = "이 묶음에서 지금 적용 중인 변경을 에픽별 건수로 정리한 보고용 글을 띄웁니다";
    bar.appendChild(report);
    const label = filtered ? `보이는 ${active.length}건 취소` : `${active.length}건 모두 취소`;
    bar.appendChild(actionButton("btn-revert-run", label, { run: run.id }));
  }
  box.appendChild(bar);

  // 표는 펼칠 때 그린다.
  // 기록이 쌓여도 닫힌 묶음은 머리만 그려서 화면이 무거워지지 않게 한다.
  if (box.open) box.appendChild(runTable(run, items));
  box.addEventListener("toggle", () => {
    if (!box.open) { opened.delete(run.id); return; }
    opened.add(run.id);
    if (!box.querySelector("table")) box.appendChild(runTable(run, visibleItems(run)));
  });
  return box;
}

// 묶음 안에서는 들어간 에픽별로 다시 묶는다.
// "26.03 TASKS에 넣은 건 다 아니다" 같은 지적에 그 에픽 단위로 바로 취소할 수 있게 하려는 것이다.
function runTable(run, items) {
  const table = el("table", "epic-table epic-history-table");
  const head = el("thead");
  const hr = el("tr");
  hr.append(el("th", "col-key", "키"), el("th", null, "제목"), el("th", "col-from", "원래 상위"), el("th", "col-act"));
  head.appendChild(hr);
  const tbody = el("tbody");
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.to)) groups.set(it.to, []);
    groups.get(it.to).push(it);
  }
  for (const [to, list] of groups) {
    const tr = el("tr", "epic-group");
    const td = el("td", "clickable", `→ ${to} ${list[0].toSummary ?? ""} (${list.length}건)`);
    td.colSpan = 3;
    td.dataset.open = to;
    td.title = "이 에픽을 Jira에서 열기";
    const tdA = el("td", "col-act");
    const active = list.filter(isActive);
    if (active.length) tdA.appendChild(actionButton("btn-revert-group", `${active.length}건 취소`, { run: run.id, to }));
    tr.append(td, tdA);
    tbody.appendChild(tr);
    for (const it of list) tbody.appendChild(itemRow(run, it));
  }
  table.append(head, tbody);
  return table;
}

function itemRow(run, it) {
  const tr = el("tr");
  tr.dataset.key = it.key;
  if (!isActive(it)) tr.classList.add("is-off");
  const key = el("td", "col-key clickable", it.key);
  key.title = "Jira에서 열기";
  const title = el("td", "col-summary", it.summary ?? "");
  if (it.note && isActive(it)) title.appendChild(el("div", "epic-note", it.note));
  const from = el("td", "col-from", it.from ? `${it.from} ${it.fromSummary ?? ""}` : "없음");
  const act = el("td", "col-act");
  if (isActive(it)) act.appendChild(actionButton("btn-revert-item", "취소", { run: run.id, key: it.key }));
  else act.textContent = `취소함 ${fmtTime(it.revertedAt)}`;
  tr.append(key, title, from, act);
  return tr;
}

// ── 취소 ─────────────────────────────

function setBusy(on) {
  job.busy = on;
  job.stop = false;
  const stop = $("btn-epic-history-stop");
  stop.classList.toggle("hidden", !on);
  stop.disabled = false;
  stop.textContent = "중지";
  if (on) {
    for (const b of document.querySelectorAll("#epic-history-view button:not(#btn-epic-history-stop)")) b.disabled = true;
  }
}

function status(text) {
  $("epic-history-status").textContent = text;
}

function revertConfirmText(targets) {
  const lines = [];
  if (targets.length === 1) {
    const it = targets[0];
    lines.push(
      `${it.key}의 상위를 바꾸기 전으로 돌립니다.`,
      "",
      `지금: ${it.to} ${it.toSummary ?? ""}`,
      `돌릴 곳: ${it.from ? `${it.from} ${it.fromSummary ?? ""}` : "상위 없음"}`,
    );
  } else {
    lines.push(`${targets.length}건의 상위를 바꾸기 전으로 돌립니다.`, "");
    const detach = targets.filter((it) => !it.from);
    const back = targets.filter((it) => it.from);
    if (detach.length) lines.push(`- 원래 상위가 없던 ${detach.length}건은 상위를 뗍니다`);
    if (back.length) {
      lines.push(`- 다른 에픽에 있던 ${back.length}건은 그 에픽으로 돌려놓습니다`);
      const byFrom = [...countBy(back, (it) => it.from)].sort((a, b) => b[1] - a[1]);
      for (const [key, n] of byFrom.slice(0, 8)) {
        lines.push(`    ${key} ${back.find((it) => it.from === key).fromSummary ?? ""} (${n}건)`);
      }
      if (byFrom.length > 8) lines.push(`    그 밖에 에픽 ${byFrom.length - 8}개`);
    }
  }
  lines.push(
    "",
    "그 사이 누군가 상위를 다시 바꾼 이슈는 건드리지 않습니다.",
    "알림 메일은 끄고 보내 봅니다. 권한이 없어 거절되면 다시 묻습니다.",
    "",
    "진행할까요?",
  );
  return lines.join("\n");
}

// 한 묶음 안의 이슈들을 바꾸기 전 상위로 돌린다.
// 지금도 우리가 넣은 에픽 아래에 있는 이슈만 돌린다.
// 브리지가 쓰기 직전에 이슈를 다시 읽어 확인하고, 그 사이 바뀐 이슈는 사유만 남기고 건드리지 않는다.
// 쓰고 나서도 다시 읽어 실제로 바뀐 것만 취소함으로 적는다.
export async function revertKeys(runId, keys) {
  if (job.busy) { snackBusy(); return; }
  const run = (await getEpicRuns()).find((r) => r.id === runId);
  const want = new Set(keys);
  const targets = (run?.items ?? []).filter((it) => isActive(it) && want.has(it.key));
  if (!targets.length) {
    showSnackbar("취소할 변경이 없습니다.", { kind: "error" });
    return;
  }
  if (!confirm(revertConfirmText(targets))) return;
  const tab = await findJiraTab();
  if (!tab) { snackNoJiraTab(); return; }

  const at = new Date().toISOString();
  const changes = [];
  const items = targets.map((it) => ({ key: it.key, to: it.from, toSummary: it.fromSummary, expect: it.to }));
  let done = 0, failed = 0, skipped = 0;
  let out = { notified: false, error: null };
  setBusy(true);
  try {
    out = await applyParents(tab.id, items, async (item, res) => {
      // 건마다 바로 기록한다.
      // 도중에 패널이 닫혀도 무엇을 이미 취소했는지 남아 있어야 한다.
      if (res.ok) {
        done++;
        await markEpicRun(runId, { reverted: [item.key], at });
        changes.push({ key: item.key, parentKey: item.to ?? null, parentSummary: item.toSummary ?? "" });
      } else if (res.skipped) {
        skipped++;
        await markEpicRun(runId, { notes: new Map([[item.key, res.error]]) });
        if (!res.missing) changes.push({ key: item.key, parentKey: res.current ?? null, parentSummary: res.currentSummary ?? "" });
      } else {
        failed++;
        await markEpicRun(runId, { notes: new Map([[item.key, `취소 실패: ${res.error}`]]) });
      }
      status(`취소 ${done + failed + skipped}/${items.length}${failed ? `, 실패 ${failed}` : ""}`);
    });
  } finally {
    setBusy(false);
    if (changes.length) announce(EV_PARENTS, changes);
    await refreshEpicHistory();
    const left = items.length - done - failed - skipped;
    const text = resultText("취소", done, failed, left, out, skipped);
    status(text);
    showSnackbar(text, { kind: failed || left || skipped || out.error ? "error" : "ok", duration: 9000 });
  }
}

// 기록을 Jira의 지금 상태와 맞춘다.
// 취소했다고 적었는데 Jira에는 반영되지 않은 건을 적용 중으로 되돌려서 다시 취소할 수 있게 한다.
// Jira에서 직접 상위를 바꾼 건에는 사유를 적어 둔다.
async function handleReconcile() {
  if (job.busy) { snackBusy(); return; }
  const keys = [...new Set(runs.flatMap((r) => r.items.map((it) => it.key)))];
  if (!keys.length) return;
  const tab = await findJiraTab();
  if (!tab) { snackNoJiraTab(); return; }

  let message = null;
  setBusy(true);
  try {
    status(`Jira의 지금 상위를 확인하는 중 (${keys.length}건)`);
    const cur = await fetchCurrentParents(tab.id, keys);
    if (!cur.ok) {
      message = { text: `Jira를 확인하지 못했습니다: ${cur.error}`, kind: "error" };
      return;
    }
    const plan = reconcileRuns([...runs].reverse(), cur.parents);
    let restored = 0, drifted = 0;
    for (const [runId, { restore, notes }] of plan) {
      if (!restore.length && !notes.size) continue;
      await markEpicRun(runId, { restored: restore, notes });
      restored += restore.length;
      drifted += [...notes.entries()].filter(([k, v]) => v && !restore.includes(k)).length;
    }
    const parts = [];
    if (restored) parts.push(`취소가 Jira에 반영되지 않았던 ${restored}건을 적용 중으로 되돌렸습니다. 다시 취소하세요.`);
    if (drifted) parts.push(`Jira에서 상위가 따로 바뀐 ${drifted}건에 사유를 적었습니다.`);
    message = parts.length
      ? { text: parts.join(" "), kind: restored ? "error" : "ok" }
      : { text: "기록이 Jira와 맞습니다.", kind: "ok" };
  } finally {
    setBusy(false);
    await refreshEpicHistory();
    if (message) {
      status(message.text);
      showSnackbar(message.text, { kind: message.kind, duration: 9000 });
    }
  }
}

// 묶음에서 아직 적용 중인 건을 모두 취소한다.
// 연결 화면의 [이번 묶음 취소]가 부른다.
export async function revertRun(runId) {
  const run = (await getEpicRuns()).find((r) => r.id === runId);
  await revertKeys(runId, (run?.items ?? []).filter(isActive).map((it) => it.key));
}

function onListClick(e) {
  const report = e.target.closest("button.btn-report-run");
  if (report) {
    const run = runs.find((r) => r.id === report.dataset.run);
    if (run) reportRun(run);
    return;
  }
  const btn = e.target.closest("button.epic-act");
  if (btn) {
    const run = runs.find((r) => r.id === btn.dataset.run);
    if (!run) return;
    const scope = visibleItems(run).filter(isActive);
    if (btn.classList.contains("btn-revert-item")) revertKeys(run.id, [btn.dataset.key]);
    else if (btn.classList.contains("btn-revert-group")) revertKeys(run.id, scope.filter((it) => it.to === btn.dataset.to).map((it) => it.key));
    else revertKeys(run.id, scope.map((it) => it.key));
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

// 지금 적용 중인 변경 전체를 에픽별로 정리한다.
// 여러 번 나눠 실행했거나 일부를 취소했어도 최종 상태로 센다.
// 이슈마다 최종 상태는 기록 전체로 먼저 정하고, 검색은 그 뒤에 거른다.
// 먼저 거르면 같은 이슈의 다른 기록이 빠져서 처음 상위나 마지막 상위를 잘못 읽는다.
function handleReport() {
  const q = query();
  const all = mergeChanges([...runs].reverse());
  const items = q ? all.filter((it) => matches(it, q)) : all;
  showEpicReport({
    title: "추가 내역",
    lead: `지금 적용 중인 변경 ${items.length}건 기준입니다.${q ? ` 검색어 "${q}"에 맞는 것만 셌습니다.` : ""}`,
    items,
  });
}

// 지금 취소된 상태인 변경을 에픽별로 세고, 밑에 무엇을 취소했는지 이슈 목록을 붙인다.
function handleRevertReport() {
  const q = query();
  const all = latestReverted([...runs].reverse());
  const items = q ? all.filter((it) => matches(it, q)) : all;
  const times = items.map((it) => it.revertedAt).sort();
  showEpicReport({
    title: "취소 내역",
    lead: items.length
      ? `지금 취소된 상태인 ${items.length}건 기준입니다. 취소한 때는 ${fmtTime(times[0])}부터 ${fmtTime(times.at(-1))}까지입니다.`
        + (q ? ` 검색어 "${q}"에 맞는 것만 셌습니다.` : "")
      : "",
    text: formatRevertReport(items),
  });
}

function reportRun(run) {
  const q = query();
  const items = visibleItems(run).filter(isActive);
  showEpicReport({
    title: `${fmtTime(run.at)} ${KIND_LABEL[run.kind] ?? "변경"} 묶음 내역`,
    lead: `이 묶음에서 지금 적용 중인 ${items.length}건 기준입니다.${q ? ` 검색어 "${q}"에 맞는 것만 셌습니다.` : ""}`,
    items,
  });
}

async function handlePrune() {
  if (job.busy) { snackBusy(); return; }
  const reverted = runs.reduce((n, r) => n + r.items.filter((it) => !isActive(it)).length, 0);
  // 취소 내역은 이 기록으로 만든다.
  // 지우면 보고에 쓸 취소 내역도 같이 사라지므로 한 번 묻는다.
  if (!confirm(
    `취소한 ${reverted}건의 기록을 지웁니다.\n`
    + "지우면 [취소 내역]에도 나오지 않습니다. 보고할 내용이 있으면 먼저 [취소 내역]에서 복사해 두세요.\n\n"
    + "Jira 쪽 이슈는 바뀌지 않습니다.\n\n지울까요?"
  )) return;
  await pruneEpicRuns();
  await refreshEpicHistory();
  showSnackbar("이미 취소한 항목을 기록에서 지웠습니다.", { kind: "ok" });
}

async function handleClear() {
  if (job.busy) { snackBusy(); return; }
  const active = runs.reduce((n, r) => n + r.items.filter(isActive).length, 0);
  if (!confirm(
    `변경 기록을 모두 지웁니다.\n\n`
    + (active ? `지금 적용 중인 ${active}건의 기록도 지워져서, 그 변경은 이 화면에서 취소할 수 없게 됩니다.\n` : "")
    + "Jira 쪽 이슈는 바뀌지 않습니다.\n\n지울까요?"
  )) return;
  await pruneEpicRuns({ all: true });
  await refreshEpicHistory();
  showSnackbar("변경 기록을 모두 지웠습니다.", { kind: "ok" });
}

export async function initEpicHistory() {
  $("epic-history-list").addEventListener("click", onListClick);
  $("btn-epic-history-report").addEventListener("click", handleReport);
  $("btn-epic-history-revert-report").addEventListener("click", handleRevertReport);
  $("btn-epic-history-reconcile").addEventListener("click", handleReconcile);
  $("btn-epic-history-prune").addEventListener("click", handlePrune);
  $("btn-epic-history-clear").addEventListener("click", handleClear);
  $("btn-epic-history-stop").addEventListener("click", () => {
    job.stop = true;
    $("btn-epic-history-stop").disabled = true;
    $("btn-epic-history-stop").textContent = "멈추는 중";
  });
  let timer = null;
  $("epic-history-search").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(render, 150);
  });
  document.addEventListener(EV_HISTORY, refreshEpicHistory);
  await refreshEpicHistory();
}
