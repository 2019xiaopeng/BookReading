import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import type { Book } from "../tauri/invoke";
import { listBooks } from "../tauri/invoke";

export default function ReaderPage() {
  const navigate = useNavigate();
  const { bookId } = useParams();
  const [book, setBook] = useState<Book | null>(null);

  useEffect(() => {
    (async () => {
      const books = await listBooks();
      const found = books.find((b) => b.id === bookId) ?? null;
      setBook(found);
    })();
  }, [bookId]);

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={() => navigate("/")}>返回书库</button>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{book?.title ?? "阅读"}</div>
      </div>

      <div style={{ color: "rgba(0,0,0,0.6)" }}>阅读器功能将在下一步接入。</div>
    </div>
  );
}

