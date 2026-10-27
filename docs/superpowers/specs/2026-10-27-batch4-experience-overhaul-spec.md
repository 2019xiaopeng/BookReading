# 批次4 · 体验大修（batch4-experience-overhaul）

基线 HEAD de34f74（批次1-3 已并入）。Tauri 2 + React 19 + TS 5.8 + epub.js 0.3.93 + rusqlite。
设计基调：微信读书风骨架，向 Apple/Fluent 精致感靠拢——克制层次、150-300ms 微动效、无溢出无换行断裂。

> **诚实声明（必读）**：本 spec 由无代码读取权限的设计会话产出。所有"根因"为基于反馈描述 + epub.js 0.3.93 / Tauri / React 19 已知行为 + 批次1-3 提交记录的推断。每条含【确认点】：实施者动手前必须 Read 对应代码验证，症状与推断不符时以实际代码为准，回到本 spec 修正后再改（硬约束"先 Read 再改"）。所有锚点为 文件+符号/搜索串，非行号。命名说明：记忆中"批次4=PDF 支持"与本文件 batch4-experience-overhaul 仅编号撞名，内容无关。

## 全局约束（所有分区共守）
- ponytail 最小完整变更；删优于增；零新依赖；CRLF；反斜杠编辑 chr(92)+唯一匹配断言。
- 不碰 1.md/电子书/temp/.claude/.git；禁 `npm run tauri dev`、禁 commit/push。
- 门禁：`npm run build` + `npm run test`；Rust（先 unset 全部代理变量）`CARGO_TARGET_DIR=C:/cargo-target/bookreading cargo check --manifest-path src-tauri/Cargo.toml`（+ `cargo test`）。
- 不回退既有行为：进度 flush、locate()、高亮/收藏/笔记去重、图片书分支、六主题 token、背景图纱。
- UI 改动过 .claude/skills/frontend-design 与 web-design-guidelines 规则（focus-visible 可见焦点、aria-label、150-300ms 过渡、prefers-reduced-motion 降级）。

## 一、反馈逐条：根因 → 修复设计

### 反馈1 · 布局溢出/换行断裂（C 区，部分触 A/B 控件）
**症状**：全屏收藏按钮"取消收藏"文字溢出胶囊；侧栏"导入漫画/导入图书"按钮 3+1 字换行；删除按钮超出书卡外框；要求全盘审查 800×600 ↔ 全屏。
**根因（推断+确认点）**：胶囊按钮文字宽度随"收藏/取消收藏"切换变化，容器无 `min-width:0`/`nowrap`，flex 收缩引发换行或溢出。侧栏按钮容器过窄时文字按字换行——未设 `white-space:nowrap` 或未提供图标态降级。书卡删除按钮大概率 `position:absolute` 定位在卡片边缘（负偏移）或卡内无 overflow 约束。【确认点】Read LibraryPage/AppShell 按钮结构与 wereed.css 控件段。
**修复设计**：
1. 通用规则进 wereed.css 控件段（一处声明多处生效）：胶囊类 `white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0`；全屏收藏钮改图标（心形 filled/outline）+aria-label/tooltip，文案仅"收藏/已收藏"两态。侧栏导入按钮 `display:flex; gap:8px; white-space:nowrap`，容器（<220px 或 container query）降为纯图标+aria-label。书卡 `overflow:hidden`，删除等操作收进"更多"菜单（与反馈10b 合并处理，不为删除钮单独打补丁）。
2. 全盘审查清单（800×600 与全屏各过一遍）：AppShell 顶栏/侧栏、书库工具行+分组 chips 行（横向滚动不换行）、书卡网格、收藏页、阅读页顶栏/底栏/HUD、Drawer 各面板、SettingsPanel/ImageSettingsPanel、所有对话框、新的选区气泡/右键菜单/缩略图网格。
3. 断裂防线：单行文本类（作者、进度、chip 文案）nowrap+ellipsis；书名两行 clamp（-webkit-line-clamp:2）；标题类允许 `overflow-wrap:anywhere` 仅长英文/URL 场景。
**涉及**：src/pages/LibraryPage.tsx、src/pages/FavoritesPage.tsx、src/ui/AppShell.tsx、src/styles/wereed.css 控件段。
**验收**：800×600 与全屏三处症状消失，审查清单零溢出零断裂。

