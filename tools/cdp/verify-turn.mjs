// 无头验证（V-1 翻页动画：View Transitions 快照双叶）
// 前置：① node tools/cdp/make-synth-epub.mjs（生成 temp/synth-turn.epub，合成测试书）
//       ② Vite dev server 在 14200（npx vite）
//       ③ 无头 Chrome 在 9333（chrome --headless=new --remote-debugging-port=9333 --user-data-dir=<F 盘临时目录>）
// 用法：node tools/cdp/verify-turn.mjs [场景片段，逗号分隔：sheet/cross/rapid/input/end/edge/life/fold/loc/reduced/spread]
// 手法：合成书 + Tauri IPC 假后端 → 应用内真实翻页 → **暂停伪元素动画并定位到指定进度后截图**（确定性逐帧）→ 拼成对照表；
//       每帧做像素统计（偏离中位亮度的像素占比）判空白；跨章更新期间连拍；连按 / 输入 / 书末 / reduced-motion / 双页各一组断言。
//       edge = V-13 首/末页轻提示（EPUB 分页与滚动、漫画、PDF：合成图片与最小 PDF 在页面里现造）；
//       life = 关书收尾（主题样式表不重复、blob 释放、坏 .opt 回落原书、滚动模式章首翻屏）；
//       fold = 折页转场的覆盖层底色（夜间主题）；loc = 长章章首 / 章末 relocated 耗时。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { connect, sleep } from "./cdp-lib.mjs";
import { MOCK, ipcShimSource } from "./ipc-shim.mjs";

const only = (process.argv.find((a) => a.startsWith("only="))?.slice(5) ?? "").split(",").filter(Boolean);
const OUT = "F:/bookreading-project/temp/turn-shots";
mkdirSync(OUT, { recursive: true });
const PAGES = 5; // edge 场景的合成视觉书页数
const T = [0.06, 0.2, 0.35, 0.5, 0.65, 0.8, 0.94];
const PAD = 24;

const c = await connect(9333, /.*/);
await c.send("Page.enable");
await c.send("Runtime.enable");
const ev = (s) => c.evaluate(s);
const J = (s) => c.evaluate(s).then(JSON.parse);
const pageSource = readFileSync(new URL("./verify-turn.page.js", import.meta.url), "utf8");
const b64Cache = new Map();
const epubB64Of = (path) => {
  if (!b64Cache.has(path)) b64Cache.set(path, readFileSync(path).toString("base64"));
  return b64Cache.get(path);
};
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

