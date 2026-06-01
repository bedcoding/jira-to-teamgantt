// TeamGantt isolated content script — MAIN hook의 postMessage를 background로 전달.

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

// viewport에 마운트된 task 행만 파싱(virtualized라 화면 밖은 datepicker null). source: "dom"으로 표시.
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

    const progressRaw = row.querySelector(".task-progress-label")?.value;
    const progressNum = progressRaw ? Number(String(progressRaw).replace("%", "").trim()) : NaN;
    const progress = Number.isFinite(progressNum) ? progressNum : null;

    const assigneeEls = row.querySelectorAll('.project-task-other-resources [role="label"]');
    const assignees = [...assigneeEls].map((el) => ({
      personId: null,
      name: el.getAttribute("title") ?? el.textContent?.trim() ?? "",
    }));

    tasks.push({ id, rawTitle, start, end, progress, assignees, source: "dom" });
  }
  return tasks;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "COLLECT_TG_DOM") {
    try {
      const tasks = collectTasksFromDom();
      const { projectId, filteredPersonIds } = readUrlIds();
      sendResponse({ ok: true, data: { tasks, projectId, filteredPersonIds, url: location.href } });
    } catch (e) {
      console.error("[Jira→TeamGantt][teamgantt-bridge] 수집 중 에러:", e);
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
    return true;
  }
  if (msg?.type === "INJECT_NEXT_TASK") {
    try {
      const r = injectIntoActiveInput(msg.text ?? "");
      sendResponse(r);
    } catch (e) {
      console.error("[Jira→TeamGantt][teamgantt-bridge] 주입 중 에러:", e);
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
    return true;
  }
  if (msg?.type === "DETECT_TASK_INPUT") {
    try {
      sendResponse(describeTaskInputDetection());
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
    return true;
  }
  return false;
});

// 디버깅용: 어떤 selector가 input을 잡았는지 단계별로 알려준다.
function describeTaskInputDetection() {
  const view = location.pathname.includes("/gantt") ? "gantt" : "list";
  const steps = [];
  // 1. activeElement
  const active = document.activeElement;
  if (active && active.tagName === "INPUT" && isLikelyTaskInput(active)) {
    steps.push({ matched: true, source: "activeElement", info: describeInput(active) });
    return { ok: true, view, found: true, steps, finalSource: "activeElement" };
  }
  steps.push({
    matched: false,
    source: "activeElement",
    info: active ? `${active.tagName}#${active.id || "(no id)"}` : "(none)",
  });
  // 2. testid
  const byTestId = document.querySelector('[data-testid="new-task-name-input"]');
  if (byTestId) {
    steps.push({ matched: true, source: 'testid="new-task-name-input"', info: describeInput(byTestId) });
    return { ok: true, view, found: true, steps, finalSource: 'testid="new-task-name-input"' };
  }
  steps.push({ matched: false, source: 'testid="new-task-name-input"', info: "(없음)" });
  // 3. placeholder=Add task (보이는 것만)
  const candidates = document.querySelectorAll('input[placeholder="Add task" i]');
  const visibleCandidates = [];
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) visibleCandidates.push(el);
  }
  if (visibleCandidates.length > 0) {
    steps.push({
      matched: true,
      source: 'placeholder="Add task"',
      info: `${visibleCandidates.length}개 중 첫 번째 — ${describeInput(visibleCandidates[0])}`,
    });
    return { ok: true, view, found: true, steps, finalSource: 'placeholder="Add task"' };
  }
  steps.push({
    matched: false,
    source: 'placeholder="Add task"',
    info: `전체 후보 ${candidates.length}개, 보이는 것 0개`,
  });
  return { ok: true, view, found: false, steps, finalSource: null };
}

function describeInput(el) {
  const testid = el.getAttribute("data-testid") || "(no testid)";
  const ph = el.getAttribute("placeholder") || "(no placeholder)";
  return `testid=${testid}, placeholder="${ph}"`;
}

// React 컨트롤드 input에 값 주입하려면 native value setter를 거쳐야 React가 변경을 인식한다.
function setReactInputValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function fireEnter(el) {
  for (const type of ["keydown", "keypress", "keyup"]) {
    el.dispatchEvent(new KeyboardEvent(type, {
      key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
    }));
  }
}

// task input 우선순위: 1) activeElement, 2) List 뷰 testid, 3) placeholder="Add task"
function findActiveTaskInput() {
  const active = document.activeElement;
  if (active && active.tagName === "INPUT" && isLikelyTaskInput(active)) return active;
  const byTestId = document.querySelector('[data-testid="new-task-name-input"]');
  if (byTestId) return byTestId;
  // Gantt 뷰는 placeholder='Add task' 인 input. 여러 개면 화면에 보이는 첫 번째.
  const candidates = document.querySelectorAll('input[placeholder="Add task" i]');
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return el;
  }
  return null;
}

function isLikelyTaskInput(el) {
  if (el.getAttribute("data-testid") === "new-task-name-input") return true;
  const ph = (el.getAttribute("placeholder") ?? "").toLowerCase();
  return ph.includes("add task");
}

function injectIntoActiveInput(text) {
  const input = findActiveTaskInput();
  if (!input) {
    return { ok: false, error: "task 입력창을 찾지 못했습니다. TeamGantt에서 [추가] 버튼을 먼저 눌러주세요." };
  }
  input.focus();
  setReactInputValue(input, text);
  // Enter 자동 발화는 안전을 위해 빼둠. 사용자가 직접 Enter로 저장.
  return { ok: true };
}

// TG_RELOAD_REQUEST는 background에서 chrome.tabs.reload로 처리 — 여기선 별도 핸들러 불필요.
