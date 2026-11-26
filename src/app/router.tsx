import { useEffect, useLayoutEffect, useState } from "react";
import { createBrowserRouter, Outlet, useLocation } from "react-router-dom";

import LibraryPage from "../pages/LibraryPage";
import ReaderPage from "../pages/ReaderPage";
import FavoritesPage from "../pages/FavoritesPage";
import CloudShelfPage from "../pages/CloudShelfPage";
import useLogicalBack from "../ui/useLogicalBack";
import AppShell from "../ui/AppShell";
import { introState } from "../ui/intro";
import { usePageMeta } from "../ui/pageMeta";

// M-3：无布局层挂 useLogicalBack（useNavigate 需要 router context，须在 RouterProvider 内层）
function LogicalBackLayer() {
  useLogicalBack();
  return <Outlet />;
}

// 批次8：唯一常驻壳——此前每页各自包 AppShell，路由切换=同一位置换父组件=整壳重挂（侧栏闪烁根因）；
// 现在壳只此一份，页面经 pageMeta store 注入 active/title/search/...，children=当前路由 Outlet。
// 阅读页在壳外（LogicalBackLayer 直挂），维持全屏现状
export function AppLayout() {
  const meta = usePageMeta();
  const { pathname } = useLocation();
  // V-3 开场动画：进程内第一次挂载壳（冷启动）才播。初值在渲染里读、挂载后立刻把标记用掉——
  // 不能用「读一次就消耗」的取法：StrictMode 开发模式下同一次挂载会连着渲染两次，第二次就成 false 了
  const [intro, setIntro] = useState(introState.pending);
  useEffect(() => {
    introState.pending = false;
    // 「减少动态效果」下 CSS 动画被全局关掉、不会有 animationend：直接收场
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) setIntro(false);
  }, []);
  // 滚动容器随壳常驻后跨页保留 scrollTop：切页回顶（布局期先于页面还原 effect）；
  // 书库自身的滚动记忆由 LibraryPage 挂载后的还原 effect 接管
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>(".wr-main-scroll");
    if (el) el.scrollTop = 0;
  }, [pathname]);
  return (
    <AppShell
      {...meta}
      intro={intro}
      onIntroEnd={(e) => {
        // 主栏那段带 80ms 延迟、最后结束；侧栏先结束时不能撤类，否则主栏会从半透明直接跳到不透明
        if (e.animationName === "wr-intro-in" && (e.target as HTMLElement).classList.contains("wr-main")) setIntro(false);
      }}
    >
      <Outlet />
    </AppShell>
  );
}

export const router = createBrowserRouter([
  {
    element: <LogicalBackLayer />,
    errorElement: (
      <div style={{ padding: 48, fontFamily: "Segoe UI, sans-serif", color: "#333" }}>
        <h2>页面出错了</h2>
        <p style={{ fontSize: 14, color: "#666" }}>阅读器内部发生异常，请返回书架重新打开这本书。切换字体/排版时偶发的此错误不影响书库数据。</p>
        <button
          style={{ marginTop: 20, padding: "10px 24px", cursor: "pointer" }}
          onClick={() => window.location.assign("/")}
        >
          返回书架
        </button>
      </div>
    ),
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: "/", element: <LibraryPage /> },
          { path: "/favorites", element: <FavoritesPage /> },
          { path: "/cloud-shelf", element: <CloudShelfPage /> },
        ],
      },
      { path: "/read/:bookId", element: <ReaderPage /> },
    ],
  },
]);
