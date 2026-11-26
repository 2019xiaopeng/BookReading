# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

BookReading — Windows 桌面全格式阅读器（Tauri 2 + React 19 + Rust + SQLite），支持 EPUB / TXT / 漫画文件夹·CBZ / 图片型 PDF，v3.0 起含 wenku8 云书架（登录拉书入库）。

## 常用命令

```powershell
# 前端（Vite dev server 固定占用 14200 端口）
npm run tauri dev          # 开发调试（唯一正确的启动方式）
npx tsc --noEmit           # TypeScript 检查
npx vitest run             # 前端全量测试
npx vitest run src/pages/LibraryPage.test.ts   # 单文件测试
npx vitest run -t "用例名片段"                  # 按名过滤

# Rust（必须重定向 target 与 unset 代理）
cd src-tauri
CARGO_TARGET_DIR=F:/cargo-target/bookreading HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy= cargo test
CARGO_TARGET_DIR=F:/cargo-target/bookreading HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy= cargo check

# 发布构建（NSIS；cargo 需 unset 代理，NSIS 工具包下载反而需代理 127.0.0.1:7897，一般已缓存）
CARGO_TARGET_DIR=F:/cargo-target/bookreading npm run tauri build
# 产物：$CARGO_TARGET_DIR/release/bundle/nsis/bookreading_<ver>_x64-setup.exe
# 本地构建无 TAURI_SIGNING_PRIVATE_KEY 时 updater 签名步骤 exit 1——NSIS 包已产出，本地装验照用；.sig/latest.json 由 CI 出
# 发版构建一律走 GitHub CI（tag 触发，见「发布流程」），不在本地构建——本机 C / F 盘空间紧张（用户 2026-11-25 裁定）；本地构建只用于安装版取证，且先看 Get-PSDrive C,F
```

网络规则（本机实测，以当次为准——2026-11-26 实测 git push / gh 直连可用、代理的 TLS 握手反而失败，且 Bash 环境里带着 `HTTP(S)_PROXY`，直连时要显式清空）：cargo/npm/gh API 直连（unset 代理）；直连失败再用 `HTTPS_PROXY=http://127.0.0.1:7897` 重试；NSIS 下载与 GitHub 网页走代理。中文路径下 gh 的 glob 参数会炸（"no matches found"），换 ASCII 路径。PS 5.1 原生传参会吞参数里的英文双引号（git -m / gh --jq 都会炸——双引号内容换中文引号或不用）；gh run list 的 displayTitle 是提交信息，tag 触发的 run 按 headBranch==tag 过滤。

## 发布流程（tag 触发 CI 云构建）

版本三处 bump：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`，然后 `cargo check` 锁 Cargo.lock → push main → `git tag vX.Y.Z && git push origin vX.Y.Z` → CI 自动出 NSIS 挂 Release。发布文档四件：CHANGELOG / release-notes / README 版本段 / 开发计划（`docs/开发计划-v*.md` 是每个版本的需求与批次账本，新版本需求往最新一份里加）。

**CI 完成后必做（不可跳过）**：
1. 写 `docs/release-notes-vX.Y.Z.md`（格式参照 `docs/release-notes-v3.1.0.md`：分区标题+条目列表+中文）——**不要用简陋一行文字**
2. `gh release edit vX.Y.Z --notes-file docs/release-notes-vX.Y.Z.md` 附上完整 release notes
3. `gh release view vX.Y.Z` 验证 assets（setup.exe + .sig + latest.json 三件齐全）
4. 需要给用户本地测试时：`gh release download` → 拷贝安装包到桌面 → 手机通知（ntfy PowerShell curl）

## 架构大图

**双进程壳**：React 前端（WebView2）↔ Rust 后端（全部 IO/重活），边界 = `#[tauri::command]`。前端 invoke 封装集中在 `src/tauri/invoke.ts` 与 `src/tauri/wenku8.ts`（契约层：改 Rust 命令签名必须同步 TS wrapper，多 agent 并行时先冻结契约再各自实现）。

