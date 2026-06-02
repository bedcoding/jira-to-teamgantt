import {
  getAll, getSettings, setSettings,
  getSyncQueue, setSyncQueue, clearSyncQueue,
  getManualChecked, setManualChecked,
} from "../lib/storage.js";
import { showSnackbar } from "./snackbar.js";

function $(id) { return document.getElementById(id); }

const DATE_LABEL = {
  jiraUpdated: "업데이트",
  jiraCreated: "생성일",
  tgStart:     "시작일",
  tgEnd:       "종료일",
};

// "2026년 5월 28일 ..." 또는 ISO → "YYYY-MM-DD"
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

function rowDate(r, source) {
  switch (source) {
    case "jiraCreated": return toIsoDate(r.jira?.created);
    case "tgStart":     return toIsoDate(r.tg?.start);
    case "tgEnd":       return toIsoDate(r.tg?.end);
    case "jiraUpdated":
    default:            return toIsoDate(r.jira?.updated);
  }
}

function classifyRows(jiraByKey, tgByKey, tgWithoutKey) {
  const rows = [];
  const tgUsed = new Set();
  for (const [key, jira] of Object.entries(jiraByKey)) {
    const tg = tgByKey[key];
    if (tg) { rows.push({ kind: "matched", key, jira, tg }); tgUsed.add(key); }
    else    { rows.push({ kind: "jira-only", key, jira, tg: null }); }
  }
  for (const [key, tg] of Object.entries(tgByKey)) {
    if (tgUsed.has(key)) continue;
    rows.push({ kind: "tg-orphan-with-key", key, jira: null, tg });
  }
  for (const tg of tgWithoutKey) {
    rows.push({ kind: "tg-orphan-no-key", key: null, jira: null, tg });
  }
  return rows;
}

// 'Jira만' 행의 TeamGantt 컬럼만 부분 갱신.
// 전체 표 재렌더 시 발생하는 깜빡임/스크롤 튐을 피하려고 td 단위로 그린다.
function renderTgCellForJiraOnly(tdT, r, confirmed) {
  if (confirmed) {
    tdT.innerHTML = `<button class="sync-mark sync-mark-confirmed" data-tip="클릭해서 해제">✅ 보정 완료</button>`;
  } else {
    tdT.innerHTML = `<button class="sync-mark sync-mark-done" data-tip="클릭해서 보정 완료로 표시">✓ 등록 완료</button>`;
  }
  tdT.querySelector("button").addEventListener("click", async () => {
    const q = await getSyncQueue();
    const set = new Set(q.confirmedKeys ?? []);
    const nextConfirmed = !set.has(r.key);
    if (nextConfirmed) set.add(r.key);
    else               set.delete(r.key);
    q.confirmedKeys = [...set];
    await setSyncQueue(q);
    renderTgCellForJiraOnly(tdT, r, nextConfirmed); // 전체 재렌더 안 함.
  });
}

// 단축키 한 번 = 한 행 pending → done으로 승격되고, 새 행 pending. 둘 다 td만 갈아끼움.
// 이렇게 하면 전체 표를 다시 그리지 않아 스크롤·체크박스 깜빡임이 없다.
async function updateRowsAfterInject(newPendingKey) {
  const q = await getSyncQueue();
  // 1) 직전 pending 였던 행을 done으로. q.doneKeys에 방금 추가됐을 것이다.
  //    (service_worker가 doneKeys에 push한 직후 SYNC_INJECTED를 보낸다.)
  const justDoneKey = q.doneKeys[q.doneKeys.length - 1];
  if (justDoneKey) {
    const tr = document.querySelector(`#compare-table tr[data-jira-only-key="${cssEscape(justDoneKey)}"]`);
    const tdT = tr?.children[3]; // 1키, 2상태, 3제목, 4 TG, 5 날짜  (인덱스 0~4)
    if (tdT) {
      const summaryText = tr?.children[2]?.textContent ?? "";
      renderTgCellForJiraOnly(tdT, { key: justDoneKey, jira: { summary: summaryText } }, q.confirmedKeys?.includes(justDoneKey));
    }
  }
  // 2) 새 pending 행을 📋 입력됨 으로.
  if (newPendingKey) {
    const tr = document.querySelector(`#compare-table tr[data-jira-only-key="${cssEscape(newPendingKey)}"]`);
    const tdT = tr?.children[3];
    if (tdT) {
      const summaryText = tr?.children[2]?.textContent ?? "";
      renderTgCellPending(tdT, { key: newPendingKey, jira: { summary: summaryText } });
    }
  }
}