### 反馈2 · 封面时序（C 区）
**症状**：打开书库封面不显示，refresh 后才出现；从阅读页返回封面消失。
**根因（推断+确认点）**：useCoverUrls 的 effect 依赖不含实际数据源（books 异步加载晚于 effect 首跑 → 无 URL，refresh 重跑才补）；blob URL 生命周期挂组件 unmount（去阅读页）被 revoke，返回重挂载缓存已失效或不再重发。【确认点】Read src/library/useCoverUrls.ts（或 hooks 目录）：effect 依赖数组、cleanup 是否 revokeObjectURL、缓存位置（组件 state vs 模块级 Map）。
**修复设计**（合同式）：
1. blob URL 缓存提升为模块级 Map<bookId, string>，生命周期与 App 同寿；revoke 仅显式刷新与替换时。
2. effect 依赖=当前列表 books 的 id 集合+每书 cover 可用标志；挂载即对无缓存书发起封面命令请求。
3. 失败重试：每书 attempts≤3、退避 200/400/800ms，计数存 Map，成功清零。
4. 返回恢复：重挂载先同步渲染缓存（瞬间出图），再对 miss 异步补。
**涉及**：src/library/useCoverUrls.ts、调用点 LibraryPage/FavoritesPage（如需传 id 列表）。
**验收**：冷开书库封面即显；进阅读页再返回封面即时恢复不闪空。

### 反馈3 · 主题四连（a=B 区，b/c/d=A 区）
**3a 漫画主题独立旧套**：【确认点】Read src/reader/image/ImageReader.tsx 与 ImageSettingsPanel.tsx 现浅色/护眼实现。修复：ImageReader 根节点挂与 epub 阅读壳相同主题属性（`data-theme={settings.theme}`，tokens.css 六主题变量即生效），内部颜色改引 `var(--paper)/var(--fg)/var(--fg-muted)` 等 token，删除旧两套色与 ImageSettingsPanel 主题选择区；ReaderPage 传参点由 A 改（areaA-A5）。
**3b dark/darkcontrast 正文文字消失**：根因：themes.register 用 `background:"transparent"` 依赖壳底透出，但 epub 自带浅底（body/html/包裹 div 显式背景，或内联样式高于注入规则），dark 下浅字浅底。修复（根治）：主题色值来源单一化——与壳同源六主题 token（ReaderSettings.theme → 现有主题映射的纸面/前景色，与 tokens.css 同值，不得出现第二份颜色表）。dark/darkcontrast 注册规则改不透明背景：`html, body { background: <纸面暗色 token 值> !important; color: <前景 token 值> !important; }`；浅色主题保持 transparent（不回退）。变体：若现状混用 themes.default/override，可等价改 `rendition.themes.override("background", paper, true)` + override("color", fg, true)（0.3.93 override(priority=true) 立即作用于已渲染 contents 且带 !important），二选一以现有代码风格取改动小者。【确认点】Read reader.ts 的 themes.register/default 调用。验收：dark、darkcontrast 下自带浅底 epub 全程可读；浅色四主题无回归。
**3c 行距无感**：根因：line-height 注入选择器只打 body（或未加 important），epub 段落自身 `p.xxx{line-height}` 更具体；且变更后未对已渲染内容重新应用。修复：注入规则改 `"p, body { line-height: <值> !important; }"`；setLineHeight 变更后 `rendition.themes.select(<当前主题名>)` 触发对已渲染 iframe 重新注入（0.3.93 select→apply 遍历当前 contents）。验证步骤写进实现：当前已渲染章节行距即时变化；若 select 不触达，降级=保存 currentCfi→display(currentCfi)（与 3d 同路径）。验收：阅读中拖行距滑杆正文立即重排。
**3d spread 三档切换内容错乱（双栏中间裁切）**：根因：spread 改变列布局度量但未重建已绘制内容，旧绘制残留在新度量中缝。修复：applySpreadMode 统一路径：`currentCfi = rendition.currentLocation()?.start.cfi` → `rendition.spread(mode)` → `rendition.clear()` → `rendition.display(currentCfi)`。单页⇄双页⇄自动三档两两互切（含切回原档）各验证。验收：任意档互切内容完整无中缝裁切，CFI 不丢。

### 反馈4 · scrolled 章节导航（A 区）
修复：flow==="scrolled" 时 prev/next 一律章节导航（滚动模式无分页语义，中途允许直接跨章）：`idx = rendition.currentLocation().start.index`（0.3.93 提供；缺失则从 start.cfi 解析 `/6/<2N>!` 取 N/2）；`goChapter(delta)`：clamp(idx+delta, 0, spine.length-1)，到边界禁用按钮（沿用现有禁用逻辑）；`rendition.display(book.spine.get(nextIdx).href)`。底栏与 HUD 按钮文案 scrolled 态改"上一章/下一章"；键盘 ←→/PageUp/PageDown 同语义；目录不变。【确认点】Read ReaderPage.tsx 现有 prev/next 处理链（footer/HUD/keyboard 三入口收敛到同一 goPrev/goNext 再分流，避免三处各改）。验收：scrolled 三入口均章节导航；章末到底按"下一章"进次章开头；首章无上一章。