/** 打开合成书到阅读页（每次重设假设置：效果 / 主题 / 速度 / 起始位置）。visual = 视觉书（漫画 / PDF，数据在页面里现造） */
async function open({ effect, theme = "ink", turnSpeedMs = "260", viewport = [1350, 801], state = null, epub = "temp/synth-turn.epub", readingMode = "paginated", visual = null, corruptOpt = false, slowMs = 0, noWait = false }) {
  const epubB64 = epubB64Of(epub);
  if (scriptId) await c.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
  const mock = JSON.parse(JSON.stringify(MOCK));
  Object.assign(mock.settings, { pageAnimation: effect, theme, turnSpeedMs, layoutMode: "auto", fontSizePercent: "120", readingMode });
  const id = visual ? `synth-${visual.kind}` : "synth-turn";
  if (visual) {
    const key = visual.kind === "images" ? "image_reader_settings" : "pdf_reader_settings";
    mock.settings[key] = JSON.stringify({
      ...JSON.parse(mock.settings[key]),
      mode: visual.mode,
      layout: "single",
      ...(visual.pageAnimation ? { pageAnimation: visual.pageAnimation } : {}),
    });
  }
  mock.books = [
    visual
      ? { ...BOOK, id, format: visual.kind, library_path: visual.kind === "images" ? `library/images/${id}` : `library/pdf/${id}.pdf`, page_count: PAGES, file_size: 0 }
      : { ...BOOK, file_size: readFileSync(epub).length },
  ];
  const source =
    ipcShimSource(mock) +
    "\n(() => {\n" +
    "  const M = window.__MOCK__;\n" +
    "  const I = window.__TAURI_INTERNALS__;\n" +
    "  const orig = I.invoke;\n" +
    `  const epub = Uint8Array.from(atob(${JSON.stringify(epubB64)}), (ch) => ch.charCodeAt(0));\n` +
    `  M.highlights = ${JSON.stringify(HIGHLIGHTS)};\n` +
    `  M.state = ${state ? JSON.stringify(state) : "null"};\n` +
    "  M.logs = [];\n" +
    "  I.invoke = async (cmd, args = {}) => {\n" +
    "    const a = args;\n" +
    "    if (cmd === 'append_frontend_log') M.logs.push(String(a.line ?? a.message ?? JSON.stringify(args)));\n" +
    "    switch (cmd) {\n" +
    `      case "get_book": return a.bookId === "${id}" ? { ...M.data.books[0] } : null;\n` +
    // corruptOpt：假装库里有一个被截断的 .opt.epub（R1 取证）
    `      case "read_library_file":${slowMs ? ` await new Promise((r) => setTimeout(r, ${slowMs}));` : ""}${corruptOpt ? ' if (String(a.rel).endsWith(".opt.epub")) return epub.subarray(0, Math.floor(epub.length * 0.5));' : ""} return ${visual?.kind === "pdf" ? `window.__SYN.pdf(${PAGES})` : "epub"};\n` +
    `      case "list_image_pages": return Array.from({ length: ${PAGES} }, (_, i) => String(i + 1).padStart(3, "0") + ".png");\n` +
    `      case "list_image_page_meta": return Array.from({ length: ${PAGES} }, (_, i) => (i % 2 ? { width: 800, height: 450 } : { width: 400, height: 600 }));\n` +
    '      case "read_image_page": return window.__SYN.png(a.index);\n' +
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
    "  // 记录 WAAPI 动画（暂停 / 定位进度做确定性取证）：翻页的伪元素动画进 __anims（既有场景只看这一份），\n" +
    "  // V-13 提示胶囊的淡入淡出进 __hintAnims——书首 / 书末再翻会弹提示，混在一起会被旧断言当成「播了动画」\n" +
    "  window.__anims = [];\n" +
    "  window.__hintAnims = [];\n" +
    "  const animate = Element.prototype.animate;\n" +
    "  Element.prototype.animate = function (kf, opts) {\n" +
    "    const a = animate.call(this, kf, opts);\n" +
    "    if (opts && opts.pseudoElement) window.__anims.push({ a, pseudo: opts.pseudoElement, duration: opts.duration });\n" +
    "    else if (opts && this.classList.contains('wr-toast--center')) { window.__hintAnims.push({ a, duration: opts.duration }); (window.__hintLog ??= []).push({ t: Math.round(performance.now()), from: kf[0].opacity, to: kf[1].opacity }); }\n" +
    "    return a;\n" +
    "  };\n" +
    "  // E1 取证：blob 地址台账——新建的入账、revoke 的销账（同一地址可能被 revoke 两次，计数会算错）\n" +
    "  window.__blobs = { created: 0, live: new Set() };\n" +
    "  const createObjectURL = URL.createObjectURL.bind(URL);\n" +
    "  const revokeObjectURL = URL.revokeObjectURL.bind(URL);\n" +
    "  URL.createObjectURL = (o) => { const u = createObjectURL(o); window.__blobs.created += 1; window.__blobs.live.add(u); return u; };\n" +
    "  URL.revokeObjectURL = (u) => { window.__blobs.live.delete(u); return revokeObjectURL(u); };\n" +
    "})();\n" +
    pageSource;
  const r = await c.send("Page.addScriptToEvaluateOnNewDocument", { source });
  scriptId = r.identifier;
  c.logs.length = 0;
  await c.viewport(viewport[0], viewport[1]);
  const ready = visual
    ? `!!document.querySelector(".wr-image-stage ${visual.kind === "images" ? "img" : "canvas"}")`
    : `!!(document.querySelector(".wr-reader-leaf iframe") && document.querySelector(".wr-reader-leaf .epub-view"))`;
  // 同一本书重开时地址不变：以 timeOrigin 换代为准，免得在还没被替换的旧文档上判成就绪
  const origin = await ev(`performance.timeOrigin`).catch(() => 0);
  await c.send("Page.navigate", { url: `http://localhost:14200/read/${id}` });
  if (noWait) return; // load 场景：加载态就要开始拍
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`performance.timeOrigin !== ${origin} && ${ready}`).catch(() => false);
    if (ok) break;
    await sleep(250);
  }
  await sleep(1800); // 首章排版 / 主题注入 / 高亮附加
}

const state = () => ev(`JSON.stringify(window.__VT.state())`).then(JSON.parse);
const key = (dir) => ev(`window.__VT.key(${JSON.stringify(typeof dir === "string" ? dir : dir > 0 ? "ArrowRight" : "ArrowLeft")}); 1`);
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
/** 同一位置：章序 + 横向 / 纵向滚动位置（竖排章走 scrollTop） */
const samePos = (a, b) => a.spine === b.spine && a.scrollLeft === b.scrollLeft && a.scrollTop === b.scrollTop;

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
  await ev(`window.__VT.waitIdle(8000)`);
  await sleep(300);
  const after = await state();
  // 动画中段帧：连拍耗时超过动画本身，另翻一次——动画一出现就暂停定位（确定性取证）
  const frames = [];
  await simpleTurn(-dir);
  await sleep(300);
  await ev(`window.__anims.length = 0`);
  await key(dir);
  if (await ev(`window.__VT.waitAnims(4000)`)) {
    for (const t of [0.3, 0.65]) {
      await ev(`window.__VT.seek(${t})`);
      const ink = await shot(`${OUT}/${name}-t${Math.round(t * 100)}.png`);
      frames.push([`${name}-t${Math.round(t * 100)}`, `${name} t=${t} ink=${(ink.ink * 100).toFixed(1)}%`]);
    }
    await ev(`window.__VT.cancel()`);
    await ev(`window.__VT.waitIdle(8000)`);
    await sleep(300);
    want(name, frames.length === 2 && frames.every(([, label]) => parseFloat(label.split("ink=")[1]) > 0.8), `动画中段出现空白帧：${frames.map((f) => f[1]).join(" / ")}`);
  } else if (effect !== "none") {
    fail(name, "跨章翻页没有产生动画");
  }
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
  want(name, !samePos(s, s2), "连按之后翻不动了");
  want(name, samePos(s, s3), "连按之后前后翻不对账");
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
  await sleep(80 * 40 + 100); // 等按键全部发完
  await ev(`window.__VT.waitIdle(20000)`);
  await sleep(600);
  const s0 = await state();
  await ev(`window.__anims.length = 0`);
  await simpleTurn(1);
  await sleep(300);
  const s1 = await state();
  const anims = await ev(`window.__anims.length`);
  want(name, s0.spine === 8 && s0.vertical, `没有走到末章（竖排）：${JSON.stringify(s0)}`);
  want(name, samePos(s0, s1), `书末再翻却变了：${JSON.stringify({ s0, s1 })}`);
  want(name, anims === 0, `书末再翻却播了动画（页面没变不该播）`);
  want(name, s1.bands === 0 && s1.turning === null, `有残留：${JSON.stringify(s1)}`);
  // 末章是竖排（纵向分页）：章内翻页只翻不播
  await ev(`window.__anims.length = 0`);
  await simpleTurn(-1);
  await sleep(300);
  const v0 = await state();
  await ev(`window.__anims.length = 0`);
  await simpleTurn(1);
  await sleep(300);
  const v1 = await state();
  want(name, v0.vertical && v0.spine === 8 && v0.scrollTop > 0, `没有落进竖排章的章中：${JSON.stringify(v0)}`);
  want(name, !samePos(v0, v1) && v1.scrollTop > v0.scrollTop && (await ev(`window.__anims.length`)) === 0, `竖排章内翻页不该播横向动画：${JSON.stringify({ v0, v1 })}`);
  const errs = errors();
  want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
  report.scenarios[name] = { s0, s1, anims, v0, v1, errors: errs };
  // 书首后退同理
  await open({ effect: "paper", theme: "ink" });
  const b0 = await state();
  await ev(`window.__anims.length = 0`);
  await simpleTurn(-1);
  await sleep(300);
  const b1 = await state();
  want(name, b0.spine === 0 && samePos(b0, b1), `书首后退却变了：${JSON.stringify({ b0, b1 })}`);
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

