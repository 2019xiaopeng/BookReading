// 断点扫描：在三个容器断点（600 / 780 / 主题九宫格 700、900）的两侧逐像素宽度探测导航形态与折行、溢出。
// 容器宽 = 窗口宽 − 侧栏(210/270) − 间距内边距(24/36)：<1200 窗口时 −240，≥1200 时 −324。
import { connect, sleep } from "./cdp-lib.mjs";

const c = await connect(9333, /.*/);
await c.click('.wr-settings-tab[data-section="reading"]');
const widths = [900, 902, 904, 906, 908, 910, 1080, 1082, 1084, 1086, 1088, 1090, 1092];
const rows = [];
for (const w of widths) {
  await c.viewport(w, 700);
  await sleep(220);
  rows.push(
    JSON.parse(
      await c.evaluate(`(() => {
        const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
        const root = document.querySelector('.wr-settings');
        const nav = document.querySelector('.wr-settings-nav');
        const sel = document.querySelector('.wr-settings-nav-select');
        const tabs = [...document.querySelectorAll('.wr-settings-tab')];
        const main = document.querySelector('.wr-main').getBoundingClientRect();
        let overflow = 0;
        for (const el of root.querySelectorAll('*')) { const b = el.getBoundingClientRect(); if (b.width > 0 && b.right > main.right + 0.5) overflow++; }
        const tops = new Set(tabs.filter(vis).map((t) => Math.round(t.getBoundingClientRect().top)));
        const stacked = (() => { const r = document.querySelector('.wr-settings-row'); return r ? getComputedStyle(r).gridTemplateColumns.split(' ').length : 0; })();
        return JSON.stringify({
          vw: ${w}, cw: Math.round(root.getBoundingClientRect().width),
          mode: vis(sel) ? 'dropdown' : getComputedStyle(nav).display === 'grid' ? 'column' : 'chips',
          tabRows: tops.size, navH: Math.round(nav.getBoundingClientRect().height), rowCols: stacked, overflow,
        });
      })()`),
    ),
  );
}
await c.viewportClear();
console.log(JSON.stringify(rows));
c.close();
process.exit(0);