**路由与壳（v3.0 批次8 重构，勿回退）**：`src/app/router.tsx` 的 `AppLayout` 是**唯一常驻 AppShell 实例**（侧栏/底栏零重挂载根治切页闪烁）；三个内容页（LibraryPage 含回收站视图、FavoritesPage、CloudShelfPage）不自带壳，通过 `src/ui/pageMeta.ts` 模块级 store（useSyncExternalStore）在 useLayoutEffect 里注册本页元信息（title/search/quickFilter/contextRow）。ReaderPage 在壳外独立路由。**开场动画（v3.2.1 V-3）**：壳在进程内第一次挂载时根节点带 `.wr-shell--intro`——整个壳体 `.wr-shell-body` 作为一体「浮入 + 微缩放」到位，560ms，只改 opacity 与 transform（**不要做侧栏 / 主栏分区错峰**，用户看下来是「分区域显示出来」）；`.wr-shell-body` 上的 `animationend` 之后撤类。**启动画面**：`index.html` 里的静态 `#wr-splash`（图标 + 标题，样式内联、不依赖脚本和样式表），页面一加载就显示，盖住脚本加载期的空白；`AppLayout` 等壳画出第一帧（两帧 rAF）后调 `dismissSplash()`（`src/ui/intro.ts`）让它放大淡出，与壳体浮入交叉。「只播一次」靠 `src/ui/intro.ts` 的模块级 `pending`（渲染时读、挂载后置 false——别改成「读一次就消耗」，StrictMode 开发模式下第二次渲染就成了 false）。侧栏品牌区下方那一行（`.wr-quick-row`）显示的就是本页注册的 quickFilter / contextRow——**新增壳内页面必须注册其中之一，否则那里留一条空白**（用户对这条空白明确提过意见）。

**设置（v3.2 V-3，2026-11-25 落地；形态为用户钦定，勿改回整页路由）**：`src/ui/SettingsDialog.tsx` 是**PyCharm 式居中模态浮窗**——侧栏「设置」钮（AppShell 的 `settings` 状态）打开，浮在当前页上方、不切页，Esc / 点遮罩 / 「关闭」退出；顶部复用刊头大字标题「设 置」，左侧分区目录（WAI-ARIA 标签页）+ 右侧配置面板，只有右面板内部滚动。各分区与通用控件在 `src/settings/`（八分区登记表 `sections.ts`，**加分区先改它**）。**阅读页的设置抽屉（`SettingsPanel` / `ImageSettingsPanel`）是另一套，没动**——设置浮窗改的是全局默认，阅读页抽屉改的是"当前书生效值"（书级覆盖优先）。全局阅读默认 ↔ settings 键的映射在 `src/settings/readerDefaults.ts` 与 `ReaderPage.tsx` 各一份（为了让设置零触碰阅读器代码），**改键必须两处同步**。`.wr-settings-group` 是与 `HealthScanDialog` 共用的小标题类，视觉勿动。同日第一版做过壳内独立路由整页（用户实测后否决：切页让侧栏留白、分区导航抖动），已撤。

**侧栏动作**：底部四钮（刷新/导入漫画/导入图书/设置）写死在 AppShell；刷新走 `src/ui/appActions.ts` 事件总线（各页订阅自消化），导入走 `src/ui/importService.ts`（落架目标=模块级当前书架）。`sidebarActions` 动态注册机制已删——不要再引入按页注册底栏的方案。

**数据层**：SQLite（`src-tauri/src/db/`，启动跑 migrations：ensure_book_columns 等加列模式），WAL。settings 表 = key/value（get_settings/set_setting 命令）。书籍关联 wenku8 用 `books.wenku8_aid`/`wenku8_last_cid` 两列做去重/新章检测。

**导入管线**：`import_book`（library.rs）是所有书籍入库唯一路径——EPUB/PDF 复制入库、TXT 转 epub（`txt.rs` txt_to_epub，内嵌清洗后标题+作者）、请求封面（cover_bytes_base64）兜底、v2.9 标题清洗管线（metadata_clean.rs 八步）。wenku8 下载（wenku8.rs）拼 TXT 后也走它。

