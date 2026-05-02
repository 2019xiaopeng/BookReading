import { invoke } from "@tauri-apps/api/core";

export type Book = {
  id: string;
  title: string | null;
  author: string | null;
  cover_path: string | null;
  library_path: string;
  added_at: number;
  last_opened_at: number | null;
};

export type ImportBookRequest = {
  source_path: string;
  title: string | null;
  author: string | null;
  cover_bytes_base64: string | null;
  cover_ext: string | null;
};

export async function listBooks(): Promise<Book[]> {
  return invoke<Book[]>("list_books");
}

export async function importBook(req: ImportBookRequest): Promise<Book> {
  return invoke<Book>("import_book", { req });
}

export async function deleteBook(bookId: string): Promise<void> {
  return invoke<void>("delete_book", { book_id: bookId });
}

export async function getSettings(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("get_settings");
}

export async function setSetting(key: string, value: string): Promise<void> {
  return invoke<void>("set_setting", { key, value });
}
