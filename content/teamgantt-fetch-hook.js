// TeamGantt 페이지 MAIN world에서 fetch 후킹 → children 응답을 postMessage로 전달.

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
