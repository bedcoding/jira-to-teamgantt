import { exportAll, importAll, getAll } from "../lib/storage.js";
import { showSnackbar } from "./snackbar.js";

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export async function saveBackup() {
  const data = await exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url, filename: `jira-tg-backup-${stamp()}.json`, saveAs: true,
  });
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function diffLine(label, cur, next) {
  const d = next - cur;
  const sign = d > 0 ? `+${d}` : d < 0 ? `${d}` : "변경 없음";
  return { label, cur, next, sign };
}

async function buildPreview(data) {
  const current = await getAll();
  const jiraNext = data.jiraIssues ?? {};
  const tgNext = data.tgTasks ?? {};
  const settingsNext = data.settings ?? {};
  const peopleNext = settingsNext.tgPeople ?? current.settings.tgPeople ?? [];
  const projectsNext = settingsNext.tgProjects ?? current.settings.tgProjects ?? [];

  const summary = [
    diffLine("Jira 이슈", Object.keys(current.jiraIssues).length, Object.keys(jiraNext).length),
    diffLine("TeamGantt 작업", Object.keys(current.tgTasks).length, Object.keys(tgNext).length),
    diffLine("사람 목록", current.settings.tgPeople?.length ?? 0, peopleNext.length),
    diffLine("프로젝트 목록", current.settings.tgProjects?.length ?? 0, projectsNext.length),
  ];

  const jiraSample = Object.values(jiraNext)
    .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""))
    .slice(0, 3)
    .map((it) => ({ key: it.key, summary: it.summary }));

  const tgSample = Object.values(tgNext)
    .sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""))
    .slice(0, 3)
    .map((it) => ({ key: it.jiraKey, title: it.rawTitle }));

  return {
    settings: {
      jiraDomain: settingsNext.jiraDomain ?? "(없음)",
      jqlTemplate: settingsNext.jqlTemplate ?? "(없음)",
    },
    summary,
    jiraSample,
    tgSample,
  };
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
}

function renderPreview(filename, preview) {
  const sumRows = preview.summary.map(({ label, cur, next, sign }) =>
    `<tr><td>${escHtml(label)}</td><td>${cur.toLocaleString()}</td><td>→</td><td>${next.toLocaleString()}</td><td class="sign">${escHtml(sign)}</td></tr>`).join("");

  const jiraRows = preview.jiraSample.length
    ? preview.jiraSample.map((it) => `<li><b>${escHtml(it.key)}</b> ${escHtml(it.summary)}</li>`).join("")
    : `<li class="empty">(없음)</li>`;

  const tgRows = preview.tgSample.length
    ? preview.tgSample.map((it) => `<li>${it.key ? `<b>${escHtml(it.key)}</b> ` : ""}${escHtml(it.title)}</li>`).join("")
    : `<li class="empty">(없음)</li>`;

  return `
    <div class="bp-file">📁 ${escHtml(filename)}</div>
    <table class="bp-summary"><tbody>${sumRows}</tbody></table>
    <div class="bp-settings">
      <div><span class="k">Jira 경로</span> ${escHtml(preview.settings.jiraDomain)}</div>
      <div><span class="k">JQL</span> <code>${escHtml(preview.settings.jqlTemplate)}</code></div>
    </div>
    <div class="bp-section">
      <div class="bp-section-title">Jira 샘플 (최신 3건)</div>
      <ul class="bp-list">${jiraRows}</ul>
    </div>
    <div class="bp-section">
      <div class="bp-section-title">TeamGantt 샘플 (최신 3건)</div>
      <ul class="bp-list">${tgRows}</ul>
    </div>
    <div class="bp-warn">⚠️ 현재 데이터가 모두 사라지고 위 백업으로 통째로 교체됩니다.</div>
  `;
}

function showRestoreDialog(filename, preview) {
  return new Promise((resolve) => {
    const dlg = document.getElementById("backup-dialog");
    const body = dlg.querySelector(".bp-body");
    body.innerHTML = renderPreview(filename, preview);
    dlg.classList.remove("hidden");

    const close = (result) => {
      dlg.classList.add("hidden");
      dlg.querySelector(".bp-confirm").removeEventListener("click", onOk);
      dlg.querySelector(".bp-cancel").removeEventListener("click", onCancel);
      dlg.querySelector(".bp-close").removeEventListener("click", onCancel);
      dlg.removeEventListener("click", onBackdrop);
      resolve(result);
    };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onBackdrop = (e) => { if (e.target === dlg) close(false); };

    dlg.querySelector(".bp-confirm").addEventListener("click", onOk);
    dlg.querySelector(".bp-cancel").addEventListener("click", onCancel);
    dlg.querySelector(".bp-close").addEventListener("click", onCancel);
    dlg.addEventListener("click", onBackdrop);
  });
}

export async function loadBackup(file, onAfter) {
  if (!file) return;
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); }
  catch (e) { showSnackbar(`JSON 파싱 실패: ${e.message}`, { kind: "error" }); return; }

  const preview = await buildPreview(data);
  const ok = await showRestoreDialog(file.name, preview);
  if (!ok) return;

  await importAll(data);
  showSnackbar("백업 복원 완료.", { kind: "ok" });
  if (onAfter) await onAfter();
}
