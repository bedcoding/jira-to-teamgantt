// Jira 이슈 검색 페이지(`/issues?jql=...`)에 주입되어 DOM 을 파싱.
// popup 에서 chrome.tabs.sendMessage(..., { type: "COLLECT_JIRA" }) 로 호출.

const SEL = {
  rows:        'tr[data-testid="native-issue-table.ui.issue-row"]',
  keyAnchor:   'a[data-testid="native-issue-table.common.ui.issue-cells.issue-key.issue-key-cell"]',
  summaryCell: '[data-testid="native-issue-table.common.ui.issue-cells.issue-summary.issue-summary-cell"]',
  statusBox:   '[data-vc="native-issue-table-ui-issue-status-box"]',
  resolution:  '[data-vc="native-issue-table-ui-resolution-cell"]',
  priorityBox: '[data-testid="issue-field-priority-readview-full.ui.priority.wrapper"]',
};

function text(el) {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

// "만듦 편집", "업데이트 편집" 같은 aria-label 버튼의 형제 span 텍스트 추출.
function fieldAfterButton(row, ariaLabel) {
  const btn = row.querySelector(`button[aria-label="${ariaLabel}"]`);
  const span = btn?.nextElementSibling;
  if (!span || span.tagName !== "SPAN") return "";
  const t = text(span);
  return t === "없음" ? "" : t;
}

// "안성민- 담당자 편집" 같은 aria-label에서 사람 이름만 추출.
function personFromButton(row, suffix) {
  const btn = [...row.querySelectorAll("button[aria-label]")]
    .find((b) => b.getAttribute("aria-label")?.endsWith(suffix));
  if (!btn) return "";
  const label = btn.getAttribute("aria-label") ?? "";
  return label.replace(suffix, "").replace(/[-–—]\s*$/, "").trim();
}

function parseRow(row) {
  const keyEl = row.querySelector(SEL.keyAnchor);
  const key = text(keyEl);
  if (!/^[A-Z]+-\d+$/.test(key)) return null;

  const summary = text(row.querySelector(SEL.summaryCell));
  const assignee = personFromButton(row, "- 담당자 편집");
  const reporter = personFromButton(row, "- 보고자 편집");
  const priority = text(row.querySelector(SEL.priorityBox));
  const status   = text(row.querySelector(SEL.statusBox));
  const resolution = text(row.querySelector(SEL.resolution));
  const created  = fieldAfterButton(row, "만듦 편집");
  const updated  = fieldAfterButton(row, "업데이트 편집");
  const dueDate  = fieldAfterButton(row, "기한 편집");
  const labels   = fieldAfterButton(row, "레이블 편집");

  return { key, summary, assignee, reporter, priority, status, resolution, created, updated, dueDate, labels };
}

function collect() {
  const rows = document.querySelectorAll(SEL.rows);
  const issues = [];
  const errors = [];
  for (const row of rows) {
    try {
      const issue = parseRow(row);
      if (issue) issues.push(issue);
    } catch (e) {
      errors.push(String(e?.message ?? e));
    }
  }
  // "323 중 50" 같은 카운트 텍스트 추출 (대략적)
  const m = document.body.innerText.match(/(\d+)\s*중\s*(\d+)/);
  return {
    issues,
    visibleCount: issues.length,
    totalText: m?.[0] ?? null,
    errors,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "COLLECT_JIRA") return false;
  try {
    sendResponse({ ok: true, data: collect() });
  } catch (e) {
    sendResponse({ ok: false, error: String(e?.message ?? e) });
  }
  return true;
});
