# 개인정보처리방침 — Jira to TeamGantt

**최종 업데이트: 2026-05-29**

이 문서는 Chrome 확장 프로그램 **Jira to TeamGantt**(이하 "본 확장")의
개인정보 처리 방침을 설명합니다.

## 1. 수집하는 정보

본 확장은 사용자의 개인정보를 외부 서버로 전송하거나 수집하지 않습니다.

본 확장이 다루는 정보는 다음과 같으며, **모두 사용자 본인의 브라우저 안에서만**
처리됩니다.

- 사용자가 로그인한 Atlassian Jira 페이지에서 노출되는 이슈 정보
  (키, 제목, 상태, 담당자, 업데이트 시각, 만든 날짜, 마감일, 우선순위, 라벨)
- 사용자가 로그인한 TeamGantt 페이지에서 노출되는 작업 정보
  (작업 ID, 제목, 시작일, 종료일, 진행률, 담당자, 프로젝트 ID)
- 사용자가 본 확장 UI에서 직접 입력한 설정 값
  (Jira 도메인, JQL, 정규식, 프로젝트/사용자 목록, 단축키 등)

## 2. 저장 위치

위 정보는 모두 `chrome.storage.local` 에 저장됩니다. 이는 사용자의 로컬 컴퓨터에만
존재하며, 외부 서버나 본 확장 제작자도 접근할 수 없습니다.

## 3. 전송 대상

본 확장은 사용자의 정보를 다음 외에는 어떠한 외부 서버로도 전송하지 않습니다.

- **Atlassian Jira** (`https://*.atlassian.net`):
  사용자가 정상적으로 로그인한 상태에서 Jira 페이지를 열 때, 본 확장이 그 페이지 안의
  공개된 DOM을 읽습니다. 별도 API 호출이나 데이터 업로드는 없습니다.
- **TeamGantt** (`https://app.teamgantt.com`, `https://api.teamgantt.com`):
  사용자가 TeamGantt 페이지를 열고 TeamGantt가 직접 요청한 응답을 사용자 브라우저
  안에서 가로채 캐시합니다. 본 확장이 TeamGantt에 추가 요청을 보내지 않습니다.

## 4. 권한 사용 이유

`manifest.json` 에 선언된 권한과 사용 목적은 다음과 같습니다.

- `storage`, `unlimitedStorage`: 수집한 데이터/설정을 사용자 로컬에 저장
- `tabs`, `activeTab`: 현재 활성 탭이 Jira/TeamGantt 인지 판별하고 메시지 전달
- `scripting`: content script 주입
- `downloads`: 사용자가 저장한 데이터를 백업 파일(JSON)로 내보낼 때 사용
- `sidePanel`: 사이드 패널 UI 표시
- `https://*.atlassian.net/*`, `https://app.teamgantt.com/*`, `https://api.teamgantt.com/*`:
  해당 도메인에서만 동작 — 다른 사이트는 건드리지 않음

## 5. 제3자 공유

본 확장은 사용자 정보를 어떤 제3자와도 공유하거나 판매하지 않습니다.

## 6. 데이터 삭제

사용자는 언제든지 다음 방법으로 본 확장이 저장한 데이터를 삭제할 수 있습니다.

- 사이드 패널의 [전체 삭제] 버튼
- Chrome 확장 관리에서 본 확장 제거

## 7. 문의

본 방침에 대한 문의는 다음 GitHub 저장소의 Issue로 남겨주세요.

https://github.com/bedcoding/jira-to-teamgantt/issues
