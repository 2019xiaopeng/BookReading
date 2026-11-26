// V-3 开场动画取证（无头 Chrome 9333 + Vite 14200 + IPC 假后端，合成数据）。
// 冷启动进书架 → 开场动画一出现就暂停 → 把两段动画定位到同一进度逐帧截图（确定性）→ 断言：
//   总时长 ≤ 600ms、只改 opacity 不改布局（进度 0 / 1 / 播完三份坐标逐位相同）、只播一次
//   （切页、去阅读页再回来都不重播）、系统「减少动态效果」下不播。各尺寸 × 主题拼对照表。
// 用法：node tools/cdp/verify-intro.mjs [sizes=1350x801,720x480] [themes=ink,dark]
// 前置同 verify-turn.mjs：Vite 在 14200、无头 Chrome 在 9333。
import { mkdirSync, writeFileSync } from "node:fs";
import { connect, sleep } from "./cdp-lib.mjs";
import { MOCK, ipcShimSource } from "./ipc-shim.mjs";

const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback);
const SIZES = arg("sizes", "1350x801,720x480").split(",");
const THEMES = arg("themes", "ink,dark").split(",");
const OUT = "F:/bookreading-project/temp/intro-shots";
mkdirSync(OUT, { recursive: true });

const c = await connect(9333, /.*/);
await c.send("Page.enable");
await c.send("Runtime.enable");
const ev = (s) => c.evaluate(s);
const J = (s) => ev(s).then(JSON.parse);
const report = { failures: [], frames: [], timing: null, stable: null, checks: {} };
const fail = (msg) => report.failures.push(msg);

/** 冷启动进书架：注入假后端 + 一个每帧把开场动画暂停下来的看门狗 */
async function coldStart(theme, viewport) {
  const mock = JSON.parse(JSON.stringify(MOCK));
  Object.assign(mock.settings, { theme });
  const source =
    ipcShimSource(mock) +
    "\n(() => {\n" +
    "  window.__intro = { anims: [] };\n" +
    "  (function watch() {\n" +
    "    for (const a of document.getAnimations()) {\n" +
    "      if (a.animationName === 'wr-intro-in' && a.playState === 'running') { a.pause(); window.__intro.anims.push(a); const sp = document.getElementById('wr-splash'); if (sp) sp.remove(); }\n" +
    "    }\n" +
    "    if (!window.__introStop) requestAnimationFrame(watch);\n" +
    "  })();\n" +
    "})();\n";
  const r = await c.send("Page.addScriptToEvaluateOnNewDocument", { source });
  await c.viewport(Number(viewport.split("x")[0]), Number(viewport.split("x")[1]));
  const origin = await ev(`performance.timeOrigin`).catch(() => 0);
  await c.send("Page.navigate", { url: "http://localhost:14200/" });
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`performance.timeOrigin !== ${origin} && !!document.querySelector('.wr-shell')`).catch(() => false);
    if (ok) break;
    await sleep(100);
  }
  await sleep(500);
  await c.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: r.identifier });
}
/** 关键元素的外框坐标：开场动画只许改透明度，不许挪东西 */
const rects = () =>
  J(
    `JSON.stringify([...document.querySelectorAll('.wr-side, .wr-brand-name, .wr-nav-btn, .wr-side-bottom, .wr-main, .wr-main-topbar, .wr-book-card')].map((el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }))`,
  );
const go = (path) => ev(`(() => { history.pushState({}, "", ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent("popstate")); return 1; })()`);

