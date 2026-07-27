# HANDOFF — WIP: TeamGantt 쓰기 연동 + Jira REST 수집 (실험)

> 작성: 2026-06-22 · 이어서 작업하기 위한 메모

이 브랜치는 확장에 **TeamGantt API 직접 쓰기**와 **Jira 동일출처 REST 수집**을 추가한 작업 중(WIP) 상태입니다.
코드 레벨(문법 검사 + 순수 로직 단위검증 + 배선 정적 점검)은 통과했지만, **실제 네트워크 동작은 브라우저에서 아직 미검증**입니다.
미검증 UI는 `popup.css`에서 **빨간 점선 + ⚠** 로 표시해 뒀습니다(별도 커밋 — 검증 끝나면 되돌리기).

---

## 추가/변경된 기능

### 1. Jira 동일출처 REST 수집 (실험)
- 버튼: 지라 탭 **`Jira 수집 (REST·실험)`** (`#btn-collect-jira-rest`)
- 콘텐트 스크립트가 `atlassian.net`과 **동일 출처**에서 쿠키 세션(`credentials:include`)으로 `POST /rest/api/3/search/jql`를 직접 호출.
  → 기존의 "[검색] 버튼 강제 클릭" 꼼수와 GraphQL operation 이름 의존을 제거. 토큰 저장도 없음.
- 파일: `content/jira-bridge.js`(`COLLECT_JIRA_REST`), `lib/storage.js`(`normalizeJiraFromRest`), `popup/tab-jira.js`(`handleCollectJiraRest`), `popup/popup.html`.
- **미검증 포인트:** 회사 Jira 인스턴스가 `/rest/api/3`에 쿠키 인증을 허용하는지. 실패 시 버튼이 HTTP 상태를 스낵바에 노출함(예: 401/403 → XSRF 헤더 필요하거나 토큰 opt-in 검토).

### 2. Jira → TeamGantt 변환 규칙 (순수 함수)
- `lib/jira-to-tg.js` — `jiraIssueToTgCreatePayload(issue, { projectId, parentGroupId, ... })` + 날짜 유틸.
  마감일 → 시작/종료, 없으면 오늘~오늘+(기간-1), 완료 상태 → 진행률 100, 이름 `[KEY] 요약`.
- 의존성 없는 순수 함수. 단위검증 통과.

### 3. TeamGantt 작업 API 직접 생성 + 그룹 선택 + 담당자 자동 할당
- 위치: 비교 탭 하단 **`누락분 API 등록` 바**(`#tg-api-bar`) — `그룹 불러오기` + `누락분 API 등록 (실험)`.
- 가로챈 TeamGantt 토큰으로 사이드패널에서 `POST /v1/tasks`를 직접 호출 → 선택한 그룹에 생성, 내 ID(`tgMyId`) 있으면 담당자도 자동 할당. 단건 거부(400/422) 시 벌크 형식으로 폴백. 두 번 눌러도 중복 생성 안 함(`syncQueue.doneKeys` 제외).
- 파일: `lib/teamgantt-api.js`(신규: `resolveTgToken`/`listGroupsFlat`/`flattenGroups`/`createTask`/`assignResource`), `popup/tab-compare.js`, `popup/popup.html`.

### 4. TeamGantt 작업 인라인 수정
- 간트 탭 TG 테이블에 **`수정` 컬럼** 추가: 시작/종료(date)·진행(0~100) 입력 + 행별 **`저장`** → **변경된 필드만** `PATCH /v1/tasks/{id}`(color 등 안 건드림 = 수동 편집 보존).
- 검증: 진행률 0~100 정수, 종료 ≥ 시작.
- 파일: `lib/teamgantt-api.js`(`updateTask`), `lib/storage.js`(`patchTgTask`), `popup/tab-tg.js`, `popup/popup.html`.

---

## 검증 상태
- ✅ 문법 검사(`node --check`), 순수 로직 단위검증(변환 / 그룹 평탄화 / 생성 벌크 폴백 / PATCH / REST 정규화), 배선 정적 교차검증(연결하는 엘리먼트 ID가 popup.html에 존재).
- ⛔ **실제 네트워크**(쿠키 REST, TeamGantt 토큰 캡처, task 생성/수정 반영)은 **로그인 세션 필요** → 브라우저에서 직접 눌러봐야 확인됨.

## 테스트 방법
1. `chrome://extensions` → 확장 **새로고침(↻)**. 콘텐트 스크립트가 바뀌었으니 Jira/TeamGantt 탭은 **F5**.
2. 지라 탭 → **`Jira 수집 (REST·실험)`** → 스낵바 결과 확인(`POST /search/jql` 성공? 아니면 HTTP 코드).
3. (수집 후) 비교 탭 → **`그룹 불러오기`** → 그룹 선택 → **`누락분 API 등록 (실험)`** → TeamGantt에 생성/담당 확인 → `TeamGantt 수집` 다시 눌러 매칭 확인.
4. 간트 탭 → 행의 날짜/진행 수정 → **`저장`** → TeamGantt 반영 확인.

## 미검증 빨간 표시 되돌리기
`popup/popup.css`의 `/* ===== 미검증(실험) 표시 ... ===== */` ~ `/* ===== /미검증 표시 끝 ===== */` 블록만 삭제(해당 커밋 `git revert`). 순수 CSS라 동작 영향 없음.

## 남은 작업
- 그룹 **'이동'**(재등록 시 다른 그룹으로) — 현재는 '지정'까지만.
- **일괄 등록 + 드라이런(미리보기)**.
- **whoami / 연결 점검** 버튼(덤).
- TeamGantt **토큰 자동 갱신**(Cognito refresh) — "토큰 저장 안 함" 원칙과 충돌하므로 보안 판단 후 결정.
- 위 실험 기능들 **브라우저 검증** → 되는 것 정식화, 안 되는 것(특히 쿠키 REST) 대안 마련.

## 설계 메모
- **토큰 저장 안 함** 원칙 유지: 쓰기도 "열린 TeamGantt 탭에서 가로챈 Authorization"을 사이드패널에서 직접 사용(`host_permissions`로 CORS 면제). 따라서 동작하려면 **TeamGantt 탭이 열려 있고 최근 인증되어 토큰이 잡힌 상태**여야 함(안 잡히면 그 탭 새로고침).
- 새 쓰기 API는 `lib/teamgantt-api.js` 한 곳에 모음. UI는 비교 탭(생성)·간트 탭(수정)에 분산.
