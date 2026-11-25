// 无头浏览器验证：注入 Tauri IPC 假后端 → 连 Vite dev server → 应用内导航到设置页 → 多尺寸截图 + 布局断言
// 用法：node temp/verify-settings.mjs [only=sectionId] [sizes=720x480,1280x800]
import { mkdirSync, writeFileSync } from "node:fs";
import { connect, sleep } from "./cdp-lib.mjs";

const PORT = 9333;
const OUT = "F:/bookreading-project/temp/shots";
mkdirSync(OUT, { recursive: true });

const MOCK = {
  settings: {
    theme: "ink",
    fontSizePercent: "125",
    pageAnimation: "paper",
    turnSpeedMs: "260",
    layoutMode: "auto",
    lineHeight: "1.8",
    fontFamily: "songti",
    fontWeight: "400",
    letterSpacing: "0",
    paragraphSpacing: "0.2",
    textIndent: "0",
    pageMargin: "24",
    justify: "false",
    readingMode: "paginated",
    reader_bg: JSON.stringify({ type: "preset" }),
    reader_font: JSON.stringify({ type: "preset" }),
    ttsRate: "1.1",
    bg_veil: "88",
    import_mode: "copy",
    close_action: "tray",
    update_check: "on",
    "continue_card.enabled": "1",
    library_density: "large",
    trash_retention_days: "30",
    "wenku8.dest_shelf": "",
    "wenku8.sort": "updated",
    "wenku8.endpoint": "auto",
    "proxy.enabled": "1",
    "proxy.host": "127.0.0.1",
    "proxy.port": "7897",
    image_reader_settings: JSON.stringify({ fit: "height", layout: "double", rtl: true, mode: "paged", pageAnimation: "slide", webtoonWidth: 75, autoScrollSpeed: 60, doubleOffset: 1 }),
    pdf_reader_settings: JSON.stringify({ fit: "width", layout: "single", rtl: false, mode: "webtoon", pageAnimation: "none", webtoonWidth: 80, autoScrollSpeed: 90, doubleOffset: 0 }),
  },
  shelves: [
    { id: 1, name: "轻小说", parent_id: null, sort_order: 1, created_at: 0 },
    { id: 2, name: "漫画", parent_id: null, sort_order: 2, created_at: 0 },
    { id: 3, name: "日漫生肉（一个名字特别特别长的嵌套书架用于测换行）", parent_id: 2, sort_order: 1, created_at: 0 },
  ],
  stats: {
    library_root: "D:\\Some Rather Long Path\\BookLibrary\\一个中文目录\\books",
    db_path: "C:\\Users\\Someone\\AppData\\Roaming\\com.root.bookreading\\bookreading.db",
    library_bytes: 312_457_128_964,
    covers_bytes: 412_883_968,
    bg_bytes: 2_410_368,
    db_bytes: 18_874_368,
    logs_bytes: 1_204_608,
    trash_count: 3,
  },
};

const init = `
(() => {
  const MOCK = window.__MOCK__ = { data: ${JSON.stringify(MOCK)}, calls: [], unknown: new Set(), written: [] };
  let cbId = 0;
  const commands = {
    "plugin:app|version": () => "3.2.0-preview",
    "plugin:event|listen": () => ++cbId + 1000,
    "plugin:event|unlisten": () => null,
    "plugin:event|emit": () => null,
    "plugin:window|is_maximized": () => false,
    "plugin:window|is_fullscreen": () => false,
    "plugin:window|theme": () => "light",
    "plugin:window|scale_factor": () => 1,
    "plugin:window|inner_position": () => ({ x: 0, y: 0 }),
    "plugin:window|outer_position": () => ({ x: 0, y: 0 }),
    "plugin:window|inner_size": () => ({ width: 1280, height: 800 }),
    "plugin:window|outer_size": () => ({ width: 1280, height: 800 }),
    get_settings: () => ({ ...MOCK.data.settings }),
    set_setting: (a) => { MOCK.data.settings[a.key] = a.value; MOCK.written.push([a.key, a.value]); return null; },
    set_settings: (a) => { Object.assign(MOCK.data.settings, a.values); for (const k of Object.keys(a.values)) MOCK.written.push([k, a.values[k]]); return null; },
    list_shelves: () => MOCK.data.shelves.map((s) => ({ ...s })),
    list_books: () => [],
    list_tags: () => [],
    get_book_count: () => 0,
    storage_stats: () => ({ ...MOCK.data.stats }),
    "wenku8_status": () => ({ has_saved: true, username: "reader@example" }),
    wenku8_endpoint_status: () => ({ setting: "auto", session: "relay", relay_ok: true, direct_ok: false }),
    clear_cache: () => ({ freed_bytes: 0 }),
  };
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      MOCK.calls.push(cmd);
      const f = commands[cmd];
      if (!f) { MOCK.unknown.add(cmd); throw new Error("mock: unknown command " + cmd); }
      return f(args ?? {});
    },
    transformCallback: (cb, once) => { const id = ++cbId; window["_" + id] = cb; return id; },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    convertFileSrc: (path, protocol) => "http://" + (protocol || "asset") + ".localhost/" + encodeURIComponent(String(path)),
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
})();
`;

