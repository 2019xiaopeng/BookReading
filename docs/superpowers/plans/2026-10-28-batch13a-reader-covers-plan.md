# 2026-10-28 批次13a · 阅读器与封面 — 变更记录

漫画全屏：stage data-image 常态 padding 0（栏悬浮于图，1.2s 后完全全屏）；栏玻璃柔化（alpha 降+blur 16+hairline+屏幕侧 22% 渐隐，六主题 AA 复核，dark tint 加深保 4.85:1）。
滚动模式三连：卡死根因=冷直建 scrolled 路径分叉+flow() 早切不重挂——统一冷建 paginated 后运行时 applyFlow（含早切强制 clear→display）；切换错乱=spread 时序——applyFlow 单入口（spread 先于 flow、location 就绪复用 flow 内 display）；章导航=边缘 400ms 防抖自动续章（程序性落位不判定）+PgDn/PgUp 章边缘即时跳章（章中原生滚动）+落章 toast。
Rust 封面选最大图：手写 PNG IHDR/JPEG SOF(含渐进) 头解析（零依赖）；候选扩为全部 image ≤8 张（含正文大图），面积最大者胜、元数据封面≥60% 面积时优先、全败回退首候选；6 新测试。
详情页：封面 WxH 显示，宽<500 提示可换高清。

门禁：vitest 122 / cargo test 75 / tsc 零错误 / check 零警告。