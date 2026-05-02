# EPUB 桌面阅读器（Windows）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Windows 上交付一个基于 Tauri + React 的 EPUB 桌面阅读器，支持书库导入/删除、沉浸式阅读、目录/进度、书签/标注、全文搜索与主题设置。

**Architecture:** Tauri(Rust) 负责书库文件管理与 SQLite 持久化，通过 Tauri commands 提供 API；React(WebView) 负责 UI 与 EPUB 渲染（epub.js），并在前端构建全文搜索索引（IndexedDB 缓存）。

**Tech Stack:** Tauri + Rust（rusqlite）、React + TypeScript + Vite、epub.js、Vitest/RTL、SQLite

---

## 0. 仓库结构（落地后）

**根目录：**
- `src/`：前端 React 代码
- `src-tauri/`：Tauri Rust 代码
- `docs/`：规格与计划文档

**Rust 侧建议结构：**
- `src-tauri/src/main.rs`：Tauri 初始化、注册 commands
- `src-tauri/src/app_paths.rs`：应用数据目录与书库目录的统一获取
- `src-tauri/src/db/mod.rs`：SQLite 初始化、迁移、连接获取
- `src-tauri/src/db/schema.sql`：建表 SQL（首版）
- `src-tauri/src/models.rs`：序列化用的结构体（Book/Bookmark/Highlight/ReadingState）
- `src-tauri/src/commands/mod.rs`：commands 聚合
- `src-tauri/src/commands/library.rs`：导入/列出/删除书籍
- `src-tauri/src/commands/reading.rs`：阅读进度/设置
- `src-tauri/src/commands/annotations.rs`：书签/高亮

**前端建议结构：**
- `src/app/router.tsx`：路由
- `src/pages/LibraryPage.tsx`：书库页
- `src/pages/ReaderPage.tsx`：阅读页
- `src/reader/epub/reader.ts`：epub.js 初始化、渲染与事件绑定
- `src/reader/search/index.ts`：全文索引构建与查询（IndexedDB 缓存）
- `src/tauri/invoke.ts`：对 `invoke()` 的类型封装

---

## Task 1: 初始化 Tauri + React 项目骨架

**Files:**
- Create: `src/`（脚手架生成）
- Create: `src-tauri/`（脚手架生成）
- Modify: `README.md`

- [ ] **Step 1: 使用 create-tauri-app 非交互脚手架初始化**

Run:
```bash
cd /workspace
npm create tauri-app@latest bookreading -- --template react-ts --ci
```

Expected:
- 输出包含 “Project created” 或等价成功提示
- 生成 `/workspace/bookreading/src-tauri` 与 `/workspace/bookreading/src`

- [ ] **Step 2: 将项目文件移动到仓库根目录（保持 README/docs 在根）**

Run:
```bash
cd /workspace
shopt -s dotglob
mv bookreading/* .
rmdir bookreading
```

Expected:
- 根目录出现 `src-tauri/`、`src/`、`package.json` 等

- [ ] **Step 3: 安装依赖并跑通 dev**

Run:
```bash
cd /workspace
npm install
npm run tauri dev
```

Expected:
- 启动一个桌面窗口，默认页面可加载

- [ ] **Step 4: README 更新（最小可运行命令）**

将 README 改为包含：
- `npm install`
- `npm run tauri dev`
- `npm run tauri build`

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "chore: scaffold tauri react app"
```

---

## Task 2: Rust 侧应用目录与 SQLite 初始化（含迁移）

**Files:**
- Create: `src-tauri/src/app_paths.rs`
- Create: `src-tauri/src/db/mod.rs`
- Create: `src-tauri/src/db/schema.sql`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/main.rs`
- Test: `src-tauri/src/db/mod.rs`（单元测试模块）

- [ ] **Step 1: 添加 Rust 依赖**

Modify `src-tauri/Cargo.toml` 增加依赖（版本以当前生态兼容为准）：
- `rusqlite`（启用 `bundled` 或系统 sqlite 取其一，Windows 上建议 bundled）
- `serde`, `serde_json`
- `uuid`
- `time` 或 `chrono`（二选一，统一用于 unix timestamp）