// ───── figures：插图页——新页快照里的图片必须是已解码的（不能是空白 / 占位）───
async function doFigures() {
  const name = "figures";
  await open({ effect: "cover", theme: "ink", viewport: [1100, 760] });
  for (let i = 0; i < 40; i++) {
    if ((await state()).spine === 2) break;
    await simpleTurn(1);
  }
  await simpleTurn(-1); // 回到第 2 章末页，逐个版面翻进第 3 章
  const files = [];
  for (let k = 0; k < 4; k++) {
    for (const t of [0.5, 0.97]) {
      const ink = await seekShot(`${OUT}/${name}-s${k}-t${Math.round(t * 100)}.png`, 1, t);
      if (!ink) break;
      files.push([`${name}-s${k}-t${Math.round(t * 100)}`, `step ${k} t=${t}`]);
    }
  }
  const errs = errors();
  want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
  await buildSheet(name, files);
  report.scenarios[name] = { errors: errs };
}

// ───── chrome：顶 / 底栏（毛玻璃）可见时翻页——栏压着纸面上缘 ─────
async function doChrome() {
  const name = "chrome-bars";
  await open({ effect: "slide", theme: "ink", viewport: [1100, 760], turnSpeedMs: "600" });
  await simpleTurn(1);
  const [x, y] = [540, 8]; // 顶部热区：唤出栏
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: y + 4 });
  await sleep(500);
  await c.screenshot(`${OUT}/${name}-idle.png`);
  await ev(`window.__anims.length = 0; 1`);
  await key(1);
  await ev(`window.__VT.waitAnims(4000)`);
  await ev(`window.__VT.seek(0.5)`);
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); // 翻页会收栏：把指针留在热区再看一帧
  await sleep(60);
  await c.screenshot(`${OUT}/${name}-mid.png`);
  await ev(`window.__VT.cancel()`);
  await ev(`window.__VT.waitIdle(8000)`);
  const errs = errors();
  want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
  report.scenarios[name] = { errors: errs };
}

// ───── legacy：不支持 View Transitions 的老 WebView2——回落 v3.1.8「先画完、再微幅滑入」─────
async function doLegacy() {
  const name = "legacy-fallback";
  await open({ effect: "cover", theme: "ink", viewport: [1100, 760] });
  await ev(`delete Document.prototype.startViewTransition; 1`);
  want(name, !(await ev(`typeof Document.prototype.startViewTransition === "function"`)), "没能模拟出老引擎");
  const s0 = await state();
  await ev(`window.__anims.length = 0`);
  await simpleTurn(1);
  // v3.1.8 路径的样式落在正文容器与 viewer 上：翻页后 120ms 应正处于微幅动画中，动画结束后应全部清掉
  const probe = `(() => { const pick = (el) => ({ transition: el.style.transition, transform: el.style.transform, opacity: el.style.opacity, clipPath: el.style.clipPath }); return JSON.stringify({ box: pick(document.querySelector(".wr-reader-leaf > div")), viewer: pick(document.querySelector(".wr-reader-viewer")) }); })()`;
  const mid = await J(`JSON.stringify({ css: JSON.parse(${probe}), anims: window.__anims.length, turning: document.documentElement.dataset.wrTurn ?? null })`);
  await sleep(700);
  const s1 = await state();
  const after = await J(probe);
  // 第 2 个版面起才有页码徽标
  await simpleTurn(-1);
  await simpleTurn(1);
  const s2 = await state();
  await sleep(700);
  want(name, s1.spine === s0.spine && s1.scrollLeft === s0.scrollLeft + s1.pageWidth && s2.badges.length >= 1, `老引擎下翻页不对：${JSON.stringify({ s0, s1, s2 })}`);
  want(name, mid.turning === null && mid.anims === 0, `老引擎下不该走快照翻页：${JSON.stringify(mid)}`);
  const playing = (c) => c.viewer.transition !== "" || c.viewer.opacity !== "" || c.box.transition !== "none" || c.box.transform !== "";
  want(name, playing(mid.css), `老引擎下没有播微幅动画：${JSON.stringify(mid)}`);
  want(name, !playing(after) && after.viewer.opacity === "" && after.box.opacity === "" && after.box.clipPath === "", `微幅动画的样式没清干净：${JSON.stringify({ mid, after })}`);
  const errs = errors();
  want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
  report.scenarios[name] = { mid, after, errors: errs };
}

