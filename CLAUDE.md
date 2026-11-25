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
```

网络规则（本机实测）：cargo/npm/gh API 直连（unset 代理）；git push 直连失败用 `HTTPS_PROXY=http://127.0.0.1:7897` 重试；NSIS 下载与 GitHub 网页走代理。中文路径下 gh 的 glob 参数会炸（"no matches found"），换 ASCII 路径。PS 5.1 原生传参会吞参数里的英文双引号（git -m / gh --jq 都会炸——双引号内容换中文引号或不用）；gh run list 的 displayTitle 是提交信息，tag 触发的 run 按 headBranch==tag 过滤。

## 发布流程（tag 触发 CI 云构建）

版本三处 bump：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`，然后 `cargo check` 锁 Cargo.lock → push main → `git tag vX.Y.Z && git push origin vX.Y.Z` → CI 自动出 NSIS 挂 Release。发布文档四件：CHANGELOG / release-notes / README 版本段 / 开发计划（`docs/开发计划-v*.md` 是每个版本的需求与批次账本，新版本需求往最新一份里加）。

**CI 完成后必做（不可跳过）**：
1. 写 `docs/release-notes-vX.Y.Z.md`（格式参照 `docs/release-notes-v3.1.0.md`：分区标题+条目列表+中文）——**不要用简陋一行文字**
2. `gh release edit vX.Y.Z --notes-file docs/release-notes-vX.Y.Z.md` 附上完整 release notes
3. `gh release view vX.Y.Z` 验证 assets（setup.exe + .sig + latest.json 三件齐全）
4. 需要给用户本地测试时：`gh release download` → 拷贝安装包到桌面 → 手机通知（ntfy PowerShell curl）

## 架构大图

**双进程壳**：React 前端（WebView2）↔ Rust 后端（全部 IO/重活），边界 = `#[tauri::command]`。前端 invoke 封装集中在 `src/tauri/invoke.ts` 与 `src/tauri/wenku8.ts`（契约层：改 Rust 命令签名必须同步 TS wrapper，多 agent 并行时先冻结契约再各自实现）。

**路由与壳（v3.0 批次8 重构，勿回退）**：`src/app/router.tsx` 的 `AppLayout` 是**唯一常驻 AppShell 实例**（侧栏/底栏零重挂载根治切页闪烁）；三个内容页（LibraryPage 含回收站视图、FavoritesPage、CloudShelfPage）不自带壳，通过 `src/ui/pageMeta.ts` 模块级 store（useSyncExternalStore）在 useLayoutEffect 里注册本页元信息（title/search/quickFilter/contextRow）。ReaderPage 在壳外独立路由。

**侧栏动作**：底部四钮（刷新/导入漫画/导入图书/设置）写死在 AppShell；刷新走 `src/ui/appActions.ts` 事件总线（各页订阅自消化），导入走 `src/ui/importService.ts`（落架目标=模块级当前书架）。`sidebarActions` 动态注册机制已删——不要再引入按页注册底栏的方案。

**数据层**：SQLite（`src-tauri/src/db/`，启动跑 migrations：ensure_book_columns 等加列模式），WAL。settings 表 = key/value（get_settings/set_setting 命令）。书籍关联 wenku8 用 `books.wenku8_aid`/`wenku8_last_cid` 两列做去重/新章检测。

**导入管线**：`import_book`（library.rs）是所有书籍入库唯一路径——EPUB/PDF 复制入库、TXT 转 epub（`txt.rs` txt_to_epub，内嵌清洗后标题+作者）、请求封面（cover_bytes_base64）兜底、v2.9 标题清洗管线（metadata_clean.rs 八步）。wenku8 下载（wenku8.rs）拼 TXT 后也走它。

**wenku8 协议**（wenku8.rs，全部实测）：POST `https://wenku8-relay.mewx.org/` 根路径，body `&appver=<magic>&request=<b64(action)>&timetoken=<ms>`（开头有 &，b64 不 urlencode）；appver = `1.29-digital-bento-` + hex(HMAC-SHA256(key="digital-bento", msg="1.29|digital-bento|"+minute))[12..20]，minute=epoch_ms/60000，按分钟缓存。会话 cookie 存 settings（wenku8.cookie/user/pass），errcode "4" 自动重登。reqwest blocking 必须跑专用 std::thread（async 线程内死锁，update.rs 先例）+ `.no_proxy()`（系统代理会劫持）。`endpoint()` 常量是切直连备胎（app.wenku8.com/api.php）留的口。

