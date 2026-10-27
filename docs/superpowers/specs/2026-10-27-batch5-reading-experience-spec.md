# 批次5 · 阅读体验闭环（batch5-reading-experience）

基线 HEAD 99e54a8（P0 prompt 热修已并入，惰性 updater 内读 e.currentTarget 的时序坑**勿回退**；批次1-4.5 成果不可回退）。Tauri 2 + React 19 + TS 5.8 + epub.js 0.3.93 + rusqlite。六主题 token（src/ui/theme.ts）与全局背景已就绪。

本轮 15 项实测反馈：读书区 A1-A6、漫画区 B1-B5、全局区 C1-C6。

## 0. 技术核实结论（已读 node_modules/epubjs 0.3.93 源码 + web 检索，非推断）

1. **relocated 的 displayed 字段（A1）**：`rendition.js#located()` 在 0.3.93 中构造 `start.displayed = { page: start.pages[0]||1, total: start.totalPages }`，`end.displayed` 同理（`end.pages[last]`），且带 `start.index`/`end.index`（spine 序号）与 `atEnd/atStart`。relocated 事件负载即此对象。**displayed.total 是章内页数**（社区确认：futurepress/epub.js#1354，全书页数需逐章渲染求和——本项目不做）。scrolled flow 下无分页语义（page 恒 1），A1 仅在 paginated 用。
2. **A3a 删除高亮失效根因（确凿）**：`annotations.js#remove(cfiRange, type)` 以 `encodeURI(cfiRange + type)` 为 hash 查表；我们调用 `rendition.annotations.remove(cfiRange)` **未传 type** → hash 拼上字符串 `"undefined"` → 永不命中 → DB 删除后渲染层注解残留且每次视图重渲染还回注（inject hook）。修法一行：传 `"highlight"`。
3. **A4 整页翻页**：0.2 时代的内置 slide 已不在 0.3.93；社区做法是容器级 CSS transform（epub.js#34）或外挂 Turn.js（禁新依赖，否决）。单 iframe 无法 clone/快照 → 采用**单层两段式 transform**（旧页全宽滑出、新页全宽滑入，见 §A4），epub.js 滚动模式不适用。
4. **A5 沉浸底部空白根因（推断+确认点）**：进入沉浸只改了外层 DOM（topbar→8px、footer 卸载），epub.js Stage 只监听 window resize，不感知容器变高 → iframe 维持旧高度 → 底部空白。锁定态收边后必须 `rendition.resize()`。
5. **C4 目录扫描**：fs 插件 scope 仅 `$APPDATA/library/**`（capabilities/default.json），前端 readDir 读不了用户目录 → 新增小 Rust 命令返回一级子目录列表（空目录服务端过滤）。
6. **CFI 相交比较（A3b）**：epubjs 导出 `EpubCFI`；`epubcfi.js#compare(a,b)` 为实例方法（接受字符串或实例，返回 -1/0/1），range CFI 解析后有 `.spinePos/.range/.start{steps,terminal}/.end`。可写纯函数做区间相交，node 环境可测（readerSpread.test.ts 先例）。

## 一、全局约束（所有分区共守）

- ponytail 最小完整变更；删优于增；零新 npm/Rust 依赖；先 Read 再改；CRLF；反斜杠编辑 chr(92)+唯一匹配断言；测试同步。
- 不碰 1.md/电子书/temp/.git；禁 `tauri dev`、禁 commit/push。
- 门禁：`npm run build` + `npm run test`；Rust 先 unset 全部代理变量后 `CARGO_TARGET_DIR=C:/cargo-target/bookreading cargo check --manifest-path src-tauri/Cargo.toml`（+ `cargo test`）。
- UI 改动过 .claude/skills/frontend-design 与 web-design-guidelines：focus-visible、aria-label/aria-pressed、150-300ms 过渡、prefers-reduced-motion 降级、tabular-nums 数字。
- 不回退：进度 flush、locate()、去重、图片书分支、六主题、背景图纱、prompt 热修（惰性 updater）。
- 新 UI 遵循现行约定：A/B 域新样式用 inline style（ReaderPage/ImageReader 现状如此）；weread.css 仅 C 改。

## 二、共享接口契约（跨分区，先冻结）