**wenku8 协议**（wenku8.rs，全部实测）：POST `https://wenku8-relay.mewx.org/` 根路径，body `&appver=<magic>&request=<b64(action)>&timetoken=<ms>`（开头有 &，b64 不 urlencode）；appver = `1.29-digital-bento-` + hex(HMAC-SHA256(key="digital-bento", msg="1.29|digital-bento|"+minute))[12..20]，minute=epoch_ms/60000，按分钟缓存。会话 cookie 存 settings（wenku8.cookie/user/pass），errcode "4" 自动重登。reqwest blocking 必须跑专用 std::thread（async 线程内死锁，update.rs 先例）+ `.no_proxy()`（系统代理会劫持）。`endpoint()` 常量是切直连备胎（app.wenku8.com/api.php）留的口。

**阅读器三管线**：`src/reader/` 下 epub（epub.js，hook 挂 rendition.hooks 非 spine.hooks）/ image（漫画）/ pdf（pdf.js）各自独立设置记忆。epubjs 坑：toc href 带 #anchor 而 relocated 不带——比较前两侧剥 hash。`src/reader/epub/epubjsPatch.ts` 是给 epub.js 的 `Resources.replacements` 打的对齐补丁（失败项留 null 占位）——**改它先读下面「类级补丁」那条陷阱**。**EPUB 翻页动画（v3.2）= View Transitions 快照双叶**（`src/reader/epub/turnFx.ts`）：叶片 `.wr-reader-leaf`（正文容器 + 页码徽标）是捕获单元，翻页提交走 `ctrl.turn()`、位置上报走 `ctrl.reportTurn()`；**不要改回 GhostView 双 rendition**，四条硬约束见「已知陷阱」。章内「一页」不是独立元素——整章是一张横向多栏长 iframe，翻页只是外层 `.epub-container` 的滚动位置；跨章 epub.js 会**先同步销毁旧 iframe 再建新的**。

## 设计系统（碳墨）

全部手搓，**无 UI 组件库**（3.2 已引入 Radix headless 基座，封装在 `src/ui/radix.tsx`：`Modal / PointMenu / WrSelect / Tooltip`，只取行为层、视觉走碳墨类，勿整库替换）。token 在 `src/ui/weread.css`（--wr-*/--m2-* 两套变量浅深主题，八主题）。**弹层/对话框设计基准 = 书库右键详情弹层**（用户钦定）；弹层一律 body 级 Portal + fixed 视口定位（父层 overflow 裁不到内嵌弹层）；新 UI 的下拉一律 `WrSelect`（原生 select 弹层做不了主题；存量少数原生 select 尚未迁）。**圆角弹窗里的滚动条不能压进圆角**（用户明确要求）：新做的大弹窗照设置浮窗 / 书库体检的骨架——面板自身 `overflow:hidden`，滚动区夹在标题与底栏之间并留内边距，行内不许横向溢出；存量自带滚动的 `.wr-dialog` 靠通用的轨道内缩规则兜着，别删。README 截图必须中性内容（用户书库隐私），裁掉侧栏或匿名化。

## 测试与验收

前端 vitest（jsdom 文件级 `// @vitest-environment jsdom` 指令，全局仍是 node 环境）。dev 应用 CDP 实测：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" npm run tauri dev`，然后零依赖 Node22 脚本（WebSocket）驱动——**Playwright page.goto 会整页重载重置 SPA 状态，持久化类验证必须走应用内导航（点侧栏按钮）**。多开 dev 实例会留 WebView2 僵尸进程占数据目录（0x8007139F 崩溃），杀 msedgewebview2 进程重启。

