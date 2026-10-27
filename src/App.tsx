import { RouterProvider } from "react-router-dom";

import { router } from "./app/router";
import { DialogHost } from "./ui/dialog";

export default function App() {
  return (
    <>
      <RouterProvider router={router} />
      <DialogHost />
    </>
  );
}