function cssEscape(s) {
  return String(s).replace(/"/g, '\\"');
}

// 빈 TeamGantt 셀 — 사용자가 클릭해서 직접 ✓ 표시 가능. 동기화 큐와 무관.
// 단, 큐가 진행 중이면 클릭이 "건너뛰기 + 등록 완료" 로 동작 (자동 흐름과 통합).
function renderTgCellManual(tdT, r, checked) {
  if (checked) {
    tdT.innerHTML = `<button class="sync-mark sync-mark-manual" data-tip="수동 체크 — 클릭해서 해제">✓</button>`;
  } else {
    tdT.innerHTML = `<button class="sync-mark sync-mark-empty" data-tip="클릭해서 ✓ 체크">—</button>`;
  }
  tdT.querySelector("button").addEventListener("click", async () => {
    const q = await getSyncQueue();
    const inQueue = q.items.some((it) => it.key === r.key);
    if (inQueue) {
      // 동기화 진행 중 + 이 항목이 큐에 있음 → 건너뛰기 + 등록 완료 처리.
      q.items = q.items.filter((it) => it.key !== r.key);
      q.doneKeys.push(r.key);
      await setSyncQueue(q);
      await refreshSyncUi();
      renderTgCellForJiraOnly(tdT, r, false);
      return;
    }
    // 큐 밖이면 수동 ✓ 토글 (기존 동작).
    const set = await getManualChecked();
    if (set.has(r.key)) set.delete(r.key);
    else                set.add(r.key);
    await setManualChecked(set);
    renderTgCellManual(tdT, r, set.has(r.key));
  });
}

function renderTgCellPending(tdT, r) {
  tdT.innerHTML = `<span class="sync-pending-mark">📋 입력됨</span> <button class="sync-pending-cancel" data-tip="입력만 하고 등록 안 한 경우 — 이 표시를 해제">×</button>`;
  tdT.querySelector(".sync-pending-cancel").addEventListener("click", async () => {
    const q = await getSyncQueue();
    if (q.pendingKey === r.key) {
      q.items.unshift({ key: r.key, text: `[${r.key}] ${r.jira?.summary ?? ""}` });
      q.pendingKey = null;
      await setSyncQueue(q);
      await refreshSyncUi();
      tdT.innerHTML = "—";
      tdT.style.color = "#bbb";
      showSnackbar("입력됨 해제: 다음 단축키에서 다시 시도하세요.", { kind: "ok" });
    }
  });
}

function renderRow(r, dateSource, doneKeys, pendingKey, confirmedKeys, manualChecked) {
  const tr = document.createElement("tr");
  tr.className = r.kind;
  const tdKey = document.createElement("td");
  const tdS   = document.createElement("td");
  const tdJ   = document.createElement("td");
  const tdT   = document.createElement("td");
  const tdD   = document.createElement("td");

  tdS.textContent = r.jira?.status ?? "—";
  if (!r.jira?.status) tdS.style.color = "#bbb";
  tdS.classList.add("col-status");

  tdKey.textContent = r.key ?? "";
  if (r.key && r.jira) {
    tdKey.classList.add("clickable");
    tdKey.setAttribute("data-tip", "클릭: 새 탭에서 Jira 이슈 열기");
    tdKey.addEventListener("click", async () => {
      const s = await getSettings();
      chrome.tabs.create({ url: `https://${s.jiraDomain}/browse/${r.key}` });
    });
  }

  if (r.jira) {
    tdJ.textContent = r.jira.summary ?? "";
    tdJ.classList.add("clickable");
    tdJ.setAttribute("data-tip", "클릭: [KEY] summary 형식으로 클립보드 복사");
    tdJ.addEventListener("click", () => {
      const txt = `[${r.jira.key}] ${r.jira.summary ?? ""}`;
      navigator.clipboard.writeText(txt);
      showSnackbar(`복사: ${txt}`, { kind: "ok", duration: 2000 });
    });
  } else {
    tdJ.textContent = "—"; tdJ.style.color = "#bbb";
  }

  if (r.tg) {
    tdT.textContent = r.tg.rawTitle ?? "";
    tdT.classList.add("clickable");
    tdT.setAttribute("data-tip", "클릭: 제목 클립보드 복사");
    tdT.addEventListener("click", () => {
      navigator.clipboard.writeText(r.tg.rawTitle ?? "");
      showSnackbar(`복사: ${r.tg.rawTitle}`, { kind: "ok", duration: 2000 });
    });
  } else if (r.kind === "jira-only" && doneKeys?.has(r.key)) {
    tr.dataset.jiraOnlyKey = r.key;
    renderTgCellForJiraOnly(tdT, r, confirmedKeys?.has(r.key));
  } else if (r.kind === "jira-only" && pendingKey === r.key) {
    tr.dataset.jiraOnlyKey = r.key;
    renderTgCellPending(tdT, r);
  } else if (r.kind === "jira-only") {
    tr.dataset.jiraOnlyKey = r.key;
    renderTgCellManual(tdT, r, manualChecked?.has(r.key));
  } else {
    tdT.textContent = "—"; tdT.style.color = "#bbb";
  }

  const dv = rowDate(r, dateSource);
  if (dv) {
    tdD.textContent = dv;
  } else {
    tdD.textContent = "—";
    tdD.style.color = "#bbb";
  }

  tr.append(tdKey, tdS, tdJ, tdT, tdD);
  return tr;
}

// 화면 정렬과 동일. 동기화 큐도 이 순서 그대로 채워 넣는다.
function sortRowsForDisplay(rows, dateSource) {
  const kindOrder = { matched: 0, "jira-only": 0, "tg-orphan-with-key": 1, "tg-orphan-no-key": 2 };
  rows.sort((a, b) => {
    const ka = kindOrder[a.kind] ?? 9, kb = kindOrder[b.kind] ?? 9;
    if (ka !== kb) return ka - kb;
    const da = rowDate(a, dateSource);
    const db = rowDate(b, dateSource);
    if (!da && db) return 1;
    if (da && !db) return -1;
    return db.localeCompare(da);
  });
}

// 상태 칩으로 'Jira만' 행을 필터. include가 비어 있으면 모두 통과.
// 다른 kind(매칭/고아)는 영향 없음.
function applyStatusFilter(rows, includeStatuses) {
  const include = new Set(includeStatuses ?? []);
  if (include.size === 0) return rows;
  return rows.filter((r) => {
    if (r.kind !== "jira-only") return true;
    return include.has(r.jira?.status);
  });
}

// 종류 칩으로 매칭/매칭 안됨 필터. include가 비어 있으면 전부 통과.
// 'jira-only'(Jira에만 있음)와 'tg-orphan-*'(TeamGantt에만 있음) 모두 '매칭 안됨'으로 묶는다.
const KIND_MAP = {
  matched:                "매칭",
  "jira-only":            "매칭 안됨",
  "tg-orphan-with-key":   "매칭 안됨",
  "tg-orphan-no-key":     "매칭 안됨",
};
function applyKindFilter(rows, includeKinds) {
  const include = new Set(includeKinds ?? []);
  if (include.size === 0) return rows;
  return rows.filter((r) => include.has(KIND_MAP[r.kind] ?? r.kind));
}

function applySearch(rows, q) {
  if (!q) return rows;
  const lo = q.toLowerCase();
  return rows.filter((r) => {
    const hay = [r.key, r.jira?.summary, r.tg?.rawTitle].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(lo);
  });
}

async function renderCompare() {
  // 표 재렌더 시 사이드 패널 스크롤이 0으로 튀는 걸 방지.
  // 단축키 → SYNC_INJECTED → renderCompare 흐름에서 특히 거슬림.
  const scroller = document.scrollingElement ?? document.documentElement;
  const savedScroll = scroller.scrollTop;

  const tbody = document.querySelector("#compare-table tbody");
  tbody.replaceChildren();
  const { jiraIssues, tgTasks, settings } = await getAll();
  const dateSource = settings.compareDateSource ?? "jiraUpdated";
  const syncQ = await getSyncQueue();
  const doneKeys = new Set(syncQ.doneKeys ?? []);
  const confirmedKeys = new Set(syncQ.confirmedKeys ?? []);
  const pendingKey = syncQ.pendingKey ?? null;
  const manualChecked = await getManualChecked();
  const tgByKey = {};
  const tgWithoutKey = [];
  for (const task of Object.values(tgTasks)) {
    if (task.jiraKey) tgByKey[task.jiraKey] = task;
    else tgWithoutKey.push(task);
  }
  let rows = classifyRows(jiraIssues, tgByKey, tgWithoutKey);
  const q = $("compare-search").value.trim();
  rows = applySearch(rows, q);
  rows = applyStatusFilter(rows, settings.syncIncludeStatuses ?? []);
  rows = applyKindFilter(rows, settings.syncIncludeKinds ?? []);
  sortRowsForDisplay(rows, dateSource);

  for (const r of rows) tbody.appendChild(renderRow(r, dateSource, doneKeys, pendingKey, confirmedKeys, manualChecked));

  $("compare-date-col").textContent = DATE_LABEL[dateSource] ?? "날짜";

  const matched   = rows.filter((r) => r.kind === "matched").length;
  const jiraOnly  = rows.filter((r) => r.kind === "jira-only").length;
  const orphanK   = rows.filter((r) => r.kind === "tg-orphan-with-key").length;
  const orphanNK  = rows.filter((r) => r.kind === "tg-orphan-no-key").length;

  // 'Jira만' 행이 있으면 동기화 바 노출.
  const syncBar = $("sync-bar");
  if (jiraOnly > 0) syncBar.classList.remove("hidden");
  else              syncBar.classList.add("hidden");

  renderKindChips(settings.syncIncludeKinds ?? [], { matched, unmatched: jiraOnly + orphanK + orphanNK });
  await renderStatusChips(jiraIssues, settings.syncIncludeStatuses ?? []);

  // 새 행 만들어 붙인 뒤 스크롤 복원. 다음 프레임에 해야 DOM 반영 후 정확히 적용됨.
  requestAnimationFrame(() => {
    scroller.scrollTop = savedScroll;
  });
}

// 매칭/매칭 안됨/TeamGantt만 3가지 종류 칩 노출. 비어 있으면 전체 ON으로 본다.
function renderKindChips(includeKinds, counts) {
  const wrap = $("include-kind-chips");
  if (!wrap) return;
  const include = new Set(includeKinds);
  const KINDS = [
    { key: "매칭",      count: counts.matched },
    { key: "매칭 안됨", count: counts.unmatched },
  ];
  wrap.innerHTML = KINDS.map(({ key, count }) => {
    const on = include.size === 0 || include.has(key);
    return `<button class="status-chip ${on ? "on" : "off"}" data-kind="${escapeHtml(key)}">${escapeHtml(key)} ${count}</button>`;
  }).join("") + `<button class="status-chip-clear" data-tip="모든 종류 표시(=필터 해제)">전체</button>`;
}

// 'Jira만' 행에 등장하는 상태들만 칩으로 노출. 사용자가 클릭하면 토글 후 저장 + 재렌더.
async function renderStatusChips(jiraIssues, includeStatuses) {
  const wrap = $("include-status-chips");
  if (!wrap) return;
  // 'Jira만' 후보(= TG 에 매칭 없는 Jira)의 상태 모음.
  const { tgTasks } = await getAll();
  const tgKeys = new Set(Object.values(tgTasks).map((t) => t.jiraKey).filter(Boolean));
  const statusSet = new Set();
  for (const j of Object.values(jiraIssues)) {
    if (tgKeys.has(j.key)) continue;
    if (j.status) statusSet.add(j.status);
  }
  const statuses = [...statusSet].sort();
  if (statuses.length === 0) {
    wrap.innerHTML = `<span class="status-chips-empty">동기화 대상 없음</span>`;
    return;
  }
  const include = new Set(includeStatuses);
  wrap.innerHTML = statuses.map((s) => {
    const on = include.size === 0 || include.has(s);
    return `<button class="status-chip ${on ? "on" : "off"}" data-status="${escapeHtml(s)}">${escapeHtml(s)}</button>`;
  }).join("") + `<button class="status-chip-clear" data-tip="모든 상태 포함(=필터 해제)">전체</button>`;
}

function buildQueueFromJiraOnly(rows, includeStatuses) {
  const include = new Set(includeStatuses ?? []);
  return rows
    .filter((r) => r.kind === "jira-only" && r.jira)
    .filter((r) => include.size === 0 || include.has(r.jira.status))
    .map((r) => ({ key: r.key, text: `[${r.key}] ${r.jira.summary ?? ""}` }));
}

async function refreshSyncUi() {
  const q = await getSyncQueue();
  const info = $("sync-info");
  const startBtn = $("btn-sync-start");
  const stopBtn  = $("btn-sync-stop");
  const next     = $("sync-next");
  const nextText = $("sync-next-text");
  const statusLine = $("sync-status-card");
  const progressFill = $("sync-progress-fill");

  const remaining = q.items.length;
  const done = q.doneKeys.length;
  const pendingCount = q.pendingKey ? 1 : 0;
  const total = done + remaining + pendingCount;

  const setProgress = (cur, tot) => {
    const pct = tot > 0 ? Math.min(100, Math.round((cur / tot) * 100)) : 0;
    progressFill.style.width = pct + "%";
    progressFill.classList.toggle("complete", tot > 0 && cur >= tot);
  };

  if (remaining === 0 && done === 0 && pendingCount === 0) {
    info.textContent = "";
    startBtn.textContent = "동기화 시작";
    startBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    next.classList.add("hidden");
    statusLine.classList.add("hidden");
    setProgress(0, 0);
    return;
  }
  statusLine.classList.remove("hidden");
  if (remaining === 0 && pendingCount === 0) {
    info.textContent = `완료 ${done}건`;
    startBtn.textContent = "다시 시작";
    startBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    next.classList.add("hidden");
    setProgress(done, done);
    return;
  }
  if (remaining === 0 && pendingCount === 1) {
    // 마지막 항목이 pending — '저장 완료' 명시적 확정 필요.
    info.textContent = `진행 ${done} / ${total} · 마지막 항목 입력됨 (Enter 후 [완료] 버튼)`;
    startBtn.textContent = "완료";
    startBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden"); // 시작/중지/완료 중 한 개만.
    next.classList.add("hidden");
    setProgress(done, total);
    return;
  }
  info.textContent = `진행 ${done} / ${total}`;
  startBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");
  next.classList.remove("hidden");
  nextText.textContent = q.items[0].text;
  setProgress(done, total);
}

async function startSync() {
  // '완료' 버튼 역할: 마지막 pending을 done으로 승격 + 큐 종료.
  const cur = await getSyncQueue();
  if (cur.items.length === 0 && cur.pendingKey) {
    cur.doneKeys.push(cur.pendingKey);
    cur.pendingKey = null;
    await setSyncQueue(cur);
    await refreshSyncUi();
    await renderCompare();
    showSnackbar("동기화 완료 처리됨.", { kind: "ok" });
    return;
  }
  const { jiraIssues, tgTasks, settings } = await getAll();
  const dateSource = settings.compareDateSource ?? "jiraUpdated";
  const tgByKey = {};
  const tgWithoutKey = [];
  for (const task of Object.values(tgTasks)) {
    if (task.jiraKey) tgByKey[task.jiraKey] = task;
    else tgWithoutKey.push(task);
  }
  let rows = classifyRows(jiraIssues, tgByKey, tgWithoutKey);
  const q = $("compare-search").value.trim();
  rows = applySearch(rows, q);
  rows = applyStatusFilter(rows, settings.syncIncludeStatuses ?? []);
  rows = applyKindFilter(rows, settings.syncIncludeKinds ?? []);
  sortRowsForDisplay(rows, dateSource);
  const items = buildQueueFromJiraOnly(rows, settings.syncIncludeStatuses);
  if (items.length === 0) {
    showSnackbar("등록할 'Jira만' 행이 없습니다.", { kind: "warn" });
    return;
  }
  await setSyncQueue({ items, pendingKey: null, doneKeys: [], confirmedKeys: [] });
  await refreshSyncUi();
  const hk = await getHotkeyLabel();
  showSnackbar(
    `동기화 시작 (${items.length}건)\nTeamGantt 페이지에서 [추가] 버튼을 누른 뒤 ${hk} 를 누르면 다음 작업이 입력됩니다.`,
    { kind: "ok", duration: 5000 },
  );
}

// chrome.commands 에서 현재 OS 단축키. ⇧⌘ 같은 기호 대신 풀어 표기.
// 사용자가 chrome://extensions/shortcuts 에서 바꿔도 자동 반영.
async function getHotkeyLabel() {
  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find((x) => x.name === "inject-next-task");
    if (c?.shortcut) return prettifyShortcut(c.shortcut);
  } catch {}
  return "단축키";
}

