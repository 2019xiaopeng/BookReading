// V-1 批次①烟测：翻页走 GhostView 双容器路径——判据=动画期间 iframe 数 1→2、提交后回 1，console 无 ghost 失败日志
import { writeFileSync } from "node:fs";

const PORT = Number(process.env.CDP_PORT || 9223);
const OUT = "F:/bookreading-project/temp/cdp-smoke-turn.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /localhost:14200|tauri\.localhost/i.test(t.url));
      if (page) return page;
    } catch {}
    await sleep(1000);
  }
  throw new Error("CDP target not found");
}

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws failed")); });
let idSeq = 0;
const pending = new Map();
const consoleLog = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.consoleAPICalled") {
    consoleLog.push({ level: m.params.type, text: (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300) });
  } else if (m.method === "Log.entryAdded") {
    const e = m.params.entry;
    consoleLog.push({ level: e.level, source: e.source, text: (e.text || "").slice(0, 300) });
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++idSeq;
  pending.set(id, (m) => (m.error ? rej(new Error(method)) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? { __exc: (r.exceptionDetails.exception?.description || "").slice(0, 200) } : r.result.value;
};

await send("Runtime.enable");
await send("Log.enable");
const report = { steps: {} };

report.steps.start = await ev(`JSON.stringify({
  url: location.href,
  hasContinue: !!document.querySelector('.wr-continue-card'),
  continueTitle: document.querySelector('.wr-continue-title')?.textContent ?? null
})`).then((s) => JSON.parse(s || "{}"));

if (!report.steps.start.hasContinue) {
  // 已在阅读页（HMR 保活路由）——直接进入翻页阶段
  const already = !!(await ev(`!!document.querySelector('.wr-reader-stage iframe')`));
  report.steps.alreadyInReader = already;
  if (already) await runTurns();
  else report.steps.error = "no continue card";
}
else {
  await ev(`document.querySelector('.wr-continue-card').click(); 'clicked'`);
  let ok = false;
  for (let i = 0; i < 30; i++) { ok = !!(await ev(`!!document.querySelector('.wr-reader-stage iframe')`)); if (ok) break; await sleep(1000); }
  report.steps.readerOpen = ok;
  if (ok) await runTurns();
}

async function runTurns() {
  {
    await sleep(2500); // 首章渲染+主题注入
    const key = (k) => ev(`(() => {
      const t = document.querySelector('.wr-reader-stage') || document.querySelector('#root');
      t.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }));
      t.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }));
      return 'sent';
    })()`);
    const iframes = () => ev(`document.querySelectorAll('.wr-reader-stage iframe').length`);
    const samples = {};
    for (const [name, k] of [["right1", "ArrowRight"], ["right2", "ArrowRight"], ["left1", "ArrowLeft"]]) {
      const before = await iframes();
      await key(k);
      await sleep(150); // 动画中段——ghost 应在场
      const mid = await iframes();
      await sleep(1500); // 提交+销毁后
      const after = await iframes();
      samples[name] = { before, mid, after };
    }
    report.steps.turns = samples;
    report.steps.residue = await ev(`(() => {
      const c = document.querySelector('.wr-reader-stage [style*="position: relative"]');
      return { containerChildren: c ? c.children.length : -1, containerTransform: c ? c.style.transform : null };
    })()`);
  }
}

await sleep(1000);
report.consoleErrors = consoleLog.filter((l) => /error|ghost|failed|warn/i.test(l.level + " " + l.text));
report.consoleAll = consoleLog.slice(-30);
writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
console.log("REPORT " + OUT);
ws.close();
process.exit(0);
