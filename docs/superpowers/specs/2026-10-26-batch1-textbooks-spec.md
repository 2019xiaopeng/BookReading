# 2026-10-26 批次1 文字书补全设计（batch1-textbooks）

## 1. 背景

HEAD=5adb5e1，工作区干净。本 spec 落实路线图（2026-10-26-format-expansion-roadmap.md）批次 1：TXT 导入、搜索章节化、文字封面卡、书架 note/分组/置顶、导入格式校验。硬约束：F 盘仅 ~3.6G，禁止一切构建/安装/执行（npm/npx/cargo/tsc/vitest），只做静态自查；ponytail 最小完整变更；仅新增两个 Rust 依赖 `regex`、`encoding_rs`（只写 Cargo.toml，不安装）；不新增 npm 依赖；保持 CRLF；禁 git commit/push；不碰 .git/.claude/1.md/三个电子书文件/temp/。

设计前重新核对了关键文件，两处与路线图/任务书的"事实"不符，已修正到本 spec：

- 前端不存在任何拖拽导入代码（全仓库 grep "drop" 仅命中 weread.css 的 backdrop-filter）。"拖拽过滤"无从过滤；不新增拖拽功能（见跳过项）。
- useCoverUrls.ts:35-63 已经是并发加载（for 循环里逐个 `pending.push((async…)())`，全部 Promise 同时在飞）。"串行 for 循环"事实过期，批次 1 无封面性能工作。

## 2. 数据与命令契约（三区共用的唯一真相）

### 2.1 books 表新列（migrations.rs / schema.sql）

- `note TEXT NULL`、`group_name TEXT NULL`、`pinned_at INTEGER NULL`。
- schema.sql 的 CREATE TABLE books 同步加三列（全新安装走这里）。
- migrations.rs 新增 `ensure_book_columns(conn: &Connection)`：对三列逐条 `ALTER TABLE books ADD COLUMN …`，错误信息含 "duplicate column name" 则忽略，其它错误向上抛；init_db 在 `ensure_books_is_favorite_column` 之后调用。不改动既有 ensure_books_is_favorite_column（PRAGMA 模式保持原样）。

### 2.2 Book 结构（models.rs:4-14 / invoke.ts:3-13 / 所有 Rust 构造点）

追加三个字段：`note: Option<String>`、`group_name: Option<String>`、`pinned_at: Option<i64>`（TS：`string | null` / `string | null` / `number | null`）。Rust 所有 Book 字面量构造点补 `None`，仅 fetch_books / fetch_book_by_id 从 SELECT 取真实值。

### 2.3 update_book_metadata（命令名不变，lib.rs 注册不动）

- 请求体改为 `{ book_id: String, note: Option<String>, group_name: Option<String>, pinned: Option<bool> }`。**删除** title / author / cover_bytes_base64 / cover_ext 四个字段：该命令前端零调用方（死链），title/author/cover 的写通道由 repair_book_metadata 独占，删除优于保留。
- 语义：`note`/`group_name` = `None` 不改；`Some(v)` trim 后为空 → 写 NULL（清除），非空 → 写值。`pinned` = `Some(true)` → `pinned_at = now_ts()`；`Some(false)` → `pinned_at = NULL`；`None` 不改。
- TS 侧 `UpdateBookMetadataRequest = { book_id: string; note?: string; group_name?: string; pinned?: boolean }`。字段省略（undefined）= 不改；空串 = 清除。注意 Tauri invoke 走 JSON：undefined 键会被丢弃 → serde `None`，`""` → `Some("")`。

### 2.4 fetch_books 排序（library.rs:88-112）

```sql
SELECT b.id, b.title, b.author, b.cover_path, b.library_path, b.added_at, b.last_opened_at,
       b.is_favorite, b.note, b.group_name, b.pinned_at, r.percent
FROM books b LEFT JOIN reading_state r ON r.book_id = b.id
ORDER BY (b.pinned_at IS NULL) ASC, COALESCE(b.pinned_at, 0) DESC,
         COALESCE(b.last_opened_at, b.added_at) DESC
```

置顶书排最前（最近置顶的在前），其余按最近阅读/添加倒序。list_favorite_books（favorites.rs:21-44）排序不动，仅 Book 字面量补三个 `None`。

### 2.5 导入嗅探（library.rs import_book）

