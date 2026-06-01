// Jira 페이지 MAIN world에서 fetch 후킹 → 이슈 목록 GraphQL 응답을 postMessage로 전달.

(() => {
  if (window.__JT_JIRA_FETCH_HOOKED__) return;
  window.__JT_JIRA_FETCH_HOOKED__ = true;

  // 이슈 목록을 들고오는 두 GraphQL operation. 둘 다 jiraIssueSearchView.issues.edges 구조.
  const TARGET_RE = /\/graphql\/.+(IssueNavigatorIssueSearchRefetchQuery|IssueNavigatorJiraListViewPaginationQuery)/;

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await originalFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === "string" ? req : (req?.url ?? "");
      if (TARGET_RE.test(url) && resp.ok) {
        resp.clone().json().then((data) => {
          window.postMessage({
            __jiraTg: true,
            type: "JIRA_ISSUE_PAYLOAD",
            url,
            data,
            at: Date.now(),
          }, "*");
        }).catch((e) => console.error("[Jira→TeamGantt][jira-hook] json 파싱 실패:", e));
      }
    } catch (_e) { /* swallow */ }
    return resp;
  };

  window.postMessage({ __jiraTg: true, type: "JIRA_HOOK_READY" }, "*");
})();