1. **`src/ui/useImmersiveChrome.ts`（A 创建+测试，B/C 不改）**：
   ```ts
   export function useImmersiveChrome(opts?: { idleMs?: number /*默认3000*/; disabled?: boolean }): {
     visible: boolean;              // 栏当前可见（自动隐藏态）
     locked: boolean;               // 锁定态
     setLocked: (v: boolean) => void;
     wake: () => void;
   };
   ```
   协议：window 上 mousemove/pointerdown/keydown/wheel（passive）→ `wake()`（重置 idle 计时）。`disabled=true`（抽屉开/加载失败/选区气泡开）→ visible 恒 true 且暂停计时。`locked=true` → visible 恒 false、wake 无效。`setLocked(true)` 立即隐藏；`setLocked(false)` 回自动隐藏态并显示。卸载清 listener+timer。测试：vi.useFakeTimers 覆盖 idle 隐藏/唤醒重置/disabled 强制/locked 抑制/解锁恢复。
2. **`ImageReaderApi` 扩展（B 加字段，A 消费用可选调用避免顺序依赖）**：`zoomed: () => boolean`。
3. **`set_book_cover(book_id: String, source_path: String) -> Result<String, String>`**（C 实现）：返回新 `cover_path`（"library/covers/{id}.{ext}"）。
4. **`list_image_subdirs(parent: String) -> Result<Vec<String>, String>`**（C 实现）：一级子目录绝对路径数组，仅含"直接含≥1张图片"的目录，文件名自然排序。
5. **`appBackground.ts` 增广播**：`subscribeBackground(fn): () => void` + `notifyBackgroundChanged()`（与 useCoverUrls listeners 同款模式）；AppShell 订阅后重读 settings+getBackgroundUrl。
6. **`useCoverUrls.ts` 增失效**：`invalidateCoverUrl(path: string)`（revoke+删缓存+通知）；hook 监听器同步从 state 删除该 key（覆盖"删除"通知：cache 无此 path 时从 prev 删）。

## 三、逐条方案（根因 → 设计）

### A1 页码（epub，paginated）
**根因/现状**：footer 只有 locations 百分比；无视觉页码。
**方案（精确式）**：
1. `reader.ts` `RelocatedPayload` 增：`sectionIndex: number`（`location.start.index`）、`pageStart: {page:number; total:number} | null`、`pageEnd: {page:number; total:number} | null`（`location.start.displayed`/`location.end.displayed`，字段缺失容错为 null）。0.3.93 已核实存在（§0.1）。
2. ReaderPage 新增 `pageBadge` state：`{ left: {page,total} | null; right: {page,total} | null }`。left=pageStart；right=（pageEnd 且 `end.index!==start.index || end.page!==start.page`）? pageEnd : null。onRelocated 写入；image 书不写。
3. 渲染：`.wr-reader-paper` 内两枚绝对定位小徽标 inline style：`position:absolute; bottom:6px; left:10px / right:10px; font-size:11px; color:var(--wr-muted); fontVariantNumeric:tabular-nums; pointer-events:none; zIndex:2`。文本 `"{page}/{total}"`。单页（right 为 null）只显示右下角；双栏两角各一（左=左页，右=右页，各自章内 total）。scrolled 模式不渲染徽标。
4. 字号/行距/版式变化后重算：设置 effect 内对 fontSize/lineHeight 变更调用 `controllerRef.current?.resize()`（ReaderController 增 `resize: () => { try { rendition.resize(); } catch ... }`）。【确认点】实测改字号后 relocated 是否自带新 displayed；若自带且不闪则可省 resize，但首版按"调 resize"落地更稳（displayed.total 随重排更新）。
5. 锁定态（A5）徽标保留（属纸面信息，不属 chrome）。

### A2 footer 章导航（epub，两模式统一）
**方案**：
1. 拆 `animateTurn`：新 `navChapter(direction)` = epub 两模式统一 `ctrl.chapterNav(±1)`（现 scrolled 分支复用）；`animateTurn` 保留键盘/滚轮/热区的翻页语义（paginated=rendition.next/prev+动画，scrolled=chapterNav）。
2. footer 两按钮改调 `navChapter`，文案 epub 恒"上一章/下一章"（删 `scrolledNav` 文案分支，保留变量判断 epub/image 即可）；image 书 footer 仍是页翻（"上一页/下一页"，现行为）。
3. HUD 旧块随 A5 删除，不迁移。