### 反馈5 · 选区气泡（A 区）
根因：现 SelectionToolbar 为底部常驻大条，遮挡+手动关闭。重做为锚定选区的小浮动气泡，仅 UI 形态变化，复用现有 onHighlight/onFavorite/onNote 及去重逻辑不动。
定位算法（精确）：
1. `rendition.on("selected", (cfiRange, contents))`：`sel = contents.window.getSelection()`；collapsed/rangeCount=0 → hide；`r = sel.getRangeAt(0).getBoundingClientRect()`（iframe 视口坐标）。
2. 宿主换算：`iframeRect = contents.element.getBoundingClientRect()`（宿主 DOM 中 iframe 节点）；`scaleX = iframeRect.width / contents.window.innerWidth`（scaleY 同理）；`host = { x: iframeRect.left + r.left*scaleX, y: iframeRect.top + r.top*scaleY, w: r.width*scaleX, h: r.height*scaleY }`。
3. 气泡尺寸约 132×36（3×28px 钮+gap+padding，实现后 offsetWidth 实测）；`position:fixed`：优先上方 `top = host.y - h - 8`，`top < 8` 翻下方 `host.y + host.h + 8`；`left = host.x + host.w/2 - w/2` clamp `[8, innerWidth - w - 8]`。
显示/隐藏状态机：隐藏=选区收起、relocated（翻页）、display/跳转、点击气泡外（host document pointerdown + 各 iframe contents.document pointerdown，气泡内不隐藏）、5 秒无操作（timeout，show/reposition/气泡上交互时重置）。z-index 高于 HUD。
内容：三图标钮（高亮/收藏/笔记，各 aria-label），无复制无预览文本，宽度 fit-content 不超内容区。动效：入场 150ms opacity+scale(0.98→1)，prefers-reduced-motion 关闭。【确认点】Read SelectionToolbar.tsx 现有 props/handler，外部接口不变。验收：选中即现于选区上方（贴顶翻下方）；翻页/跳转/外点/5s 自动消失；三功能+去重与旧版等价。

### 反馈6 · 排序双维（C 区）
现单段控扩为两控件：排序键段控（最近阅读/书名/导入时间）+方向钮（升降图标，aria-pressed），或组合段控（取与现有工具行风格一致者）。纯前端 useMemo 排序：lastRead 缺失回退 importedAt；书名 `localeCompare(zh)`；默认=现状（最近阅读降序）不变。持久化沿用现有设置存储，无则仅会话态（最小）。【确认点】Read LibraryPage.tsx 现有排序段控与列表组装。验收：六种组合生效；默认进入与现状一致。

### 反馈7 · 进度条（A 区）
**7a 可拖动**：locations 就绪（现有 locationsReady 标志）后进度条容器升级 pointer 交互（`role="slider"`，aria-valuemin/max/now，键盘 ←→ ±1%）：
- `pointerdown`：setPointerCapture，draggingRef=true（期间抑制 relocated 持久化）。
- `pointermove`：`p = clamp((clientX - trackRect.left)/trackRect.width, 0, 0.999)`，仅更新视觉 thumb+章节提示（当前 p 所在章名，可选），**不 display**（epub.js 高频 display 抖动大；设计决策：拖到松手跳转）。
- `pointerup`：`cfi = rendition.locations.cfiFromPercentage(p)` → `display(cfi)`；松手后首个 relocated 恢复持久化。
- 点击=零位移拖动，同路径覆盖。拖动能力随 locationsReady 一同激活。
**7b 超时不丢弃**：现状 `locations.generate(1024)` 30s 超时整会话放弃。修复：超时不置终态，降级 interval 4096 后台重试一次（仍 30s 上限）；成功→走现有 flush/locate 路径补发一次当前进度+激活进度条与拖动；再超时维持禁用态（attempts 上限 2，不无限循环）。【确认点】Read reader.ts/ReaderPage.tsx generate 超时与取消逻辑。验收：拖动跳转准、拖动中不写库；大书 30s 后后台重试成功即出进度。

### 反馈8 · 收藏页导航统一（C 区）
移除 FavoritesPage 底部"返回书架刷新"按钮及 onClick/样式，无残留引用；返回仅靠左侧导航。刷新去留：保留挂载时+window focus 时静默刷新（返回即新数据）。【确认点】Read FavoritesPage.tsx 按钮与刷新函数。验收：按钮消失；侧栏返回后数据新鲜。

