# 2026-10-27 批次4.5 · 全局主题与全局背景 — 变更记录

用户补充三点反馈的落地（无独立 spec，设计内联于实施）。

## 交付
- 主题记忆根治：根因=AppShell 的 theme prop 从无人传入，壳恒 light（阅读器其实一直在写库）。新 src/ui/theme.ts 单一事实源：import 时同步读 localStorage 设 html[data-theme]（首帧不闪白）、setTheme 双写 localStorage+settings 库、getSettings 回来后纠偏（本会话已改则跳过防回跳）、useSyncExternalStore 订阅。
- 全局主题切换：书架/收藏顶栏调色板图标 → .wr-menu 六色块即时切换；阅读设置面板色块驱动同一 store；epub iframe/漫画/壳三端同源；theme 从 ReaderSettings 移除（不再每书设置项）。
- 全局背景：reader_bg 升级应用级，src/ui/appBackground.ts 单槽 objectURL 缓存（全应用至多一份，换图/恢复时回收+作废），AppShell 根容器 cover 渲染 + color-mix 可读性纱；阅读纸面叠加不变；设置入口文案"全局背景"。换图旧缓存回归已修（SettingsPanel.saveReaderBackground 后 resetBackgroundCache）+测试。
- Minor 七项：死规则 .wr-selection×3 删除；ImageSettingsPanel 死 Props 与调用点传参删除；菜单 resize 重 clamp；分组 chips 细滚动条；wr-menu 入场 reduced-motion 守卫；选区气泡 wr-fade-out 150ms 退场（reduced-motion 直接卸载）；PagesPanel THUMB_LIMIT 60→24。

## 门禁
npm build（tsc 零错误）/ vitest 70（+7：theme 4 + appBackground 3+1）。Rust 零改动。

## 实机验证要点
重启应用主题恢复；壳顶栏切换六主题即时全端生效；换背景图立即更新（含同扩展名换图）；阅读器色块与壳入口互切一致。
