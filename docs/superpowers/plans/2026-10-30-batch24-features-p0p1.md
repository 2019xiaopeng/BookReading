# 批次24：功能补齐 P0/P1（交付文档阶段三）

执行：agent E + 主控补 ImageReader 两行（E 所有权外）。npm test 22 文件 162 用例全绿，tsc 零错。

## P0
- **划选复制**：选区气泡加"复制"钮（navigator.clipboard），高亮/收藏/笔记流不动
- **漫画设置按书记忆**：settings 键 imgset:<bookId> 覆盖键（rtl/layout/fit/webtoonWidth/doubleOffset），全局键作默认；面板只钉被改字段，显示合并生效值；PDF 同键（书型互斥）
- **阅读时长**：可见态 1s 累计、60s 落库、隐藏/关书补尾款（reading_sessions 表）；书卡第二枚 chip「已读 X」+ 详情「时长」行（formatReadingTime 纯函数）
- **标注导出**：标注抽屉/收藏摘录/书详情三入口 → save 对话框 → export_annotations 生成 Markdown

## P1
- **高亮 text 收口**：quick-highlight 写 text 列（不再塞 note）；面板原文+笔记双行、色点用 color 列；后端迁移见批次20
- **书库全局搜索**：搜索源改全库 books，跨书架命中直接列书卡可打开
- **字号快捷键**：Ctrl+= / Ctrl+- / Ctrl+0（±5 钳 80-200）
- **双页偏移**：doubleOffset 0|1（封面独占），buildSpreads 第 4 参 + 按书记忆；ImageReader 两处调用传参由主控补
- **PagesPanel**：打开滚到当前页 + 页码输入直达（钳 1..N）
- **mobi/azw3 评估**：确认降级 P2——纯 Rust 生态唯一活跃 crate kindling-mobi 是写出器非解析器，KF8/AZW3 解析空白（交付文档 >3 天规则）

## 顺带
- FavoritesPage refreshBooks 瘦身（去掉仅为摘录 tab 的全量 listBooks 搭车）；importRunner 的全量 listBooks 是查重索引必须保留，未动
