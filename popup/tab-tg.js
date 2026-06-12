import {
  getAll, getSettings, setSettings,
  upsertTgTasks, getTgFetchCache, normalizeTgFromFetch, clearTgTasks,
} from "../lib/storage.js";
import { showSnackbar } from "./snackbar.js";
import { renderPager } from "./pager.js";

let tgPage = 1;

const DATE_MISSING_TIP = "※ DOM으로 추출한 경우 TeamGantt는 보이는 행만 날짜를 그리므로 화면에 보이지 않는 행은 날짜 정보가 빠집니다.";

function $(id) { return document.getElementById(id); }

function dedupe(items) {
  const map = new Map();
  for (const it of items) map.set(it.id, it);
  return [...map.values()];
}

function parsePresetJson(raw) {
  const data = JSON.parse(raw);
  // 도움말의 "응답 통째로 붙여넣기"를 실제로 지원: {projects:[...]}/{people:[...]} 래퍼도 수용.
  const arr = Array.isArray(data) ? data
    : (Array.isArray(data?.projects) ? data.projects
    : (Array.isArray(data?.people) ? data.people : null));
  if (!arr) throw new Error("JSON 최상위가 배열이거나 projects/people 배열을 포함해야 합니다.");
  const out = [];
  for (const item of arr) {
    if (item == null || typeof item !== "object") continue;
    const id = Number(item.id);
    const name = String(item.name ?? "").trim();
    if (!Number.isFinite(id) || !name) continue;
    out.push({ id, name });
  }
  return out;
}

function sortedByName(items) {
  return [...items].sort((a, b) => String(a.name).localeCompare(String(b.name), "ko"));
}

function fillSelect(selectEl, items, currentValue) {
  while (selectEl.options.length > 1) selectEl.remove(1);
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = String(item.id);
    opt.textContent = `${item.name} (${item.id})`;
    selectEl.appendChild(opt);
  }
  selectEl.value = items.some((p) => String(p.id) === currentValue) ? currentValue : "";
}

function renderPresetList(containerEl, items, onDelete) {
  containerEl.replaceChildren();
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "preset-row";
    const pid = document.createElement("span");
    pid.className = "pid";
    pid.textContent = String(item.id);
    const name = document.createElement("span");
    name.className = "pname";
    name.textContent = item.name;
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "삭제";
    del.addEventListener("click", () => onDelete(item.id));
    row.append(pid, name, del);
    containerEl.appendChild(row);
  }
}

function buildTgListUrl(s) {
  if (!s.tgMyId || !s.tgProjectId) return null;
  return `https://app.teamgantt.com/projects/list?companyResourceIds=${s.tgMyId}&ids=${s.tgProjectId}`;
}

async function syncFinalUrl() {
  const s = await getSettings();
  $("tg-final-url").value = buildTgListUrl(s) ?? "";
}

function debounce(fn, ms = 300) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}


async function handleOpenTg() {
  const s = await getSettings();
  const url = buildTgListUrl(s);
  if (!url) {
    showSnackbar("프로젝트와 사용자를 먼저 선택하세요.", { kind: "error" });
    return;
  }
  chrome.tabs.create({ url });
}

async function handleCollectTgFetch() {
  const s = await getSettings();
  if (!s.tgProjectId) {
    showSnackbar("프로젝트를 먼저 선택하세요.", { kind: "error" });
    return;
  }
  const cache = await getTgFetchCache();
  const entry = cache[String(s.tgProjectId)];
  if (!entry) {
    const [tab] = await chrome.tabs.query({ url: "https://app.teamgantt.com/projects/*" });
    if (tab) {
      showSnackbar("캐시 없음. TeamGantt 탭을 새로고침하면 자동 캐시됩니다.", {
        kind: "error",
        actionLabel: "새로고침",
        onAction: () => chrome.tabs.reload(tab.id),
        duration: 8000,
      });
    } else {
      showSnackbar("TeamGantt 탭이 없습니다. List 뷰를 열어주세요.", {
        kind: "error",
        actionLabel: "TeamGantt 열기",
        onAction: handleOpenTg,
        duration: 8000,
      });
    }
    return;
  }
  const ageMin = Math.round((Date.now() - entry.at) / 60000);
  const normalized = normalizeTgFromFetch(entry.data, {
    prefixRegex: s.prefixRegex,
    myTgId: s.tgMyId,
  }).map((t) => ({ ...t, source: "api" }));
  if (normalized.length === 0) {
    showSnackbar(`정규화 결과 0건. (캡처 ${ageMin}분 전, payload가 비었거나 myTgId 불일치)`,
      { kind: "error", duration: 6000 });
    return;
  }
  const result = await upsertTgTasks(normalized);
  showSnackbar(
    `TeamGantt 수집(API): 신규 ${result.added} / 갱신 ${result.updated} / 동일 ${result.skipped} · 누적 ${result.total} (캡처 ${ageMin}분 전)`,
    { kind: "ok", duration: 5000 }
  );
  await renderTgTable();
}