- [ ] **Step 2: 实现 app 数据目录与书库目录工具**

Create `src-tauri/src/app_paths.rs`，提供：
- `fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String>`
- `fn library_dir(app: &tauri::AppHandle) -> Result<PathBuf, String>`
- `fn books_dir(app: &tauri::AppHandle) -> Result<PathBuf, String>`
- `fn covers_dir(app: &tauri::AppHandle) -> Result<PathBuf, String>`
- `fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String>`

- [ ] **Step 3: SQLite 初始化与 schema 建表**

Create `src-tauri/src/db/schema.sql`（与 spec 对齐）：
- `books`
- `reading_state`
- `bookmarks`
- `highlights`
- `settings`

Create `src-tauri/src/db/mod.rs`：
- `pub fn init_db(app: &tauri::AppHandle) -> Result<(), String>`：创建目录 + 连接 db + 执行 schema.sql（可用 `execute_batch`）
- `pub fn open_db(app: &tauri::AppHandle) -> Result<rusqlite::Connection, String>`：打开连接（后续每次 command 使用短连接，首版足够）

- [ ] **Step 4: main.rs 启动时初始化 DB**

Modify `src-tauri/src/main.rs`：
- 在 `setup` 中调用 `init_db`
- 若失败，返回错误阻止启动（避免运行时后续全失败）

- [ ] **Step 5: 添加最小单元测试（不依赖真实 app）**

在 `src-tauri/src/db/mod.rs` 增加 `#[cfg(test)]`：
- 使用 `rusqlite::Connection::open_in_memory()`
- 执行 `schema.sql` 字符串（测试中可 `include_str!("schema.sql")` 的同路径拷贝，或把 schema 放到可 include 的位置）
- 验证关键表存在：

```rust
#[test]
fn creates_required_tables() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(include_str!("schema.sql")).unwrap();
    let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").unwrap();
    let names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert!(names.contains(&"books".to_string()));
    assert!(names.contains(&"reading_state".to_string()));
    assert!(names.contains(&"bookmarks".to_string()));
    assert!(names.contains(&"highlights".to_string()));
    assert!(names.contains(&"settings".to_string()));
}
```

- [ ] **Step 6: 运行 Rust 测试**

Run:
```bash
cd /workspace/src-tauri
cargo test -q
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src-tauri
git commit -m "feat(tauri): init app library paths and sqlite schema"
```

---

## Task 3: Tauri Commands（书库：导入/列表/删除）

**Files:**
- Create: `src-tauri/src/models.rs`
- Create: `src-tauri/src/commands/mod.rs`
- Create: `src-tauri/src/commands/library.rs`
- Modify: `src-tauri/src/main.rs`
- Test: `src-tauri/src/commands/library.rs`（单元测试：db CRUD 逻辑拆为纯函数可测）

- [ ] **Step 1: 定义模型与序列化结构**

Create `src-tauri/src/models.rs`：
- `Book { id, title, author, cover_path, library_path, added_at, last_opened_at }`
- `ImportBookRequest { source_path, title, author, cover_bytes_base64, cover_ext }`
- `ReadingState`, `Bookmark`, `Highlight`

要求：
- 全部 `#[derive(Serialize, Deserialize)]`
- 时间使用 unix timestamp（i64）

- [ ] **Step 2: 实现导入 command（复制 epub + 保存封面 + 写库）**

Create `src-tauri/src/commands/library.rs`：
- `#[tauri::command] pub fn list_books(app: tauri::AppHandle) -> Result<Vec<Book>, String>`
- `#[tauri::command] pub fn import_book(app: tauri::AppHandle, req: ImportBookRequest) -> Result<Book, String>`
  - 生成 `book_id`（uuid v4）
  - 复制 `req.source_path` 到 `books/{book_id}.epub`
  - 将 `cover_bytes_base64` 解码后写入 `covers/{book_id}.{ext}`
  - 插入 `books` 表
- `#[tauri::command] pub fn delete_book(app: tauri::AppHandle, book_id: String) -> Result<(), String>`
  - 查询 `library_path` 与 `cover_path`，删除文件（忽略不存在）
  - 删除 `books` 表记录（cascade 清理其他表）

