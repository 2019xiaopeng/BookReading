// 无头浏览器验证（v3.2 设置浮窗 + 书库体检）：注入 Tauri IPC 假后端 → 连 Vite dev server → 应用内导航（点侧栏「设置」）
// → 逐分区、多尺寸截图 + 布局断言：零横向溢出、切分区零位移（浮窗/目录行/内容宽度坐标逐一比对）、底下书架页不切走。
// 用法：node tools/cdp/verify-settings.mjs [only=sectionId] [sizes=720x480,1350x801]
// 前置：Vite dev server 在 14200；无头 Chrome 在 9333（chrome --headless=new --remote-debugging-port=9333 --user-data-dir=<临时目录>）
import { mkdirSync, writeFileSync } from "node:fs";
import { connect, sleep } from "./cdp-lib.mjs";

const PORT = 9333;
const OUT = "F:/bookreading-project/temp/shots";
mkdirSync(OUT, { recursive: true });

import { MOCK, ipcShimSource } from "./ipc-shim.mjs";

const [only, sizesArg] = process.argv.slice(2);
const SIZES = (sizesArg ?? "720x480,800x600,1024x700,1350x801,1920x1080,2560x1400").split(",").map((s) => {
  const [w, h] = s.split("x").map(Number);
  return { w, h, name: s };
});
const sc = (w) => (w >= 1900 ? 0.6 : 0); // 大窗口截图用 0.6 的像素比（布局不变，省体积）

const settingsProbe = `(() => {
  const dlg = document.querySelector('.wr-settings-dialog');
  if (!dlg) return JSON.stringify({ missing: true });
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left * 10) / 10, Math.round(b.top * 10) / 10, Math.round(b.width * 10) / 10, Math.round(b.height * 10) / 10]; };
  const d = dlg.getBoundingClientRect();
  const overflow = [];
  for (const el of dlg.querySelectorAll('*')) {
    const b = el.getBoundingClientRect();
    if (b.width > 0 && (b.right > d.right - 1 || b.left < d.left + 1) && getComputedStyle(el).position !== 'fixed') { overflow.push((el.className && String(el.className)) || el.tagName); if (overflow.length > 8) break; }
  }
  const pane = document.querySelector('.wr-settings-pane');
  const body = document.querySelector('.wr-settings-body');
  const quick = document.querySelector('.wr-quick-row');
  return JSON.stringify({
    vw: innerWidth, vh: innerHeight,
    dlg: r(dlg),
    h1: dlg.querySelector('.wr-masthead-name')?.textContent ?? null,
    h1Left: dlg.querySelector('.wr-masthead-name')?.getBoundingClientRect().left ?? null,
    iconLeft: document.querySelector('.wr-settings-tab .wr-settings-tab-icon')?.getBoundingClientRect().left ?? null,
    tabs: [...document.querySelectorAll('.wr-settings-tab')].map((t) => ({ t: t.dataset.section, sel: t.getAttribute('aria-selected'), r: r(t) })),
    title: document.querySelector('.wr-settings-title')?.textContent ?? null,
    pane: r(pane), bodyW: body ? Math.round(body.getBoundingClientRect().width * 10) / 10 : null,
    paneScroll: pane ? { sw: pane.scrollWidth, cw: pane.clientWidth, sh: pane.scrollHeight, ch: pane.clientHeight, xOverflow: pane.scrollWidth > pane.clientWidth } : null,
    sidebarQuick: quick ? getComputedStyle(quick).visibility + '/' + getComputedStyle(quick).display + '/chips=' + quick.querySelectorAll('.wr-quick-chip').length : null,
    libraryStillThere: location.pathname === '/' && !!document.querySelector('.wr-main .wr-masthead-name'),
    overflow,
  });
})()`;

