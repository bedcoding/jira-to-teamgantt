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

// popup → background → "TG_RELOAD_REQUEST" 메시지 처리는 background 에서 chrome.tabs.reload 로 하니
// 여기선 별도 처리 불필요.
