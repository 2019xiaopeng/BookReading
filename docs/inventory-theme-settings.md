# BookReading 主题 / 背景 / 设置体系只读盘点（M2 前置事实基线）

盘点对象：`F:\BookReading-project`（Tauri2 + React19）。全部结论只读源码得出，均附 `文件:行号`。样式入口：`main.tsx:4-5` 依次引入 `src/styles/global.css`（内部 `@import "./tokens.css"`，global.css:1）与 `src/ui/weread.css`。

---

## 1. 主题机制

### 1.1 主题枚举与切换入口

- 主题类型 `Theme = "light" | "sepia" | "green" | "gray" | "dark" | "darkcontrast"`（src\reader\settings\types.ts:3），共 **6 套**。
- 色块表 `THEME_SWATCHES`（src\ui\theme.ts:8-16）：白色 #ffffff / 米黄 #fffaf0 / 护眼 #c8e6c4 / 纸灰 #d9d9d6 / 夜间 #0f1214（dark 的纸面 token 是半透明白，色块用壳底色代表）/ 夜间高对比 #050505。壳顶栏菜单与阅读设置面板共用这一份（theme.ts:7）。
- 主题已提升为**应用级**单一事实源 `src\ui\theme.ts`，不随每本书的阅读设置对象流转（types.ts:12 注释）。
- 切换入口共 3 处，全部调 `setTheme`：
  1. 壳顶栏调色盘按钮弹出的浮动菜单（src\ui\AppShell.tsx:288-298 按钮、303-328 菜单）；
  2. EPUB 阅读设置面板六色块（src\reader\components\SettingsPanel.tsx:107-127）；
  3. 漫画/PDF 设置面板六色块（src\reader\image\ImageSettingsPanel.tsx:150-170）。

### 1.2 应用方式：html[data-theme] 属性 + CSS 变量切换（无 body class、无主题名 class）

- `applyDom()` 写 `document.documentElement.dataset.theme = t`，并内联直写 `color-scheme`（dark/darkcontrast→"dark"，否则 "light"）作 WebView2 兜底（theme.ts:25-32）。
- 模块 import 时即读 localStorage 首帧应用，避免启动闪白（theme.ts:18-21、41）。localStorage 键 **`wr-theme`**（theme.ts:18）。
- 持久化双写：localStorage + DB settings 键 **`theme`**（`setSetting("theme", t)`，theme.ts:52；setSetting 定义 src\tauri\invoke.ts:181-183）。
- DB 回填纠偏 `applyPersistedTheme`：`getSettings()` 返回后若与缓存不一致以 DB 为准；本会话用户改过（touched）则跳过（theme.ts:55-60）。调用点：AppShell.tsx:104、ReaderPage.tsx:252。
- 订阅：`useTheme()` 用 useSyncExternalStore（theme.ts:62-73）。

### 1.3 tokens.css 全部变量与默认值（src\styles\tokens.css）

`:root`（light，行 1-13）：

| 变量 | 值 |
|---|---|
| `--bg` | `#f7f7fa` |
| `--panel` | `rgba(255,255,255,0.78)` |
| `--panel-solid` | `#ffffff` |
| `--text` | `rgba(15,18,22,0.92)` |
| `--text-muted` | `rgba(15,18,22,0.62)` |
| `--border` | `rgba(15,18,22,0.12)` |
| `--shadow-sm` | `0 10px 30px rgba(20,24,32,0.12)` |
| `--font-sans` | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", sans-serif` |
| `--font-mono` | `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace` |
| `color-scheme` | `light` |

各主题覆盖值（同名变量，仅列差异项）：

| 主题 | 行号 | --bg | --panel | --panel-solid | --text | --text-muted | --border | --shadow-sm |
|---|---|---|---|---|---|---|---|---|
| dark | 15-24 | `#0b0d10` | `rgba(255,255,255,0.06)` | `#11151b` | `rgba(255,255,255,0.92)` | `rgba(255,255,255,0.62)` | `rgba(255,255,255,0.12)` | `0 8px 24px rgba(0,0,0,0.28)` |
| sepia | 26-35 | `#f4efe6` | `rgba(255,252,246,0.72)` | `#fffaf0` | `rgba(38,29,18,0.9)` | `rgba(38,29,18,0.62)` | `rgba(38,29,18,0.14)` | `0 10px 30px rgba(38,29,18,0.12)` |
| green | 38-47 | `#eef3ec` | `rgba(255,255,255,0.7)` | `#c8e6c4` | `#223325` | `#4d6052` | `#b7d4b3` | `0 10px 30px rgba(34,51,37,0.12)` |
| gray | 49-58 | `#e3e3e0` | `rgba(255,255,255,0.7)` | `#d9d9d6` | `#2b2b28` | `#5b5b54` | `#c4c4bf` | `0 10px 30px rgba(43,43,40,0.12)` |
| darkcontrast | 60-69 | `#000000` | `rgba(255,255,255,0.06)` | `#050505` | `#f5f5f5` | `#bdbdbd` | `#2e2e2e` | `0 8px 24px rgba(0,0,0,0.28)` |

