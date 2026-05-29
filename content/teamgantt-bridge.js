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

// 현재 viewport 에 마운트된 task 행만 파싱. virtualized 라서 화면 밖 행은 datepicker 가 마운트되지 않아
// 날짜 input 을 못 찾는다(=null). 그 경우에도 task 자체는 저장하되 source: "dom" 으로 표시한다.
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

console.log("[TG-bridge] content script 로드됨, COLLECT_TG_DOM 리스너 등록");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[TG-bridge] 메시지 수신:", msg);
  if (msg?.type === "COLLECT_TG_DOM") {
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
  }
  if (msg?.type === "INJECT_NEXT_TASK") {
    try {
      const r = injectIntoActiveInput(msg.text ?? "");
      sendResponse(r);
    } catch (e) {
      console.error("[TG-bridge] 주입 중 에러:", e);
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

// 디버깅용: 어떤 selector 가 input 을 잡았는지 단계별로 알려준다.
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

// React 컨트롤드 input 에 값 주입하려면 native value setter 를 거쳐야 React 가 변경을 인식한다.
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

// TG 의 task 추가용 input 찾기. 우선순위:
//   1) 현재 포커스가 task 입력창에 잡혀 있으면 그것
//   2) List 뷰: [data-testid="new-task-name-input"]
//   3) Gantt 뷰 / List 뷰 공통: placeholder 가 'Add task' 인 input
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
  // Enter 자동 발화는 안전을 위해 빼둠. 사용자가 직접 Enter 로 저장.
  return { ok: true };
}

// popup → background → "TG_RELOAD_REQUEST" 메시지 처리는 background 에서 chrome.tabs.reload 로 하니
// 여기선 별도 처리 불필요.
