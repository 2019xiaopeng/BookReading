# BookReading 修复与升级交付文档

> **给实施方（F:\BookReading-project 下的 Claude Code）**：本文档自包含，按它实施即可。背景分析报告在 `F:\Reverse\analysis\bookreading-*.md`（同机可读，可选深查，本文档已含全部必要结论）。
> **目标版本：2.5.0**（实施 → 构建 → README → release 全流程见项目侧提示词）。**UI 设计规范见 §六（已选定 M2 碳墨刊头）**，高保真参照稿放在 `/docs/design/mono-carbon.html`（浏览器打开对照，含完整 token 与可点交互）。
> **纪律**：①每条改动附验收标准，改完自验；②项目有 vitest（`npm test`），新纯逻辑要补测试，现有测试必须保持绿；③不做本文档"明确不做"清单里的事；④分三个阶段提交，每阶段可独立回滚。
> 所有 `文件:行号` 均已在 2026-10-29 对过源码（部分行号会随改动漂移，按邻近代码定位）。

---

## 阶段一：止血包（每项 ≤1 天，先拿大头）

### 1. 书架封面滚动卡（用户主诉②）

**根因（已实证）**：封面原图直出无缩略图层——`src-tauri/src/commands/images.rs:218`（漫画封面=第一页原图复制，注释自认"不缩放不压缩"）、`epub.rs:284-291`（EPUB 故意选书内**最大**图当封面）、`storage.rs:527`（fs::read 整份字节过 IPC）。实测本机 91 个封面共 86MB、最大 9.97MB/4000×6000，塞进 64-120px 的格子（`weread.css:1000/938/951`）。浏览器仍要**全幅解码**再缩小显示，滚动时解码缓存互相驱逐→反复重解码→掉帧。
**"看着分辨率低但还卡"的说明**：管线里没有任何缩小/压缩环节，所以"糊"不是被压过——排查两个方向：①部分封面**源文件本身就小**（低分辨率扫描/EPUB 内嵌小图），显示在详情页大尺寸时露馅；②Windows 显示缩放（150%/200%）下 64-96px 逻辑槽只有有限物理像素。修法见下，缩略图**只缩小、绝不放大小图源**，详情页继续用原图。

**修法（按序）**：
1. `LibraryPage.tsx:1228/1289/1134/1402` 四处 `<img>` 补 `loading="lazy" decoding="async"`，并加固定宽高比容器（`aspect-ratio: 2/3`）防加载时布局跳动。
2. 书卡类加 `content-visibility: auto; contain-intrinsic-size: <格子宽高>;`（weread.css 里找书卡 grid 项类名）。若滚动条跳动明显，改用 `contain-intrinsic-size: auto <宽高>;`。
3. `BookCard` 抽成独立组件 + `React.memo`（现在 `LibraryPage.tsx:1241-1342` 是内联 map，任何 state 变化全部卡片重渲）。
4. `useCoverUrls.ts`：①初始 state 从 `urlCache` 播种（`:73` 现在恒空对象，导致每次回页先占位再跳图——这也是闪烁根因之一）；②`notify`（`:24-26`）改为 **rAF/50ms 短定时合帧**后统一 setState（每张封面到达现在都触发一次整页重渲；注意不能用微任务——每张封面是独立 IPC 宏任务，微任务批不到）；③`wanted` 全集立即并发（`:102-104`）改为并发上限 6 + 视口优先（IntersectionObserver 命中的先请求），且只对 `booksFiltered` 的封面发起（`LibraryPage.tsx:119` 现在传全库 books，回收站的也在急加载）。
5. 四宫格封面（`LibraryPage.tsx:141-153` coversByShelf 取"已就绪前 4"）改为**固定取该书前 4 页**，加载完成前显示骨架占位，不随到达顺序洗牌。

**验收**：500 本库滚动无长任务掉帧（DevTools Performance 录制对比基线）；回书架页不再出现占位→图片跳变。

### 2. 漫画阅读器卡（用户主诉①"图片多了就卡"）