错误处理：
- 所有对外错误返回 `String`，不要 panic
- 文件路径只存应用书库内路径，避免外部路径变化

- [ ] **Step 3: main.rs 注册 commands**

在 `src-tauri/src/commands/mod.rs` 导出上述函数；
在 `src-tauri/src/main.rs` 的 `invoke_handler` 注册。

- [ ] **Step 4: Rust 单测（只测 db 层）**

将 SQL 操作拆出为纯函数：
- `fn insert_book(conn: &Connection, book: &Book) -> Result<(), rusqlite::Error>`
- `fn fetch_books(conn: &Connection) -> Result<Vec<Book>, rusqlite::Error>`
并用 `open_in_memory + schema.sql` 测：
- insert 后能查到
- delete 后查不到

- [ ] **Step 5: 运行 Rust 测试**

Run:
```bash
cd /workspace/src-tauri
cargo test -q
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri
git commit -m "feat(tauri): add library commands (import/list/delete)"
```

---

## Task 4: 前端书库页（导入/删除/打开）

**Files:**
- Modify: `package.json`
- Create: `src/tauri/invoke.ts`
- Create: `src/app/router.tsx`
- Create: `src/pages/LibraryPage.tsx`
- Create: `src/pages/ReaderPage.tsx`（先放占位）
- Modify: `src/main.tsx` / `src/App.tsx`（以脚手架为准）
- Test: `src/pages/LibraryPage.test.tsx`

- [ ] **Step 1: 安装前端依赖**

Add deps:
- `react-router-dom`
- `epubjs`（包名以 npm 实际为准：`epubjs` 或 `epubjs-es`，以能 import 为准）

Run:
```bash
cd /workspace
npm install react-router-dom
npm install epubjs
```

- [ ] **Step 2: 封装 Tauri invoke API（带类型）**

Create `src/tauri/invoke.ts`：
- 定义 `Book`、`ImportBookRequest`
- 导出：
  - `listBooks(): Promise<Book[]>`
  - `importBook(req: ImportBookRequest): Promise<Book>`
  - `deleteBook(bookId: string): Promise<void>`

- [ ] **Step 3: 书库 UI**

Create `src/pages/LibraryPage.tsx`：
- 顶部：应用标题 + “导入 EPUB”按钮
- 列表：卡片（封面 + 标题/作者 + 最近阅读 + 删除按钮 + 打开）

导入流程（前端）：
- 使用 Tauri dialog 选择 epub 文件
- 使用 epub.js 读取文件（ArrayBuffer）提取：
  - `title` / `creator`（取不到则 fallback 为文件名）
  - cover：从 epub.js 获取 cover blob（取不到则为空）
- 调用 `importBook` 传入：
  - `source_path`
  - `title/author`
  - `cover_bytes_base64`（可空字符串）
  - `cover_ext`（例如 png/jpg；无封面时传空）
- 成功后刷新列表

删除流程：
- 二次确认（`confirm()` 或自定义对话框）
- 调用 `deleteBook` 后刷新

打开流程：
- 跳转 `/read/:bookId`

- [ ] **Step 4: 路由接入**

Create `src/app/router.tsx`：
- `/` -> `LibraryPage`
- `/read/:bookId` -> `ReaderPage`

- [ ] **Step 5: 前端测试（LibraryPage）**

Create `src/pages/LibraryPage.test.tsx`（Vitest + RTL；若脚手架未带测试框架，此 task 需要先补 Vitest 基建）：
- mock `listBooks` 返回 1 本书，断言卡片渲染
- 点击删除按钮触发 `deleteBook` 调用

- [ ] **Step 6: Commit**

```bash
git add src package.json package-lock.json
git commit -m "feat(ui): add library page with import/delete/open"
```

---

## Task 5: 阅读页接入 epub.js（渲染、翻页、图片）

**Files:**
- Create: `src/reader/epub/reader.ts`
- Modify: `src/pages/ReaderPage.tsx`
- Create: `src/reader/components/ReaderChrome.tsx`
- Test: `src/reader/epub/reader.test.ts`（偏逻辑层：设置注入与事件回调）

