# 2026-10-28 批次12b · 全局 UI 修复 — 变更记录

深色弹层白底：根因=原生 select 弹层取控件自身背景（Chromium/Win）——.wr-select 改不透明 --panel-solid+option 同步，theme.ts applyDom 内联 colorScheme 兜底，tag 弹层补 ink 色。
封面清晰度：链路分析无损（cover 有效分辨率≥contain），无 bug；保持现状，高清出口=设置封面。
拖拽红圈：根因=Tauri2 dragDropEnabled 默认接管 DOM 拖放（WebView2 OLE）——内部拖拽整体改 Pointer Events（>5px 判定/elementFromPoint 目标/自绘 ghost/Escape 取消/拖后 click 抑制），OS 文件拖入导入不受影响；删光 HTML5 DnD。
侧栏闪烁：根因=每路由各挂 AppShell——书架树上提模块级 store（useSyncExternalStore 同源消费）+背景单槽缓存首帧播种+BOOKS_CHANGED_EVENT 驱动刷新（替 window focus），切视图零闪烁。
绿色活力点回归：.wr-live-dot（呼吸光晕，reduced-motion 关停）仅"本地库"与"读到%"两处。
四宫格立体感：gap 3px+每格内描边圆角+底部 inset 微阴影++N 徽标墨色实底反色字。

门禁：vitest 120 / tsc 零错误 / 零 Rust。
待真机验证：pointer 拖拽四场景；深色 tag 弹层如仍白底需截图再查。