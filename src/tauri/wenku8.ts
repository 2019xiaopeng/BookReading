// v3.0 wenku8 云书架 invoke 契约（与 src-tauri/src/commands/wenku8.rs 一一对应，冻结）。

import { invoke } from "@tauri-apps/api/core";

export type Wenku8LoginResult = {
  ok: boolean;
  errcode: number;
  message: string;
};

/** 是否存过账密（不代表会话仍有效；会话失效时后端命令自动重登） */
export type Wenku8Status = {
  has_saved: boolean;
  username: string | null;
};

export type Wenku8ShelfBook = {
  aid: number;
  name: string | null;
  date: string | null;
};

export type Wenku8BookInfo = {
  aid: number;
  title: string;
  author: string;
  status: string;
  last_update: string;
  latest_cid: number;
  intro: string | null;
};

export type Wenku8DownloadResult = {
  book_id: string;
  title: string;
  chapters: number;
};

/** 下载进度事件（listen 频道 "wr:wenku8-progress"）载荷 */
export type Wenku8ProgressEvent = {
  aid: number;
  done: number;
  total: number;
};

/** errcode → 中文提示（协议实测：0 请求错误 / 2 用户名错 / 3 密码错 / 4 未登录 …） */
export function wenku8ErrcodeMessage(errcode: number): string {
  switch (errcode) {
    case 0:
      return "请求发生错误，请稍后重试";
    case 2:
      return "用户名错误";
    case 3:
      return "密码错误";
    case 4:
      return "请先登录";
    case 5:
      return "已经在书架";
    case 6:
      return "书架已满";
    case 7:
      return "小说不在书架";
    default:
      return `未知错误 ${errcode}`;
  }
}

export function wenku8Login(username: string, password: string): Promise<Wenku8LoginResult> {
  return invoke<Wenku8LoginResult>("wenku8_login", { username, password });
}

export function wenku8Status(): Promise<Wenku8Status> {
  return invoke<Wenku8Status>("wenku8_status");
}

export function wenku8Bookshelf(): Promise<Wenku8ShelfBook[]> {
  return invoke<Wenku8ShelfBook[]>("wenku8_bookshelf");
}

export function wenku8BookInfo(aid: number): Promise<Wenku8BookInfo> {
  return invoke<Wenku8BookInfo>("wenku8_book_info", { aid });
}

export function wenku8Download(aid: number): Promise<Wenku8DownloadResult> {
  return invoke<Wenku8DownloadResult>("wenku8_download", { aid });
}
