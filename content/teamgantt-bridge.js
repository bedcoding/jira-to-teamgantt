// TeamGantt 페이지의 isolated content script.
// MAIN world hook 이 던지는 postMessage 를 받아 background 로 chrome.runtime.sendMessage.

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.__jiraTg !== true) return;
  if (msg.type === "TG_CHILDREN_PAYLOAD") {
    chrome.runtime.sendMessage({
      type: "TG_CHILDREN_PAYLOAD",
      url: msg.url,
      data: msg.data,
      at: msg.at,
    }).catch(() => {});
  } else if (msg.type === "TG_HOOK_READY") {
    chrome.runtime.sendMessage({ type: "TG_HOOK_READY" }).catch(() => {});
  }
});

// "/projects/list?ids=4440591&companyResourceIds=1091332" 같은 URL 에서 ids / companyResourceIds 파싱.
function readUrlIds() {
  const u = new URL(location.href);
  return {
    projectId: u.searchParams.get("ids"),
    filteredPersonIds: (u.searchParams.get("companyResourceIds") ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean),
  };
}

// 현재 viewport 에 마운트된 task 행만 파싱. virtualized 라서 화면 밖 행은 잡히지 않음.
function collectTasksFromDom() {
  const rows = document.querySelectorAll('[data-testid^="row-task-"]');
  const tasks = [];
  for (const row of rows) {
    const m = row.getAttribute("data-testid").match(/^row-task-(\d+)$/);
    if (!m) continue;
    const id = Number(m[1]);

    const nameEl = row.querySelector(".project-task-name");
    const rawTitle = nameEl?.getAttribute("title") ?? nameEl?.textContent?.trim() ?? "";

    const dateInputs = row.querySelectorAll('[data-testid="task-datepicker-date"]');
    const start = dateInputs[0]?.value || null;
    const end   = dateInputs[1]?.value || null;

    const progressInput = row.querySelector(".task-progress-label");
    const progress = progressInput?.value ?? null;

    const assigneeEls = row.querySelectorAll('.project-task-other-resources [role="label"]');
    const assignees = [...assigneeEls].map((el) => ({
      personId: null,
      name: el.getAttribute("title") ?? el.textContent?.trim() ?? "",
    }));

    tasks.push({ id, rawTitle, start, end, progress, assignees });
  }
  return tasks;
}

console.log("[TG-bridge] content script 로드됨, COLLECT_TG_DOM 리스너 등록");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[TG-bridge] 메시지 수신:", msg);
  if (msg?.type !== "COLLECT_TG_DOM") return false;
  try {
    const tasks = collectTasksFromDom();
    const { projectId, filteredPersonIds } = readUrlIds();
    console.log("[TG-bridge] 수집 결과:", { taskCount: tasks.length, projectId, filteredPersonIds });
    sendResponse({ ok: true, data: { tasks, projectId, filteredPersonIds, url: location.href } });
  } catch (e) {
    console.error("[TG-bridge] 수집 중 에러:", e);
    sendResponse({ ok: false, error: String(e?.message ?? e) });
  }
  return true;
});

// popup → background → "TG_RELOAD_REQUEST" 메시지 처리는 background 에서 chrome.tabs.reload 로 하니
// 여기선 별도 처리 불필요.
