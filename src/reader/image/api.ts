import { invoke } from "@tauri-apps/api/core";
import type { Book } from "../../tauri/invoke";

export async function listImagePages(bookId: string): Promise<string[]> {
  return invoke<string[]>("list_image_pages", { bookId });
}

export async function readImagePage(bookId: string, index: number): Promise<Uint8Array> {
  const res = await invoke<ArrayBuffer | number[]>("read_image_page", { bookId, index });
  return new Uint8Array(res);
}

export async function importImageFolder(sourcePath: string, titleOpt: string | null): Promise<Book> {
  return invoke<Book>("import_image_folder", { sourcePath, titleOpt });
}

// 批次18：文件夹漫画源目录丢失后的重链接（Rust 端校验目录含图且不与其它书撞路径），返回更新后的书
export async function relinkImageBook(bookId: string, newPath: string): Promise<Book> {
  return invoke<Book>("relink_image_book", { bookId, newPath });
}
