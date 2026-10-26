# 2026-10-26 格式扩展与功能路线图（roadmap）

基于同日代码事实核查（10 问，均附 file:line 证据）与六路竞品调研（koodo-reader / readest / legado / mihon / kavita+sumatrapdf / 主流读书软件）。原则：全面而不冗杂；每个阅读设置映射为渲染器属性而非独立代码路径（readest 架构哲学）。

## 一、现状事实（代码核查结论）
1. 格式：仅 EPUB。import_book 无扩展名校验，非 epub 文件"假成功"导入、打开时报「EPUB 打开失败」；拖拽路径连 dialog 的 epub 过滤都没有（library.rs ~240-325、LibraryPage.tsx ~100-131）。
2. 翻页动画：真实存在，none/slide/fade 三档，180ms 轻量内联实现，respect prefers-reduced-motion（ReaderPage.tsx ~570）。无仿真翻页，也不计划做。
3. 阅读流：flow:"paginated" 硬编码，无滚动模式；滚轮=翻页器（reader.ts ~103、ReaderPage.tsx ~640）。
4. 书内搜索：结果 {cfi, excerpt}，无章节/页码/百分比，上限 200 条。
5. 封面兜底：书名首字 40px 灰底占位（LibraryPage.tsx ~320）。
6. 主题：light/dark/sepia 三预设；正文色写死、背景 transparent、链接色未设；用户可调仅字号%与行距。
7. schema：books(id,title,author,cover_path,library_path,added_at,last_opened_at,is_favorite)；无 tag/note/分组；bookmarks.label 已有。
8. Rust 经 std::fs 直读任意路径（无 fs 插件 capability）→ 新增"扫描图片文件夹"命令零权限成本。
9. zip 2.6.1(deflate) 已在依赖中，ZipWriter 可用 → TXT→EPUB / 读写 CBZ 零新依赖。
10. 性能：无 memo/虚拟化；书库封面串行 readAppDataFile 是真实瓶颈；epub 正文在 iframe 内，React 重渲染不触碰。

## 二、竞品调研要点
- koodo-reader：格式矩阵最全（15 种）；设置面板配置驱动（常量+泛型组件）；EmptyCover；搜索结果 {chapterTitle, chapterIndex, excerpt}；云同步矩阵是最大抱怨源（反例，砍）。
- readest（Tauri+Rust，同栈最近参考）：foliate-js 内核；格式检测用魔数（PK\x03 / %PDF- / 文本兜底）；性能三板斧——重活不过 IPC 只回传小结果、状态按写入频率拆分（95→14 组件重渲染）、卸载 flush 进度；阅读区主题与 App UI 主题解耦。
- legado：TXT 分章=规则池（默认 25 条正则，核心：`^[ 　\t]{0,4}(?:序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|第\s{0,4}[\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+?\s{0,4}(?:章|节(?!课)|卷|集(?![合和])|部(?![分赛游])|篇(?!张))).{0,30}$`）；512KB 块流式扫描记偏移；无命中兜底按 ~10KB 切块；超 100KB 长章递归拆分；扁平章列表+isVolume 标志（不建树）；主题=日/夜/墨水屏三组值 + bgType(0纯色/1内置图/2自定义图) + shareLayout（换肤不重排）。
- mihon/kavita/sumatrapdf（漫画）：文件夹=一本书（不递归、自然排序 `new Intl.Collator(undefined,{numeric:true})`）；首图=封面；适配套式 3 个（适高/适宽/原始）即可；单双页+RTL+横图跨页是正交枚举；ReaderMode=横翻/竖翻/Webtoon 连滚三选一；预载当前 ±2~5 张；反例 Komga 强制打包 CBZ（用户抱怨）。Kavita 教训：进度别只靠翻页事件、保持宽高比。PDF=pdf.js 薄壳（spreadMode/scrollMode/layoutMode 全内置；disableAutoFetch+rangeChunkSize 懒加载；跳页必 renderTask.cancel()）。
- 主流软件共识（微信读书/Moon+/Apple Books/Kindle/起点）：epub+txt+pdf 三件套；一层分组+置顶+排序（无一家做嵌套文件夹）；封面兜底=纯色底+书名+作者文字卡（无 AI 生成）；搜索=章节+摘句+跳转（无倒排索引）；滚动模式与翻页动画是同页并列的两个正交设置。