const healthProbe = `(() => {
  const dlg = document.querySelector('.wr-health-dialog');
  if (!dlg) return JSON.stringify({ missing: true });
  const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left * 10) / 10, Math.round(b.top * 10) / 10, Math.round(b.width), Math.round(b.height)]; };
  const d = dlg.getBoundingClientRect();
  const scroller = document.querySelector('.wr-health-scroll');
  const overflow = [];
  for (const el of dlg.querySelectorAll('*')) {
    const b = el.getBoundingClientRect();
    if (b.width > 0 && (b.right > d.right - 1 || b.left < d.left + 1)) { overflow.push((el.className && String(el.className)) || el.tagName); if (overflow.length > 8) break; }
  }
  const foot = document.querySelector('.wr-health-foot');
  return JSON.stringify({
    vw: innerWidth, vh: innerHeight, dlg: r(dlg),
    scroll: { sw: scroller.scrollWidth, cw: scroller.clientWidth, sh: scroller.scrollHeight, ch: scroller.clientHeight, xOverflow: scroller.scrollWidth > scroller.clientWidth },
    groups: document.querySelectorAll('.wr-health-group').length, copies: document.querySelectorAll('.wr-health-copy').length,
    rows: document.querySelectorAll('.wr-health-row').length, checkboxes: document.querySelectorAll('.wr-health-check:not([aria-hidden])').length,
    footInFrame: foot ? foot.getBoundingClientRect().bottom <= d.bottom - 1 && foot.getBoundingClientRect().top >= d.top : false,
    footText: foot ? foot.textContent : null,
    overflow,
  });
})()`;

const c = await connect(PORT, /.*/);
await c.send("Log.clear"); // Log.enable 会回放历史积压
await c.send("Page.addScriptToEvaluateOnNewDocument", { source: ipcShimSource(MOCK) });
c.logs.length = 0;
await c.send("Page.navigate", { url: "http://localhost:14200/" });
for (let i = 0; i < 60; i++) {
  if (await c.evaluate(`!!document.querySelector('.wr-side-bottom')`)) break;
  await sleep(500);
}
await sleep(800);

const report = { sizes: {}, sections: {}, health: {}, errors: [] };
report.entered = await c.click('.wr-side-bottom button[aria-label="设置"]');
await sleep(900);
const first = JSON.parse(await c.evaluate(settingsProbe));
report.hasDialog = !first.missing;
if (!report.hasDialog) {
  report.errors = c.logs.filter((l) => /error|exception/i.test(l.kind));
  writeFileSync("F:/bookreading-project/temp/verify-settings.json", JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ hasDialog: false, errors: report.errors.slice(0, 5) }));
  c.close();
  process.exit(0);
}

const ids = only ? [only] : await c.evaluate(`[...document.querySelectorAll('.wr-settings-tab')].map((t) => t.dataset.section)`);
const tabSig = (p) => JSON.stringify(p.tabs.map((t) => t.r)); // 八个目录行的坐标签名：切分区前后必须逐位相同

for (const { w, h, name } of SIZES) {
  await c.viewport(w, h, sc(w));
  await sleep(300);
  report.sections[name] = {};
  let ref = null;
  for (const id of ids) {
    await c.click(`.wr-settings-tab[data-section="${id}"]`);
    await sleep(id === "library" || id === "about" ? 700 : id === "cloud" || id === "network" ? 500 : 320);
    const p = JSON.parse(await c.evaluate(settingsProbe));
    report.sections[name][id] = p;
    if (ref === null) ref = { dlg: JSON.stringify(p.dlg), tabs: tabSig(p), bodyW: p.bodyW, h1Left: p.h1Left, iconLeft: p.iconLeft };
    p.stable = { dlg: JSON.stringify(p.dlg) === ref.dlg, tabs: tabSig(p) === ref.tabs, bodyW: p.bodyW === ref.bodyW };
    await c.screenshot(`${OUT}/dlg-${id}-${name}.png`);
  }
  const p0 = report.sections[name][ids[0]];
  report.sizes[name] = { vw: p0.vw, vh: p0.vh, dlg: p0.dlg, h1: p0.h1, h1Left: p0.h1Left, iconLeft: p0.iconLeft, sidebarQuick: p0.sidebarQuick, libraryStillThere: p0.libraryStillThere };
}

// 书库体检：设置 → 书库 → 「开始体检」
for (const { w, h, name } of SIZES) {
  await c.viewport(w, h, sc(w));
  await c.click('.wr-settings-tab[data-section="library"]');
  await sleep(500);
  const opened = await c.evaluate(`(() => { const b = [...document.querySelectorAll('.wr-settings-body button')].find((x) => x.textContent.trim() === '开始体检'); if (!b) return false; b.click(); return true; })()`);
  let hp = { missing: true };
  for (let i = 0; i < 20 && opened; i++) {
    await sleep(300);
    hp = JSON.parse(await c.evaluate(healthProbe));
    if (!hp.missing && hp.groups > 0) break;
  }
  report.health[name] = { opened, ...hp };
  await c.screenshot(`${OUT}/health-${name}.png`);
  // 勾选两份重复项 + 全选失链：底栏出现批量钮后再拍一张
  await c.evaluate(`(() => { const all = [...document.querySelectorAll('.wr-health-dialog button')].find((x) => x.textContent.trim() === '全选失链'); if (all) all.click(); })()`);
  await sleep(200);
  await c.evaluate(`(() => { const c = document.querySelectorAll('.wr-health-copy input[type=checkbox]')[1]; if (c) c.click(); })()`);
  await sleep(300);
  report.health[name].afterSelect = JSON.parse(await c.evaluate(healthProbe)).footText;
  await c.screenshot(`${OUT}/health-selected-${name}.png`);
  await c.click('.wr-health-dialog .wr-health-foot button:last-child'); // 关闭体检
  await sleep(350);
}