**布局/视觉验证（不占用用户的 dev 窗口）**：起一个独立无头 Chrome（`chrome --headless=new --remote-debugging-port=9333 --user-data-dir=<F 盘临时目录>`）连 Vite dev server（用户的 dev 开着时直接共用它的 14200），用 `tools/cdp/` 里的零依赖脚本驱动——`cdp-lib.mjs`（连接/eval/视口模拟/截图，截图可裁剪放大看圆角与边缘）、`ipc-shim.mjs`（Tauri IPC 假后端：假数据 + 调用记录）、`verify-settings.mjs`（应用内导航 → 设置浮窗与书库体检：六尺寸 × 八分区截图 + 零溢出断言 + **切分区零位移断言**，可选参数 `only=sectionId sizes=720x480,1350x801`）、`verify-settings-extra.mjs`（深浅主题、Esc / 遮罩关闭）、`inspect-installed.mjs`（安装版取证）、`reopen-images.mjs`（**真实窗口**：同一本书三轮打开，比对插图状态与 blob 数——"第二次打开才坏"类问题的回归）、`verify-turn.mjs` + `verify-turn.page.js` + `make-synth-epub.mjs`（**翻页动画逐帧取证**：合成测试书 → IPC 假后端 → 真实阅读页翻页 → **暂停伪元素动画并定位到指定进度后截图**，确定性逐帧；`only=sheet,cross,rapid,input,end,edge,life,fold,loc,reduced,spread,figures,chrome,legacy,long` 各组含跨章连拍、长书连翻 100 次、连按、过渡期间输入、竖排、老引擎回退、首 / 末页提示（`edge`：合成漫画 / PDF 在页面里现造）、关书收尾（`life`：主题样式表不重复、blob 释放、坏 `.opt` 回落）、进书加载（`load`：拖慢读数字节，拍加载层与正文的交叉淡入，断言纸面尺寸不变）、折页覆盖层底色（`fold`：放慢 rAF 时间戳按角度定格、取像素断言）、长章 relocated 耗时（`loc`）；先 `node tools/cdp/make-synth-epub.mjs`、`node tools/cdp/make-synth-epub.mjs temp/synth-long.epub long`、`node tools/cdp/make-synth-epub.mjs temp/synth-chapter.epub chapter` 各生成一本合成书。**看结果读 `temp/verify-turn.json` 的 `failures`——别用 `| tail` 接管道（会把脚本的退出码吞成 tail 的 0）**。界面改动后先跑前两个并逐张看截图；改翻页动画跑 verify-turn 并逐张看 `temp/turn-shots/SHEET-*.png`。**真实窗口冒烟不碰正式书库**：`npm run dev:isolated`（隔离数据目录；要先停掉占着 14200 的独立 Vite）带 `--remote-debugging-port` 启动 → CDP 里 `invoke("import_book", { req: { source_path, mode: "copy" } })` 导入合成书（请求字段是 snake_case）→ `history.pushState` 进 `/read/<id>` → 用 `Input.dispatchKeyEvent` 发真实按键；测完杀进程，并删 `%APPDATA%\com.root.bookreading.dev` 与 `%LOCALAPPDATA%\com.root.bookreading.dev`。真实后端冒烟 `tools/cdp/smoke-backend.mjs <合成 EPUB>`（隔离 dev 带 9223 启动后跑：入库校验、坏 `.opt` 回落与自愈、三轮开关的插图与 blob、详情页删除是软删；改了 Rust 的入库 / `.opt` / 删除路径后跑）。开场动画：`tools/cdp/verify-intro.mjs`（冷启动进书架、动画一出现就暂停、定位进度截图；断言 ≤600ms、只动 opacity、坐标零位移、只播一次、reduced-motion 不播）+ `tools/cdp/coldstart-burst.mjs`（**真实窗口冷启动连拍**：先后台起它，再带 9223 启动隔离 dev）。界面改动后先跑前两个并逐张看截图。dev 与安装版**共用正式数据目录**，两者不能同时开；`npm run dev:isolated` 的隔离目录在本机尚不存在（=空书库）。**别把用户书名 / 路径写进入库文件**（脚本用命令行参数传）。

## Subagent 协作规则（用户 2026-11-25 定）