**根因（已实证）**：
- 无降采样：3000px 原图整字节进 `<img>` 仅 CSS 缩小（`ImageReader.tsx:255-260`），全项目无 createImageBitmap/后端 image crate（Cargo.toml 无 image 依赖），7 页驻留≈300-400MB 解码位图。
- Rust 每读一页全流程重复：`images.rs:345-358` 每次新开 SQLite 连接+查书+**全目录 read_dir+自然排序**再读文件；CBZ 每页**重开 zip 遍历全部条目**（`images.rs:100-116`）→ 翻完整本 O(N²)。
- **全部 40+ 命令零 async**（grep 证实无一处 `async fn`/`#[tauri::command(async)]`），多 MB `fs::read` 同步阻塞主线程与全部 IPC。
- 条漫占位无宽高预留（`weread.css:1864` min-height:50vh），窗口外页销毁成矮占位（`ImageReader.tsx:315-328/707-717`），向上滚动时上方页重载变高**推动视口**→滚动跳动。

**修法**：
1. 全部命令加 `#[tauri::command(async)]`（多页读盘的命令优先：`read_image_page`、`read_cover_blob` 等）。⚠️ async 引入并发后，下面第 2 条的缓存必须用 `Mutex`/`RwLock` 保护——两项**捆绑同批实施**。
2. AppState 加两个缓存：`HashMap<book_id, Vec<PageMeta>>` 页列表（目录 mtime 变化时失效，参考 `relink_image_book` `images.rs:379-383` 已有的清除点）、`HashMap<book_id, ZipArchive>`（打开的 CBZ 句柄）。消除 O(N²)。
3. 页元数据：页列表缓存里顺手记录每页宽高（首次读时用 `image` crate 探测，见阶段二·缩略图管线一起做）。前端占位从 `min-height:50vh` 改为按宽高比 `aspect-ratio` 精确预留。
4. 大页降采样：显示尺寸的 1.5 倍以上的页，读页时后端 resize 后再交付（`image` crate `resize`，LANCZOS3）；双页/单页模式切换时按需重取。
5. 缩放/平移（`ImageReader.tsx:512-556`）不要每 pointermove setState 重渲整棵阅读器（webtoon 下几百页 DOM 每帧 diff）：变换直写容器 `style.transform` + rAF 合帧，pointerup 才落 state。

**验收**：300 页条漫连续翻 20 页 P95 < 100ms；向上滚动无视口推动；稳态内存 < 500MB。

### 3. 布局闪烁（用户主诉③）

三处独立根因，逐一修：
1. **书架首帧空→跳图**：上面 1.4① 播种修复；顺带把 `:1289-1295` 占位/图片三元硬切换改成同一容器内 opacity 过渡（图片 onLoad 后 120ms 淡入已有，占位不卸载只淡化）。
2. **阅读模式切换闪烁**（paged↔webtoon）：anchor 在 paged 模式从不更新，切 webtoon 时用陈旧 anchor 先错误回收当前页邻域再重载。修：`ImageReader.tsx:128-131` 模式 effect 里补一行 `setAnchor(currentPageRef.current)`。
3. **双页模式宽页换组**：宽页（跨页大图）在解码后才探测到→spreads 数组重建→当前页当场换画面（`ImageReader.tsx:269-271/133-140/186-188`）。修：页元数据（上面 2.3）落地后，spreads 构建时直接用已知宽高判定 wide，不再靠解码后探测。
4. **EPUB 字号/行距滑杆**：每拖一档=整章 `rendition.clear()+display`（`ReaderPage.tsx:475-477`→`reader.ts:576-585`）+9 次串行 setSetting IPC（`ReaderPage.tsx:720-731`）。修：`SettingsPanel.tsx:136-145` 滑杆本地预览用 CSS 变量（不触重排的属性），**onCommit（拖完/change 结束）才 resize+持久化**，setSetting 合并为一次批量命令。

**验收**：三种场景录屏逐帧检查无空白帧；拖字号滑杆过程中不再整章白闪。

### 4. 启动体验专项（用户新反馈：窗口固定 800×600、启动"重新全部加载一遍"）

**根因（已实证）**：
- 窗口：`tauri.conf.json:13-18` 写死 `width:800, height:600`，无 maximized/无状态记忆。
- 启动重载感：blob URL 是会话级的——每次启动全部封面重新逐张走 IPC 变 blob（91 张=86MB），且首帧 state 恒空（1.4①）导致占位→图片逐张弹入；`LibraryPage.tsx:243-267` 元数据自愈循环**每修一本 await refresh() 全量重拉**（N 本待修=N 次整页重渲）；`list_books` 全表拉取无分页。
- "书多了会不会越来越卡"——会：以上开销全部随书数线性增长，必须治。

