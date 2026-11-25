// 无头验证（V-1 翻页动画：View Transitions 快照双叶）
// 前置：① node tools/cdp/make-synth-epub.mjs（生成 temp/synth-turn.epub，合成测试书）
//       ② Vite dev server 在 14200（npx vite）
//       ③ 无头 Chrome 在 9333（chrome --headless=new --remote-debugging-port=9333 --user-data-dir=<F 盘临时目录>）
// 用法：node tools/cdp/verify-turn.mjs [场景片段，逗号分隔：sheet/cross/rapid/input/end/reduced/spread]
// 手法：合成书 + Tauri IPC 假后端 → 应用内真实翻页 → **暂停伪元素动画并定位到指定进度后截图**（确定性逐帧）→ 拼成对照表；
//       每帧做像素统计（偏离中位亮度的像素占比）判空白；跨章更新期间连拍；连按 / 输入 / 书末 / reduced-motion / 双页各一组断言。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, sleep } from "./cdp-lib.mjs";
import { MOCK, ipcShimSource } from "./ipc-shim.mjs";

const EPUB = process.argv.find((a) => a.startsWith("epub="))?.slice(5) ?? "temp/synth-turn.epub";
const only = (process.argv.find((a) => a.startsWith("only="))?.slice(5) ?? "").split(",").filter(Boolean);
const OUT = "F:/bookreading-project/temp/turn-shots";
mkdirSync(OUT, { recursive: true });
const URL_READER = "http://localhost:14200/read/synth-turn";
const T = [0.06, 0.2, 0.35, 0.5, 0.65, 0.8, 0.94];
const PAD = 24;

const c = await connect(9333, /.*/);
await c.send("Page.enable");
await c.send("Runtime.enable");
const ev = (s) => c.evaluate(s);
const J = (s) => c.evaluate(s).then(JSON.parse);
const pageSource = readFileSync(new URL("./verify-turn.page.js", import.meta.url), "utf8");
const epubB64 = readFileSync(EPUB).toString("base64");
const BOOK = {
  id: "synth-turn", title: "合成测试书（翻页验证用）", author: "示例作者", cover_path: null, library_path: "library/epub/synth-turn.epub",
  added_at: 1_700_000_000, last_opened_at: null, note: null, pinned_at: null, reading_percent: null, is_favorite: false,
  format: "epub", page_count: null, shelf_id: 1, sort_order: null, deleted_at: null, description: null, content_chars: null,
  file_size: 0, tags: [],
};
const HIGHLIGHTS = [
  { id: "synth-h1", book_id: "synth-turn", cfi_range: "epubcfi(/6/2!/4/6/1:6,/4/6/1:52)", color: "#ffe600", note: null, text: null, created_at: 0 },
  { id: "synth-h2", book_id: "synth-turn", cfi_range: "epubcfi(/6/4!/4/8/1:20,/4/8/1:64)", color: "#ffe600", note: null, text: null, created_at: 0 },
];
let scriptId = null;
const report = { scenarios: {}, failures: [] };
const fail = (scenario, msg) => {
  report.failures.push(`${scenario}: ${msg}`);
};