// ───── long：长书（120 章短章）连翻 100 次，每一步都跨章；按下后立刻拍一帧，任何一帧都不能是空白 ─────
async function doLong() {
  for (const effect of ["paper", "none"]) {
    const name = `long-${effect}`;
    await open({ effect, theme: "ink", viewport: [1100, 760], epub: "temp/synth-long.epub" });
    await c.send("Emulation.setCPUThrottlingRate", { rate: 3 });
    const inks = [];
    const blank = [];
    const phases = { update: 0, anim: 0, idle: 0 };
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) {
      await key(1);
      const s = await state();
      const anims = await ev(`window.__anims.length`);
      // 每一帧先落盘再统计：空白帧原样留证（补拍的那张往往已经是完整的新章，看不出白屏）
      const f = `${OUT}/long-cur-${effect}.png`;
      const ink = await shot(f);
      inks.push(+(ink.ink * 100).toFixed(2));
      if (ink.ink <= 0.008) {
        const keep = `${OUT}/blank-${effect}-${i}.png`;
        renameSync(f, keep);
        blank.push({ i, f: keep, turning: s.turning, anims, spine: s.spine, scrollLeft: s.scrollLeft, pageWidth: s.pageWidth });
      }
      phases[s.turning === null ? "idle" : anims ? "anim" : "update"] += 1;
      await ev(`window.__VT.waitIdle(8000)`);
    }
    const ms = Date.now() - t0;
    await c.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const end = await state();
    want(name, end.spine === 100, `100 次连翻后应到第 101 章（每章一个版面）：${JSON.stringify(end)}`);
    want(name, Math.min(...inks) > 0.8, `出现空白帧：${inks.filter((v) => v <= 0.8).length} 帧，最小 ${Math.min(...inks)}%`);
    want(name, end.bands === 0 && end.turning === null && end.iframes === 1, `有残留：${JSON.stringify(end)}`);
    const errs = errors();
    want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
    report.scenarios[name] = { ms, phases, minInk: Math.min(...inks), avgInk: +(inks.reduce((a, b) => a + b, 0) / inks.length).toFixed(2), spine: end.spine, blank, errors: errs };
  }
}

// ───── edge：V-13 到头再翻的轻提示（EPUB 分页 / 滚动、漫画、PDF）─────
const hintNow = () => ev(`JSON.stringify(window.__VT.hint())`).then(JSON.parse);
/** 到头再翻一次 → 等翻页收尾与淡入动画 → 把淡入定位到进度 t → 截图（返回提示状态） */
async function edgePress(file, dir, t = 1) {
  await ev(`window.__hintAnims.length = 0`);
  await key(dir);
  await ev(`window.__VT.waitIdle(8000)`);
  await ev(`window.__VT.waitAnims(300, "hint")`); // 提示已在显示时再触发没有新动画，等一小会儿即可
  const held = await ev(`window.__hintAnims.length`); // 此刻在账上的才归这次截图管
  await ev(`window.__VT.seek(${t})`);
  const h = await hintNow();
  if (file) {
    // 视觉书没有 .wr-reader-paper：整窗截图
    const rect = await ev(`JSON.stringify(window.__VT.paperRect(${PAD}))`).then(JSON.parse);
    await c.screenshot(file, rect ? { ...rect, scale: 1 } : undefined);
  }
  await ev(`window.__VT.cancel(${held})`);
  return h;
}
/** 连按 n 次方向键（每次间隔 250ms，等页面换完） */
async function press(dir, n) {
  for (let i = 0; i < n; i++) {
    await key(dir);
    await sleep(250);
  }
}

