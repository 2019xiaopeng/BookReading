import { createBrowserRouter } from "react-router-dom";

import LibraryPage from "../pages/LibraryPage";
import ReaderPage from "../pages/ReaderPage";
import FavoritesPage from "../pages/FavoritesPage";

export const router = createBrowserRouter([
  { path: "/", element: <LibraryPage /> },
  { path: "/read/:bookId", element: <ReaderPage /> },
  { path: "/favorites", element: <FavoritesPage /> },
]);