/** 打开合成书到阅读页（每次重设假设置：效果 / 主题 / 速度 / 起始位置） */
async function open({ effect, theme = "ink", turnSpeedMs = "260", viewport = [1350, 801], state = null }) {
  if (scriptId) await c.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
  const mock = JSON.parse(JSON.stringify(MOCK));
  Object.assign(mock.settings, { pageAnimation: effect, theme, turnSpeedMs, layoutMode: "auto", fontSizePercent: "120" });
  mock.books = [{ ...BOOK, file_size: readFileSync(EPUB).length }];
  const source =
    ipcShimSource(mock) +
    "\n(() => {\n" +
    "  const M = window.__MOCK__;\n" +
    "  const I = window.__TAURI_INTERNALS__;\n" +
    "  const orig = I.invoke;\n" +
    `  const epub = Uint8Array.from(atob(${JSON.stringify(epubB64)}), (ch) => ch.charCodeAt(0));\n` +
    `  M.highlights = ${JSON.stringify(HIGHLIGHTS)};\n` +
    `  M.state = ${state ? JSON.stringify(state) : "null"};\n` +
    "  I.invoke = async (cmd, args = {}) => {\n" +
    "    const a = args;\n" +
    "    switch (cmd) {\n" +
    '      case "get_book": return a.bookId === "synth-turn" ? { ...M.data.books[0] } : null;\n' +
    '      case "read_library_file": return epub;\n' +
    '      case "get_reading_state": return M.state ? { ...M.state } : null;\n' +
    '      case "upsert_reading_state": M.state = { book_id: a.bookId, cfi: a.cfi, percent: a.percent, updated_at: 0 }; return null;\n' +
    '      case "list_bookmarks": return [];\n' +
    '      case "list_highlights": return JSON.parse(JSON.stringify(M.highlights));\n' +
    '      case "list_favorite_quotes": return [];\n' +
    '      case "load_book_locations": return null;\n' +
    '      case "save_book_locations": return null;\n' +
    '      case "add_reading_time": return null;\n' +
    '      case "plugin:path|resolve_directory": return "C:\\\\Users\\\\Someone\\\\AppData\\\\Roaming\\\\com.root.bookreading";\n' +
    "      default: return orig(cmd, args);\n" +
    "    }\n" +
    "  };\n" +
    "  // 记录 WAAPI 伪元素动画（暂停 / 定位进度做确定性取证）\n" +
    "  window.__anims = [];\n" +
    "  const animate = Element.prototype.animate;\n" +
    "  Element.prototype.animate = function (kf, opts) {\n" +
    "    const a = animate.call(this, kf, opts);\n" +
    "    if (opts && opts.pseudoElement) window.__anims.push({ a, pseudo: opts.pseudoElement, duration: opts.duration });\n" +
    "    return a;\n" +
    "  };\n" +
    "})();\n" +
    pageSource;
  const r = await c.send("Page.addScriptToEvaluateOnNewDocument", { source });
  scriptId = r.identifier;
  c.logs.length = 0;
  await c.viewport(viewport[0], viewport[1]);
  await c.send("Page.navigate", { url: URL_READER });
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`!!(document.querySelector(".wr-reader-leaf iframe") && document.querySelector(".wr-reader-leaf .epub-view"))`).catch(() => false);
    if (ok) break;
    await sleep(250);
  }
  await sleep(1800); // 首章排版 / 主题注入 / 高亮附加
}

const state = () => ev(`JSON.stringify(window.__VT.state())`).then(JSON.parse);
const key = (dir) => ev(`window.__VT.key(${JSON.stringify(dir > 0 ? "ArrowRight" : "ArrowLeft")}); 1`);
async function shot(file) {
  const rect = await ev(`JSON.stringify(window.__VT.paperRect(${PAD}))`).then(JSON.parse);
  const r = await c.send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 } });
  if (file) writeFileSync(file, Buffer.from(r.data, "base64"));
  const ink = await ev(`window.__VT.ink("data:image/png;base64,${r.data}", ${PAD})`);
  return ink;
}
/** 普通翻一页并等它收尾 */
async function simpleTurn(dir) {
  await key(dir);
  await ev(`window.__VT.waitIdle(8000)`);
  await sleep(120);
}
/** 翻一页 → 等动画出现 → 暂停并定位到进度 t → 截图（返回像素统计）→ 收尾 */
async function seekShot(file, dir, t) {
  await ev(`window.__anims.length = 0`);
  await key(dir);
  const has = await ev(`window.__VT.waitAnims(4000)`);
  if (!has) return null;
  await ev(`window.__VT.seek(${t})`);
  const ink = await shot(file);
  await ev(`window.__VT.cancel()`);
  await ev(`window.__VT.waitIdle(8000)`);
  await sleep(120);
  return ink;
}
function sheet(name, files) {
  const w = 380, h = 340, cols = 4;
  const rows = Math.ceil(files.length / cols);
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#888;font:12px sans-serif;color:#fff"><div style="display:grid;grid-template-columns:repeat(${cols},${w}px);gap:4px;padding:4px">${files
      .map(([f, label]) => `<div><div style="height:16px">${label}</div><img src="${f}.png" style="width:${w}px;height:${h}px;display:block"></div>`)
      .join("")}</div></body>`,
    "utf8",
  );
}
async function buildSheet(name, files) {
  sheet(name, files);
  await c.viewport(4 * 380 + 20, Math.ceil(files.length / 4) * 360 + 8);
  await c.send("Page.navigate", { url: `file:///${OUT}/${name}.html` });
  await sleep(500);
  await c.screenshot(`${OUT}/SHEET-${name}.png`);
}

// epub.js 建视图管理器时挂 unload 监听，Chromium 会按弃用策略打一条 Permissions policy 日志——与翻页无关，略过
const errors = () =>
  c.logs.filter((l) => /error|exception/i.test(l.kind) && !/unload is not allowed/.test(l.text)).map((l) => l.text.slice(0, 300));
const want = (scenario, cond, msg) => {
  if (!cond) fail(scenario, msg);
};

