// V-3 开场动画：冷启动时壳（侧栏 + 主栏）各淡入一次，画法在 weread.css 的 .wr-shell--intro。
// 只播一次：整个进程里只有 AppLayout 第一次挂载时 pending 还是 true——托盘唤起不重挂壳；
// 从阅读页回到壳会重挂，但那时 pending 已经是 false。动画只改 opacity，不动布局、不挡数据加载。
export const introState = { pending: true };
