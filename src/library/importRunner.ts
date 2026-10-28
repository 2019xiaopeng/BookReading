import { computeBookStats, importBook, listBooks, probePaths, type Book, type PathInfo } from "../tauri/invoke";
import { importImageFolder } from "../reader/image/api";
import { logFrontend } from "../tauri/frontendLog";
import { showAlert } from "../ui/dialog";

// 批量/拖拽导入统一入口：进度广播 + 查重 + 四类汇总（成功/已存在/疑似重复/失败）。
// 模块级单例（同 dialog.tsx 模式）：AppShell 拖拽与书库页按钮共用，进度条挂在壳上。

export type ImportProgress = { done: number; total: number; current: string } | null;

// 导入结束（无论成败）广播：书库页订阅后刷新列表（拖拽入口不在页面内，无法直接回调）
export const BOOKS_CHANGED_EVENT = "wr:books-changed";

type Outcome = { kind: "success" | "dup" | "exists" | "failed"; name: string; error?: string };

const listeners = new Set<(p: ImportProgress) => void>();

export function subscribeImportProgress(fn: (p: ImportProgress) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(p: ImportProgress) {
  for (const l of listeners) l(p);
}

export type DedupIndex = {
  folderPaths: Set<string>;
  // 库内文件按 basename 与标题两种键各挂一份字节数（复制入库的 basename 是 uuid，标题更贴近源文件名）
  byName: Map<string, Set<number>>;
};

function normPath(p: string): string {
  return p.split("\\").join("/").toLowerCase();
}

function addSize(map: Map<string, Set<number>>, key: string, size: number) {
  const set = map.get(key) ?? new Set<number>();
  set.add(size);
  map.set(key, set);
}

export function buildDedupIndex(books: Book[]): DedupIndex {
  const folderPaths = new Set<string>();
  const byName = new Map<string, Set<number>>();
  for (const b of books) {
    const lp = b.library_path.split("\\").join("/");
    const abs = /^([a-zA-Z]:|\/)/.test(lp);
    if (abs) {
      // 文件夹漫画=原地引用：整路径即身份
      folderPaths.add(lp.toLowerCase());
      if (b.file_size != null) addSize(byName, (b.title ?? "").trim().toLowerCase(), b.file_size);
      continue;
    }
    if (b.file_size == null) continue;
    const basename = lp.split("/").pop() ?? "";
    if (basename) addSize(byName, basename.toLowerCase(), b.file_size);
    addSize(byName, (b.title ?? "").trim().toLowerCase(), b.file_size);
  }
  return { folderPaths, byName };
}

export type ImportCheck = { kind: "exists" | "dup" | null };

// info.name 为源文件/目录名；dup = 同名（basename 或标题）同字节数
export function checkDuplicate(info: PathInfo, index: DedupIndex): ImportCheck {
  if (info.is_dir) {
    return { kind: index.folderPaths.has(normPath(info.path)) ? "exists" : null };
  }
  const stem = info.name.toLowerCase().replace(/\.[^.]+$/, "");
  const sizes = index.byName.get(info.name.toLowerCase()) ?? index.byName.get(stem);
  return { kind: sizes?.has(info.size) ? "dup" : null };
}

const IMPORTABLE_EXTS = new Set(["epub", "txt", "cbz", "pdf"]);

export function isImportableFile(name: string): boolean {
  return IMPORTABLE_EXTS.has((name.split(".").pop() ?? "").toLowerCase());
}

let queue: Promise<void> = Promise.resolve();

export async function runImports(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const task = queue.then(() => runImportBatch(paths));
  queue = task.catch(() => {});
  await task;
}

async function runImportBatch(paths: string[]) {
  const outcomes: Outcome[] = [];
  try {
    const infos = await probePaths(paths).catch((e): PathInfo[] => {
      logFrontend(`import: probe failed ${String(e)}`);
      return [];
    });
    // 探针失败的路径按失败记（无 is_dir/size 无法安全导入）
    const probed = new Map(infos.map((i) => [i.path, i]));
    for (const p of paths) {
      if (!probed.has(p)) outcomes.push({ kind: "failed", name: p.split(/[\\/]/).pop() ?? p, error: "无法读取" });
    }

    const books = await listBooks().catch((): Book[] => []);
    // 旧书 file_size 为空 → 先补算，查重才有字节数可比
    for (const b of books) {
      if (b.file_size == null) {
        try {
          const updated = await computeBookStats(b.id);
          b.file_size = updated.file_size;
        } catch {
          // 补算失败：该书不参与大小查重
        }
      }
    }
    const index = buildDedupIndex(books);

    const list = infos;
    for (let i = 0; i < list.length; i++) {
      const info = list[i];
      emit({ done: i, total: list.length, current: info.name });
      const dup = checkDuplicate(info, index);
      if (dup.kind === "exists") {
        outcomes.push({ kind: "exists", name: info.name });
        continue;
      }
      try {
        if (info.is_dir) {
          await importImageFolder(info.path, null);
          index.folderPaths.add(normPath(info.path));
        } else if (isImportableFile(info.name)) {
          if (info.name.toLowerCase().endsWith(".cbz")) {
            await importImageFolder(info.path, null);
          } else {
            await importBook({
              source_path: info.path,
              title: null,
              author: null,
              cover_bytes_base64: null,
              cover_ext: null,
            });
          }
          const basename = info.name.toLowerCase();
          addSize(index.byName, basename, info.size);
        } else {
          outcomes.push({ kind: "failed", name: info.name, error: "不支持的格式（仅 EPUB / TXT / CBZ / PDF / 漫画文件夹）" });
          continue;
        }
        outcomes.push(dup.kind === "dup" ? { kind: "dup", name: info.name } : { kind: "success", name: info.name });
      } catch (e) {
        outcomes.push({ kind: "failed", name: info.name, error: String(e) });
        logFrontend(`import: failed ${info.path} ${String(e)}`);
      }
    }
  } finally {
    emit(null);
    window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
  }

  // 汇总：单项全部成功时保持原有静默行为，不打扰
  const hasIssue = outcomes.some((o) => o.kind !== "success");
  if (outcomes.length > 1 || hasIssue) {
    await showSummary(outcomes);
  }
}

const OUTCOME_LABELS: Record<Outcome["kind"], string> = {
  success: "成功",
  exists: "已存在（跳过）",
  dup: "疑似重复（同名同大小，已导入）",
  failed: "失败",
};

async function showSummary(outcomes: Outcome[]) {
  const sections: string[] = [];
  for (const kind of ["success", "exists", "dup", "failed"] as const) {
    const items = outcomes.filter((o) => o.kind === kind);
    if (items.length === 0) continue;
    const lines = items.map((o) => `· ${o.name}${o.error ? `：${o.error}` : ""}`).join("\n");
    sections.push(`${OUTCOME_LABELS[kind]} ${items.length}\n${lines}`);
  }
  await showAlert("导入汇总", sections.join("\n\n") || "没有可导入的内容");
}