### A3 高亮闭环
**a) 删除即消**：`reader.ts#removeHighlight` 改 `rendition.annotations.remove(cfiRange, "highlight")`（根因见 §0.2，一行修复+注释）。ReaderPage 面板删除链已调 removeHighlight，不动。
**b) 气泡"取消高亮"**：
1. `reader.ts` 导出纯函数：
   ```ts
   export function cfiRangesOverlap(a: string, b: string): boolean
   ```
   实现：`const A = new EpubCFI(a), B = new EpubCFI(b)`（`import ePub, { EpubCFI } from "epubjs"`；确认 EpubCFI 具名导出可用，否则 `(ePub as any).EpubCFI` 或 `new (Rendition as any)` 不可取——epubjs src/index.js 已具名导出 EpubCFI）。区间位置键：`keyOf(cfi, "start"|"end") = [spinePos, ...path.steps.map(s=>s.index), ...(edge.steps?.map(s=>s.index) ?? []), edge.terminal?.offset ?? -1]`（range 时 path+start/end steps，非 range 退化同键）；字典序比较（短的靠 pad 规则：前缀相同者更小）。相交 = `cmp(A.start,B.end)<=0 && cmp(B.start,A.end)<=0`。
2. ReaderPage：selection 变化时算 `overlapping = highlights.filter(h => cfiRangesOverlap(h.cfi_range, selection.cfiRange))`；SelectionToolbar 增 prop `removeMode: boolean`：为 true 时高亮钮 aria-label/title 改"取消高亮"、图标加删除斜线（inline `<svg>` 或 IconHighlight + style 叠加删除线：用 `IconHighlight` 包一层 `opacity` + 边框？——最小：按钮内加文本 `✕`？**定案**：钮内 IconHighlight 且 `style={{opacity:.55}}` + aria-label 区分，另加一条 4px 底线 `borderBottom:"2px solid var(--danger)"`，可读且零新图标）。onHighlight → `removeHighlightAll`：循环 `deleteHighlight(id)` + `ctrl.removeHighlight(h.cfi_range)` + state 过滤，然后 `setSelection(null)`。
3. 测试：`cfiRangesOverlap` 单测（相交/相邻/包含/跨 spine/同 range），样例 CFI 覆盖 charOffset 形态 `epubcfi(/6/4!/4/2,/1:0,/1:10)`。

### A4 整页滑动翻页（epub paginated，替换现 2% slide）
**DOM/CSS**：动画节点 = `containerRef.current`（epub 渲染目标 div，`.wr-reader-paper` 纸框与背景纱保持不动——纸面稳定、内容整页平移的观感）。viewer 已 `overflow:hidden` 充当轨道。
**时序**（dir=next；prev 全部取反；D1=150ms 出场、D2=240ms 入场，`cubic-bezier(0.2,0,0,1)`）：
1. `turningRef.current === true` → 跳过动画直接 `await run()`（快速连翻=瞬时跳页，**永排队永不卡死**）。
2. 置 busy；`el.style.transition = "transform 150ms ease-in"`；`el.style.transform = translateX(-100%)`（旧页整幅滑出，display 清空发生在屏外，用户不可见）。
3. `await run()`（rendition.next/prev；relocated 已触发，新内容已挂）。
4. `transition="none"`；`transform = translateX(+100%)`；`void el.offsetHeight`（强制 reflow 提交起点）。
5. `transition = "transform 240ms cubic-bezier(0.2,0,0,1)"`；`transform = "translateX(0)"`。
6. `setTimeout(260ms)` 兜底（不依赖 transitionend）：清 transition/transform、busy=false。
**降级**：`pageAnimation==="none"` 或 reduced-motion → 直接 run()；`"fade"` 保留现有 180ms opacity；scrolled/图片书不走此路径。全部内联 style，无 CSS 新增。

