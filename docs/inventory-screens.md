# BookReading 逐屏结构现状盘点（M2「碳墨刊头」改版前置事实）

盘点范围：F:\BookReading-project（Tauri2 + React19 + react-router-dom），只读，未改任何文件。
所有行号以当前工作区文件为准。样式主文件为 `src/ui/weread.css`（2629 行，全部 wr-* 类都在这一个文件里），主题 token 在 `src/styles/tokens.css`（--panel-solid 六主题映射）与 weread.css 的 `[data-theme=*]` 段。

---

## 1. 路由与屏清单

### 1.1 路由（src/app/router.tsx:7-11）

| 路径 | 组件 | 文件 |
|---|---|---|
| `/` | LibraryPage | src/pages/LibraryPage.tsx:85 |
| `/read/:bookId` | ReaderPage | src/pages/ReaderPage.tsx:96 |
| `/favorites` | FavoritesPage | src/pages/FavoritesPage.tsx:11 |

App 根（src/App.tsx:63-68）= `<RouterProvider>` + `<DialogHost />`。DialogHost 是模块级单例命令式对话框（showAlert/showConfirm/showChoice，src/ui/dialog.tsx:25-56），渲染在两壳之外。

每个页面各自渲染一个 `AppShell`（src/ui/AppShell.tsx:60-76），props：`active`（library/favorites/reader 三态高亮）、`title`、`search`、`seg`（段控）、`sidebarFooter`、`children`。书架树是模块级单例缓存（AppShell.tsx:18-58），路由切换不重挂。

### 1.2 书库页 LibraryPage（含回收站视图，`?trash=1` / `?shelf=id` 走 URL，LibraryPage.tsx:123-127）

顶栏（AppShell 提供，AppShell.tsx:251-299）：
- 搜索框 `wr-search > wr-search-input`（LibraryPage.tsx:980 传入）
- 主题色钮 `wr-btn wr-icon-btn`（IconPalette，AppShell.tsx:288-298）→ 弹出 `wr-menu` 六色块 `wr-swatch-btn`（AppShell.tsx:303-328）

侧栏底部 sidebarFooter（LibraryPage.tsx:981-996），三个 `wr-small-btn`（图标+文字）：
- 刷新（IconRefresh）
- 导入漫画 `wr-primary`（IconImage，导入中变文案"导入中…"）
- 导入图书 `wr-primary`（IconBook）
另加 AppShell 自带"设置"钮（AppShell.tsx:243-246）→ SettingsDialog。

工具行 `wr-toolbar-row`（非回收站，LibraryPage.tsx:1029-1081）——**全是文字钮 `wr-seg-btn`**：
- 排序段控 `wr-seg`：最近阅读 / 书名 / 导入时间 / 自定义（"拖动卡片调整顺序"）/ ↑升序↓降序（1031-1056）
- 批量选择段控：选择（1058-1067）
- 密度段控（`marginLeft:auto`）：标准 / 宽松 / 特大（1068-1080）

筛选行 `wr-filter-row`（1085-1092）——**全文字钮**：
- TagFilterMenu：`wr-btn` 触发"标签 ▾"→ `wr-tag-pop` 复选列表（TagDialogs.tsx:47-114）
- StatusFilterMenu：`wr-btn` "全部状态 ▾" → `wr-tag-pop`（StatusFilterMenu.tsx:44-77）
- 管理标签 `wr-btn` → ManageTagsDialog

面包屑行 `wr-group-row`（1095-1120）：`wr-group-chip`（全部 / 各级书架，可作拖放目标）。

网格区 `wr-book-grid`（1167-1175）：空白右键 → `wr-menu` 网格菜单（新建书架/导入图书/导入漫画/批量导入漫画/设置全局背景/恢复默认背景/排序方向，1414-1437）。

回收站视图工具行（999-1027）：返回书架（`wr-btn` 文字钮）、保留期 label + `wr-select`、清空回收站（`wr-btn wr-btn-danger` 图标+文字）。列表 `wr-trash-list > wr-trash-row`（1132-1152，封面/信息/恢复/彻底删除按钮）。