- [ ] **Step 1: ReaderPage 基础布局**

`ReaderPage` 包含：
- 顶部栏（返回书库、标题、设置按钮、沉浸切换）
- 主阅读容器 `<div id="epub-viewer" />`
- 侧边栏（先占位：目录/书签/搜索 tab）

- [ ] **Step 2: epub.js 渲染封装**

Create `src/reader/epub/reader.ts`，导出：
- `createRendition(opts)`：创建 book + rendition，返回控制器
- `applyTheme({ theme, fontSize, lineHeight, margin })`
- `goNext()/goPrev()/goToCfi(cfi)`
- 事件回调：
  - `onRelocated({ cfi, percent })`
  - `onTocLoaded(tocTree)`

输入：
- book 的来源：从后端 `listBooks` 获取 `library_path`，前端通过 Tauri fs 读取 bytes：
  - `readBinaryFile(library_path)` -> `Uint8Array` -> `ArrayBuffer` -> `ePub(arrayBuffer)`

- [ ] **Step 3: 翻页交互**

在 ReaderChrome：
- 左/右点击区域触发 prev/next
- 监听键盘 Left/Right

- [ ] **Step 4: 图片显示验证**

手动验证：
- 导入包含图片的 epub
- 打开后图片可显示（不破版）

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(reader): render epub with paging and image support"
```

---

## Task 6: 阅读设置（字体大小/主题/翻页动画）与沉浸模式

**Files:**
- Create: `src/reader/settings/types.ts`
- Create: `src/reader/settings/defaults.ts`
- Create: `src/reader/components/SettingsPanel.tsx`
- Modify: `src/pages/ReaderPage.tsx`
- Modify: `src-tauri/src/commands/reading.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Test: `src-tauri/src/commands/reading.rs`（db 持久化）

- [ ] **Step 1: Rust settings commands**

Create `src-tauri/src/commands/reading.rs`：
- `get_settings(app) -> Result<HashMap<String, String>, String>`
- `set_setting(app, key, value) -> Result<(), String>`

settings keys：
- `theme`：`light|dark|sepia`
- `fontSize`：数值字符串
- `pageAnimation`：`none|slide|fade`

- [ ] **Step 2: 前端 SettingsPanel**

实现：
- 字号 slider
- 主题 radio
- 翻页动画 select
变更时：
- 立即调用 `applyTheme` / `setAnimation`
- 同步写入 `set_setting`

- [ ] **Step 3: 沉浸模式**

实现：
- `isImmersive` 状态
- 隐藏顶部栏/侧边栏
- 鼠标移动顶部 20px 或按 `Esc` 临时显示
- 全屏切换（Tauri window API）

- [ ] **Step 4: Commit**

```bash
git add src src-tauri
git commit -m "feat: reader settings, themes, animations and immersive mode"
```

---

## Task 7: 目录与进度持久化（恢复上次位置）

**Files:**
- Modify: `src/reader/epub/reader.ts`
- Modify: `src/pages/ReaderPage.tsx`
- Modify: `src-tauri/src/commands/reading.rs`
- Test: `src-tauri/src/commands/reading.rs`

- [ ] **Step 1: Rust reading_state commands**

在 `reading.rs` 增加：
- `get_reading_state(app, book_id) -> Result<Option<ReadingState>, String>`
- `upsert_reading_state(app, book_id, cfi, percent) -> Result<(), String>`

- [ ] **Step 2: 前端绑定 relocated 事件**

`onRelocated`：
- 节流（例如 2s 一次）调用 `upsert_reading_state`
- UI 显示 percent

打开书籍：
- 读取 `get_reading_state`
- 若存在 `cfi`，在渲染完成后跳转到该 cfi

- [ ] **Step 3: 目录展示**

从 `onTocLoaded` 获取 toc tree：
- 侧边栏展示树
- 点击调用 `goToCfi` 或 `book.rendition.display(href)`

- [ ] **Step 4: Commit**

```bash
git add src src-tauri
git commit -m "feat: toc and reading progress persistence"
```

---

## Task 8: 书签与标注（高亮/笔记）与恢复