### A5+B1 沉浸 chrome 重做（读书+漫画统一）
**模型**：常态=栏自动隐藏；锁定=全藏+纸面顶满。旧 immersive HUD（鼠标到顶唤出）整块删除（`isImmersive`、`showImmersiveHudRef`、`immersiveHud*` state/effect、HUD JSX、HUD 内联样式；`.wr-immersive-hud*` CSS 由 C 删除）。
**ReaderPage 接线**（epub 与 image 共用同一套栏，B 区无代码改动即自动统一）：
1. `const chrome = useImmersiveChrome({ disabled: drawerOpen || !!readerError || !!selection || !!noteDraft })`。顶部"沉浸"钮（IconMoon）换成锁定钮：`chrome.setLocked(!chrome.locked)`，IconLock/IconLockOpen（C 先加图标）。锁定时提示 toast：底部居中小条 `已锁定 · Esc 解锁`（inline style，wr-fade-out 2.5s 自清，复用现有类）。
2. topbar/footer 容器 inline 加：`transition:"opacity 200ms ease, transform 200ms ease"`，`!chrome.visible && !chrome.locked` 时 `opacity:0; transform:translateY(±8px); pointerEvents:"none"`（**高度保留**，无 layout 变化，不触发 epub resize/relocated 抖动）。`chrome.locked` 时两栏与 A6 章名条直接不渲染（`null`），纸面 `wr-reader-paper-wrap` padding 收为 `0 6px`（inline 覆盖）。
3. `useEffect([chrome.locked])`：锁定切换 250ms 后（等布局稳定）`controllerRef.current?.resize()`（修底部空白根因 §0.4；image 书无需）。进入/退出阅读页不受影响（createReader 时容器尺寸已是最终值）。
4. Esc 语义（改现有 keydown 分支，顺序）：抽屉开→关抽屉；locked→`setLocked(false)`（唤回栏）；!visible→`wake()`；否则无操作。Ctrl+D 保留=切锁定。翻页（键盘/滚轮/热区/进度条）在锁定态照常。
5. image 书顶满：`wr-paper-image` 本就 padding 0，锁定无额外处理；热区/滚轮已兼容。

### A6 章节小字（纸面上方）
- `paper-wrap` 内（epub 分支）绝对定位于顶部 padding 带：`position:absolute; top:0; left:0; right:0; height:18px; lineHeight:"18px"; textAlign:"center"; fontSize:12px; color:var(--wr-muted); overflow:"hidden"; textOverflow:"ellipsis"; whiteSpace:"nowrap"; pointerEvents:"none"`（paper-wrap 置 `position:"relative"`）。零 layout 影响。
- 数据流：onRelocated 已存 `chapterRef`；新增 state `chapterHref`，onRelocated `setChapterHref(href)`；渲染时 `tocLabelFor(flatToc, chapterHref) ?? "正文"`（toc 晚到时 memo 重算自动补上，无闭包陈旧）。锁定态隐藏（与栏同生灭）。六主题走 `--wr-muted`。

### B2 漫画设置面板
- **a) 实色化**（CSS 落 C）：`.wr-drawer { background: var(--panel-solid); }`（六主题 token 齐备；壳内其余玻璃面板不动）。B 验收暗色可读。
- **b) 主题入口**：ImageSettingsPanel 增"主题"区块，与 SettingsPanel 同款六色块（inline 渲染 `THEME_SWATCHES.map` + `setTheme/useTheme`，不新建共享文件；代码库共 2 份 inline 拷贝，可接受）。
- **c) 翻页动画**：`ImageReaderSettings` 增 `pageAnimation: "none" | "slide"`，默认 `"slide"`（现行为）；normalizeImageReaderSettings 兼容旧 JSON（缺省→slide）；ImageSettingsPanel 增 Seg（条漫模式禁用）；ImageReader 的 snap 滑动 effect 以 `settings.pageAnimation==="slide"` 为前置（reduced-motion 已有）。layout.test.ts 补 normalize 断言。

### B3 条漫宽度
- `ImageReaderSettings` 增 `webtoonWidth: number`（40-100，默认 75）。档位：62（A4 感）/ 75（适中）/ 92（宽）三 Seg + range 滑条（step 1，右侧数值%）。持久化随 `image_reader_settings` 整体 JSON（现链路零新增）。
- 渲染：webtoon 每页容器 `style={{ width: `${settings.webtoonWidth}%` }}`（现 100%）；图片 `width:100%` 不变；列容器 `align-items:center` 已居中；两侧露出 `.wr-image-stage` 的 `var(--wr-bg)` 纸面色。normalize clamp 到 [40,100]；layout.test.ts 断言。

