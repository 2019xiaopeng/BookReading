---
title: AppData Library Hardening Design
date: 2026-05-03
status: proposed
---

## 背景

当前应用在 Windows 上出现以下高频问题：

- 读取书籍/封面时触发 `allow-read-file` scope 校验导致 `forbidden path`，进而阅读器卡加载、封面不显示。
- 导入/删除非原子流程导致脏文件、残留文件，或数据库与磁盘状态不一致。
- 多处吞错导致“看起来没反应”，排障成本高。
- 读写路径依赖绝对路径，跨平台与安全边界不清晰。

本设计将文件访问模型收敛到“仅 App 库（AppData/library）”，并系统性补齐导入/删除原子性、路径安全、前端读取方式、错误可见性与性能问题。

## 目标

- 文件访问：所有书籍与封面只存在于 `AppData/library/...`，前端只通过 `BaseDirectory.AppData` 访问相对路径。
- 数据一致性：导入/删除/更新封面具备原子性与可恢复性，不留下脏文件。
- 安全边界：后端不信任 DB 中的绝对路径；删除/覆盖操作只允许发生在 library 根目录内。
- 可观测性：关键失败路径对用户可见（提示可复制），并可在本地留痕用于排障。
- 性能：阅读搜索等操作不造成章节常驻内存或明显内存泄漏。

## 非目标

- “直接打开外部任意路径 epub”模式（由用户选择为仅 App 库）。
- 多设备同步/云端库管理。

## 方案概述

### 文件布局（稳定）

- `AppData/library/books/<book_id>.epub`
- `AppData/library/covers/<book_id>.<ext>`
- `AppData/library/db.sqlite`（或现有位置保持）

### DB 字段（相对路径）

- `books.library_path`：从绝对路径改为相对 `library/` 的路径（例如 `books/<id>.epub`）
- `books.cover_path`：从绝对路径改为相对 `library/` 的路径（例如 `covers/<id>.jpg`）

### 前端文件读取（统一入口）

- 读取书籍：`readFile(rel, { baseDir: BaseDirectory.AppData })`
- 读取封面：同上 → Blob URL 渲染
- 严禁再走：
  - `readFile(绝对路径)`（触发 allow-read-file scope）
  - `convertFileSrc(绝对路径)`（依赖 asset 协议/权限与平台差异）

## 迁移策略

### 迁移触发

应用启动时（或首次访问 DB 时）执行一次“路径字段迁移”：

- 若字段已经是相对路径（不包含盘符/UNC/绝对前缀），跳过。
- 若是绝对路径：
  - 尝试找到 `.../library/<subpath>` 或 `...\\library\\<subpath>` 的切片，将 `<subpath>` 写回 DB。
  - 若无法判定，保留原值但标记为不可访问（前端显示“文件丢失/路径不受支持，可删除重导入”）。

### 兼容与回滚

- 迁移只改变 DB 字段，不移动文件；文件仍位于 library 目录的既有路径中。
- 若迁移失败，不阻塞启动，但需提示用户并允许删除损坏条目。

## 后端改动（Tauri commands）

### import_book 原子化

- copy 到 `books/<id>.epub.tmp`
- DB 事务 `INSERT books` 成功后将 `.tmp` `rename` 为 `.epub`
- 任一步失败：删除 `.tmp` 与可能生成的封面文件

### update_book_metadata 原子化

- 封面写入：写到 `covers/<id>.<ext>.tmp` → `rename` → 再清理旧封面（仅限 covers 目录内）
- 更新 title/author/cover_path 一次性写入

### delete_book 一致性

建议策略：

- 若书籍当前被占用（Windows 文件锁）：返回明确错误供前端提示“请先关闭阅读器后重试”。
- 删除顺序：
  - 优先尝试删除磁盘文件（book+cover）；如失败则返回错误（不删 DB）。
  - 删除成功后再删 DB 行（或 DB 事务化处理）。

### 路径安全

后端所有涉及删除/覆盖的路径必须满足：

- canonicalize 后位于 `library_dir` 下，否则拒绝。
- DB 不再存绝对路径，运行时通过 `library_dir.join(rel)` 组合得到真实路径。

## 前端改动

### LibraryPage

- 导入：后端 copy 后返回相对路径；前端从 AppData 读库内 epub 解析 metadata/cover，再调用 `update_book_metadata` 写回。
- 封面：从 AppData 读封面 bytes → Blob URL；书籍删除时 revoke 对应 URL。
- 删除：失败弹窗可见，避免静默失败。

### ReaderPage / createReader

- 打开 epub：只接收 AppData 相对路径；`readFile(rel, { baseDir: AppData })`。
- 失败可见：openFailed / displayerror / timeout 明确展示，可复制错误文本。
- 目录：解析失败不阻塞正文渲染；目录空则显示“暂无目录”。

### 搜索与内存

- 搜索逐章 load 后必须 unload，避免章节常驻内存。
- 封面 Blob URL 在页面卸载、列表刷新、删除书籍时全部 revoke。

## 权限与配置

- capability 保持最小权限，仅覆盖 AppData 相关目录。
- CSP 从完全关闭（null）收敛到最小可用策略（后续按实际资源加载逐步放开）。

## 测试与验收

- 后端：
  - import 原子性：模拟 DB insert 失败时不残留 `.tmp`
  - delete 一致性：文件删除失败时 DB 不应丢失记录
  - 路径校验：拒绝 library 外路径
- 前端：
  - 导入后封面可见（Blob URL）
  - 读书不再触发 forbidden path
  - 目录解析失败不再卡“加载中”
  - 多次刷新/切页无明显内存增长（至少 revoke URL）

## 风险与缓解

- Windows 文件锁导致删书失败：返回错误并引导关闭阅读器重试；必要时追加延迟清理机制。
- 迁移误判：仅写回可确定的相对路径；无法判定的条目保留并提示用户处理。
