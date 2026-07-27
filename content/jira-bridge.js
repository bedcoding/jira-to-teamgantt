// Jira 페이지 isolated content script — MAIN hook의 postMessage를 background로 전달.

window.addEventListener("message", (event) => {
  if (event.source !== window) return; // iframe 등 다른 window발 위조 메시지 차단
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

// ── 실험: 동일 출처 REST 수집 ─────────────────────────────────────────────
// Jira는 SSR이라 첫 로드에 API 호출이 안 보여서, 기존엔 [검색] 버튼을 강제 클릭하는
// 꼼수로 GraphQL을 유발했다(검색버튼 UI가 바뀌면 깨짐). 여기서는 콘텐트 스크립트가
// atlassian.net과 "동일 출처"인 점을 이용해, 로그인 쿠키 세션(credentials:include)으로
// 안정적인 공개 REST를 직접 호출한다 → 검색버튼 불필요, GraphQL 이름 변경에도 안 깨짐,
// 토큰 저장도 없음(쿠키 사용).
const REST_FIELDS = [
  "summary", "status", "assignee", "reporter", "priority",
  "resolution", "duedate", "updated", "created", "labels", "timeoriginalestimate",
];

async function fetchJsonSameOrigin(url, init) {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, json: res.ok ? await res.json() : null };
}

// cap은 "총 수집 상한"(선택, 미지정 시 무제한). 페이지 크기는 API 상한인 100 고정.
// 주의: 화면 테이블의 [페이지당] 설정(jiraPageSize)과 절대 묶지 말 것 —
// 예전에 그 값을 cap으로 넘겨서 항상 100건에서 멈추는 버그가 있었다.
const PER_PAGE = 100;
const MAX_PAGES = 50; // 안전장치. 100 x 50 = 최대 5000건

async function collectJiraViaRest({ jql, cap: capIn }) {
  const cap = Number.isFinite(capIn) && capIn > 0 ? capIn : Infinity;
  const origin = location.origin;
  const headers = { "Content-Type": "application/json", "Accept": "application/json" };

  // 1순위: 신형 POST /rest/api/3/search/jql (nextPageToken 페이지네이션) — CLI와 동일 엔드포인트.
  const issues = [];
  let nextPageToken;
  let firstStatus = null;
  let pages = 0;
  while (pages < MAX_PAGES && issues.length < cap) {
    const body = { jql, maxResults: Math.min(PER_PAGE, cap - issues.length), fields: REST_FIELDS };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    let r;
    try {
      r = await fetchJsonSameOrigin(`${origin}/rest/api/3/search/jql`, {
        method: "POST", credentials: "include", headers, body: JSON.stringify(body),
      });
    } catch (e) {
      firstStatus = `network:${String(e?.message ?? e)}`;
      break;
    }
    if (!r.ok) { firstStatus = r.status; break; }
    pages++;
    issues.push(...(r.json.issues ?? []));
    // 마지막 페이지 → 전량 수집 완료.
    if (r.json.isLast || !r.json.nextPageToken) {
      return { ok: true, endpoint: "POST /search/jql", data: { issues, pages, truncated: false } };
    }
    nextPageToken = r.json.nextPageToken;
  }
  // 여기 도달 = 상한(cap/MAX_PAGES)에 걸려 잘렸거나, 중간에 에러로 break됨.
  // 둘 다 "전량이 아님"이므로 truncated로 알린다 — 부분 결과가 완전한 결과로
  // 보이면 안 된다. 왜 멈췄는지는 stoppedBy로 구분해서 넘긴다.
  if (issues.length > 0) {
    return {
      ok: true,
      endpoint: "POST /search/jql",
      data: {
        issues, pages, truncated: true,
        stoppedBy: firstStatus == null ? `상한 ${pages}페이지 도달` : `HTTP/네트워크 오류 ${firstStatus}`,
      },
    };
  }

  // 폴백: 구형 GET /rest/api/3/search (일부 인스턴스/버전).
  try {
    // cap이 Infinity면 URL에 그대로 박히므로 반드시 유한값으로 자른다.
    // 구형 GET은 startAt 페이지네이션이 따로 필요해서 여기서는 1페이지만 가져온다(폴백 경로).
    const url = `${origin}/rest/api/3/search?jql=${encodeURIComponent(jql)}`
      + `&maxResults=${Math.min(cap, PER_PAGE)}&fields=${encodeURIComponent(REST_FIELDS.join(","))}`;
    const r = await fetchJsonSameOrigin(url, { credentials: "include", headers: { "Accept": "application/json" } });
    if (!r.ok) return { ok: false, error: `REST 수집 실패 (POST ${firstStatus} / GET HTTP ${r.status})` };
    const got = r.json.issues ?? [];
    const totalKnown = Number(r.json.total);
    return {
      ok: true,
      endpoint: "GET /search",
      data: { issues: got, pages: 1, truncated: Number.isFinite(totalKnown) && got.length < totalKnown },
    };
  } catch (e2) {
    return { ok: false, error: `REST 수집 실패 (POST ${firstStatus} / GET network:${String(e2?.message ?? e2)})` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "COLLECT_JIRA_REST") return false;
  collectJiraViaRest({ jql: msg.jql, cap: msg.cap })
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true; // async sendResponse
});