// ───── sheet：各效果 × 方向 × 主题的确定性逐帧 ─────
async function doSheet({ name, effect, dir, theme, viewport }) {
  await open({ effect, theme, viewport });
  await simpleTurn(1);
  await simpleTurn(1); // 第 3 页起：前后都是正文页
  const base = await state();
  const files = [];
  const inks = [];
  let seekOk = true;
  for (const t of T) {
    const f = `${name}-t${String(Math.round(t * 100)).padStart(2, "0")}`;
    const ink = await seekShot(`${OUT}/${f}.png`, dir, t);
    if (!ink) {
      fail(name, `t=${t} 没有产生动画`);
      seekOk = false;
      break;
    }
    inks.push(+ink.ink.toFixed(4));
    files.push([f, `${name} t=${t} ink=${(ink.ink * 100).toFixed(1)}%`]);
    await simpleTurn(-dir); // 回到同一页：每帧都是同一对新旧页
  }
  const end = await state();
  want(name, inks.length === T.length && inks.every((v) => v > 0.008), `存在近似空白的帧：${inks.join(",")}`);
  want(name, end.spine === base.spine && end.scrollLeft === base.scrollLeft, `收尾后位置不对：${JSON.stringify({ base, end })}`);
  want(name, end.bands === 0 && end.turning === null && end.iframes === 1, `有残留：${JSON.stringify(end)}`);
  const errs = errors();
  want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
  await buildSheet(name, files);
  report.scenarios[name] = { inks, base, end, errors: errs };
}

// ───── cross：跨章（epub.js 先销毁旧 iframe 再建新）更新期间连拍不露白 ─────
async function doCross({ name, effect, theme }) {
  await open({ effect, theme });
  for (let i = 0; i < 40; i++) {
    await simpleTurn(1);
    if ((await state()).spine === 1) break;
  }
  await simpleTurn(-1); // 回到第 1 章末页（这本身就是一次跨章后退）
  await sleep(1900); // 让阅读状态落库，记下末页 CFI
  const before = await state();
  const dir = name.includes("prev") ? -1 : 1;
  if (dir < 0) {
    // 后退跨章：先站到第 2 章首页
    await simpleTurn(1);
    await sleep(300);
  }
  const from = await state();
  await c.send("Emulation.setCPUThrottlingRate", { rate: 8 }); // 放慢重建，好拍更新期间的帧
  await ev(`window.__anims.length = 0`);
  await key(dir);
  const burst = [];
  for (let i = 0; i < 7; i++) {
    const s = await state();
    const ink = await shot(null);
    burst.push({ i, ink: +(ink.ink * 100).toFixed(2), turning: s.turning, anims: await ev(`window.__anims.length`), spine: s.spine });
  }
  await c.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const frames = [];
  if (await ev(`window.__VT.waitAnims(4000)`)) {
    for (const t of [0.3, 0.65]) {
      await ev(`window.__VT.seek(${t})`);
      const ink = await shot(`${OUT}/${name}-t${Math.round(t * 100)}.png`);
      frames.push([`${name}-t${Math.round(t * 100)}`, `${name} t=${t} ink=${(ink.ink * 100).toFixed(1)}%`]);
    }
    await ev(`window.__VT.cancel()`);
  }
  await ev(`window.__VT.waitIdle(8000)`);
  await sleep(300);
  const after = await state();
  want(name, burst.every((b) => b.ink > 0.8), `更新 / 动画期间出现空白帧：${JSON.stringify(burst)}`);
  want(name, after.spine === (dir > 0 ? 1 : 0) && after.spine !== from.spine, `没有跨章：${JSON.stringify({ from, after })}`);
  want(name, after.bands === 0 && after.turning === null && after.iframes === 1, `有残留：${JSON.stringify(after)}`);
  const errs = errors();
  want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
  if (frames.length) await buildSheet(name, frames);
  report.scenarios[name] = { before, from, burst, after, errors: errs };
}

