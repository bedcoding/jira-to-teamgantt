// Jira 페이지 isolated content script — MAIN hook의 postMessage를 background로 전달.

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.__jiraTg !== true) return;
  if (msg.type === "JIRA_ISSUE_PAYLOAD") {
    chrome.runtime.sendMessage({
      type: "JIRA_ISSUE_PAYLOAD",
      url: msg.url,
      data: msg.data,
      at: msg.at,
    }).catch(() => {});
  } else if (msg.type === "JIRA_HOOK_READY") {
    chrome.runtime.sendMessage({ type: "JIRA_HOOK_READY" }).catch(() => {});
  }
});

// popup → [검색] 자동 클릭. Jira 첫 진입은 SSR이라 hook으로 못 잡으니 강제 발사.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "TRIGGER_JIRA_SEARCH") return false;
  try {
    const btn = document.querySelector('[data-testid="jql-editor-search"]');
    if (!btn) {
      sendResponse({ ok: false, error: "검색 버튼을 찾지 못했습니다. JQL 편집 영역이 열려있는지 확인해주세요." });
      return true;
    }
    btn.click();
    sendResponse({ ok: true });
  } catch (e) {
    sendResponse({ ok: false, error: String(e?.message ?? e) });
  }
  return true;
});