弹窗挂载点（都在 AppShell children 内、页面级 state 控制）：
- 右键/更多菜单 `wr-menu`（1412-1498；grid/book/shelf 三种）
- 移动到书架树选择 `wr-prompt-overlay > wr-panel wr-prompt wr-move-dialog > wr-shelf-tree`（1500-1533）
- 输入 prompt（重命名/备注/新建书架）`wr-prompt-overlay > wr-panel wr-prompt`（1535-1576）
- BookDetailsDialog `wr-prompt wr-dialog`（1577-1585；组件 src/library/BookDetailsDialog.tsx:167-326）
- BatchTagDialog（1587-1604）、ManageTagsDialog（1606-1608，均为 wr-prompt/wr-dialog 体系，TagDialogs.tsx:117-335）
- 批量操作浮动条 `wr-batch-bar`（1370-1392：已选 N / 移动到书架 / 收藏 / 打标签 / 删除 / 全选 / 取消，全 `wr-btn` 文字钮）
- 拖拽 ghost `wr-drag-ghost`（1394-1410）

空态 `wr-state`（1344-1366：无匹配/空书架/空书库三套文案；回收站空态 1156-1164）。

**重要：书库页没有"网格/列表视图切换"。** 工具行的段控是排序/选择/密度；AppShell 的 `seg` prop 只有 FavoritesPage 用。除回收站行式列表外不存在列表视图。

### 1.3 收藏页 FavoritesPage

- AppShell seg：收藏书籍 / 收藏句子（FavoritesPage.tsx:89-98）
- books tab：`wr-book-grid > wr-book-card`（101-153），卡内多 `wr-actions`（打开 `wr-btn-primary` / 收藏 `wr-btn`，133-150），无 card-tools、无选择模式
- quotes tab：工具行 `wr-toolbar-row`（书籍筛选 `wr-select` + 搜索 `wr-btn-primary`，178-205）+ `wr-quote-list > wr-card wr-quote-card`（226-263，底部 `wr-quote-foot` 定位/删除 `wr-mini-btn` 图标钮）
- 空态 wr-state 两处（155-172、207-223）

### 1.4 全局弹窗/抽屉组件

- Drawer（src/ui/Drawer.tsx:6-30）：`wr-drawer-overlay > wr-panel wr-drawer > wr-drawer-head + wr-drawer-content`，仅阅读器用
- DialogHost（src/ui/dialog.tsx:75-114）：`wr-prompt-overlay > wr-panel wr-prompt`（title/body/actions）
- SettingsDialog（src/ui/SettingsDialog.tsx:173-189 起）：`wr-prompt wr-dialog`，内部 `wr-settings-group/wr-settings-row/wr-settings-label/wr-settings-value`（css 2249-2333）

---

## 2. AppShell 布局骨架

DOM（AppShell.tsx:181-301）：

```
div.wr-shell (style: 全局背景图时 backgroundImage 双层纱)   ← 100vh grid 270px 1fr
├─ div.wr-panel.wr-side        ← 侧栏（弹性列）
│  ├─ .wr-side-top  (.wr-brand 名+副题, .wr-pill "本地库"状态)
│  ├─ .wr-nav       (书架/收藏/回收站 wr-nav-btn + .wr-nav-groups 树形 wr-nav-group-btn)
│  └─ .wr-side-bottom (sidebarFooter 三导入钮 + 设置钮, margin-top:auto)
├─ div.wr-panel.wr-main        ← grid-template-rows: auto 1fr
│  ├─ .wr-main-topbar          ← 搜索/标题 + seg + 主题钮，flex-wrap, min-height 62px
│  └─ div[style: minHeight:0, overflow:auto]  ← 页面级滚动容器（AppShell.tsx:300）
├─ 主题菜单 wr-menu / 拖放 overlay wr-drop-overlay / 导入进度条 wr-import-bar
└─ SettingsDialog
```

