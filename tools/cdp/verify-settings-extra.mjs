// 补充验证：深色主题观感 + 滚动后分区导航吸顶。复用 verify-settings.mjs 已打开的页面（不重载）。
import { connect, sleep } from "./cdp-lib.mjs";

const OUT = "F:/bookreading-project/temp/shots";
const c = await connect(9333, /.*/);
const out = {};

async function theme(name) {
  await c.click('.wr-settings-tab[data-section="appearance"]');
  await sleep(250);
  await c.click(`.wr-settings-theme[aria-label="${name}"]`);
  await sleep(350);
}
async function scrollAndProbe(section, px) {
  await c.click(`.wr-settings-tab[data-section="${section}"]`);
  await sleep(350);
  await c.evaluate(`(() => { const s = document.querySelector('.wr-main-scroll'); s.scrollTop = ${px}; return s.scrollTop; })()`);
  await sleep(250);
  return c.evaluate(`(() => {
    const nav = document.querySelector('.wr-settings-nav').getBoundingClientRect();
    const sc = document.querySelector('.wr-main-scroll').getBoundingClientRect();
    const title = document.querySelector('.wr-settings-title');
    return JSON.stringify({ theme: document.documentElement.dataset.theme, vw: innerWidth, scrollTop: document.querySelector('.wr-main-scroll').scrollTop, navTop: Math.round(nav.top - sc.top), navH: Math.round(nav.height), titleVisible: title ? title.getBoundingClientRect().bottom > sc.top : null });
  })()`).then(JSON.parse);
}

// 1) 宽形态 + 墨夜：滚动后左列导航应停在 top=20
await c.viewport(1280, 800);
await theme("墨夜");
out.wideInkDark = await scrollAndProbe("reading", 420);
await c.screenshot(`${OUT}/dark-reading-1280x800-scrolled.png`);

// 2) 窄形态 + 墨夜：滚动后顶部胶囊行应吸在 top=0
await c.viewport(720, 480);
out.narrowInkDark = await scrollAndProbe("library", 500);
await c.screenshot(`${OUT}/dark-library-720x480-scrolled.png`);

// 3) 夜间 + 米黄：外观分区各拍一张（窄形态，看主题卡与吸顶条在深/浅底上的对比）
await theme("夜间");
await sleep(200);
out.narrowDark = await scrollAndProbe("appearance", 0);
await c.screenshot(`${OUT}/dark-appearance-720x480.png`);
await theme("米黄");
await c.click('.wr-settings-tab[data-section="network"]');
await sleep(500);
await c.screenshot(`${OUT}/sepia-network-720x480.png`);

// 4) 复原：纸墨主题、视口还原
await theme("纸墨");
await c.viewportClear();
console.log(JSON.stringify(out));
c.close();
process.exit(0);