### B4 漫画收藏与书签
1. **收藏**：ReaderPage 顶栏 image 书加 IconHeart 钮（`aria-pressed={book.is_favorite}`，fill 切换沿用 FavoritesPage 画法）；onClick `setBookFavorite(book.id, !book.is_favorite)` + 本地 `setBook(b => b && {...b, is_favorite: !b.is_favorite})`（与书库联动=书库刷新即见）。
2. **页书签**：`imageCfi(page)` 已有（"img:N"）。放开 Ctrl+B 的 `!imageCtxRef.current.active` 限制：image 分支 label=`第${page+1}页`、cfi=`imageCfi(imagePage.page)`。顶栏 image 书加"书签"钮（IconBookmark，openDrawer("bookmarks")，与 pages 钮并排）。`locate()` 分流：`imageCtxRef.current.active` → `parseImageCfi(cfi)` 命中则 `imageApiRef.current?.goToPage(n)`，否则走 ctrl.display。BookmarksPanel 复用零改（label 显示"第N页"）。
3. 去重：现 `prev.some(x => x.cfi === bm.cfi)` 已覆盖 img:N。

### B5 图片缩放（条漫+单页同款）
- **状态机**（ImageReader 内）：`const [zoom, setZoom] = useState({ scale: 1, tx: 0, ty: 0 })`；`zoomed = zoom.scale !== 1`。
- **Ctrl+滚轮**：stage 根 div `onWheel`（React 合成，`{ passive: false }` 需原生 addEventListener——React onWheel 默认可 preventDefault 于桌面 WebView，稳妥起见用 ref+原生 listener passive:false）：`e.ctrlKey` → preventDefault + 以光标为锚缩放：`factor = deltaY<0 ? 1.1 : 1/1.1`，`scale' = clamp(scale*factor, 0.5, 4)`，`tx'/ty'` 按锚点公式（光标点在缩放前后不动）重算。非 Ctrl：zoomed 时 → preventDefault + 平移（`tx -= deltaX; ty -= deltaY`）；未 zoomed → 交还现行为（翻页/原生滚动）。
- **平移拖拽**：zoomed 时 stage `onPointerDown` 捕获拖拽改 tx/ty，`cursor:"grab"`；clamp 到内容边界（|tx| ≤ (w*scale−w)/2，ty 同理，w/h 取 stage 尺寸）。**禁翻页**：`ImageReaderApi.zoomed()` 暴露；ReaderPage（A）wheel/热区/键盘 image 分支加 `if (imageApiRef.current?.zoomed?.()) return;`（A 侧可选调用，B 先后落地均可）。
- **应用变换**：paged→对 `.wr-image-fit` 主层 inline `transform: translate(tx,ty) scale(scale)`、`transformOrigin:"center center"`、zoomed 时去掉 overflow 滚动（fit=width/original 时 zoomed 优先平移）；webtoon→对页列外包一层 div 施加同变换，zoomed 时滚动容器 `overflow:"hidden"`。
- **复位**：双击 stage 或右下角浮动小钮"100%"（inline，zoomed 才渲染）→ `{1,0,0}`。
- 纯函数进 layout.ts：`clampZoomScale(s)`（0.5-4）+ `panClamp(tx, ty, w, h, scale)`，配测试；锚点公式在组件内（依赖光标坐标）。
- persist：不持久化（会话态，复位即回）。

### C1 卡片工具钮不遮书名
- weread.css：`.wr-title { transition: padding-right 150ms ease; }`；`.wr-book-card:hover .wr-title, .wr-book-card:focus-within .wr-title { padding-right: 68px; }`（两钮 28px×2+gap+边距，hover 时标题让位、永不压字）。`.wr-mini-btn` 背景实色化 `background: var(--panel-solid)`（保玻璃卡片质感、按钮本体可读）。验收：hover 任意卡标题无遮挡、800×600 与全屏均过。