**修法**：
1. 窗口：Cargo 加 `tauri-plugin-window-state = "2"` 并在 `lib.rs` 注册 `.plugin(tauri_plugin_window_state::Builder::new().build())`——记住用户上次的大小/位置/最大化状态；`tauri.conf.json` 里给兜底 `"center": true, "minWidth": 720, "minHeight": 480`。
2. 自愈循环批处理：循环里只收集修复结果，结束后 refresh 一次（`LibraryPage.tsx:243-267`）。
3. 新增 `get_book(id)` 命令（`fetch_book_by_id` 已存在 `library.rs:179-212`，只差包成命令），替换三处全量拉书：`ReaderPage.tsx:171-173`、`FavoritesPage.tsx:31`、`importRunner.ts:125`。
4. 阶段二缩略图+assetProtocol 落地后，封面启动开销从"每张 IPC 传 1MB 级"降为浏览器直接按 URL 取 30KB 级小图——启动重载感根治。

**验收**：重启应用窗口保持上次大小/位置；启动时书架封面一次成批出现（无逐张弹跳）；导入 500 本后启动到可交互 < 1.5s。

---

## 阶段二：根治包（管线级）

### 5. 封面缩略图管线（治本）

Cargo.toml 现无 `image` crate，需加 `image = "0.25"`（webp 编码可用；若 webp 编码受限，退 JPEG q80+PNG 兜底透明）。

方案（已裁决，勿另起炉灶）：
- **另存缩略档，原图保留**：`covers/thumbs/{book_id}.webp`，**480px 宽**（覆盖 120px 格 ×3DPR=360px 留余量），只在原图宽 >480 时缩小，**绝不放大**小图源（详情页继续用原图路径，保住"高清封面"）。
- 生成时机：导入、换封面、重提取封面时同步生成。
- 存量补生成：扩展 `reextract_all_covers` 为后台批量任务，**必须 async 化（spawn_blocking/独立线程）+ tauri event 报进度**——当前全部命令同步跑主线程，批量生成会直接卡死 UI。
- 投递：短期新增 `read_cover_thumb` invoke 命令（改动最小）；**中期启用 assetProtocol**——`tauri.conf.json:21` CSP 已放行 `asset:` 但协议没启用（`app.security.assetProtocol` 缺失），启用后 `convertFileSrc` 直出文件 URL，封面连 IPC 都省了（缩略档目录加入 scope）。
- `useCoverUrls` 改为消费缩略 URL；顺手给详情页留 `read_cover_full`。

### 6. EPUB 阅读链路（闪烁与厚书卡顿的根治）

1. **开书双渲染**：`reader.ts:484` 无条件先 display 第 1 章，`ReaderPage.tsx:424-435` 再 display 恢复 CFI——开书时间翻倍+首页闪跳。修：createReader 加 `initialTarget` 参数首显直达。
2. **locations 厚书永不就绪**：epubjs 每章固定 100ms 停顿（`node_modules/epubjs/lib/locations.js:30` `this.pause = pause || 100`，`:87` 每章 setTimeout），>300 章 ≈ 超 30s 超时（`reader.ts:389`），4096 档从头重跑一遍→开书后 30-60s 全书最卡、进度条永不就绪。修：去掉超时、首次渲染完成后 idle 再启动、生成结果**持久化进 SQLite**（按 book_id+字体字号档缓存，字体字号变了才重算）。
3. **自定义字体完全无效**（两边都不生效）：`readerFont.ts:27-29` 的 @font-face 只注入宿主 document，而正文在 epubjs iframe 里；宿主又没有任何元素消费 `wr-custom`（全项目仅 3 处引用）。修：@font-face 注入 iframe（epubjs `registerContent`/themes 时机），并等 `document.fonts.ready` 再触发重排（微信读书同款"字体就绪才排版"）；顺带修 `ReaderPage.tsx:475-477` 依赖数组缺 fontFamily 导致换字体不重排分页错位。
4. **章节预取**：翻到章尾预 load 下一章（微信读书 `preloadNextChapter` 同款；`reader.ts` 目前唯一 `section.load` 在搜索里）。

### 7. 数据层（书库增长的线性开销治理）

1. SQLite：连接改 `manage()` 复用 + `PRAGMA journal_mode=WAL`（现在每命令新开连接，`db/mod.rs:42-48`，51 处调用；async 化后注意 `Mutex<Connection>`）；给 `books(shelf_id)`、`book_tags(book_id)`、annotations/reading_state 的 book_id 加二级索引（schema.sql 现在除主键零索引）。
2. 书架列表分页/懒加载（500 本以下可先不做，配合阶段一 content-visibility 顶住）。

