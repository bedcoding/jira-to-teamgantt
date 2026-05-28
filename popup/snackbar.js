let hideTimer = null;

function el() { return document.getElementById("snackbar"); }

export function showSnackbar(message, opts = {}) {
  const {
    kind = "info",         // "info" | "ok" | "error"
    duration = 4000,       // ms, 0 이면 자동 닫기 안 함
    actionLabel = null,    // 액션 버튼 라벨
    onAction = null,       // 클릭 핸들러
  } = opts;

  const root = el();
  if (!root) return;
  const msgEl = root.querySelector(".snackbar-msg");
  const actEl = root.querySelector(".snackbar-action");
  const closeEl = root.querySelector(".snackbar-close");

  msgEl.textContent = message;
  root.classList.remove("hidden", "error", "ok");
  if (kind === "error") root.classList.add("error");
  if (kind === "ok")    root.classList.add("ok");

  if (actionLabel && typeof onAction === "function") {
    actEl.textContent = actionLabel;
    actEl.classList.remove("hidden");
    actEl.onclick = () => { hideSnackbar(); onAction(); };
  } else {
    actEl.classList.add("hidden");
    actEl.onclick = null;
  }
  closeEl.onclick = hideSnackbar;

  if (hideTimer) clearTimeout(hideTimer);
  if (duration > 0) hideTimer = setTimeout(hideSnackbar, duration);
}

export function hideSnackbar() {
  const root = el();
  if (root) root.classList.add("hidden");
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}
