# M2 碳墨刊头 · UI 实施规范（施工图）

> 配套：`BookReading交付文档.md`（性能/功能/发布主线）§6；视觉气质参照 `/docs/design/mono-carbon.html`（**只对照气质与 token，不照抄布局**——参照稿里有、但原版没有的东西，一律以本文档第 11 节确认清单为准）。
> 现状事实均出自 2026-10-29 代码盘点（inventory-theme-settings.md / inventory-screens.md，附 文件:行号）。

## 0. 总原则（红线）

1. **换皮不换骨**：路由（/ 书库、/read/:bookId 阅读、/favorites 收藏、/?trash=1 回收站）、AppShell 骨架、全部交互与数据流不动。
2. **可调性零丢失**：六主题切换、全局背景图（reader_bg）、阅读器全部设置（字号/行距/字体/翻页/版式/条漫宽度/自动滚动…）、自定义字体单槽，改版后逐项可用且生效方式不变。
3. **颜色三副本同步**：`tokens.css`（壳）、`weread.css`（--wr-* 与 chrome）、`reader.ts` THEME_STYLES（EPUB iframe 注入）——任何纸墨色值变更三处一起改，漏一处就"壳变了书页没变"。
4. **只动 chrome 不动正文**：阅读器正文排版（wr-reader-root 内 stage/iframe/翻页动画/热区）本次零改动；漫画/PDF 阅读器内部不动。
5. 内联样式够得着的就顺手迁移到类（第 8 节清单），够不着的原地改值。
6. `mono-carbon.html` 里的以下元素**不实现**：网格/列表视图切换（原版无列表视图）、右侧等宽数字索引按稿照搬（改为融入现有工具行，见 §3.2）。

## 1. 与现有主题系统的融合

- **新增「纸墨 ink」（日）与「墨夜 ink-dark」（夜）两套主题，默认=纸墨**（共 8 套，现有六套全部保留可选）：`theme.ts` THEME_SWATCHES 增 `ink`（swatch #242321）与 `ink-dark`（swatch #EDECE7）；默认主题从 light 改为 ink；`html[data-theme="ink"|"ink-dark"]` + `color-scheme` 照现有机制（theme.ts:25-32）。
- **墨色语义**：M2 体系里 `--m2-ink` 就是"当前墨"。ink 主题下墨=碳墨 #242321（夜 #EDECE7）；其他主题下墨=该主题的 --text。这样"换主题=换墨"，与现有机制零冲突，**不需要**引入用户自定义墨色新功能。
- **EPUB 正文**：reader.ts THEME_STYLES 增两套——纸墨（paper #FAFAF7 / fg #242321）与墨夜（paper #191816 / fg #EDECE7），注册名 `ink` / `ink-dark`；阅读器内主题色块菜单自动多一格（复用 THEME_SWATCHES，SettingsPanel.tsx:107-127）。
- `--wr-accent`（#1aad19，weread.css accent 族）：ink 主题下重定义为碳墨；其余主题保持现状。

## 2. token 层施工

- `tokens.css` 追加 M2 语义变量（保留全部现有 9 变量不动，新增不改名）：

```css
/* M2 纸墨层 —— 字面值只允许出现在这里（每主题一组） */
--m2-paper / --m2-ink / --m2-ink-soft / --m2-line / --m2-cover-line
--m2-wash / --m2-ink-ghost / --m2-skeleton / --m2-sheen / --m2-shadow
--m2-cover-filter(夜间 brightness(.86) saturate(.96))
--m2-noise(feTurbulence 0.05 alpha，SVG data URI，照交付文档 §6.1)
```

- **八套主题（6 旧 + 纸墨 + 墨夜）都要给值**；`--panel-solid`（select 弹层/抽屉/菜单实底）：纸墨 #FFFFFF / 墨夜 #201F1D。
- 灰度换算规则（旧主题的 m2 值）：paper=该主题 --bg，ink=该主题 --text，line=ink 的 16% alpha，其余 alpha 族同理推导——写一个 CSS 小节集中放八组，不散落。
- 高亮黄 #ffe600 **保留不动**（阅读高亮是内容标记不是 chrome 墨色；P1 高亮多色时再统一）。

## 3. 书架页施工（LibraryPage + AppShell 侧栏）

### 3.1 刊头（新增，焦点事件）
- 位置：主区顶部、工具行之上，新增 `wr-masthead` 区块：当前书架名（默认"书 架"全角空格）`clamp(34px, 4.5vw, 60px)` / weight 800 / --m2-ink；右侧等宽小字列（藏书 N · 在读 N，--font-mono，tabular-nums，右对齐，复用现有统计来源）。
- 回收站视图（?trash=1）刊头换"回 收 站"。