### 8. ReaderPage 拆分（轻量版，别过度）

`ReaderPage.tsx` 72KB/34 个 useState 全树耦合：滚动 relocated（`reader.ts:349-366` 每次构造新对象）与鼠标进出热区（`useImmersiveChrome.ts:131` bump）都触发全树重渲。最小拆法：顶栏/页脚/设置面板抽成 memo 子组件，relocated 回调的对象引用去重（值不变就复用旧引用）。不要求大重构。

---

## 阶段三：功能补齐（P0/P1）

> 对标微信读书逆向结论（web = CSS 多栏排版+canvas 逐字绘制；APK = 自研排版引擎）。本地软件**不抄**：书城/社区/付费/公众号/版权听书/密文防复制/监控。PDF 策略见下。

### P0（缺陷级）
| 功能 | 现状证据 | 方案 |
|---|---|---|
| 划选复制正文 | `reader.ts:413` selected 回调立即 removeAllRanges；气泡仅高亮/收藏/笔记 3 钮（`SelectionToolbar.tsx:81-96`） | SelectionToolbar 加"复制"钮（navigator.clipboard，约 15 行）；保留现有高亮流 |
| 漫画方向/双页按书记忆 | `image_reader_settings` 全局单份（`ReaderPage.tsx:271-273`），books 表无方向列 | settings 表存 `imgset:<bookId>` 覆盖键：书内改设置写书级键，全局键作默认值 |
| 阅读时长统计 | reading_state 仅 cfi/percent（schema.sql:33-38），全项目无 session/时长 | 新表 `reading_sessions(book_id, date, seconds)`；阅读页 visibilitychange 计时，1 分钟落一次；书详情/书架显示"已读 x 小时" |
| 标注/收藏导出 | 60 命令无 export | Rust `export_annotations(book_id?)` 生成 Markdown（书名/章节/原文/笔记/颜色），dialog 选目录写出 |

### P1
| 功能 | 现状证据 | 方案 |
|---|---|---|
| 高亮体系修复 | 面板只显示 note 不显示原文（`HighlightsPanel.tsx:33`）；颜色硬编码 `#ffe600`（`defaults.ts:15`）而 DB color 列已存在（schema.sql:52）；quick-highlight 把选中文本塞进 note 字段（`ReaderPage.tsx:1506`） | **先做迁移**：annotations 加 `text` 列（存量从 note 拆分），note 回归纯笔记语义；颜色改多色可选写 color 列；面板渲染原文+笔记 |
| 书库全局搜索 | `LibraryPage.tsx:156` `let list = shelfBooks` 只搜当前书架 | 搜索源改全库 books（一个 useMemo 的事） |
| EPUB 章节预取 | 无（见 6.4） | 阶段二已含 |
| 字号快捷键 | `ReaderPage.tsx:522-613` keydown 仅 Ctrl+F/D/B+方向键 | Ctrl+= / Ctrl+- / Ctrl+0 |
| 漫画双页偏移 | `layout.ts:54-81` buildSpreads 固定从第 0 页配对，日漫封面被强拼 | `doubleOffset: 0|1` 设置项（按书记忆，走上面 imgset 键） |
| 页面面板定位 | PagesPanel 无 scrollIntoView、无页码直达 | 打开面板滚到当前页；加页码输入框跳转 |
| mobi/azw3 支持 | `importRunner.ts:84` 仅 epub/txt/cbz/pdf | ⚠️ 先评估：mobi/azw3 解析（纯 Rust 生态较弱）可能要带转换依赖，工作量与边角多——评估后若 >3 天降级 P2，不阻塞其他项 |

### PDF 策略（用户明确：不做重功能）
- **不做**：PDF 书内搜索、大纲面板、重排、注释导出等一切新功能——市面上好的 PDF 阅读器很多，本项目 PDF 只求"能读、不卡"。
- **只做**（廉价性能修，可选）：①PdfReader canvas 绘制从 inline ref 回调（`PdfReader.tsx:659-726`，每次重渲染全量重绘 7 张 HiDPI canvas）改为 `useEffect([bitmap])` + 组件 memo；②cacheKey 去掉逐帧失效的 stageSize（`:203-213`）。

### P2 备忘（本期不做，别顺手做）
TTS 朗读（WinRT 系统合成）、AI 问书/翻译（用户自配 OpenAI 兼容端点，复用书内搜索基建 `reader.ts:594-614`）、StarDict 本地词典、全库备份 zip。