// 通用规则验证：其它圆角弹窗（书籍详情）滚动时，滚动条不压进圆角。塞一根高元素逼出竖向滚动条，放大拍右下角。
await c.viewport(1350, 801);
await c.evaluate(`(() => { const b = [...document.querySelectorAll('.wr-settings-body button')].find((x) => x.textContent.trim() === '开始体检'); if (b) b.click(); })()`);
await sleep(1200);
await c.evaluate(`(() => { const d = [...document.querySelectorAll('.wr-health-copy button')].find((x) => x.textContent.trim() === '详情'); if (d) d.click(); })()`);
await sleep(900);
const details = await c.evaluate(`(() => {
  const dlg = [...document.querySelectorAll('.wr-dialog')].find((d) => !d.classList.contains('wr-health-dialog') && !d.classList.contains('wr-settings-dialog'));
  if (!dlg) return JSON.stringify({ missing: true });
  const tall = document.createElement('div'); tall.style.cssText = 'height:1800px;background:linear-gradient(#e66,#66e)'; dlg.appendChild(tall);
  dlg.scrollTop = 0;
  const d = dlg.getBoundingClientRect();
  return JSON.stringify({ rect: [Math.round(d.left), Math.round(d.top), Math.round(d.width), Math.round(d.height)], scrolls: dlg.scrollHeight > dlg.clientHeight, radius: getComputedStyle(dlg).borderRadius });
})()`).then(JSON.parse);
report.detailsDialog = details;
if (!details.missing) {
  const [x, y, w, h] = details.rect;
  await c.screenshot(`${OUT}/corner-topright.png`, { x: x + w - 60, y, width: 60, height: 60, scale: 5 });
  await c.screenshot(`${OUT}/corner-bottomright.png`, { x: x + w - 60, y: y + h - 60, width: 60, height: 60, scale: 5 });
}

report.mock = await c.evaluate(`JSON.stringify({ unknown: [...window.__MOCK__.unknown] })`).then(JSON.parse);
report.errors = c.logs.filter((l) => /error|exception/i.test(l.kind));
await c.viewportClear();
writeFileSync("F:/bookreading-project/temp/verify-settings.json", JSON.stringify(report, null, 2), "utf8");

const summary = { hasDialog: true, sizes: {}, sections: {}, health: {}, errors: report.errors.length, unknown: report.mock.unknown };
for (const [name, s] of Object.entries(report.sizes)) {
  summary.sizes[name] = { win: `${s.vw}x${s.vh}`, dlg: s.dlg.map((v) => Math.round(v)).join("x"), h1Left: s.h1Left, iconLeft: s.iconLeft, quick: s.sidebarQuick, libStill: s.libraryStillThere };
}
for (const [name, secs] of Object.entries(report.sections)) {
  const unstable = Object.entries(secs).filter(([, p]) => !p.stable.dlg || !p.stable.tabs || !p.stable.bodyW).map(([k, p]) => k + JSON.stringify(p.stable));
  const overflow = Object.entries(secs).filter(([, p]) => p.overflow.length || p.paneScroll?.xOverflow).map(([k, p]) => k);
  summary.sections[name] = { sections: Object.keys(secs).length, unstable, overflow };
}
for (const [name, h] of Object.entries(report.health)) {
  summary.health[name] = h.missing ? "MISSING" : { dlg: h.dlg.map((v) => Math.round(v)).join("x"), xOverflow: h.scroll?.xOverflow, groups: h.groups, copies: h.copies, rows: h.rows, checks: h.checkboxes, footInFrame: h.footInFrame, overflow: h.overflow, afterSelect: h.afterSelect };
}
summary.detailsDialog = report.detailsDialog;
console.log(JSON.stringify(summary));
c.close();
process.exit(0);