async function handleCollectTgDom() {
  const s = await getSettings();
  const [tab] = await chrome.tabs.query({ url: "https://app.teamgantt.com/projects/*", active: true, currentWindow: true })
    .then((arr) => arr.length ? arr : chrome.tabs.query({ url: "https://app.teamgantt.com/projects/*" }));
  if (!tab) {
    showSnackbar("TeamGantt List 뷰 페이지를 먼저 여세요.", {
      kind: "error", actionLabel: "TeamGantt 열기", onAction: handleOpenTg, duration: 8000,
    });
    return;
  }

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_TG_DOM" });
  } catch (e) {
    showSnackbar("TeamGantt 페이지와 연결이 끊어졌습니다. 페이지를 새로고침해주세요.",
      { kind: "error", duration: 5000 });
    return;
  }
  if (!resp?.ok) {
    showSnackbar(`수집 실패: ${resp?.error ?? "unknown"}`, { kind: "error" });
    return;
  }

  const { tasks, projectId, filteredPersonIds } = resp.data;
  if (tasks.length === 0) {
    showSnackbar("task 0건: List 뷰가 떠 있는지 확인하세요.",
      { kind: "error", duration: 6000 });
    return;
  }

  const myId = String(s.tgMyId ?? "");
  const myName = (s.tgPeople ?? []).find((p) => String(p.id) === myId)?.name;
  const mismatch = myId && filteredPersonIds.length && !filteredPersonIds.includes(myId);
  const warn = mismatch
    ? `\n⚠ TeamGantt 필터(${filteredPersonIds.join(", ")})와 본인 ID(${myId})가 다릅니다.`
    : !myId
      ? `\n⚠ 본인 ID 미설정.`
      : "";

  const prefix = myName ? `[${myName}] ` : "";
  const ok = confirm(
    `${prefix}${tasks.length}건을 저장합니다.${warn}\n\n`
    + DATE_MISSING_TIP
  );
  if (!ok) return;

  // 정규식으로 jiraKey 추출 + projectId 부여
  const re = s.prefixRegex ? new RegExp(s.prefixRegex) : null;
  const normalized = tasks.map((t) => ({
    id: t.id,
    rawTitle: t.rawTitle,
    jiraKey: re ? (t.rawTitle.match(re)?.[1] ?? null) : null,
    start: t.start ? t.start.replaceAll("/", "-") : null,
    end:   t.end   ? t.end.replaceAll("/", "-")   : null,
    progress: t.progress,
    assignees: t.assignees,
    projectId: projectId ? Number(projectId) : null,
    source: "dom",
  }));

  const result = await upsertTgTasks(normalized);
  showSnackbar(
    `TeamGantt 수집(DOM): 신규 ${result.added} / 갱신 ${result.updated} / 동일 ${result.skipped} · 누적 ${result.total} (이번 ${tasks.length}건)`,
    { kind: "ok", duration: 5000 }
  );
  await renderTgTable();
}

