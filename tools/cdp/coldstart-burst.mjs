// 真实窗口冷启动连拍（V-3 开场动画的另一半验收）：等隔离 dev 的 CDP 端口出现 → 连上 → 每 ~80ms 截一帧，
// 直到壳出现、开场动画播完。记下每帧的壳类名与两栏透明度（应是单调上升），拼成对照表。
// 用法：先起本脚本（它会等 9223），再启动应用：
//   node tools/cdp/coldstart-burst.mjs            （后台）
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" npm run dev:isolated
// 产物：temp/intro-shots/cold-NN.png + SHEET-cold.png（在无头 Chrome 9333 里拼，不动真实窗口）+ temp/coldstart-burst.json
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, sleep } from "./cdp-lib.mjs";

const OUT = "F:/bookreading-project/temp/intro-shots";
mkdirSync(OUT, { recursive: true });
const waitPort = async () => {
  for (let i = 0; i < 900; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
      if (list.some((t) => t.type === "page")) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("CDP 9223 没有出现（应用没起来？）");
};
await waitPort();
const c = await connect(9223, /.*/);
await c.send("Page.enable");
await c.send("Runtime.enable");

const frames = [];
let settled = 0;
for (let i = 0; i < 150; i++) {
  const s = await c
    .evaluate(
      `JSON.stringify({ t: Math.round(performance.now()), path: location.pathname, shell: !!document.querySelector('.wr-shell'), intro: !!document.querySelector('.wr-shell--intro'), side: document.querySelector('.wr-side') ? getComputedStyle(document.querySelector('.wr-side')).opacity : null, main: document.querySelector('.wr-main') ? getComputedStyle(document.querySelector('.wr-main')).opacity : null })`,
    )
    .then(JSON.parse)
    .catch(() => null);
  const file = `${OUT}/cold-${String(i).padStart(2, "0")}.png`;
  await c.screenshot(file).catch(() => {});
  if (s) {
    frames.push({ i, ...s, file });
    // 壳出现且开场动画撤类之后再拍 4 帧
    settled = s.shell && !s.intro ? settled + 1 : 0;
    if (settled >= 4) break;
  }
}
c.close(); // 真实窗口到此为止，不再碰它

const first = frames.find((f) => f.shell);
const introFrames = frames.filter((f) => f.intro);
const sideOps = introFrames.map((f) => Number(f.side));
const mainOps = introFrames.map((f) => Number(f.main));
const mono = (xs) => xs.every((v, i) => i === 0 || v >= xs[i - 1] - 0.001);
const report = {
  frames: frames.length,
  firstShellAtMs: first?.t ?? null,
  introFrames: introFrames.length,
  sideOpacity: sideOps,
  mainOpacity: mainOps,
  monotonic: { side: mono(sideOps), main: mono(mainOps) },
  done: !!first && frames[frames.length - 1].intro === false,
};
writeFileSync("F:/bookreading-project/temp/coldstart-burst.json", JSON.stringify({ ...report, frames }, null, 1), "utf8");

// 对照表在无头 Chrome（9333）里拼
const start = Math.max(0, (first ? first.i : 0) - 1);
const shown = frames.slice(start, start + 15);
const png = readFileSync(shown[0]?.file ?? `${OUT}/cold-00.png`);
const iw = png.readUInt32BE(16);
const ih = png.readUInt32BE(20);
const w = 400;
const h = Math.round((w * ih) / iw);
const cols = 5;
const rows = Math.ceil(shown.length / cols);
writeFileSync(
  `${OUT}/SHEET-cold.html`,
  `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#888;font:12px sans-serif;color:#fff"><div style="display:grid;grid-template-columns:repeat(${cols},${w}px);gap:4px;padding:4px">${shown
    .map(
      (f) =>
        `<div><div style="height:16px">+${f.t}ms side=${Number(f.side ?? 0).toFixed(2)} main=${Number(f.main ?? 0).toFixed(2)}</div><img src="${f.file.split("/").pop()}" style="width:${w}px;height:${h}px;display:block"></div>`,
    )
    .join("")}</div></body>`,
  "utf8",
);
const hc = await connect(9333, /.*/);
await hc.viewport(cols * (w + 4) + 8, rows * (h + 22) + 8);
await hc.send("Page.navigate", { url: `file:///${OUT}/SHEET-cold.html` });
await sleep(700);
await hc.screenshot(`${OUT}/SHEET-cold.png`);
hc.close();
console.log(JSON.stringify(report, null, 1));
