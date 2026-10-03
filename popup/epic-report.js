// 보고용 내역 창.
// 에픽에 넣은 건수를 에픽별로 정리해 보여 주고, 그대로 복사해 보고에 붙일 수 있게 한다.
import { formatEpicReport } from "../lib/epic-link.js";
import { showSnackbar } from "./snackbar.js";

let onHistory = null;

function $(id) { return document.getElementById(id); }

// lead는 창 맨 위의 안내 한 줄(실행 결과나 정리 범위)이다.
// text를 주면 그 글을 그대로 보이고, 없으면 items로 넣은 내역 정리 글을 만든다.
// showHistory를 넘기면 [변경 기록 보기]가 보이고, 누르면 창을 닫은 뒤 그것을 부른다.
export function showEpicReport({ title, lead = "", items = [], text: given = null, showHistory = null }) {
  $("epic-report-title").textContent = title;
  $("epic-report-lead").textContent = lead;
  $("epic-report-lead").classList.toggle("hidden", !lead);
  const text = given ?? formatEpicReport(items);
  $("epic-report-text").value = text || "정리할 변경이 없습니다.";
  $("btn-epic-report-copy").disabled = !text;
  onHistory = showHistory;
  $("btn-epic-report-history").classList.toggle("hidden", !showHistory);
  $("epic-report-dialog").classList.remove("hidden");
}

function close() {
  $("epic-report-dialog").classList.add("hidden");
}

async function copy() {
  const text = $("epic-report-text").value;
  try {
    await navigator.clipboard.writeText(text);
    showSnackbar("복사했습니다.", { kind: "ok" });
  } catch {
    // 패널이 포커스를 잃은 순간 등에는 클립보드 쓰기가 거절될 수 있다.
    // 그때는 글을 선택해서 예전 방식(execCommand)으로 한 번 더 복사해 보고, 그것도 안 되면 직접 복사하게 둔다.
    const area = $("epic-report-text");
    area.focus();
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    if (ok) showSnackbar("복사했습니다.", { kind: "ok" });
    else showSnackbar("복사하지 못했습니다. 글을 선택해 두었으니 Cmd+C(또는 Ctrl+C)로 복사하세요.", { kind: "error", duration: 7000 });
  }
}

export function initEpicReport() {
  const dlg = $("epic-report-dialog");
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg || e.target.closest("[data-close]")) close();
  });
  $("btn-epic-report-copy").addEventListener("click", copy);
  $("btn-epic-report-history").addEventListener("click", () => {
    close();
    onHistory?.();
  });
}
