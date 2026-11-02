// 확장 사이드패널을 가짜 데이터로 띄워 스토어용 1280x800 스크린샷을 찍는다.
// 확장 코드는 그대로 쓰고, chrome API와 데이터만 mock.js로 바꿔 끼운다.
// 실행: node scripts/shots/capture.mjs [--readme] [출력 폴더] [장면 이름...]
// 출력 폴더를 비우면 레포의 store-screenshots/에 저장한다.
// --readme를 붙이면 README에 넣을 화면을 docs/screenshots/에 찍는다.
// README용은 크기를 맞추지 않고 탭 내용이 다 들어가는 높이로 찍어서 표가 잘리지 않는다.
// playwright-core 1.45 이상이 필요하고, 브라우저는 설치된 Chrome을 쓴다.
// 설치는 `npm i -g playwright-core`로 하고, 다른 곳에 설치돼 있으면 그 경로를 PLAYWRIGHT_CORE에 넣는다.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..", "..");
const ARGS = process.argv.slice(2);
const README = ARGS[0] === "--readme";
if (README) ARGS.shift();
const OUT = ARGS[0] ?? path.join(EXT, README ? "docs/screenshots" : "store-screenshots");
const ONLY = ARGS.slice(1);
const W = 1280;
const H = 800;
// 화면을 125%로 키워 찍는다.
// 스토어는 스크린샷을 줄여서 보여 주므로 12px 글자가 그대로면 읽기 어렵다.
const SCALE = 1.25;
// README용은 GitHub 본문 폭에 맞춰 800px로 찍는다.
// 레티나 화면에서 흐리지 않게 2배로 찍는다.
const README_W = 800;
const README_SCALE = 2;

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const tries = [process.env.PLAYWRIGHT_CORE, "playwright-core"];
  try {
    tries.push(path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "playwright-core"));
  } catch {}
  for (const name of tries.filter(Boolean)) {
    try {
      return require(name);
    } catch {}
  }
  console.error("playwright-core를 찾지 못했습니다.");
  console.error("`npm i -g playwright-core`로 설치하거나, 설치된 경로를 PLAYWRIGHT_CORE에 넣고 다시 실행하세요.");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const click = (id) => (page) => page.evaluate((x) => document.getElementById(x).click(), id);
const wait = (ms) => (page) => page.waitForTimeout(ms);

// 패널 안에서 그 요소가 맨 위에 오도록 내린다.
const scrollTo = (id) => (page) => page.evaluate((x) => {
  const el = document.getElementById(x);
  const panel = el.closest(".tab-panel");
  panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12;
}, id);

// README용은 탭 내용이 다 들어가는 높이로 화면을 다시 맞춘다.
// 창이 열려 있으면 그 창이 들어가는 높이로 맞춘다.
async function fitHeight(page) {
  const height = await page.evaluate(() => {
    const dialog = document.querySelector(".bp-backdrop:not(.hidden) .bp-dialog");
    // 창 위아래에 40px씩 여백이 있다.
    if (dialog) return dialog.offsetHeight + 80;
    const panel = document.querySelector(".tab-panel.active");
    // 추출 탭의 글상자는 남는 높이를 다 채우므로 글이 차지하는 만큼으로 줄인다.
    // 마지막 줄이 테두리에 붙지 않게 조금 남긴다.
    for (const t of panel.querySelectorAll("textarea")) {
      t.style.flex = "none";
      t.style.height = "0";
      t.style.height = `${t.scrollHeight + 12}px`;
    }
    const bottom = Math.max(...[...panel.children].map((c) => c.getBoundingClientRect().bottom));
    return Math.ceil(bottom + panel.scrollTop + parseFloat(getComputedStyle(panel).paddingBottom));
  });
  await page.setViewportSize({ width: README_W, height });
}

// 접어 둔 변경 기록 묶음을 펼친다.
// 옮기기 묶음에 있는 취소한 행까지 보이게 하려는 것이다.
const openRuns = (page) => page.evaluate(() => {
  for (const d of document.querySelectorAll("#epic-history-list details:not([open])")) d.open = true;
});

// 장면 이름과 저장할 파일 이름이다.
// 앞의 다섯 장이 스토어에 올릴 추천 순서다.
// README용은 장면 이름을 그대로 파일 이름으로 쓴다.
const SCENES = [
  ["compare", "1-compare", [click("btn-tg-api-load-groups"), wait(400)]],
  ["epic-link", "2-epic-link", [click("btn-epic-load"), wait(600), scrollTo("epic-month-box")]],
  ["epic-history", "3-epic-history", [openRuns]],
  ["epic-report", "4-epic-report", [click("btn-epic-history-report")]],
  ["jira", "5-jira", []],
  ["tg", "6-tg", []],
  ["report", "7-report", []],
];
// README에 넣는 장면이다.
// 추가 내역 창은 README에 글 예시가 따로 있어서 뺀다.
const README_SCENES = ["jira", "tg", "compare", "report", "epic-link", "epic-history"];
const PICK = ONLY.length ? ONLY : README ? README_SCENES : SCENES.map(([name]) => name);

const { chromium } = loadPlaywright();
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });

for (const [name, file, steps] of SCENES) {
  if (!PICK.includes(name)) continue;
  const context = await browser.newContext({
    // README용은 넉넉한 높이로 띄운 뒤 찍기 직전에 내용 높이로 줄인다.
    viewport: README ? { width: README_W, height: 1600 } : { width: Math.round(W / SCALE), height: Math.round(H / SCALE) },
    deviceScaleFactor: README ? README_SCALE : SCALE,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  // 확장 폴더를 localhost로 내보낸다.
  // localhost여야 보안 출처로 취급돼서 확장이 쓰는 crypto.subtle이 동작한다.
  await context.route("http://localhost:4567/**", (route) => {
    const file = path.join(EXT, decodeURIComponent(new URL(route.request().url()).pathname));
    if (!file.startsWith(EXT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? "application/octet-stream", body: fs.readFileSync(file) });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error(`[${name}] pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") console.error(`[${name}] console: ${m.text()}`); });
  // 날짜를 고정해서 언제 찍어도 같은 화면이 나오게 한다.
  await page.clock.setFixedTime(new Date("2026-09-29T14:42:00+09:00"));
  await page.addInitScript(`window.__SHOT = ${JSON.stringify(name)};`);
  await page.addInitScript({ path: path.join(HERE, "mock.js") });
  await page.goto("http://localhost:4567/popup/popup.html");
  await page.waitForTimeout(800);
  // 알림 막대와 입력 커서는 화면을 가려서 숨긴다.
  await page.addStyleTag({ content: "#snackbar{display:none!important} *{caret-color:transparent!important}" });
  for (const step of steps) await step(page);
  await page.waitForTimeout(400);
  if (README) {
    await fitHeight(page);
    await page.waitForTimeout(200);
  }
  const out = `${README ? name : file}.png`;
  await page.screenshot({ path: path.join(OUT, out) });
  console.log(out);
  await context.close();
}
await browser.close();