关键样式：
- `.wr-shell`：height 100vh、grid 270px 1fr、gap 18、padding 18、overflow hidden，底为双 radial 光斑 + `--wr-bg`（weread.css:163-174）。全局背景图时 AppShell 内联覆盖 backgroundImage（88% 主题纱 + url cover，AppShell.tsx:173-179）。
- `.wr-main`：`grid-template-rows: auto 1fr`（批次11b 改 auto，窄窗顶栏换行时长高不裁切，weread.css:462-468）。
- **双层滚动声明**：AppShell.tsx:300 的 div 是真正的滚动容器（children 全在里面，含工具行/筛选行/面包屑）；`.wr-book-grid` 自身也有 `overflow:auto; min-height:0`（weread.css:927-934），但它在高度不受限的父容器里高度随内容增长，实际滚动发生在 AppShell.tsx:300 那层。回收站的 `.wr-trash-list` 同理（weread.css:1553-1560）。
- 弹层定位：菜单 `position:fixed`（wr-menu, css:1188）、prompt `position:fixed`（wr-prompt-overlay, css:1253-1261）、批量条 fixed 底部居中（css:1521-1538）。

---

## 3. 书卡 DOM 结构与类名

普通书卡（LibraryPage.tsx:1241-1341）：

```
div.wr-book-card [role=button, data-drop=book, data-book-id, data-selected, data-dragging, data-pop]
├─ (选择模式) button.wr-select-check          ← 左上 22px 复选
├─ div.wr-cover                                ← 64px, aspect-ratio 2/3
│  ├─ img (object-fit:cover)
│  └─ (无封面) div.wr-cover-text > .wr-cover-title + .wr-cover-author   ← 白字叠渐变底
├─ div.wr-meta
│  ├─ div.wr-title        (2 行 -webkit-line-clamp)
│  ├─ div.wr-author       (单行省略；title 属性带 作者·进度)
│  └─ (有进度) div.wr-chip-row > div.wr-chip > span.wr-live-dot + "读到 N%"
└─ (非选择模式) div.wr-card-tools [data-show=置顶]  ← absolute 右上, hover 显现
   ├─ button.wr-mini-btn (IconPin 置顶)
   └─ button.wr-mini-btn (IconMore 更多 → wr-menu)
```

基础样式：`.wr-book-card` grid 64px 1fr、padding 12、圆角 lg、纸底+卡影、hover 上浮 2px（weread.css:968-998）；`.wr-cover` 渐变兜底为 accent 双光斑（weread.css:1000-1017）。hover 时标题让位右上工具钮（`.wr-title` padding-right 68px，:has 限定，css:1075-1082）。

书架卡（LibraryPage.tsx:1199-1239）：`wr-book-card wr-shelf-card`（**wr-shelf-card 无独立 CSS 规则**，仅 JS 标识）：
- `.wr-cover > .wr-shelf-grid` 四宫格（前 4 张已就绪封面，2×2 grid、3px 缝、内描边+底部内阴影，weread.css:1350-1373）
- 超 4 本 `.wr-shelf-badge` "+N" 右下徽标（css:1376-1388）
- `.wr-meta > .wr-title 书架名 + .wr-author "N 本"`

新建书架卡（1177-1197）：`wr-book-card wr-shelf-create` 虚线卡、min-height 132、常驻网格第一格（css:1390-1409）。

密度差异见 §7。**没有列表视图差异**——唯一行式列表是回收站 `.wr-trash-row`（40px 小封面 + 信息 + 操作钮，css:1552-1624）。

拖拽态类/属性：`.drop-target`（程序加删）、`data-dragging`（35% 透明+虚线）、`data-pop`（弹入动画）、body.`wr-card-dragging`（css:1411-1489）。

---

## 4. 响应式现状

### 4.1 断点：只有两个尺寸断点，均为"压缩"而非"改布局"

- `@media (max-width: 900px)`（weread.css:2573-2596）：侧栏 270→210px、gap/padding 18→12、各行 padding 收紧。
- `@media (max-width: 640px)`（weread.css:2598-2629）：侧栏 210→156px、gap/padding→10、`.wr-pill` 隐藏、`.wr-details` 详情弹窗转单列（封面缩 128px）。
- 其余全部 `@media` 是 `prefers-reduced-motion`（313、1213、1758、1913、1933）。**无任何 `@supports`**。

