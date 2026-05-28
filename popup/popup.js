import { initJiraTab } from "./tab-jira.js";
import { initTgTab } from "./tab-tg.js";
import { initCompareTab } from "./tab-compare.js";
import { initReportTab } from "./tab-report.js";
import { saveBackup, loadBackup } from "./backup.js";
import { getSettings, setSettings } from "../lib/storage.js";

function spawnInk(btn, event) {
  const rect = btn.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const size = Math.max(rect.width, rect.height);
  const ink = document.createElement("span");
  ink.className = "tab-ink";
  ink.style.left = `${x}px`;
  ink.style.top = `${y}px`;
  ink.style.width = `${size}px`;
  ink.style.height = `${size}px`;
  btn.appendChild(ink);
  ink.addEventListener("animationend", () => ink.remove());
}

function activate(target, btns, panels, opts = {}) {
  btns.forEach((b) => {
    const isActive = b.dataset.tab === target;
    b.classList.toggle("active", isActive);
    if (isActive && opts.animate) {
      b.classList.remove("just-activated");
      void b.offsetWidth;
      b.classList.add("just-activated");
    } else if (!isActive) {
      b.classList.remove("just-activated");
    }
  });
  panels.forEach((p) => p.classList.toggle("active", p.dataset.tab === target));
}

async function routeTabs() {
  const btns = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");

  const s = await getSettings();
  const known = new Set([...btns].map((b) => b.dataset.tab));
  const initial = known.has(s.activeTab) ? s.activeTab : "jira";
  activate(initial, btns, panels);

  btns.forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const target = btn.dataset.tab;
      spawnInk(btn, e);
      activate(target, btns, panels, { animate: true });
      await setSettings({ activeTab: target });
    });
  });
}

function wireGlobalBackup() {
  document.getElementById("btn-global-backup-save")
    .addEventListener("click", saveBackup);
  document.getElementById("btn-global-backup-load")
    .addEventListener("click", () => document.getElementById("global-backup-file").click());
  document.getElementById("global-backup-file")
    .addEventListener("change", async (e) => {
      await loadBackup(e.target.files[0], async () => {
        // 복원 후 모든 탭 다시 그려야 깔끔. 가장 단순한 방법은 popup 재로드.
        location.reload();
      });
      e.target.value = "";
    });
}

document.addEventListener("DOMContentLoaded", async () => {
  await routeTabs();
  wireGlobalBackup();
  // 초기 라디오/UI 상태가 필요한 추출 탭을 먼저 init 해서 깜빡임 방지
  await initReportTab();
  await initJiraTab();
  await initTgTab();
  await initCompareTab();
});