async function doEdge() {
  const name = "edge";
  const files = [];
  const expectHint = async (label, dir, text, file, t = 1) => {
    const h = await edgePress(file, dir, t);
    want(name, h && h.text === text, `${label}：提示不对 ${JSON.stringify(h)}`);
    if (!h) return h;
    want(name, t < 1 ? Number(h.opacity) < 1 : h.opacity === "1", `${label}：进度 ${t} 时透明度应为${t < 1 ? "小于 1" : " 1"}，实际 ${h.opacity}`);
    want(name, Math.abs(h.centered.dx) <= 1 && Math.abs(h.centered.dy) <= 1, `${label}：提示不在屏幕正中 ${JSON.stringify(h.centered)}`);
    if (file) files.push([file.replace(`${OUT}/`, "").replace(".png", ""), `${label} ${h.centered.w}×${h.centered.h}`]);
    return h;
  };
  const webtoonToBottom = async () => {
    for (let i = 0; i < 6; i++) {
      // 条漫图片懒加载会改变总高度：反复贴到底，直到稳定
      await ev(`(() => { const el = document.querySelector(".wr-image-webtoon"); if (!el) return; el.scrollTop = el.scrollHeight; })()`);
      await sleep(250);
    }
  };

  // ① EPUB 分页：正常翻页不弹；书末再翻 → 淡入 → 再触发不叠弹 → 1s 后淡出
  await open({ effect: "paper", theme: "ink" });
  await simpleTurn(1);
  const quiet = await hintNow();
  want(name, !quiet || quiet.opacity === "0", `正常翻页却弹了提示：${JSON.stringify(quiet)}`);
  await ev(`(() => { for (let i = 0; i < 80; i++) setTimeout(() => window.__VT.key("ArrowRight"), i * 40); return 1; })()`);
  await sleep(80 * 40 + 100);
  await ev(`window.__VT.waitIdle(20000)`);
  await sleep(600);
  want(name, (await state()).spine === 8, `没有走到末章：${JSON.stringify(await state())}`);
  // 连按收尾时提示可能还在显示（显示中再触发不重播淡入）：等它淡完，才拍得到下一次的淡入半程
  for (let i = 0; i < 60; i++) {
    const h = await hintNow();
    if (!h || h.opacity === "0") break;
    await sleep(100);
  }
  await expectHint("EPUB 分页·书末（淡入半程）", 1, "已是最后一页", `${OUT}/edge-epub-end-half.png`, 0.5);
  await expectHint("EPUB 分页·书末·再触发", 1, "已是最后一页", `${OUT}/edge-epub-end.png`);
  want(name, (await ev(`document.querySelectorAll(".wr-toast--center").length`)) === 1, "连按叠出了多个提示");
  // 淡出轨迹：每 200ms 取一次透明度（留档，排查「没淡出」用）
  const keyAt = await ev(`window.__VT.lastKeyAt`);
  const fade = [];
  for (let i = 0; i < 8; i++) {
    await sleep(200);
    fade.push({ dt: (await ev(`Math.round(performance.now())`)) - keyAt, opacity: (await hintNow())?.opacity ?? "none" });
  }
  const hintLog = (await J(`JSON.stringify(window.__hintLog ?? [])`)).filter((e) => e.t >= keyAt - 50);
  const gone = await hintNow();
  want(name, gone && gone.opacity === "0", `1s 后没有淡出：${JSON.stringify(gone)}`);
  await open({ effect: "paper", theme: "dark" });
  await expectHint("EPUB 分页·书首（夜间）", -1, "已是第一页", `${OUT}/edge-epub-start-dark.png`);

  // ② EPUB 滚动模式：按章翻——方向键与 PageDown 到头都说「章」
  await open({ effect: "none", theme: "ink", readingMode: "scrolled" });
  for (let i = 0; i < 14 && (await state()).spine !== 8; i++) {
    await key(1);
    await sleep(450);
  }
  want(name, (await state()).spine === 8, `滚动模式没有走到末章：${JSON.stringify(await state())}`);
  await expectHint("EPUB 滚动·末章再翻", 1, "已是最后一章", `${OUT}/edge-scrolled-end.png`);
  await ev(`(() => { const sc = document.querySelector(".epub-container"); if (sc) sc.scrollTop = sc.scrollHeight; })()`);
  await sleep(400);
  await expectHint("EPUB 滚动·末章底 PageDown", "PageDown", "已是最后一章", `${OUT}/edge-scrolled-pagedown.png`);
  await open({ effect: "none", theme: "ink", readingMode: "scrolled" });
  await expectHint("EPUB 滚动·首章再翻", -1, "已是第一章", `${OUT}/edge-scrolled-start.png`);

  // ③ 漫画（假设置是 RTL：方向键右 = 往前翻）
  await open({ effect: "none", visual: { kind: "images", mode: "paged" } });
  await expectHint("漫画分页（RTL）·书首", 1, "已是第一页", `${OUT}/edge-img-paged-start.png`);
  await press(-1, 6);
  await expectHint("漫画分页（RTL）·书末", -1, "已是最后一页", `${OUT}/edge-img-paged-end.png`);
  await open({ effect: "none", visual: { kind: "images", mode: "webtoon" } });
  // RTL 条漫：方向键右 = 往回（书首），左 = 往后（书末）
  await expectHint("漫画条漫·书首", 1, "已是第一页", `${OUT}/edge-img-webtoon-start.png`);
  await webtoonToBottom();
  await expectHint("漫画条漫·书末", -1, "已是最后一页", `${OUT}/edge-img-webtoon-end.png`);

  // ④ PDF（假设置非 RTL）
  await open({ effect: "none", visual: { kind: "pdf", mode: "paged" } });
  await expectHint("PDF 分页·书首", -1, "已是第一页", `${OUT}/edge-pdf-paged-start.png`);
  await press(1, 6);
  await expectHint("PDF 分页·书末", 1, "已是最后一页", `${OUT}/edge-pdf-paged-end.png`);
  await open({ effect: "none", visual: { kind: "pdf", mode: "webtoon" } });
  await expectHint("PDF 连续滚动·书首", -1, "已是第一页", `${OUT}/edge-pdf-webtoon-start.png`);
  await webtoonToBottom();
  await expectHint("PDF 连续滚动·书末", 1, "已是最后一页", `${OUT}/edge-pdf-webtoon-end.png`);

  // ⑤ 系统「减少动态效果」：直接出现、不建动画、满 1s 直接移除
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await open({ effect: "paper", theme: "ink" });
  await ev(`window.__hintAnims.length = 0`);
  await key(-1);
  await ev(`window.__VT.waitIdle(8000)`);
  await sleep(150);
  const r0 = await hintNow();
  want(name, r0 && r0.text === "已是第一页" && r0.opacity === "1", `reduced-motion 下提示不对：${JSON.stringify(r0)}`);
  want(name, (await ev(`window.__hintAnims.length`)) === 0, "reduced-motion 下提示仍建了动画");
  await sleep(1100);
  want(name, (await hintNow()) === null, "reduced-motion 下提示满 1s 后应直接移除");
  await c.send("Emulation.setEmulatedMedia", { features: [] });

  const errs = errors();
  want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
  report.scenarios[name] = { files, fade, hintLog, errors: errs };
  await buildSheet("edge", files);
}

