# 批次3 Spec：滚动阅读模式 + 六主题 + 自定义背景图

- 日期：2026-10-26；基线 HEAD=e46a658（工作区干净）。
- 前置：docs/superpowers/specs/2026-10-26-format-expansion-roadmap.md 批次3；先例 batch1/batch2 spec 同目录。
- 产出方式说明：本 spec 由无文件工具的设计子代理产出，锚点为“文件+符号/搜索串”，行号未逐一校验；实施者必须先 Read 锚点文件再改（批次硬约束）。实读后如与本 spec 冲突，以现状为准并在文末“实施记录”一行记录。

## 0. 范围与现状锚点

- 只动 epub 阅读侧。图片书（book.format==="images" → ImageReader）与书库壳不进入行为面，仅随 [data-theme] token 换色；不得回退批次1-2 任何功能与既有守卫（进度 flush、locate()、wheel×抽屉守卫、导入去重、图片书分支）。
- 必读锚点（实施前逐个 Read）：
  - src/reader/settings/**（types/defaults/normalize 及测试）
  - src/reader/epub/reader.ts（renderTo 硬编码 flow:"paginated"；wheel 翻页 60px/300ms 冷却；动画 none/slide/fade 180ms；registerThemes 三主题 background transparent、正文色写死、链接色未设）
  - src/pages/ReaderPage.tsx（getSettings/set_setting 的实际键结构与合并方式；pagerEnabled；键盘翻页处理）
  - src/reader/components/SettingsPanel.tsx（主题/字号/行距/动画控件的类名与交互模式）
  - src/ui/weread.css 与 src/styles/tokens.css 的 [data-theme] 段
  - src/tauri/invoke.ts；src-tauri/src/commands/library.rs（pub(crate) appdata helper、atomic_copy_to/atomic_write_to）；src-tauri/src/lib.rs 注册段
  - node_modules/epubjs（0.3.93）manager 的 flow 实现（§1.2 定案用）

## 1. readingMode（阅读模式）

### 1.1 设置结构与迁移
- ReaderSettings 增加：
  - `readingMode: "paginated" | "scrolled"`，默认 `"paginated"`；
  - `reader_bg: {type:"preset"} | {type:"image", path:string}`，默认 `{type:"preset"}`（见 §3）。
- 合并/迁移：沿用 getSettings 现有合并路径（形如 {...DEFAULTS, ...stored}）与 set_setting 现有键结构（整包 JSON 或逐键，实读后按现状追加两键，不改既有键写法）。旧数据（批次2 时代，无两新键）打开即 paginated + preset，无独立迁移代码。
- normalize：readingMode 缺失/未知 → "paginated"；reader_bg 形状非法（缺 type、image 无 path）→ {type:"preset"}；theme 未知 → "light"（见 §2.1）。
- 测试同步：settings 测试补两新键默认值、normalize 各回退分支、旧 stored 透传。

### 1.2 scrolled 模式行为（仅 epub）
- 建立时：renderTo 的 flow 由 settings.readingMode 决定（去掉硬编码 "paginated"）；spread：scrolled → "none"（分栏失效、按 single 表现），paginated → 按 layoutMode。
- 切换：仅当 readingMode 实际变化时执行。首选 `rendition.flow(newMode)` + `rendition.spread(...)`；实施前实读 epubjs 0.3.93 manager.flow 确认运行时切换可靠；若不可靠，回退方案为 destroy + 按新 flow renderTo + display(已存 CFI)。二选一定案，写入文末实施记录，不得两条并存。字号/行距重注册路径与 flow 完全解耦（flow effect 依赖仅 readingMode）。
- wheel：翻页守卫链追加 `readingMode==="paginated"` 条件（scrolled 不翻页、不 preventDefault，wheel 落入 iframe 原生滚动）；阈值/冷却不动。
- 边缘热区：pagerEnabled 计算追加 `readingMode==="paginated"`（热区已有 pagerEnabled 守卫，热区自身不改）。
- 键盘：scrolled 下文档级翻页键（ArrowLeft/ArrowRight/PageUp/PageDown/Space，以实读现有键位为准）直接 return、不 preventDefault；iframe 聚焦时其内部按键为原生滚动，焦点在壳上不响应。paginated 恢复全部原键位。
- 进度：relocated 照常监听、照常持久化（CFI 语义不变、flush 不动）；不新增 scroll 监听。
- HUD：内容与更新路径不变（relocated 驱动）。scrolled 下 animateTurn 的 epub 分支直接 return：footer/HUD 的上一页/下一页按钮为无操作（wheel/热区/键盘已各自禁用），翻页动画不会被触发，动画代码不删。
- CSS：滚动纸面全高铺满（现有 flex 容器即满高；仅当实读发现不满时在 weread.css 补一条最小规则）。行距/字号在 scrolled 下继续生效（重注册路径不变）。

### 1.3 SettingsPanel
- 新增“阅读模式”分段控件（复用 wr-seg/现有分段类）：左右翻页 / 上下滚动；选中态、focus-visible、150-300ms 过渡与现有控件一致。
- scrolled 选中时“翻页动画”“分栏”控件置灰：aria-disabled + title="滚动模式下不可用"（不隐藏，避免面板高度跳变）；paginated 恢复可操作。

## 2. 六主题

### 2.1 类型与注册
- `Theme = "light" | "sepia" | "green" | "gray" | "dark" | "darkcontrast"`；normalize 未知 → "light"；旧三值原样通过，无迁移。
- registerThemes 一次注册六主题，沿用现模式：background "transparent"、正文色写死；light/sepia/dark 现值逐字不动；新增 green #223325、gray #2b2b28、darkcontrast #f5f5f5（与 §2.2 表同步，注释一行说明同步关系）。链接色继续不设（跳过项）。
- 主题切换仍走 setTheme→themes.select + 根容器 data-theme 换值；书库/收藏等壳区域自动跟随。

### 2.2 token 值表（tokens.css / weread.css，六块 [data-theme] 键集合完全一致）
角色→值（“现”= 实读文件保留现值，禁止改动）：

| 角色（语义） | light | sepia | green | gray | dark | darkcontrast |
|---|---|---|---|---|---|---|
| 壳底 | 现 | 现 | #eef3ec | #e3e3e0 | 现 | #000000 |
| 纸面底 | 现 | 现 | #c8e6c4 | #d9d9d6 | 现 | #050505 |
| 正文 | 现 | 现 | #223325 | #2b2b28 | 现 | #f5f5f5 |
| 次级文本 | 现 | 现 | #66796b | #71716a | 现 | #bdbdbd |
| 分割线 | 现 | 现 | #b7d4b3 | #c4c4bf | 现 | #2e2e2e |
| 强调/品牌 | 现 | 现 | 沿用 light 值 | 沿用 light 值 | 现 | 沿用 dark 值 |

- 对比度（正文/纸面）：green ≈9.9:1、gray ≈10.0:1、darkcontrast ≈18.7:1，全部 ≥ AA。
- 实施时把角色映射到 tokens.css 现有 token 键名；若现有三块缺某角色键，六块统一补齐该键（键集一致是“零重排”前提）；六块只含颜色类 token，禁止新增布局属性。
- 零重排验收：阅读中切主题，仅颜色变化，HUD/面板/纸面几何零位移。

### 2.3 主题选择器 UI
- 六个色块按钮（背景=各主题纸面色：#ffffff / 现 sepia 值 / #c8e6c4 / #d9d9d6 / 现 dark 值 / #050505），复用现有分段/控件类；每块 aria-label 与 title = 白色/米黄/护眼/纸灰/夜间/夜间高对比；选中态环/描边用现有 token；focus-visible 环；过渡 150-300ms。

## 3. 自定义背景图（仅 epub 阅读纸面）

### 3.1 设置结构
- `reader_bg`：`{type:"preset"}`=当前主题纸面色；`{type:"image", path}` 时纸面渲染背景图，path 为 appdata 相对路径（正斜杠）。

### 3.2 Rust 命令 `save_reader_background(source_path: String) -> Result<String, String>`（commands/library.rs，注册进 lib.rs）
- 校验（抽纯函数便于测试）：扩展名（大小写不敏感）∈ png/jpg/jpeg/webp，否则 Err("不支持的图片格式，仅支持 PNG/JPG/WebP")；metadata.len() > 8*1024*1024（8MB=8MiB），否则 Err("图片超过 8MB 限制")。
- 写入：create_dir_all `<appdata>/library/bg/`，复用 atomic_copy_to 写 `bg.<ext>`（单槽覆盖）；成功后 best-effort 删除该目录其它 `bg.*` 残留（忽略 NotFound），保证真单槽。
- 返回相对路径 `library/bg/bg.<ext>`。
- cargo test 覆盖：扩展名拒绝、超限拒绝、成功覆盖旧槽；测试用 tempdir，不依赖真实 appdata。

### 3.3 前端管线
- invoke.ts：加一个封装 saveReaderBackground(source)（精准局部编辑）。
- SettingsPanel“背景图”行：
  - [选择图片]：dialog open（复用 dialog:allow-open，filters images：png/jpg/jpeg/webp）→ invoke save_reader_background → set_setting `reader_bg {type:"image", path}` → objectURL 缩略图预览（cover、圆角、约 96-120px 宽）。
  - [恢复默认]：set_setting `{type:"preset"}`，revoke 预览 URL；不删磁盘文件（跳过项）。
  - 命令 Err 文案走面板现有错误提示通路。
- ReaderPage（仅 epub 分支，ImageReader 与书库零改动）：
  - image 时经 readAppDataFile(path) → Blob(mime 按扩展名：image/png、image/jpeg、image/webp，构建方式与图片书现有实现一致) → objectURL；模块级单槽缓存 {path,url}，path 变化先 revoke 旧 URL，卸载 revoke。
  - 纸面容器（背景为纸面 token 的那一层）内联 `backgroundImage:url(...)`、`background-size:cover`、`background-position:center`；叠加主题薄纱：叠加层 background=var(纸面色 token)、opacity .86、pointer-events:none、transition 200ms——暗色主题自动适配（token 本身即暗色），正文对比度≈纸面级，满足 AA；preset 时移除内联样式与类。

## 4. 验收（含审美和性能）
1. 门禁全绿：npm run build、npm run test；unset 全部代理变量后 `CARGO_TARGET_DIR=C:/cargo-target/bookreading cargo check --manifest-path src-tauri/Cargo.toml`（+ cargo test）。禁止 npm run tauri dev；禁止 git commit/push；零新依赖（package.json/Cargo.toml 零 diff）；CRLF。
2. 迁移：批次2 时代 settings 打开即 paginated+preset 无报错；旧主题值不丢。
3. 六主题：切换零重排（几何零位移）；色块 aria-label/title/选中态/键盘可达；三新主题正文/纸面对比度 ≥ AA（§2.2 值）。
4. 滚动模式：打开已存 scrolled 的书直接滚动；flow 切换仅发生在模式实际变化时；scrolled 中改字号/行距不重建 flow、CFI 不跳；scrolled 下 wheel=iframe 原生滚动、热区与翻页键不响应；relocated 进度照常写入；paginated 一切如旧（含 wheel×抽屉守卫、动画、分栏）。
5. 背景图：>8MB 拒绝、错扩展拒绝、二次选图覆盖旧槽、“恢复默认”回纸面色；暗色+背景图正文仍可读（薄纱）；图片书与书库无背景图。
6. 性能：无每帧 JS（进度仅 relocated 驱动）；objectURL 单槽缓存一次；主题切换纯 token 替换。
7. 不回退清单逐项抽查：进度 flush、locate()、wheel×抽屉守卫、去重、图片书分支、批次1-2 全部功能。

## 5. 跳过项
- 主题内链接色（维持未设现状）。
- 背景图磁盘删除命令 / 多槽多预设管理（单槽覆盖已约束磁盘上限）。
- scrolled 用 continuous manager 做跨章连续滚动（本批为默认 manager 章内滚动）。
- scrolled 下自定义键盘滚动动画（原生滚动）。
- 行级锚点校验（本 spec 产出环境无文件工具；实施者先 Read 再改）。

## 6. 实施记录（实施时回填）
- flow 切换定案：rendition.flow() 直切（实读 epubjs 0.3.93 rendition.js flow()：已渲染且有 location 时内部自动 manager.clear() + display(location.start.cfi)，CFI 自动恢复；reader.setReadingMode 仅在同值短路外补 spread 恢复与 paginated 回归时 resize，无 destroy 路径）。
- settings 键结构实读结论：逐键。set_setting 每键一调（theme/pageAnimation/layoutMode 为字符串、fontSizePercent/lineHeight 为数字字符串），读取侧 getSettings 返回 Record<string,string> 后逐键 normalize；新键沿用：readingMode=字符串，reader_bg=JSON 字符串（同 image_reader_settings 先例）。
- 现值抄录：light/sepia/dark 各 token 实际值（§2.2“现”处补充具体值）。
- C 区（CSS/Rust）实读结论：
  - 角色映射：壳底=--bg/--wr-bg、纸面底=--panel-solid/--wr-paper、正文=--text/--wr-ink、次级=--text-muted/--wr-muted、分割线=--border/--wr-hairline、强调=--wr-accent（tokens.css 无 accent 键，未新增；两文件各自沿用现有键集，六块键集一致）。
  - 现值抄录：weread.css light 壳 #f6f4ef/纸 #fbfaf7、sepia #f4efe6/#fffaf0、dark #0f1214/rgba(255,255,255,0.06)；tokens.css light #f7f7fa/#ffffff、sepia #f4efe6/#fffaf0、dark #0b0d10/#11151b。
  - weread.css 在 token 块之外另有 25 条 [data-theme="dark"] 组件级覆盖（.wr-panel/.wr-reader-paper/顶栏底/滚动条等），已逐条扩展为同时匹配 [data-theme="darkcontrast"]（单一来源、暗色表面行为一致）；green/gray 为浅色主题沿用浅色默认，仅补 .wr-reader-paper 渐变（值=§2.2 纸面色）。
  - scrolled 纸面实读已满高（.wr-reader-paper-wrap 与 .wr-reader-paper 均 height:100%），无需补铺满规则。
  - 背景图薄纱类定名 .wr-reader-bg-veil（纸面容器内 absolute inset:0、background var(--wr-bg)——六主题壳底均为实色，dark 的 --wr-paper 是半透明白会漏亮图、opacity .88、pointer-events:none、transition 200ms），B 区纸面渲染时消费。
  - save_reader_background：校验抽 validate_reader_background 纯函数 + 可测核心 store_reader_background(bg_dir, source)（AppHandle 无关，测试走 std 临时目录+Uuid）；cargo test 3 例（扩展名拒绝/超 8MB 拒绝/大小写扩展名成功覆盖旧槽）。
