# 2026-10-26 批次2 · 漫画/图片书 — 规格（实现后回写）

本 spec 在实现完成后按真实代码回写（原设计 agent 无文件工具未能落盘；实现依据任务书契约，复核后逐条对齐）。路线图批次2。

## 契约（已实现）
1. 数据：books.format TEXT NULL（NULL/'epub'=文字书，'images'=图片书）+ books.page_count INTEGER NULL；迁移走 ensure_book_columns 幂等 ALTER；全部构造点同步。
2. 源与存储：图片文件夹=原地引用（library_path 存绝对路径，零复制；删书仅删记录+封面，源目录不动）；CBZ=复制进 library/books/{uuid}.cbz（便携语义）。
3. 命令（src-tauri/src/commands/images.rs）：import_image_folder(source_path, title_opt)（单层不递归、7 种扩展名白名单、自然排序、首图提封面、按扩展名分流文件夹/CBZ）；list_image_pages(book_id) -> Vec<String>；read_image_page(book_id, index) -> tauri::ipc::Response（原始字节，避免 JSON number[] 放大 4-6 倍）。
4. 前端 src/reader/image/：layout.ts 纯函数（双页配对、宽高比>1.2 跨页独占、RTL 交换与方向键反相、img:N 进度约定、设置归一化）+ 17 个测试；api.ts 命令封装（ArrayBuffer/number[] 双兼容）；ImageReader（分页模式：适高/适宽/原始三档+单双页+RTL；Webtoon 连续纵向滚动+IntersectionObserver 懒加载；预载 ±2 且 epoch+wantedRef 双守卫防驻留超标与卸载泄漏；失败页可点重试）；ImageSettingsPanel 精简面板（持久化 settings key image_reader_settings，JSON）。
5. ReaderPage 按 book.format 分支：漫画复用外壳（HUD/进度/沉浸/边缘热区/键盘），禁用 epub 专属（目录/搜索/书签/高亮/收藏/Ctrl+F/Ctrl+B），页脚"n / total"，进度复用 reading_state（cfi="img:N"、percent=N/总、1.5s 防抖+pagehide flush 同路径）。
6. 书库：导入按钮加"导入漫画"入口（dialog directory:true）；文件对话框加 .cbz；漫画书卡"漫画"徽标；文件夹引用书删除确认注明"源文件夹不会被改动"。
7. 审美：漫画纸面全幅沉浸（去卡片框/圆角/阴影/18px padding，暗色近黑底）；双页 0 缝；条漫无缝+键盘可达（tabIndex+aria-label+focus）；"原始"档 margin:auto 居中保滚动。

## 复核结论与修复（两路复核 12 条，11 修 1 纳）
critical 全修：书库入口缺失→补齐；删除文案→补齐；IPC JSON 数组→tauri::ipc::Response；卡片框→全幅；原始档裁边→margin:auto。medium 全修：暗色白晕→#0a0a0a、双页缝→0、条漫键盘→可达、失败页→可重试区分态、Blob 驻留越界→epoch+wantedRef。minor 接受：Webtoon 深恢复落点约值（占位高度估算，shortcut 注释在案）。

## 跳过项
真实页宽高比的持久缓存（首读后内存估算即可）；read_image_page 的 ArrayBuffer 端到端实机验证（需 GUI，用户跳过 dev）；图片书搜索/书签（无文本语义）；CBR/rar（拒绝，零新依赖红线）。

## 构建门禁（全绿）
npm run build ✓（tsc 零错误）、npm run test ✓（10 文件/47 测试）、cargo check ✓（零警告）、cargo test ✓（33 测试，含 images 3 新测试）。

## 实机验证清单（用户后续 GUI 冒烟）
导入一个真实漫画文件夹/CBZ → 三档适配/单双页/RTL/跨页/Webtoon/进度恢复/删除确认文案。
