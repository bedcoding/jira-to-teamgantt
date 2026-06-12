// TeamGantt 페이지 MAIN world에서 fetch 후킹 → children 응답을 postMessage로 전달.
// 추가로 bridge의 요청을 받아 페이지가 쓰는 Authorization 토큰을 넘겨준다.
// (api.teamgantt.com fetch를 MAIN에서 직접 하면 cross-origin CORS에 막히므로, 실제 호출은
//  host_permissions로 CORS가 면제되는 사이드패널이 이 토큰으로 수행한다.)

(() => {
  if (window.__JT_FETCH_HOOKED__) return;
  window.__JT_FETCH_HOOKED__ = true;

  const TARGET_RE   = /^https:\/\/api\.teamgantt\.com\/v1\/projects\/\d+\/children\b/;
  const API_RE      = /^https:\/\/api\.teamgantt\.com\//;

  // 페이지가 api.teamgantt.com 에 보내는 Authorization 헤더를 기억해뒀다가 사이드패널에 넘긴다.
  let lastAuth = null;

  function readAuthHeader(args) {
    const [req, init] = args;
    const h = init?.headers ?? (req instanceof Request ? req.headers : null);
    if (!h) return null;
    if (h instanceof Headers) return h.get("authorization");
    if (Array.isArray(h)) {
      const found = h.find(([k]) => String(k).toLowerCase() === "authorization");
      return found?.[1] ?? null;
    }
    const key = Object.keys(h).find((k) => k.toLowerCase() === "authorization");
    return key ? h[key] : null;
  }

  function emit(type, payload) {
    window.postMessage({ __jiraTg: true, type, at: Date.now(), ...payload }, "*");
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await originalFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === "string" ? req : (req?.url ?? "");
      if (API_RE.test(url)) {
        const auth = readAuthHeader(args);
        if (auth) lastAuth = auth;
      }
      if (TARGET_RE.test(url) && resp.ok) {
        // 응답을 두 번 읽을 수 있게 clone
        resp.clone().json().then((data) => {
          emit("TG_CHILDREN_PAYLOAD", { url, data });
        }).catch(() => {});
      }
    } catch (_e) { /* swallow */ }
    return resp;
  };

  // bridge가 토큰을 요청하면 기억해둔 Authorization 헤더를 reqId와 함께 돌려준다.
  // 실제 /v1/projects/all 호출은 사이드패널이 수행한다(MAIN에서 하면 CORS에 막힘).
  window.addEventListener("message", (event) => {
    if (event.source !== window) return; // iframe 등 다른 window발 위조 메시지 차단
    const msg = event.data;
    if (!msg || msg.__jiraTg !== true || msg.type !== "TG_TOKEN_REQUEST") return;
    emit("TG_TOKEN_RESULT", { reqId: msg.reqId, auth: lastAuth });
  });

  // 처음 한 번 ping
  window.postMessage({ __jiraTg: true, type: "TG_HOOK_READY" }, "*");
})();
