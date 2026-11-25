// 补充验证（v3.2 设置浮窗）：深浅主题观感 + 关闭方式。复用 verify-settings.mjs 已打开的页面（不重载）。
// 用法：先跑 verify-settings.mjs，再跑本脚本。结果写 F:/bookreading-project/temp/verify-extra.json，截图进 temp/shots。
import { writeFileSync } from "node:fs";
import { connect, sleep } from "./cdp-lib.mjs";

const OUT = "F:/bookreading-project/temp/shots";
const c = await connect(9333, /.*/);
const out = { themes: {} };
c.logs.length = 0;

const dialogOpen = () => c.evaluate(`!!document.querySelector('.wr-settings-dialog')`);
async function open() {
  if (!(await dialogOpen())) {
    await c.click('.wr-side-bottom button[aria-label="设置"]');
    await sleep(800);
  }
}
async function setTheme(label) {
  await c.click('.wr-settings-tab[data-section="appearance"]');
  await sleep(250);
  await c.click(`.wr-settings-theme[aria-label="${label}"]`);
  await sleep(350);
}
async function shot(section, size, file) {
  await c.click(`.wr-settings-tab[data-section="${section}"]`);
  await sleep(section === "library" ? 650 : 400);
  await c.screenshot(`${OUT}/${file}`);
}

await c.viewport(1350, 801);
await open();
for (const [label, file] of [
  ["墨夜", "dark"],
  ["夜间", "night"],
  ["米黄", "sepia"],
]) {
  await setTheme(label);
  await shot("reading", "1350x801", `dlg-${file}-reading-1350x801.png`);
  const probe = await c.evaluate(`(() => { const dlg = document.querySelector('.wr-settings-dialog'); const tab = document.querySelector('.wr-settings-tab[aria-selected="true"]'); const cs = getComputedStyle(tab); const csT = getComputedStyle(document.querySelector('.wr-settings-title')); return JSON.stringify({ theme: document.documentElement.dataset.theme, tabBg: cs.backgroundColor, tabColor: cs.color, titleColor: csT.color, ink: getComputedStyle(dlg).color }); })()`).then(JSON.parse);
  await c.viewport(720, 480);
  await shot("library", "720x480", `dlg-${file}-library-720x480.png`);
  out.themes[label] = probe;
}

// 还原纸墨
await c.viewport(1350, 801);
await setTheme("纸墨");

// 关闭方式一：Esc
await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await sleep(450);
out.escClosed = !(await dialogOpen());
out.pathAfterEsc = await c.evaluate(`location.pathname + location.search`);

// 关闭方式二：重开后点遮罩（落在浮窗外的侧栏区域）
await open();
out.reopened = await dialogOpen();
out.reopenedSection = await c.evaluate(`document.querySelector('.wr-settings-tab[aria-selected="true"]')?.dataset.section`);
await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 60, y: 420, button: "left", clickCount: 1 });
await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 60, y: 420, button: "left", clickCount: 1 });
await sleep(450);
out.overlayClosed = !(await dialogOpen());
out.pathAfterOverlay = await c.evaluate(`location.pathname + location.search`);
out.libraryIntact = await c.evaluate(`!!document.querySelector('.wr-main .wr-masthead-name')`);

out.errors = c.logs.filter((l) => /error|exception/i.test(l.kind)).map((l) => l.kind);
await c.viewportClear();
writeFileSync("F:/bookreading-project/temp/verify-extra.json", JSON.stringify(out, null, 2), "utf8");
console.log(JSON.stringify(out));
c.close();
process.exit(0);
