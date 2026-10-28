import { computeBookStats, importBook, listBooks, probePaths, type Book, type PathInfo } from "../tauri/invoke";
import { importImageFolder } from "../reader/image/api";
import { logFrontend } from "../tauri/frontendLog";
import { showAlert, showChoice, showConfirm } from "../ui/dialog";

// 批量/拖拽/单本导入统一入口：进度广播 + 查重 + 结果汇总（成功/已存在跳过/失败，可一键补副本）。
// 模块级单例（同 dialog.tsx 模式）：AppShell 拖拽与书库页按钮共用，进度条挂在壳上；
// 每批结束广播 BOOKS_CHANGED_EVENT，书库页订阅后自动刷新。

export type ImportProgress = { done: number; total: number; current: string } | null;

// 导入结束（无论成败）广播：书库页订阅后刷新列表（拖拽入口不在页面内，无法直接回调）
export const BOOKS_CHANGED_EVENT = "wr:books-changed";

type Outcome = { kind: "success" | "dup" | "exists" | "failed"; name: string; path?: string; error?: string };

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

let queue: Promise<unknown> = Promise.resolve();

// 串行队列：同一时刻只跑一批导入；调用方直接拿到批结果（异常原样抛出）
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const task = queue.then(fn, fn);
  queue = task.catch(() => {});
  return task;
}

export async function runImports(paths: string[], opts?: { force?: boolean }): Promise<void> {
  if (paths.length === 0) return;
  const force = opts?.force === true;
  // 汇总与"导入全部副本"都在队列外进行：次按钮重新入队的批次不会卡在当前任务后面
  const outcomes = await enqueue(() => runImportBatch(paths, force));
  const hasIssue = outcomes.some((o) => o.kind !== "success");
  const interactive = !force && paths.length === 1;
  // 单项全部成功保持静默；单项交互式（exists/dup 已当面处理）无失败也不打扰
  if (interactive && !outcomes.some((o) => o.kind === "failed")) return;
  if (outcomes.length > 1 || hasIssue) await showSummary(outcomes);
}

export type SingleImportResult = { kind: Outcome["kind"]; error?: string };

/** 批次16：单本导入（按钮/拖单文件）——查重当面交互（exists 提示 / dup 问副本），无汇总弹窗；错误交调用方分流 */
export async function importSingle(path: string): Promise<SingleImportResult> {
  const [o] = await enqueue(() => runImportBatch([path], false));
  return o ? { kind: o.kind, error: o.error } : { kind: "failed", error: "无法读取" };
}

// 库内实况查重索引：旧书 file_size 为空先补算，才有字节数可比
async function buildLiveDedupIndex(): Promise<DedupIndex> {
  const books = await listBooks().catch((): Book[] => []);
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
  return buildDedupIndex(books);
}

async function importOne(info: PathInfo): Promise<void> {
  if (info.is_dir) {
    await importImageFolder(info.path, null);
    return;
  }
  if (!isImportableFile(info.name)) throw new Error("不支持的格式（仅 EPUB / TXT / CBZ / PDF / 漫画文件夹）");
  if (info.name.toLowerCase().endsWith(".cbz")) {
    await importImageFolder(info.path, null);
    return;
  }
  await importBook({
    source_path: info.path,
    title: null,
    author: null,
    cover_bytes_base64: null,
    cover_ext: null,
  });
}

async function runImportBatch(paths: string[], force: boolean): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  // 单本导入=交互式（exists 弹提示、dup 问是否导入副本）；批量=静默跳过，汇总里可一键补副本
  const interactive = !force && paths.length === 1;
  try {
    const infos = await probePaths(paths).catch((e): PathInfo[] => {
      logFrontend(`import: probe failed ${String(e)}`);
      return [];
    });
    // 探针失败的路径按失败记（无 is_dir/size 无法安全导入）
    const probed = new Map(infos.map((i) => [i.path, i]));
    for (const p of paths) {
      if (!probed.has(p)) outcomes.push({ kind: "failed", name: p.split(/[\\/]/).pop() ?? p, path: p, error: "无法读取" });
    }

    const index = force ? null : await buildLiveDedupIndex();

    const list = infos;
    for (let i = 0; i < list.length; i++) {
      const info = list[i];
      emit({ done: i, total: list.length, current: info.name });
      if (index) {
        const dup = checkDuplicate(info, index);
        if (dup.kind === "exists") {
          if (interactive) {
            await showAlert("已在书架中（原地引用）", `《${info.name}》已在书架中，未重复导入。`);
          }
          outcomes.push({ kind: "exists", name: info.name, path: info.path });
          continue;
        }
        if (dup.kind === "dup") {
          const copy =
            interactive &&
            await showConfirm("导入副本？", `《${info.name}》疑似已导入（同名同大小），是否仍导入副本？`, {
              confirmText: "导入副本",
            });
          if (!copy) {
            outcomes.push({ kind: "dup", name: info.name, path: info.path });
            continue;
          }
        }
      }
      try {
        await importOne(info);
        // 批内索引同步：同批后续项的查重不漏刚导入的书
        if (index) {
          if (info.is_dir) index.folderPaths.add(normPath(info.path));
          else addSize(index.byName, info.name.toLowerCase(), info.size);
        }
        outcomes.push({ kind: "success", name: info.name });
      } catch (e) {
        outcomes.push({ kind: "failed", name: info.name, path: info.path, error: String(e) });
        logFrontend(`import: failed ${info.path} ${String(e)}`);
      }
    }
  } finally {
    emit(null);
    if (typeof window !== "undefined") window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
  }
  return outcomes;
}

async function showSummary(outcomes: Outcome[]) {
  const sections: string[] = [];
  const section = (label: string, items: Outcome[]) => {
    if (items.length === 0) return;
    const lines = items.map((o) => `· ${o.name}${o.error ? `：${o.error}` : ""}`).join("\n");
    sections.push(`${label} ${items.length}\n${lines}`);
  };
  section("成功", outcomes.filter((o) => o.kind === "success"));
  section("已存在（跳过）", outcomes.filter((o) => o.kind === "exists" || o.kind === "dup"));
  section("失败", outcomes.filter((o) => o.kind === "failed"));
  const skipped = outcomes
    .filter((o) => (o.kind === "exists" || o.kind === "dup") && o.path)
    .map((o) => o.path as string);
  const body = sections.join("\n\n") || "没有可导入的内容";
  if (skipped.length === 0) {
    await showAlert("导入汇总", body);
    return;
  }
  const act = await showChoice("导入汇总", body, { confirmText: "关闭", secondaryText: `导入全部副本（${skipped.length}）` });
  if (act === "secondary") await runImports(skipped, { force: true });
}
