# 收藏（书籍/句子）与收藏页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加收藏书籍与收藏句子（文本快照+CFI），提供收藏页（支持搜索/筛选/跳转），并补齐导入封面、快捷键、滚轮翻页、双击沉浸，同时增加 Windows 安装包构建并推送到独立分支的 CI。

**Architecture:** Rust(Tauri) 扩展 SQLite schema 与 commands；React 增加 FavoritesPage，并在 Library/Reader 处增加入口与调用；epub.js 负责从 selection 获取 cfiRange 与 text，并用于跳转到收藏定位；Windows 安装包由 GitHub Actions windows runner 构建并把 bundle 产物提交到专用分支。

**Tech Stack:** Tauri 2 + Rust(rusqlite) + React/TS + epubjs + GitHub Actions

---

## 文件结构（新增/修改）

- Modify: `src-tauri/src/db/schema.sql`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/commands/library.rs`
- Create: `src-tauri/src/commands/favorites.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/tauri/invoke.ts`
- Create: `src/pages/FavoritesPage.tsx`
- Modify: `src/app/router.tsx`
- Modify: `src/pages/LibraryPage.tsx`
- Modify: `src/pages/ReaderPage.tsx`
- Modify: `src/reader/epub/reader.ts`
- Create: `.github/workflows/windows-installers.yml`

---

## Task 1: 数据库 schema 升级（收藏书籍 + 收藏句子）

**Files:**
- Modify: `src-tauri/src/db/schema.sql`
- Test: `src-tauri/src/db/mod.rs`

- [ ] **Step 1: 修改 schema.sql**

在 `books` 表增加：
- `is_favorite INTEGER NOT NULL DEFAULT 0`

新增表 `favorite_quotes`：
- `id TEXT PRIMARY KEY`
- `book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE`
- `cfi_range TEXT NOT NULL`
- `text TEXT NOT NULL`
- `note TEXT`
- `created_at INTEGER NOT NULL`

说明：SQLite 对 `ALTER TABLE ... ADD COLUMN` 支持；现阶段 `schema.sql` 是“幂等建表”，因此需要对 `books` 的新增列用 `ALTER TABLE` 语句包一层“列不存在再加”。实现方式：

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS books (...原字段...);

ALTER TABLE books ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;

-- 如果重复执行可能报错：duplicate column name
-- 所以在 Rust init_db 中用 PRAGMA table_info(books) 判断后再执行 ALTER
```

- [ ] **Step 2: Rust init_db 增加迁移逻辑**

Modify `src-tauri/src/db/mod.rs`：
- 执行 schema 建表后
- 查询 `PRAGMA table_info(books)`，若无 `is_favorite` 列，则执行 `ALTER TABLE books ADD COLUMN ...`
- 创建 `favorite_quotes` 表（可继续放 schema.sql 的 CREATE TABLE IF NOT EXISTS）

- [ ] **Step 3: 运行 Rust 测试**

Run:
```bash
cd /workspace/src-tauri
cargo test -q
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db
git commit -m "feat(db): add favorites schema (book flag + favorite quotes)"
```

---

## Task 2: Rust 侧收藏 Commands（书籍/句子）

**Files:**
- Create: `src-tauri/src/commands/favorites.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/models.rs`
- Test: `src-tauri/src/commands/favorites.rs`

- [ ] **Step 1: models 增加 FavoriteQuote**

