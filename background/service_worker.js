// content/teamgantt-bridge.js 가 보내는 TeamGantt fetch payload 를
// chrome.storage.local 의 tgFetchCache 에 보관.
// popup [TeamGantt 수집 (API)] 이 이 캐시를 꺼내 upsert 한다.

chrome.runtime.onInstalled.addListener(() => {
  console.log("[jira-to-teamgantt] installed/updated");
});

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

async function storeTgPayload({ url, data, at }) {
  // 같은 projectId 의 새 응답이 오면 덮어씀. 응답이 페이지 진입할 때마다 새로 발생함.
  const projectId = (url.match(/\/projects\/(\d+)\/children/) ?? [])[1] ?? "unknown";
  const cache = (await chrome.storage.local.get("tgFetchCache")).tgFetchCache ?? {};
  cache[projectId] = { url, data, at, capturedAt: new Date().toISOString() };
  await chrome.storage.local.set({ tgFetchCache: cache });
}
