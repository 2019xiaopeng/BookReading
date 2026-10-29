# 批次20：Rust 后端性能根治 + 数据层 + 新命令（v2.5.0 阶段一§2/§4 + 阶段二§5/§7 + P0 后端）

执行：agent A。范围：仅 src-tauri/**。cargo check 零警告，cargo test 97 过（新增 7）。

## 命令层
- 全部 40+ 命令 `#[tauri::command(async)]` 化（多页读盘不再阻塞主线程/IPC 串行）
- AppState：页列表缓存（目录/CBZ mtime 失效，relink 显式清）+ CBZ ZipArchive 句柄复用（消除每页重开 zip 的 O(N²)），全部 Mutex 保护与 async 捆绑
- read_image_page 增 maxWidth 可选参（LANCZOS3 降采样，JPEG q85/透明 PNG，超限才解码、已知尺寸不超限直通）

## 缩略图管线（阶段二§5）
- image = "0.25"；缩略档 covers/thumbs/{id}：不透明→JPEG q80（.jpg），透明→无损 webp（.webp）；宽 480 只缩不放大（≤480 小图不落盘，前端回退原图）
- 生成点：导入/换封面/重提取/修复元数据/清理重建；generate_cover_thumbs() 后台线程存量补生成（幂等，启动自动触发），事件 cover-thumbs-progress {done,total}
- webp 有损需 libwebp C 库不可用 → 退 JPEG 主路径（交付文档预案）

## 数据层（阶段二§7）
- 托管 Mutex<Connection> + WAL + busy_timeout 5000 + foreign_keys；迁移机制不动（ensure 幂等，真实库无损升级，单测覆盖）
- 二级索引：books(shelf_id)、book_tags(book_id)、highlights(book_id)、reading_state(book_id)
- migrate_library_root 持锁全程 + wal_checkpoint(TRUNCATE) 后复制（并发化后的等价串行保证）

## 新表/新命令
- get_book / set_settings（批量）
- book_locations 表 + save/load_book_locations（EPUB locations 持久化，配 D7）
- reading_sessions 表 + add_reading_time（当日 upsert 累加）/ list_reading_times（配 E3 阅读时长）
- highlights 加 text 列 + 存量回填（text:=note where null；note==text 的行 note:=''——quick-highlight 曾塞 note 的痕迹，零数据丢失）；list_highlights 返 text；add_highlight 增 text 参（配 E5）
- export_annotations(bookId?, destPath)：Markdown（书名/原文/笔记/颜色/收藏摘录），UTF-8 无 BOM
- tauri.conf.json：minWidth 720 / minHeight 480 / center；tauri-plugin-window-state 注册（记住窗口大小/位置）

## 与文档不符（以代码为准）
- 标注表实名 highlights（非 annotations）
- DB 无章节列，导出以 cfi 作定位参考
- clear_cache("covers") 连 thumbs 一并清（目录包含关系，重建走幂等 backfill）
- AVIF 解码需 dav1d C 库不在默认特性：宽高 0/0、降采样回退直通（安全）

## 遗留
- 用户真实库升级实测由主控联调做（已先备份 app.sqlite 到桌面）