// ───── rapid：连按 60 次（约 35ms 一次，夹杂后退）───
async function doRapid({ effect }) {
  const name = `rapid-${effect}`;
  await open({ effect, theme: "ink" });
  await c.send("Emulation.setCPUThrottlingRate", { rate: 2 });
  const n = await ev(`(() => { window.__anims.length = 0; const keys = []; for (let i = 0; i < 60; i++) keys.push(i % 5 === 4 ? "ArrowLeft" : "ArrowRight"); keys.forEach((k, i) => setTimeout(() => window.__VT.key(k), i * 35)); return keys.length; })()`);
  await sleep(n * 35 + 60); // 等按键全部发完
  const t0 = Date.now();
  const idle = await ev(`window.__VT.waitIdle(20000)`);
  const ms = Date.now() - t0;
  await c.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await sleep(400);
  const s = await state();
  await simpleTurn(1);
  const s2 = await state();
  await simpleTurn(-1);
  const s3 = await state();
  want(name, idle, "队列 20s 没排空");
  want(name, s.bands === 0 && s.turning === null && s.iframes === 1, `有残留：${JSON.stringify(s)}`);
  want(name, s.spine !== null && s.spine >= 3, `没有连翻出去：${JSON.stringify(s)}（共 ${n} 次按键）`);
  want(name, s2.spine !== s.spine || s2.scrollLeft !== s.scrollLeft, "连按之后翻不动了");
  want(name, s3.spine === s.spine && s3.scrollLeft === s.scrollLeft, "连按之后前后翻不对账");
  const errs = errors();
  want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
  report.scenarios[name] = { ms, idle, s, s2, s3, errors: errs };
}

