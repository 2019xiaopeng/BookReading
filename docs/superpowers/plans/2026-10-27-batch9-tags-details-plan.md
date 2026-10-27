# 2026-10-27 批次9 · 标签系统与详情页 — 变更记录

数据：tags 表（name UNIQUE/color hex 白名单/sort_order）+ book_tags 复合主键双 CASCADE + books.description/content_chars/file_size；9 命令（CRUD/换色/合并去重/全量替换/批量打标幂等/compute_book_stats 回填 file_size——文件夹书求和子文件）；fetch_books 带 tags 聚合；update_book_metadata 扩 author/description（None 不改/空串清除）。

前端：详情对话框（封面点击更换、标题/作者/简介一次保存、标签 chips 增删+输入联想建新、统计行：格式/文件名/大小/页数/导入时间/进度/书架路径，file_size 缺失自动补算）；筛选行（标签多选 AND + 阅读状态 select + 管理标签）；搜索扩展文件名 basename；批量条"打标签"；标签管理（改名/8 色/合并/删除确认）。readingStatus 纯函数（未读/在读/已读 0.95 阈值）+测试。

门禁：vitest 109（+7）/ cargo test 58（+7）/ tsc 零错误。

定案：content_chars v1 不填（显示"—"）；章节数字段缺失跳过；book_count 只计未软删。