**阅读器三管线**：`src/reader/` 下 epub（epub.js，hook 挂 rendition.hooks 非 spine.hooks）/ image（漫画）/ pdf（pdf.js）各自独立设置记忆。epubjs 坑：toc href 带 #anchor 而 relocated 不带——比较前两侧剥 hash。

## 设计系统（碳墨）

全部手搓，**无 UI 组件库**（3.2 计划引入 Radix 类 headless 基座，勿整库替换）。token 在 `src/ui/weread.css`（--wr-*/--m2-* 两套变量浅深主题，八主题）。**弹层/对话框设计基准 = 书库右键详情弹层**（用户钦定）；弹层一律 body 级 Portal + fixed 视口定位（父层 overflow 裁不到内嵌弹层）；下拉自绘（原生 select 弹层做不了主题）。README 截图必须中性内容（用户书库隐私），裁掉侧栏或匿名化。

## 测试与验收

前端 vitest（jsdom 文件级 `// @vitest-environment jsdom` 指令，全局仍是 node 环境）。dev 应用 CDP 实测：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" npm run tauri dev`，然后零依赖 Node22 脚本（WebSocket）驱动——**Playwright page.goto 会整页重载重置 SPA 状态，持久化类验证必须走应用内导航（点侧栏按钮）**。多开 dev 实例会留 WebView2 僵尸进程占数据目录（0x8007139F 崩溃），杀 msedgewebview2 进程重启。

## 已知陷阱（历史教训，改动前先查）

- **v3.1 系列（3.1.0→3.1.7）安装版字体/布局/插图全坏的根因 = CSP nonce（已解，v3.1.8）**：tauri.conf.json 配置任何 csp，Tauri 构建时都会往 style-src 自动追加 nonce；CSP 规范规定 source list 含 nonce/hash 时 'unsafe-inline' 一律失效 → epub.js 全部动态 `<style>` 注入被拦（主题/字体栈/排版/adjustImages 缩放/书内嵌字体/blob 样式表）→ sheet 恒 null——即此前误判为"themes.select 时序"的 null sheet。iframe 是 about:srcdoc，继承 tauri.localhost 的 CSP。**dev 不注入 CSP，所以 dev 永远正常——本 bug 连错 6 版就是因为一直在 dev 验证**。修复=整体移除 csp（回到 v3.0.1 已知良好状态；CSP 本是为放行内联 boot 脚本才引入的）。**不要再给本应用配 csp**；排查安装版问题的唯一可信手段=`temp/cdp-inspect.mjs` 式 CDP 取证（安装版带 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port` 启动）
- **epub.js themes.select() 必须在首章 display() 完成后调用，且每次 rendered（章节切换重建 iframe）后重新调用**：display 前 iframe 不存在 → sheet null。reader.ts 已如此实现，不要回退

- **Vite 生产构建 minify 疑似破坏 epub.js（未复验——当时症状实为 CSP 根因）**：minify 已锁 false 在 vite.config.ts，保守起见**不要改回 true**
- **regex 清 CSS 极危险**：grep 关键词可能误删同名前缀类（如清理 V-4 窄窗时误删 Drawer CSS 含 'drawer' 关键词）——删除前必须逐条核实每个命中行
- **tauri-plugin-window-state 默认恢复 decorated:true**：必须排除 DECORATIONS flag 否则无边框被覆盖出双标题栏
- **快速连按翻页必须 clearTimeout 抢占**：残留定时器会在下一帧醒来强制设 opacity:0 造成闪烁

- 改 `src-tauri/icons/` **不会**触发 build.rs 重嵌图标——touch `build.rs` 强制重跑，否则 exe/NSIS 图标停在旧版（窗口左上角是运行时读的所以会假性"已更新"）
- `tauri.conf.json` 的 `bundle.windows.nsis` 段是 deny_unknown_fields：非法键（如 headerIcon，合法的是 installerIcon/uninstallerIcon/headerImage/installMode/template/languages）会**静默拒绝整段且构建流程 EXIT 假绿**——改完必须 grep 构建日志确认 "Finished 1 bundle"
- Rust 文件历史包袱：GBK 控制台输出乱码是显示问题，诊断用 python -I 落 UTF-8 文件再读
- 前端模块级缓存（books/infoCache/pageMeta/shelfCache）是跨页瞬开的关键，但测试必须用对应 reset*ForTests 清理，否则跨用例泄漏
