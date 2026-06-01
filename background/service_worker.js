// teamgantt-bridge.js → tgFetchCache 저장. popup [TeamGantt 수집 (API)]이 꺼내 upsert.

chrome.runtime.onInstalled.addListener(() => {
  // 정보성 로그 제거 — 필요 시 chrome://extensions/ 의 서비스 워커 콘솔에서 확인.
});

// 확장 아이콘 클릭 시 사이드 패널 열기. X로 닫기 전까지 탭/페이지 전환과 무관.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("[Jira→TeamGantt] setPanelBehavior 실패:", e));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "TG_CHILDREN_PAYLOAD") {
    storeTgPayload(msg).then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  if (msg?.type === "JIRA_ISSUE_PAYLOAD") {
    storeJiraPayload(msg).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "TG_HOOK_READY" || msg?.type === "JIRA_HOOK_READY") {
    // 정보성. 별도 처리 없음.
    return false;
  }
  return false;
});

// Cmd+D: 큐의 다음 항목을 TG 활성 탭에 주입.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "inject-next-task") return;
  // 단축키 수신을 사이드 패널에 알림(큐 상태와 무관하게 동작 여부 확인용).
  chrome.runtime.sendMessage({ type: "SYNC_HOTKEY_FIRED" }).catch(() => {});
  const queue = (await chrome.storage.local.get("syncQueue")).syncQueue ?? { items: [], pendingKey: null, doneKeys: [], confirmedKeys: [] };
  if (queue.items.length === 0) {
    // 큐 비었으면 사이드 패널에 신호만 보냄(있어도 그만, 없어도 그만).
    chrome.runtime.sendMessage({ type: "SYNC_QUEUE_EMPTY" }).catch(() => {});
    return;
  }
  const next = queue.items[0];
  // TG 탭 찾기. 여러 개면 activeTab 우선, 없으면 첫 번째.
  const tgTabs = await chrome.tabs.query({ url: "https://app.teamgantt.com/projects/*" });
  if (tgTabs.length === 0) {
    chrome.runtime.sendMessage({ type: "SYNC_NO_TG_TAB" }).catch(() => {});
    return;
  }
  const tab = tgTabs.find((t) => t.active) ?? tgTabs[0];
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "INJECT_NEXT_TASK", text: next.text });
    if (resp?.ok) {
      // 직전 pendingKey는 사용자가 Enter로 저장했다고 가정 → doneKeys로 승격.
      if (queue.pendingKey) queue.doneKeys.push(queue.pendingKey);
      // 이번 주입은 pendingKey로 보류(사용자 Enter 대기).
      queue.items.shift();
      queue.pendingKey = next.key;
      await chrome.storage.local.set({ syncQueue: queue });
      chrome.runtime.sendMessage({ type: "SYNC_INJECTED", key: next.key }).catch(() => {});
    } else {
      chrome.runtime.sendMessage({ type: "SYNC_INJECT_FAIL", error: resp?.error ?? "주입 실패" }).catch(() => {});
    }
  } catch (e) {
    chrome.runtime.sendMessage({ type: "SYNC_INJECT_FAIL", error: String(e?.message ?? e) }).catch(() => {});
  }
});

async function storeTgPayload({ url, data, at }) {
  // 같은 projectId의 새 응답이 오면 덮어씀. 응답이 페이지 진입할 때마다 새로 발생함.
  const projectId = (url.match(/\/projects\/(\d+)\/children/) ?? [])[1] ?? "unknown";
  const cache = (await chrome.storage.local.get("tgFetchCache")).tgFetchCache ?? {};
  cache[projectId] = { url, data, at, capturedAt: new Date().toISOString() };
  await chrome.storage.local.set({ tgFetchCache: cache });
}

// Jira GraphQL IssueNavigator 응답 캐시 — 응답 1건이 페이지 1개라 cursor별 보관 후 합쳐 upsert.
async function storeJiraPayload({ url, data, at }) {
  const cache = (await chrome.storage.local.get("jiraFetchCache")).jiraFetchCache ?? { pages: [] };
  // 같은 URL이 또 오면 기존 동일 entry 갱신, 아니면 추가.
  const idx = cache.pages.findIndex((p) => p.url === url);
  const entry = { url, data, at, capturedAt: new Date().toISOString() };
  if (idx >= 0) cache.pages[idx] = entry;
  else          cache.pages.push(entry);
  await chrome.storage.local.set({ jiraFetchCache: cache });
}