tokens.css **不含 accent**（行 37 注释：accent 角色归 weread.css）。

### 1.4 weread.css 变量（第二套 token，`--wr-*`，src\ui\weread.css）

这是壳/阅读器实际主力 token。`:root`（light，行 1-46）全集：

- 纸面/墨色：`--wr-bg:#f6f4ef`、`--wr-paper:#fbfaf7`、`--wr-ink:rgba(22,24,26,0.92)`、`--wr-muted:rgba(22,24,26,0.62)`、`--wr-hairline:rgba(22,24,26,0.12)`、`--wr-ink-rgb:22,24,26`
- 阴影：`--wr-shadow`、`--wr-shadow-soft`、`--wr-paper-shadow`、`--wr-paper-shadow-soft`、`--wr-shadow-card`、`--wr-shadow-card-hover`、`--wr-shadow-pop`（行 8-10、35-37）
- 纸面描边：`--wr-paper-border:rgba(22,24,26,0.1)`（行 12）
- 圆角：`--wr-radius-xl:22px / -lg:16px / -md:12px / -sm:10px / -xs:8px`（行 13-17）
- **accent（用户不可调，随主题换值）**：`--wr-accent:#1aad19`、`--wr-accent-ink:#ffffff`、`--wr-accent-rgb:26,173,25`、`--wr-accent-deep-rgb:13,117,12`（对比度注释行 21）、`--wr-accent-2-rgb:16,185,129`（壳/封面第二光斑，行 23-24）
- 危险色：`--wr-danger:#d93025`、`--wr-danger-ink:#ffffff`（行 25-26）
- 玻璃栏：`--wr-chrome-bg:rgba(251,250,247,0.6)`（行 28-29，透明度 0.6 + blur16 注释）
- 遮罩：`--wr-scrim:rgba(0,0,0,0.26)`（行 30）
- 半透明面板渐变：`--wr-panel-bg:linear-gradient(180deg, rgba(255,255,255,0.7), rgba(255,255,255,0.55))`（行 31）
- 阅读纸面渐变：`--wr-reader-paper-bg:linear-gradient(180deg, rgba(255,255,255,0.82), rgba(255,255,255,0.64))`（行 32）
- 封面字色：`--wr-cover-title-ink:rgba(255,255,255,0.94)`、`--wr-cover-meta-ink:rgba(255,255,255,0.72)`（行 33-34）
- 字体：`--wr-serif`（Songti/思源宋栈）、`--wr-sans`（PingFang/雅黑栈）、`--wr-mono`（行 38-39、45）
- z 序：`--wr-z-pager:15 / -drawer:20 / -selection:25 / -overlay:30 / -hud:60`（行 40-44）

主题覆盖（仅列关键差异）：

| 主题 | 行号 | --wr-bg | --wr-paper | --wr-accent | 其它关键 |
|---|---|---|---|---|---|
| dark | 48-74 | `#0f1214` | `rgba(255,255,255,0.06)`（半透明） | `#28c76f`，accent-ink 深字 | `--wr-chrome-bg:rgba(0,0,0,0.58)`；panel/paper 渐变改白色 0.08→0.04 |
| sepia | 76-94 | `#f4efe6` | `#fffaf0` | `#b45309`（暖棕），ink `#fff7ed` | panel/paper 渐变近实色 0.96/0.86 |
| green | 97-114 | `#eef3ec` | `#c8e6c4` | `#1aad19`（保持浅色绿） | paper 渐变 0.96/0.84 |
| gray | 116-133 | `#e3e3e0` | `#d9d9d6` | `#1aad19` | 同上模式 |
| darkcontrast | 135-161 | `#000000` | `#050505` | `#28c76f` | 同 dark 的 chrome/渐变组 |

