# AppData Library Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development where possible. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将书籍/封面文件访问彻底收敛到 AppData/library，相对路径持久化，修复 forbidden path、封面不显示、删书失败与卡加载等核心问题。

**Architecture:** 后端以 `library_dir` 为唯一根目录，DB 存相对路径；前端统一用 `BaseDirectory.AppData` 读取相对路径。导入/封面写入/删除采用 tmp + rename/事务，失败可见并可恢复。

**Tech Stack:** Tauri 2 (Rust), rusqlite, React/TS, @tauri-apps/plugin-fs, epubjs.

---

## Files & Ownership

**Backend**
- Modify: [schema.sql](file:///workspace/src-tauri/src/db/schema.sql)
- Modify: [db/mod.rs](file:///workspace/src-tauri/src/db/mod.rs)
- Modify: [library.rs](file:///workspace/src-tauri/src/commands/library.rs)
- Modify: [app_paths.rs](file:///workspace/src-tauri/src/app_paths.rs)
- Modify: [models.rs](file:///workspace/src-tauri/src/models.rs)
- Modify: [lib.rs](file:///workspace/src-tauri/src/lib.rs)
- Create: `src-tauri/src/db/migrations.rs`（若现有迁移结构缺失则创建）
- Create/Modify Tests: `src-tauri/src/commands/library_tests.rs`（或沿用现有 tests module）

**Frontend**
- Modify: [invoke.ts](file:///workspace/src/tauri/invoke.ts)
- Modify: [LibraryPage.tsx](file:///workspace/src/pages/LibraryPage.tsx)
- Modify: [FavoritesPage.tsx](file:///workspace/src/pages/FavoritesPage.tsx)
- Modify: [ReaderPage.tsx](file:///workspace/src/pages/ReaderPage.tsx)
- Modify: [reader.ts](file:///workspace/src/reader/epub/reader.ts)
- Create: `src/tauri/appDataPaths.ts`（集中处理 appData 相对路径、Blob URL 生命周期）

---

### Task 1: DB 字段相对路径化 + 迁移（P0）

**Files:**
- Modify: [schema.sql](file:///workspace/src-tauri/src/db/schema.sql)
- Modify: [db/mod.rs](file:///workspace/src-tauri/src/db/mod.rs)
- Create/Modify: `src-tauri/src/db/migrations.rs`
- Test: `src-tauri/src/db/migrations_tests.rs`

- [ ] **Step 1: 写迁移测试（RED）**

```rust
#[test]
fn migrate_paths_absolute_to_relative() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::db::SCHEMA_SQL).unwrap();

    conn.execute(
        "INSERT INTO books (id, title, author, cover_path, library_path, added_at, last_opened_at, is_favorite)
         VALUES (?1, NULL, NULL, ?2, ?3, 0, NULL, 0)",
        rusqlite::params![
            "b1",
            r\"C:\Users\me\AppData\Roaming\com.root.bookreading\library\covers\b1.jpg\",
            r\"C:\Users\me\AppData\Roaming\com.root.bookreading\library\books\b1.epub\"
        ],
    ).unwrap();

    crate::db::migrations::migrate_book_paths_to_relative(&conn).unwrap();

    let (cover, lib): (String, String) = conn
        .query_row("SELECT cover_path, library_path FROM books WHERE id = 'b1'", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(cover, "covers\\b1.jpg");
    assert_eq!(lib, "books\\b1.epub");
}
```

- [ ] **Step 2: 运行测试确认失败（RED）**

Run: `cargo test -q migrate_paths_absolute_to_relative`  
Expected: FAIL（找不到 migrations 或函数未实现）

- [ ] **Step 3: 实现迁移（GREEN）**

实现 `migrate_book_paths_to_relative(conn)`：
- 对每本书的 `library_path/cover_path`：
  - 若看起来已是相对路径（不含 `:\`、不以 `\\` 开头），跳过
  - 在字符串中查找 `\\library\\` 或 `/library/`，取其后部分作为相对路径（统一分隔符为 `\\`）
  - 无法判定则保留原值但不崩溃

- [ ] **Step 4: 在 DB init 时调用迁移（GREEN）**

在 [db/mod.rs](file:///workspace/src-tauri/src/db/mod.rs) 的 `init_db` 或 open 逻辑中调用一次迁移（幂等）。

- [ ] **Step 5: 运行全量 Rust 测试**

Run: `cargo test -q`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db src-tauri/src/db/mod.rs src-tauri/src/db/schema.sql
git commit -m "fix(db): migrate book paths to appdata-relative"
```

---

### Task 2: 后端导入/封面写入/删除原子化 + 路径校验（P0）

**Files:**
- Modify: [library.rs](file:///workspace/src-tauri/src/commands/library.rs)
- Modify: [app_paths.rs](file:///workspace/src-tauri/src/app_paths.rs)
- Test: `src-tauri/src/commands/library.rs` tests module

- [ ] **Step 1: 写导入原子性测试（RED）**

目标：模拟 DB 插入失败时不残留 `.tmp`。建议做法：将“落盘 + 写库”拆出内部函数并注入一个会失败的插入回调；测试时用临时目录作为 library 根（通过 `app_paths` 增加 test-only override）。

- [ ] **Step 2: 写路径校验测试（RED）**

目标：当 DB 路径被篡改为 library 外路径时，`delete_book` / `update_book_metadata` 不应删除该路径，并返回错误。

- [ ] **Step 3: 实现 import_book tmp+rename（GREEN）**

要点：
- copy 到 `books/<id>.epub.tmp`
- DB insert 成功后 `rename` 为 `books/<id>.epub`
- 任一步失败清理 tmp
- DB 存储 `books/<id>.epub`（相对路径）

- [ ] **Step 4: 实现 update_book_metadata 封面 tmp+rename（GREEN）**

要点：
- 写入 `covers/<id>.<ext>.tmp` → `rename`
- 仅当旧封面也在 `covers/` 下才删除（或 canonicalize 校验）
- DB 存储 `covers/<id>.<ext>`（相对路径）

- [ ] **Step 5: 实现 delete_book 一致性策略（GREEN）**

要点：
- 先解析相对路径拼接到 `library_dir`
- 删除失败返回可读错误（不要静默）
- 删除成功再删 DB 行

- [ ] **Step 6: 运行 Rust 测试**

Run: `cargo test -q`  
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/library.rs src-tauri/src/app_paths.rs
git commit -m "fix(library): atomic import/delete and safe path handling"
```

---

### Task 3: 前端统一 AppData 相对路径读取 + 封面 URL 生命周期（P0/P1）

**Files:**
- Create: `src/tauri/appDataPaths.ts`
- Modify: [LibraryPage.tsx](file:///workspace/src/pages/LibraryPage.tsx)
- Modify: [FavoritesPage.tsx](file:///workspace/src/pages/FavoritesPage.tsx)
- Modify: [ReaderPage.tsx](file:///workspace/src/pages/ReaderPage.tsx)
- Modify: [invoke.ts](file:///workspace/src/tauri/invoke.ts)

- [ ] **Step 1: 写 appData 相对路径工具（GREEN）**

`src/tauri/appDataPaths.ts`：
- `getAppDataBase()`（缓存 appDataDir）
- `toAppDataRelative(abs)`（严格校验：必须在 base 下；禁止 `..`、盘符、UNC）

- [ ] **Step 2: 封面读取统一封装（GREEN）**

同文件提供：
- `readAppDataBlobUrl(relPath, mime)`：读取 bytes 并 `URL.createObjectURL`
- `revokeObjectUrl(url)`：统一回收

- [ ] **Step 3: 替换 LibraryPage/FavoritesPage 封面展示（GREEN）**

要点：
- 不再使用 `convertFileSrc`
- 为每本书的封面 URL 建立 map
- 在组件卸载、书籍列表刷新、书籍删除后 revoke

- [ ] **Step 4: ReaderPage 只传相对路径（GREEN）**

要点：
- 后端返回的 `library_path` 为相对路径后，直接传给 `createReader`
- 若仍遇到旧数据绝对路径，显示“该书籍记录需要迁移/请重导入”

- [ ] **Step 5: npm build**

Run: `npm run build`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tauri/appDataPaths.ts src/pages/LibraryPage.tsx src/pages/FavoritesPage.tsx src/pages/ReaderPage.tsx
git commit -m "fix(frontend): appdata-only file access and cover url lifecycle"
```

---

### Task 4: Reader 搜索释放内存 + 错误可见性收口（P1）

**Files:**
- Modify: [reader.ts](file:///workspace/src/reader/epub/reader.ts)
- Modify: [ReaderPage.tsx](file:///workspace/src/pages/ReaderPage.tsx)

- [ ] **Step 1: 搜索 load/unload（GREEN）**

```ts
try {
  await section.load(book.load.bind(book));
  ...
} finally {
  section.unload?.();
}
```

- [ ] **Step 2: 错误提示一致化（GREEN）**

Reader 内部只负责产生结构化错误字符串；UI 统一展示并提供复制。

- [ ] **Step 3: npm build**

Run: `npm run build`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/reader/epub/reader.ts src/pages/ReaderPage.tsx
git commit -m "fix(reader): unload chapters after search and improve error reporting"
```

---

### Task 5: 权限与配置收口 + 回归验证（P1）

**Files:**
- Modify: [tauri.conf.json](file:///workspace/src-tauri/tauri.conf.json)
- Modify: `src-tauri/capabilities/*.json`（按实际）

- [ ] **Step 1: 恢复最小 CSP（GREEN）**

从 `csp: null` 改为最小策略（按当前资源需要逐步放开），确保本地 `tauri dev` 正常。

- [ ] **Step 2: 回归测试**

Run:
- `cargo test -q`
- `npm run build`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/capabilities
git commit -m "chore: tighten csp and capabilities for appdata-only mode"
```

---

### Task 6: 发布与验收（Release）

- [ ] 确认 GitHub Actions Windows build 产物已进入 Release（windows-latest tag）
- [ ] 在 Release Notes 中写明：
  - 安装包下载位置
  - 若旧库数据异常，提示“删除并重导入”或“自动迁移”
