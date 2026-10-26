# 2026-10-26 UI 打磨与补缺设计（ui-polish）

## 1. 背景

HEAD=23a43fe 之后，四路审计（样式/外壳、阅读器、书库/后端、a11y 复核）对现有"微信读书风"实现提出了约 50 条发现。本 spec 做三件事：去重归类、按 ponytail 原则过滤（值得做 / 不值得做）、给出文件级分区任务。只做工艺打磨与补缺，不推翻重设计、不改配色基调、不换字体体系；不引入任何新依赖；不跑任何构建（F 盘容量约束，改动仅静态自查）。

设计源头：temp/weread-prototype.html 与 docs/superpowers/specs/2026-05-04-weread-ui-redesign-design.md（2.3 卡片即"继续阅读"、3.2 纸宽 680-820px、4.3 选区操作含"复制"）。

## 2. 约束源

- web-design-guidelines（Vercel 规则集，.claude/skills/web-design-guidelines/SKILL.md）：可交互元素 cursor:pointer、键盘可达与可见 focus-visible、禁用态 cursor:default、prefers-reduced-motion、暗色 color-scheme、WCAG AA 对比度、空态/加载态、语义 HTML 与 aria、表单 Enter 提交、错误用文本说明。
- frontend-design（Anthropic 工艺，.claude/skills/frontend-design/SKILL.md）：大胆只花一处其余克制；动效少而准、非用户触发的动效克制；排版不超过两族字体；空态=行动邀请、错误=哪里错+怎么修；按钮动词句首、全流程同名；不加无人需要的装饰性结构。
- ponytail（会话方法论）：最小完整变更、删优于增、复用现有 helper/组件/token、保持 wr- 前缀与 CSS 变量惯例。

## 3. 问题清单（去重后，按区）

### 区A 样式/外壳
- index.html lang="en" + 脚手架 title（读屏发音、窗口标题）。
- 全仓库零 color-scheme 声明（dark 下滚动条/原生控件发白）；tokens.css 与 weread.css 默认主题方向相反（:root 一暗一浅，挂载前明暗错配）。
- global.css 约 165 行死代码（.app-*/.btn-*/.tabs/.tab/.muted）+ button 基类 backdrop-filter 与蓝色 hover 泄漏进 wr 皮肤（目录/搜索卡 hover 闪蓝边）；.btn-primary 对比度 1.67:1（critical，命中阅读器错误浮层）。
- 主色 rgba(26,173,25,*) 硬编码约 20 处，sepia 下绿琥珀两套强调色同屏；.wr-small-btn.wr-primary 与 .wr-btn-primary 两条规则体重复；亮色主按钮白字对比 2.87:1；亮色 --wr-muted 4.06:1。
- focus-visible 只盖 btn/select/input/textarea 且强度不足（<3:1）；nav/seg/small-btn/card 无焦点环；cursor:not-allowed 两处。
- 零 prefers-reduced-motion（CSS 侧 + ReaderPage JS 翻页动画）。
- 字体身份丢失（无 font-family 声明，封面字母非衬线）；纸宽全宽失控（设计文档 3.2 为"必须"）；书卡丢失整卡 hover/点击；目录/搜索行误用重卡片；底部进度条缺失（设计文档 2.3）。
- z-index 魔数、字重 780/750 混用、radius/shadow 离档、sepia topbar 覆盖不对称、搜索图标是 CSS 画的占位方块、选区条无入场过渡、range 无 accent-color、滚动条未定制。
- 外壳 a11y：搜索框/分段按钮/导航无程序化名称或状态、主标题非 h1、抽屉无 dialog 语义。

### 区B 阅读器
- 无 PageUp/PageDown；选区条缺"复制"；书签不带章节标题；高亮不存划线原文（note 列闲置）；无行距设置（reader.ts line-height 硬编码 1.85）；主题首帧闪白（useState 默认 light，getSettings 异步返回后才切）。
- 沉浸 HUD 隐藏时按钮仍在 Tab 序；翻页动画不响应 reduced-motion；错误浮层无 role="alert"、复制无反馈、按钮用旧 .btn-primary。
- 空态全是"暂无X"陈述句且贴在网格一角；书签/标注/收藏先闪假空态；打开书无加载态；搜索初始即"暂无结果"；删除书签/标注/收藏句无确认（用户笔记误触即丢）；翻页热区 w/e-resize 光标语义误导；#ffe600 魔法串两处。

### 区C 书库/后端
- upsert_reading_state 不更新 books.last_opened_at（排序字段长期为 NULL，靠 added_at 兜底）；list_books 不带阅读进度（卡片无从显示"读到xx%"）。
- 书架空态文案指错位置（"右上角"实为左下角）且不区分"无书/无结果"；导入中无文案；删书 confirm 不说明连带后果；收藏页双搜索入口语义漂移（顶栏在句子 tab 按 Enter 无动作）；收藏句删除无确认；筛选 select 无标签。

## 4. 分区任务（文件级）

实施顺序建议 A → C → B（C 的收藏页 Enter 提交依赖 A 的 AppShell.onSubmit；三区文件互不重叠：A=index.html/tokens.css/global.css/weread.css/AppShell.tsx/Drawer.tsx，B=ReaderPage.tsx/reader 组件/reader.ts/settings 链，C=LibraryPage/FavoritesPage/invoke.ts/src-tauri）。行号为 HEAD 23a43fe 基准。

