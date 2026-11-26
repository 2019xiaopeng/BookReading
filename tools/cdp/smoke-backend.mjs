// 真实后端冒烟（隔离 dev）：入库校验（R4）、坏 .opt 回落与自愈（R1）、详情页删除 = 软删（R3）、
// 同一本书三轮开关的插图与 blob（E1）。无头假后端验不到这些——它们走的是真 Rust 命令与真文件。
// 前置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" npm run dev:isolated
// 用法：node tools/cdp/smoke-backend.mjs <合成 EPUB 路径>      （只用合成书；别把真实书名 / 路径写进这里）
// 判读：末尾输出 JSON，checks 里 ok 全为 true；任一 false 进程退出码 1。
import { readFileSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, sleep } from "./cdp-lib.mjs";

const EPUB = process.argv[2];
if (!EPUB) {
  console.error("usage: node tools/cdp/smoke-backend.mjs <synthetic.epub>");
  process.exit(2);
}
const PLAIN = "F:/bookreading-project/temp/not-an-epub.epub";
const checks = {};
const check = (name, ok, detail) => {
  checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) };
  if (!ok) console.error(`FAIL ${name}: ${JSON.stringify(detail)}`);
};

const c = await connect(9223);
const J = async (s) => JSON.parse(await c.evaluate(s));
/** 返回 { ok, v } 或 { ok: false, e }：CDP 的 awaitPromise 只报 "Uncaught (in promise)"，错误文案要在页面内接住 */
const invokeRaw = (cmd, args = {}) =>
  c.evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String(e) }))`,
  );
const invoke = async (cmd, args) => {
  const r = await invokeRaw(cmd, args);
  if (!r.ok) throw new Error(r.e);
  return r.v;
};
const inReader = () => c.evaluate(`location.pathname.startsWith("/read/")`);
async function waitFor(fn, ms = 30000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn().catch(() => false)) return true;
    await sleep(step);
  }
  return false;
}
const go = (path) => c.evaluate(`(() => { history.pushState({}, "", ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent("popstate")); return 1; })()`);
/** 点侧栏「刷新当前视图」让书库页认领直接经 invoke 导入的书 */
const refresh = () =>
  c.evaluate(`(() => { document.querySelector('button[aria-label="刷新当前视图"]')?.click(); return 1; })()`).then(() =>
    waitFor(() => c.evaluate(`!!document.querySelector('.wr-book-card[data-book-id="${book.id}"]')`), 15000),
  );

const backToLibrary = async () => {
  if (await inReader()) await c.evaluate(`history.back()`);
  await waitFor(async () => !(await inReader()), 15000);
  await sleep(700);
};

for (let i = 0; i < 120; i++) {
  if (await c.evaluate(`!!document.querySelector('.wr-side-bottom')`).catch(() => false)) break;
  await sleep(500);
}
await sleep(1000);

// ── R4：改名成 .epub 的普通文件必须被拒，且不留库 ──
writeFileSync(PLAIN, "just some text, not a zip\n");
const plainImport = await invokeRaw("import_book", { req: { source_path: PLAIN, mode: "copy" } });
const rejected = plainImport.ok ? null : plainImport.e;
const leaked = (await invoke("list_books")).some((b) => b.library_path?.endsWith(".epub") && b.file_size === 27);
check("import-rejects-non-zip", /EPUB|zip/i.test(rejected ?? "") && !leaked, { rejected, leaked });
unlinkSync(PLAIN);

// ── 导入合成书 ──
const before = new Set((await invoke("list_books")).map((b) => b.id));
const book = await invoke("import_book", { req: { source_path: EPUB, mode: "copy" } });
check("import-valid-book", typeof book?.id === "string" && !before.has(book.id), { id: book?.id, format: book?.format });
const stats = await invoke("storage_stats");
const optPath = `${stats.library_root}\\books\\${book.id}.opt.epub`;
const bookPath = `${stats.library_root}\\books\\${book.id}.epub`;
const optSize = () => { try { return statSync(optPath).size; } catch { return -1; } };
check("opt-generated", optSize() > 0, { optSize: optSize(), bookSize: statSync(bookPath).size });
await refresh();

/** 打开合成书；带插图的是第 3 章（spine 序号 2）——翻过去再量插图 */
const openBook = async () => {
  await go(`/read/${book.id}`);
  await waitFor(async () => await inReader() && await c.evaluate(`!!document.querySelector(".wr-reader-leaf iframe")`), 60000);
  await sleep(2500);
  for (let i = 0; i < 40; i++) {
    if ((await c.evaluate(`document.querySelector(".wr-reader-leaf .epub-view")?.getAttribute("ref")`)) === "2") break;
    await c.evaluate(`(() => { for (const type of ["keydown", "keyup"]) window.dispatchEvent(new KeyboardEvent(type, { key: "ArrowRight", bubbles: true, cancelable: true })); return 1; })()`);
    await sleep(350);
  }
  await sleep(2500);
  return J(`JSON.stringify({
    textChars: (document.querySelector(".wr-reader-leaf iframe")?.contentDocument?.body?.innerText ?? "").length,
    error: document.querySelector(".wr-reader-root [role=alert]")?.textContent?.slice(0, 80) ?? null,
  })`);
};

// ── R1：把 .opt 截成半截 → 仍能打开（回落原书）；跑一遍启动补生成 → .opt 自愈 ──
const full = optSize();
truncateSync(optPath, Math.floor(full / 2));
const withBrokenOpt = await openBook();
await backToLibrary();
await invoke("optimize_epub_images");
await sleep(1500);
await waitFor(() => Promise.resolve(optSize() === full), 20000, 500);
check("broken-opt-falls-back", withBrokenOpt.textChars > 50 && !withBrokenOpt.error, withBrokenOpt);
check("broken-opt-self-heals", optSize() === full, { before: full, after: optSize() });

// ── E1：同一本书三轮开关——插图是好的 blob、每轮新建数相近、关书即释放 ──
await c.evaluate(`(() => {
  if (window.__probeOn) return;
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  window.__blobs = { created: 0, live: new Set() };
  URL.createObjectURL = (o) => { const u = create(o); window.__blobs.created += 1; window.__blobs.live.add(u); return u; };
  URL.revokeObjectURL = (u) => { window.__blobs.live.delete(u); return revoke(u); };
  window.__probeOn = true;
})()`);
const runs = [];
for (const run of [1, 2, 3]) {
  await backToLibrary();
  await c.evaluate(`(() => { window.__blobs.created = 0; window.__blobs.live.clear(); })()`);
  await openBook();
  const s = await J(`JSON.stringify((() => {
    const d = document.querySelector(".wr-reader-leaf iframe")?.contentDocument;
    const imgs = [...(d?.querySelectorAll("img") ?? [])].map((i) => (i.currentSrc || i.src || "").slice(0, 4) + (i.complete ? (i.naturalWidth > 0 ? ":ok" : ":BROKEN") : ":pending"));
    return { created: window.__blobs.created, live: window.__blobs.live.size, imgs };
  })())`);
  runs.push({ run, ...s });
  await backToLibrary();
  await sleep(800);
  runs[runs.length - 1].liveAfterClose = await c.evaluate(`window.__blobs.live.size`);
}
const imgSig = (r) => r.imgs.join(",");
check("reopen-images-intact", runs.every((r) => r.imgs.length > 0 && r.imgs.every((k) => k === "blob:ok")) && new Set(runs.map(imgSig)).size === 1, { runs });
check("reopen-blobs-released", runs.every((r) => r.liveAfterClose === 0) && new Set(runs.map((r) => r.created)).size === 1, { runs });

// ── R3：详情页「移入回收站」必须是软删——文件还在、进了回收站 ──
await c.evaluate(`(() => { const card = document.querySelector('.wr-book-card[data-book-id="${book.id}"]'); card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 300 })); })()`);
await sleep(300);
await c.evaluate(`(() => { const b = [...document.querySelectorAll('.wr-menu-item')].find((x) => x.textContent.trim() === "详情"); if (b) b.click(); return !!b; })()`);
await sleep(600);
await c.evaluate(`(() => { const b = [...document.querySelectorAll("button.wr-btn-danger")].find((x) => x.textContent.trim() === "删除"); if (b) b.click(); return !!b; })()`);
await sleep(500);
const confirmText = await c.evaluate(`document.querySelector(".wr-prompt-body")?.textContent ?? null`);
await c.evaluate(`(() => { const b = [...document.querySelectorAll(".wr-prompt-actions button")].find((x) => x.textContent.trim() === "移入回收站"); if (b) b.click(); return !!b; })()`);
await waitFor(async () => !(await c.evaluate(`!!document.querySelector(".wr-prompt")`)), 8000);
await sleep(800);
const stillListed = (await invoke("list_books")).some((b) => b.id === book.id);
const inTrash = (await invoke("list_trash")).some((b) => b.id === book.id);
let fileExists = true;
try { statSync(bookPath); } catch { fileExists = false; }
check("details-delete-is-soft", !stillListed && inTrash && fileExists, { confirmText, stillListed, inTrash, fileExists });

console.log(JSON.stringify({ bookId: book.id, checks }, null, 1));
c.close();
process.exit(Object.values(checks).every((x) => x.ok) ? 0 : 1);