// "⇧⌘X" 같은 Mac 기호를 "Cmd+Shift+X" 로 풀어 씀. 이미 "Ctrl+..." 처럼
// 풀려 있는 경우는 그대로 유지.
function prettifyShortcut(s) {
  return s
    .replace(/⌃/g, "Ctrl+")
    .replace(/⌥/g, "Alt+")
    .replace(/⇧/g, "Shift+")
    .replace(/⌘/g, "Cmd+")
    .trim();
}

// manifest의 suggested_key 두 OS 값을 동시에 노출용으로 읽음.
// chrome.commands는 현재 OS 단축키만 주므로 manifest를 직접 읽는다.
async function getBothOsHotkeys() {
  try {
    const url = chrome.runtime.getURL("manifest.json");
    const m = await (await fetch(url)).json();
    const sk = m.commands?.["inject-next-task"]?.suggested_key ?? {};
    return {
      mac: prettifyShortcut(sk.mac ?? sk.default ?? ""),
      win: prettifyShortcut(sk.default ?? ""),
    };
  } catch {
    return { mac: "", win: "" };
  }
}

async function detectTaskInput() {
  const tgTabs = await chrome.tabs.query({ url: "https://app.teamgantt.com/projects/*" });
  if (tgTabs.length === 0) {
    showSnackbar("TeamGantt 탭이 열려 있지 않습니다.", { kind: "warn" });
    return;
  }
  const tab = tgTabs.find((t) => t.active) ?? tgTabs[0];
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { type: "DETECT_TASK_INPUT" });
  } catch (e) {
    showSnackbar(`[감지 실패] ${humanizeContentError(e)}`, { kind: "warn", duration: 4000 });
    return;
  }
  renderDetectResult(resp);
  openDialog("detect-result-dialog");
}

