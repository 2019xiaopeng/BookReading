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