### 区A（23 条，详见结构化 plan areaA）
index.html 语言与标题；tokens.css 主题方向对调+color-scheme+无引用变量删除；weread.css 三主题 color-scheme；global.css 瘦身（删约 165 行）；--wr-accent-rgb/--wr-accent-deep-rgb 通道化并删 4 个冗余 dark 块；主按钮规则合并与加深（AA）；焦点环统一加强（并入 nav/seg/small-btn/card/toc-item）；禁用 cursor:default；reduced-motion 块；--wr-serif/--wr-sans 字体身份；纸宽 min(760px,100%) 与 --wide 变体；书卡整卡 hover；.wr-toc-item 轻量行；滚动条（thumb≥44px 可拖、暗色）；选区条入场；range accent-color；z 层 token；.wr-progress 样式；muted/textarea/seg 阴影/wr-title/sepia topbar 小修正；AppShell 图标换 IconSearch+a11y+h1+search.onSubmit；Drawer dialog 语义。

### 区B（20 条，详见 areaB）
PageUp/PageDown；选区条复制+已复制反馈+toolbar 语义；书签带章节标题（RelocatedPayload.href + toc 匹配）；高亮存 s.text；行距设置全链（types/defaults/normalize+test/SettingsPanel/reader.ts registerThemes 重构+setLineHeight/ReaderPage 读取与应用与持久化）；主题首帧（localStorage 初值+库为准同步+触碰守卫）；reduced-motion JS 短路；HUD visibility；HUD 提示行；错误浮层 role=alert+wr 按钮类+已复制反馈+z token；底部进度条结构；目录/搜索行换 .wr-toc-item；空态文案行动邀请；书加载态+三面板 annotationsLoaded gate；三处删除 confirm；热区光标 pointer；HIGHLIGHT_COLOR 常量；纸宽条件类+热区 z token；SettingsPanel 四个 aria-label；搜索 searched 假空态修正+role=status。

### 区C（6 条，详见 areaC）
reading.rs upsert 顺带 UPDATE books.last_opened_at（测试镜像）；models.Book.reading_percent + fetch_books LEFT JOIN + 全部 Book 字面量补字段 + 测试断言 + invoke.ts 类型 + LibraryPage "读到xx%"徽标（复用 wr-chip）；LibraryPage 整卡点击/导入中文案/删书 confirm 后果说明/空态区分与位置修正；FavoritesPage 空态区分/删除 confirm/筛选 aria-label/顶栏 Enter 提交接线/整卡点击。

### 受影响测试
- normalize.test.ts：补 normalizeLineHeight 用例（B5）。
- src-tauri reading.rs tests：upsert_reading_state_overwrites 镜像 last_opened_at UPDATE 并断言（C1）。
- src-tauri library.rs tests：两处 Book 字面量补字段，insert_and_fetch_books 补进度断言（C2）；favorites.rs 测试字面量补字段（C2）。
- invoke.test.ts：无签名变化，无需改（已核对 mock 断言）。

## 5. 跳过项与理由

- 全局搜索、"阅读中"导航、沉浸全屏、设置面板重设计、TTS：菜单预筛排除，仅记录。
- 纸面点阵纹理：epub.js 的 iframe 覆满纸面会盖住 ::before 纹理，要可见必须改容器结构，违反最小变更；纸宽收敛保留。
- 触控目标≥44px 硬性补足：桌面鼠标/键盘场景，现有主要控件 36-50px，不垫高。
- 封面骨架屏/图片懒加载：封面容器 64x92 固定无 CLS，本地文件即时加载，字母兜底已占位。
- toast/全局 aria-live：无既有基建；错误浮层 role="alert"+行内"已复制"已覆盖现存场景。
- Drawer 完整焦点圈闭/关闭焦点回归：Esc 与遮罩点击已是退出路径，只补 role/aria-modal/autoFocus。
- 抽屉关闭出场动画：不对称属实，收益低于成本。
- .wr-panel-title 字重类收敛：跨 5 文件换类不值得 diff，仅 .wr-title 780→750。
- 高亮色按主题差异化：既定视觉统一 #ffe600，仅抽常量。
- tokens.css 只留 body 变量：错误浮层仍用 --border/--panel-solid/--shadow-sm/--text-muted，只删确认无引用的 --primary/--danger/--radius-*/--space-*。
- safe-area、hover-only 内容审计：桌面固定窗口；现状无 hover-only 内容。

## 6. 验收要点

- lang/title 正确；夜间主题下滚动条、select 下拉、range 滑杆为暗色渲染；首帧不再闪白（暗色主题重开书验证）。
- 键盘 Tab 全控件可见统一焦点环；HUD 隐藏时 Tab 不会落入不可见按钮；抽屉被读屏识别为对话框。
- 系统开启"减少动态效果"后：抽屉/HUD/翻页/hover 位移全部静止。
- sepia 主题全屏无绿色强调元素；亮色主按钮白字对比≥4.5:1；12px 辅助文字对比≥4.5:1。
- PageUp/PageDown 翻页且页面不滚动；选中文字可一键复制并有"已复制"反馈；书签名显示章节标题；高亮在标注面板显示原文；行距滑条即时生效且重启保留。
- 书架卡片整卡可点继续阅读；卡片显示"读到xx%"；最近打开的书排前（last_opened_at 生效）；删除类操作均有 confirm；空态文案为行动邀请且与"无结果"区分。
- 静态自查：grep 确认 rgba(26,173,25, 与 .app- 与 btn-primary 零残留；*.test.ts 与实现一致（无法运行，靠人工比对）。