function renderDetectResult(r) {
  const body = $("detect-result-body");
  if (!r || !r.ok) {
    body.innerHTML = `<p class="detect-fail">감지 실패: ${escapeHtml(r?.error ?? "응답 없음")}</p>`;
    return;
  }
  const viewLabel = r.view === "gantt" ? "Gantt 뷰" : "List 뷰";
  const headLine = r.found
    ? `<p class="detect-ok">✓ <b>${viewLabel}</b> 에서 입력창을 찾았습니다 — selector: <code>${escapeHtml(r.finalSource)}</code></p>`
    : `<p class="detect-fail">✗ <b>${viewLabel}</b>에서 입력창을 못 찾았습니다. TeamGantt에서 [추가] 버튼을 먼저 누르고 다시 테스트해주세요.</p>`;
  const steps = r.steps.map((s) => {
    const icon = s.matched ? "✓" : "✗";
    const cls = s.matched ? "detect-step-ok" : "detect-step-ng";
    return `<li class="${cls}"><span class="detect-icon">${icon}</span> <code>${escapeHtml(s.source)}</code> — ${escapeHtml(s.info)}</li>`;
  }).join("");
  body.innerHTML = headLine + `<ol class="detect-steps">${steps}</ol>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// content script 통신 에러를 사람 말로 변환.
function humanizeContentError(e) {
  const msg = String(e?.message ?? e);
  if (msg.includes("Could not establish connection") || msg.includes("Receiving end does not exist")) {
    return "TeamGantt 페이지와 연결이 끊어졌습니다. 페이지를 새로고침해주세요.";
  }
  return msg;
}

async function stopSync() {
  // 단축키 동작만 멈춤. items만 비우고 doneKeys/confirmedKeys/pendingKey는 유지.
  // 진행 기록(✓ 등록 완료 / ✅ 보정 완료 / 📋 입력됨)은 다음 [동기화 시작]까지 보존.
  const q = await getSyncQueue();
  q.items = [];
  await setSyncQueue(q);
  await refreshSyncUi();
  showSnackbar("동기화 중지: 표시된 기록은 유지됩니다.", { kind: "ok", duration: 3000 });
  await renderCompare();
}

// 현재 큐의 맨 앞 항목을 건너뛰고 등록 완료(✓)로 승격.
// 단축키 동작과 동일하게 td만 부분 갱신해 스크롤·깜빡임을 막는다.
async function skipNext() {
  const q = await getSyncQueue();
  if (q.items.length === 0) {
    showSnackbar("건너뛸 항목이 없습니다.", { kind: "warn" });
    return;
  }
  const skipped = q.items.shift();
  q.doneKeys.push(skipped.key);
  await setSyncQueue(q);
  await refreshSyncUi();
  // 비교 표에서 그 행의 TG 셀만 ✓ 등록 완료로 교체.
  const tr = document.querySelector(`#compare-table tr[data-jira-only-key="${cssEscape(skipped.key)}"]`);
  const tdT = tr?.children[3];
  if (tdT) {
    const summaryText = tr?.children[2]?.textContent ?? "";
    renderTgCellForJiraOnly(tdT, { key: skipped.key, jira: { summary: summaryText } }, false);
  }
}

