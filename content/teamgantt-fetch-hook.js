// TeamGantt 페이지 컨텍스트(MAIN world)에서 window.fetch 를 가로채
// `api.teamgantt.com/v1/projects/{id}/children?is_flat_list=true` 응답을
// window.postMessage 로 흘려보낸다. content script(isolated)가 받아서 background 로 전달.

(() => {
  if (window.__JT_FETCH_HOOKED__) return;
  window.__JT_FETCH_HOOKED__ = true;

  const TARGET_RE = /^https:\/\/api\.teamgantt\.com\/v1\/projects\/\d+\/children\b/;

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await originalFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === "string" ? req : (req?.url ?? "");
      if (TARGET_RE.test(url) && resp.ok) {
        // 응답을 두 번 읽을 수 있게 clone
        resp.clone().json().then((data) => {
          window.postMessage({
            __jiraTg: true,
            type: "TG_CHILDREN_PAYLOAD",
            url,
            data,
            at: Date.now(),
          }, "*");
        }).catch(() => {});
      }
    } catch (_e) { /* swallow */ }
    return resp;
  };

  // 처음 한 번 ping
  window.postMessage({ __jiraTg: true, type: "TG_HOOK_READY" }, "*");
})();
