# 2026-10-28 批次11a · 阅读器域修复 — 变更记录

P0 抽屉空白：根因=Drawer 头部复用 .wr-reader-topbar（批次6 改 absolute overlay）→头部锚到 overlay 全宽+grid 首行吞内容；头部换独立 .wr-drawer-head。六面板×双书型全查非空。
热栏：idle 2.5s→1.2s；点击即收（栏/热区外 pointerdown 立即 dismiss，iframe 中继）；栏出现纸面让位（data-chrome 驱动 padding 62px 过渡 200ms，epub 过渡后补 resize）。F11 窗口全屏（独立于沉浸，快捷键表补行）。漫画复原钮移左下 z17 避让；复原仅重置缩放保持当前页（transform 逆映射取中心页 scrollIntoView，绝不回跳）。
字体：默认栈改悦读组合（思源宋→Noto→等线→宋体回退）；自定义字体安装（ttf/otf/woff2 ≤20MB 单槽，@font-face wr-custom 注入，恢复默认删槽；Rust save/delete_reader_font +2 测试）。
条漫自动滚动：播放/暂停浮钮+速度滑条（20-240px/s 默认 60，持久化），rAF 帧距累积，滚轮/键盘/指针/翻页/换书即停，到底自动停+轻提示。

门禁：vitest 117 / cargo test 69 / tsc 零错误。
已知边界：热区 48px 带内 iframe 拖选/Ctrl 缩放仍被拦（修则热区唤栏失效，两害取轻）；拖滚动条不停自动滚动。