for (const theme of THEMES) {
  for (const size of SIZES) {
    const tag = `${theme}-${size}`;
    await coldStart(theme, size);
    for (let i = 0; i < 40 && (await ev(`window.__intro.anims.length`)) < 1; i++) await sleep(100);
    const info = await J(
      `JSON.stringify({ cls: !!document.querySelector('.wr-shell--intro'), anims: window.__intro.anims.map((a) => { const t = a.effect.getTiming(); return { target: a.effect.target.className.split(' ')[1], duration: t.duration, delay: t.delay, prop: Object.keys(a.effect.getKeyframes().reduce((o, k) => ({ ...o, ...k }), {})).filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k)) }; }) })`,
    );
    const total = Math.max(...info.anims.map((a) => a.delay + a.duration));
    report.timing = { total, anims: info.anims };
    if (!info.cls || info.anims.length !== 1) fail(`${tag}：没有看到开场动画（${JSON.stringify(info)}）`);
    if (!(total <= 600)) fail(`${tag}：总时长 ${total}ms 超过 600ms`);
    if (!info.anims.every((a) => a.prop.length > 0 && a.prop.every((p) => p === "opacity" || p === "transform"))) fail(`${tag}：动画改了 opacity 以外的属性：${JSON.stringify(info.anims)}`);

    const seek = (p) => ev(`(() => { for (const a of window.__intro.anims) { a.currentTime = ${p} * ${total}; } return 1; })()`);
    await seek(0);
    const r0 = await rects();
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      await seek(p);
      const f = `${OUT}/intro-${tag}-t${String(Math.round(p * 100)).padStart(3, "0")}`;
      await c.screenshot(`${f}.png`);
      report.frames.push([f.replace(`${OUT}/`, ""), `${tag} ${Math.round(p * 100)}%`]);
    }
    const r1 = await rects();
    // 放开让它播完 → animationend → 撤类
    // 直接收尾 → animationend → 撤类（看门狗同时停掉：否则会把重新跑起来的动画又暂停、重复记账）
    await ev(`(() => { window.__introStop = true; for (const a of window.__intro.anims) a.finish(); return 1; })()`);
    for (let i = 0; i < 40 && (await ev(`!!document.querySelector('.wr-shell--intro')`)); i++) await sleep(100);
    const r2 = await rects();
    report.stable = { sameAt1AndAfterEnd: JSON.stringify(r1) === JSON.stringify(r2), elements: r0.length };
    if (!report.stable.sameAt1AndAfterEnd) fail(`${tag}：动画改了布局坐标（${JSON.stringify(report.stable)}）`);
    if (r0.length < 6) fail(`${tag}：只量到 ${r0.length} 个元素`);
    if (await ev(`!!document.querySelector('.wr-shell--intro')`)) fail(`${tag}：播完后 .wr-shell--intro 没有撤掉`);

    // 只播一次：切页 / 去阅读页再回来（壳重挂）都不重播
    const steps = [];
    for (const path of ["/favorites", "/", "/read/synth-turn", "/"]) {
      await go(path);
      await sleep(600);
      steps.push(
        await J(
          `JSON.stringify({ path: location.pathname, shell: !!document.querySelector('.wr-shell'), cls: !!document.querySelector('.wr-shell--intro'), opacity: [document.querySelector('.wr-shell-body')].filter(Boolean).map((el) => getComputedStyle(el).opacity).join("/"), running: document.getAnimations().filter((a) => a.animationName === 'wr-intro-in').map((a) => a.playState).join(",") })`,
        ),
      );
    }
    // 判据是用户看得见的：类没有再加回来、两栏都是不透明（无头环境不出帧，已结束的动画对象会晚一点才回收，不拿它当判据）
    const again = steps.some((s) => s.shell && (s.cls || s.opacity !== "1"));
    report.checks.playOnce = !again;
    if (again) fail(`${tag}：切页 / 重挂壳之后开场动画又播了一次：${JSON.stringify(steps)}`);
  }
}

// 系统「减少动态效果」：不播（没有动画、类即时撤掉）
await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await coldStart("ink", SIZES[0]);
await sleep(800);
const reduced = await J(`JSON.stringify({ cls: !!document.querySelector('.wr-shell--intro'), anims: window.__intro.anims.length, shellVisible: getComputedStyle(document.querySelector('.wr-side')).opacity })`);
await c.send("Emulation.setEmulatedMedia", { features: [] });
report.checks.reducedMotion = reduced;
if (reduced.cls || reduced.anims !== 0 || reduced.shellVisible !== "1") fail(`reduced-motion 下不对：${JSON.stringify(reduced)}`);

// 对照表
const w = 420;
const h = Math.round((w * Number(SIZES[0].split("x")[1])) / Number(SIZES[0].split("x")[0]));
const cols = 5;
const rows = Math.ceil(report.frames.length / cols);
writeFileSync(
  `${OUT}/SHEET-intro.html`,
  `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#888;font:12px sans-serif;color:#fff"><div style="display:grid;grid-template-columns:repeat(${cols},${w}px);gap:4px;padding:4px">${report.frames
    .map(([f, label]) => `<div><div style="height:16px">${label}</div><img src="${f}.png" style="width:${w}px;height:${h}px;display:block"></div>`)
    .join("")}</div></body>`,
  "utf8",
);
await c.viewport(cols * (w + 4) + 8, rows * (h + 22) + 8);
await c.send("Page.navigate", { url: `file:///${OUT}/SHEET-intro.html` });
await sleep(600);
await c.screenshot(`${OUT}/SHEET-intro.png`);

writeFileSync("F:/bookreading-project/temp/verify-intro.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ failures: report.failures, timing: report.timing, stable: report.stable, checks: report.checks }, null, 1));
c.close();
process.exit(report.failures.length ? 1 : 0);