// ───── life：关书后的收尾——主题样式表不重复（E7）、blob 释放（E1）、坏 .opt 回落原书（R1）─────
/** 应用内导航（不整页重载）：pushState + popstate 让路由换页 */
const go = (path) => ev(`(() => { history.pushState({}, "", ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent("popstate")); return 1; })()`);
const blobs = () => J(`JSON.stringify({ created: window.__blobs.created, live: window.__blobs.live.size })`);
async function waitReader(want, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await ev(`!!document.querySelector(".wr-reader-root")`).catch(() => false)) === want) return true;
    await sleep(100);
  }
  return false;
}

async function doLife() {
  const name = "life";
  const rec = {};
  report.scenarios[name] = rec;
  // E7：首章 iframe 里当前主题的样式表规则数（上游 Themes.add 是追加：主题 hook、rendered、首显各注入一次 → 三份）
  await open({ effect: "none", theme: "ink" });
  rec.rulesAfterOpen = await ev(
    `(() => { const d = document.querySelector(".wr-reader-leaf iframe")?.contentDocument; const s = d && d.getElementById("epubjs-inserted-css-ink"); return s ? s.sheet.cssRules.length : -1; })()`,
  );
  want(name, rec.rulesAfterOpen > 0, `没找到主题样式表：${rec.rulesAfterOpen}`);
  // E7 续：来回切主题——新主题即时生效（body 类名换了、样式表在），切回来的主题规则数不涨。
  // 模块要拿应用自己加载的那一份（资源条目里的 URL 带 HMR 时间戳，直接 import 路径会是另一个实例）
  const switchTheme = (t) =>
    ev(
      `(async () => { const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/ui/theme.ts")); const m = await import(url ?? "/src/ui/theme.ts"); m.setTheme(${JSON.stringify(t)}); return url ?? "fallback"; })()`,
    );
  const themeState = (theme) =>
    J(
      `JSON.stringify((() => { const d = document.querySelector(".wr-reader-leaf iframe")?.contentDocument; const s = d && d.getElementById("epubjs-inserted-css-${theme}"); return { rules: s ? s.sheet.cssRules.length : -1, bodyClass: d?.body?.className ?? "" }; })())`,
    );
  await switchTheme("dark");
  await sleep(500);
  const d1 = await themeState("dark");
  await switchTheme("ink");
  await sleep(500);
  const i1 = await themeState("ink");
  await switchTheme("dark");
  await sleep(500);
  const d2 = await themeState("dark");
  rec.themeSwitch = { dark: d1, ink: i1, darkAgain: d2 };
  want(name, d1.bodyClass.split(/\s+/).includes("dark") && d1.rules === rec.rulesAfterOpen, `切到夜间主题没有即时生效：${JSON.stringify(d1)}`);
  want(name, i1.bodyClass.split(/\s+/).includes("ink") && i1.rules === rec.rulesAfterOpen, `切回纸墨主题没有即时生效：${JSON.stringify(i1)}`);
  want(name, d2.rules === d1.rules, `来回切主题后规则数在涨：${d1.rules} → ${d2.rules}`);
  await switchTheme("ink");

  // E1：开 → 关 → 开 → 关 → 开，每轮新建的 blob 数相同、关书后仍存活的 blob 数不增长
  const live = [];
  let createdSoFar = 0;
  for (let round = 0; round < 3; round++) {
    if (round > 0) {
      await go("/read/synth-turn");
      if (!(await waitReader(true))) return fail(name, "重开阅读页超时");
      await sleep(1800);
    }
    const opened = await blobs();
    await go("/");
    if (!(await waitReader(false))) return fail(name, "关书后阅读页没有卸载");
    await sleep(600);
    const closed = await blobs();
    live.push({ created: opened.created - createdSoFar, liveAfterClose: closed.live });
    createdSoFar = opened.created;
  }
  rec.blobs = live;
  want(name, live[0].created > 0, "没观察到 blob（计数桩失效）");
  want(name, live.every((x) => x.created === live[0].created), `每轮新建的 blob 数不一致：${JSON.stringify(live)}`);
  want(name, live.every((x) => x.liveAfterClose === live[0].liveAfterClose), `关书后仍存活的 blob 在增长：${JSON.stringify(live)}`);

  // R1：库里的 .opt.epub 是半截文件 → 回落原书照常渲染，并留一条日志
  await open({ effect: "none", theme: "ink", corruptOpt: true });
  const text = await ev(`(document.querySelector(".wr-reader-leaf iframe")?.contentDocument?.body?.innerText ?? "").length`);
  const logs = await J(`JSON.stringify(window.__MOCK__.logs)`);
  rec.optFallback = { textChars: text, logs };
  want(name, text > 50, `坏 .opt 下没有渲染出正文（${text} 字）`);
  want(name, logs.some((l) => l.includes(".opt.epub")), `日志里没有回落记录：${JSON.stringify(logs.slice(0, 5))}`);

  // E4（核实后未复现，留作回归哨兵）：滚动模式章首按 PageDown、跳章落到章顶后按 PageDown，
  // 位置都要照常上报（落库的 cfi / percent 变化）。调研担心 epub.js 的 ignore 标志残留会吞掉这一次 relocated——
  // 两条路径修复前后实测都照常上报
  await open({ effect: "none", theme: "ink", readingMode: "scrolled" });
  const where = () => J(`JSON.stringify(window.__MOCK__.state && { cfi: window.__MOCK__.state.cfi, percent: window.__MOCK__.state.percent })`);
  await sleep(2200); // 等 relocated 落库（1.5s 防抖）
  const s0 = await where();
  await key("PageDown");
  await sleep(2200);
  const s1 = await where();
  rec.scrollStep = { before: s0, after: s1 };
  want(name, s1 && (!s0 || s1.cfi !== s0.cfi || s1.percent !== s0.percent), `章首 PageDown 后位置没变（relocated 被吞）：${JSON.stringify({ s0, s1 })}`);
  const hop = [];
  for (let i = 0; i < 4; i++) {
    await key(1); // 滚动模式方向键 = 下一章
    await sleep(2200);
    const a0 = await where();
    await key("PageDown");
    await sleep(2200);
    const a1 = await where();
    hop.push({ after: a1, moved: !!a1 && (!a0 || a1.cfi !== a0.cfi || a1.percent !== a0.percent) });
  }
  rec.scrollStepAfterChapterJump = hop.map((h) => h.moved);
  want(name, hop.every((h) => h.moved), `跳章后的第一次翻屏有被吞的：${JSON.stringify(hop)}`);

  const errs = errors();
  want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
  rec.errors = errs;
}

