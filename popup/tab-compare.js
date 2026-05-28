import {
  getAll, getSettings, setSettings, clearAll,
} from "../lib/storage.js";
import { showSnackbar } from "./snackbar.js";
import { saveBackup, loadBackup } from "./backup.js";

function $(id) { return document.getElementById(id); }

const DATE_LABEL = {
  jiraUpdated: "업데이트",
  jiraDue:     "마감일",
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
    case "jiraDue":     return toIsoDate(r.jira?.dueDate);
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

function renderRow(r, dateSource) {
  const tr = document.createElement("tr");
  tr.className = r.kind;
  const tdKey = document.createElement("td");
  const tdJ   = document.createElement("td");
  const tdT   = document.createElement("td");
  const tdD   = document.createElement("td");

  tdKey.textContent = r.key ?? "";
  if (r.key && r.jira) {
    tdKey.classList.add("clickable");
    tdKey.title = "클릭: 새 탭에서 Jira 이슈 열기";
    tdKey.addEventListener("click", async () => {
      const s = await getSettings();
      chrome.tabs.create({ url: `https://${s.jiraDomain}/browse/${r.key}` });
    });
  }

  if (r.jira) {
    tdJ.textContent = r.jira.summary ?? "";
    tdJ.classList.add("clickable");
    tdJ.title = "클릭: [KEY] summary 형식으로 클립보드 복사";
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
    tdT.title = "클릭: 제목 클립보드 복사";
    tdT.addEventListener("click", () => {
      navigator.clipboard.writeText(r.tg.rawTitle ?? "");
      showSnackbar(`복사: ${r.tg.rawTitle}`, { kind: "ok", duration: 2000 });
    });
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

  tr.append(tdKey, tdJ, tdT, tdD);
  return tr;
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
  const tbody = document.querySelector("#compare-table tbody");
  tbody.replaceChildren();
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

  const kindOrder = { matched: 0, "jira-only": 0, "tg-orphan-with-key": 1, "tg-orphan-no-key": 2 };
  rows.sort((a, b) => {
    const ka = kindOrder[a.kind] ?? 9, kb = kindOrder[b.kind] ?? 9;
    if (ka !== kb) return ka - kb;
    const da = rowDate(a, dateSource);
    const db = rowDate(b, dateSource);
    // 값 없는 행은 뒤로
    if (!da && db) return 1;
    if (da && !db) return -1;
    return db.localeCompare(da); // 최신 우선
  });

  for (const r of rows) tbody.appendChild(renderRow(r, dateSource));

  $("compare-date-col").textContent = DATE_LABEL[dateSource] ?? "날짜";

  const matched   = rows.filter((r) => r.kind === "matched").length;
  const jiraOnly  = rows.filter((r) => r.kind === "jira-only").length;
  const orphanK   = rows.filter((r) => r.kind === "tg-orphan-with-key").length;
  const orphanNK  = rows.filter((r) => r.kind === "tg-orphan-no-key").length;
  $("compare-status").textContent =
    `Jira ${Object.keys(jiraIssues).length}건 / TeamGantt ${Object.keys(tgTasks).length}건 ·` +
    ` 매칭 ${matched} / Jira만 ${jiraOnly} / TeamGantt 고아(키있음) ${orphanK} / TeamGantt 고아(키없음) ${orphanNK}`;
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

async function handleClearAll() {
  if (!confirm("저장된 Jira/TeamGantt/설정/목록 모두 삭제됩니다. 진행할까요?")) return;
  await clearAll();
  showSnackbar("전체 삭제 완료.", { kind: "ok" });
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
    showSnackbar("키 추출 규칙 저장됨. 다시 [TeamGantt 수집] 하면 적용됩니다.", { kind: "ok" });
  });

  $("compare-search").addEventListener("input", () => renderCompare());
  $("compare-date-source").addEventListener("change", async () => {
    await setSettings({ compareDateSource: $("compare-date-source").value });
    renderCompare();
  });

  $("btn-backup-save").addEventListener("click", saveBackup);
  $("btn-backup-load").addEventListener("click", () => $("backup-file").click());
  $("backup-file").addEventListener("change", async (e) => {
    await loadBackup(e.target.files[0], renderCompare);
    e.target.value = "";
  });
  $("btn-clear-all").addEventListener("click", handleClearAll);

  await renderCompare();
}