- **调研 / 查询 / 纠错类任务**（多文件排查、定位根因、并行核查）优先由 Subagent 分工并行排查；Subagent 只返回精简结论、关键文件路径与依据，**不替主 Agent 擅自发散修改**。
- **实际修改代码、跨模块 / 跨组件联动、守住既有红线**（翻页动画、布局、安全策略等）由主 Agent 统一决策与实施。
- **单一且定位明确的局部修改**由主 Agent 直接完成，不开子任务（省掉不必要的开销与重复读取）。

## 接续与红线（v3.2 期间）

- **新对话接续**：先读 `docs/开发计划-v3.2.md` 的**第九节「3.2.1 施工单」、第十节「施工记录」与第十一节「3.2.2 需求池」**（每条审计发现的结论、三个批次的记录、已知限制、3.2.2 的七项需求都在那里）。最新发布 = **v3.2.1**（2026-11-26）：启动画面 + 开场浮入 + 进书加载动画、首 / 末页轻提示（V-13）、更新安装包清理（V-12）、审计发现逐条处置。**下一步 = v3.2.2**（用户 2026-11-26 定：①–⑧、⑩ 全做，⑨ 挑着做，范围见 `docs/开发计划-v3.2.md` 第十一节）：启动细节优化（开场动画太短、启动时先出空白小窗再变大窗）、换启动画面图标（用户提需求再做）、依赖大版本升级（zip → 9、rusqlite → 0.39）、`long-paper` 偶发空白帧、从仓库移除 `temp/` 里 6 个被跟踪的历史文件、老 WebView2 回退路径的首 / 末页提示、README 截图重拍、`docs/功能清单.md` 补到当前版本、「覆盖」翻页动画的上一页改为逆操作（当前页向右退回去露出上一页；用户明确要求，翻页动画红线仅对这一条放行）；遗留杂项（过时的 `RELEASE_CHECKLIST.md`、`package-lock.json` 根版本、纯文档提交触发 CI、桌面旧安装包、两个旧文件里的测试书名、旧文档去留）见第十一节 ⑨。**再之后 = v3.3**：需求池在 `docs/开发计划-v3.3.md`（从 3.2 计划移来的 V-5 / V-6 / V-7 / V-8 / V-9 / V-10 与延后清单；新的大功能需求往这份里加）。
- **翻页动画（2026-11-25 晚）已改为 View Transitions 快照双叶并打开 `TURN_FX_ENABLED`，用户 2026-11-26 验收通过，随 v3.2.0 发布**。EPUB 处理链 / 展示链的审计发现已在 3.2.1 批次 B 逐条处置（结论见开发计划第九节表格，已知限制见第十节）。**待用户裁定**：`verify-turn` 的 `long-paper` 偶发空白帧（旧态快照里 iframe 是白的；撤回任何改动后同样偶发，翻页动画红线区，未动）。
- **自动识别的产品红线（用户 2026-11-25 原话要点）**：导入新书时的自动识别要直觉、合乎人性，**不要生硬机械的排列，不要强制归类**；任何自动动作都不覆盖用户手动改过的作者 / 书架 / 标签。V-8 规则已获用户确认（作者子架阈值 3、5 个状态标签 已汉化 / 生肉 / 无修正 / DL版 / AI生成、入口两处），**不做**「书架转标签」、作者标签、宣传页过滤、轻小说自动分类。
- **隐私红线**：公开仓库里不得出现个人书籍文件、真实书名、个人书架名（2026-11-25 清理过一次根目录的书）。README 更新用 `beautify-github-readme` skill，截图只用合成书。
- **发布者名称**：`identifier` 是 `com.root.bookreading`，不要改（决定 appdata 目录）；对外显示的发布者 = `bundle.publisher`（v3.2.0 起为 `qcb`，Cargo `authors` 同）。**陷阱（2026-11-26 实锤）：Tauri 的 NSIS 安装器把「上次安装目录」记在 `HKCU\Software\<发布者>\<应用名>` 下，键名含发布者——改发布者会让装在非默认目录的用户升级时换目录、旧快捷方式仍指旧版。不要再直接改 `bundle.publisher`；R0 已结案——用户 2026-11-26 选 b：保留 `qcb` 不修，发版说明带升级说明（见开发计划第九节）。
- **未经用户同意不改翻页动画与阅读器字体 / 主题 / 插图注入逻辑**；翻页矩阵总开关见「已知陷阱」。

