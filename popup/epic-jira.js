// 에픽 탭의 두 화면(에픽에 연결, 변경 기록)이 함께 쓰는 Jira 통신과 작업 상태.
import { showSnackbar } from "./snackbar.js";
import { setParentInTab } from "./epic-write.js";

// 동시에 보내는 수정 요청 수.
// 한 건씩 보내면 수백 건에 몇 분이 걸리고, 너무 많이 열면 Jira가 429로 막는다.
const CONCURRENCY = 3;

export const STALE_TAB = "Jira 탭이 응답하지 않습니다. 그 탭을 새로고침(F5)한 뒤 다시 시도하세요.";

// Jira에 쓰는 작업은 두 화면을 통틀어 한 번에 하나만 돌린다.
// 연결하는 도중에 변경 기록에서 취소를 누르면 같은 이슈에 요청이 엇갈릴 수 있다.
// stop은 [중지]가 세우는 깃발이고, 다음 요청을 보내기 전에 본다.
export const job = { busy: false, stop: false };

export function snackBusy() {
  showSnackbar("다른 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요.", { kind: "error" });
}

// REST는 atlassian.net과 같은 출처인 콘텐트 스크립트가 쿠키 세션으로 보낸다.
// 그래서 어느 Jira 탭이든 열려 있기만 하면 된다.
export async function findJiraTab() {
  let [tab] = await chrome.tabs.query({ url: "https://*.atlassian.net/*", active: true, currentWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ url: "https://*.atlassian.net/*" });
  return tab ?? null;
}

export function snackNoJiraTab() {
  showSnackbar("Jira 탭이 없습니다. 아무 Jira 페이지나 열어 주세요.", { kind: "error", duration: 7000 });
}

export function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 실행 결과를 한 줄로 만들고, out은 applyParents가 돌려준 값이다.
export function resultText(verb, done, failed, left, out, skipped = 0) {
  const parts = [`${verb} ${done}건 완료`];
  if (failed) parts.push(`실패 ${failed}건(사유는 표에 있음)`);
  if (skipped) parts.push(`그 사이 상위가 바뀌어 건너뛴 ${skipped}건`);
  if (left) parts.push(`보내지 않은 ${left}건`);
  return `${parts.join(", ")}.`
    + (out.notified ? " 알림을 켠 채로 보냈습니다." : "")
    + (out.error ? ` 오류로 중간에 멈췄습니다: ${out.error}` : "");
}

export async function openIssue(key) {
  const tab = await findJiraTab();
  const { settings } = await chrome.storage.local.get("settings");
  const domain = settings?.jiraDomain;
  const origin = tab?.url ? new URL(tab.url).origin : (domain ? `https://${domain}` : "");
  if (origin) chrome.tabs.create({ url: `${origin}/browse/${encodeURIComponent(key)}` });
}

export async function searchJql(tabId, jql, fields) {
  let r;
  try {
    r = await chrome.tabs.sendMessage(tabId, { type: "COLLECT_JIRA_REST", jql, fields });
  } catch {
    return { ok: false, error: STALE_TAB };
  }
  if (!r) return { ok: false, error: STALE_TAB };
  if (!r.ok) return r;
  // 확장을 고친 뒤 Jira 탭을 새로고침하지 않으면 예전 스크립트가 fields 지정을 무시한다.
  // 그러면 상위(parent) 없이 응답이 와서 모든 이슈가 상위 없음으로 보이고, 이미 다른 에픽에 있는 이슈까지 옮기게 된다.
  if (!fields.every((f) => r.data?.fields?.includes(f))) return { ok: false, error: STALE_TAB };
  return r;
}

// 지난번에 통한 상위 떼기 방법 번호.
// 탭 안에서 실행할 때마다 넘겨서, 다음 이슈부터는 그 방법부터 쓰게 한다.
let detachFirst = 0;

// item.to가 새 상위 키이고, null이면 상위를 뗀다.
// item에 expect가 있으면 지금 상위가 그 값일 때만 바꾼다.
// 쓰기는 탭에 심어 둔 스크립트를 거치지 않고, 그때마다 setParentInTab을 탭에 넣어 실행한다(epic-write.js 참고).
async function sendSetParent(tabId, item, notify) {
  const args = { key: item.key, parentKey: item.to ?? null, notify, detachFirst };
  if ("expect" in item) args.expect = item.expect ?? null;
  try {
    const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func: setParentInTab, args: [args] });
    const r = frame?.result;
    if (!r) return { ok: false, disconnected: true, error: "Jira 탭에서 실행하지 못했습니다. 그 탭을 새로고침(F5)한 뒤 다시 시도하세요." };
    if (Number.isInteger(r.detachUsed)) detachFirst = r.detachUsed;
    return r;
  } catch (e) {
    return { ok: false, disconnected: true, error: `Jira 탭에서 실행하지 못했습니다: ${String(e?.message ?? e)}` };
  }
}

