你是 BookReading 项目的实施负责人，目标：完成 v2.5.0 全部交付（性能修复 + 功能补齐 + M2「碳墨刊头」UI 改版 + 构建发布）。仓库 F:\bookreading-project，起点 = tag v2.1.0。

【第零步：先问后做（阻塞项，仅剩 2 问）】
读 docs/M2-UI实施规范.md §11：第 1-7 项用户已确认（答案已写在清单里，照办）；第 8（纸墨/墨夜两套主题）与第 9（进度 chip 改墨线）两项未答——开工时原样列出等用户答复；答复前先做与答案无关的部分（性能修复、后端、功能 P0/P1、U1 之外不依赖这两答的施工）。

【需求文档，按序读】
1. docs/BookReading交付文档.md —— 主线：性能根因与修复、P0/P1、验收口径；UI 红线 §6
2. docs/M2-UI实施规范.md —— UI 施工图：8 主题方案（纸墨+墨夜）、逐屏逐类名、token、三档断点（中档含 800）、U1–U7 提交切分、§11 已确认清单
3. docs/design/mono-carbon.html —— 仅气质与 token 参照（含原版没有的元素，布局一律以施工规范为准，禁止照抄）
4. docs/inventory-theme-settings.md 与 docs/inventory-screens.md —— 现状盘点（file:line 已在起点 HEAD 抽查 20/20 命中）；改 UI 前先对照确认真实类名。若实施中盘点与代码不一致：以代码为准，并在同一 commit 修正盘点。

【实施纪律（用户红线，最高优先级）】
- 功能与可调性零丢失：动工前 npm test 记基线（当前应为 20 文件 129 用例全过；不符先查环境再动工）；交付文档 §6.4 的 21 项功能存续清单逐项核验、每个 U commit 附打勾表；八主题+背景图+阅读器全部设置（字号/行距/字体/翻页速度/版式/条漫宽度/自动滚动）改版后逐项拨动验证
- 颜色三副本同步：tokens.css / weread.css / reader.ts THEME_STYLES——新主题（纸墨 ink、墨夜 ink-dark）三处一起加，漏一处即壳变书页不变
- 性能只升不降：先录基线（DevTools Performance：书架滚动 / 300 页条漫翻页 / EPUB 拖字号），UI 改造与根治包完成后各对比一次，回退即返工
- UI 按 §9 的 U1–U7 切 commit，一屏一 commit 可回滚；禁止顺手重构范围外代码；内联样式只迁 §8 列出的位置
- 文档纪律：每阶段落 docs/superpowers/plans/ 批次记录（沿用仓库存量命名式 2026-10-XX-batchN-*.md），docs/CHANGELOG.md 逐批追加

【本机环境（必读，都是踩过的坑）】
- Rust 一切命令先 unset HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 及小写，再 CARGO_TARGET_DIR=C:/cargo-target/bookreading（rsproxy 镜像已在 src-tauri/.cargo/config.toml，无需另配）。禁止无重定向构建——产物会撑爆 F 盘
- gh CLI 在 "C:\Program Files\GitHub CLI\gh.exe"（已登录 2019xiaopeng）；gh 命令必须 unset 代理直连，走代理 graphql 会 EOF
- git push 网络不稳：直连失败换环境代理重试，再失败挂后台每 5 分钟重试
- NSIS 产物在 C:\cargo-target\bookreading\release\bundle\nsis\（约 212MB），不是 src-tauri/target
- npm run dev 端口 14200（UI 截图验收用）；wereed.css 偶发 Select-String -Path 报"不存在"（文件锁假象）——用 Get-Content 管道读；src-tauri/Cargo.toml 常显 M（autocrlf 噪声），git diff 为空即忽略
- 本机已装 F:\bookreading（NSIS 原地升级）；用户数据在 %APPDATA%\com.root.bookreading，任何操作不得触碰

【多 agent 分工（按文件所有权切分，禁止两个 agent 改同一文件）】
- agent A（Rust 后端）：阶段一 async 命令+页列表缓存；阶段二缩略图管线（存量补生成 async+进度事件，禁止同步批量卡 UI）；SQLite WAL+索引；get_book 命令；标注导出
- agent B（UI·书架）：M2 §2 token 层+主题注册（三副本，ink/ink-dark）→ §3 书架页（刊头/工具行图标化/书卡/骨架/空态/回收站行；书卡 hover ⋯ 菜单按 §11.6 收进去）→ §5 断点+minWidth 720
- agent C（UI·其他屏+阅读器外壳）：§4 全部弹窗/抽屉/设置面板外壳 + 收藏页 + 阅读器顶底栏颜色层 + §6 背景与毛玻璃融合（只动颜色层，正文排版零改动）
- agent D（阅读器链路性能）：交付文档阶段一 5/6 + 阶段二 6（滑杆 onCommit、anchor 一行修、开书双渲染、locations 持久化、字体注入修复、章节预取、PdfReader 两个廉价修）
- agent E（功能 P0/P1）：复制正文、漫画方向按书记忆、阅读时长统计、导出、高亮 text 列迁移、全局搜索、字号快捷键、双页偏移、PagesPanel 滚动定位/页码直达；mobi/azw3 先评估，超 3 天降级跳过
- 前端实现统一按 oil-frontend 规范；全部完成后用 oiloil-ui-ux-guide 整体评审并修复其 P0/P1 发现

【UI 每屏验收（截图留证）】
书架/收藏/详情弹窗/标签弹窗/应用设置/阅读器设置/阅读器外壳，每屏 1440/1000/720 三宽度截图（npm run dev），对照 M2 §10：八主题切换壳/弹窗/EPUB 正文三处颜色同步；背景图启停（壳纱/EPUB 纸面/毛玻璃栏）；阅读器设置逐项生效；720 宽无横向滚动且工具行完整；书架滚动帧率 ≥ 基线。截图入 docs/design/shots/ 一并提交。

【构建与发布（前面全部通过后才做）】
1. 版本 2.1.0 → 2.5.0：package.json、src-tauri/tauri.conf.json、src-tauri/Cargo.toml 三处 + cargo check 同步 Cargo.lock
2. npm test 全绿 → unset 代理 + CARGO_TARGET_DIR 重定向后 npm run tauri build，确认 C:\cargo-target\bookreading\release\bundle\nsis\bookreading_2.5.0_x64-setup.exe 生成
3. 用 beautify-github-readme skill 重做 README：新 UI 截图、2.5.0 更新说明按交付文档如实写
4. git 提交推送（commit 信息末尾 Co-Authored-By: Claude Code <noreply@anthropic.com>）→ 打 tag v2.5.0 推送 → gh release create v2.5.0 --title "v2.5.0" --notes-file <发布说明>（unset 代理直连），上传 NSIS 安装包（约 212MB，上传需数分钟勿中断）

【C 盘清理（发布完成后，只清安全项）】
安装包先备份到桌面再上传；删 C:\cargo-target\bookreading（回收约 9GB）；npm cache verify；%TEMP% 里 tauri/wix/claude 残留；~/.cargo/registry 仅在超 2GB 时清且先报占用；pagefile 可能被构建撑到 20GB+——重启即回收，不要手动调页面文件。其余任何删除先列清单问用户。

【遇阻规则】gh 未登录/推送无权限/release 失败/构建报错两轮修不好/发现文档与代码大面积冲突：停下来如实报告，不要绕过或降级发布。