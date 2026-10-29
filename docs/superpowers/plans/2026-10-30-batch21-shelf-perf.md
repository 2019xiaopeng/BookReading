# 批次21：书架前端性能（v2.5.0 阶段一§1 + §3.1 + §4.2）

执行：agent B。范围：src/library/**、LibraryPage.tsx、weread.css 增量。npm test 全绿（新增 1 文件 9 用例）。

- B1 四处封面 <img>（书卡/回收站行/四宫格/拖拽 ghost）补 loading="lazy" decoding="async"；.wr-cover 已有 2/3 确认
- B2 书卡 content-visibility:auto + contain-intrinsic-size auto 前缀三档（220/320/420 密度对应），weread.css 末尾增量
- B3 BookCard 抽独立组件 + React.memo；DOM/类名/data-* 与盘点 §3 逐一比对零变化；LibraryPage 回调 useCallback/startCardDrag 经 ref 转发保引用恒定
- B4 useCoverUrls 重做：初始 state 从 urlCache 播种（回页不闪烁）；notify 50ms 合帧；并发上限 6 + IntersectionObserver 视口优先（rootMargin 200px，.wr-cover 挂 priority ref）；只对 booksFiltered + 四宫格前 4 发起（回收站不再急加载）。调度器纯函数 coverScheduler.pickNextCoverRequests
- B5 封面缩略档消费：id 存在时先探 covers/thumbs/{id}.jpg → .webp（后端不透明=JPEG/透明=webp，主控联调期对表修正），缺失静默回退原 cover_path；对外 API 签名兼容
- B6 四宫格固定取该书前 4 本（firstBooksByShelf 进 shelves.ts），未就绪格素色骨架，不随到达洗牌
- B7 占位/图片同容器 opacity 过渡（data-loaded 淡入 120ms / 占位淡出保留 DOM），prefers-reduced-motion 回退
- B8 元数据自愈循环 Promise.all 收集后 refresh 一次（原每本全量重拉）

测试：coverScheduler（上限/视口优先/FIFO）、缩略探测+回退（双扩展名）、播种、合帧、四宫格固定前4。
运行时验证（联调期由主控过）：缩略路径实际命中、content-visibility 滚动条与拖拽命中、IO 与 content-visibility 交互。