---

## 六、UI 设计规范（已选定：M2 碳墨刊头）

> 用户于 2026-10-29 三方向评审中选定（原话："我选定M2，我觉得非常好非常好"）。美学宪法 = mono-color 一墨编辑印刷体系：**纸白底 + 碳墨单墨 + 封面保彩**。
> **详细施工规范见 `/docs/M2-UI实施规范.md`（逐屏逐类名施工图 + 小窗断点 + 主题/背景/毛玻璃融合方案 + 待确认清单），本节只保留红线。** `/docs/design/mono-carbon.html` 仅作视觉气质与 token 参照，布局以施工规范为准（规范基于对现有代码的逐文件盘点写成）。

### 6.1 红线（与施工规范 §0 等价，冲突时以施工规范为准）

1. **换皮不换骨**：路由、AppShell 骨架、树形书架拖拽、全部设置项与可调性（六主题+背景图+阅读器全套设置+自定义字体）零丢失。
2. **颜色三副本同步**：tokens.css / weread.css / reader.ts THEME_STYLES（EPUB iframe）——新增「纸墨」主题三处一起加，漏一处就壳变书页不变。
3. **只动 chrome 不动正文**：阅读器正文排版、翻页动画、热区、漫画/PDF 内部零改动；毛玻璃（阅读器顶/底栏两处）保留，只换底色。
4. M2 = 新增默认主题「纸墨」，现有六主题保留可选；换主题=换墨，不引入新的用户配置项。
5. 小窗：minWidth 720 + 三档 min-width 断点（规范 §5），网格 auto-fill 天然自适应；默认 800 宽窗口必须落在"中档"而非"小窗"。
6. 实施按规范 §9 的 U1–U7 七个 commit 切分，每个 commit 后 npm test 全绿 + §6.4 对应项核验；规范 §11 的待确认项**先问用户再动**。

### 6.4 功能存续核查清单（PR 描述必须附此表，逐项打勾）

树形书架+拖拽 / 标签筛选 / 回收站（含还原）/ 收藏（书+摘录）/ 批量管理 / 导入查重 / 元数据自愈 / 状态过滤菜单 / 书详情弹窗 / 书库搜索 / TXT 智能分章 / EPUB·PDF·漫画·TXT 四阅读器入口 / 阅读进度恢复 / 书签 / 高亮与笔记 / 沉浸 chrome / 主题切换 / 字体切换 / 翻页动画 / 密度三档 / 快捷键（Ctrl+F/D/B、方向键、Esc、空格）——**每项在新 UI 里可到达且行为不变**。任何一项够不到 = 该 commit 未完成。

---

## 最终验收清单

- [ ] 500 本库书架滚动 60fps（Performance trace 对比基线，基线先录！）
- [ ] 300 页条漫翻页 P95<100ms、向上滚无视口推动、稳态内存<500MB
- [ ] 密度/阅读模式切换逐帧无空白帧
- [ ] EPUB 拖字号滑杆不整章白闪；厚书开书 30s 内不再有后台卡顿峰（locations 持久化生效）
- [ ] 重启窗口保持上次状态；启动封面成批出现不逐张弹入
- [ ] 划选可复制；漫画方向按书记忆；阅读时长可见；标注可导出 Markdown
- [ ] M2 token 一比一落地：styles 目录除 token 文件外 grep 不到色值/字体字面量；书架气质对照 `docs/design/mono-carbon.html` 一致（布局以 M2 施工规范为准）
- [ ] §6.4 功能存续核查表全绿（PR 描述附表）
- [ ] UI 重构后书架滚动帧率不低于重构前基线（content-visibility + BookCard memo 生效）
- [ ] `npm test` 全绿，新增纯逻辑（播种/合帧/页元数据/双页偏移）有测试

## 明确不做（防跑偏）

- 不替换 epubjs、不上 canvas 排版引擎（根因已用补丁解决；库层去留评估放最后单独决策）
- 不做 PDF 新功能（只允许两个廉价性能修）
- 不做书城/社区/账号/云同步/防复制/监控
- 不顺手重构成 monorepo/状态库（zustand 等都不必引入，memo+拆组件够用）
- 不动已反超微信读书的部分：树形书架拖拽、标签系统、回收站、TXT 五套分章正则、条漫 RTL+自动滚动+错峰预读、文件夹漫画原地引用