## 已知陷阱（历史教训，改动前先查）

- **C 盘空闲骤降先看页面文件（2026-11-26 实锤）**：隔离 dev 应用、无头 Chrome、全量回归同时跑的时候提交内存冲高，`C:\pagefile.sys` 几分钟内涨到 11 GB，`Get-PSDrive C` 一度只剩 0.3 GB；负载落下后它自己缩回去。这几样错开跑，别叠在一起；见到骤降先 `Get-Item C:\pagefile.sys -Force` 看大小，不要急着清用户的东西。
- **A/B 对照两边都要多跑几次**：偶发类问题只给一边跑一遍就下结论错过两次——`long-paper` 空白帧先被判成「本次改动的回归」，给撤回版加跑后才知本来就偶发；`edge`「没有淡出」其实是取证脚本自己取消了淡出动画。下结论前先确认样本够，以及脚本没有反过来干扰被测对象
- **v3.1 系列（3.1.0→3.1.7）安装版字体/布局/插图全坏的根因 = CSP nonce（已解，v3.1.8）**：tauri.conf.json 配置任何 csp，Tauri 构建时都会往 style-src 自动追加 nonce；CSP 规范规定 source list 含 nonce/hash 时 'unsafe-inline' 一律失效 → epub.js 全部动态 `<style>` 注入被拦（主题/字体栈/排版/adjustImages 缩放/书内嵌字体/blob 样式表）→ sheet 恒 null——即此前误判为"themes.select 时序"的 null sheet。iframe 是 about:srcdoc，继承 tauri.localhost 的 CSP。**dev 不注入 CSP，所以 dev 永远正常——本 bug 连错 6 版就是因为一直在 dev 验证**。修复=整体移除 csp（回到 v3.0.1 已知良好状态；CSP 本是为放行内联 boot 脚本才引入的）。**不要再给本应用配 csp**；排查安装版问题的唯一可信手段=`tools/cdp/inspect-installed.mjs` 式 CDP 取证（安装版带 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port` 启动）
- **视觉功能必须看画面验收（2026-11-25 用户明确批评）**：翻页动画批次只做了 DOM 计数烟测（iframe 1→2→1）就报"实证通过"，用户一拉慢速就看出五种效果全一样 + 闪烁。计数/单测只能证明路径走通，证明不了效果正确——动画、布局、主题类改动一律截图逐张过目（设置页这批靠看画面抓到两处单测没覆盖的 bug）。动画批次的已知缺陷与根因见 `docs/开发计划-v3.2.md` V-1 节
- **磁盘空间是硬约束**：书库数据库与设置在 **C 盘**（`%APPDATA%\com.root.bookreading`），C 盘写满时 dev 的 tauri 命令行工具会静默退出（exit 1，窗口成孤儿）、应用存不进进度。本机 C 盘长期接近满（桌面有大文件夹）、F 盘也紧张（`F:\cargo-target\bookreading` debug ≈18GB + release ≈4.5GB）。**动构建前先看 `Get-PSDrive C,F`**；Claude Code 自己的临时目录也在 C 盘，满了会话随时断。清理用户机器上的东西必须先列清单征得同意，只删清单内的
- **任何 cargo / tauri dev 都必须带 `CARGO_TARGET_DIR=F:/cargo-target/bookreading`**：漏了会编到仓库内 `src-tauri/target`（一次落了 10GB 垃圾，且撞 hashbrown rlib 冲突 exit 101）。清理该目录即可
- **Radix Select（`WrSelect`）的选项值不能是空串**：不报错，触发器直接显示成一片空白。设置表里用空串表示"默认/根"的键（如 `wenku8.dest_shelf`），界面上要换成占位值、读写时互换
- **CSS 容器查询量的是内容盒宽度**（扣掉容器自身 padding；滚动容器还要扣预留的滚动条槽）：设置浮窗的右面板 `.wr-settings-pane` 是容器，断点 600（设置行上下堆叠）/ 700（主题九宫格一行九个）。改断点后在分界两侧逐像素实测，别只靠推算
- **EPUB 翻页动画 = View Transitions 快照双叶（v3.2，2026-11-25 落地；`src/reader/epub/turnFx.ts`）**：`document.startViewTransition(提交)` 对叶片拍新旧两张合成器级快照，画法 = `turnKeyframes` 产出的 WAAPI 关键帧。四条硬约束：① **DOM 更新回调里浏览器不产帧、`requestAnimationFrame` 冻结**——回调里只能走 `ctrl.turn()`（直接调 `manager.next/prev` + 同步 settle），不能 `await rendition.next()` 或等 rAF，epub.js 的队列正是 rAF 驱动的；② **动画 `cancel()` 之后它的 `finished` 会换成一个新的、永不 settle 的 Promise**——要先订阅 `finished` 再取消，否则等待方永久挂起（翻页队列整个卡死，连按 80 次必现）；③ 过渡期间点击 / 滚轮全靠 `::view-transition { pointer-events: none }` 才能到达页面，别删这条；④ 被打断的旧动画要 cancel，否则新过渡的 finished 拖到旧动画自然结束。竖排书（纵向分页）只翻不播；需要 Chromium ≥ 111。`TURN_FX_ENABLED=false` 是退路（走 v3.1.8 路径；不支持 View Transitions 的老 WebView2 也自动走它）。原 GhostView 双 rendition 路线已删，不要再引入第二 rendition（原因见 `docs/开发计划-v3.2.md` V-1「方案改定」）；用户明示过未经同意不改翻页动画与阅读器字体 / 主题 / 插图注入逻辑
- **"切换内容时抖动"的通用解法**：容器尺寸固定 + 滚动容器 `scrollbar-gutter: stable`（内容有长有短时滚动条时有时无，可用宽度会跳一个滚动条宽）+ 导航项定高定宽、选中只换色。验证不能只看"没溢出"，要**把切换前后的坐标逐位比对**（`verify-settings.mjs` 的 stable 断言）。注意这条只适用于**内部滚动容器**；根元素 `html` 不要设（见 weread.css 顶部注释：外壳满窗高内部滚动，根元素从不出现滚动条，设了只会在窗口最右留一条 10px 根底色带，还会让居中弹窗偏左 5px）
- **类级（prototype）补丁只对"之后的实例"生效——验收必须覆盖第二次**：`epubjsPatch` 在第一本书 `book.ready` 之后才装到类上，所以同一会话里第一本书永远走原版逻辑、第二本起才走补丁。2026-11-25 实锤：补丁改写 `replacements` 时把 manifest 相对 href 直接传给 `createUrl`（它要求书内绝对路径，内部会去掉首字符当压缩包内文件名查找），第二本书起 100 个资源全部替换失败、插图破损——这个 bug 从 v2.9.0 潜伏了 6 天，因为每次验收都只开第一本书。**给第三方库打补丁：先逐行对照原版做同样的前置处理；测试桩必须仿真真实查找口径**（当时的假 `createUrl` 来者不拒，把 bug 固化成了"通过"）。回归工具 `tools/cdp/reopen-images.mjs`
- **dev 启动后白屏 ≠ 代码问题**：Vite 开发模式逐模块加载，启动瞬间若机器网络变动（网卡 / 代理 / TUN 切换），模块请求成批报 `ERR_NETWORK_CHANGED`，React 根本没挂载（`#root` 为空）。CDP 里 `Page.reload` 一下即可；先用 `tools/cdp/cdp-lib.mjs` 的 `c.logs` 看报错再下结论
- **"操作进行中不许关闭"之类的闸门要在动作开始处同步置位，不要靠 React effect**：effect 要等下一次渲染提交才执行，那个空档里 Esc / 点遮罩能穿透——全量测试负载下才复现（单跑永远过），这类"单跑过、全量偶发挂"的用例是竞态信号，不要重跑放过
- **断言异步回填的值必须包在 `waitFor` 里**：`await findByRole(...)` 只等"元素出现"，控件一挂载就在，紧接着读 `.textContent` / `.value` 读到的是初始值。本机 mock 瞬间 resolve 所以总能过，CI 慢就偶发失败（v3.1.9 首次 CI 构建因此挂掉）。实测扫描：旧写法在后端延迟 ≥10ms 时 0/8 通过，`waitFor` 写法 72/72。写"回填 / 懒加载后的值"的断言时先问一句：这个值是同步就有的吗？不是就 `waitFor`
- **经 CDP 求值的页面侧代码放独立 .js 文件，先 `node --check` 再送进浏览器**：嵌在模板字符串里要做双重转义，正则极易写错且只有浏览器执行时才报错（2026-11-25 一条正则漏了结尾斜杠，来回排查多轮）。范例 `tools/cdp/dryrun-organize.mjs` + `dryrun-organize.page.js`
- **实验 / 诊断脚本给出的"反常结果"先怀疑脚本本身**：同一天两次被自己的工具误导——对照实验漏导入 `expect`，把所有断言错误都记成"新写法失败"；比对脚本按固定长度截取字符串，把源码里缺失的字符"补"了上去。反常时直接看原始字节（`JSON.stringify` / `lastIndexOf` 找终止符），别用推导出来的中间量下结论。同日翻页动画取证又踩四次：总开关没打开就取了三组「效果」（全是渐隐，像素统计一模一样才是破绽）；连拍耗时超过动画本身，之后「定位到中段」拍到的是终态；按键还没发完就判「队列已空闲」；手写 PNG 的块长度写成了含类型字的长度
- **给 weread.css 做多行 Edit 前先确认能匹配**：文件里个别注释行含看不见的异常字符，几十行的 old_string 会整体匹配失败甚至拼坏相邻行（2026-11-25 踩过）。先小块试、或按行号带前置条件校验后拼接；含中文的 PowerShell 脚本不要用 `powershell -File` 跑（无 BOM 会被按 GBK 读坏），用 `[scriptblock]::Create((Get-Content -Raw -Encoding UTF8 …))` 在进程内执行
- **epub.js themes.select() 必须在首章 display() 完成后调用，且每次 rendered（章节切换重建 iframe）后重新调用**：display 前 iframe 不存在 → sheet null。reader.ts 已如此实现，不要回退

