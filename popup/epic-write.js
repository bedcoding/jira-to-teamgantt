// Jira 탭 안에서 이슈의 상위(에픽)를 바꾸는 함수.
// 사이드패널이 chrome.scripting.executeScript로 그때그때 탭에 넣어 실행한다.
// 콘텐트 스크립트로 미리 심어 두면 확장을 고친 뒤 탭을 새로고침해야 새 코드가 도는데, 크롬이 탭 쪽 스크립트를 확장을 불러올 때 읽어 두기 때문에 새로고침해도 예전 코드가 남는 일이 있었다.
// 그 예전 코드가 확인 없이 쓰기만 해서 '성공했는데 안 바뀐' 기록이 생겼으므로, 쓰기는 늘 이 최신 코드로 돌게 한다.
// 탭 안으로 직렬화되어 들어가므로 바깥 변수를 쓰지 않고 필요한 것을 모두 이 함수 안에 둔다.

// args는 { key, parentKey, expect, notify, detachFirst }다.
// parentKey가 있으면 그 에픽 아래로 넣고, null이면 상위를 뗀다.
// expect를 주면(null 포함) 지금 상위가 그 값일 때만 바꾸고, 다르면 쓰지 않고 skipped로 돌려준다.
// notify가 false면 notifyUsers=false를 붙여 알림 메일을 끈다.
// detachFirst는 지난번에 통한 떼기 방법 번호이고, 이번에 통한 번호는 detachUsed로 돌려준다.
export async function setParentInTab(args) {
  const { key, parentKey = null, notify = false } = args;
  const hasExpect = Object.prototype.hasOwnProperty.call(args, "expect");
  const detachFirst = Number.isInteger(args.detachFirst) ? args.detachFirst : 0;
  const origin = location.origin;
  // 429(요청 한도 초과)를 받았을 때 다시 보내 보는 횟수.
  const MAX_RETRY = 3;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Jira 오류 응답은 { errorMessages: [...], errors: { 필드: 메시지 } } 모양이다.
  const readError = async (res) => {
    try {
      const j = await res.json();
      const parts = [...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})].filter(Boolean);
      if (parts.length) return parts.join(" / ");
    } catch {}
    return `HTTP ${res.status}`;
  };

  const send = async (path, method, body) => {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(`${origin}${path}`, {
          method,
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            // 쿠키 세션으로 쓰기 요청을 보낼 때 Jira의 XSRF 검사를 건너뛰게 하는 헤더.
            "X-Atlassian-Token": "no-check",
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        return { ok: false, status: 0, error: `네트워크 오류: ${String(e?.message ?? e)}` };
      }
      if (res.ok) return { ok: true, status: res.status };
      if (res.status === 429 && attempt < MAX_RETRY) {
        const sec = Number(res.headers.get("Retry-After"));
        await sleep((Number.isFinite(sec) && sec > 0 ? Math.min(sec, 30) : 2 ** attempt) * 1000);
        continue;
      }
      return { ok: false, status: res.status, error: await readError(res) };
    }
  };

  // 검색(JQL)은 방금 바꾼 값이 몇 초 늦게 보일 수 있어서, 쓰기 전후 확인에는 이슈 조회를 쓴다.
  const readParent = async () => {
    try {
      const res = await fetch(`${origin}/rest/api/3/issue/${encodeURIComponent(key)}?fields=parent`, {
        credentials: "include",
        headers: { "Accept": "application/json" },
      });
      if (!res.ok) return { ok: false, status: res.status, error: `지금 상위를 읽지 못했습니다: ${await readError(res)}` };
      const json = await res.json();
      return { ok: true, parentKey: json.fields?.parent?.key ?? null, parentSummary: json.fields?.parent?.fields?.summary ?? "" };
    } catch (e) {
      return { ok: false, status: 0, error: `네트워크 오류: ${String(e?.message ?? e)}` };
    }
  };

  const confirmParent = async (expected, write) => {
    const r = await readParent();
    if (!r.ok) return r;
    if (r.parentKey === expected) return { ok: true, status: write.status };
    return {
      ok: false, status: write.status, unchanged: true,
      error: `Jira가 요청을 받았지만 상위가 바뀌지 않았습니다 (지금 상위 ${r.parentKey ?? "없음"})`,
    };
  };

  if (hasExpect) {
    const expect = args.expect ?? null;
    const now = await readParent();
    if (!now.ok && now.status === 404) {
      return { ok: false, skipped: true, missing: true, error: "이슈를 찾을 수 없어서 건드리지 않았습니다" };
    }
    if (!now.ok) return now;
    if (now.parentKey !== expect) {
      return {
        ok: false, skipped: true, current: now.parentKey, currentSummary: now.parentSummary,
        error: now.parentKey
          ? `그 사이 상위가 바뀌어서 건드리지 않았습니다 (지금 상위 ${now.parentKey})`
          : "그 사이 상위가 비워져서 건드리지 않았습니다",
      };
    }
  }

  const issuePath = `/rest/api/3/issue/${encodeURIComponent(key)}${notify ? "" : "?notifyUsers=false"}`;
  if (parentKey) {
    const w = await send(issuePath, "PUT", { fields: { parent: { key: parentKey } } });
    return w.ok ? confirmParent(parentKey, w) : w;
  }

  // 상위를 떼는 방법들.
  // update.parent.set.none은 공식 문서에 나오는 방법인데, 회사 관리형 프로젝트에서 204로 성공을 돌려주고도 상위를 그대로 둔 적이 있다.
  // 그래서 하나씩 보내 보고, 실제로 떼졌는지 다시 읽어 확인한 뒤에야 성공으로 친다.
  // 에픽 전용 API(epic/none)는 알림 끄기 옵션이 없어서 PUT 방식들 뒤에 둔다.
  const detach = [
    () => send(issuePath, "PUT", { fields: { parent: null } }),
    () => send(issuePath, "PUT", { fields: { parent: { key: null } } }),
    () => send("/rest/agile/1.0/epic/none/issue", "POST", { issues: [key] }),
    () => send(issuePath, "PUT", { fields: { parent: {} } }),
    () => send(issuePath, "PUT", { update: { parent: [{ set: { none: true } }] } }),
  ];
  let last = null;
  for (let n = 0; n < detach.length; n++) {
    const i = (detachFirst + n) % detach.length;
    const w = await detach[i]();
    // 403(권한, 알림 끄기 거절 포함)과 네트워크 오류는 방법을 바꿔도 그대로라 바로 돌려준다.
    if (!w.ok && (w.status === 403 || w.status === 0)) return w;
    if (!w.ok) { last = w; continue; }
    const c = await confirmParent(null, w);
    if (c.ok) return { ...c, detachUsed: i };
    if (!c.unchanged) return c;
    last = c;
  }
  return last ?? { ok: false, status: 0, error: "상위를 떼지 못했습니다." };
}
