// 安装版 CDP 取证：CSP 实文 / console 违规 / epub iframe 字体·样式·图片 / 手动样式注入测试
// 用法：node temp/cdp-inspect.mjs  （需先带 --remote-debugging-port 启动安装版）
import { writeFileSync } from "node:fs";

const PORT = Number(process.env.CDP_PORT || 9224);
const OUT = process.argv[2] || "F:/bookreading-project/temp/cdp-report.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /tauri\.localhost|bookreading/i.test(t.url + " " + t.title));
      if (page) return page;
    } catch {}
    await sleep(1000);
  }
  throw new Error("CDP page target not found (app not running with debug port?)");
}

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws connect failed")); });

let idSeq = 0;
const pending = new Map();
const consoleLog = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === "Runtime.consoleAPICalled") {
    consoleLog.push({ src: "console", level: msg.params.type, text: (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400) });
  } else if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry;
    consoleLog.push({ src: "log", level: e.level, source: e.source, text: (e.text || "").slice(0, 400), url: e.url });
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++idSeq;
  pending.set(id, (msg) => (msg.error ? rej(new Error(method + ": " + JSON.stringify(msg.error))) : res(msg.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || "").slice(0, 400) };
  return r.result.value;
};

await send("Runtime.enable");
await send("Log.enable");
const report = { steps: {} };

// 1) 页面基础 + 实际生效的 CSP meta（Tauri 打包时注入）
report.steps.page = await ev(`JSON.stringify({
  url: location.href, ua: navigator.userAgent.slice(-80),
  cspMeta: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
  hasContinue: !!document.querySelector('.wr-continue-card'),
  continueTitle: document.querySelector('.wr-continue-title')?.textContent ?? null
})`).then((s) => JSON.parse(s || "{}"));

// 2) 打开上次读的书
if (report.steps.page.hasContinue) {
  await ev(`document.querySelector('.wr-continue-card').click(); 'clicked'`);
  report.steps.clicked = report.steps.page.continueTitle;
}

// 3) 等 epub iframe 出现（最多 30s）
let iframeFound = false;
for (let i = 0; i < 30; i++) {
  iframeFound = !!(await ev(`!!document.querySelector('iframe')`));
  if (iframeFound) break;
  await sleep(1000);
}
report.steps.iframeFound = iframeFound;
await sleep(4000); // 等首章渲染 + 主题/字体注入

// 4) iframe 内取证
if (iframeFound) {
  report.steps.iframe = await ev(`(() => {
    const f = document.querySelector('iframe');
    const d = f && f.contentDocument;
    if (!d) return { error: 'no contentDocument' };
    const cs = getComputedStyle(d.body);
    let injectTest;
    try {
      const s = d.createElement('style');
      s.textContent = 'body{letter-spacing:.123em}';
      d.head.appendChild(s);
      injectTest = { applied: getComputedStyle(d.body).letterSpacing, rules: s.sheet ? s.sheet.cssRules.length : null };
      s.remove();
    } catch (e) { injectTest = { error: String(e) }; }
    const imgs = [...d.querySelectorAll('img')];
    return {
      iframeSrc: (f.src || '').slice(0, 90), attrSrc: f.getAttribute('src'),
      contentHref: (d.location && d.location.href || '').slice(0, 90),
      bodyClass: d.body.className,
      computed: { fontFamily: cs.fontFamily, lineHeight: cs.lineHeight, padding: cs.padding, bg: cs.backgroundColor, color: cs.color, fontSize: cs.fontSize },
      headStyles: [...d.head.querySelectorAll('style')].map((s) => ({ head: (s.textContent || '').slice(0, 180), rules: s.sheet ? s.sheet.cssRules.length : null })),
      fonts: [...d.fonts].map((x) => x.family + ':' + x.status),
      fontsCheckWrCustom: d.fonts.check('16px wr-custom'),
      imgs: { total: imgs.length, broken: imgs.filter((i) => !i.naturalWidth).length, sample: imgs.slice(0, 6).map((i) => ({ src: (i.currentSrc || i.src || '').slice(0, 70), ok: i.naturalWidth > 0, complete: i.complete })) },
      injectTest,
      bodyHtmlHead: d.body.innerHTML.slice(0, 300)
    };
  })()`);
  // 宿主 document 的 @font-face（readerFont.ts 注入 wr-custom）
  report.steps.host = await ev(`(() => ({
    styles: [...document.head.querySelectorAll('style')].map((s) => (s.textContent || '').slice(0, 200)),
    fontsCheckWrCustom: document.fonts.check('16px wr-custom')
  }))()`);
} else {
  report.steps.fallback = await ev(`JSON.stringify({
    url: location.href,
    bodyText: document.body.innerText.slice(0, 300),
    cardCandidates: [...document.querySelectorAll('[class*="card"]')].slice(0, 12).map((e) => e.className)
  })`).then((s) => JSON.parse(s || "{}"));
}

await sleep(1500);
report.consoleLog = consoleLog;
writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
console.log("REPORT_WRITTEN " + OUT + " console=" + consoleLog.length);
ws.close();
process.exit(0);
