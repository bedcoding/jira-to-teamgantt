import {
  getAll, getSettings, setSettings,
  getSyncQueue, setSyncQueue, clearSyncQueue,
  getManualChecked, setManualChecked,
  getApiSelected, updateApiSelected, getApiCreated, addApiCreated, removeApiCreated,
} from "../lib/storage.js";
import { showSnackbar } from "./snackbar.js";
import { resolveTgToken, listGroupsFlat, createTask, assignResource } from "../lib/teamgantt-api.js";
import { jiraIssueToTgCreatePayload } from "../lib/jira-to-tg.js";

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
  const mark = confirmed
    ? `<button class="sync-mark sync-mark-confirmed" data-tip="클릭해서 해제">✅ 보정 완료</button>`
    : `<button class="sync-mark sync-mark-done" data-tip="클릭해서 보정 완료로 표시">✓ 등록 완료</button>`;
  // × = 등록 완료 자체를 해제. 해제하면 체크박스가 다시 살아나 재등록할 수 있다.
  tdT.innerHTML = `${mark} <button class="sync-done-undo" data-tip="등록 완료 해제 — 다시 체크해서 등록할 수 있게 됩니다">×</button>`;

  tdT.querySelector(".sync-mark").addEventListener("click", async () => {
    const q = await getSyncQueue();
    const set = new Set(q.confirmedKeys ?? []);
    const nextConfirmed = !set.has(r.key);
    if (nextConfirmed) set.add(r.key);
    else               set.delete(r.key);
    q.confirmedKeys = [...set];
    await setSyncQueue(q);
    renderTgCellForJiraOnly(tdT, r, nextConfirmed); // 전체 재렌더 안 함.
  });

  tdT.querySelector(".sync-done-undo").addEventListener("click", async () => {
    // 되돌리기 어려운 방향(재등록 시 TeamGantt에 중복 생성)이라 확인을 받는다.
    if (!confirm(
      `${r.key} 의 '등록 완료'를 해제합니다.\n\n`
      + "다시 체크해서 등록할 수 있게 되지만, TeamGantt에 이미 남아 있으면 같은 작업이 중복 생성됩니다.\n"
      + "TeamGantt에서 지웠거나 다른 그룹으로 옮기려는 경우에만 해제하세요.\n\n계속할까요?"
    )) return;

    // 등록 완료로 보이게 만드는 출처가 둘이므로 양쪽에서 모두 빼야 한다.
    await removeApiCreated([r.key]);                      // API로 만든 이력
    const q = await getSyncQueue();
    q.doneKeys = (q.doneKeys ?? []).filter((k) => k !== r.key);        // 단축키로 넣은 이력
    q.confirmedKeys = (q.confirmedKeys ?? []).filter((k) => k !== r.key);
    await setSyncQueue(q);
    await renderCompare();
    showSnackbar(`${r.key} 등록 완료 해제 — 다시 체크할 수 있습니다.`, { kind: "ok", duration: 5000 });
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
    const tdT = tr?.querySelector(".col-tg");
    if (tdT) {
      const summaryText = tr?.querySelector(".col-jira")?.textContent ?? "";
      renderTgCellForJiraOnly(tdT, { key: justDoneKey, jira: { summary: summaryText } }, q.confirmedKeys?.includes(justDoneKey));
    }
  }
  // 2) 새 pending 행을 📋 입력됨 으로.
  if (newPendingKey) {
    const tr = document.querySelector(`#compare-table tr[data-jira-only-key="${cssEscape(newPendingKey)}"]`);
    const tdT = tr?.querySelector(".col-tg");
    if (tdT) {
      const summaryText = tr?.querySelector(".col-jira")?.textContent ?? "";
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

// doneKeys 자리에는 '등록 완료로 볼 키 집합'(syncQueue.doneKeys ∪ apiCreatedKeys)이 들어온다.
// blocked는 거기에 manualChecked까지 합친 '등록 대상에서 제외할 키 집합'.
function renderRow(r, dateSource, doneKeys, pendingKey, confirmedKeys, manualChecked, apiSelected, blocked) {
  const tr = document.createElement("tr");
  tr.className = r.kind;
  // 셀은 클래스로 찾는다. 인덱스(children[N])로 잡으면 컬럼이 하나 늘 때마다 전부 밀린다.
  const tdC   = document.createElement("td");
  const tdKey = document.createElement("td");
  const tdS   = document.createElement("td");
  const tdJ   = document.createElement("td");
  const tdT   = document.createElement("td");
  const tdD   = document.createElement("td");
  tdC.classList.add("col-check");
  tdKey.classList.add("col-key");
  tdJ.classList.add("col-jira");
  tdT.classList.add("col-tg");
  tdD.classList.add("col-date");

  // 등록 대상 체크박스는 '아직 TG에 없는(jira-only)' 행에만 의미가 있다.
  // 이미 처리된 건(등록 완료 / 수동 ✓)은 중복 생성을 막으려고 체크 자체를 비활성화한다.
  // disabled input은 hover 이벤트를 안 받으므로 안내는 부모 td에 붙인다.
  if (r.kind === "jira-only") {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "api-pick";
    cb.dataset.key = r.key;
    // .tip(= cursor: help)은 붙이지 않는다. 여기는 누르는 칸이라 물음표 커서가 어울리지
    // 않는다. 툴팁 본체는 전역 [data-tip] 규칙이 처리하므로 data-tip만 있으면 뜬다.
    if (blocked?.has(r.key)) {
      cb.disabled = true;
      tdC.setAttribute("data-tip", manualChecked?.has(r.key)
        ? "수동 ✓ 표시된 항목 — 이미 처리한 것으로 봅니다"
        : "이미 등록된 항목입니다");
    } else {
      cb.checked = apiSelected?.has(r.key) ?? false;
      // 드래그 안내는 표 위 고정 안내(#compare-pick-hint)가 맡는다. 칸마다 툴팁을 달면
      // 드래그 중 마우스를 따라다니며 떴다 사라져 오히려 방해가 된다.
    }
    tdC.appendChild(cb);
  }

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

  tr.append(tdC, tdKey, tdS, tdJ, tdT, tdD);
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
  const { jiraIssues, tgTasks, settings } = await getAll();
  const dateSource = settings.compareDateSource ?? "jiraUpdated";
  const syncQ = await getSyncQueue();
  const doneKeys = new Set(syncQ.doneKeys ?? []);
  const confirmedKeys = new Set(syncQ.confirmedKeys ?? []);
  const pendingKey = syncQ.pendingKey ?? null;
  const manualChecked = await getManualChecked();
  const apiSelected = await getApiSelected();
  // API로 만든 이력은 doneKeys와 별도로 영속된다([동기화 시작]이 doneKeys를 비우기 때문).
  const apiCreated = await getApiCreated();
  const registered = new Set([...doneKeys, ...apiCreated]);
  const blocked = new Set([...registered, ...manualChecked]);
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

  // 비우기는 반드시 채우기 '직전'에 한다. 위쪽 await 6개 사이에 두면, 렌더가 두 번
  // 겹칠 때 둘 다 비운 뒤 둘 다 채워서 모든 행이 2배로 나온다(검색 타이핑 중 실제 발생).
  tbody.replaceChildren();
  for (const r of rows) tbody.appendChild(renderRow(r, dateSource, registered, pendingKey, confirmedKeys, manualChecked, apiSelected, blocked));

  $("compare-date-col").textContent = DATE_LABEL[dateSource] ?? "날짜";

  const matched   = rows.filter((r) => r.kind === "matched").length;
  const jiraOnly  = rows.filter((r) => r.kind === "jira-only").length;
  const orphanK   = rows.filter((r) => r.kind === "tg-orphan-with-key").length;
  const orphanNK  = rows.filter((r) => r.kind === "tg-orphan-no-key").length;

  // 두 모드는 각자의 바만 보여준다 — 한 화면에 섞여 있으면 뭘 눌러야 할지 알 수 없다.
  // 어느 쪽이든 'Jira만' 행이 없으면 할 일이 없으므로 숨긴다.
  //
  // 단, 동기화가 진행 중이면 모드와 무관하게 sync-bar를 남긴다. 진행 표시(sync-status-card)는
  // sync-bar 밖이라 계속 보이는데 [동기화 중지]/[완료]는 sync-bar 안에 있어서, api 모드로
  // 넘어가면 "Enter 후 [완료] 버튼"이라고 안내하면서 그 버튼이 없는 상태가 된다.
  // 단축키는 UI 모드를 보지 않고 계속 주입하므로 조작 수단을 없애면 안 된다.
  const mode = settings.compareMode ?? "manual";
  const hasJiraOnly = jiraOnly > 0;
  const syncActive = (syncQ.items?.length ?? 0) > 0 || !!syncQ.pendingKey;
  $("sync-bar").classList.toggle("hidden", !syncActive && (!hasJiraOnly || mode !== "manual"));
  $("tg-api-bar").classList.toggle("hidden", !hasJiraOnly || mode !== "api");
  // 체크박스 컬럼은 api 모드에서만 노출(table-layout:fixed라 숨기면 컬럼도 사라진다).
  $("compare-table").classList.toggle("show-check", mode === "api");
  refreshApiPickUi();

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
  }).join("") + `<button class="status-chip-clear" data-tip="모든 종류 표시">전체</button>`;
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
  }).join("") + `<button class="status-chip-clear" data-tip="모든 상태 포함">전체</button>`;
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

  // done > 0이어도 큐가 비면 idle로. ✓/✅ 표시는 doneKeys가 살아있어 유지.
  if (remaining === 0 && pendingCount === 0) {
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
  // 단축키가 해제된 상태로 시작하면 아무 키도 안 먹는 헛수고가 되므로 먼저 막는다.
  if (!(await getAssignedHotkey())) {
    await renderHotkeyBadge();
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    showSnackbar(
      "chrome://extensions/shortcuts 페이지에서 단축키를 지정해주세요.",
      { kind: "warn", duration: 6000 },
    );
    return;
  }
  await setSyncQueue({ items, pendingKey: null, doneKeys: [], confirmedKeys: [] });
  await refreshSyncUi();
  await renderCompare();
  const hk = await getHotkeyLabel();
  showSnackbar(
    `동기화 시작: TeamGantt 페이지 입력창에서 단축키(${hk})를 누르면 작업이 입력됩니다.`,
    { kind: "ok", duration: 5000 },
  );
}

