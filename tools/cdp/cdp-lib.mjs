// 零依赖 CDP 小工具（Node22 全局 WebSocket/fetch）：连接 dev/安装版 page target，提供 eval / 截图 / 视口模拟 / console 采集
// 用法：import { cdp } from "./cdp-lib.mjs"; const c = await cdp.connect(9223); ...
import { writeFileSync } from "node:fs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connect(port = 9223, match = /localhost:14200|tauri\.localhost/i) {
  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page" && match.test(t.url));
    } catch {}
    if (!target) await sleep(1000);
  }
  if (!target) throw new Error("CDP page target not found on port " + port);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws connect failed")); });
  let seq = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.consoleAPICalled") {
      logs.push({ kind: "console." + m.params.type, text: (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 500) });
    } else if (m.method === "Log.entryAdded") {
      const e = m.params.entry;
      logs.push({ kind: "log." + e.level + "." + e.source, text: (e.text || "").slice(0, 500), url: e.url });
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      logs.push({ kind: "exception", text: ((d.exception?.description || d.text || "") + " @ " + (d.url || "") + ":" + (d.lineNumber ?? "")).slice(0, 600) });
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(method + ": " + JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return {
    logs,
    send,
    evaluate,
    /** 应用内导航（不整页重载）：点击侧栏/页面内按钮 */
    click: (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`),
    /** 视口模拟（仅布局）；dsf<1 时截图按比例缩小（CSS 布局不变），clear 复原 */
    viewport: (width, height, dsf = 0) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dsf, mobile: false }),
    viewportClear: () => send("Emulation.clearDeviceMetricsOverride"),
    /** 截图落盘（PNG），返回路径 */
    screenshot: async (file) => {
      const r = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(r.data, "base64"));
      return file;
    },
    close: () => { try { ws.close(); } catch {} },
  };
}
