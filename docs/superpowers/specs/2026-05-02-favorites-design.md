# 收藏（书籍/句子）与收藏页设计

日期：2026-05-02

## 1. 目标

- 增加“收藏书籍”能力：对整本书进行收藏/取消收藏，并提供独立收藏书籍页面
- 增加“收藏句子”能力：阅读时选择文本，将选中文本作为“收藏句子”保存（文本快照 + CFI range），并提供独立收藏句子页面
- 收藏页支持：搜索、按书筛选、跳转定位到阅读器
- 补齐体验：导入封面提取、快捷键、滚轮翻页、双击沉浸
- 产物分支：在 CI 中构建 Windows 安装包（.msi/.exe），提交到单独分支

## 2. 数据模型

### 2.1 books 表新增字段

- `is_favorite INTEGER NOT NULL DEFAULT 0`

用于“收藏书籍”列表筛选。

### 2.2 新增 favorite_quotes 表

- `id TEXT PRIMARY KEY`
- `book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE`
- `cfi_range TEXT NOT NULL`
- `text TEXT NOT NULL`
- `note TEXT`
- `created_at INTEGER NOT NULL`

说明：
- `text` 为收藏当时的文本快照，用于收藏页直接展示与搜索
- `cfi_range` 用于跳转回阅读器定位（用 epub.js display(range)）

## 3. 后端接口（Tauri Commands）

### 3.1 收藏书籍

- `set_book_favorite(book_id: String, is_favorite: bool) -> Result<(), String>`
- `list_favorite_books() -> Result<Vec<Book>, String>`

### 3.2 收藏句子

- `add_favorite_quote(book_id: String, cfi_range: String, text: String, note: Option<String>) -> Result<FavoriteQuote, String>`
- `delete_favorite_quote(quote_id: String) -> Result<(), String>`
- `list_favorite_quotes(book_id: Option<String>, query: Option<String>) -> Result<Vec<FavoriteQuote>, String>`

查询规则：
- `book_id` 为空：全库
- `query` 为空：不做文本过滤
- `query` 非空：`text LIKE %query%`（首版使用 LIKE，后续可升级 FTS）

## 4. 前端页面与交互

### 4.1 路由与入口

- 新路由：`/favorites`
- 入口：
  - 书库页顶部增加“收藏”按钮
  - 阅读页顶部/侧栏增加“收藏”入口（可复用同一路由，跳回时记住书与位置）

### 4.2 收藏页结构

`/favorites` 页面使用 Tab：
- Tab1：收藏书籍
  - 列表展示：封面/标题/作者
  - 操作：打开阅读、取消收藏
- Tab2：收藏句子
  - 顶部：搜索框 + 书籍筛选下拉（来自 books 列表）
  - 列表：书名 + text 摘录 + note（若有）
  - 操作：跳转阅读定位、删除收藏

### 4.3 阅读页收藏句子

- 当用户选中文本：
  - 现有“标注（高亮 + 笔记）”保持不变
  - 新增“收藏句子”动作：
    - 获取选中文本 `text` 与 `cfiRange`
    - 弹出输入框填写 note（可空）
    - 调用 `add_favorite_quote`
    - 收藏句子页可见并可跳转

## 5. 补齐体验

### 5.1 导入封面提取

- 前端导入 EPUB 时通过 epub.js 提取封面 blob（若存在）
- 转 base64 发送给后端 `import_book`
- 后端将封面写入 `library/covers/{bookId}.{ext}` 并记录到 `books.cover_path`

### 5.2 快捷键

- 阅读页：
  - `ArrowLeft` / `ArrowRight`：上一页/下一页
  - `Ctrl+F`：切换到搜索面板并聚焦
  - `Ctrl+D`：切换沉浸模式
  - `Ctrl+B`：添加书签

### 5.3 滚轮翻页与双击沉浸

- 阅读区监听 wheel（节流，向下 next，向上 prev）
- 双击阅读区切换沉浸模式

## 6. Windows 安装包产物分支

### 6.1 目标

- 通过 GitHub Actions 在 Windows runner 构建 Tauri 安装包
- 将 `src-tauri/target/release/bundle/` 下的安装包文件拷贝到仓库的一个专用分支（例如 `artifacts/windows-installers`）
- 主分支不提交大体积安装包

### 6.2 约束

- 使用 `GITHUB_TOKEN` 推送到同一仓库（需要 `contents: write` 权限）
- 分支更新策略：每次构建覆盖旧内容（force push 或清空后提交）

## 7. 验收标准

- 书库页可收藏/取消收藏书籍，收藏页 Tab 能看到收藏书籍并可打开阅读
- 阅读页可收藏句子（保存 text+CFI），收藏页 Tab 能检索/筛选/删除/跳转
- 导入书籍可自动提取封面并在书库展示
- 快捷键、滚轮翻页、双击沉浸可用
- GitHub Actions 可生成 Windows 安装包并提交到独立分支

