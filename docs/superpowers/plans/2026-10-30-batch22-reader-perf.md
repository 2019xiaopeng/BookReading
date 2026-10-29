# 批次22：阅读链路性能（v2.5.0 阶段一§2.5/§3.2-3.4/§4.3 + 阶段二§6 + §8 + PDF 廉价修）

执行：agent D。范围：src/reader/**、ReaderPage.tsx、invoke.ts(+test)。npm test 21 文件 149 用例全绿（新增 12 例），tsc 零错。

- D1 模式切换闪烁：ImageReader 模式 effect 补 setAnchor(currentPageRef)
- D2 缩放/平移 rAF 化：手势期直写 style.transform + rAF 合帧，200ms 尾随提交兜底，pointerup 落 state；resetZoom/模式切换/滚轮统一走 applyZoomNow/commitZoomNow
- D3 页元数据占位：消费 list_image_page_meta（失败静默回退）；条漫+翻页内联 aspect-ratio 精确预留；spreads 用元数据判 wide（解码后探测保留兜底）
- D4 大页降采样：readImagePage 第三参 maxWidth=显示宽×1.5×DPR（256px 分桶）；fit=original 取原图；缓存条目带 maxWidth，fit/mode/layout 变化自动重取
- D5 滑杆 onCommit：CommitSlider（字号/行距/翻页速度），拖动仅本地草稿，pointerup/keyup/blur 才 commit + resize；9 次串行 setSetting → 一次 setSettings 批量
- D6 开书双渲染：createReader 增 initialTarget，恢复 CFI 首显直达（URL cfi > reading_state），坏 CFI 退回第 1 章
- D7 locations 根治：去 30s 超时与 4096 降级循环；首显后 idle 启动生成；命中 book_locations 表直接 locations.load() 灌注；未命中 generate(1024) 后 5s 防抖持久化（saveBookLocations，cacheKey=fontFamily|fontSizePercent）；换字体字号自动重算
- D8 自定义字体生效：@font-face 注入 epubjs iframe（iframeFont.ts 单槽 blob，addStylesheetCss 幂等），doc.fonts.ready 后重排；开书单次渲染即正确分页；重排 effect 补 fontFamily 依赖。src/ui/readerFont.ts 成为死代码（后续批次清理）
- D9 章节预取：relocated 时预 load 相邻章 section（去重，section.load 自带缓存）
- D10 ReaderPage 轻拆：ReaderTopBar/ReaderFooter/Memo 双设置面板抽出 + 源头 memo；回调全 useCallback；relocated 载荷值等价去重（sameRelocatedPayload）；seekTo display().finally 清拖动态。零行为变化
- D11 PdfReader：PageCanvas memo + useEffect([bitmap])；cacheKey 去 stageSize
- D12 ReaderPage 换用 get_book（不再全量拉书）

ImageSettingsPanel 条漫宽度/自动滚速滑杆不做 commit 化（CSS 实时预览不触发重排，无收益）。
联调点：新命令联调、厚书 locations 二次开秒开、自定义字体 iframe 生效、漫画缩放跟手、向上滚无视口推动（见验收清单）。