### 4.2 窗口尺寸（src-tauri/tauri.conf.json:12-19）

`windows: [{ title, width: 800, height: 600 }]` —— **无 minWidth/minHeight/maxWidth**，窗口可缩至任意小。初始 800px 宽即命中 900px 断点分支（侧栏 210px）。`resizable` 未设（默认 true）。

### 4.3 useElementSize（src/ui/useElementSize.ts:3-50）

clientWidth/Height + ResizeObserver + window resize，rAF 节流。只用在两处：
- ReaderPage.tsx:144 `viewerRef` → viewerWidth/viewerHeight（**书库/收藏页完全不用**，纯 CSS auto-fill）
- PdfReader.tsx:94 `stageRef`

viewerWidth 派生的 JS 断点（阅读器内）：
- 双栏判定：`resolveSpreadMode`，auto 模式 `containerWidth >= 1200` 才 always（src/reader/settings/layoutMode.ts:11-15）
- 边缘翻页区比例：viewerWidth ≥1400 → 0.2，≥1100 → 0.18，否则 0.16（ReaderPage.tsx:184）；实际宽度经 `calcPaperStage` 钳在 120–220px（src/reader/ui/paperStage.ts:11-14）

### 4.4 小窗时的实际行为（现状策略 = "换行 + 收紧"，无折叠/隐藏侧栏、无图标化）

- `.wr-main-topbar` flex-wrap（css:476）；`.wr-seg` 内部 flex-wrap 成两排（css:520-522）；`.wr-toolbar-row`/`.wr-filter-row` wrap（css:1339-1346、2111-2117）；`.wr-batch-bar` wrap + max-width calc(100vw-32px)（css:1527-1532）
- 书网格 `repeat(auto-fill, minmax(220px,1fr))`：小窗自然降到 1 列；密度三档 minmax 320/420 时更早单列
- 侧栏最窄 156px 仍显示"书架/收藏/回收站"完整两行 nav-btn（图标+标题+副题文字），无汉堡/抽屉化
- 批次11b 注释明确该决策："窄窗下顶栏控件换行时栏随长，不裁切"（css:464）、"段控内按钮允许换行成两排，胶囊不被压扁"（css:520）

---

## 5. 阅读器外壳结构（ReaderPage.tsx:977-1762）

```
div.wr-reader-root [data-theme]              ← 100vh flex column, 双 radial 光斑底 (css:675-685)
├─ (非锁定) div.wr-topbar.wr-reader-topbar    ← absolute top 玻璃条 z16 (css:757-766)
│   返回书库(wr-btn 纯文字) · 书名 · [epub] 目录/书签/标注/收藏/搜索 (wr-btn wr-icon-btn=图标+文字)
│   · [视觉书] 收藏/书签/页面 · 设置 · 锁定 · 百分比(muted)
├─ div.wr-reader-stage [data-locked][data-image]   ← padding 62/62 固定预留 (css:687-696)
│  └─ div.wr-reader-viewer
│     ├─ Drawer (右抽屉, 见下)
│     ├─ div.wr-reader-paper-wrap [(--wr-paper-image padding:0)] (css:718-726)
│     │  ├─ ImageReader / PdfReader (视觉书, 各自 wr-image-* 类)
│     │  └─ div.wr-reader-paper[(--wide 1100px)]   ← 760px 纸面, 可叠背景图+wr-reader-bg-veil (css:728-752)
│     ├─ 边缘翻页热区 (absolute inset:18, 内联样式, ReaderPage.tsx:1430-1484)
│     ├─ SelectionToolbar (wr-selection-bubble, 划选气泡)
│     └─ 错误浮层 (内联 scrim + wr-card wr-state-error)
├─ (非锁定) 热区条 wr-chrome-hotzone--top/--bottom  ← 62px, z14, 鼠标唤栏 (1585-1600, css:781-795)
├─ (非锁定) div.wr-reader-footer              ← absolute bottom 玻璃条 z16 (css:768-777)
│   上一页/下一页 (wr-btn wr-icon-btn) · wr-progress 进度条(可拖) · 页码/百分比
├─ (锁定) wr-immersive-exit                    ← 右上角落退出钮 (css:798-853)
└─ 三个 fixed toast (锁定提示/自动滚速/章名, 全内联样式, 1694-1758)
```

