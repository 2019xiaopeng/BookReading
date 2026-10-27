# 2026-10-27 批次4 · 十项实测反馈体验大修 — 变更记录

对应 spec：../specs/2026-10-27-batch4-experience-overhaul-spec.md。实施 3 分区 + 双路复核（25 条发现）+ 修复轮（9 条确认项全修，含 critical×2）。

## 修复与新增（对应用户反馈编号）
1 布局：收藏胶囊改心形图标+短文案；侧栏导入按钮图标+nowrap 纵排；删除移入"更多"菜单；.wr-btn/.wr-chip/.wr-pill/.wr-small-btn 全局溢出守卫；800×600↔全盘抽查。
2 封面：双根因（卸载 revoke+竞态漏载）→ 模块级会话缓存 + 退避重试(≤3) + 失败回补；重挂载即时渲染缓存。
3 主题四连：epub 主题色统一 THEME_STYLES（dark/darkcontrast 不透明纸面+前景 !important，根治暗色文字消失）；行距 body.<t> p !important + 同值跳过；spread 切换统一 clear→display(currentCfi)（根治单双栏错乱）；漫画主题跟随全局六主题（独立主题选择移除）。
4 滚动模式：footer/HUD/键盘统一 chapterNav(±1)（spine index），文案"上一章/下一章"。
5 选区气泡：锚定选区矩形 fixed 小气泡（高亮/收藏/笔记三图标钮，无复制无文字预览），选区清空/relocated/外点/5s 自动隐藏；iframe 按下中继。
6 排序：排序键（最近/书名/导入时间）×方向（升/降）。
7 进度条：role=slider 可拖动+键盘±1%（松手 cfiFromPercentage 跳转，拖动仅视觉）；locations 1024 超时→销毁旧实例→4096 重试一次+完成后补报（治大书无进度）；把手两端裁剪修复；:focus-visible；拖动中禁 width 过渡。
8 导航：收藏页底部按钮移除，改挂载+窗口聚焦静默刷新。
9 漫画：Drawer"页面"缩略图面板（懒加载、当前页高亮、点击跳页）+顶栏入口；翻页 250ms 滑入/滑出动画（reduced-motion 双守卫）；滑出层 pointer-events:none。
10 书架：重命名（update_book_metadata 扩 title，空白拒绝，+4 Rust 测试）；卡片精简（标题/作者/进度，作者进度 tooltip）；hover 浮出 置顶/更多 菜单（重命名/分组/备注/收藏/删除）；空白右键菜单（新建分组/导入×2/排序方向）；分组 chips（右键改名/删除）+卡片 HTML5 拖拽入组；五处 window.prompt 换 wr-prompt 对话框；danger 色 token 化；菜单键盘语义（方向键/Esc/还焦）。
旧账：色块钮 CSS 类化、设置面板背景预览复用单一 URL。

## 门禁
npm build（tsc 零错误）/ vitest 62（+11）/ cargo check 零警告 / cargo test 40（+4）。未跑 tauri dev。

## 遗留（minor，记档）
缩略图全尺寸 blob（THUMB_LIMIT=60，中期加 Rust 缩略命令）；选区气泡无退场动画；scrolled 下气泡坐标随滚动过期（5s 兜底）；分组 chips 无滚动提示；菜单 resize 不重 clamp；ImageReader/ImageSettingsPanel 缩进风格未统一；hover 工具钮盖标题尾部。