### 3.2 工具行图标化（痛点"全是文字"）
现状文字钮：排序 5 钮 / 选择 / 密度 3 档（LibraryPage 工具行）。改造：
- **排序 5 钮 → 一个排序按钮**（图标：箭头上下线）+ 下拉菜单（菜单项=原 5 项，当前项打勾）。
- **密度 3 档 → 三格分段图标控件**（小/中/大三格，格子图标用 2/3/4 条竖排矩形示意，aria-label 宽松/标准/特大）。双轨生效机制不动（wr-book-grid--large/--xl 类 + 内联列模板，LibraryPage.tsx:1168-1169）。
- **选择 → 复选框图标钮**；**搜索**（现状如有输入框保留，前缀放大镜图标）。
- 图标全部进 `src/ui/icons.tsx`（内联 SVG：viewBox 0 0 24 24 / stroke currentColor / width 1.75 / round / 20px），不引库。
- 侧栏（270px，现状树形书架+拖拽**原样保留**）：顶部加 3 个快捷项「全部藏书 / 在读 / 未读」（映射现有 StatusFilterMenu 的状态过滤逻辑，选中态=实底反白 chip）；底部设置入口图标化。

### 3.3 书卡（类名全保留）
`wr-book-card`（grid 64px 1fr，weread.css:1000 一带）：
- 封面 img：加 `1px var(--m2-cover-line)` 描边 + 夜间 `var(--m2-cover-filter)`；容器 `aspect-ratio: 2/3` 防跳动（与交付文档阶段一 1.1 合并）。
- hover：`wr-card-tools` 保留（置顶/移出等），图标化；卡片 `transform: scale(1.02)`+`--m2-shadow`，150ms ease。
- 书名/作者/进度行：字号不变，颜色换 `--m2-ink` / `--m2-ink-soft`；在读进度=封面下缘 2px 墨线。
- 四宫格书架卡 coversByShelf：占位骨架 + 固定取前 4（交付文档阶段一 1.5）；`wr-shelf-card` 现状无 CSS 规则——本次补最小规则（padding/border/背景 wash）。
- 骨架屏：`--m2-skeleton` 底 + `--m2-sheen` shimmer 1.6s（prefers-reduced-motion 停用）。
- 空态（无书/无搜索结果）：图标 + 一句引导文案（图标用书架线稿）。

### 3.4 印刷感收尾（各一处）
主区底部 1px 墨线画到 70% 宽；body 叠 `--m2-noise` 噪点（fixed 伪元素，z-index 低于弹窗）。

## 4. 其他屏施工

| 屏 | 施工内容（类名级） |
|---|---|
| FavoritesPage | 复用书卡改造；页顶加同款小型刊头（"收 藏"），统计列复用 |
| BookDetailsDialog | 标题/作者/标签 chips 换 token；chips=1px 墨线空心；封面描边同书卡；640px 单列行为保留 |
| TagDialogs / StatusFilterMenu | 按钮/输入框换 token；选中态=实底反白 |
| Drawer / dialog.tsx | 实底 `--panel-solid`(ink 值)；标题字重 650；圆角统一 8px |
| SettingsDialog（应用设置） | 结构不动，视觉 token 化；快捷键表格线 `--m2-line` |
| SettingsPanel（阅读器设置抽屉） | **仅外壳** token 化；内部控件（字号滑杆等）行为与键名零改动；主题色块菜单自动含纸墨/墨夜 |
| 阅读器顶/底栏 | **仅颜色层**：--wr-chrome-bg 半透底换纸墨（纸墨 rgba(250,250,247,.72) / 墨夜 rgba(25,24,22,.72)），backdrop-filter:blur(16px) 两处**原样保留**；按钮保持图标+文字组合不动 |
| 回收站 wr-trash-row | 行式列表 token 化，结构不动 |

## 5. 小窗适配（现状只有 900/640 两档，默认 800 宽一开窗即中档）

- **tauri.conf.json 增 `minWidth: 720, minHeight: 480, center: true`**（配合交付文档的 window-state 插件）。
- 断点重划（全部走 min-width，避免 800 默认窗直接命中"小窗"）：
  - **≥1200**：完整版（侧栏 270、刊头 60px、网格 auto-fill 现状）。
  - **800–1199**：侧栏 210（沿用现状值）、刊头 clamp 自动缩至 ~44px、统计列移到刊头下一行。
  - **720–799**：侧栏 156（沿用现状值）+ 藏快捷 chips（wr-pill 现状行为）；工具行允许换行（现状 flex-wrap 保留）；刊头 ~34px；排序/密度控件保持可见。
  - 网格本身 auto-fill minmax(220/320/420) 天然自适应，不改。