Modify `src-tauri/src/models.rs` 增加：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteQuote {
  pub id: String,
  pub book_id: String,
  pub cfi_range: String,
  pub text: String,
  pub note: Option<String>,
  pub created_at: i64,
}
```

- [ ] **Step 2: 实现 favorites.rs**

Create `src-tauri/src/commands/favorites.rs`：
- `set_book_favorite(app, book_id: String, is_favorite: bool) -> Result<(), String>`
- `list_favorite_books(app) -> Result<Vec<Book>, String>`
- `add_favorite_quote(app, book_id: String, cfi_range: String, text: String, note: Option<String>) -> Result<FavoriteQuote, String>`
- `delete_favorite_quote(app, quote_id: String) -> Result<(), String>`
- `list_favorite_quotes(app, book_id: Option<String>, query: Option<String>) -> Result<Vec<FavoriteQuote>, String>`

实现要点：
- `set_book_favorite`：`UPDATE books SET is_favorite = ? WHERE id = ?`
- `list_favorite_books`：`SELECT ... FROM books WHERE is_favorite = 1 ORDER BY ...`
- `list_favorite_quotes`：按 `book_id`/`query` 拼接 WHERE（query 用 `LIKE '%' || ? || '%'`）

- [ ] **Step 3: 注册 commands**

Modify `src-tauri/src/commands/mod.rs` 导出 favorites；
Modify `src-tauri/src/lib.rs` 加入 `tauri::generate_handler![...]`。

- [ ] **Step 4: Rust 单测（内存库 CRUD）**

在 `favorites.rs` 测：
- 插入 1 本书（含 is_favorite=0），set_book_favorite 后 list_favorite_books 返回 1 条
- favorite_quotes：add -> list -> delete -> list empty

- [ ] **Step 5: 运行 Rust 测试并提交**

Run:
```bash
cd /workspace/src-tauri
cargo test -q
```

Commit:
```bash
git add src-tauri/src/commands src-tauri/src/models.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): add favorites commands"
```

---

## Task 3: 导入封面提取（前端提取 + 后端写入）

**Files:**
- Modify: `src/pages/LibraryPage.tsx`
- Modify: `src-tauri/src/commands/library.rs`

- [ ] **Step 1: 前端导入时提取封面并传给 import_book**

在 `LibraryPage` 导入流程中：
- 使用 epub.js 获取 cover：
  - `const coverUrl = await book.coverUrl()` 或从 metadata/manifeset 获取（以实际 epubjs API 为准）
  - fetch / read blob -> ArrayBuffer
  - 转 base64（纯 base64，不含 data: 前缀）
- 调用 `importBook` 时传：
  - `cover_bytes_base64`
  - `cover_ext`（从 blob.type 推断 png/jpg；默认 png）

- [ ] **Step 2: 后端 import_book 已支持 cover 写入**

检查 `src-tauri/src/commands/library.rs`：
- 若 `cover_bytes_base64` 非空则写入 covers 并落库 `cover_path`
- 确保 ext 白名单：仅允许 `png|jpg|jpeg|webp`，否则忽略封面写入（防止路径注入）

- [ ] **Step 3: 构建并提交**

Run:
```bash
cd /workspace
npm run build
cd /workspace/src-tauri
cargo test -q
```

Commit:
```bash
git add src src-tauri/src/commands/library.rs
git commit -m "feat: extract and persist epub cover on import"
```

---

## Task 4: 收藏页（/favorites）+ 书库入口（收藏书籍）

**Files:**
- Create: `src/pages/FavoritesPage.tsx`
- Modify: `src/app/router.tsx`
- Modify: `src/pages/LibraryPage.tsx`
- Modify: `src/tauri/invoke.ts`

- [ ] **Step 1: 前端 invoke 增加 favorites API**

Modify `src/tauri/invoke.ts`：
- `setBookFavorite(bookId: string, isFavorite: boolean)`
- `listFavoriteBooks()`
- `listFavoriteQuotes(bookId?: string | null, query?: string | null)`
- `deleteFavoriteQuote(quoteId: string)`

- [ ] **Step 2: FavoritesPage（Tab：书籍/句子）**

Create `src/pages/FavoritesPage.tsx`：
- Tab1 收藏书籍：调用 `listFavoriteBooks`，卡片列表；点击打开跳转 `/read/:bookId`；取消收藏调用 `setBookFavorite(false)`
- Tab2 收藏句子：顶部搜索框 + 书籍筛选（用 `listBooks` 提供下拉）；列表展示 text+note；点击跳转 `/read/:bookId` 并携带 `?cfi=...`；删除调用 `deleteFavoriteQuote`

- [ ] **Step 3: 路由与入口**

Modify `src/app/router.tsx` 增加：
- `/favorites` -> `FavoritesPage`

Modify `LibraryPage`：
- 顶部增加“收藏”按钮 -> `/favorites`
- 每本书卡片增加“收藏/取消收藏”按钮：
  - 若 Book 暂无 is_favorite 字段返回，先用 `listFavoriteBooks` 结果做本地集合判断（后续 Task 2 后端返回字段再完善）

- [ ] **Step 4: 构建与提交**

Run:
```bash
cd /workspace
npm run build
```

Commit:
```bash
git add src package.json package-lock.json
git commit -m "feat(ui): add favorites page and book favorites"
```

---

## Task 5: 阅读页收藏句子（文本快照+CFI）与跳转

**Files:**
- Modify: `src/reader/epub/reader.ts`
- Modify: `src/pages/ReaderPage.tsx`
- Modify: `src/tauri/invoke.ts`

- [ ] **Step 1: reader.ts 暴露选中文本**

将 `createReader` 的 `onSelected` 回调扩展为：
- `(payload: { cfiRange: string; text: string })`

实现：
- epubjs `rendition.on("selected", (cfiRange, contents) => { ... })`
- `book.getRange(cfiRange)` 取 `range.toString()` 作为 text（失败则空字符串）

- [ ] **Step 2: ReaderPage 中添加“收藏句子”动作**

在 `onSelected` 中弹出选择（首版可简化为 confirm）：
- “收藏句子”：调用 `add_favorite_quote(bookId, cfiRange, text, note)`
- “仅高亮”：走已有 `add_highlight`

同时：
- ReaderPage 增加“收藏”侧栏 tab（与书签/标注/搜索/设置并列），展示该书收藏句子列表
- 支持删除与跳转

- [ ] **Step 3: 支持从 /favorites 跳转定位**

ReaderPage 读取 URL query `cfi`：
- 若存在，在 reader 初始化后 `display(cfi)` 并清理 query（可选）

- [ ] **Step 4: 构建与提交**

Run:
```bash
cd /workspace
npm run build
```

Commit:
```bash
git add src
git commit -m "feat(reader): favorite quotes from selection and jump to cfi"
```

---

## Task 6: 快捷键、滚轮翻页、双击沉浸

**Files:**
- Modify: `src/pages/ReaderPage.tsx`

- [ ] **Step 1: 快捷键**

在 ReaderPage 监听 `keydown`：
- Left/Right -> prev/next
- Ctrl+F -> 打开搜索 tab 并聚焦输入
- Ctrl+D -> toggle 沉浸
- Ctrl+B -> 添加书签（需要当前 cfi）

- [ ] **Step 2: 滚轮翻页**

在阅读容器监听 `wheel`：
- `deltaY > 0` -> next
- `deltaY < 0` -> prev
- 节流 300ms

- [ ] **Step 3: 双击沉浸**

在阅读容器监听 `dblclick` toggle 沉浸

- [ ] **Step 4: 构建与提交**

```bash
cd /workspace
npm run build
git add src
git commit -m "feat(reader): shortcuts, wheel paging and double click immersive"
```

---

## Task 7: GitHub Actions 构建 Windows 安装包并推送到独立分支

**Files:**
- Create: `.github/workflows/windows-installers.yml`

- [ ] **Step 1: 新增 workflow**

workflow 行为：
- 触发：`workflow_dispatch` + `push` 到 `main`
- 环境：`windows-latest`
- 步骤：
  - checkout（`fetch-depth: 0`）
  - setup node（`npm ci`）
  - setup rust toolchain
  - 安装 Tauri prerequisites（按 Tauri Windows 指南：WiX/NSIS；用 `choco install`）
  - `npm run tauri build`
  - 将 `src-tauri/target/release/bundle/` 拷贝到 `artifacts/windows/`
  - 提交到分支 `artifacts/windows-installers`（覆盖旧内容）

- [ ] **Step 2: 提交 workflow**

```bash
git add .github/workflows/windows-installers.yml
git commit -m "ci: publish windows installers to artifacts branch"
```

---

## Task 8: 推送主分支并触发 Windows 产物分支更新

- [ ] **Step 1: push main**

```bash
git push
```

- [ ] **Step 2: 触发 workflow（可选）**

在 GitHub Actions 手动运行 `windows-installers` 工作流，等待产物分支更新。

