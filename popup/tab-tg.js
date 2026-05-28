import {
  getAll, getSettings, setSettings,
  upsertTgTasks, getTgFetchCache, normalizeTgFromFetch, clearTgTasks,
} from "../lib/storage.js";
import { showSnackbar } from "./snackbar.js";
import { renderPager } from "./pager.js";

let tgPage = 1;

function $(id) { return document.getElementById(id); }

function dedupe(items) {
  const map = new Map();
  for (const it of items) map.set(it.id, it);
  return [...map.values()];
}

function parsePresetJson(raw) {
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("JSON 최상위가 배열이어야 합니다.");
  const out = [];
  for (const item of data) {
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
      showSnackbar("TeamGantt fetch 캐시 비어있음. TeamGantt 탭을 새로고침하면 자동으로 가로채집니다.", {
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
  });
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
    showSnackbar("TeamGantt 프로젝트 페이지가 열려있지 않습니다. List 뷰를 먼저 여세요.", {
      kind: "error", actionLabel: "TeamGantt 열기", onAction: handleOpenTg, duration: 8000,
    });
    return;
  }

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_TG_DOM" });
  } catch (e) {
    showSnackbar("페이지와 확장 프로그램의 연결이 끊어졌습니다. TeamGantt 페이지를 새로고침 해주세요.",
      { kind: "error", duration: 5000 });
    return;
  }
  if (!resp?.ok) {
    showSnackbar(`수집 실패: ${resp?.error ?? "unknown"}`, { kind: "error" });
    return;
  }

  const { tasks, projectId, filteredPersonIds } = resp.data;
  if (tasks.length === 0) {
    showSnackbar("화면에 보이는 task 행이 0건입니다. List 뷰가 떠 있고 행이 보이는지 확인하세요.",
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
    `${prefix}${tasks.length}건을 저장합니다.${warn}`
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
    const tdS = document.createElement("td"); tdS.textContent = it.start ?? "";
    const tdE = document.createElement("td"); tdE.textContent = it.end ?? "";
    const tdP = document.createElement("td"); tdP.textContent = it.progress != null ? `${it.progress}%` : "";
    tr.append(tdK, tdN, tdS, tdE, tdP);
    tbody.appendChild(tr);
  }
  $("tg-status").textContent = pageSize === 0
    ? `누적 ${total}건`
    : `누적 ${total}건 · 페이지 ${tgPage}/${Math.max(1, Math.ceil(total / pageSize))}`;
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
  // value="" 도 placeholder 는 정상 표시되지만, 명시적 빈 문자열을 굳이 박지 않아도 결과는 같으므로 truthy 만 set.
  if (s.personJsonDraft) $("person-json").value = s.personJsonDraft;
  if (s.projectJsonDraft) $("project-json").value = s.projectJsonDraft;

  const savePersonDraft = debounce(async () => {
    await setSettings({ personJsonDraft: $("person-json").value });
  }, 400);
  const saveProjectDraft = debounce(async () => {
    await setSettings({ projectJsonDraft: $("project-json").value });
  }, 400);
  $("person-json").addEventListener("input", savePersonDraft);
  $("project-json").addEventListener("input", saveProjectDraft);

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

  $("btn-open-person-mgr").addEventListener("click", () => openDialog("person-mgr-dialog"));
  $("btn-open-project-mgr").addEventListener("click", () => openDialog("project-mgr-dialog"));

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
