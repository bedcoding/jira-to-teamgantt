// DOM 셀렉터 / URL 매칭 규칙을 한 곳에 모음.
// Atlassian / TeamGantt UI가 바뀌면 여기만 손보면 됨.

export const JIRA = {
  urlDomain: /^https:\/\/[a-z0-9-]+\.atlassian\.net\//,
  urlPath:   /\/issues(\?|$)/,
  rows: 'tr[data-testid="native-issue-table.ui.issue-row"]',
  keyCell:   '[data-testid*="issue-key"]',
  titleCell: '[data-testid*="issue-summary"]',
  readView:  '[data-testid*="read-view"]',
};

export const TG = {
  urlDomain: /^https:\/\/app\.teamgantt\.com\//,
  urlPath:   /\/projects\/list/,
};

export function checkJiraUrl(url) {
  if (!url) return { ok: false, reason: "탭 URL을 읽을 수 없습니다." };
  if (!JIRA.urlDomain.test(url))
    return { ok: false, reason: "Atlassian 도메인이 아닙니다." };
  if (!JIRA.urlPath.test(url))
    return { ok: false, reason: "Jira 이슈 검색 페이지가 아닙니다." };
  return { ok: true };
}

export function checkTgUrl(url) {
  if (!url) return { ok: false, reason: "탭 URL을 읽을 수 없습니다." };
  if (!TG.urlDomain.test(url))
    return { ok: false, reason: "TeamGantt 페이지가 아닙니다." };
  if (!TG.urlPath.test(url))
    return { ok: false, reason: "TeamGantt List 뷰가 아닙니다." };
  return { ok: true };
}
