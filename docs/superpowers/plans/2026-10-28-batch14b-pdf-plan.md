# 2026-10-28 批次14b · PDF 支持（路线图终章） — 变更记录

依赖：pdfjs-dist 6.4.299（本批唯一新依赖，用户点名批准）。主库与 worker 均按需 chunk（动态 import，首个 PDF 打开才加载）；worker 用 `?url` hashed 资产（`build/pdf.worker.min.mjs?url` → dist/assets/pdf.worker.min-*.mjs），dev/生产同源可用。生产 worker 失败的回退路径：不设 workerSrc + `getDocument({ disableWorker: true })` 走主线程 fake worker（api.ts 头注释留档）。

导入链：`import_book`（Rust）魔数 `%PDF-` 优先、扩展名 .pdf 兜底 → 原样复制 `library/books/{uuid}.pdf`、format='pdf'、title=文件名、无封面（书架文字卡）、page_count 由前端 pdfjs 读取。importRunner IMPORTABLE_EXTS+错误文案、LibraryPage 文件对话框 filters、AppShell 拖拽（runImports 通用无改）一并放行 pdf；dedup 沿用 basename/title+size 通用键。BookDetailsDialog 格式标签加"PDF"。查重/删除/回收站链路 format 无关，自动兼容。

PdfReader（src/reader/pdf/）：
- layout.ts：pdfCfi/parsePdfCfi（`pdf:<页号0起>`）、normalizePdfReaderSettings（pdf_reader_settings：fit+mode），clamp/percent/panClamp 从 image/layout 复用。
- api.ts：loadPdf（readAppDataFile→getDocument 禁自动 fetch，返回 {doc, destroy}——pdfjs v6 销毁在 loadingTask 上）；renderPdfPage（离屏 canvas，dpr transform 适配清晰度）；PasswordException → "受密码保护的 PDF 暂不支持"。
- PdfReader.tsx：分页（单页居中，适高/适宽/原始复用漫画语义）+ 连续滚动（类 webtoon，IntersectionObserver 锚定+aspectRatio 占位）；渲染治理=窗口外 RenderTask 即时取消（RenderingCancelledException 不记失败）+位图 ±2 常驻+容器/模式/适配变化整体作废缓存；Ctrl+滚轮 0.5-4x 缩放+拖拽平移+复原钮（复制漫画实现，未抽共用组件——两处消费面差异大于共性，ponytail：少量复制优于错误抽象）。单一根节点跨加载/错误/内容态常驻（stageRef 稳定供 ResizeObserver）。
- PdfSettingsPanel.tsx：模式（翻页/连续滚动）+适配+主题，Seg 结构复用漫画面板。

ReaderPage：引入 isVisualBook（images|pdf）统一视觉书管线——顶栏（收藏/书签/页面/设置/锁定）、热区、滚轮/键盘翻页、页脚 n/total、书签 pdf:N、"页面"面板（PagesPanel 加 fetchThumb 可选 prop，PDF 由 reader 渲染 150px 缩略图）；imageCtxRef 拆 webtoon（滚轮转发）/autoscroll（空格，仅条漫）两标志。SettingsDialog 快捷键表加一行：PDF 复用漫画键位。

门禁：vitest 128（新增 pdf layout 5 项）/ tsc 零错误 / vite build 通过 / cargo check 零警告 / cargo test 78 通过。