async function renderTgTable() {
  const { tgTasks, settings } = await getAll();
  const tbody = document.querySelector("#tg-table tbody");
  tbody.replaceChildren();
  const list = Object.values(tgTasks).sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""));
  const total = list.length;
  const pageSize = Number(settings.tgPageSize) || 100;
  const slice = pageSize === 0 ? list : list.slice((tgPage - 1) * pageSize, tgPage * pageSize);
  for (const it of slice) {
    const tr = document.createElement("tr");
    const tdK = document.createElement("td"); tdK.textContent = it.jiraKey ?? "";
    const tdN = document.createElement("td"); tdN.textContent = it.rawTitle ?? "";
    const tdS = document.createElement("td");
    const tdE = document.createElement("td");
    const showWarn = it.source === "dom" && !it.start && !it.end;
    if (showWarn) {
      for (const td of [tdS, tdE]) {
        td.textContent = "⚠️";
        td.classList.add("tip");
        td.setAttribute("data-tip", DATE_MISSING_TIP);
      }
    } else {
      tdS.textContent = it.start ?? "";
      tdE.textContent = it.end ?? "";
    }
    const tdP = document.createElement("td");
    // 옛 데이터엔 "100%" 문자열, 새 데이터엔 100 숫자. 중복 % 방지.
    const progressStr = it.progress != null ? String(it.progress).replace(/%$/, "") + "%" : "";
    tdP.textContent = progressStr;
    tr.append(tdK, tdN, tdS, tdE, tdP);
    tbody.appendChild(tr);
  }
  $("tg-status").textContent = `누적 ${total}건`;
  renderPager($("tg-pager"), total, pageSize, tgPage, (p) => {
    tgPage = p;
    renderTgTable();
  });
}