- 沉浸状态机 `useImmersiveChrome`（src/ui/useImmersiveChrome.ts:31-122）：显示=指针进顶/底热区；隐藏=离开 1.2s / 翻页动作 dismiss / 选字或抽屉打开（disabled）；锁定=全藏+热区禁用。栏显隐只动 opacity+transform（chromeBarStyle，ReaderPage.tsx:962-966），布局零变化。
- 漫画/PDF（`data-image`）stage padding 恒 0，栏悬浮在图上（css:703-708）。
- 抽屉 Drawer（src/ui/Drawer.tsx）：右侧 390px、`--panel-solid` 实底、头部 62px 定高独立类 `wr-drawer-head`（**注释明确禁止借用 reader-topbar**，Drawer.tsx:19；css:865-891）。七种 sideTab 内容（ReaderPage.tsx:1085-1307）：
  - settings → SettingsPanel（EPUB，src/reader/components/SettingsPanel.tsx）或 ImageSettingsPanel（漫画/PDF，src/reader/image/ImageSettingsPanel.tsx）
  - pages → PagesPanel（视觉书缩略图网格 `wr-image-pages`）
  - toc / bookmarks / highlights / favorites / search（后五者内联在 ReaderPage 或 components/*）
- 面板组件类名：全部复用 wr-btn / wr-card / wr-state / wr-input / wr-toc-item / wr-seg / wr-select / wr-swatch-btn，**面板组件没有任何私有类名**。列表项 = `wr-card`（padding 10）+ 文字钮"打开/删除"（BookmarksPanel.tsx:39-52、HighlightsPanel.tsx:30-45）。
- 工具按钮形态：**顶栏除"返回书库"是纯文字外，全部是"图标+文字"组合**（`wr-btn wr-icon-btn` 同时含 svg 与汉字，ReaderPage.tsx:1002-1060）；底栏两钮同为图标+文字。无纯图标工具钮（纯图标钮只有选区气泡与 wr-mini-btn）。

---

## 6. 毛玻璃 / 背景视觉出现点

### 6.1 backdrop-filter（全项目仅两处）

- `.wr-reader-topbar`：weread.css:757-766 —— `background: linear-gradient(to bottom, transparent, var(--wr-chrome-bg) 22%)` + `backdrop-filter: blur(16px)`，z-index 16
- `.wr-reader-footer`：weread.css:768-777 —— 同款倒置
- `--wr-chrome-bg`：light `rgba(251,250,247,.6)`（css:29）、dark/darkcontrast `rgba(0,0,0,.58)`（css:68、155）。sepia/green/gray 未覆盖，沿用 light 值。
- 书库壳**没有任何毛玻璃**；面板的"玻璃感"来自 `--wr-panel-bg` 半透明白渐变（css:31、69）而非 blur。

### 6.2 背景体系（三层）

1. **壳默认底**：`.wr-shell` / `.wr-reader-root` 双 radial accent 光斑 + `--wr-bg`（css:171-172、682-683）。
2. **全局背景图（用户可设）**：
   - 链路：`reader_bg` settings → `getBackgroundUrl`（单槽 objectURL 缓存，src/ui/appBackground.ts:34-45）→ 壳与阅读纸面共用。
   - 壳：AppShell.tsx:173-179 内联 `backgroundImage: linear-gradient(--wr-bg 88% 纱) + url(bg)` cover 居中。
   - EPUB 纸面：`.wr-reader-paper` 内联 bgUrl + `.wr-reader-bg-veil`（`--wr-bg` 实底 0.88 透明度纱保对比，css:745-752；ReaderPage.tsx:1377-1383）。视觉书（漫画/PDF）不叠背景（ReaderPage.tsx:484-487）。
   - 设置入口：书架右键菜单"设置全局背景/恢复默认"（LibraryPage.tsx:415-442、1428-1433）+ 阅读器 SettingsPanel"全局背景"（选择图片/恢复默认/104×32 缩略预览，SettingsPanel.tsx:273-308）。
3. **主题色**：六主题 `data-theme`（light/sepia/green/gray/dark/darkcontrast），THEME_SWATCHES 定义于 src/ui/theme.ts:8-16；切换入口 = 壳顶栏调色盘菜单（AppShell.tsx:303-328）与阅读设置面板同款色块（SettingsPanel.tsx:107-127）。`document.documentElement.dataset.theme` 驱动（theme.ts:25-32）。

### 6.3 与"实色化"的混合（M2 需注意的现状矛盾）

弹层/浮层已全部从半透明面板改 `--panel-solid` 实底：wr-prompt（css:1269）、wr-menu（1197）、wr-drawer（871）、wr-tag-pop（2144）、wr-mini-btn（1158）、wr-select（198）、wr-drop-hint（2354）、wr-import-bar（2372）、wr-batch-bar（1536）。`--panel-solid` 值在 src/styles/tokens.css:5-64。即现状 = **壳/卡半透明渐变 + 浮层实底** 两套语言并存。

---

## 7. 密度三档如何生效

- 定义：src/library/density.ts:2-13 —— `standard | large | xl`，label 标准/宽松/特大；grid 模板分别为 `repeat(auto-fill, minmax(220px,1fr))` / 320px / 420px。旧 compact 档迁移回 standard。
- 生效方式 = **类名 + 内联 grid 模板**双管齐下（LibraryPage.tsx:1167-1169）：
  - 类名 `wr-book-grid`（standard）或 `wr-book-grid wr-book-grid--large/--xl`
  - 内联 `style={{ gridTemplateColumns: DENSITY_PRESETS[density].grid }}` 注入列宽模板（覆盖 css:932 里的同名默认模板）
- weread.css 只联动卡内尺寸（938-966）：`--large` 封面 64→96px、卡列模板 96px 1fr；`--xl` 封面 120px、卡列 120px 1fr、`.wr-title` 17px。封面高一律 aspect-ratio 2/3 推导。
- 持久化：settings 键 `library_density`（LibraryPage.tsx:233-236 写入；206-215 启动回填）。
- 段控 UI 在工具行右侧（`marginLeft:auto`），三档文字钮。

---

## 8. 对撰写 M2 规范直接相关的补充事实

1. **样式单文件集中**：全部组件类在 `src/ui/weread.css`；改版基本只动这一个文件 + tokens.css，组件里另有大量**内联样式**（ReaderPage 的 toast/页徽标/边缘热区、AppShell 的 shellStyle、各面板的 flex/gap 布局），纯 CSS 改版覆盖不到它们。
2. **主题驱动**：`html[data-theme]` 属性选择器（非 class），六主题各有独立 token 块（weread.css:1-161 + tokens.css）。M2 的"纸白×碳墨"若收拢主题，需同时处理 THEME_SWATCHES（theme.ts:8-16）与 SettingsPanel/AppShell 两处色块 UI。
3. **z-index 体系**：--wr-z-pager 15 / drawer 20 / selection 25 / overlay 30 / hud 60（css:40-44），阅读器顶底栏硬编码 z16、热区 z14、沉浸退出 z17。
4. **圆角/阴影 token**：--wr-radius-xs..xl（8/10/12/16/22）、多套阴影 token（css:13-37）。
5. **键盘/焦点**：大量 `:focus-visible` 两像素 outline 约定（css:614-627 等）；菜单有完整方向键导航（LibraryPage.tsx:281-331）。
6. **滚动条**：全局 ::-webkit-scrollbar 10px 自绘（css:1729-1756）。
7. **选区气泡** `wr-selection-bubble` fixed 定位、28px 图标钮×3（css:2013-2058）。
8. **动画**：栏淡入淡出 200ms、抽屉滑入 180ms、菜单 150ms、卡弹入 180ms，全部有 prefers-reduced-motion 回退。
