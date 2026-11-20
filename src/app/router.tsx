import { createBrowserRouter, Outlet } from "react-router-dom";

import LibraryPage from "../pages/LibraryPage";
import ReaderPage from "../pages/ReaderPage";
import FavoritesPage from "../pages/FavoritesPage";
import CloudShelfPage from "../pages/CloudShelfPage";
import useLogicalBack from "../ui/useLogicalBack";

// M-3：无布局层挂 useLogicalBack（useNavigate 需要 router context，须在 RouterProvider 内层）
function LogicalBackLayer() {
  useLogicalBack();
  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    element: <LogicalBackLayer />,
    children: [
      { path: "/", element: <LibraryPage /> },
      { path: "/read/:bookId", element: <ReaderPage /> },
      { path: "/favorites", element: <FavoritesPage /> },
      { path: "/cloud-shelf", element: <CloudShelfPage /> },
    ],
  },
]);