const [only, sizesArg] = process.argv.slice(2);
const SIZES = (sizesArg ?? "720x480,800x600,1024x700,1280x800,1920x1080,2560x1400").split(",").map((s) => {
  const [w, h] = s.split("x").map(Number);
  return { w, h, name: s };
});

const c = await connect(PORT, /.*/);
await c.send("Log.clear"); // Log.enable 会回放历史积压：清掉，只留本次导航之后的
await c.send("Page.addScriptToEvaluateOnNewDocument", { source: init });
c.logs.length = 0;
await c.send("Page.navigate", { url: "http://localhost:14200/" });
// 等壳挂载（应用内导航从书库页点侧栏「设置」进入，不整页重载）
for (let i = 0; i < 60; i++) {
  if (await c.evaluate(`!!document.querySelector('.wr-side-bottom')`)) break;
  await sleep(500);
}
await sleep(800);

const report = { sizes: {}, sections: {}, errors: [] };
const sc = (w) => (w >= 1900 ? 0.6 : 0); // 大窗口截图用 0.6 的像素比（布局不变，省体积）
const probe = `(() => {
  const root = document.querySelector('.wr-settings');
  const main = document.querySelector('.wr-main');
  const scroll = document.querySelector('.wr-main-scroll');
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };
  // 横向溢出检测：设置区内任何元素右缘超出主栏内缘
  let overflow = [];
  if (root) {
    const lim = main.getBoundingClientRect().right;
    for (const el of root.querySelectorAll('*')) {
      const b = el.getBoundingClientRect();
      if (b.width > 0 && b.right > lim + 0.5 && getComputedStyle(el).position !== 'fixed') overflow.push((el.className && String(el.className)) || el.tagName);
      if (overflow.length > 8) break;
    }
  }
  return JSON.stringify({
    url: location.pathname + location.search,
    vw: innerWidth, vh: innerHeight,
    docOverflowX: document.documentElement.scrollWidth > innerWidth,
    main: r(main), scroll: r(scroll), scrollW: scroll ? scroll.scrollWidth : null, scrollH: scroll ? scroll.scrollHeight : null,
    root: root ? r(root) : null,
    nav: r(document.querySelector('.wr-settings-nav')),
    body: r(document.querySelector('.wr-settings-body')),
    mode: root ? getComputedStyle(root).display + ' / ' + getComputedStyle(document.querySelector('.wr-settings')).gridTemplateColumns : null,
    tabs: [...document.querySelectorAll('.wr-settings-tab')].map((t) => ({ t: t.textContent.trim(), a: t.hasAttribute('data-active'), ...r(t) })),
    rows: document.querySelectorAll('.wr-settings-row').length,
    overflow,
  });
})()`;

// 进入设置页：点侧栏「设置」钮（应用内导航；改造前它会开旧弹窗，用于留 before 对照）
const entered = await c.click('.wr-side-bottom button[aria-label="设置"]');
await sleep(900);
const hasPage = await c.evaluate(`!!document.querySelector('.wr-settings')`);
report.entered = entered;
report.hasSettingsPage = hasPage;

if (hasPage) {
  const ids = only ? [only] : await c.evaluate(`[...document.querySelectorAll('.wr-settings-tab')].map((t) => t.dataset.section)`);
  for (const { w, h, name } of SIZES) {
    await c.viewport(w, h, sc(w));
    await sleep(250);
    const p = JSON.parse(await c.evaluate(probe));
    report.sizes[name] = p;
    await c.screenshot(`${OUT}/nav-${name}.png`);
  }
  for (const id of ids) {
    report.sections[id] = {};
    for (const { w, h, name } of SIZES) {
      await c.viewport(w, h, sc(w));
      await c.click(`.wr-settings-tab[data-section="${id}"]`);
      await sleep(350);
      const p = JSON.parse(await c.evaluate(probe));
      report.sections[id][name] = p;
      await c.screenshot(`${OUT}/sec-${id}-${name}.png`);
    }
  }
  // 探测未知 IPC 命令（mock 未覆盖=真实后端才有的调用）
  report.mock = await c.evaluate(`JSON.stringify({ unknown: [...window.__MOCK__.unknown], calls: [...new Set(window.__MOCK__.calls)] })`).then(JSON.parse);
} else {
  await c.viewport(1280, 800);
  await sleep(300);
  await c.screenshot(`${OUT}/before-1280x800.png`);
  await c.viewport(720, 480);
  await sleep(300);
  await c.screenshot(`${OUT}/before-720x480.png`);
}

report.errors = c.logs.filter((l) => /error|exception|warn/i.test(l.kind));
await c.viewportClear();
writeFileSync("F:/bookreading-project/temp/verify-settings.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  hasSettingsPage: hasPage,
  sizes: Object.fromEntries(Object.entries(report.sizes).map(([k, v]) => [k, { mode: v.mode, main: v.main && v.main.w, overflowX: v.docOverflowX, scrollW: v.scrollW, mainW: v.main && v.main.w, overflow: v.overflow, tabs: v.tabs.length }])),
  sections: Object.fromEntries(Object.entries(report.sections).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([s, p]) => [s, { rows: p.rows, h: p.scrollH, overflow: p.overflow }]))])),
  errors: report.errors.slice(0, 12),
  unknown: report.mock?.unknown,
}));
c.close();
process.exit(0);
