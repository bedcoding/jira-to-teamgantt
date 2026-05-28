// total: 전체 항목 수, pageSize: 0이면 전체, page: 현재 페이지(1-based), onGo: (page) => void
export function renderPager(el, total, pageSize, page, onGo) {
  el.replaceChildren();
  if (!pageSize || total <= pageSize) return;
  const last = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(Math.max(1, page), last);

  const mk = (label, target, opts = {}) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (opts.active) b.classList.add("active");
    if (opts.disabled) b.disabled = true;
    if (!opts.disabled) b.addEventListener("click", () => onGo(target));
    return b;
  };

  el.appendChild(mk("«", 1, { disabled: cur === 1 }));
  el.appendChild(mk("‹", cur - 1, { disabled: cur === 1 }));

  // 페이지 번호: 현재 페이지 주변 ±2, 양 끝 1·last 항상 표시
  const pages = new Set([1, last, cur - 2, cur - 1, cur, cur + 1, cur + 2].filter((n) => n >= 1 && n <= last));
  const sorted = [...pages].sort((a, b) => a - b);
  let prev = 0;
  for (const n of sorted) {
    if (prev && n - prev > 1) {
      const span = document.createElement("span");
      span.className = "pager-ellipsis";
      span.textContent = "…";
      el.appendChild(span);
    }
    el.appendChild(mk(String(n), n, { active: n === cur }));
    prev = n;
  }

  el.appendChild(mk("›", cur + 1, { disabled: cur === last }));
  el.appendChild(mk("»", last, { disabled: cur === last }));
}