// ───── fold：折页转场的覆盖层底色（E10）——横竖页交替的合成漫画，竖页翻向横页 ─────
// 折页是 rAF 按时间戳推进的（不是 WAAPI，没法暂停定位）：给 rAF 回调的时间戳乘 0.12，600ms 的折页放慢到 5s，
// 在固定的几个进度上截图，各主题 / 改动前后才是同一帧。
async function doFold() {
  const name = "fold";
  const files = [];
  const probes = [];
  for (const theme of ["ink", "dark", "ink-dark"]) {
    await open({ effect: "none", theme, turnSpeedMs: "600", visual: { kind: "images", mode: "paged", pageAnimation: "fold" } });
    await ev(
      "(() => { const raf = window.requestAnimationFrame.bind(window); const base = performance.now();" +
        "  window.requestAnimationFrame = (cb) => raf((now) => cb(base + (now - base) * 0.12));" +
        "  window.__VT.restoreRaf = () => { window.requestAnimationFrame = raf; }; return 1; })()",
    );
    await ev(`window.__VT.foldT0 = performance.now(); 1`);
    await key(-1); // 假设置是 RTL：方向键左 = 往后翻（竖页 → 横页）
    // 实测进度（按时间戳放慢 10 倍）：1.2s≈20°、1.6s≈45°、2.0s≈78°——越过 90° 后背面隐藏，只看得到新页
    let waited = 0;
    for (const at of [1200, 1620, 2000]) {
      await sleep(at - waited);
      waited = at;
      const probe = await J(
        `JSON.stringify((() => { const el = document.querySelector(".wr-fold-layer"); const m = el ? getComputedStyle(el).transform : ""; const c = m.startsWith("matrix3d(") ? m.slice(9).split(",")[0] : ""; return { sinceKey: Math.round(performance.now() - window.__VT.foldT0), layer: !!el, deg: c ? Math.round(Math.acos(Math.max(-1, Math.min(1, Number(c)))) * 180 / Math.PI) : null }; })())`,
      );
      const f = `fold-${theme}-${probe.deg ?? "x"}deg`;
      const shotRes = await c.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(`${OUT}/${f}.png`, Buffer.from(shotRes.data, "base64"));
      files.push([f, `${theme} ≈${probe.deg}°`]);
      // E10 断言（只在 ≈20° 那一帧做）：横过来的新页左端在 (330, 400) 一带——旧页的纸必须把它挡住。
      // 夜间两档修复前这里透出浅色新页（亮度 ≈228），修复后是深色纸面
      if (probe.deg >= 10 && probe.deg <= 35) {
        const px = JSON.parse(
          await ev(`(async () => JSON.stringify(await window.__VT.pixel("data:image/png;base64,${shotRes.data}", 330, 400)))()`),
        );
        probe.pixel = px;
        const lum = px ? 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2] : -1;
        probe.lum = Math.round(lum);
        want(name, px && (theme === "ink" ? lum > 200 : lum < 90), `${theme} ≈${probe.deg}°：新页从旧页四周透出来了，像素 ${JSON.stringify(px)}`);
      }
      probes.push(probe);
    }
    await ev(`window.__VT.restoreRaf()`);
    await sleep(900);
    want(name, !(await ev(`!!document.querySelector(".wr-fold-layer")`)), `${theme}：折页结束后覆盖层没有撤掉`);
  }
  const errs = errors();
  want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
  report.scenarios[name] = { files, probes, errors: errs };
  if (files.length) await buildSheet("fold", files);
}