dark/darkcontrast 的 `--wr-paper` 是半透明，因此所有需要**实底**的面（select 弹层 weread.css:194-205、抽屉 865-876（实色化注释 870-871）、prompt 弹层 1263-1272、菜单 1188-1200、mini-btn 1149-1162、batch-bar 1521-1538、import-bar 2360-2376、drop-hint 2349-2357）统一改用 `var(--panel-solid)`（来自 tokens.css）。

### 1.5 EPUB iframe 内的第三份主题色（关键：改版必须三处同步）

iframe 无法继承宿主 CSS 变量，`src\reader\epub\reader.ts:206-213` 硬编码 `THEME_STYLES`：light `fg:#16181a`；sepia `fg:rgba(38,29,18,0.9)`；green `fg:#223325`；gray `fg:#2b2b28`；dark `paper:#11151b + fg:rgba(255,255,255,0.92)`（不透明纸面）；darkcontrast `paper:#050505 + fg:#f5f5f5`。注释（204-205）明言与 tokens.css / weread.css `[data-theme]` 手工同步。生效路径：`registerThemes()` 向 epubjs `rendition.themes.register` 注册六套规则（body 类作用域，reader.ts:280-332），`setTheme()` 调 `rendition.themes.select(theme)`（reader.ts:509-512）；HostPage 每次主题变化重调 `ctrl.setTheme(theme)`（ReaderPage.tsx:466）。即：**宿主纸面色由 CSS 变量驱动，iframe 正文色由 reader.ts 常量驱动，两处加上 tokens.css/weread.css 共 3 处色值副本**。

---

## 2. 背景功能

### 2.1 背景类型

`ReaderBackground = { type: "preset" } | { type: "image"; path: string }`（src\reader\settings\types.ts:7）。**只有两态：preset（默认底色）/ image（单张自定义图）**，没有纯色自定义、没有"毛玻璃背景类型"。normalize 见 normalize.ts:24-41（字符串会 JSON.parse，非法回 preset）。

- 图片安装：`saveReaderBackground` 后端固定覆写 `library/bg/bg.<ext>`（invoke.ts:185-187；同路径覆写语义 appBackground.ts:7、SettingsPanel.tsx:35）。
- 单槽 objectURL 缓存：全应用同时至多驻留一张，壳与阅读纸面共用（appBackground.ts:4-45）。`resetBackgroundCache()`（8-13）在换图/清缓存后显式失效；`getCachedBackgroundUrl()`（16-18）供跨路由重挂首帧命中；`subscribeBackground/notifyBackgroundChanged`（23-32）换背景广播。测试覆盖见 appBackground.test.ts:21-59。
- 存储：DB settings 键 **`reader_bg`**，JSON 字符串（ReaderPage.tsx:729）。

### 2.2 背景在两处的应用方式

1. **壳（书架/收藏页）**：AppShell 根元素 `.wr-shell` 内联 `backgroundImage = color-mix(in srgb, var(--wr-bg) 88%, transparent) 双层渐变 + url(bg)`，cover 居中（AppShell.tsx:173-179）——半透明主题色纱保证六主题对比度，`--wr-bg` 底色仍兜底。启动时 `getSettings()` 解析 `reader_bg` 并订阅广播（AppShell.tsx:98-116）。
2. **EPUB 阅读纸面**：`.wr-reader-paper` 内联 `backgroundImage: url(bg)` + cover（ReaderPage.tsx:1377-1381），其上叠 `.wr-reader-bg-veil`——实色 `var(--wr-bg)`、opacity 0.88 的定影纱，防止亮图透底破坏正文对比（weread.css:744-752，注释说明 dark 半透明纸面会漏亮图）。纸面本体默认色是 `var(--wr-reader-paper-bg)` 渐变（weread.css:728-738）。
3. **漫画/PDF 不吃背景图**：视觉书 `setBgUrl(null)`（ReaderPage.tsx:484-487），stage 直接 `var(--wr-bg)`（weread.css:1785-1795）。

### 2.3 毛玻璃在哪

毛玻璃不是背景类型，而是**阅读器顶/底栏的呈现方式**（B13 玻璃栏）：`.wr-reader-topbar`（weread.css:757-766）与 `.wr-reader-footer`（768-777）为 absolute overlay，`backdrop-filter: blur(16px)` + `linear-gradient(to bottom/top, transparent, var(--wr-chrome-bg) 22%)` 渐入 + 1px hairline。全项目 backdrop-filter 仅这两处（grep 全 src 只有 weread.css:764、775）。面板 `.wr-panel`/`.wr-card` 只用半透明渐变（--wr-panel-bg/--wr-paper）**无 blur**。壳侧栏/顶栏无毛玻璃。