async function runPool(items, worker) {
  let next = 0;
  const lane = async () => {
    while (next < items.length && !job.stop) {
      try {
        await worker(items[next++]);
      } catch (e) {
        job.stop = true;
        throw e;
      }
    }
  };
  // 한 레인이 예외로 끝나도 나머지 레인이 다 멈출 때까지 기다린다.
  // Promise.all은 첫 예외에서 바로 돌아오므로, 화면은 끝났다고 보이는데 요청이 계속 나가는 일이 생긴다.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, items.length) }, lane));
  const failed = settled.find((s) => s.status === "rejected");
  if (failed) throw failed.reason;
}

// 상위 변경 요청을 보낸다.
// 첫 건을 먼저 보내서 알림 끄기 옵션이 받아들여지는지 본 뒤, 나머지를 같은 조건으로 나눠 보낸다.
// items는 [{ key, to, expect }]이고 onResult(item, res)는 건마다 불린다.
// res.skipped는 지금 상위가 expect와 달라서 쓰지 않은 건이다.
// 돌려주는 notified는 알림을 켠 채로 보냈는지, error는 도중에 멈추게 한 예외다.
export async function applyParents(tabId, items, onResult) {
  const out = { notified: false, error: null };
  if (!items.length) return out;
  try {
    // 건너뛴 건은 쓰지 않은 것이라 알림 끄기가 통하는지 알려 주지 않는다.
    // 실제로 쓴 첫 건이 나올 때까지 하나씩 보낸다.
    let i = 0;
    let res = null;
    for (; i < items.length && !job.stop; i++) {
      res = await sendSetParent(tabId, items[i], false);
      if (!res.skipped) break;
      await onResult(items[i], res);
    }
    if (i >= items.length || job.stop) return out;
    const first = items[i];
    const rest = items.slice(i + 1);
    // 쓴 뒤 다시 읽어 보니 그대로였던 실패(unchanged)는 알림과 상관없으니 묻지 않는다.
    if (!res.ok && !res.disconnected && !res.unchanged) {
      // 알림 끄기(notifyUsers=false)는 Jira 관리자나 프로젝트 관리자만 쓸 수 있다.
      // 실패 응답만으로는 그 때문인지 다른 이유인지 가릴 수 없어서, 알림을 켜고 한 번 더 보낼지 묻는다.
      const again = confirm(
        `첫 건(${first.key})이 실패했습니다.\n사유: ${res.error}\n\n`
        + "알림 메일을 끄는 옵션은 Jira 관리자나 프로젝트 관리자만 쓸 수 있어서 거절됐을 수 있습니다.\n"
        + "알림을 켠 채로 다시 보낼까요? 이슈의 보고자와 지켜보는 사람에게 변경 알림이 갈 수 있습니다."
      );
      if (again) {
        out.notified = true;
        res = await sendSetParent(tabId, first, true);
      }
    }
    await onResult(first, res);
    if (!res.ok) return out;
    await runPool(rest, async (item) => {
      const r = await sendSetParent(tabId, item, out.notified);
      // 탭이 닫히거나 새로고침되면 남은 요청도 모두 실패한다.
      // 실패를 쌓지 않고 거기서 멈춘다.
      if (r.disconnected) job.stop = true;
      await onResult(item, r);
    });
  } catch (e) {
    out.error = String(e?.message ?? e);
  }
  return out;
}

// 취소하기 전에 지금 상위를 확인한다.
// key in (...)으로 100건씩 묻는다.
// summaries는 건너뛴 이슈의 화면 상태를 지금 상위로 맞추는 데 쓴다.
export async function fetchCurrentParents(tabId, keys) {
  const parents = new Map();
  const summaries = new Map();
  const valid = keys.filter((k) => /^[A-Z][A-Z0-9_]*-\d+$/.test(k));
  const keep = (issues) => {
    for (const it of issues ?? []) {
      parents.set(it.key, it.fields?.parent?.key ?? null);
      summaries.set(it.key, it.fields?.parent?.fields?.summary ?? "");
    }
  };
  for (let i = 0; i < valid.length; i += 100) {
    const chunk = valid.slice(i, i + 100);
    const r = await searchJql(tabId, `key in (${chunk.join(",")})`, ["parent"]);
    if (r.ok) { keep(r.data.issues); continue; }
    if (r.error === STALE_TAB) return { ok: false, error: r.error };
    // 그 사이 삭제된 이슈가 끼어 있으면 Jira가 JQL 전체를 거절한다.
    // 그대로 멈추면 이 기록은 영영 취소할 수 없으므로, 이 묶음만 한 건씩 다시 묻는다.
    // 끝내 조회되지 않는 이슈는 건너뛴다.
    for (const key of chunk) {
      const one = await searchJql(tabId, `key = ${key}`, ["parent"]);
      if (one.ok) keep(one.data.issues);
      else if (one.error === STALE_TAB) return { ok: false, error: one.error };
    }
  }
  return { ok: true, parents, summaries };
}

// 두 화면은 서로를 직접 부르지 않고 이벤트로 알린다.
// parents-changed는 Jira에서 상위가 바뀐 이슈 목록이고, history-changed는 변경 기록이 바뀌었다는 뜻이다.
export const EV_PARENTS = "epic:parents-changed";
export const EV_HISTORY = "epic:history-changed";

export function announce(type, detail = null) {
  document.dispatchEvent(new CustomEvent(type, { detail }));
}
