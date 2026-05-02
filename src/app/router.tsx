import { createBrowserRouter } from "react-router-dom";

import LibraryPage from "../pages/LibraryPage";
import ReaderPage from "../pages/ReaderPage";

export const router = createBrowserRouter([
  { path: "/", element: <LibraryPage /> },
  { path: "/read/:bookId", element: <ReaderPage /> },
]);

