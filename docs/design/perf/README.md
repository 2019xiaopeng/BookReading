# 性能基线记录（v2.1.0 起点，2026-10-30）

方法：`npm run tauri dev`（WebView2 带 `--remote-debugging-port=9223`），playwright-core CDP 驱动；
窗口 800×600，刷新率 ~165Hz。采样 = 页面内 rAF 帧间隔统计 + CDP Performance.getMetrics 差值。
脚本与复测方法：本机 `%TEMP%\claude\F--bookreading-project\perf\harness.mjs`（会话外丢失可按本 README 重建）。

| 场景 | 参数 | 结果（10s 或注明） |
|---|---|---|
| shelfScroll 书架滚动 | /?shelf=13，61 卡，13574px，900px/s 下+上 | avgFps 135.8，p95 6.3ms，jank50=11，jank100=4，maxGap 394ms |
| comicPaged20 漫画翻页 | 302 页书，20 次下一页（450ms 间隔） | avgFps 156.4，maxGap 54.3ms，jank50=1 |
| comicWebtoon10s 条漫滚动 | 同书 webtoon 模式 900px/s | avgFps 128.6，p95 24.3ms，jank50=7，maxGap 78.8ms |
| epubOpenIdle30s 厚书开书后 30s 空闲 | 合成 350 章 EPUB（已导入，标题“性能测试·厚书350章(可删)”） | jank50=0（rAF 空闲平滑；epubjs locations 的 100ms/章 setTimeout 链不阻塞帧但持续占 CPU 35s+） |
| epubFontSlider 拖字号 | 20 步 125→170→120 | jank50=3，maxGap 66.7ms，LayoutDuration 0.3s（每步整章重排的累积证据） |

对照时点：根治包完成后（阶段一/二合并验证）一次；U7 UI 改版完成后一次。指标不得回退：
jank50 / jank100 / maxGap / p95 同场景对比，回退即返工。
