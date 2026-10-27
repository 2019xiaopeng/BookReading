# 2026-10-27 批次5 · 阅读体验深化 — 变更记录

对应 spec：../specs/2026-10-27-batch5-reading-experience-spec.md。实施 3 分区 + 双复核 + 修复轮（critical 漫画收藏接线 + medium 条漫居中均已修）。P0 prompt 崩溃已先行热修（99e54a8）。

## 读书
- 页码：章内页码徽标（relocated.displayed；单页右下、双页两角；字号/行距/分栏变化经 resize 重排自适应；跳过全书累计页码——需逐章渲染，成本不成比例）
- footer 翻页/滚动两模式统一"上一章/下一章"（翻页交给键盘/滚轮/热区）
- 高亮闭环：removeHighlight 补 "highlight" 类参（面板删除后正文同步清除）；cfiRangesOverlap 纯函数（6 测试）——选中已高亮文字气泡变"取消高亮"
- 整页翻页动画：slide 档改为纸面整页两段式平移（150ms 出场→换内容→240ms 入场，setTimeout 兜底，turningRef 防连翻卡死；reduced-motion 直切；跳过仿真卷曲——单 iframe 无法快照，零新依赖红线）
- 沉浸重做：useImmersiveChrome 状态机（3s idle 隐栏/输入唤回/锁定全藏且鼠标不唤出/Ctrl+D 切锁，5 测试）；锁定时纸面 padding 收 0 并 resize 修底部空白根因；旧 HUD 删除换锁定钮+自清提示
- 正文顶部章节小字（iframe 外 18px 行，--wr-muted 六主题适配，锁定时隐藏）

## 漫画
- 设置面板：主题六色块入口（驱动全局 store）+ 翻页动画（无/滑动）档 + 面板不透明度提升
- 条漫宽度：62/75/92 三档 + 自定义滑条（40-100%，默认 75），页容器 marginInline:auto 居中、两侧纸面色
- 收藏与书签：顶栏 IconHeart 收藏（is_favorite）；Ctrl+B 页书签（img:N，复用去重）；书签抽屉入口与"第N页"标签、点击跳页（locate img: 分流）
- Ctrl+滚轮缩放 0.5-4x（光标锚点、缩放中拖拽平移、双击/悬浮 100% 钮复位、缩放时翻页手势让位；clampZoomScale/panClamp 纯函数测试）
- 沉浸：复用 useImmersiveChrome（锁定/自动收缩与读书同款）

## 全局
- 卡片工具钮重排不压书名；书架密度三档（紧凑/标准/大图，density.ts 纯函数+测试，持久化，封面尺寸联动）
- 书架右键菜单/顶栏"设置背景"入口（复用全局背景链路）
- 漫画批量导入：父目录→每个一级子文件夹各成一本（空跳过、失败续行）
- 左侧分组书架（书架/收藏下按分组导航，同源过滤）
- 自定义封面：set_book_cover 命令（校验≤8MB png/jpg/webp、覆盖写 covers/{id}，+3 Rust 测试）+"设置封面"菜单

## 门禁
vitest 88（+18）/ cargo test 43（+3）/ tsc 零错误 / cargo check 零警告。

## 实机验证要点
页码随分栏/字号联动；双角页码；面板删高亮正文即清+选中取消；slide 整页动画与快速连翻；沉浸锁定时顶/底全藏+底部无空白+Ctrl+D；章节头行；漫画收藏/页书签往返；Ctrl 缩放与复位；条漫 62% 居中观感；密度三档；批量导漫画；自定义封面后卡片刷新。
