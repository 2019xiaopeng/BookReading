# 2026-10-28 批次10 · 存储管理与导入增强 — 变更记录

存储：library_root 可配置（settings 键，缺省 AppData/library，全部路径函数改造）；migrate_library_root（空间预检 1.1x、复制 books/covers/bg+db、失败清理不写设置）；storage_stats（分类字节+trash_count+db_path）；clear_cache（covers——文件夹书自动重拷首页、bg——删文件重置设置、logs；books/db 不可清）。
设置对话框（src/ui/SettingsDialog.tsx，侧栏设置入口）：存储（根路径/迁移向导/占用列表/一键清理）、数据（保留期只读）、关于（版本/db/库路径）、快捷键静态表。
拖拽导入：Tauri onDragDropEvent（绝对路径，文件+目录）；目录=逐本漫画导入；拖入 overlay 提示。
导入统一入口 importRunner：进度广播（i/N+当前名，壳级进度条）、去重（文件夹=绝对路径相同；文件=basename 或 标题+字节数，旧书 file_size 自动补算）、四类汇总（成功/已存在/疑似重复/失败+原因对话框）、BOOKS_CHANGED_EVENT 通知书库刷新。
插曲：importRunner.ts 曾因主会话编辑事故损毁，从 agent 转录逐 Edit 重建（字节级验证一致）并顺势修复去重 title 匹配缺陷。

门禁：vitest 114（+5）/ cargo test 67（+9）/ tsc 零错误 / check 零警告。