// content/teamgantt-bridge.js 가 보내는 TeamGantt fetch payload 를
// chrome.storage.local 의 tgFetchCache 에 보관.
// popup [TeamGantt 수집 (API)] 이 이 캐시를 꺼내 upsert 한다.

chrome.runtime.onInstalled.addListener(() => {
  console.log("[jira-to-teamgantt] installed/updated");
});

// 확장 아이콘 클릭 시 사이드 패널 열기.
// 사이드 패널은 사용자가 X 로 닫기 전까지 페이지 전환·탭 전환과 무관하게 유지된다.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("[jira-to-teamgantt] setPanelBehavior 실패:", e));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "TG_CHILDREN_PAYLOAD") {
    storeTgPayload(msg).then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  if (msg?.type === "TG_HOOK_READY") {
    // 정보성. 별도 처리 없음.
    return false;
  }
  return false;
});

// Cmd+D: 큐의 다음 항목을 TG 활성 탭에 주입.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "inject-next-task") return;
  console.log("[jira-to-teamgantt] 단축키 수신: inject-next-task");
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
      // 직전 pendingKey 는 사용자가 Enter 로 저장했다고 가정 → doneKeys 로 승격.
      if (queue.pendingKey) queue.doneKeys.push(queue.pendingKey);
      // 이번 주입은 pendingKey 로 보류(사용자 Enter 대기).
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
  // 같은 projectId 의 새 응답이 오면 덮어씀. 응답이 페이지 진입할 때마다 새로 발생함.
  const projectId = (url.match(/\/projects\/(\d+)\/children/) ?? [])[1] ?? "unknown";
  const cache = (await chrome.storage.local.get("tgFetchCache")).tgFetchCache ?? {};
  cache[projectId] = { url, data, at, capturedAt: new Date().toISOString() };
  await chrome.storage.local.set({ tgFetchCache: cache });
}