### 2.4 背景的设置 UI 与清理

- 调整入口在**阅读设置抽屉**："全局背景"行，`选择图片`（png/jpg/jpeg/webp）/ `恢复默认` / 104x32 缩略预览（SettingsPanel.tsx:273-308，pickBackground 25-42）。
- 应用级"设置"对话框可清理 `bg` 类别（恢复默认底色）：占用行（SettingsDialog.tsx:163-167）与一键清理勾选（234-246），清后 `resetBackgroundCache() + notifyBackgroundChanged()`（62-65）。

---

## 3. 阅读器设置项全集

### 3.1 EPUB：SettingsPanel.tsx（src\reader\components\SettingsPanel.tsx）

数据流：ReaderPage state `settings: ReaderSettings` ← 启动 `getSettings()` 回填（ReaderPage.tsx:246-278）→ 面板 onChange 即改 state 并 `persistSettings` 逐键写 DB（720-731）→ effect 推给 epubjs controller（464-477）。

| UI 项 | 设置键（ReaderSettings / DB） | 取值 | 默认 | 生效组件/路径 |
|---|---|---|---|---|
| 阅读模式（左右翻页/上下滚动） | `readingMode` | `paginated` \| `scrolled` | `paginated` | SettingsPanel.tsx:85-104；`ctrl.setReadingMode`（ReaderPage.tsx:479-481；reader.ts 冷启动统一 paginated 再切 259-270）；scrolled 下翻页动画/速度/版式禁用（218、246、258） |
| 主题（六色块） | **应用级 `theme`**（不在 ReaderSettings，types.ts:12） | 6 值 | `light` | `setTheme`（SettingsPanel.tsx:121）→ html[data-theme] + iframe themes.select（见 §1） |
| 字号 | `fontSizePercent` | 80–200，step 5（SettingsPanel.tsx:140-141）；读取时钳 80-200（ReaderPage.tsx:259-261） | 120（defaults.ts:4） | `ctrl.setFontSizePercent` → `rendition.themes.fontSize("N%")`（ReaderPage.tsx:467；reader.ts:514-515、334） |
| 行距 | `lineHeight` | 1.5–2.2，step 0.1（SettingsPanel.tsx:155-163）；normalize 钳 1.5-2.2 一位小数（normalize.ts:68-72） | 1.9 | 重新 registerThemes 注入 iframe body/p 的 line-height（reader.ts:315、325-328；ReaderPage.tsx:520） |
| 正文字体 | `fontFamily` | `default`\|`songti`\|`heiti`\|`kaiti`\|`fangsong`\|`custom`（types.ts:6；normalize.ts:5-8） | `default` | 下拉（SettingsPanel.tsx:168-192）→ FONT_STACKS 六套字体栈进 iframe（reader.ts:216-223、316、327；ReaderPage.tsx:525）。"悦读（回退宋体）"=思源宋优先栈（reader.ts:217） |
| 自定义字体安装/恢复 | `reader_font`（JSON） | `{type:"preset"}` \| `{type:"custom",path}`（types.ts:8-9） | preset | pickFont/restoreFont（SettingsPanel.tsx:44-77、193-207）；`applyReaderFont` 注入 `@font-face "wr-custom"` 单槽 `<style>`（readerFont.ts:17-31）；`saveReaderFont/deleteReaderFont` 后端单槽 library/fonts/font.<ext>（invoke.ts:190-196） |
| 翻页动画 | `pageAnimation` | `none` \| `fade` \| `slide`（normalize.ts:62-66） | `none` | fade=viewer opacity 过渡、slide=渲染容器整页平移，时长按 turnSpeedMs 缩放（ReaderPage.tsx:795-842）；reduced-motion 直翻（786-789） |
| 翻页速度 | `turnSpeedMs` | 150–600ms，step 10（SettingsPanel.tsx:238-249）；normalize 钳 150-600（normalize.ts:75-79） | 260 | epub fade/slide 与漫画滑动过渡共用（ReaderPage.tsx:794-795；ImageReader 收 turnSpeedMs，ReaderPage.tsx:1319；weread.css 250ms 被覆盖，ImageReader.tsx:779） |
| 版式 | `layoutMode` | `auto` \| `single` \| `double`（layoutMode.ts:1、5-9） | `auto` | `resolveSpreadMode`：auto 时容器宽 ≥1200px 双页否则单页（layoutMode.ts:11-15；ReaderPage.tsx:183）；双页加 `--wide` 1100px 纸宽（ReaderPage.tsx:1372-1376；weread.css:740-742） |
| 全局背景 | `reader_bg`（JSON） | preset \| image | preset | 见 §2.2 |

