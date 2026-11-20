// P-1 导入共享服务：侧栏底部固定导入钮（任意视图可用）与书库页菜单共用同一份流程。
// 落架目标 = 模块级「当前书架」（LibraryPage 切架时推写，缺省根）；并发安全由 importRunner 串行队列兜底；
// 结果提示（查重交互/汇总弹窗）与结束后的 BOOKS_CHANGED_EVENT 刷新广播都在 importRunner 内。
import { open } from "@tauri-apps/plugin-dialog";
import { listImageSubdirs } from "../tauri/invoke";
import { importSingle, runImports } from "../library/importRunner";
import { logFrontend } from "../tauri/frontendLog";
import { showAlert, showConfirm } from "./dialog";

let currentShelfId: number | null = null;

export function setImportTargetShelf(id: number | null): void {
  currentShelfId = id;
}

export async function importBooks(): Promise<void> {
  const selected = await open({
    multiple: true,
    filters: [{ name: "EPUB / TXT / CBZ / PDF", extensions: ["epub", "txt", "cbz", "pdf"] }],
  });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  if (paths.length === 0) return;
  await runImports(paths, { targetShelfId: currentShelfId });
}

export async function importImages(): Promise<void> {
  const dir = await open({ directory: true, multiple: false, title: "选择漫画文件夹" });
  if (!dir || Array.isArray(dir)) return;
  // 单本漫画也走 importRunner（查重交互 + BOOKS_CHANGED_EVENT 自动刷新书卡）
  const res = await importSingle(dir, { targetShelfId: currentShelfId });
  if (res.kind !== "failed") return;
  const msg = res.error ?? "";
  logFrontend(`ui: import image folder failed ${dir} ${msg}`);
  // 实测根因：把「每本一个子文件夹」的父目录当单本导入——直接子项全是子文件夹 → 无图。
  // 此时若子文件夹里有漫画，引导走批量导入而不是报错退出
  const subdirs = msg.includes("未找到图片") ? await listImageSubdirs(dir).catch(() => [] as string[]) : [];
  if (subdirs.length > 0) {
    const batch = await showConfirm(
      "改为批量导入？",
      `该文件夹内没有直接图片，但包含 ${subdirs.length} 个图片子文件夹。\n按每个子文件夹一本批量导入。`,
      { confirmText: "批量导入" },
    );
    if (batch) await runImports(subdirs, { targetShelfId: currentShelfId });
  } else {
    await showAlert("导入失败", msg);
  }
}