// ───── input：过渡动画进行中，热区点击 / 滚轮照常翻页 ─────
async function doInput() {
  const name = "input-during-turn";
  await open({ effect: "slide", theme: "ink", turnSpeedMs: "600" });
  const click = async (selector) => {
    const [x, y] = await ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify([b.left + b.width / 2, b.top + b.height / 2]); })()`).then(JSON.parse);
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  /** 站到第 1 章第 n 个版面（从章首数） */
  const goTo = async (n) => {
    for (let i = 0; i < 12; i++) {
      const s = await state();
      if (s.spine === 0 && s.scrollLeft === n * s.pageWidth) return;
      if (s.spine > 0 || s.scrollLeft > n * s.pageWidth) await simpleTurn(-1);
      else await simpleTurn(1);
    }
  };
  /** 动画停在中段时给一次输入：应打断当前动画并再翻一页；expected = 相对起点的两次推进（[章内步数, 是否跨到下一章]） */
  const run = async (type, from, expect) => {
    await goTo(from);
    await sleep(500); // 滚轮冷却
    const s0 = await state();
    await ev(`window.__anims.length = 0; 1`);
    await key(1);
    await ev(`window.__VT.waitAnims(4000)`);
    await ev(`window.__VT.seek(0.5)`); // 过渡停在中段
    const anims0 = await ev(`window.__anims.length`);
    if (type === "click") await click(".wr-edge-tap--right");
    else await c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 540, y: 380, deltaX: 0, deltaY: 120 });
    await sleep(250);
    const anims1 = await ev(`window.__anims.length`);
    await ev(`window.__VT.cancel()`);
    await ev(`window.__VT.waitIdle(8000)`);
    await sleep(250);
    const s1 = await state();
    const want1 = { spine: expect.cross ? 1 : 0, scrollLeft: expect.cross ? (expect.after || 0) * s0.pageWidth : (from + 2) * s0.pageWidth };
    const ok = s1.spine === want1.spine && s1.scrollLeft === want1.scrollLeft;
    want(name, anims1 > anims0, `${type}：过渡期间没有触发第二次翻页 ${JSON.stringify({ anims0, anims1 })}`);
    want(name, ok, `${type}：两次翻页后位置不对 ${JSON.stringify({ s0, s1, want1 })}`);
    return { type, anims0, anims1, from: s0.scrollLeft, to: s1.scrollLeft, spine: s1.spine };
  };
  const results = [
    await run("click", 1, {}), // 章内两步：第 2 → 第 4 个版面
    await run("wheel", 1, {}),
    await run("click", 4, { cross: true, after: 1 }), // 第 5 个版面是第 1 章末：第一步跨到第 2 章首页，第二步紧接着在新章里再翻
  ];
  const errs = errors();
  want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
  report.scenarios[name] = { results, errors: errs };
}

// ───── end：书末再翻不空翻、不残留 ─────
async function doEnd() {
  const name = "book-end";
  await open({ effect: "paper", theme: "ink" });
  await c.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await ev(`(() => { for (let i = 0; i < 80; i++) setTimeout(() => window.__VT.key("ArrowRight"), i * 40); return 1; })()`);
  await ev(`window.__VT.waitIdle(20000)`);
  await sleep(600);
  const s0 = await state();
  await ev(`window.__anims.length = 0`);
  await simpleTurn(1);
  await sleep(300);
  const s1 = await state();
  const anims = await ev(`window.__anims.length`);
  want(name, s0.spine === 7, `没有走到末章：${JSON.stringify(s0)}`);
  want(name, s0.spine === s1.spine && s0.scrollLeft === s1.scrollLeft, `书末再翻却变了：${JSON.stringify({ s0, s1 })}`);
  want(name, anims === 0, `书末再翻却播了动画（页面没变不该播）`);
  want(name, s1.bands === 0 && s1.turning === null, `有残留：${JSON.stringify(s1)}`);
  const errs = errors();
  want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
  report.scenarios[name] = { s0, s1, anims, errors: errs };
  // 书首后退同理
  await open({ effect: "paper", theme: "ink" });
  const b0 = await state();
  await ev(`window.__anims.length = 0`);
  await simpleTurn(-1);
  await sleep(300);
  const b1 = await state();
  want(name, b0.spine === 0 && b1.spine === 0 && b0.scrollLeft === b1.scrollLeft, `书首后退却变了：${JSON.stringify({ b0, b1 })}`);
  want(name, (await ev(`window.__anims.length`)) === 0 && b1.bands === 0 && b1.turning === null, "书首后退残留了动画 / 遮罩条");
}

// ───── reduced：系统"减少动态效果"时不播动画 ─────
async function doReduced() {
  const name = "reduced-motion";
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await open({ effect: "paper", theme: "ink" });
  const s0 = await state();
  await ev(`window.__anims.length = 0`);
  await simpleTurn(1);
  await simpleTurn(1);
  const s1 = await state();
  await c.send("Emulation.setEmulatedMedia", { features: [] });
  want(name, (await ev(`window.__anims.length`)) === 0, "reduced-motion 下仍创建了动画");
  want(name, s1.spine === s0.spine && s1.scrollLeft === s0.scrollLeft + 2 * s1.pageWidth, `不播动画时翻页不对：${JSON.stringify({ s0, s1 })}`);
  const errs = errors();
  want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
  report.scenarios[name] = { s0, s1, errors: errs };
}

const PLAN = {
  sheet: async () => {
    for (const [effect, dir, theme, name] of [
      ["slide", 1, "ink", "ink-slide-next"],
      ["slide", -1, "ink", "ink-slide-prev"],
      ["cover", 1, "ink", "ink-cover-next"],
      ["cover", -1, "ink", "ink-cover-prev"],
      ["fade", 1, "ink", "ink-fade-next"],
      ["paper", 1, "ink", "ink-paper-next"],
      ["paper", -1, "ink", "ink-paper-prev"],
      ["cover", 1, "dark", "dark-cover-next"],
      ["paper", 1, "dark", "dark-paper-next"],
      ["paper", -1, "dark", "dark-paper-prev"],
      ["cover", 1, "sepia", "sepia-cover-next"],
    ]) {
      await doSheet({ name, effect, dir, theme, viewport: [1100, 760] }); // 单页版式
    }
  },
  spread: async () => {
    for (const [effect, name] of [["slide", "spread-slide-next"], ["paper", "spread-paper-next"]]) {
      await doSheet({ name, effect, dir: 1, theme: "ink", viewport: [1350, 801] }); // auto 版式在 ≥1200 宽时是双页
      want(name, report.scenarios[name].end.pageWidth > 1000, `没有进入双页：${JSON.stringify(report.scenarios[name].end)}`);
    }
  },
  cross: async () => {
    for (const [effect, name] of [["slide", "cross-slide-next"], ["cover", "cross-cover-prev"], ["fade", "cross-fade-next"], ["paper", "cross-paper-next"], ["none", "cross-none-next"]]) {
      await doCross({ name, effect, theme: "ink" });
    }
  },
  rapid: async () => {
    for (const effect of ["slide", "paper"]) await doRapid({ effect });
  },
  input: doInput,
  end: doEnd,
  reduced: doReduced,
};

const order = ["sheet", "cross", "rapid", "input", "end", "reduced", "spread"];
for (const id of order) {
  if (only.length && !only.some((o) => id.includes(o))) continue;
  try {
    await PLAN[id]();
  } catch (e) {
    fail(id, `场景执行异常：${String(e && e.message ? e.message : e).slice(0, 400)}`);
  }
}
await c.send("Emulation.setCPUThrottlingRate", { rate: 1 });
await c.send("Emulation.setEmulatedMedia", { features: [] });
if (scriptId) await c.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
writeFileSync("F:/bookreading-project/temp/verify-turn.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ failures: report.failures, scenarios: Object.fromEntries(Object.entries(report.scenarios).map(([k, v]) => [k, v.inks ? { inks: v.inks } : v.ms ? { ms: v.ms } : "ok"])) }, null, 1));
c.close();
process.exit(report.failures.length ? 1 : 0);