// 실제 Chrome에 할당된 단축키. 확장 재로드/충돌로 해제되면 빈 문자열이 오므로 null 반환.
// manifest의 suggested_key는 설치 시점 제안일 뿐 실제 할당과 다를 수 있다.
async function getAssignedHotkey() {
  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find((x) => x.name === "inject-next-task");
    if (c?.shortcut) return prettifyShortcut(c.shortcut);
  } catch {}
  return null;
}

async function getHotkeyLabel() {
  return (await getAssignedHotkey()) ?? "단축키";
}

// sync-bar 우측 배지. 할당된 실제 키를 표시하고, 미할당이면 경고로 바꿔
// 클릭 시 Chrome 단축키 설정 페이지를 연다.
async function renderHotkeyBadge() {
  const badge = $("hotkey-badge");
  if (!badge) return;
  const assigned = await getAssignedHotkey();
  if (assigned) {
    badge.classList.remove("unset");
    badge.innerHTML = `<span class="hotkey-label">동기화 단축키:</span> <span class="hotkey-keys">${escapeHtml(assigned)}</span>`;
    badge.setAttribute("data-tip", "작업 입력 단축키. chrome://extensions/shortcuts 에서 변경할 수 있습니다.");
  } else {
    badge.classList.add("unset");
    badge.innerHTML = `<span class="hotkey-keys">⚠ 단축키 미설정(설정하기)</span>`;
    badge.setAttribute("data-tip", "클릭해서 단축키를 설정해주세요");
  }
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
  showSnackbar("동기화 중지: 간트 탭에서 다시 갱신해주세요.", { kind: "ok", duration: 3000 });
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
  const tdT = tr?.querySelector(".col-tg");
  if (tdT) {
    const summaryText = tr?.querySelector(".col-jira")?.textContent ?? "";
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

// ── 실험: 누락분 TeamGantt API 직접 등록 (이식 1·5·3번) ───────────────────────
// 단축키 반자동(입력창 주입)과 별개로, 가로챈 TeamGantt 토큰으로 api.teamgantt.com 에
// task를 직접 POST 한다. 그룹(parent_group_id)을 골라 넣고, 내 ID가 있으면 담당자도 자동 할당.

function syncModeTabUi(mode) {
  for (const b of document.querySelectorAll("#compare-mode-tabs button[data-cmode]")) {
    b.classList.toggle("active", b.dataset.cmode === mode);
  }
}

// 등록 버튼 라벨/활성 상태와 전체선택 체크박스를 현재 체크 상태에 맞춘다.
// 무엇이 등록될지 누르기 전에 보이게 하는 게 목적.
function refreshApiPickUi() {
  const boxes = [...document.querySelectorAll("#compare-table .api-pick:not(:disabled)")];
  const picked = boxes.filter((b) => b.checked);
  // '다음에 할 일'로 강조(primary)를 옮긴다. 셋 다 항상 파랗거나 항상 흐리면
  // 순서를 모르는 사람은 가장 눈에 띄는 걸 먼저 누른다.
  const groupChosen = Boolean(Number($("tg-api-group-select")?.value));
  const loadBtn = $("btn-tg-api-load-groups");
  if (loadBtn) loadBtn.classList.toggle("primary", !groupChosen);

  const btn = $("btn-tg-api-create");
  if (btn) {
    // disabled로 막지 않는다 — 눌러도 아무 일이 없으면 고장으로 보인다.
    // 항상 누를 수 있게 하고, 무엇이 빠졌는지는 클릭 시 스낵바로 알린다.
    btn.textContent = picked.length ? `선택 ${picked.length}건 등록` : "선택 항목 등록";
    btn.classList.toggle("primary", groupChosen && picked.length > 0);
  }
  const all = $("compare-check-all");
  if (all) {
    all.disabled = boxes.length === 0;
    all.checked = boxes.length > 0 && picked.length === boxes.length;
    all.indeterminate = picked.length > 0 && picked.length < boxes.length;
  }
}

function snackbarForTokenError(t) {
  if (t.error === "no-tab") {
    showSnackbar("TeamGantt 탭이 없습니다. 프로젝트 페이지를 먼저 여세요.", {
      kind: "error", actionLabel: "TeamGantt 열기",
      onAction: () => chrome.tabs.create({ url: "https://app.teamgantt.com/" }), duration: 8000,
    });
  } else if (t.error === "no-content-script") {
    showSnackbar("TeamGantt 페이지와 연결이 끊겼습니다. 그 탭을 새로고침(F5) 후 다시 시도하세요.", {
      kind: "error", actionLabel: "새로고침", onAction: () => t.tab && chrome.tabs.reload(t.tab.id), duration: 8000,
    });
  } else {
    showSnackbar("인증 토큰을 아직 못 잡았습니다. TeamGantt 탭을 새로고침하면 토큰이 잡힙니다.", {
      kind: "error", actionLabel: "새로고침", onAction: () => t.tab && chrome.tabs.reload(t.tab.id), duration: 8000,
    });
  }
}

// 설정된 프로젝트의 그룹을 불러와 select 채움. 마지막 선택(tgCreateGroupId) 복원.
async function loadGroupsForCreate() {
  const { settings } = await getAll();
  if (!settings.tgProjectId) { showSnackbar("간트 탭에서 프로젝트를 먼저 선택하세요.", { kind: "error" }); return; }
  const t = await resolveTgToken();
  if (t.error) { snackbarForTokenError(t); return; }

  const btn = $("btn-tg-api-load-groups");
  btn.disabled = true; btn.classList.add("is-loading");
  try {
    const res = await listGroupsFlat(Number(settings.tgProjectId), t.auth);
    if (!res.ok) {
      showSnackbar(`${res.error}. 토큰 만료면 TeamGantt 탭을 새로고침하세요.`, { kind: "error", duration: 7000 });
      return;
    }
    await fillGroupSelect(res.groups, settings.tgCreateGroupId);
    lastGroupsFetchAt = Date.now();
    showSnackbar(`그룹 ${res.groups.length}개 불러옴 — 넣을 그룹을 고르세요.`, { kind: "ok", duration: 4000 });
  } finally {
    btn.disabled = false; btn.classList.remove("is-loading");
  }
}

// select 채우기 + 마지막 선택 복원. 수동 버튼과 자동 호출이 공유한다.
//
// 표시는 부모 경로를 붙인 전체 이름으로 한다. <option>의 앞쪽 공백은 브라우저가
// 잘라내므로 들여쓰기로는 계층이 전혀 보이지 않는다 — 'BE'/'FE'/'7월'처럼 짧고
// 여러 부모 아래 반복되는 이름은 경로 없이는 구분이 불가능하다.
async function fillGroupSelect(groups, savedGroupId) {
  const sel = $("tg-api-group-select");
  if (!sel) return;
  const prev = savedGroupId ? String(savedGroupId) : sel.value;

  const { tgTasks, settings } = await getAll();
  // 1) 즐겨찾기 — 사용자가 직접 지정. 가장 확실하므로 맨 위.
  favCache = new Set((settings.favoriteGroupIds ?? []).map(String));
  // 2) 내 작업이 이미 들어 있는 그룹 — 역산. parentGroupId는 최근 수집분에만 있어서
  //    한 번 재수집하기 전까지는 비어 있다.
  const mine = new Set();
  for (const t of Object.values(tgTasks)) {
    if (t.parentGroupId != null) mine.add(String(t.parentGroupId));
  }

  const labelOf = (g) => (g.path?.length ? `${g.path.join(" › ")} › ${g.name}` : g.name);
  const optionOf = (g, star) => {
    const o = document.createElement("option");
    o.value = String(g.id);
    o.textContent = star ? `★ ${labelOf(g)}` : labelOf(g);
    return o;
  };
  const addGroup = (label, list, star) => {
    if (!list.length) return;
    const og = document.createElement("optgroup");
    og.label = `${label} (${list.length})`;
    for (const g of list) og.appendChild(optionOf(g, star));
    sel.appendChild(og);
  };

  sel.replaceChildren();
  const ph = document.createElement("option");
  ph.value = ""; ph.textContent = "그룹 선택…";
  sel.appendChild(ph);

  const favs = groups.filter((g) => favCache.has(String(g.id)));
  const mineOnly = groups.filter((g) => !favCache.has(String(g.id)) && mine.has(String(g.id)));
  const rest = groups.filter((g) => !favCache.has(String(g.id)) && !mine.has(String(g.id)));

  addGroup("★ 즐겨찾기", favs, true);
  addGroup("내 작업이 있는 그룹", mineOnly, false);
  addGroup(favs.length || mineOnly.length ? "그 외 전체" : "전체", rest, false);

  if ([...sel.querySelectorAll("option")].some((o) => o.value === prev)) sel.value = prev;
  refreshApiPickUi();   // 이전 선택이 복원됐을 수 있으니 강조를 다시 계산
  refreshFavButton();
}

// 즐겨찾기 id 캐시 — 별 버튼 상태를 sync로 갱신하려고 들고 있는다(저장소는 settings).
let favCache = new Set();

function refreshFavButton() {
  const btn = $("btn-tg-api-fav");
  const sel = $("tg-api-group-select");
  if (!btn || !sel) return;
  const id = sel.value;
  const isFav = Boolean(id) && favCache.has(String(id));
  btn.textContent = isFav ? "★" : "☆";
  btn.style.color = isFav ? "#f5a623" : "";   // 등록된 별은 노랑, 아니면 CSS 기본(회색)
  btn.setAttribute("data-tip", !id
    ? "그룹을 먼저 선택하세요 — 선택한 그룹을 즐겨찾기에 고정할 수 있습니다"
    : isFav ? "즐겨찾기에서 빼기" : "이 그룹을 즐겨찾기에 넣기(목록 맨 위 고정)");
}

// 비교 탭에 들어올 때 그룹 목록을 조용히 새로 받아둔다 — 매번 [그룹 불러오기]를
// 누르지 않아도 되게. '조용히'가 핵심이다:
//  - api 모드가 아니면 애초에 필요 없다
//  - TeamGantt 탭이 없거나 토큰이 안 잡혔으면 그냥 넘어간다. 에러 스낵바를 띄우면
//    비교 탭에 들어갈 때마다 경고가 떠서 수동으로 누르는 것보다 더 괴롭다
//  - 탭 전환이 잦으니 쿨다운을 둬서 API를 연달아 때리지 않는다
let lastGroupsFetchAt = 0;
const GROUPS_COOLDOWN_MS = 30_000;

async function autoLoadGroupsQuietly() {
  const settings = await getSettings();
  if ((settings.compareMode ?? "api") !== "api") return;
  if (!settings.tgProjectId) return;
  if (Date.now() - lastGroupsFetchAt < GROUPS_COOLDOWN_MS) return;

  const t = await resolveTgToken();
  if (t.error) return;                        // 조용히 포기 — 수동 버튼이 그대로 남아 있다
  const res = await listGroupsFlat(Number(settings.tgProjectId), t.auth);
  if (!res.ok) return;                        // 실패도 조용히
  lastGroupsFetchAt = Date.now();
  await fillGroupSelect(res.groups, settings.tgCreateGroupId);
}

async function createMissingViaApi() {
  const groupSel = $("tg-api-group-select");
  const parentGroupId = Number(groupSel.value);
  // 빠진 조건을 '한 번에 모두' 알린다. 하나씩 알려주면 고치고 또 눌러야 해서 답답하다.
  const pickedNow = document.querySelectorAll("#compare-table .api-pick:checked:not(:disabled)").length;
  const missing = [];
  if (!parentGroupId) missing.push("넣을 그룹([그룹 불러오기] 후 선택)");
  if (pickedNow === 0) missing.push("등록할 항목(표에서 체크 · 드래그로 여러 개)");
  if (missing.length) {
    showSnackbar(`${missing.join(" + ")}이 필요합니다.`, { kind: "error", duration: 7000 });
    return;
  }

  const { jiraIssues, tgTasks, settings } = await getAll();
  if (!settings.tgProjectId) { showSnackbar("간트 탭에서 프로젝트를 먼저 선택하세요.", { kind: "error" }); return; }

  // 현재 필터가 적용된 'Jira만' 행 = 누락분 (startSync와 동일한 행 계산).
  const tgByKey = {};
  const tgWithoutKey = [];
  for (const task of Object.values(tgTasks)) {
    if (task.jiraKey) tgByKey[task.jiraKey] = task;
    else tgWithoutKey.push(task);
  }
  let rows = classifyRows(jiraIssues, tgByKey, tgWithoutKey);
  rows = applySearch(rows, $("compare-search").value.trim());
  rows = applyStatusFilter(rows, settings.syncIncludeStatuses ?? []);
  rows = applyKindFilter(rows, settings.syncIncludeKinds ?? []);

  // 대상 = 체크한 것 ∩ 현재 필터에 보이는 'Jira만' 행 − 이미 처리된 것.
  // '이미 처리된 것'은 세 곳에서 온다. 하나라도 빠뜨리면 TeamGantt에 중복 생성된다:
  //   syncQueue.doneKeys  — 이번 세션에 단축키로 넣은 것
  //   apiCreatedKeys      — 과거에 API로 만든 것(doneKeys는 [동기화 시작] 때 비워짐)
  //   manualChecked       — 사용자가 직접 넣고 ✓ 표시한 것
  const q = await getSyncQueue();
  const picked = await getApiSelected();
  const blocked = new Set([
    ...(q.doneKeys ?? []),
    ...(await getApiCreated()),
    ...(await getManualChecked()),
  ]);
  const targets = rows.filter((r) =>
    r.kind === "jira-only" && r.jira && !blocked.has(r.key) && picked.has(r.key));
  if (targets.length === 0) {
    showSnackbar("등록할 항목을 체크하세요. (체크박스는 'Jira만' 행에만 있습니다)", { kind: "warn" });
    return;
  }

  const groupLabel = (groupSel.selectedOptions[0]?.textContent ?? "").trim();
  // 미리보기에 날짜를 함께 보여준다 — 시작=종료=업데이트일이 의도대로 들어가는지
  // 누르기 전에 확인할 수 있어야 한다(등록 후에는 되돌리기 어렵다).
  const preview = targets.slice(0, 5).map((r) => {
    const p = jiraIssueToTgCreatePayload(r.jira, { projectId: 0, parentGroupId: 0 });
    return `· ${p.start_date}  ${r.key} ${r.jira.summary ?? ""}`.slice(0, 66);
  }).join("\n");
  const more = targets.length > 5 ? `\n… 외 ${targets.length - 5}건` : "";
  if (!confirm(
    `체크한 ${targets.length}건을 TeamGantt에 생성합니다.\n그룹: ${groupLabel}\n\n${preview}${more}\n\n진행할까요?`
  )) return;

  const t = await resolveTgToken();
  if (t.error) { snackbarForTokenError(t); return; }

  const projectId = Number(settings.tgProjectId);
  const myId = settings.tgMyId ? Number(settings.tgMyId) : null;
  const btn = $("btn-tg-api-create");
  btn.disabled = true; btn.classList.add("is-loading");
  let created = 0, failed = 0, assignFail = 0;
  const createdKeys = [];
  try {
    for (const r of targets) {
      const payload = jiraIssueToTgCreatePayload(r.jira, { projectId, parentGroupId });
      const res = await createTask(payload, t.auth);
      if (!res.ok) { failed++; continue; }
      created++;
      createdKeys.push(r.key);
      // 성공은 건마다 즉시 커밋한다. finally에서 한 번에 쓰면 등록 도중 패널이 닫히거나
      // 사이드패널이 재시작될 때 이미 만들어진 것들의 이력이 통째로 사라져 중복 생성된다.
      await addApiCreated([r.key]);
      // 담당자 자동 할당(내 ID 있을 때만, 베스트에포트). 안 하면 '내 작업' 필터에서 빠져 계속 누락처럼 보임.
      if (myId && res.task?.id) {
        const a = await assignResource(res.task.id, myId, "company", t.auth);
        if (!a.ok) assignFail++;
      }
      // 비교 표의 해당 행 TG 셀을 '✓ 등록 완료'로 표시(전체 재렌더 없이).
      const tr = document.querySelector(`#compare-table tr[data-jira-only-key="${cssEscape(r.key)}"]`);
      const tdT = tr?.querySelector(".col-tg");
      if (tdT) renderTgCellForJiraOnly(tdT, { key: r.key, jira: { summary: r.jira.summary } }, false);
    }
  } finally {
    btn.disabled = false; btn.classList.remove("is-loading");
    if (createdKeys.length) {
      // 등록 루프가 도는 동안 단축키가 큐를 바꿨을 수 있다. 함수 시작 때 읽은 q를 그대로
      // 저장하면 이미 소비된 항목이 되살아나 같은 이슈가 또 주입된다 → 최신 큐를 다시 읽어 병합.
      const fresh = await getSyncQueue();
      const madeSet = new Set(createdKeys);
      // API로 이미 만든 항목이 대기 큐에 남아 있으면 단축키가 중복 주입한다.
      fresh.items = (fresh.items ?? []).filter((it) => !madeSet.has(it.key));
      if (fresh.pendingKey && madeSet.has(fresh.pendingKey)) fresh.pendingKey = null;
      await setSyncQueue(fresh);
    }
    // 성공한 건 선택 해제. 스냅샷(picked)을 덮어쓰지 않고 최신 값 위에서 지운다 —
    // 등록 중에 사용자가 새로 체크한 항목이 날아가지 않게.
    if (createdKeys.length) {
      await updateApiSelected((set) => { for (const k of createdKeys) set.delete(k); });
    }
    await renderCompare();
    await refreshSyncUi();
    // 결과 요약은 finally 안에서 띄운다. 밖에 두면 루프 중 예외가 나는 순간 건너뛰어져
    // "몇 건이 실제로 생성됐는지" 알 수 없게 되고, 그대로 다시 누르면 중복 생성 위험이 커진다.
    showSnackbar(
      `API 등록: 생성 ${created} / 실패 ${failed}${assignFail ? ` · 담당자할당실패 ${assignFail}` : ""}. ` +
      "반영하려면 TeamGantt 탭에서 [API 직통] 수집을 다시 누르세요.",
      { kind: failed ? "warn" : "ok", duration: 8000 }
    );
  }
}

export async function refreshCompareTab() {
  await renderCompare();
  await renderHotkeyBadge();
  // 그룹 목록은 화면을 막지 않게 뒤에서 채운다(await 하지 않음).
  // 실패해도 조용하므로 표시가 늦어질 뿐 흐름에 영향이 없다.
  autoLoadGroupsQuietly();
}

export async function initCompareTab() {
  const s = await getSettings();
  $("prefix-regex").value = s.prefixRegex ?? "";
  $("compare-date-source").value = s.compareDateSource ?? "jiraUpdated";
  syncModeTabUi(s.compareMode ?? "manual");

  // 하위 모드 전환: 수동 동기화 ↔ 그룹에 일괄 등록.
  $("compare-mode-tabs").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-cmode]");
    if (!btn) return;
    await setSettings({ compareMode: btn.dataset.cmode });
    syncModeTabUi(btn.dataset.cmode);
    await renderCompare();
    // 버튼 라벨(동기화 시작/중지/완료)이 현재 큐 상태와 어긋난 채 다시 노출되지 않게.
    await refreshSyncUi();
  });

  // 체크박스는 행마다 새로 그려지므로 이벤트 위임으로 받는다.
  // 연타하면 read-modify-write가 겹쳐 앞선 클릭이 유실되므로 updateApiSelected로 직렬화한다.
  $("compare-table").addEventListener("change", async (e) => {
    const cb = e.target.closest(".api-pick");
    if (!cb) return;
    const { key } = cb.dataset;
    const on = cb.checked;
    await updateApiSelected((set) => { if (on) set.add(key); else set.delete(key); });
    refreshApiPickUi();
  });

  // 선택 방법 안내: 체크 칸에 마우스를 올린 동안에만 화면 상단 중앙에 띄운다.
  // 셀마다 붙이면 드래그 중 마우스를 따라다니고, 상시 노출하면 자리를 계속 차지한다.
  const pickHint = $("compare-pick-hint");
  const showPickHint = (on) => {
    if (!pickHint) return;
    if (on) {
      // 표(체크 칸) 바로 위에 붙인다. 멀리 띄우면 마우스는 표 왼쪽 끝에 있는데
      // 안내는 화면 위쪽에 떠서 시선이 왕복하고, 결국 못 보고 지나친다.
      const table = $("compare-table");
      const r = table.getBoundingClientRect();
      const h = pickHint.offsetHeight || 24;
      // 표가 위로 스크롤돼 헤더가 화면 밖이면 최소한 화면 안(탭 바 아래)에는 남긴다.
      pickHint.style.top = `${Math.max(50, r.top - h - 6)}px`;
      pickHint.style.left = `${Math.max(8, r.left)}px`;
    }
    pickHint.classList.toggle("visible", on);
  };
  $("compare-table").addEventListener("mouseover", (e) => {
    if (document.body.classList.contains("dragging")) { showPickHint(false); return; }
    const inCheckCol = Boolean(e.target.closest?.("td.col-check, th.col-check"));
    showPickHint(inCheckCol && $("compare-table").classList.contains("show-check"));
  });
  $("compare-table").addEventListener("mouseleave", () => showPickHint(false));

  // ── 마우스 드래그로 여러 행 한꺼번에 선택/해제 ──
  // 체크박스 칸을 누른 채 위/아래로 훑으면 지나간 행이 모두 같은 상태가 된다.
  // 방향은 '누른 행의 반대 상태'로 고정한다(해제된 행에서 시작하면 쭉 체크, 그 반대도 동일).
  //
  // 시작 칸 처리가 까다롭다. 브라우저가 체크박스를 토글하는 시점은 mousedown이 아니라
  // click이고, click은 '누른 곳과 뗀 곳이 같을 때만' 그 요소에 온다:
  //   · 제자리 클릭 → click 옴   → 브라우저가 토글, change 핸들러가 저장 (여기선 손대지 않음)
  //   · 드래그      → click 없음 → 아무도 토글하지 않으므로 여기서 직접 칠해야 한다
  // 그래서 다른 칸으로 넘어가 '드래그가 확정된 순간' 시작 칸을 직접 칠한다.
  let dragOn = null;              // 드래그 중 적용할 상태 (null이면 드래그 아님)
  let dragTouched = new Set();
  let dragStartCb = null;         // 처음 누른 체크박스
  let dragExtended = false;       // 시작 칸 밖으로 나갔는가(= 진짜 드래그인가)

  const pickInCell = (target) => {
    const cell = target.closest?.("td.col-check");
    return cell ? cell.querySelector(".api-pick:not(:disabled)") : null;
  };
  const paint = (cb) => {
    if (!cb || dragTouched.has(cb.dataset.key)) return;
    dragTouched.add(cb.dataset.key);
    cb.checked = dragOn;
  };

  $("compare-table").addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.shiftKey) return;   // 좌클릭만, Shift는 범위 선택에 양보
    const cb = pickInCell(e.target);
    if (!cb) return;
    // preventDefault로 기본 토글을 막으려 하면 안 된다. 토글은 click 단계라 막히지 않고,
    // 여기서 켜둔 것을 click이 도로 꺼버린다(단일 클릭이 켜졌다 바로 꺼지던 원인).
    dragOn = !cb.checked;                      // click 이후의 최종 상태와 같은 값
    dragStartCb = cb;
    dragExtended = false;
    dragTouched = new Set([cb.dataset.key]);
    // dragging: 텍스트 선택 방지 + 지나가는 칸의 툴팁 억제(CSS에서 처리)
    document.body.classList.add("dragging");
    document.body.style.userSelect = "none";
    showPickHint(false);
  });

  // 드래그 중 지나가는 행을 칠한다. 셀 안이면 어디든(체크박스를 정확히 안 지나도) 잡힌다.
  $("compare-table").addEventListener("mouseover", (e) => {
    if (dragOn === null) return;
    const cb = pickInCell(e.target);
    if (!cb) return;
    if (!dragExtended && cb !== dragStartCb) {
      // 다른 칸으로 넘어왔다 = 드래그 확정. 이제 시작 칸에는 click이 오지 않으므로
      // 직접 칠해준다(안 하면 출발한 칸만 선택에서 빠진다).
      dragExtended = true;
      if (dragStartCb) dragStartCb.checked = dragOn;
    }
    paint(cb);
  });

  // 표 밖에서 손을 떼도 끝나야 하므로 document에 붙인다. 저장은 여기서 한 번만.
  document.addEventListener("mouseup", async () => {
    if (dragOn === null) return;
    const on = dragOn;
    const keys = [...dragTouched];
    const extended = dragExtended;
    dragOn = null;
    dragStartCb = null;
    dragExtended = false;
    dragTouched = new Set();
    document.body.classList.remove("dragging");
    document.body.style.userSelect = "";
    showPickHint(false);
    // 제자리 클릭이면 브라우저 토글 + change 핸들러가 처리한다. 여기서 또 쓰지 않는다.
    if (!extended) return;
    await updateApiSelected((set) => {
      for (const k of keys) { if (on) set.add(k); else set.delete(k); }
    });
    refreshApiPickUi();
  });

  // Shift+클릭 = 직전에 클릭한 체크박스부터 여기까지 한꺼번에 선택/해제.
  // change 이벤트에는 shiftKey가 실리지 않아 click으로 받는다(click이 change보다 먼저 오고,
  // 이 시점에 cb.checked는 이미 토글된 값이다). 단일 클릭은 위 change 핸들러가 처리하므로
  // 여기서는 범위일 때만 저장한다 — Set의 add/delete라 겹쳐도 결과는 같다.
  let lastPickIdx = null;
  $("compare-table").addEventListener("click", async (e) => {
    const cb = e.target.closest(".api-pick");
    if (!cb || cb.disabled) return;
    const boxes = [...document.querySelectorAll("#compare-table .api-pick:not(:disabled)")];
    const idx = boxes.indexOf(cb);
    if (idx < 0) return;

    if (e.shiftKey && lastPickIdx != null && lastPickIdx !== idx) {
      const on = cb.checked;
      const [from, to] = idx < lastPickIdx ? [idx, lastPickIdx] : [lastPickIdx, idx];
      const keys = [];
      for (let i = from; i <= to; i++) {
        boxes[i].checked = on;
        keys.push(boxes[i].dataset.key);
      }
      await updateApiSelected((set) => {
        for (const k of keys) { if (on) set.add(k); else set.delete(k); }
      });
      refreshApiPickUi();
    }
    lastPickIdx = idx;
  });

  // 전체선택은 '지금 화면에 보이는(필터 적용된) 등록 가능한 행'만 대상으로 한다.
  // 숨겨진 행까지 잡으면 확인창 건수와 화면이 어긋나 사고가 난다.
  $("compare-check-all").addEventListener("change", async () => {
    const on = $("compare-check-all").checked;
    const boxes = [...document.querySelectorAll("#compare-table .api-pick:not(:disabled)")];
    const keys = boxes.map((b) => b.dataset.key);
    for (const b of boxes) b.checked = on;
    await updateApiSelected((set) => {
      for (const k of keys) { if (on) set.add(k); else set.delete(k); }
    });
    refreshApiPickUi();
  });

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

  $("btn-tg-api-load-groups").addEventListener("click", loadGroupsForCreate);
  $("btn-tg-api-create").addEventListener("click", createMissingViaApi);
  $("tg-api-group-select").addEventListener("change", async () => {
    await setSettings({ tgCreateGroupId: $("tg-api-group-select").value });
    refreshApiPickUi();   // 그룹을 고르면 강조가 [등록]으로 넘어가야 한다
    refreshFavButton();
  });

  // ☆/★ 토글. 선택한 그룹을 즐겨찾기에 넣거나 뺀다.
  // 목록 순서가 바뀌므로 다시 채우되, 방금 고른 그룹은 선택 상태를 유지한다.
  $("btn-tg-api-fav").addEventListener("click", async () => {
    const sel = $("tg-api-group-select");
    const id = sel.value;
    if (!id) {
      showSnackbar("먼저 즐겨찾기할 그룹을 선택하세요.", { kind: "error" });
      return;
    }
    const cur = await getSettings();
    const favs = new Set((cur.favoriteGroupIds ?? []).map(String));
    const nowFav = !favs.has(String(id));
    if (nowFav) favs.add(String(id));
    else        favs.delete(String(id));
    await setSettings({ favoriteGroupIds: [...favs] });
    favCache = favs;
    // 이미 받아둔 목록만 재배치한다 — 별 하나 누를 때마다 API를 다시 부를 이유가 없다.
    const labels = [...sel.querySelectorAll("option")].filter((o) => o.value);
    const known = labels.map((o) => ({
      id: Number(o.value),
      name: o.textContent.replace(/^★\s*/, ""),
      path: [],
    }));
    await fillGroupSelect(known, id);
    showSnackbar(nowFav ? "즐겨찾기에 넣었습니다 — 목록 맨 위에 고정됩니다." : "즐겨찾기에서 뺐습니다.", { kind: "ok" });
  });
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

  // sync-bar 우측 끝에 실제 할당된 단축키 표시. 미할당이면 경고 배지.
  await renderHotkeyBadge();
  $("hotkey-badge")?.addEventListener("click", () => {
    if ($("hotkey-badge").classList.contains("unset")) {
      chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    }
  });
  // 설정 페이지에서 단축키를 지정하고 돌아오는 경우를 잡기 위해 탭 전환 시 재확인.
  chrome.tabs.onActivated.addListener(() => { renderHotkeyBadge(); });

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