- 读源文件前 5 字节：以 `%PDF-` 开头 → `Err("暂不支持该格式（PDF 见路线图批次4）")`，不看扩展名。
- 扩展名（小写）：`.epub` → 现有复制流不变；`.txt` → TXT→EPUB 转换流（2.6）；其它扩展名 → 同样的"暂不支持"错误。
- `.txt` 转换流：整读字节 → `txt::decode_txt`（失败则 Err，不落库不落盘）→ `txt::txt_to_epub(title_stem, text)` → `atomic_write_to` 写入 `books/{id}.epub.part` 再 rename（复用现有原子写）。txt 分支跳过 `extract_epub_metadata`（自己生成的 EPUB，title=文件名 stem、author=None、无封面）。library_path 仍为 `library/books/{id}.epub`，删除/回收站链路零改动。

### 2.6 TXT→EPUB 转换（新模块 src-tauri/src/txt.rs，纯函数）

**编码检测 `decode_txt(bytes) -> Result<String, String>`**：UTF-8 BOM → 剥前缀 `String::from_utf8`；UTF-16LE/BE BOM → `encoding_rs::UTF_16LE/BE.decode_with_bom_removal`；否则 `String::from_utf8` 成功即用；失败 → `encoding_rs::GBK.decode_with_bom_removal`（WHATWG 规范中 GBK label 即 gb18030 解码器，超集兼容），`had_errors` 则 `Err("TXT 解码失败：仅支持 UTF-8 / GBK(GB18030) 编码")`。

**章节切分 `split_chapters(text) -> Vec<Chapter>`（title + 段落行）**：逐行（\n 分），trim（含 \r）。规则池按序命中，Rust `regex` crate **不支持环视**，legado 正则里的负向前瞻改为"匹配后字符续词表"后置检查：

- R1 `^\s{0,4}第\s{0,4}[\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,12}\s{0,4}(章|节|卷|回|部|集|篇)(.{0,30})$`；后置拒绝：单位后紧跟 续词——节→课、部→分|赛|游、集→合|和、篇→张。
- R2 `^\s{0,4}(序章|序言|楔子|引子|正文|终章|尾声|后记|番外|结局)(.{0,20})$`；后置拒绝：正文 后紧跟 完|结。
- R3 `^\s{0,4}(?i)(chapter|part|section|vol\.?|no\.?)\s*\d{1,4}(.{0,40})$`。
- R4 `^\s{0,4}\d{1,4}[、.．:：]\s*\S{0,20}$`（数字+分隔符标题行）。
- R5 `^\s{0,4}\d{1,4}$`（纯数字短行）。

首个标题前的正文归入独立章"开头"。规则零命中（命中数 < 1）→ 兜底按段落累计 ~10_240 字符切块，命名"第N章"（N 从 1）。单章 > 100_000 字符 → 在段落边界拆分，标题加 `(1)(2)…` 后缀。

**EPUB3 生成 `txt_to_epub(title, text) -> Result<Vec<u8>, String>`**：zip::ZipWriter；`mimetype` 第一个条目 STORED 不压缩（内容 `application/epub+zip`），其余 Deflated：`META-INF/container.xml`（标准 OEBPS/content.opf 指针）、`OEBPS/content.opf`（EPUB3，dc:title=传入标题、dc:language=zh、dc:identifier=urn:uuid、dcterms:modified、manifest 含 `properties="nav"` 的 nav.xhtml + 各章 item、spine 顺序 itemref）、`OEBPS/nav.xhtml`（`epub:type="toc"` nav 一层 ol/li/a）、`OEBPS/text/chNNNN.xhtml`（四位零填充；h1 标题 + 段落 `<p>`）。转义：`escape_xml` 替换 `& < >` 并剔除 XML 1.0 非法字符（0x00-0x08、0x0B、0x0C、0x0E-0x1F）。空文本 → Err("TXT 内容为空")。分页/主题/书签/搜索全走现有 epub.js 管线，零前端适配。

### 2.7 搜索章节化（reader.ts / ReaderPage / SearchPanel）

- reader.ts `search` 返回 `{ cfi, excerpt, sectionHref, percent? }[]`：`sectionHref = section.href` 去 `#` 锚点；`percent` 仅当 `book.locations.length() > 0` 时用 `percentageFromCfi(cfi)` 计算（locations 未生成则省略字段）。
- ReaderPage 用既有 flatToc 把 sectionHref 映射章节标题（比较前去 `#` 锚点，复用 chapterLabel 现有匹配逻辑，抽 `tocLabelFor(href)`），无匹配显示"正文"；映射在渲染期做（memo 依赖 searchResults + flatToc，toc 晚到可自愈）。
- SearchPanel 每行行首加章节小字标签（12px wr-muted）+ 行尾百分比（tabular-nums，无 percent 省略）。

### 2.8 文字封面卡（LibraryPage / weread.css）

