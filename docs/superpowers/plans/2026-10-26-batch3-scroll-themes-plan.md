# 2026-10-26 批次3 · 滚动模式与主题扩展 — 变更记录

对应 spec：../specs/2026-10-26-batch3-scroll-themes-spec.md。实施：3 分区（A 设置链+reader 核心 / B ReaderPage+面板 / C token/CSS+Rust 背景命令）+ 两路复核 + 修复轮。

## 交付
- 阅读模式 paginated|scrolled：rendition.flow() 直切（CFI 自动恢复）；scrolled 下 wheel/边缘热区/键盘/翻页按钮（animateTurn 单点守卫）全禁用，交 iframe 原生滚动；分栏选择跨模式保留；进度持久化路径不变。
- 六主题：light/sepia/green/gray/dark/darkcontrast，token 双文件（tokens.css 8 键×3 新块 + weread.css 15 键×3 新块），24 条 dark 组件覆盖扩展匹配 darkcontrast；旧值未知归一 light；normalize 测试 5→11。
- 自定义背景图：设置面板选图（png/jpg/webp ≤8MB）→ Rust save_reader_background 校验+单槽复制（3 个新测试）→ 阅读纸面 cover 渲染 + 实色主题纱（var(--wr-bg)、0.88，六主题正文对比度 ≥5.6:1 达 AA；暗色下不再透底）；恢复默认只改设置不删文件。
- SettingsPanel：模式段控、六色块主题网格（aria-label/title/选中环）、背景图入口+预览+恢复默认；scrolled 下翻页动画/版式控件禁用态（不隐藏）。

## 复核与修复
- build-correctness：scrolled 按钮路径漏禁→animateTurn 单点守卫修复；门禁未跑→本记录第 1 步已补跑全绿。
- ui-perf：暗色纱失效（critical，~1:1 对比）→改实色 var(--wr-bg)+0.88；green/gray 次级文字 4.14/3.82→#4d6052/#5b5b54（≥4.9:1）。
- 接受的 minor（2）：色块按钮 inline boxShadow 抑制 focus 光晕（2px outline 仍可见）；设置面板预览与阅读页各持一个 objectURL（生命周期无泄漏，抽屉开启期间双驻留 ≤8MB×2）。

## 构建门禁（本记录收尾时全绿）
npm build（tsc 零错误）/ vitest 53 / cargo check 零警告 / cargo test 36。未跑 tauri dev（用户指定跳过）。

## 实机验证清单（后续 GUI 冒烟）
滚动模式往返切换+进度恢复；六主题逐一切换（壳与纸面同步）；背景图设置/恢复/暗色下可读性。
