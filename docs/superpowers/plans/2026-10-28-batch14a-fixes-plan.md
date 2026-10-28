# 2026-10-28 批次14a · 综合修复 — 变更记录

P0 封面消失：回退 13b canvas 缩略管线（toBlob 在 WebView2 挂起→inflight 永占无错无重试），原图直出恢复；Rust 选最大图保留。
F11：capabilities 补 core:window:allow-set-fullscreen/-is-fullscreen（日志实锤）；dialog:allow-confirm 原已在。
locations 4096：同实例二次 generate 会混合粒度破坏二分——改新 Locations 实例；destroy 后 ctor 缺失不再 throw。
滚动 iframe 滚动条：THEME_STYLES 加 inkRgb，六主题注入 8px 细圆角 thumb（body + html:has 双作用域）。
书架判重：同级（含父 NULL）NOCASE 撞名拒绝（create/rename，改名撞自身跳过），+2 Rust 测试，前端透出错误。
拖拽：架→架（移入）与架→面包屑（上移一层）补齐；书→面包屑确认原已支持；无操作目标（当前父级）过滤不亮。
翻页速度：settings.turnSpeedMs 150-600 默认 260，fade/slide 比例驱动（260 与旧值逐毫秒一致），漫画滑动同源，SettingsPanel 滑条（scrolled 禁用）。

门禁：vitest 123 / cargo test 78 / tsc 零错误 / check 零警告。
行为变更：custom 排序下架卡互拖由"排序"改为"移入"（书排序不变）。