### 反馈9 · 漫画体验（B 区）
**9a 缩略图页目录**：Drawer（image 书时）新增"页面"面板：`grid-template-columns: repeat(auto-fill, minmax(72px, 1fr))`；IntersectionObserver（rootMargin 200px）进入视口才 `readImagePage(page)`；取数先查 ImageReader 现有页面缓存（缓存/取数 getter 提为模块级或 prop 传入，命中当前±2 不重复拉全本）；当前页高亮（accent 2px outline）；点击→跳页（复用现有 setPage）。
**9b 滑动翻页动画**：DOM：舞台 relative+overflow:hidden，两层绝对定位 `<img class="page-layer">`（out/in）。切页：旧 src 留 out 层，新 src 置 in 层；**新图 onLoad（或 decode() 完成）后才启动动画**（否则保持旧页，杜绝白屏）→ out 层 `translateX(∓100%)`、in 层从 `±100%` 归 0，`transition: transform 250ms cubic-bezier(0.2,0,0,1)`；transitionend 清空 out 层。方向：next=旧页向左出，RTL 取反；prefers-reduced-motion 直接切换无过渡。
**9c 缓存**：±2 预载已有不扩窗口——动画只在下一张已解码后启动即命中；连续快翻 10 页无白屏验证。【确认点】Read ImageReader.tsx 现有翻页/setPage/预载实现。验收：缩略图懒加载流畅、点图跳页正确；翻页 250ms 滑动、RTL 反向、减动效关闭、快翻无白屏。

### 反馈10 · 书架管理重做（C 区 + Rust）
**10a 重命名**：Rust（src-tauri/src/commands/library.rs）`update_book_metadata` 增 `title: Option<String>`：`if let Some(t) = title { let t = t.trim().to_string(); if t.is_empty() { return Err("标题不能为空".into()); } /* UPDATE books SET title = ?1 WHERE id = ?2 */ }`；其余字段行为不变，错误/返回风格与现有一致；models.rs 仅必要时同步（title 已在表与模型，预计零改）。前端 invoke 传 title+乐观更新列表；阅读页顶栏标题在进阅读页时读取即同步（阅读中改名非场景，不做事件同步）。
**10b 卡片重做**：卡片仅显 书名（两行 clamp）、作者+进度单行小字（12px muted nowrap+ellipsis，hover title tooltip）、进度 chip 保留。hover（及键盘 focus）浮出右上角两枚小图标钮：置顶、更多（opacity 0→1 150ms）。"更多"菜单：重命名/设置分组/备注/删除（删除沿用既有确认文案与流程）。三常驻 chip 取消；备注不再常驻卡面。
**10c 分组可视化**：书库空白处 `contextmenu`（target===网格容器非卡片）：preventDefault 弹上下文菜单（新建分组/导入图书/导入漫画/排序切换），坐标 clamp 视口内。分组 chips 行（书库顶部横向滚动 nowrap）：全部 | 未分组 | 各分组；chip 右键：重命名/删除（删除将组内书 group 置空，不删书）。拖拽入组（HTML5 DnD 零依赖）：卡片 `dragstart` → `dataTransfer.setData("text/book-id", id)`、effectAllowed="move"；chip `dragover` preventDefault+.drop-target 高亮；`drop` → 调既有分组命令（现三 chip 已有"分组"功能，复用其 set_group/update 命令；【确认点】若无组表，chips 由 books distinct group 派生，新建/改名/删除作用于 books.group 值，最小实现）。全部新控件：focus-visible 焦点环、aria（menu/menuitem）、150-300ms 过渡。
**验收**：重命名同步书卡+阅读页顶栏；空串被拒；右键菜单四项可用；拖卡到 chip 移动即时反映；删除分组保书。

### 旧账两笔（A 区）
1. **SettingsPanel 色块钮 inline 样式抑制焦点/hover**：去 inline boxShadow/transition 改 CSS 类：`.swatch-btn{transition:...}` `:hover{transform:translateY(-1px)}` `:focus-visible{outline:2px solid var(--accent);outline-offset:2px}` `[data-selected]{box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--accent)}`（token 名以 tokens.css 实名为准）。
2. **背景图双 objectURL**：面板预览与阅读页共用同一模块级缓存 URL getter（同 useCoverUrls 思路；替换/退出才 revoke）；面板 `<img>` 或 CSS 引用同一 URL，不再各自 createObjectURL。
【确认点】Read SettingsPanel.tsx 两处 URL 创建与 inline 样式。