升级首字占位为"书名+作者文字卡"：`.wr-cover` 现有渐变底不变，占位内容改为两行——标题（serif 750、12px、最多 2 行 line-clamp）+ 作者（10px、单行省略）。删除 `.wr-cover-letter` 类。纯 CSS，零依赖。

## 3. 任务分解（分区 file:line 指令，行号=HEAD 5adb5e1 基准）

实施顺序 A → B → C（B 的 TS 类型对齐 A 的 Rust 契约；C 完全独立）。三区文件互不重叠：A=src-tauri/**，B=LibraryPage.tsx / useCoverUrls.ts / invoke.ts / invoke.test.ts / weread.css / icons.tsx，C=reader.ts / ReaderPage.tsx / SearchPanel.tsx。invoke.ts 归 B 独占。

### 区A（后端，10 条）

- A1 `src-tauri/Cargo.toml:33` 后追加 `regex = "1"`、`encoding_rs = "0.8"`（仅声明，不安装不构建）。
- A2 `src-tauri/src/db/schema.sql:3-12` books 表 `last_opened_at INTEGER,` 后加 `note TEXT,`、`group_name TEXT,`、`pinned_at INTEGER,`（逗号随位置调整）。
- A3 `src-tauri/src/db/migrations.rs` 新增 `pub fn ensure_book_columns`（三条 ALTER，忽略 "duplicate column name"），`src-tauri/src/db/mod.rs:24` 后调用；migrations.rs tests 补：旧表（手工建无新列的 books）迁移后 PRAGMA table_info 含三列、二次调用 Ok。
- A4 `src-tauri/src/models.rs` Book 加三字段；UpdateBookMetadataRequest 改为 2.3 契约（删 title/author/cover 两对字段）。
- A5 `src-tauri/src/commands/library.rs` fetch_books（88-112）换 SQL（2.4，列序 8/9/10=note/group_name/pinned_at、11=percent）；fetch_book_by_id（127-147）SELECT 与构造同步加三列；import_book（227-303）加嗅探与 txt 分支（2.5，fallback_title 提前计算，txt 走 atomic_write_to 且 extracted=None）；update_book_metadata（305-360）重写：删 title/author/base64 封面逻辑，抽纯函数 `merge_metadata(existing: &Book, req, now: i64) -> Book` 供测试，UPDATE 三列后 fetch_book_by_id 返回；删顶部 `use base64::Engine`（5 行，变死导入）；import_book 的 Book 字面量（281-291）补三 None；tests：两个 Book 字面量补字段 + 新增 pinned 排序断言 + merge_metadata 三语义用例（None 不改 / 空串清除 / pinned true-false）。
- A6 `src-tauri/src/txt.rs` 新建（约 220 行含测试），公开 `decode_txt`、`split_chapters`、`txt_to_epub`；`src-tauri/src/lib.rs:5` 后加 `mod txt;`。单元测试覆盖：GBK 解码往返（用 encoding_rs::GBK.encode 造字节）、UTF-8 BOM 剥离、非法字节报错、R1/R2/R4 三条正则命中（含"第3节课"拒绝）、兜底 10KB 切块、100KB 长章拆分、escape 转义与控制字符剔除、EPUB zip 结构（首条目 mimetype STORED、container/nav/opf/章节文件齐全、opf 含 dc:title）。
- A7 `src-tauri/src/commands/favorites.rs:29-41` Book 字面量补 `note: None, group_name: None, pinned_at: None`（SQL 不动）。

### 区B（书库前端，5 条）

- B1 `src/tauri/invoke.ts`：Book 类型（3-13）加 note/group_name/pinned_at 三字段；UpdateBookMetadataRequest（23-29）改可选三字段契约（2.3）。
- B2 `src/tauri/invoke.test.ts` 补一条：`updateBookMetadata({ book_id: "b1", pinned: true })` 断言 `invokeMock` 收到 `("update_book_metadata", { req: { book_id: "b1", pinned: true } })`；imports 补 updateBookMetadata。
- B3 `src/pages/LibraryPage.tsx`：导入 dialog 过滤（76 行）改 `extensions: ["epub", "txt"]`；按钮文案（130 行）"导入 EPUB"→"导入图书"；onImport（83-96）收集失败路径，循环后 `window.alert` 一次（列出失败文件与"仅支持 EPUB 与 UTF-8/GBK 编码的 TXT"）；卡片 chip 行（149-163）加三个可点 chip：置顶/已置顶（`pinned` 契约，aria-pressed + data-pinned 高亮）、分组（`window.prompt("分组名称（留空清除）", b.group_name ?? "")`，null=取消不动、空串=清除）、备注（同 prompt 模式，`note`）；作者行下加 note 单行省略显示；书网格上方加排序 seg（wr-seg 复用：最近/书名，"书名"模式本地 sort：置顶优先 + `localeCompare(…, "zh")`）与分组筛选 select（wr-select 复用，仅当存在分组时渲染，"全部分组"+各组名）；booksFiltered 扩展为 过滤(分组+搜索)→可选排序。
- B4 `src/ui/weread.css`：删 `.wr-cover-letter`（701-711），新增 `.wr-cover-text`（absolute inset、列布局、底对齐、padding 8px 6px、z-index 1）、`.wr-cover-title`（var(--wr-serif)、750、12px、line-clamp 2）、`.wr-cover-author`（10px、rgba 白 72%、单行省略）、`.wr-note`（12px var(--wr-muted) 单行省略）、`.wr-chip-btn { cursor: pointer; font: inherit; }` 与 `.wr-chip-btn[data-pinned="true"] { border-color: rgba(var(--wr-accent-rgb), 0.5); }`。
- B5 icons.tsx：不需要（chip 用文字，无新图标）。

### 区C（阅读器，3 条）

- C1 `src/reader/epub/reader.ts`：导出 `SearchResult = { cfi: string; excerpt: string; sectionHref: string; percent?: number }`；ReaderController.search 签名（38 行）换该类型；search 实现（250-283）内层循环取 `sectionHref`（section.href 去 #）与 `percent`（新私有 helper `percentFromCfi(book, cfi)`：locations.length()>0 才算，非有限数返回 undefined）。
- C2 `src/pages/ReaderPage.tsx`：searchResults state（72 行）类型换 SearchResult[]；chapterLabel（132-136）重构为 `tocLabelFor(href)`（逻辑不变）+ chapterLabel 复用；新增 `searchRows = useMemo(() => searchResults.map(r => ({ ...r, chapter: tocLabelFor(r.sectionHref) ?? "正文" })), [searchResults, flatToc])`，SearchPanel（717 行）传 `results={searchRows}`。
- C3 `src/reader/components/SearchPanel.tsx`：results prop 类型（9 行）改 `{ cfi: string; excerpt: string; chapter: string; percent?: number }[]`；行渲染（47-51）在 excerpt 上加行首章节标签行（12px wr-muted、flex 两端、章节名省略、percent 显示 `Math.round(r.percent*100)%`，无 percent 省略）。

## 4. 验收要点（静态自查，无法运行测试）

- grep：`update_book_metadata` 请求不含 title/author/cover；`base64::Engine` 在 library.rs 无残留引用；`.wr-cover-letter` 全仓库零残留；`ImportBookRequest` 未被改动。
- 契约对拍：models.rs Book ↔ invoke.ts Book 字段名/可空性一一对应；UpdateBookMetadataRequest 两端一致（可选字段 = 不改语义）。
- 排序：置顶书永远在最前（SQL 三段 ORDER BY；"书名"排序模式在前端保持置顶优先）。
- TXT：GBK 文件可导入（测试用 encoding_rs 造字节）；PDF / 未知扩展名弹一次明确错误；转换产物 mimetype STORED 第一条。
- 搜索：结果行显示章节小字（无 toc 匹配显示"正文"）与百分比（locations 未就绪时省略）；跳转仍走 locate() 清选区逻辑（不动）。
- 既有行为零回退：cfi 定位、进度 flush（pagehide+1500ms 节流）、locate() 清选区、wheel×抽屉守卫、搜索去重/上限 200、metadataRepair 触发链。
- *.test.ts / #[cfg(test)] 与实现同步修改（人工比对，不运行）。

## 5. 跳过项与理由

- 拖拽导入及过滤：前端不存在 drop 处理代码（grep "drop" 仅 backdrop-filter）；新增拖拽是批次外新功能，后端嗅探已拒绝一切非法格式。待用户点名再做。
- 封面分批并行加载：useCoverUrls.ts:35-63 已全量并发（路线图"串行 for 循环"事实过期）。不改动。
- legado 的 512KB 块流式扫描：TXT 导入是一次性转换且本地文件，整读内存足够；流扫是为边读边翻页的低内存场景设计。不引入。
- nav 一层列表即可（扁平章节），不做 isVolume/卷结构树：epub.js 目录渲染与书签/跳转不依赖层级。
- ImportBookRequest 的 title/author/cover_* 死字段清理：批次外，避免涟漪（前端仍传 null）。
- "已置顶"角标/拖拽排序/书架编辑态：一层分组+置顶+排序已覆盖主流软件共识形态，其余为锦上添花。
- CRLF/行尾与既有文件保持一致；本 spec 为新文件无此约束。
