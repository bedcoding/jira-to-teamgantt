// Jira 이슈 → TeamGantt 작업(task) 변환 규칙.
//
// 동료 CLI(jira2tg)의 src/sync.ts `toTeamGanttTaskPayload` + src/date.ts 를 옮겨온 것.
// 이 확장이 TeamGantt에 "직접 생성/수정(API)"을 붙일 때(이식 1·4번), 여기서 만든
// payload를 그대로 POST/PATCH 하면 된다. 지금은 어떤 파일도 이 모듈을 import 하지 않으므로
// 기존 동작에는 영향이 없다(순수 함수 모음).
//
// CLI와 다른 점(확장 데이터에 맞춘 적응):
//  - status: 확장은 상태 "이름 문자열"만 수집(예: "완료"). 그래서 Done 판정을 statusCategory가
//    아니라 이름 목록으로 한다. 팀 워크플로 언어에 맞게 doneStatuses로 덮어쓸 수 있다.
//  - estimated_hours: 확장은 아직 추정시간을 수집하지 않음 → issue에 값이 있을 때만 채움(미래 대비).

export const DEFAULT_DURATION_DAYS = 30;
export const DEFAULT_TASK_COLOR = "blue1";

// 상태 '완료' 판정에 쓰는 이름들. 호출부에서 교체 가능.
export const DEFAULT_DONE_STATUSES = ["완료", "Done", "Closed", "Resolved", "해결됨", "닫힘"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtDateLocal(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// 오늘(로컬 기준) YYYY-MM-DD.
export function todayIso() {
  return fmtDateLocal(new Date());
}

// dateIso(YYYY-MM-DD)에 days를 더한 YYYY-MM-DD. (CLI src/date.ts 와 동일 로직)
export function addDaysIso(dateIso, days) {
  const [year, month, date] = String(dateIso).split("-").map(Number);
  const next = new Date(year, month - 1, date);
  next.setDate(next.getDate() + days);
  return fmtDateLocal(next);
}

// 마감일 문자열을 YYYY-MM-DD로 정규화. ISO / "YYYY/MM/DD" / "YYYY년 M월 D일" 모두 수용.
// 못 읽으면 "" → 마감일 없음으로 취급.
export function normalizeDueDate(value) {
  if (!value) return "";
  const t = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const slash = t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (slash) return `${slash[1]}-${pad2(slash[2])}-${pad2(slash[3])}`;
  const kr = t.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (kr) return `${kr[1]}-${pad2(kr[2])}-${pad2(kr[3])}`;
  return "";
}

// 이슈가 '완료' 상태인지(이름 기반). 대소문자 무시.
export function isJiraDone(issue, doneStatuses = DEFAULT_DONE_STATUSES) {
  const name = (issue?.status ?? "").trim().toLowerCase();
  if (!name) return false;
  return doneStatuses.some((d) => String(d).trim().toLowerCase() === name);
}

// undefined 값 필드 제거(서버에 빈 값 안 보냄).
function removeUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// Jira 이슈 1건 → TeamGantt 'task 생성' payload.
//
// 규칙(CLI와 동일):
//  - 마감일 있으면 시작=종료=마감일, 없으면 오늘 ~ 오늘+(durationDays-1)
//  - 상태가 Done이면 진행률 100, 아니면 0
//  - name = "[KEY] 요약" (255자 컷)
//  - 추정시간(초)이 있으면 시간으로 환산해 estimated_hours
//
// opts: { projectId, parentGroupId, durationDays?, color?, doneStatuses? }
//   projectId / parentGroupId 는 TeamGantt 생성에 필수. 호출부(간트 탭 설정값)에서 넘긴다.
export function jiraIssueToTgCreatePayload(issue, opts = {}) {
  const {
    projectId,
    parentGroupId,
    durationDays = DEFAULT_DURATION_DAYS,
    color = DEFAULT_TASK_COLOR,
    doneStatuses = DEFAULT_DONE_STATUSES,
  } = opts;

  const due = normalizeDueDate(issue?.dueDate);
  const startDate = due || todayIso();
  const endDate = due || addDaysIso(startDate, Math.max(durationDays - 1, 0));
  const done = isJiraDone(issue, doneStatuses);

  // 확장이 추정시간을 수집하게 되면 자동 반영(초 단위 가정). 지금은 보통 undefined → 생략.
  const estimateSeconds = issue?.timeoriginalestimate ?? issue?.estimateSeconds ?? null;
  const estimatedHours = estimateSeconds ? Math.round((estimateSeconds / 3600) * 10) / 10 : undefined;

  const key = issue?.key ?? "";
  const summary = issue?.summary ?? key;

  return removeUndefined({
    project_id: projectId,
    parent_group_id: parentGroupId,
    name: `[${key}] ${summary}`.slice(0, 255),
    start_date: startDate,
    end_date: endDate,
    percent_complete: done ? 100 : 0,
    color,
    type: "task",
    estimated_hours: estimatedHours,
  });
}
