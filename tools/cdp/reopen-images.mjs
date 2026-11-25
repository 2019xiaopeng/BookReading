// 「同一本书第二次打开插图破损」回归检查（需真实 dev 窗口 + 真实书库：端口 9223）。
// 进指定书架 → 按书名片段打开书 → 打开 / 退出 / 再打开 三轮，逐轮报告：
//   首个 iframe 里图片的地址类型与加载状态、本轮新建的 blob 数（健康值应三轮相近）、撤销来自哪里。
// 只输出结构信息（数量 / 状态 / 函数名），不截图、不输出正文与书名以外的内容。
// 用法：node tools/cdp/reopen-images.mjs <书架名> <书名片段>
// 判读：三轮都应是 blob:ok 且 created 数相近；若第二轮起 img 变成 http(…):BROKEN 且 created 骤降 → 资源替换被跳过
//      （2026-11-25 的根因是 epubjsPatch 的 replacements 没把相对 href 解析成绝对路径，见 CLAUDE.md）。
import { connect, sleep } from "./cdp-lib.mjs";

const [SHELF, TITLE] = process.argv.slice(2);
if (!SHELF || !TITLE) {
  console.error("usage: node tools/cdp/reopen-images.mjs <书架名> <书名片段>");
  process.exit(2);
}
const c = await connect(9223);
const startUrl = await c.evaluate(`location.pathname + location.search`);
// 干净环境：整页重载，清掉此前脚本可能留在页面里的探针（测完再送回原位置）
await c.send("Page.reload");
for (let i = 0; i < 80; i++) {
  await sleep(250);
  if (await c.evaluate(`!!document.querySelector('.wr-side-bottom')`)) break;
}
await sleep(1500);
const out = { runs: [], notes: [] };

const inReader = () => c.evaluate(`location.pathname.startsWith('/read/')`);
const backToLibrary = async () => {
  if (await inReader()) await c.evaluate(`history.back()`);
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (!(await inReader())) break;
  }
  await sleep(700);
};

async function openTargetBook() {
  await backToLibrary();
  await c.evaluate(`(() => { const t = [...document.querySelectorAll('.wr-nav-tree-tool')].find((x) => x.textContent.trim() === '全部展开'); if (t) t.click(); })()`);
  await sleep(300);
  const clicked = await c.evaluate(`(() => {
    const row = [...document.querySelectorAll('.wr-nav-group-btn')].find((b) => ([...b.childNodes].find((n) => n.nodeType === 3)?.textContent || '').trim() === ${JSON.stringify(SHELF)});
    if (!row) return false; row.click(); return true;
  })()`);
  if (!clicked) return "no-shelf-row";
  const find = `!![...document.querySelectorAll('.wr-book-card')].find((x) => (x.querySelector('.wr-title')?.textContent || '').includes(${JSON.stringify(TITLE)}))`;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (await c.evaluate(find)) break;
  }
  const bookId = await c.evaluate(`(() => {
    const card = [...document.querySelectorAll('.wr-book-card')].find((x) => (x.querySelector('.wr-title')?.textContent || '').includes(${JSON.stringify(TITLE)}));
    if (!card) return null; card.click(); return card.getAttribute('data-book-id');
  })()`);
  if (!bookId) return "card-not-found";
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    if (await inReader()) break;
  }
  return bookId;
}

const snap = `(() => {
  const stage = document.querySelector('.wr-reader-stage') || document;
  const rows = [...stage.querySelectorAll('iframe')].map((f) => {
    let d = null;
    try { d = f.contentDocument; } catch (e) {}
    if (!d) return 'nodoc';
    const imgs = [...d.querySelectorAll('img')];
    const kinds = imgs.map((i) => {
      const s = i.currentSrc || i.src || '';
      const k = s.startsWith('blob:') ? 'blob' : s.startsWith('http') ? 'http' : s.startsWith('data:') ? 'data' : 'rel';
      return k + (i.complete ? (i.naturalWidth > 0 ? ':ok' : ':BROKEN') : ':pending');
    });
    return 'imgs=' + imgs.length + ' [' + kinds.join(', ') + '] cls=' + (d.body ? d.body.className : '-');
  });
  const alertEl = document.querySelector('.wr-reader-root [role=alert]');
  return JSON.stringify({ frames: rows.length, rows, alert: alertEl ? alertEl.textContent.slice(0, 60) : null });
})()`;

// 探针：撤销 / 创建 blob 时各记一条（调用方取栈里前几个具名函数，定位是谁撤销的）
await c.evaluate(`(() => {
  if (window.__probeOn) return;
  const origRevoke = URL.revokeObjectURL.bind(URL);
  const origCreate = URL.createObjectURL.bind(URL);
  const fnName = (s) => (s.trim().split(' ')[1] || s.trim().slice(0, 40)).replace(/^at /, '');
  window.__revoked = [];
  window.__created = [];
  URL.revokeObjectURL = (u) => { const st = (new Error().stack || '').split('\\n').slice(2, 8).map(fnName); window.__revoked.push({ st, t: Math.round(performance.now()) }); return origRevoke(u); };
  URL.createObjectURL = (o) => { const u = origCreate(o); window.__created.push({ type: (o && o.type) || '', t: Math.round(performance.now()) }); return u; };
  window.__probeOn = true;
})()`);

for (const run of [1, 2, 3]) {
  await c.evaluate(`window.__revoked = []; window.__created = [];`);
  const t0 = await c.evaluate(`Math.round(performance.now())`);
  const bookId = await openTargetBook();
  if (typeof bookId !== "string" || bookId.length !== 36) {
    out.runs.push({ run, failed: true, reason: bookId });
    break;
  }
  const timeline = [];
  let last = "";
  for (let t = 0; t < 40; t++) {
    await sleep(300);
    const s = await c.evaluate(snap);
    if (s !== last) {
      timeline.push({ t: (t + 1) * 300, s: JSON.parse(s) });
      last = s;
    }
  }
  const revoked = JSON.parse(await c.evaluate(`JSON.stringify(window.__revoked)`));
  const created = JSON.parse(await c.evaluate(`JSON.stringify(window.__created)`));
  const final = timeline[timeline.length - 1]?.s;
  out.runs.push({
    run,
    sameBook: run === 1 ? true : bookId === out.__bookId,
    final: final ? final.rows : null,
    alert: final?.alert ?? null,
    created: created.length,
    createdTypes: [...new Set(created.map((x) => x.type))],
    revokedDuringThisOpen: revoked.length,
    revokedBy: [...new Set(revoked.map((x) => x.st.slice(0, 4).join('<')))],
  });
  out.__bookId = bookId;
}
delete out.__bookId;

await backToLibrary();
await c.evaluate(`(() => { if (${JSON.stringify(startUrl)} !== location.pathname + location.search) { history.pushState({}, '', ${JSON.stringify(startUrl)}); window.dispatchEvent(new PopStateEvent('popstate', { state: history.state })); } })()`);
out.restoredTo = await c.evaluate(`location.pathname + location.search`);
console.log(JSON.stringify(out));
c.close();
process.exit(0);