### 3.2 EPUB 正文配色的生效（"主题色"问题）

阅读器**没有独立于应用主题的正文配色**：正文色 = 应用主题在 iframe 的镜像（reader.ts:206-213），切换走 `setTheme` 同一条链。用户可调的只有"六选一"，不能自定义任意色。高亮黄是独立硬编码：`HIGHLIGHT_COLOR="#ffe600"`（src\reader\settings\defaults.ts:15，写 DB 的 highlight.color，ReaderPage.tsx:1284、1506），选区/epubjs-hl 底色 `rgba(255,230,0,0.35)`（reader.ts:335-338）。

### 3.3 漫画/PDF：ImageSettingsPanel.tsx（视觉书独立设置，勿漏）

存 DB 键 **`image_reader_settings` / `pdf_reader_settings`**（各一 JSON，ReaderPage.tsx:193-194、1093；pdf 缺失时继承 image 一次，272-273）。类型/默认在 src\reader\image\layout.ts:6-28（fit="height"、layout="single"、rtl=false 等）。面板项（ImageSettingsPanel.tsx）：阅读模式 paged/webtoon（48-56）、适配 height/width/original（63-72）、单双页（74-82）、阅读方向 ltr/rtl（84-92）、翻页动画 none/slide（94-102）、条漫/滚动宽度 40–100% 滑杆+62/75/92 档（104-127）、自动滚动速度 20–240px/s（129-148）、主题六色块（150-170）。PDF 时单双页/RTL/翻页动画置灰（39、7-8 注释）。设置面板按书型分流：视觉书走 ImageSettingsPanel，EPUB 走 SettingsPanel（ReaderPage.tsx:1085-1107）。

### 3.4 settings 目录全部文件

