# 2026-10-28 批次15 · 终版修整（v2.0.0 前最后修整） — 变更记录

四项用户实测问题修复 + 文档，无新依赖、无行为回退。

## 1. 导入按钮 loading 文案

根因：LibraryPage 两个导入按钮共用一个 `loading` state，且只有"导入图书"按钮绑了 loading 文案——任一操作（含删除/收藏）都会让图书按钮误显"导入中…"，漫画按钮则永不变化。

修法：新增独立 `importing: "books" | "images" | null` state（src/pages/LibraryPage.tsx），onImport / onImportImages / onBatchImportImages 各自 set/clear；按钮文案 `importing === "books" | "images" ? "导入中…" : 原文案`。防并发沿用既有 `loading` 守卫（按钮 disabled={loading}，函数入口 `if (loading) return`；批量导入补上同款守卫）。拖拽导入（AppShell → importRunner）自带模块级串行队列，与按钮天然不冲突。

## 2. 拖书卡到侧栏"回收站" = 移入回收站

拖拽通信方案（最小实现，无新 store / 无 CustomEvent）：批次12b 的 pointer 拖拽（LibraryPage.startCardDrag）本就通过 `document.elementFromPoint(...).closest("[data-drop]")` 全文档命中测试，拖拽 ghost 为 pointer-events:none 不挡命中。因此侧栏回收站导航项只需加 `data-drop="trash"` DOM 标记（src/ui/AppShell.tsx），LibraryPage 的 canDropOn/onUp 增加该 mode 分支即可，无需跨组件状态传递。

- AppShell 回收站按钮：`data-drop="trash"`。
- LibraryPage：canDropOn 书卡分支 `mode === "trash" → !trashView`（回收站视图内无拖拽源，再挡一层防自删困惑）；onUp 分流 `dropOnTrash`（showConfirm"将 1 本书移入回收站？可在回收站恢复"→ deleteBooks 软删 → refresh + BOOKS_CHANGED_EVENT 广播）。
- weread.css：`.wr-nav-btn.drop-target` 高亮（accent 描边 + 光晕，语义同书卡 .drop-target）。

## 3. PDF 并轨漫画交互（删 PdfSettingsPanel 与 pdf_reader_settings）

- 删除 src/reader/pdf/PdfSettingsPanel.tsx 与 pdf/layout.ts 的 PdfReadMode/PdfReaderSettings/default/normalize（layout.test.ts 同步删该 describe）；pdf/layout.ts 仅保留 pdfCfi/parsePdfCfi 与漫画 layout 的复用 re-export。
- ReaderPage PDF 分支设置抽屉改渲染 ImageSettingsPanel（`pdf` prop 区分文案），与漫画共用 imageSettings state 与 image_reader_settings 持久化键；PDF 的连续滚动 = 漫画 webtoon 枚举（pagerEnabled / imageCtxRef 判定统一为 `isVisualBook && imageSettings.mode === "webtoon"`）。
- ImageSettingsPanel 新增 `pdf?: boolean`：标题"PDF 设置"、模式第二项文案"连续滚动"、宽度标签"滚动宽度"；单双页 / RTL / 翻页动画对 PDF 置灰（PdfReader 未实现，见取舍）。
- PdfReader：settings 类型换 ImageReaderSettings，`mode === "scroll"` 全部改判 `"webtoon"`；连续滚动页宽用 `webtoonWidth%`（与条漫同档）；自动滚动为条漫 B11/B12 实现的最小复制（rAF 浮点累积步进、用户接管即停、到底自停+轻提示、HUD 自动/暂停钮；空格播放暂停、播放中 ↑/↓ 调速由 ReaderPage 既有键盘链路自动覆盖，速度共用 image_reader_settings.autoScrollSpeed）。
- SettingsDialog 快捷键表 PDF 行："与漫画一致（连续滚动支持空格自动滚动）"。

**双页 / RTL / 翻页动画取舍**：本批对 PDF 置灰不实现。理由：PdfReader 分页渲染是单 canvas + 离屏位图缓存 + 缩放原点计算，双页需引入 spreads 分组、宽页检测（PDF 页尺寸需渲染才知）、双 canvas 布局与进度/书签页号语义改造，改动面远超"最小完整变更"；翻页动画同理（ImageReader 靠双 img 层滑动，PdfReader 是位图直绘）。面板置灰保留漫画侧可用，后续批次若做可解锁。

## 4. 漫画导入解析 [作者] 标题（Rust images.rs）

- `parse_name_meta`：先循环剥离开头的前导 `(...)` 段与空白（汉化组等发布标记，不作元数据），再匹配 `^\[([^\]]+)\]\s*(.+)$` → (author, title)；空作者/空标题/无中括号返回 None（保持原名，不剥离）。
- `resolve_comic_meta(base, title_opt)`：显式 title_opt（trim 后非空）优先，作者留空不解析；否则用文件夹名 / CBZ 文件名（去扩展）走 parse_name_meta，不匹配则整名作标题、作者 None。
- import_folder 与 import_cbz 的 title 计算替换为 resolve_comic_meta；批量父目录导入（list_image_subdirs → import_image_folder）走同函数自动生效。显示层无改动（书卡显示 title，详情显示 author）。
- Rust 测试 +4：`[A]B` 解析（含空格分隔）、无括号不解析（含空作者与 None base）、title_opt 优先（含空白 title_opt 回退）、前导括号剥离（单/双前导括号 + 中括号、纯前导括号无中括号不剥离）。

## 5. 文档

CHANGELOG.md 末尾"批次 15"四条；README 功能总览 PDF 描述改"图片型 PDF 按漫画交互（条漫/页漫）"、导入段加"[作者] 标题"解析一句、快捷键表 PDF 行同步；本变更记录。

门禁：npm run build（tsc + vite）/ npm run test（vitest）/ cargo check / cargo test（unset 代理 + CARGO_TARGET_DIR=C:/cargo-target/bookreading）全过。
