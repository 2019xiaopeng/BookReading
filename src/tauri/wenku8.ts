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

/** book_id 非空=已入库（可直接 /read/:book_id）；last_cid=入库时最后一章 cid，未入库为 0 */
export type Wenku8ShelfBook = {
  aid: number;
  name: string | null;
  date: string | null;
  book_id: string | null;
  last_cid: number;
};

export type Wenku8BookInfo = {
  aid: number;
  title: string;
  author: string;
  status: string;
  last_update: string;
  latest_cid: number;
  intro: string | null;
  /** bookinfo 的 Tags 字段按空白切分（Rust Vec<String>，无标签为空数组） */
  tags: string[];
};

export type Wenku8DownloadResult = {
  book_id: string;
  title: string;
  chapters: number;
};

/** 卷章目录（action=book&do=list） */
export type Wenku8Chapter = {
  cid: number;
  title: string;
};

export type Wenku8Volume = {
  name: string;
  chapters: Wenku8Chapter[];
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

/** shelfId 空串=默认（根）；书随导入入库后挂到该书架（'' 归一为 null，数字串转 number） */
export function wenku8Download(aid: number, shelfId: string): Promise<Wenku8DownloadResult> {
  const shelfIdArg = shelfId === "" ? null : Number(shelfId);
  return invoke<Wenku8DownloadResult>("wenku8_download", { aid, shelfId: shelfIdArg });
}

export function wenku8Catalog(aid: number): Promise<Wenku8Volume[]> {
  return invoke<Wenku8Volume[]>("wenku8_catalog", { aid });
}

/** 退出登录：清掉本机保存的账密与会话 cookie（页面侧随后回登录卡） */
export function wenku8Logout(): Promise<void> {
  return invoke<void>("wenku8_logout");
}

/** C-2 端点状态：当前设置 + auto 会话记忆 + 两地址连通探测（短超时，结果不落库）。
 *  字段与 Rust Wenku8EndpointStatus 一致（该结构体无 camelCase rename，保持 snake_case）。 */
export type Wenku8EndpointStatus = {
  setting: string; // settings 实际值："auto" | "relay" | "direct"
  session: string; // auto 会话记忆："relay" | "direct" | ""（本会话未发生过切换）
  relay_ok: boolean;
  direct_ok: boolean;
};

export function wenku8EndpointStatus(): Promise<Wenku8EndpointStatus> {
  return invoke<Wenku8EndpointStatus>("wenku8_endpoint_status");
}