function openDialog(id) { document.getElementById(id).classList.remove("hidden"); }
function closeDialog(id) { document.getElementById(id).classList.add("hidden"); }

function wireDialogClose(id) {
  const dlg = document.getElementById(id);
  dlg.querySelectorAll(`[data-close="${id}"]`).forEach((b) =>
    b.addEventListener("click", () => closeDialog(id))
  );
  dlg.addEventListener("click", (e) => { if (e.target === dlg) closeDialog(id); });
}

export async function refreshCompareTab() {
  await renderCompare();
}

export async function initCompareTab() {
  const s = await getSettings();
  $("prefix-regex").value = s.prefixRegex ?? "";
  $("compare-date-source").value = s.compareDateSource ?? "jiraUpdated";

  $("btn-open-prefix-mgr").addEventListener("click", async () => {
    const cur = await getSettings();
    $("prefix-regex").value = cur.prefixRegex ?? "";
    openDialog("prefix-mgr-dialog");
  });
  wireDialogClose("prefix-mgr-dialog");

  $("btn-prefix-save").addEventListener("click", async () => {
    await setSettings({ prefixRegex: $("prefix-regex").value.trim() });
    closeDialog("prefix-mgr-dialog");
    showSnackbar("규칙 저장됨: [TeamGantt 수집] 다시 누르면 적용.", { kind: "ok" });
  });

  $("compare-search").addEventListener("input", () => renderCompare());
  $("compare-date-source").addEventListener("change", async () => {
    await setSettings({ compareDateSource: $("compare-date-source").value });
    renderCompare();
  });

  $("btn-sync-start").addEventListener("click", startSync);
  $("btn-sync-stop").addEventListener("click", stopSync);
  $("btn-sync-detect").addEventListener("click", detectTaskInput);
  $("btn-sync-skip").addEventListener("click", skipNext);
  wireDialogClose("detect-result-dialog");

  // 종류 칩 토글: 클릭 시 includeKinds 갱신.
  $("include-kind-chips").addEventListener("click", async (e) => {
    const target = e.target.closest("button");
    if (!target) return;
    const cur = await getSettings();
    const include = new Set(cur.syncIncludeKinds ?? []);
    if (target.classList.contains("status-chip-clear")) {
      include.clear();
    } else {
      const k = target.dataset.kind;
      if (!k) return;
      if (include.size === 0) {
        const all = [...$("include-kind-chips").querySelectorAll("button[data-kind]")]
          .map((b) => b.dataset.kind);
        for (const x of all) include.add(x);
        include.delete(k);
      } else if (include.has(k)) {
        include.delete(k);
      } else {
        include.add(k);
      }
    }
    await setSettings({ syncIncludeKinds: [...include] });
    await renderCompare();
  });

  // 상태 칩 토글: 클릭 시 includeStatuses 갱신.
  $("include-status-chips").addEventListener("click", async (e) => {
    const target = e.target.closest("button");
    if (!target) return;
    const cur = await getSettings();
    const include = new Set(cur.syncIncludeStatuses ?? []);
    if (target.classList.contains("status-chip-clear")) {
      include.clear();
    } else {
      const s = target.dataset.status;
      if (!s) return;
      // 빈 상태(=전체 포함) 였으면 현재 보이는 칩들 전부 포함으로 보고, 클릭한 것만 제외.
      if (include.size === 0) {
        const all = [...$("include-status-chips").querySelectorAll("button[data-status]")]
          .map((b) => b.dataset.status);
        for (const x of all) include.add(x);
        include.delete(s);
      } else if (include.has(s)) {
        include.delete(s);
      } else {
        include.add(s);
      }
    }
    await setSettings({ syncIncludeStatuses: [...include] });
    await renderCompare();
  });

  const hk = await getHotkeyLabel();
  $("btn-sync-start").setAttribute(
    "data-tip",
    `TeamGantt의 입력창이 떠 있는 상태에서 단축키를 누르면 Jira에만 있는 작업들을 TeamGantt에 자동 입력합니다.\n\n사용법:\n1. [동기화 시작] 클릭\n2. TeamGantt 페이지에서 (+) 버튼을 눌러서 입력창 띄우기\n3. 단축키를 누르면 누락된 항목이 자동으로 입력창에 박힘\n4. 입력창에서 포커스가 사라지면 TeamGantt에 저장`,
  );

  // sync-bar 우측 끝에 현재 OS 단축키만 작게 표시. 호버 툴팁에 다른 OS 키 안내.
  const { mac, win } = await getBothOsHotkeys();
  const badge = $("hotkey-badge");
  if (badge && (mac || win)) {
    const isMac = /Mac/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? "");
    const my    = isMac ? mac : win;
    const other = isMac ? win : mac;
    const otherLabel = isMac ? "윈도우" : "맥";
    badge.innerHTML = `<span class="hotkey-label">동기화 단축키:</span> <span class="hotkey-keys">${escapeHtml(my || "-")}</span>`;
    if (other) badge.setAttribute("data-tip", `${otherLabel}: ${other}`);
    else       badge.removeAttribute("data-tip");
  }

  // background가 주입 결과 알려주면 UI 갱신.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "SYNC_HOTKEY_FIRED") {
      // 단축키 동작 확인용. 큐가 비어있어도 떠야 한다.
      showSnackbar("단축키 인식됨", { kind: "ok", duration: 1200 });
      return;
    }
    if (msg?.type === "SYNC_INJECTED") {
      refreshSyncUi();
      updateRowsAfterInject(msg.key);
      return;
    }
    if (msg?.type === "SYNC_QUEUE_EMPTY") {
      showSnackbar("큐 비었음: [동기화 시작]을 먼저 누르세요.", { kind: "warn" });
      return;
    }
    if (msg?.type === "SYNC_NO_TG_TAB") {
      showSnackbar("TeamGantt 탭이 열려 있지 않습니다.", { kind: "warn" });
      return;
    }
    if (msg?.type === "SYNC_INJECT_FAIL") {
      showSnackbar(`[주입 실패] ${humanizeContentError({ message: msg.error })}`, { kind: "warn", duration: 4000 });
      return;
    }
  });

  await renderCompare();
  await refreshSyncUi();
}