// ───── loc：章内页码越靠后 relocated 越慢（E6）——量个数留档 ─────
// relocated 的页码定位（epub.js Mapping.findStart）是从 body 开头逐文本节点取矩形、走到当前页为止：
// 耗时 ∝ 章内文本节点数 × 页码 / 总页数。徽标不能当信号（它优先显示按字数切的全局「位置页」），
// 所以直接按同一算法在真实排版上走一遍：普通章节 vs 一章 3000 段的超长章。
async function doLoc() {
  const name = "loc";
  const median = async (limit, n = 5) => {
    const xs = [];
    for (let i = 0; i < n; i++) {
      const r = await J(`JSON.stringify(window.__VT.cfiWalk(${limit}))`);
      if (!r) return fail(name, "cfiWalk 没拿到 iframe 文档");
      xs.push(r);
    }
    xs.sort((a, b) => a.ms - b.ms);
    const mid = xs[Math.floor(xs.length / 2)];
    return { nodes: mid.nodes, ms: mid.ms, perNodeUs: mid.nodes ? +((mid.ms * 1000) / mid.nodes).toFixed(1) : 0 };
  };
  await open({ effect: "none", theme: "ink" });
  await sleep(800);
  const normal = await median(1e9);
  await open({ effect: "none", theme: "ink", epub: "temp/synth-chapter.epub" });
  await sleep(800);
  const pages = await ev(`(() => { const s = document.querySelector(".epub-container"); return s ? Math.ceil(s.scrollWidth / s.clientWidth) : 0; })()`);
  const longHead = await median(300);
  const longAll = await median(1e9, 3);
  const errs = errors();
  want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
  report.scenarios[name] = { normal, longChapter: { approxPages: pages, first300: longHead, whole: longAll }, errors: errs };
}

// ───── load：进书加载——加载层不占布局，内容到了与它交叉淡入 ─────
async function doLoad() {
  const name = "load";
  const files = [];
  const paper = () => J(`JSON.stringify((() => { const p = document.querySelector(".wr-reader-paper"); if (!p) return null; const b = p.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })())`);
  for (const theme of ["ink", "dark"]) {
    await open({ effect: "none", theme, slowMs: 1600, noWait: true });
    for (let i = 0; i < 150 && !(await ev(`!!document.querySelector(".wr-book-loading")`).catch(() => false)); i++) await sleep(100);
    await sleep(450); // 加载层自己的淡入走完
    const p0 = await paper();
    await c.screenshot(`${OUT}/load-${theme}-loading.png`);
    files.push([`load-${theme}-loading`, `${theme} 加载中`]);
    for (let i = 0; i < 120; i++) {
      if (await ev(`!!(document.querySelector(".wr-reader-leaf iframe") && document.querySelector(".wr-reader-leaf .epub-view"))`).catch(() => false)) break;
      await sleep(100);
    }
    // 交叉淡入的中段与终态
    await sleep(180);
    const p1 = await paper();
    const mid = await J(`JSON.stringify({ loader: !!document.querySelector(".wr-book-loading"), loaderOpacity: document.querySelector(".wr-book-loading") ? getComputedStyle(document.querySelector(".wr-book-loading")).opacity : null, enter: !!document.querySelector(".wr-reader-enter"), leafOpacity: getComputedStyle(document.querySelector(".wr-reader-leaf")).opacity })`);
    await c.screenshot(`${OUT}/load-${theme}-enter.png`);
    await sleep(900);
    const end = await J(`JSON.stringify({ loader: !!document.querySelector(".wr-book-loading"), enter: !!document.querySelector(".wr-reader-enter"), leafOpacity: getComputedStyle(document.querySelector(".wr-reader-leaf")).opacity })`);
    const p2 = await paper();
    await c.screenshot(`${OUT}/load-${theme}-done.png`);
    files.push([`load-${theme}-enter`, `${theme} 交叉淡入`], [`load-${theme}-done`, `${theme} 完成`]);
    want(name, !!p0 && JSON.stringify(p0) === JSON.stringify(p1) && JSON.stringify(p0) === JSON.stringify(p2), `${theme}：加载前后纸面尺寸变了：${JSON.stringify({ p0, p1, p2 })}`);
    want(name, mid.enter && Number(mid.leafOpacity) > 0, `${theme}：没有拍到正文入场：${JSON.stringify(mid)}`);
    want(name, !end.loader && !end.enter && end.leafOpacity === "1", `${theme}：收尾后还有残留：${JSON.stringify(end)}`);
    const errs = errors();
    want(name, errs.length === 0, `控制台报错：${errs.slice(0, 3).join(" | ")}`);
  }
  report.scenarios[name] = { files };
  await buildSheet("load", files);
}

const PLAN = {
  long: doLong,
  legacy: doLegacy,
  figures: doFigures,
  chrome: doChrome,
  edge: doEdge,
  life: doLife,
  load: doLoad,
  fold: doFold,
  loc: doLoc,
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

const order = ["sheet", "cross", "rapid", "input", "end", "edge", "life", "load", "fold", "loc", "reduced", "spread", "figures", "chrome", "legacy", "long"];
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
