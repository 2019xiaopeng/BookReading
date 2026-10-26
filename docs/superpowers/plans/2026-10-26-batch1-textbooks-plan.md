# 2026-10-26 批次1 · 文字书补全 — 变更记录

对应 spec：`../specs/2026-10-26-batch1-textbooks-spec.md`（路线图批次1）。全部静态自查（F 盘约束，未构建）。

## 实施结果

### A · Rust 后端
- Cargo.toml：+regex、+encoding_rs（GBK 解码必需）、−base64（死依赖）
- 新模块 src/txt.rs（466 行，9 测试）：decode_txt（BOM/UTF-8/UTF-16LE/BE/GBK 回落）；split_chapters（R1–R5 规则池含后置续词拒绝"第3节课"类误伤、无命中按 10_240 字符兜底切块、超 100_000 长章拆"(1)(2)"）；txt_to_epub（EPUB3：mimetype 首条 STORED、container/opf/nav/章节 Deflated、escape_xml 覆盖 &<> 并剔 XML 非法控制字符）
- import_book：5 字节魔数嗅探；%PDF- 拒绝并指路路线图批次4；扩展名分流 epub 复制 / txt 转换；错误消息带源路径
- migrations：ensure_book_columns 幂等加 note/group_name/pinned_at 三列（schema.sql 同步供全新安装）
- fetch_books：12 列 + 置顶优先排序 `(pinned_at IS NULL) ASC, pinned_at DESC, COALESCE(last_opened_at, added_at) DESC`
- update_book_metadata 复用为 {book_id, note?, group_name?, pinned?}（None=不改 / Some("")=清除 / pinned=true 存时间戳、false 存 NULL）；删除 title/author/cover 死字段与 base64 封面逻辑；8 处 Book 构造点同步

### B · 书库前端
- Book 类型与 UpdateBookMetadataRequest 同步；updateBookMetadata 通道复用
- 书卡三 chip：置顶（aria-pressed）、分组、备注（prompt 流：取消=不改、空串=清除、失败 alert）+ 分组筛选 + 最近/书名排序
- 文字封面卡 .wr-cover-text（书名两行截断 + 作者）替换首字占位；FavoritesPage 同步
- 导入对话框过滤 EPUB/TXT；失败汇总提示含 GBK 编码指引

### C · 阅读器搜索
- SearchResult {cfi, excerpt, sectionHref, percent?}；tocLabel.ts 纯函数 spine→章节标题（锚点两侧忽略、无匹配回落"正文"）+ 测试
- SearchPanel 行首章节小字 + 行尾 tabular-nums 百分比（无则省略）

## 复核与修复
- 契约复核（needs-fixes，4 minor）：txt.rs CRLF 归一、.wr-chip-btn 焦点环、base64 死依赖删除——均已修；tocLabel.ts 独立抽取与 FavoritesPage/metadataRepair.test 涟漪——备案无需修
- 正确性复核（工作流首跑失败后重跑）：MEDIUM×1 tocLabel.test.ts 类型导入错误（tsc 必挂）已修；TRIVIAL×1 空态文案补"或 TXT"已修；regex/zip/encoding_rs/SQL 列序/迁移幂等逐项核对无问题
- shortcut 注释×2：epub.js 实机打开生成 EPUB 待验；encoding_rs 待首次 cargo build 写入 Cargo.lock

## 跳过项（7，理由见 spec）
拖拽导入（仓库现状无 drop 代码，原"拖拽无过滤"为过期事实）；封面并行分批（现状已全量并发）；512KB 流式扫描；TXT 卷层级目录；title/author/cover 更新通道（判死删）；ImportBookRequest 死字段清理；置顶角标/拖拽排序/编辑态。

## 构建恢复后验证清单
1. `npm install && npm run test`（重点 normalize/layoutMode/tocLabel/invoke/metadataRepair）
2. `npm run build`（tsc）
3. `CARGO_TARGET_DIR=C:\cargo-target\bookreading cargo check`（新增 regex/encoding_rs 首次编译）
4. `cargo test`（txt.rs 9 测试 + 迁移/排序测试）
5. 真机：GBK TXT 导入→翻页/搜索/书签；置顶/分组/备注往返