## 二、任务分解（按文件所有权）
**A（epub 阅读域）**：src/pages/ReaderPage.tsx、src/reader/epub/**、src/reader/components/{SelectionToolbar,SettingsPanel,BookmarksPanel,HighlightsPanel,SearchPanel}.tsx、src/reader/settings/** → 反馈 3b/3c/3d/4/5/7 + 旧账两笔 + ImageReader 主题传参点（仅改传参）。
**B（漫画域）**：src/reader/image/** → 反馈 3a/9（token 化、缩略图面板、滑动动画、共享缓存 getter）。
**C（书库/壳/样式/Rust）**：src/pages/{LibraryPage,FavoritesPage}.tsx、src/ui/**、src/styles/**、src/library/**、src-tauri/** → 反馈 1/2/6/8/10 + rename 命令。
A/B/C 可并行；唯一交界：ReaderPage 内 ImageReader 的 props（A 改调用点，B 改组件内部）；若 ImageSettings 类型在 A 的 src/reader/settings/**，B 先停止引用、A 后清字段（顺序：B 先改组件，A 后清类型）。
**建议实施序**（每步过门禁）：C1 反馈2（封面）→ C2 反馈10a（Rust+前端）→ A1 反馈3b/3c（同函数一次过）→ A2 反馈3d → A3 反馈7 → A4 反馈4 → A5 反馈5 → A6 旧账 → B1 反馈3a → B2 反馈9b/9c → B3 反馈9a → C3 反馈1+10b/10c（卡片重做合并溢出修复）→ C4 反馈6/8 → 全局审美 pass。

## 三、审美 pass 清单（C 主责，A/B 自查域内控件）
- 动效令牌：快 150ms / 常规 200ms / 位移 250ms；全部过 prefers-reduced-motion。
- 图标钮：28×28（HUD/底栏 32×32），radius 8px，hover `--surface-2`，active `scale(.97)`，focus-visible 2px accent 环+2px offset，必带 aria-label。
- 书卡：hover `translateY(-2px)`+柔和阴影 200ms；操作钮浮现 150ms；书名 2 行 clamp。
- chips/菜单/气泡：nowrap；菜单 radius 10px、阴影 `0 8px 24px rgba(0,0,0,.14)`+1px surface-3 描边；入场 150ms opacity+scale(.98→1)。
- 进度 slider：命中区 ≥12px，thumb 12px（拖动 16px）accent 圆点。
- 缩略图网格：radius 6px，当前页 accent 2px outline。
- 密度：控件间距走 4/8/12 节奏，不加新间距值。

## 四、验收要点
1. 门禁全绿（build/test/cargo check/test，零新依赖）。
2. 10 条反馈逐条按上文"验收"行手测通过；800×600 与全屏双尺寸过审查清单。
3. 回归不丢：进度 flush、locate()、去重、图片书分支、六主题、背景图纱。
4. 每条修复落地前完成对应【确认点】Read 验证（与 spec 推断不符处先改 spec 再改码）。

## 五、跳过项
- 进度条拖动中的实时 display（scrub 渲染）：跳过，拖动仅视觉+松手跳转（epub.js 高频 display 抖动）。
- locations 第三档降级（8192）与缩略图专用 Rust 端 downscale 命令：跳过；若 4096 仍超时或缩略图实测卡顿再升级。
- 阅读页打开状态下书库改名的实时顶栏同步：跳过（进阅读页读取即正确）。
- 收藏页移除按钮后的手动刷新替代入口：跳过（挂载/focus 刷新覆盖）。

## 六、A 区实施勘误（2026-10-27，以实测为准）
- 3b：epubjs 0.3.93 `Contents` 无 `element` 属性，iframe 宿主矩形取 `contents.window.frameElement.getBoundingClientRect()`；主题规则须按 `body.<theme>` 类作用域注册（`themes.select` 靠 body class 切换，非作用域规则会在多主题样式表共存时后者压死前者）；dark/darkcontrast 用注册规则注入不透明背景（而非 themes.override），`registerRules` 为整体替换、`select` 对已渲染内容为追加式重注入，新规则靠靠后位置+`!important` 生效。
- 3c：行距无感的另一根因是 ReaderPage 每次设置变更都会重调 setLineHeight/setSpreadMode，已加"值未变即跳过"幂等守卫。
- 3d：`rendition.flow()` 内部自带 clear+display，spread 切换补 clear+display(currentCfi) 即可。
- 7b：`locations.generate` 共享内部 Queue，超时重试须换新 `Locations` 实例（`book.locations` 重新赋值）避免重复追加。