### C2 书架密度
- 新 `src/library/density.ts`：`export type LibraryDensity = "compact" | "standard" | "large"; export const DENSITY_PRESETS: Record<LibraryDensity, { grid: string; cover: string }>;`（供 aria 与样式拼接）+ `normalizeLibraryDensity(v): LibraryDensity`（缺省/非法→standard），配 density.test.ts。
- LibraryPage：`libraryDensity` state，挂载时 `getSettings()["library_density"]` 回填；变更即 `setSetting("library_density", v)`。入口：排序行右侧新 `wr-seg`（紧凑/标准/大图，aria-label="书架密度"）。
- weread.css：`.wr-book-grid--compact { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }` + `.wr-book-grid--compact .wr-cover { width:52px; height:76px; }` + `.wr-book-grid--compact .wr-book-card { grid-template-columns: 52px 1fr; }`；`--large`：minmax(320px,1fr)、cover 96×138、card 列 96px 1fr。默认 standard=现状不动。

### C3 书架背景入口
- LibraryPage 网格右键菜单增两项：`设置全局背景`、`恢复默认背景`（后者仅当前 settings.reader_bg.type==="image" 时显示——读 AppShell 同源 getSettings，或直接无条件显示，简单为上：无条件）。
- 流程复用：`open({ filters: 图片 })` → `saveReaderBackground(path)` → `resetBackgroundCache()` → `setSetting("reader_bg", JSON.stringify({ type: "image", path }))` → `notifyBackgroundChanged()`；恢复默认：`setSetting("reader_bg", JSON.stringify({ type: "preset" }))` → reset+notify。AppShell 订阅（§二.5）后重读 settings+getBackgroundUrl，即时换肤；阅读页下次进入自动新背景（reader_bg 属 settings，挂载读取）。不做预览对话框（应用即预览）。

### C4 批量导入漫画 + 多选确认
- Rust `list_image_subdirs`（§二.4；images.rs，复用 `folder_image_files` 判空过滤+`nat_cmp` 排序；lib.rs 注册；测试：tempdir 子目录含图/空/仅 txt/根下散文件 → 只返回含图目录且自然序）。
- LibraryPage：网格右键菜单增 `批量导入漫画`：`open({ directory: true })` → `listImageSubdirs(dir)` → 逐个 `importImageFolder(sub, null)`（title=null → 取子目录名，Rust 现逻辑即此），失败 `logFrontend` 收集不中断；结束 `window.alert(\`导入 ${ok} 本，失败 ${fail.length} 个\`)` + refresh。空目录已在服务端跳过。
- 确认（只读不改）：`onImport` 已 `multiple:true` 逐文件容错（epub/txt/cbz 分流）——验证即可。

### C5 侧栏分组书架
- AppShell：挂载+window focus 时 `listBooks()`，派生 groups（distinct group_name，zh 排序）；`useSearchParams()` 读 `group` 当前值。书架 nav 按钮下渲染分组子列表：`全部 / 未分组 / 各分组` 小钮（12px、缩进、`aria-current` 高亮、focus-visible），点击 `navigate(\`/?group=${encodeURIComponent(g)}\`)`（全部→`/`）。与 LibraryPage chips 同源（books.group_name）；LibraryPage 内"新建分组"的会话空组不出现在侧栏（同源原则，spec 记录）。
- LibraryPage：挂载+`searchParams` 变化 effect：`const g = searchParams.get("group")` → `setGroupFilter(g ?? "全部")`；chips 点击仍本地态（不写 URL，最小）。

### C6 自定义封面
- Rust `set_book_cover`（library.rs）：
  ```rust
  #[tauri::command]
  pub fn set_book_cover(app, book_id: String, source_path: String) -> Result<String, String>
  ```
  1) 复用校验：把 `validate_reader_background` 主体提为 `validate_image_file(path) -> Result<String,String>`（ext png/jpg/jpeg/webp + ≤8MB），bg 命令改调用（行为不变，测试复用）。
  2) `fetch_book_by_id` 确认存在；`covers_dir` + `atomic_copy_to` 写 `covers/{book_id}.{ext}`（.part 中转）；删除同 id 其他扩展名残留（仿 bg 单槽清理）；`UPDATE books SET cover_path=?2 WHERE id=?1`；返回 `library/covers/{book_id}.{ext}`。lib.rs 注册。
  3) Rust 测试（tempdir+内存库）：覆盖已有封面替换+异扩展残留清理+非法扩展/超限报错。
- 前端：invoke.ts 加 `setBookCover(bookId, sourcePath): Promise<string>`；LibraryPage 书卡"更多"菜单加 `设置封面`：图片对话框 → `setBookCover` → `invalidateCoverUrl(book.cover_path)`（§二.6）→ `refresh()`。无封面书同样可用（insert 不涉、UPDATE 皆可）。repair 命令只在封面缺失时补，不会覆盖自定义封面（已核 repairBookMetadata 逻辑）。