- 禁止引入横向滚动；刊头文字 `overflow-wrap` 保护。

## 6. 背景与毛玻璃融合（用户功能，完整保留）

- 默认（无背景图）：纯纸底 + 噪点，无光斑。**删除壳底双 radial 光斑渐变（weread.css:171-172 与 682-683）仅限 ink 主题**（用 `[data-theme="ink"]:root` 作用域覆盖为纯色），其他主题的光斑保留。
- 用户设背景图（reader_bg，preset/image 两态机制不动）：
  - 壳：AppShell.tsx:173-179 的 `color-mix(--wr-bg 88%)` 纱照常生效——ink 主题下 --wr-bg 取 --m2-paper，即"纸色纱"罩图，视觉=米白纸透出背景。
  - EPUB 纸面：ReaderPage.tsx:1377-1383 + weread.css:745-752 的 0.88 实底 veil 同步取纸色。漫画/PDF 不吃背景图（现状）。
- 毛玻璃：仅阅读器顶/底栏两处（weread.css:764/775），保留 blur(16px)，只换底色为纸墨半透（§4 表）。
- 噪点层叠序：背景图 → 纸色纱 → 噪点 → 内容（噪点 opacity 0.05，两种状态都成立）。

## 7. 图标清单（src/ui/icons.tsx 统一导出）

搜索 / 排序 / 密度(三格) / 选择(复选) / 书架 / 设置 / 更多(⋯) / 关闭 / 返回 / 置顶 / 心形(收藏) / 标签 / 回收站 / 还原 / 删除 / 加号 / 全部藏书 / 在读(翻开书) / 未读(闭合书) / 警示(空态)。lucide 风手写，禁止 emoji。

## 8. 内联样式迁移清单（够得着的迁进 weread.css）

ReaderPage toast/页徽标/边缘热区尺寸、AppShell 背景纱（173-179）、LibraryPage 内联列模板保留（双轨机制）、各面板内联色值 → token。z-index 只在触碰的文件里顺手归 token（15/20/25/30/60），不全局重排。

## 9. 实施顺序与提交切分

1. commit U1：token 层 + 主题注册（三副本同步）+ swatch/默认主题
2. commit U2：icons.tsx + 工具行图标化（排序收纳/密度分段）
3. commit U3：刊头 + 侧栏快捷项 + 空态/骨架
4. commit U4：书卡 + 四宫格 + 回收站行
5. commit U5：弹窗/抽屉/设置面板外壳 + 收藏页
6. commit U6：阅读器顶/底栏颜色层 + 背景融合 + 光斑作用域
7. commit U7：小窗断点 + minWidth + 截图验收产物入库 docs/design/shots/
每个 commit 后：`npm test` 全绿 + 手动过 §10 验收对应项。

## 10. 验收（每屏三宽度：1440 / 1000 / 720）

- [ ] 七主题逐个切换：壳/弹窗/EPUB 正文三处颜色同步变化，无残留旧色；背景图启停：壳纱/EPUB 纸面/毛玻璃栏正常
- [ ] 阅读器设置逐项拨动（字号/行距/字体六栈+自定义/翻页/速度/版式/条漫宽度/自动滚动）全部生效
- [ ] 交付文档 §6.4 功能存续清单 21 项全绿（PR 附表）
- [ ] styles 目录除 token 段外 grep 不到新增字面色值；mono-carbon 对照：气质一致，布局以本规范为准
- [ ] 720 宽无横向滚动、工具行完整可用；书架滚动帧率 ≥ 基线

## 11. 待用户确认清单（实施 agent 遇到即停，批量问，勿自行拍板）

1. 排序 5 钮收进下拉菜单——【已确认：同意】
2. 列表视图（书架行式列表形态）本期**不做**——【已确认：不做；用户已知列表视图指书架展示区形态，非左侧导航】
3. 「纸墨」设为默认主题（旧的 light 仍可选）——【已确认】
4. 壳底光斑渐变在纸墨/墨夜下去掉（其他主题保留）——【已确认】
5. minWidth 定 720——【已确认：无更小屏需求】
6. 书卡 hover ⋯ 菜单（置顶/详情/移出收进去）——【已确认：收进去】
7. 高亮黄 #ffe600 本次保留——【已确认】
8. 「纸墨」按**两套主题**落地（纸墨=日间米白、墨夜=夜间碳墨，均为独立可选主题，共 8 套）——施工图已按此写，确认？
9. 书卡「读到 N%」chip 改为封面下缘 2px 墨线（百分比移入 hover 提示）——确认？