- **Vite 生产构建 minify 疑似破坏 epub.js（未复验——当时症状实为 CSP 根因）**：minify 已锁 false 在 vite.config.ts，保守起见**不要改回 true**
- **regex 清 CSS 极危险**：grep 关键词可能误删同名前缀类（如清理 V-4 窄窗时误删 Drawer CSS 含 'drawer' 关键词）——删除前必须逐条核实每个命中行
- **tauri-plugin-window-state 默认恢复 decorated:true**：必须排除 DECORATIONS flag 否则无边框被覆盖出双标题栏
- **快速连按翻页必须 clearTimeout 抢占**：残留定时器会在下一帧醒来强制设 opacity:0 造成闪烁

- 改 `src-tauri/icons/` **不会**触发 build.rs 重嵌图标——touch `build.rs` 强制重跑，否则 exe/NSIS 图标停在旧版（窗口左上角是运行时读的所以会假性"已更新"）
- `tauri.conf.json` 的 `bundle.windows.nsis` 段是 deny_unknown_fields：非法键（如 headerIcon，合法的是 installerIcon/uninstallerIcon/headerImage/installMode/template/languages）会**静默拒绝整段且构建流程 EXIT 假绿**——改完必须 grep 构建日志确认 "Finished 1 bundle"
- Rust 文件历史包袱：GBK 控制台输出乱码是显示问题，诊断用 python -I 落 UTF-8 文件再读
- 前端模块级缓存（books/infoCache/pageMeta/shelfCache）是跨页瞬开的关键，但测试必须用对应 reset*ForTests 清理，否则跨用例泄漏
