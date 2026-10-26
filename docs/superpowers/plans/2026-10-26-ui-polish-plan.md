# 2026-10-26 UI 打磨与功能增强 — 变更记录

对应设计文档：`../specs/2026-10-26-ui-polish-design.md`。约束源：`.claude/skills/frontend-design`（anthropics/skills，MIT）与 `.claude/skills/web-design-guidelines`（vercel-labs/agent-skills，MIT）。前序：同日 `23a43fe` 已提交 27 项审计修复。

## 实施结果（全部完成）

### 区 A — 样式与外壳（23 条）
- tokens.css：三主题（浅/sepia/暗）方向对齐 + 各自 color-scheme；主色通道化 --wr-accent-rgb/--wr-accent-deep-rgb，删除全仓零引用的 --primary*/--danger*/--radius-*/--space-*；字体 token --wr-serif/--wr-sans
- global.css 241→38 行（删除死类与模板残留）；button cursor:pointer / :disabled cursor:default
- weread.css：focus-visible 焦点环统一（token 化 outline）、prefers-reduced-motion 全局降级、自定义滚动条（thumb≥44px、暗色适配）、书卡 hover、z-index token 体系（pager/drawer/selection/overlay/hud）、纸宽 min(760px,100%) + --wide 变体、range accent-color、进度条样式
- AppShell：lang=zh-CN、h1 标题、aria-current、search onSubmit（回车提交）；Drawer：role=dialog/aria-modal/aria-label/关闭钮 autoFocus

### 区 B — 阅读器（20 条）
- PageUp/PageDown 翻页；选区工具条"复制"按钮（成功才显示"已复制"）+ role=toolbar
- 书签自动携带章节标题（RelocatedPayload.href + toc 匹配）；高亮持久化划线原文（addHighlight 既有 note 参数传 s.text）
- 行距设置全链：types/defaults(1.9)/normalize(1.5–2.2 步进 0.1)/SettingsPanel 滑条/reader.ts registerThemes+setLineHeight/set_setting 持久化
- 主题首帧闪烁修复（localStorage wr-theme 惰性初值 + 库值回填触碰守卫）；翻页动画尊重 prefers-reduced-motion；HUD 可见性/提示行/移出 Tab 序
- 三面板（目录/书签/高亮）加载态与空态（行动邀请式文案）；三处删除加 confirm；错误浮层 role=alert；HIGHLIGHT_COLOR 常量收口

### 区 C — 书库/收藏/后端（6 条）
- reading.rs：upsert_reading_state 顺带 UPDATE books.last_opened_at（"最近阅读优先"排序自此生效；测试镜像存在但为 shortcut 镜像，见代码注释）
- list_books LEFT JOIN reading_state 返回 reading_percent（Book 前后端类型同步，6 处构造点补齐，JOIN 镜像测试断言 Some(0.25)）
- LibraryPage："读到 N%" chip、整卡点击进书（按钮冒泡守卫）、导入 loading 文案、删书确认含书名与连带后果、双空态（无匹配/空书架+导入引导）
- FavoritesPage：quotes 标签搜索回车提交、整卡点击、删除确认、筛选 aria-label、双空态

### 复核与修复（2 复核 agent：correctness=needs-fixes(3 minor)、guidelines=pass(2 minor)）
5 条 minor 已全部修复：行距默认 1.85→1.9 上网格（含 normalize/测试/reader.ts 兜底）、复制反馈成功才显示（顺带删除重复的 onCopy prop）、无效测试镜像加 shortcut 注释、焦点环选择器死代码修正（button.wr-card→.wr-search-input）、两处新增 120ms 动效提到 160ms。
集成点验证通过：AppShell.search.onSubmit 已实现且 FavoritesPage/LibraryPage 用法类型一致；SettingsPanel 滑条与默认 1.9 兼容。

## 明确跳过（理由见设计文档"跳过项"）
全局搜索、"阅读中"导航、沉浸全屏、设置面板重设计、TTS、纸面点阵纹理、触控目标垫高、封面骨架屏、toast 系统、抽屉焦点圈闭/出场动画、面板标题类抽象、高亮色按主题差异化、safe-area。

## 验证状态与清单（重要）
本批与 `23a43fe` 均为**静态自查**（F 盘容量约束，未安装依赖、未编译）。恢复磁盘空间后按序验证：
1. `npm install && npm run test`（vitest 8 文件，normalize/layoutMode/readerSpread/paperStage/metadataRepair/invoke 已同步更新）
2. `npm run build`（tsc + vite）
3. `cd src-tauri && cargo check`
4. 真机冒烟：三主题切换与首帧、行距滑条、复制按钮（成功/失败态）、PageUp/Dn、书签章节标题、高亮原文回显、书库"读到%"chip 与最近优先排序、收藏页回车搜索
已知运行时存疑点：epub.js themes.default 用法与 displayerror 事件（审计期在线核对过源码，低风险）