## 三、路线图（四批，每批独立可交付）
### 批次 1 · 文字书补全（小而高值，纯复用）
- TXT→EPUB 转换（Rust 导入时）：legado 规则池核心 8 条正则 + 512KB 流扫 + 10KB 兜底切块 + 100KB 长章拆分 + GBK/UTF-8 编码探测；唯一新增 Rust 依赖 encoding_rs（中文 GBK txt 必需）；分页/主题/书签/搜索全链路免费复用 epub 管线。
- 搜索结果带章节：spine 序号→toc 匹配章节标题 + percentageFromCfi 百分比，照抄 koodo 三元组 {chapterTitle, excerpt, percent}。
- 文字封面卡：纯色底+书名+作者模板升级现有首字占位（纯 CSS，零依赖）。
- 书架管理：books 加 note 列、group_name 列、pinned_at 列（一层分组+置顶+按最近阅读/书名排序；明确不做嵌套文件夹树）。
- 性能：封面分批并行加载（Promise.all 每批 8 本）。
- 导入校验：扩展名+魔数嗅探（PK\x03→zip 系、%PDF-→pdf、UTF-8/GBK 文本→txt、图片目录→漫画），拖拽同样过滤。

### 批次 2 · 漫画（图片书）
- 新书类型 images：图片文件夹（原地引用不复制——F 盘容量现实；删除书只删记录不删源文件）与 CBZ（zip 解包到临时目录）。
- Mihon 规范：不递归、自然排序、首图=封面、目录名=书名。
- 查看器：适高/适宽/原始三档 + 单双页 + RTL + 横图跨页检测（readest issue #6210 的教训：第一版就带）；预载 ±2 页；Webtoon 连续滚动模式（漫画形态的"无限下滑"）；进度=页码（图片书无 CFI）。

### 批次 3 · 沉浸与个性
- epub 滚动模式：rendition.flow("scrolled") 切换开关；与翻页动画互斥；开启后 wheel 交给 iframe 原生滚动；relocated 进度照常。
- 主题扩展：预设 3→6 套；背景色/文字色/强调色分离可调；自定义背景图（bgType 0 纯色/1 内置纹理/2 本地图）；shareLayout（换肤不重排）。

### 批次 4 · PDF（可选，需用户确认）
- pdfjs-dist 薄壳（新增 npm 依赖，属"用户点名功能"例外）：分页/滚动/双页直接映射 pdf.js 内置；懒加载 + renderTask.cancel；无封面走文字封面卡。

## 四、明确砍掉（不做，防止越做越复杂）
云同步/WebDAV/S3、TTS、仿真翻页、书源系统、嵌套文件夹管理器、AI 生成封面、mobi/azw3/docx/md 格式、OPDS、翻译、自动滚动 5 档、搜索倒排索引、双层笔记系统。

## 五、性能红线（每批实施时对照）
1. 重活（解析/扫描/缩略图）留在 Rust 侧，IPC 只传小结果结构。
2. 高频状态（翻页级进度）与低频状态分离，防一次 swipe 全组件重渲染。
3. 漫画只预载 ±2；滚动模式只刷新当前 ±3 屏；卸载必 flush 进度（已实现）。
4. 书库封面并行分批；列表超 300 本再考虑虚拟化（现在不做）。

## 六、实施顺序建议
批次 1 → 2 → 3 →（确认后）4。每批完成即提交推送；每批开工前先写该批的 spec 细化（沿用 docs/superpowers 工作流）。