**Files:**
- Modify: `src-tauri/src/commands/annotations.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src/pages/ReaderPage.tsx`
- Modify: `src/reader/epub/reader.ts`
- Create: `src/reader/components/BookmarksPanel.tsx`
- Create: `src/reader/components/HighlightsPanel.tsx`
- Test: `src-tauri/src/commands/annotations.rs`

- [ ] **Step 1: Rust annotations commands**

Create `src-tauri/src/commands/annotations.rs`：
- bookmarks：
  - `list_bookmarks(app, book_id) -> Result<Vec<Bookmark>, String>`
  - `add_bookmark(app, book_id, cfi, label) -> Result<Bookmark, String>`
  - `delete_bookmark(app, bookmark_id) -> Result<(), String>`
- highlights：
  - `list_highlights(app, book_id) -> Result<Vec<Highlight>, String>`
  - `add_highlight(app, book_id, cfi_range, color, note) -> Result<Highlight, String>`
  - `delete_highlight(app, highlight_id) -> Result<(), String>`

- [ ] **Step 2: 前端交互**

书签：
- 当前页按钮“添加书签”
- 列表展示与跳转

标注：
- 选中文本后出现浮层：颜色选择 + “添加笔记”
- 保存 CFI range + color + note

- [ ] **Step 3: 打开书籍时恢复标注**

流程：
- `list_highlights` 拿到所有高亮
- 对每条调用 epub.js annotations API 恢复到 rendition

- [ ] **Step 4: Commit**

```bash
git add src src-tauri
git commit -m "feat: bookmarks and highlights with persistence"
```

---

## Task 9: 全文搜索（IndexedDB 缓存）与跳转

**Files:**
- Create: `src/reader/search/index.ts`
- Create: `src/reader/components/SearchPanel.tsx`
- Modify: `src/pages/ReaderPage.tsx`
- Modify: `package.json`
- Test: `src/reader/search/index.test.ts`

- [ ] **Step 1: 选择并接入搜索库**

优先：`flexsearch`（若安装与打包正常）。

Run:
```bash
npm install flexsearch
```

- [ ] **Step 2: 索引构建与缓存**

Create `src/reader/search/index.ts`：
- `buildIndex(book, { onProgress })`
  - 遍历 spine items，提取 text
  - `docId = spineIndex:offset`（或章节级 doc）
  - 写入 flexsearch
- 缓存策略：
  - IndexedDB 保存提取后的章节纯文本（key: `bookId:spineHref`）
  - 下次搜索优先从缓存加载文本，不再从 epub 解包读取

- [ ] **Step 3: SearchPanel UI**

搜索框：
- 输入关键字后展示结果列表（章节标题 + 摘要）
- 点击结果：
  - 若能拿到 CFI：跳转到 CFI
  - 否则跳转到章节 href 并在章节内高亮（首版可用浏览器 find 或简单 mark）

- [ ] **Step 4: 单测（纯逻辑）**

`index.test.ts`：
- 用一个最小 mock 文本数组构建索引
- 查询能返回命中 doc

- [ ] **Step 5: Commit**

```bash
git add src package.json package-lock.json
git commit -m "feat: full text search with cached index"
```

---

## Task 10: 端到端自检与打包

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 手动验收清单跑一遍**

验证：
- 导入/删除书籍（文件确实复制到 app data 下）
- 打开后图片显示正常
- 翻页与动画切换生效
- 字体与主题重启后保留
- 目录跳转可用
- 进度保存与恢复可用
- 书签/高亮/笔记重启后可恢复
- 搜索可用并能跳转

- [ ] **Step 2: Windows build**

Run:
```bash
npm run tauri build
```

Expected:
- 产物在 `src-tauri/target/release/bundle/`

- [ ] **Step 3: README 增加“已知限制/下一步”**

如：
- DRM EPUB 不支持
- 卷页动画未支持
- 搜索索引首次构建耗时与取消策略

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add usage notes and known limitations"
```

---

## Task 11: 推送到远端仓库

- [ ] **Step 1: 检查 remote**

Run:
```bash
git remote -v
```

- [ ] **Step 2: 推送**

Run:
```bash
git push -u origin main
```

