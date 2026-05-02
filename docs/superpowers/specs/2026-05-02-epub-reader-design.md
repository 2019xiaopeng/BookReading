# EPUB 桌面阅读器（Windows）设计文档

日期：2026-05-02

## 1. 目标与范围

### 1.1 产品目标

- 提供一个 Windows 桌面端 EPUB 阅读器
- 支持将本地 EPUB 导入应用书库、管理增删
- 提供沉浸式阅读体验，支持图片内容展示
- 可调字体大小、主题、翻页动画
- 支持目录与阅读进度、书签/标注、全文搜索

### 1.2 MVP 范围（首版）

- 书库
  - 导入 EPUB（复制到应用书库目录）
  - 删除书籍（删除数据库记录并删除书库文件）
  - 书籍列表（封面/标题/作者/最近阅读时间）
- 阅读
  - 打开书籍并渲染图片与文本
  - 翻页（键盘/点击区域）
  - 翻页动画（none/slide/fade）
  - 字体大小调节
  - 主题（light/dark/sepia）
  - 沉浸模式（隐藏 UI，可全屏）
- 目录与进度
  - 目录树展示与跳转
  - 阅读进度展示与持久化（记住上次位置）
- 书签/标注
  - 书签：当前阅读位置一键添加/删除
  - 标注：高亮与笔记（颜色可选），持久化与恢复
- 全文搜索
  - 书内搜索与结果列表
  - 结果跳转到命中位置

### 1.3 明确不做（首版不保证）

- 云同步、账号体系
- DRM/加密 EPUB
- 听书（TTS）
- 跨设备同步
- 复杂“卷页”动画

## 2. 技术选型

### 2.1 推荐方案

- 桌面壳：Tauri（Rust）
- UI：React + TypeScript + Vite
- EPUB 渲染：epub.js（Rendition）
- 数据持久化：SQLite（Rust 侧通过插件/库访问）
- 全文索引：前端构建索引（FlexSearch 或等价方案，按依赖可用性确认）

### 2.2 选择理由

- Tauri 相比 Electron 体积更小、内存更低，适合“阅读器”这一长时运行应用
- epub.js 提供较成熟的 EPUB 解析/渲染、CFI 定位、目录读取能力
- SQLite 便于统一存储书库元数据、阅读位置、书签与标注数据

## 3. 架构与模块边界

### 3.1 总体架构

- 前端（WebView）
  - 书库页：展示、导入、删除、打开
  - 阅读页：渲染、目录、进度、书签、标注、搜索、设置
  - 状态管理：当前书籍、阅读设置、索引构建状态
- 后端（Tauri/Rust）
  - 文件系统：导入复制、删除、封面缓存目录管理
  - 数据库：书籍元数据、阅读状态、书签、标注、设置
  - 命令接口：以 Tauri command 暴露给前端

### 3.2 核心数据流

- 导入：前端选择文件 → 调用后端导入命令 → 复制到书库目录 → 解析元信息/封面 → 写入数据库 → 前端刷新列表
- 阅读：前端打开书籍 → 后端返回书库文件路径/或读取为 bytes（按 Tauri 资源策略选择）→ epub.js 加载 → 恢复上次 CFI → 渲染
- 进度/书签/标注：前端产生 CFI / CFI range → 调用后端持久化 → 下次打开恢复
- 搜索：前端触发 → 读取章节文本 → 构建索引 → 结果定位到 CFI → 跳转

## 4. 数据模型（SQLite）

### 4.1 tables

- books
  - id TEXT PRIMARY KEY
  - title TEXT
  - author TEXT
  - cover_path TEXT
  - library_path TEXT NOT NULL
  - added_at INTEGER NOT NULL
  - last_opened_at INTEGER
- reading_state
  - book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE
  - cfi TEXT NOT NULL
  - percent REAL
  - updated_at INTEGER NOT NULL
- bookmarks
  - id TEXT PRIMARY KEY
  - book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE
  - cfi TEXT NOT NULL
  - label TEXT
  - created_at INTEGER NOT NULL
- highlights
  - id TEXT PRIMARY KEY
  - book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE
  - cfi_range TEXT NOT NULL
  - color TEXT NOT NULL
  - note TEXT
  - created_at INTEGER NOT NULL
- settings
  - key TEXT PRIMARY KEY
  - value TEXT NOT NULL

### 4.2 关键约束

- 删除书籍必须联动删除 reading_state/bookmarks/highlights
- 数据库升级策略：使用 schema_version 表或 SQLite PRAGMA user_version

## 5. 书库文件组织

- 应用数据目录（Tauri app data dir）
  - library/
    - books/{bookId}.epub
    - covers/{bookId}.jpg|png
  - db/app.sqlite

## 6. 阅读器设计（epub.js）

### 6.1 渲染模式

- 使用 epub.js 的 paginated 模式
- 翻页输入
  - 键盘：Left/Right、PageUp/PageDown
  - 鼠标：点击左右区域
- 动画：none / slide / fade

### 6.2 样式与主题

- 通过注入 CSS 控制字体大小、行距、段落间距、背景色与文字色
- 预设主题：light/dark/sepia
- 支持持久化用户设置

### 6.3 沉浸模式

- 阅读页隐藏顶部栏与侧边栏，仅保留最小化交互区域
- 鼠标移动到顶部或快捷键唤出 UI
- 支持全屏切换

## 7. 目录与进度

- 目录
  - 解析 navigation/TOC
  - 树形展示，点击跳转对应章节（使用 epub.js goto）
- 进度
  - 基于 epub.js 提供的 location/percentage 计算
  - 退出与定时保存当前 CFI 与 percent

## 8. 书签与标注

- 书签
  - 当前 CFI 作为书签定位
  - 支持自定义标签与列表跳转
- 标注
  - 高亮：保存 CFI range、颜色
  - 笔记：在高亮基础上保存 note 文本
  - 打开书籍时恢复所有标注到 rendition

## 9. 全文搜索

### 9.1 实现策略

- 从 spine 逐章提取纯文本
- 构建索引并缓存（以 book_id 作为命名空间）
- 结果映射：
  - 优先使用章节内定位到段落或片段，再生成对应 range CFI
  - 若无法精确定位，退化到章节级跳转

### 9.2 体验约束

- 初次索引可能较慢，需要“索引中”提示
- 支持取消与重试

## 10. 安全与隐私

- 不上传用户书籍内容到网络
- 不在日志中打印用户书籍路径与书籍内容片段（除非用户显式开启调试）

## 11. 验收清单（MVP）

- 可导入任意本地 EPUB 到书库并在列表展示
- 可打开阅读并正确显示图片
- 可翻页，动画可切换（none/slide/fade）
- 字体大小与主题设置生效且重启后仍保留
- 目录可跳转章节；进度可保存与恢复
- 可添加书签与高亮标注，重开可恢复
- 可全文搜索并跳转到命中位置