`src\reader\settings\`：`types.ts`（全部类型）、`defaults.ts`（defaultSettings + HIGHLIGHT_COLOR）、`normalize.ts`（七个 normalize 函数，全部非法值回默认）、`layoutMode.ts`（LayoutMode/SpreadMode/resolveSpreadMode ≥1200 阈值）、对应测试 `normalize.test.ts`、`layoutMode.test.ts`。

---

## 4. 应用级设置全集（SettingsDialog.tsx，src\ui\SettingsDialog.tsx）

入口：壳侧栏底部"设置"按钮（AppShell.tsx:243-246）。对话框内容（**没有任何主题/外观项**）：

| 分组 | 项 | 事实 |
|---|---|---|
| 存储 | 书库位置 + `迁移书库…` | `migrateLibraryRoot`，复制式，删旧库二次确认（76-110；invoke.ts:244-250） |
| 存储 | 封面重提取 | `reextractAllCovers` 为存量 EPUB 重提最高清封面（112-131；invoke.ts:209-211） |
| 存储 | 占用行×5 + 清理按钮 | books（不可清）、covers（可清，清后封面失效+重拷首页）、**bg（阅读背景图，可清，恢复默认底色）**、db（不可清）、logs（可清）（144-171；可清类别注释 invoke.ts:255） |
| 存储 | 一键清理 | 勾选 covers/bg/logs 批量 `clearCache`（229-265） |
| 数据 | 回收站保留期 | **只读展示**：`trash_retention_days`（读取 45；标签 7/30/0=永不，行 12），修改入口在回收站页（`setTrashRetentionDays` invoke.ts:117-119） |
| 关于 | 版本 / 数据库路径 | `getVersion`、`stats.db_path`（48-51、273-283） |
| 快捷键 | 阅读/书库两张静态表 | 纯文案常量（15-33、285-309） |

**DB settings 键全量清单**（前端实际读写的全部键）：`theme`（theme.ts:52）、`fontSizePercent`、`pageAnimation`、`turnSpeedMs`、`layoutMode`、`lineHeight`、`fontFamily`、`readingMode`、`reader_bg`、`reader_font`（ReaderPage.tsx:722-730）、`image_reader_settings`、`pdf_reader_settings`（ReaderPage.tsx:1093）、`trash_retention_days`（SettingsDialog.tsx:45）。读写通道：`getSettings()/setSetting(key,value)`（invoke.ts:177-183），值一律字符串（对象 JSON.stringify）。

---

## 5. 与 M2「碳墨刊头」改版的冲突点清单

### 5.1 用户可调、改版必须保留的可调性

1. **六主题切换**（html[data-theme] 驱动 tokens.css + weread.css 全套变量 + reader.ts iframe 镜像）——M2 的"纸白底×碳墨"只能作为 light 主题的新值或新主题，不能砍掉 data-theme 机制；dark/sepia/green/gray/darkcontrast 五套必须继续可用（theme.ts:25-32；tokens.css:15-69；weread.css:48-161；reader.ts:206-213）。
2. **全局背景图**（preset/image 两态）：壳底+EPUB 纸面两处叠加，含 color-mix 纱与 0.88 定影纱（AppShell.tsx:173-179；ReaderPage.tsx:1377-1383；weread.css:745-752）。M2 若改纸面/纱的透明度策略，须保证"亮图上正文 AA"这条既有约束。
3. **毛玻璃顶/底栏**：`--wr-chrome-bg`（0.6 透明）+ `backdrop-filter: blur(16px)`，仅阅读器两栏（weread.css:757-777）。用户原版观感的一部分，M2 刊头若盖顶栏需决定保留/替换此玻璃语言。
4. 字号 80–200%、行距 1.5–2.2、六字体栈 + 自定义字体单槽、翻页动画/速度、版式（≥1200px 双页）、阅读模式、漫画/PDF 全套视觉设置（§3）。

### 5.2 硬编码色（改版可自由重定义，但注意同步点）

- accent 家族**随主题但不可由用户调**：light/green/gray 绿 #1aad19、sepia 棕 #b45309、dark/darkcontrast #28c76f 等（weread.css:18-24、60-66、88-93、109-115、128-133、147-153）。
- `THEME_SWATCHES` 六色块展示色（theme.ts:8-16）——若改六主题底色，此表要跟着改。
- iframe `THEME_STYLES` 六套 paper/fg/inkRgb（reader.ts:206-213）——**同一主题的色值存在 tokens.css、weread.css、reader.ts 三份手工同步副本**，M2 効定新色时是最容易漏的一处。
- 高亮黄 #ffe600 与选区黄 rgba(255,230,0,0.35)（defaults.ts:15；reader.ts:335-338）；danger #d93025/#ff6b5e（weread.css:25-26、65-66）；封面标题白字（weread.css:33-34）；壳/阅读根的两枚 accent 径向光斑（weread.css:171-172、682-683）——M2"纸白底×碳墨单墨"若要收掉光斑，这两处是源头。
- 定影纱 opacity 0.88（weread.css:749）、壳纱 color-mix 88%（AppShell.tsx:175）。

### 5.3 小窗/窄窗现状（用户关心的"排版是否考虑小窗"已有部分处理）

- 壳栅格 270px 侧栏 + 1fr 主区（weread.css:163-174）；`@media (max-width:900px)` 侧栏收 210px/gap12（2573-2596）、`@media (max-width:640px)` 收 156px、隐藏状态 pill、详情页单列（2598-2629）。
- 顶栏 `grid-template-rows: auto 1fr` + `.wr-main-topbar` flex-wrap（weread.css:462-478）；段控 `.wr-seg` 允许换行（518-527）；工具行/筛选行 wrap（1339-1346、2111-2117）。
- 阅读器：layoutMode auto 的 1200px 双页阈值（layoutMode.ts:14）、边缘翻页热区比例随宽度分档 ≥1400/≥1100/其余（ReaderPage.tsx:184）；纸面 `min(760px,100%)`、双页 `min(1100px,100%)`（weread.css:731、741）。
- 尚无的：无 <640px 以下侧栏折叠/抽屉化方案，无阅读器窄窗单栏阈值以外的专属布局。

### 5.4 其它改版注意

- 大量 UI 已依赖 `var(--panel-solid)` 作实底（select 弹层/抽屉/菜单/气泡等，weread.css:194-205、871、1269、1197 等）——M2 改 token 时 `--panel-solid` 六主题都要有值，否则夜间弹层透底。
- `.wr-btn-primary` 实底用 `rgb(var(--wr-accent-deep-rgb))`，选择器特异度有历史坑注释（weread.css:637-646）。
- 主题首帧依赖 localStorage（theme.ts:18-21），改主题键名/存储格式需考虑旧值迁移（normalizeTheme 未知值回 light，normalize.ts:10-16）。