## 四、任务分解与顺序

**A（epub 阅读域）**：src/pages/ReaderPage.tsx、src/reader/epub/**（reader.ts）、src/reader/components/**、src/reader/settings/**、src/reader/ui/**、新建 src/ui/useImmersiveChrome.ts(+test)。
**B（漫画域）**：src/reader/image/**（ImageReader/ImageSettingsPanel/layout(+test)/api.ts）——只引用 A 的 hook 与 C 的图标，不改其文件。
**C（壳/库/样式/Rust）**：src/pages/LibraryPage.tsx、src/ui/{AppShell,Drawer,icons,appBackground}.ts(x)、src/library/**（含新 density.ts）、src/styles/**、src-tauri/**、src/tauri/invoke.ts。
交界处理：A/B 新样式走 inline；weread.css 增删只 C 动（C0 图标 → C 任务）；`ImageReaderApi.zoomed` B 加、A 用可选调用；`.wr-immersive-hud` CSS 由 C 在 A 删 HUD 后清理。

**建议序**（每步过门禁）：C0（IconLock/IconLockOpen + .wr-drawer 实色 + .wr-immersive-hud 清理预备注）→ A1（reader.ts payload+徽标）→ A2 → A3（一行修复先行）→ A4 → A5（useImmersiveChrome+chrome 接线，删 HUD）→ A6 → B2/B3（settings 字段+面板）→ B4 → B5（zoom+api.zoomed）→ A 补 zoomed 守卫 → C1/C2 → C3 → C4 → C5 → C6 → C 清理 HUD CSS → 全局审美 pass（800×600 与全屏）。

## 五、验收

1. 门禁全绿：npm run build/test、cargo check/test（env 代理 unset、CARGO_TARGET_DIR 指定），零新依赖。
2. 逐条手测：A1 单/双栏角标随翻页/字号/行距/版式更新；A2 epub 两模式 footer 均章导航（image 仍页翻）；A3 面板删除正文即消、选中已高亮段气泡呈"取消高亮"且可撤；A4 slide 档整页平移、快速连翻 10 次无卡死无丢页、reduced-motion 直切；A5 3s 隐栏、任意输入唤回、锁定全藏+纸面顶满+无底部空白、Esc 语义四级分明；A6 章名随章变、锁定隐藏；B2 面板暗色可读、主题即切、动画档生效；B3 三档+滑条居中留白持久化；B4 收藏联动书库、img:N 书签显示"第N页"可跳页、Ctrl+B；B5 Ctrl 滚轮 0.5-4x、拖拽平移、翻页被禁、双击/复位回 1x、非 Ctrl 保持原语义；C1 hover 无遮字；C2 三档密度持久化；C3 书架设背景即时全应用；C4 父目录批量+失败不中断、多选导入复验；C5 侧栏分组过滤进入；C6 换封面即刷、旧 blob 不残留。
3. 回归不丢：进度 flush/拖动、locate、去重、图片书分支、六主题、背景纱、prompt 热修、scrolled 行为。
4. 每项动手前完成对应【确认点】；实测与 spec 不符先改 spec 再改码。

## 六、跳过项（记录在案，不做）

- 全书累计页码（跨章 X/Y 总和）：跳过——epub.js displayed.total 为章内语义，全局聚合需逐章渲染，成本不成比例；用章名条+章内页码表达。
- 真实翻书仿真（卷曲/双页翻折、iframe 快照交替）：跳过——单 iframe 无法快照，外挂库（Turn.js/page-flip）违零新依赖；slide 全宽平移已达"整页挪动"。
- 书架背景独立预览对话框：跳过——应用即生效即预览，不建第二套对话框。
- epub 阅读器内收藏按钮：跳过（B4 明确范围为漫画；epub 走书库收藏）。
- 漫画角标页码：跳过——footer 已有 "N / M"。
- 缩放态持久化/记忆：跳过——会话态，复位回 1x。
- 侧栏分组右键管理（重命名/删除）：跳过——chips 行右键已有，侧栏仅导航。
- 条漫宽度档位自定义命名（用户起名档位）：跳过——三预设+滑条已覆盖需求。