export async function initTgTab() {
  const elMyId   = $("tg-my-id");
  const elProjId = $("tg-project-id");

  let people = [];
  let projects = [];

  function refreshUI() {
    fillSelect(elMyId, people, elMyId.value);
    fillSelect(elProjId, projects, elProjId.value);
    renderPresetList($("people-list"), people, async (id) => {
      people = people.filter((p) => p.id !== id);
      await setSettings({ tgPeople: people });
      refreshUI();
      showSnackbar("사람 1명 삭제");
    });
    renderPresetList($("projects-list"), projects, async (id) => {
      projects = projects.filter((p) => p.id !== id);
      await setSettings({ tgProjects: projects });
      refreshUI();
      showSnackbar("프로젝트 1개 삭제");
    });
  }

  const s = await getSettings();
  elMyId.value = s.tgMyId ?? "";
  elProjId.value = s.tgProjectId ?? "";
  people   = Array.isArray(s.tgPeople)   ? s.tgPeople   : [];
  projects = Array.isArray(s.tgProjects) ? s.tgProjects : [];

  // JSON textarea 마지막 입력값 복원.
  // value=""도 placeholder는 정상 표시되지만, 명시적 빈 문자열을 굳이 박지 않아도 결과는 같으므로 truthy만 set.
  if (s.personJsonDraft) $("person-json").value = s.personJsonDraft;
  if (s.projectJsonDraft) $("project-json").value = s.projectJsonDraft;
  if (s.projectApiDraft) $("project-api-json").value = s.projectApiDraft;
  if (s.personApiDraft) $("person-api-json").value = s.personApiDraft;

  const savePersonDraft = debounce(async () => {
    await setSettings({ personJsonDraft: $("person-json").value });
  }, 400);
  const saveProjectDraft = debounce(async () => {
    await setSettings({ projectJsonDraft: $("project-json").value });
  }, 400);
  const saveProjectApiDraft = debounce(async () => {
    await setSettings({ projectApiDraft: $("project-api-json").value });
  }, 400);
  const savePersonApiDraft = debounce(async () => {
    await setSettings({ personApiDraft: $("person-api-json").value });
  }, 400);
  $("person-json").addEventListener("input", savePersonDraft);
  $("project-json").addEventListener("input", saveProjectDraft);
  $("project-api-json").addEventListener("input", saveProjectApiDraft);
  $("person-api-json").addEventListener("input", savePersonApiDraft);

  refreshUI();
  elMyId.value = s.tgMyId ?? "";
  elProjId.value = s.tgProjectId ?? "";

  elMyId.addEventListener("change", async () => {
    await setSettings({ tgMyId: elMyId.value });
    await syncFinalUrl();
  });
  elProjId.addEventListener("change", async () => {
    await setSettings({ tgProjectId: elProjId.value });
    await syncFinalUrl();
  });

  $("tg-final-url").addEventListener("click", () => {
    const v = $("tg-final-url").value;
    if (!v) { showSnackbar("프로젝트와 사용자를 먼저 선택하세요.", { kind: "error" }); return; }
    chrome.tabs.create({ url: v });
  });
  document.querySelector('.tab-btn[data-tab="tg"]').addEventListener("click", syncFinalUrl);

  // 1명/1개 추가
  $("btn-person-add").addEventListener("click", async () => {
    const id = Number($("person-add-id").value.trim());
    const name = $("person-add-name").value.trim();
    if (!Number.isFinite(id) || !name) {
      showSnackbar("ID(숫자)와 이름 둘 다 필요합니다.", { kind: "error" });
      return;
    }
    people = sortedByName(dedupe([...people, { id, name }]));
    await setSettings({ tgPeople: people });
    $("person-add-id").value = ""; $("person-add-name").value = "";
    refreshUI();
    showSnackbar(`사람 추가: ${name} (${id})`);
  });
  $("btn-project-add").addEventListener("click", async () => {
    const id = Number($("project-add-id").value.trim());
    const name = $("project-add-name").value.trim();
    if (!Number.isFinite(id) || !name) {
      showSnackbar("ID(숫자)와 이름 둘 다 필요합니다.", { kind: "error" });
      return;
    }
    projects = sortedByName(dedupe([...projects, { id, name }]));
    await setSettings({ tgProjects: projects });
    $("project-add-id").value = ""; $("project-add-name").value = "";
    refreshUI();
    showSnackbar(`프로젝트 추가: ${name} (${id})`);
  });

  async function applyJson(key, current, raw, mode) {
    let parsed;
    try { parsed = parsePresetJson(raw); }
    catch (e) { showSnackbar(`JSON 파싱 실패: ${e.message}`, { kind: "error" }); return null; }
    if (parsed.length === 0) { showSnackbar("유효한 항목이 없습니다.", { kind: "error" }); return null; }
    const merged = mode === "replace" ? parsed : dedupe([...current, ...parsed]);
    const next = sortedByName(merged);
    await setSettings({ [key]: next });
    return next;
  }

  $("btn-person-json-merge").addEventListener("click", async () => {
    const next = await applyJson("tgPeople", people, $("person-json").value, "merge");
    if (next) { people = next; refreshUI(); showSnackbar(`사람 병합 (총 ${next.length}명)`); }
  });
  $("btn-person-json-replace").addEventListener("click", async () => {
    if (!confirm("기존 사람 목록을 모두 덮어씁니다. 진행할까요?")) return;
    const next = await applyJson("tgPeople", people, $("person-json").value, "replace");
    if (next) { people = next; refreshUI(); showSnackbar(`사람 덮어쓰기 (총 ${next.length}명)`); }
  });
  $("btn-person-clear").addEventListener("click", async () => {
    if (!confirm("사람 목록 전체를 삭제합니다. 진행할까요?")) return;
    people = []; await setSettings({ tgPeople: people }); refreshUI();
    showSnackbar("사람 목록 전체 삭제");
  });
  $("btn-project-json-merge").addEventListener("click", async () => {
    const next = await applyJson("tgProjects", projects, $("project-json").value, "merge");
    if (next) { projects = next; refreshUI(); showSnackbar(`프로젝트 병합 (총 ${next.length}개)`); }
  });
  $("btn-project-json-replace").addEventListener("click", async () => {
    if (!confirm("기존 프로젝트 목록을 모두 덮어씁니다. 진행할까요?")) return;
    const next = await applyJson("tgProjects", projects, $("project-json").value, "replace");
    if (next) { projects = next; refreshUI(); showSnackbar(`프로젝트 덮어쓰기 (총 ${next.length}개)`); }
  });
  $("btn-project-clear").addEventListener("click", async () => {
    if (!confirm("프로젝트 목록 전체를 삭제합니다. 진행할까요?")) return;
    projects = []; await setSettings({ tgProjects: projects }); refreshUI();
    showSnackbar("프로젝트 목록 전체 삭제");
  });

  // ── 목록 자동 조회 (API 추출) — 프로젝트/사용자 공용 ──
  // 흐름: 열린 TG 탭의 MAIN 훅에서 Authorization 토큰만 받아오고(content script 경유),
  // 실제 api.teamgantt.com 호출은 사이드패널이 직접 한다. host_permissions 덕에 확장 컨텍스트
  // 발 요청은 CORS가 면제되지만, MAIN(페이지) 컨텍스트 발은 막힌다.
  const PROJECTS_URL = "https://api.teamgantt.com/v1/projects/all?fields[]=id&fields[]=name&status=active";

  // 열린 TG 탭을 찾아 MAIN 훅에서 토큰을 받는다. 실패 시 안내 스낵바를 띄우고 null 반환.
  async function resolveTgToken() {
    const tabs = await chrome.tabs.query({ url: "https://app.teamgantt.com/*" });
    const tab = tabs.find((t) => t.active) ?? tabs[0];
    if (!tab) {
      showSnackbar("TeamGantt 탭이 없습니다. 프로젝트 페이지를 먼저 열어주세요.", {
        kind: "error", actionLabel: "TeamGantt 열기",
        onAction: () => chrome.tabs.create({ url: $("project-mgr-url").value || "https://app.teamgantt.com/" }),
        duration: 8000,
      });
      return null;
    }
    let tokenResp;
    try {
      tokenResp = await chrome.tabs.sendMessage(tab.id, { type: "GET_TG_TOKEN" });
    } catch (_e) {
      showSnackbar("TeamGantt 페이지와 연결이 끊겼습니다. 확장 갱신 후 그 페이지를 새로고침(F5)해주세요.", {
        kind: "error", actionLabel: "새로고침", onAction: () => chrome.tabs.reload(tab.id), duration: 8000,
      });
      return null;
    }
    if (!tokenResp?.auth) {
      showSnackbar("인증 토큰을 아직 못 잡았습니다. TeamGantt 탭을 새로고침하면 토큰이 잡힙니다.", {
        kind: "error", actionLabel: "새로고침", onAction: () => chrome.tabs.reload(tab.id), duration: 8000,
      });
      return null;
    }
    return { auth: tokenResp.auth, tab };
  }

  // 사이드패널에서 직접 fetch(CORS 면제). 실패 시 안내 스낵바 + null.
  async function fetchTgJson(url, auth, tab) {
    let res;
    try {
      res = await fetch(url, { headers: { authorization: auth } });
    } catch (e) {
      showSnackbar(`네트워크 오류: ${e?.message ?? e}`, { kind: "error", duration: 6000 });
      return null;
    }
    if (!res.ok) {
      showSnackbar(`조회 실패 (HTTP ${res.status}). 토큰 만료면 TeamGantt 탭을 새로고침하세요.`, {
        kind: "error", actionLabel: "새로고침", onAction: () => chrome.tabs.reload(tab.id), duration: 8000,
      });
      return null;
    }
    return res.json();
  }

  function extractProjectList(data) {
    // 응답이 최상위 배열이든 {projects:[...]} 래퍼든 수용 (normalizeTgFromFetch와 같은 방어 패턴).
    const raw = Array.isArray(data) ? data
      : (Array.isArray(data?.projects) ? data.projects : []);
    return raw
      .map((p) => ({ id: Number(p?.id), name: String(p?.name ?? "").trim() }))
      .filter((p) => Number.isFinite(p.id) && p.name);
  }

  // people 응답 구조는 불확실(토큰 만료로 미확인) → 여러 후보 컨테이너/이름 필드를 방어적으로 시도.
  function extractPeopleList(data) {
    const raw = Array.isArray(data) ? data
      : (Array.isArray(data?.resources) ? data.resources
      : (Array.isArray(data?.company_resources) ? data.company_resources
      : (Array.isArray(data?.people) ? data.people : [])));
    return raw
      .map((p) => {
        const id = Number(p?.id ?? p?.resource_id);
        const name = String(p?.name ?? [p?.first_name, p?.last_name].filter(Boolean).join(" ")).trim();
        return { id, name };
      })
      .filter((p) => Number.isFinite(p.id) && p.name);
  }

  let tgApiBusy = false; // 프로젝트/사용자 추출 공용 연타 가드

  // 버튼 로딩 스피너 토글 + 공용 에러 캐치.
  async function runApiExtract(btnId, fn) {
    if (tgApiBusy) return;
    tgApiBusy = true;
    const btn = $(btnId);
    btn.disabled = true;
    btn.classList.add("is-loading");
    try {
      await fn();
    } catch (e) {
      showSnackbar(`추출 실패: ${e?.message ?? e}`, { kind: "error", duration: 6000 });
    } finally {
      tgApiBusy = false;
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
  }

  async function handleFetchProjectsApi() {
    await runApiExtract("btn-project-fetch-api", async () => {
      const t = await resolveTgToken();
      if (!t) return;
      const data = await fetchTgJson(PROJECTS_URL, t.auth, t.tab);
      if (!data) return;
      const list = extractProjectList(data);
      if (list.length === 0) {
        showSnackbar("응답에 프로젝트가 없습니다. (구조가 예상과 다름)", { kind: "error", duration: 6000 });
        return;
      }
      const json = JSON.stringify(list, null, 2);
      $("project-api-json").value = json;
      await setSettings({ projectApiDraft: json }); // .value 할당은 input 이벤트를 안 띄우므로 직접 저장
      showSnackbar(`프로젝트 ${list.length}건 추출됨 — [병합 적용] 또는 [덮어쓰기 적용]을 누르세요.`, { kind: "ok", duration: 6000 });
    });
  }

  async function handleFetchPeopleApi() {
    await runApiExtract("btn-person-fetch-api", async () => {
      const t = await resolveTgToken();
      if (!t) return;
      // people API는 companyId가 필요 → 프로젝트 응답의 company_id를 먼저 얻는다.
      const projData = await fetchTgJson(PROJECTS_URL, t.auth, t.tab);
      if (!projData) return;
      const projList = Array.isArray(projData) ? projData : (projData?.projects ?? []);
      const companyId = projList.map((p) => p?.company_id).find((v) => v != null);
      if (companyId == null) {
        showSnackbar("companyId를 못 찾았습니다(프로젝트 0개?). JSON 탭으로 수동 입력하세요.", { kind: "error", duration: 7000 });
        return;
      }
      const peopleData = await fetchTgJson(
        `https://api.teamgantt.com/v1/companies/${companyId}/resources/company`, t.auth, t.tab);
      if (!peopleData) return;
      const list = extractPeopleList(peopleData);
      if (list.length === 0) {
        // 구조 미지 → 원본을 박스에 덤프해 사용자가 보고 수동 처리/제보할 수 있게.
        const dump = JSON.stringify(peopleData, null, 2);
        $("person-api-json").value = dump;
        await setSettings({ personApiDraft: dump });
        showSnackbar("자동 추출 실패 — 원본 응답을 박스에 표시했습니다. 구조 확인이 필요합니다.", { kind: "error", duration: 8000 });
        return;
      }
      const json = JSON.stringify(list, null, 2);
      $("person-api-json").value = json;
      await setSettings({ personApiDraft: json });
      showSnackbar(`사용자 ${list.length}명 추출됨 — [병합 적용] 또는 [덮어쓰기 적용]을 누르세요.`, { kind: "ok", duration: 6000 });
    });
  }

  $("btn-project-fetch-api").addEventListener("click", handleFetchProjectsApi);
  $("btn-project-api-merge").addEventListener("click", async () => {
    const next = await applyJson("tgProjects", projects, $("project-api-json").value, "merge");
    if (next) { projects = next; refreshUI(); showSnackbar(`프로젝트 병합 (총 ${next.length}개)`); }
  });
  $("btn-project-api-replace").addEventListener("click", async () => {
    if (!confirm("기존 프로젝트 목록을 모두 덮어씁니다. 진행할까요?")) return;
    const next = await applyJson("tgProjects", projects, $("project-api-json").value, "replace");
    if (next) { projects = next; refreshUI(); showSnackbar(`프로젝트 덮어쓰기 (총 ${next.length}개)`); }
  });
  $("project-mgr-url").addEventListener("click", () => {
    const v = $("project-mgr-url").value;
    if (v) chrome.tabs.create({ url: v });
  });

  $("btn-person-fetch-api").addEventListener("click", handleFetchPeopleApi);
  $("btn-person-api-merge").addEventListener("click", async () => {
    const next = await applyJson("tgPeople", people, $("person-api-json").value, "merge");
    if (next) { people = next; refreshUI(); showSnackbar(`사용자 병합 (총 ${next.length}명)`); }
  });
  $("btn-person-api-replace").addEventListener("click", async () => {
    if (!confirm("기존 사용자 목록을 모두 덮어씁니다. 진행할까요?")) return;
    const next = await applyJson("tgPeople", people, $("person-api-json").value, "replace");
    if (next) { people = next; refreshUI(); showSnackbar(`사용자 덮어쓰기 (총 ${next.length}명)`); }
  });

  $("btn-collect-tg-fetch").addEventListener("click", handleCollectTgFetch);
  $("btn-collect-tg-dom").addEventListener("click", handleCollectTgDom);

  $("tg-page-size").value = String(s.tgPageSize ?? 100);
  $("tg-page-size").addEventListener("change", async () => {
    const v = Number($("tg-page-size").value);
    await setSettings({ tgPageSize: v });
    tgPage = 1;
    await renderTgTable();
  });

  $("btn-clear-tg").addEventListener("click", async () => {
    if (!confirm("저장된 TeamGantt 작업과 fetch 캐시를 모두 삭제합니다. 진행할까요? (설정은 유지)")) return;
    await clearTgTasks();
    tgPage = 1;
    showSnackbar("TeamGantt 작업 전체 삭제됨.", { kind: "ok" });
    await renderTgTable();
  });

  function openDialog(id) { $(id).classList.remove("hidden"); }
  function closeDialog(id) { $(id).classList.add("hidden"); }

  // 모달 내부 입력방식 탭(API 자동 / JSON / 1줄 추가) 전환.
  function selectModalTab(dialogId, key) {
    const dlg = $(dialogId);
    for (const t of dlg.querySelectorAll(".modal-tab"))
      t.classList.toggle("active", t.dataset.ptab === key);
    for (const p of dlg.querySelectorAll(".modal-panel"))
      p.classList.toggle("hidden", p.dataset.ppanel !== key);
  }
  function initModalTabs(dialogId) {
    for (const tab of $(dialogId).querySelectorAll(".modal-tab"))
      tab.addEventListener("click", () => selectModalTab(dialogId, tab.dataset.ptab));
  }
  initModalTabs("project-mgr-dialog");
  initModalTabs("person-mgr-dialog");

  $("btn-open-person-mgr").addEventListener("click", () => {
    selectModalTab("person-mgr-dialog", "api"); // 열 때마다 주력인 API 자동 탭으로 시작
    openDialog("person-mgr-dialog");
  });
  $("btn-open-project-mgr").addEventListener("click", async () => {
    // 프로젝트/사용자 미설정(부트스트랩) 상태면 홈으로 폴백 — 아무 프로젝트나 열면 훅이 동작한다.
    const cur = await getSettings();
    $("project-mgr-url").value = buildTgListUrl(cur) ?? "https://app.teamgantt.com/";
    selectModalTab("project-mgr-dialog", "api"); // 열 때마다 주력인 API 자동 탭으로 시작
    openDialog("project-mgr-dialog");
  });

  for (const id of ["person-mgr-dialog", "project-mgr-dialog"]) {
    const dlg = $(id);
    dlg.querySelectorAll("[data-close]").forEach((btn) => {
      btn.addEventListener("click", () => closeDialog(btn.dataset.close));
    });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) closeDialog(id); });
  }

  await syncFinalUrl();
  await renderTgTable();
}
