import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useNavigate } from "react-router-dom";

import {
  wenku8BookInfo,
  wenku8Bookshelf,
  wenku8Catalog,
  wenku8Download,
  wenku8ErrcodeMessage,
  wenku8Login,
  wenku8Logout,
  wenku8Status,
  type Wenku8BookInfo,
  type Wenku8ProgressEvent,
  type Wenku8ShelfBook,
  type Wenku8Volume,
} from "../tauri/wenku8";
import { createShelf, getSettings, listShelves, setSetting, type Shelf } from "../tauri/invoke";
import { DENSITY_PRESETS, normalizeLibraryDensity, type LibraryDensity } from "../library/density";
import { setPageMeta } from "../ui/pageMeta";
import { subscribeAppRefresh } from "../ui/appActions";
import { IconBookOpen, IconDensity, IconDownload, IconSort } from "../ui/icons";
import { showToast } from "../ui/toast";
import { showAlert } from "../ui/dialog";

// 封面直链无鉴权：卷目录 = aid 整除 1000（协议实测，docs/开发计划-v3.0.md §2）
function coverUrl(aid: number): string {
  return `http://img.wenku8.com/image/${Math.floor(aid / 1000)}/${aid}/${aid}s.jpg`;
}

// F4/批次11 D-3 网页版入口统一（照设置页 GitHub 链接先例：打开失败退复制链接提示）
async function openWebUrl(url: string) {
  try {
    await openUrl(url);
  } catch {
    try {
      await navigator.clipboard.writeText(url);
      showToast("已复制网页版链接");
    } catch {
      void showAlert("打开网页版失败", url);
    }
  }
}

// settings 表键：目标书架（'' = 默认根）
const DEST_SHELF_KEY = "wenku8.dest_shelf";

// settings 表键：云书架排序（added=收藏顺序，即 API 返回序=云端新收藏在前）
const SORT_KEY = "wenku8.sort";
type CloudSort = "added" | "updated" | "title";
const CLOUD_SORT_LABELS: Record<CloudSort, string> = { added: "收藏顺序", updated: "最近更新", title: "书名" };

function normalizeCloudSort(v: unknown): CloudSort {
  return v === "updated" || v === "title" ? v : "added";
}

// 书籍元信息懒取：会话级缓存 + in-flight 去重（书架接口对未看过的书不返回 name；详情/新章比对共用）
const infoCache = new Map<number, Wenku8BookInfo>();
const infoInflight = new Map<number, Promise<void>>();

// 公益中继限流：bookinfo 最多 3 并发，超出排队（FIFO）——整架懒取不再同拍打满
const infoQueue: Array<() => void> = [];
let infoActive = 0;
function infoSlot(): Promise<void> {
  if (infoActive < 3) {
    infoActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => infoQueue.push(() => {
    infoActive++;
    resolve();
  }));
}
function infoRelease() {
  infoActive--;
  const next = infoQueue.shift();
  if (next) next();
}

function ensureInfo(aid: number): Promise<void> {
  const cached = infoCache.has(aid) ? Promise.resolve() : infoInflight.get(aid);
  if (cached) return cached;
  const p = (async () => {
    await infoSlot();
    try {
      const info = await wenku8BookInfo(aid);
      infoCache.set(aid, info);
    } finally {
      infoRelease();
    }
  })();
  infoInflight.set(aid, p);
  return p;
}

// F2 有新章比对：会话内每本书只查一次（刷新书架不重查）
const checkedNew = new Set<number>();

// P-2 云书架会话缓存：切走再切回直接渲染旧数据（不重拉不闪 loading）；
// 仅显式刷新 / 拉取完成 / 登录成功才真正重拉（重拉期间旧数据照常显示）
// （书名/元信息不缓存：模块级 infoCache 同会话存活，重挂时由它重建）
type CloudShelfCache = {
  books: Wenku8ShelfBook[];
  hasNew: Set<number>;
  syncText: string | null;
  account: string;
};
let shelfCache: CloudShelfCache | null = null;

function writeShelfCache(patch: Partial<CloudShelfCache>): void {
  shelfCache = {
    books: shelfCache?.books ?? [],
    hasNew: shelfCache?.hasNew ?? new Set(),
    syncText: shelfCache?.syncText ?? null,
    account: shelfCache?.account ?? "",
    ...patch,
  };
}

/** 测试隔离：模块级缓存会跨用例泄漏，每个用例后清空 */
export function resetCloudShelfCacheForTests(): void {
  shelfCache = null;
  infoCache.clear();
  infoInflight.clear();
  checkedNew.clear();
  infoQueue.length = 0;
  infoActive = 0;
}

// 拉取锁：页面级一次一本（downloading 期间其它拉取钮禁用）
type DlState =
  | { phase: "downloading"; done: number; total: number }
  | { phase: "done" }
  | { phase: "error"; message: string };

// 批次10 F-2 目标书架自绘下拉：自绘弹层（原生 select 弹层做不了"新建书架"交互），
// 含「＋ 新建书架…」原位内联输入（回车确认 / Esc 取消，重名沿用后端报错）
function ShelfPicker({
  shelves,
  value,
  onChange,
  onShelves,
}: {
  shelves: Shelf[];
  value: string;
  onChange: (v: string) => void;
  onShelves: (list: Shelf[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Portal 弹层视口定位（根治：详情对话框随简介变高 + overflow:auto 裁切内嵌弹层的问题）
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number; width: number } | null>(null);

  const active = open || creating;

  function openMenu() {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) {
      setOpen(true);
      return;
    }
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const useAbove = below < 200 && above > below;
    const space = Math.max(160, useAbove ? above : below);
    const maxHeight = Math.min(300, space);
    setPos({
      left: r.left,
      top: useAbove ? Math.max(8, r.top - maxHeight - 4) : r.bottom + 4,
      maxHeight,
      width: Math.max(r.width, 220),
    });
    setOpen(true);
  }

  // 外点关闭；Esc 只收下拉不关对话框（捕获期拦截）；对话框内滚动即收（弹层已 Portal 不随滚）
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !menuRef.current?.contains(t)) {
        setOpen(false);
        setCreating(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        setCreating(false);
      }
    };
    const onScroll = (e: Event) => {
      // 菜单自身滚动不收（否则列表一滚就关）；只在外层（详情对话框）滚动时收——弹层是 fixed 不随滚，留着会错位
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    // keydown 须捕获期注册：气泡期拦在 React 根监听之后，Esc 会先关掉整个对话框
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [active]);

  async function submitCreate() {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const shelf = await createShelf(n, null);
      onShelves(await listShelves());
      onChange(String(shelf.id)); // 自动选中新架（onChange 内含 dest_shelf 记忆）
      setCreating(false);
      setName("");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const label = shelves.find((s) => String(s.id) === value)?.name ?? "默认（根）";

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      {creating ? (
        <input
          className="wr-input"
          style={{ width: 150, padding: "5px 10px", fontSize: 12 }}
          aria-label="新书架名称"
          placeholder="新书架名称，回车确认"
          autoFocus
          disabled={busy}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submitCreate();
          }}
        />
      ) : (
        <>
          <button
            ref={btnRef}
            type="button"
            className="wr-cloud-picker-btn"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label="目标书架"
            title={label}
            onClick={() => (open ? setOpen(false) : openMenu())}
          >
            <span className="wr-cloud-picker-label">{label}</span>
            <span aria-hidden="true" style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>▾</span>
          </button>
          {open && pos
            ? createPortal(
                /* 批次13 F-3 + 发布前补：Portal 到 body 的 fixed 弹层——对话框 overflow/圆角裁不到；
                   书架过多定高可滚，「＋ 新建书架…」sticky 常驻在 CSS；对话框滚动即收（见 effect） */
                <div
                  ref={menuRef}
                  className="wr-menu wr-cloud-picker-menu"
                  role="listbox"
                  aria-label="目标书架选项"
                  style={{
                    position: "fixed",
                    left: pos.left,
                    top: pos.top,
                    width: pos.width,
                    maxHeight: pos.maxHeight,
                    overflowY: "auto",
                    zIndex: 2000,
                  }}
                >
              <button
                type="button"
                className="wr-menu-item"
                role="option"
                aria-selected={value === ""}
                data-checked={value === ""}
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                默认（根）
              </button>
              {shelves.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="wr-menu-item"
                  role="option"
                  aria-selected={value === String(s.id)}
                  data-checked={value === String(s.id)}
                  onClick={() => {
                    onChange(String(s.id));
                    setOpen(false);
                  }}
                >
                  {s.name}
                </button>
              ))}
              <button
                type="button"
                className="wr-menu-item"
                role="option"
                aria-selected={false}
                onClick={() => {
                  setOpen(false);
                  setCreating(true);
                }}
              >
                ＋ 新建书架…
              </button>
                </div>,
                document.body,
              )
            : null}
        </>
      )}
      {err ? <div className="wr-cloud-picker-err" role="alert">{err}</div> : null}
    </div>
  );
}

// F1 详情对话框：大封面 + 完整元信息 + 卷章目录（默认收起）+ 简介 + 底部目标书架/拉取
function CloudBookDialog({
  book,
  shelves,
  destShelf,
  onDestShelf,
  onShelves,
  pullBusy,
  onPull,
  onClose,
  coverFailed,
  onCoverError,
}: {
  book: Wenku8ShelfBook;
  shelves: Shelf[];
  destShelf: string;
  onDestShelf: (v: string) => void;
  onShelves: (list: Shelf[]) => void;
  pullBusy: boolean;
  onPull: (aid: number, shelfId: string) => void;
  onClose: () => void;
  coverFailed: boolean;
  onCoverError: (aid: number) => void;
}) {
  const navigate = useNavigate();
  const [info, setInfo] = useState<Wenku8BookInfo | null>(() => infoCache.get(book.aid) ?? null);
  const [catalog, setCatalog] = useState<Wenku8Volume[] | null>(null);
  const [catOpen, setCatOpen] = useState(false);

  useEffect(() => {
    let disposed = false;
    void ensureInfo(book.aid)
      .then(() => {
        if (!disposed) setInfo(infoCache.get(book.aid) ?? null);
      })
      .catch(() => {});
    // 目录独立拉，失败不拖垮元信息（按钮停留「目录获取中…」可重开）
    void wenku8Catalog(book.aid)
      .then((v) => {
        if (!disposed) setCatalog(v);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [book.aid]);

  const imported = book.book_id != null;
  const title = info?.title ?? book.name ?? "正在获取书名…";
  const chapCount = catalog?.reduce((n, v) => n + v.chapters.length, 0) ?? 0;

  return (
    <div
      className="wr-prompt-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* 批次12 U-3：撤玻璃——结构与样式类直接复用书库 BookDetailsDialog 同一套
          （wr-prompt-overlay / wr-panel wr-prompt wr-dialog / wr-details / wr-details-cover），
          弹窗整体随 wr-dialog 滚动；云特有内容（标签/目录/书架下拉/网页版/拉取）照旧 */}
      <div
        className="wr-panel wr-prompt wr-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`书籍详情 ${title}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="wr-prompt-title">书籍详情</div>
        <div className="wr-details">
          <div className="wr-details-cover" style={{ cursor: "default" }}>
            {coverFailed ? (
              <>
                <div className="wr-cover-title">{title}</div>
                <div className="wr-cover-author">{info?.author?.trim() || "未知作者"}</div>
              </>
            ) : (
              <img src={coverUrl(book.aid)} alt="" onError={() => onCoverError(book.aid)} />
            )}
          </div>
          <div className="wr-details-main">
            {/* 完整书名不截断（默认换行） */}
            <div style={{ fontWeight: 750, fontSize: 16 }}>{title}</div>
            <div className="wr-muted" style={{ fontSize: 12 }}>
              {info
                ? `${info.author || "未知作者"} · ${info.status || "—"} · 最近更新 ${info.last_update || "—"}`
                : "正在获取…"}
            </div>
            {/* 批次10 F-1 标签：墨线细边小 chips 一排（空数组不渲染该行） */}
            {info?.tags?.length ? (
              <div className="wr-cloud-tags">
                {info.tags.map((t) => (
                  <span key={t} className="wr-cloud-tag-chip">{t}</span>
                ))}
              </div>
            ) : null}
            <div>
              <button
                type="button"
                className="wr-btn"
                style={{ padding: "4px 10px", fontSize: 12 }}
                disabled={catalog == null}
                onClick={() => setCatOpen((v) => !v)}
              >
                {catalog == null ? "目录获取中…" : catOpen ? "收起目录" : `共 ${catalog.length} 卷 ${chapCount} 章`}
              </button>
            </div>
            {catOpen ? (
              <div style={{ maxHeight: 240, overflowY: "auto", fontSize: 12, lineHeight: 1.9 }}>
                {catalog?.map((v) => (
                  <div key={v.name}>
                    <div style={{ fontWeight: 650 }}>{v.name}</div>
                    {v.chapters.map((c) => (
                      <div key={c.cid} className="wr-muted">{c.title}</div>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
            {/* P-3 简介默认全部展开（去折叠钮），完整显示 */}
            {info?.intro ? (
              <div style={{ fontSize: 13, whiteSpace: "pre-line" }}>{info.intro}</div>
            ) : null}
          </div>
        </div>
        <div className="wr-prompt-actions">
          {imported ? (
            <span className="wr-muted" style={{ fontSize: 12, marginRight: "auto", alignSelf: "center" }}>
              已入库，增量更新将随后续版本提供
            </span>
          ) : (
            <span
              className="wr-muted"
              style={{ fontSize: 12, marginRight: "auto", alignSelf: "center", display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              拉到
              {/* 批次10 F-2：自绘下拉（可新建书架），弹层回归原版 wr-menu 墨线 */}
              <ShelfPicker shelves={shelves} value={destShelf} onChange={onDestShelf} onShelves={onShelves} />
            </span>
          )}
          {/* 批次11 D-3 每本书的网页版入口：次级小钮，同顶栏网页版的失败退复制 */}
          <button
            type="button"
            className="wr-btn"
            style={{ padding: "4px 10px", fontSize: 12, alignSelf: "center" }}
            title={`在网页版打开 ${title}`}
            onClick={() => void openWebUrl(`https://www.wenku8.cc/book/${book.aid}.htm`)}
          >
            网页版 ↗
          </button>
          <button className="wr-btn" onClick={onClose}>关闭</button>
          {imported ? (
            <button className="wr-btn wr-btn-primary" onClick={() => navigate(`/read/${book.book_id}`)}>
              打开这本书
            </button>
          ) : (
            <button
              className="wr-btn wr-btn-primary"
              disabled={pullBusy}
              title={pullBusy ? "正在拉取另一本" : undefined}
              onClick={() => onPull(book.aid, destShelf)}
            >
              {pullBusy ? "正在拉取另一本" : "拉取到书库"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CloudShelfPage() {
  const navigate = useNavigate();
  // P-2 有会话缓存时跳过 checking/loading 首帧，直接渲染旧书架
  const [mode, setMode] = useState<"checking" | "login" | "shelf">(() => (shelfCache ? "shelf" : "checking"));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [books, setBooks] = useState<Wenku8ShelfBook[]>(() => shelfCache?.books ?? []);
  const [shelfBusy, setShelfBusy] = useState(false);
  const [shelfError, setShelfError] = useState<string | null>(null);
  // C-1 元信息（书名兜底/作者/更新日期/排序）：从模块级 infoCache 重建，懒取到再补
  const [infos, setInfos] = useState<Record<number, Wenku8BookInfo>>(() => {
    const m: Record<number, Wenku8BookInfo> = {};
    for (const b of shelfCache?.books ?? []) {
      const i = infoCache.get(b.aid);
      if (i) m[b.aid] = i;
    }
    return m;
  });
  // C-1 密度复用书库同一键（library_density），排序存 wenku8.sort
  const [density, setDensity] = useState<LibraryDensity>("standard");
  const [sortKey, setSortKey] = useState<CloudSort>("added");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // E-1（U-14 分区）：云书架卡右键菜单——详情/拉取(或打开)/网页版
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; book: Wenku8ShelfBook } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [dl, setDl] = useState<({ aid: number } & DlState) | null>(null);
  const [account, setAccount] = useState(() => shelfCache?.account ?? "");
  // D3 上下文行：上次成功拉取云书架的时间（HH:mm）
  const [syncText, setSyncText] = useState<string | null>(() => shelfCache?.syncText ?? null);
  // D1 封面占位：远端封面拉挂的书才在封面 overlay 上显示书名（有封面不显示，照书库卡）
  const [coverFailed, setCoverFailed] = useState<Set<number>>(new Set());
  // F1 详情对话框 + 目标书架（listShelves 一次 + settings 记住上次选择）
  const [detail, setDetail] = useState<Wenku8ShelfBook | null>(null);
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [destShelf, setDestShelf] = useState("");
  // F2 有新章徽标：imported 卡懒比对 latest_cid > last_cid（失败静默不标）
  const [hasNew, setHasNew] = useState<Set<number>>(() => new Set(shelfCache?.hasNew ?? []));
  // 批次12 U-2 顶栏搜索：本地过滤（书名/作者/aid，大小写不敏感；空=全部），清空恢复
  const [search, setSearch] = useState("");

  // state 与会话缓存同步写（P-2：切页回来徽标即时还原）
  function seedInfo(aid: number): void {
    const got = infoCache.get(aid);
    if (got != null) setInfos((m) => (m[aid] === got ? m : { ...m, [aid]: got }));
  }
  function applyHasNew(aid: number): void {
    setHasNew((s) => new Set(s).add(aid));
    if (shelfCache) writeShelfCache({ hasNew: new Set([...shelfCache.hasNew, aid]) });
  }

  const loadShelf = useCallback(async () => {
    setShelfBusy(true);
    setShelfError(null);
    try {
      const list = await wenku8Bookshelf();
      const time = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
      setBooks(list);
      setSyncText(time);
      writeShelfCache({ books: list, syncText: time });
      let stagger = 0;
      for (const b of list) {
        // C-1 每本书都取元信息（作者 · 最近更新是卡面副行的必需品）；已有缓存直接播种
        if (infoCache.has(b.aid)) seedInfo(b.aid);
        else void ensureInfo(b.aid).then(() => seedInfo(b.aid)).catch(() => {});
        if (b.book_id != null && !checkedNew.has(b.aid)) {
          checkedNew.add(b.aid);
          const lastCid = b.last_cid;
          // F2 错峰 300ms：整架 imported 卡不至于同拍打满中继
          setTimeout(() => {
            void ensureInfo(b.aid)
              .then(() => {
                seedInfo(b.aid);
                const got = infoCache.get(b.aid);
                if (got != null && got.latest_cid > lastCid) applyHasNew(b.aid);
              })
              .catch(() => {});
          }, 300 * stagger++);
        }
      }
    } catch (e) {
      setShelfError(String(e));
    } finally {
      setShelfBusy(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    // 拉取进度事件按 aid 过滤，只更新下载中的那本（页面级单飞锁）
    void listen<Wenku8ProgressEvent>("wr:wenku8-progress", (e) => {
      const { aid, done, total } = e.payload;
      setDl((prev) =>
        prev && prev.aid === aid && prev.phase === "downloading" ? { ...prev, done, total } : prev,
      );
    })
      .then((f) => {
        if (disposed) f();
        else unlisten = f;
      })
      .catch(() => {});
    void wenku8Status()
      .then((s) => {
        if (disposed) return;
        setAccount(s.username ?? "");
        if (!s.has_saved) {
          shelfCache = null;
          setUsername(s.username ?? "");
          setMode("login");
          return;
        }
        if (shelfCache) writeShelfCache({ account: s.username ?? "" });
        setMode("shelf");
        // P-2 会话缓存命中不重拉（回本页零等待）；无缓存才首拉。重拉仅：显式刷新 / 拉取完成 / 登录成功
        if (!shelfCache) void loadShelf();
        // F1 目标书架下拉数据 + 上次选择（失败静默退默认根）
        void listShelves().then((list) => {
          if (!disposed) setShelves(list);
        }).catch(() => {});
        void getSettings().then((s2) => {
          if (disposed) return;
          setDestShelf(s2[DEST_SHELF_KEY] ?? "");
          setSortKey(normalizeCloudSort(s2[SORT_KEY]));
          setDensity(normalizeLibraryDensity(s2.library_density));
        }).catch(() => {});
      })
      .catch(() => {
        if (!disposed) setMode("login");
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadShelf]);

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    setLoginBusy(true);
    setLoginError(null);
    try {
      const res = await wenku8Login(username, password);
      if (res.ok) {
        setAccount(username);
        writeShelfCache({ account: username });
        setMode("shelf");
        void loadShelf();
        void listShelves().then(setShelves).catch(() => {});
        void getSettings().then((s) => {
          setDestShelf(s[DEST_SHELF_KEY] ?? "");
          setSortKey(normalizeCloudSort(s[SORT_KEY]));
          setDensity(normalizeLibraryDensity(s.library_density));
        }).catch(() => {});
      } else {
        setLoginError(wenku8ErrcodeMessage(res.errcode));
      }
    } catch (err) {
      setLoginError(String(err));
    } finally {
      setLoginBusy(false);
    }
  }

  // F3 拉取流：对话框发起 → 卡片下载态 → 完成重拉书架（imported 徽标即现）
  async function onDownload(aid: number, shelfId: string) {
    setDetail(null);
    setDl({ aid, phase: "downloading", done: 0, total: 0 });
    try {
      await wenku8Download(aid, shelfId);
      setDl({ aid, phase: "done" });
      void loadShelf();
    } catch (err) {
      setDl({ aid, phase: "error", message: String(err) });
    }
  }

  function onDestShelfChange(v: string) {
    setDestShelf(v);
    void setSetting(DEST_SHELF_KEY, v).catch(() => {});
  }

  // F4 网页版入口（顶栏）：统一走 openWebUrl（失败退复制链接提示）
  function openWeb() {
    return openWebUrl("http://www.wenku8.cc/");
  }

  // D3 退出登录：清本机账密与会话缓存后回登录卡（invoke 失败也照常回，下次进入 status 会纠偏）
  async function onLogout() {
    try {
      await wenku8Logout();
    } catch {}
    shelfCache = null;
    setBooks([]);
    setDl(null);
    setInfos({});
    setSyncText(null);
    setHasNew(new Set());
    setAccount("");
    setUsername("");
    setPassword("");
    setMode("login");
  }

  // P-1 侧栏固定「刷新」钮：本视图订阅（shelf 态才重拉云端书架；后台刷新期间旧数据照常显示）
  useEffect(() => subscribeAppRefresh(() => {
    if (mode === "shelf") void loadShelf();
  }), [mode, loadShelf]);

  const titleOf = (b: Wenku8ShelfBook): string => b.name ?? infos[b.aid]?.title ?? "正在获取书名…";
  const pullBusy = dl?.phase === "downloading";
  // E-1 右键「拉取到书库」的 title 提示用：目标书架名（根=书库根）
  const destShelfName = destShelf ? shelves.find((s) => String(s.id) === destShelf)?.name ?? "书库" : "书库";

  // C-1 排序：收藏顺序=API 返回序（云端新收藏在前）；最近更新=last_update 降序，尚未取到 bookinfo 的排尾部
  //（取到后 infos 更新触发重排自动归位）；书名按中文 locale
  const sortedBooks = useMemo(() => {
    if (sortKey === "added") return books;
    if (sortKey === "title") return [...books].sort((a, b) => titleOf(a).localeCompare(titleOf(b), "zh"));
    return [...books].sort((a, b) => {
      const ua = infos[a.aid]?.last_update ?? "";
      const ub = infos[b.aid]?.last_update ?? "";
      if (!ua || !ub) return ua === ub ? 0 : ua ? -1 : 1;
      return ub.localeCompare(ua);
    });
  }, [books, sortKey, infos]);

  // U-2 搜索过滤在排序之后套一层（与排序/密度正交）：匹配懒取书名 / 作者 / aid
  const visibleBooks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sortedBooks;
    return sortedBooks.filter((b) =>
      `${b.name ?? infos[b.aid]?.title ?? ""} ${infos[b.aid]?.author ?? ""} ${b.aid}`.toLowerCase().includes(q),
    );
  }, [sortedBooks, search, infos]);

  function changeSort(k: CloudSort): void {
    setSortKey(k);
    void setSetting(SORT_KEY, k).catch(() => {});
  }

  function changeDensity(v: LibraryDensity): void {
    setDensity(v);
    void setSetting("library_density", v).catch(() => {});
  }

  // 排序/云卡右键菜单：外部 pointerdown / Esc 关闭（照 AppShell 主题菜单模式）
  useEffect(() => {
    if (!menu && !cardMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenu(null);
        setCardMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        setCardMenu(null);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu, cardMenu]);

  // 批次8：壳常驻，本页元信息布局期写入 pageMeta store（切页零闪烁；登录卡态不渲染上下文行）
  // 批次12 U-1/U-2：顶栏与书库同款恒放搜索框（不再显示标题——刊头已有，避免双「云书架」）
  useLayoutEffect(() => {
    setPageMeta({
      active: "cloud",
      title: "云书架",
      search: { value: search, placeholder: "搜索云书架 / 作者", onChange: setSearch },
      contextRow:
        mode === "shelf" ? (
          <>
            <span className="wr-quick-context">
              {account || "wenku8"} · 上次同步 {syncText ?? (shelfBusy ? "同步中…" : "—")}
            </span>
            <button type="button" className="wr-quick-chip wr-quick-chip--act" onClick={() => void onLogout()}>
              退出登录
            </button>
          </>
        ) : undefined,
    });
  }, [mode, account, syncText, shelfBusy, search]);

  return (
    <>
      <div className="wr-masthead">
        <h1 className="wr-masthead-name">云 书 架</h1>
        <div className="wr-masthead-stats">
          <span>{mode === "shelf" ? `wenku8 · ${account || "已登录"} · 共 ${books.length} 本` : "wenku8 在线书架"}</span>
          <button
            type="button"
            className="wr-stats-link"
            title="去网页版管理云端书架"
            onClick={() => void openWeb()}
          >
            网页版 ↗
          </button>
        </div>
      </div>

      {/* C-1 工具行：排序菜单 + 密度档（复用书库同一 library_density 键，两处生效） */}
      {mode === "shelf" ? (
        <div className="wr-toolbar-row">
          <button
            type="button"
            className="wr-btn wr-icon-btn"
            aria-haspopup="menu"
            aria-expanded={menu != null}
            aria-label={`排序：${CLOUD_SORT_LABELS[sortKey]}`}
            title={`排序：${CLOUD_SORT_LABELS[sortKey]}`}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu((m) => (m ? null : { x: r.left, y: r.bottom + 4 }));
            }}
          >
            <IconSort />
          </button>
          <div className="wr-seg" role="group" aria-label="书架密度" style={{ marginLeft: "auto" }}>
            {(Object.keys(DENSITY_PRESETS) as LibraryDensity[]).map((d) => (
              <button
                key={d}
                type="button"
                className="wr-seg-btn wr-seg-btn--icon"
                data-active={density === d}
                aria-pressed={density === d}
                aria-label={DENSITY_PRESETS[d].label}
                title={DENSITY_PRESETS[d].label}
                onClick={() => changeDensity(d)}
              >
                <IconDensity bars={d === "standard" ? 2 : d === "large" ? 3 : 4} />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {mode === "checking" ? <div className="wr-state" style={{ gridColumn: "1 / -1" }}>正在检查登录状态…</div> : null}

      {mode === "login" ? (
        <div style={{ display: "grid", placeItems: "center", padding: "48px 16px" }}>
          <form
            onSubmit={onLogin}
            className="wr-panel"
            style={{ width: 320, padding: 24, display: "flex", flexDirection: "column", gap: 12 }}
          >
            <div style={{ fontWeight: 750 }}>登录 wenku8</div>
            <input
              className="wr-search-input"
              style={{ width: "100%", background: "var(--wr-paper)" }}
              placeholder="用户名"
              aria-label="用户名"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
            />
            <input
              className="wr-search-input"
              style={{ width: "100%", background: "var(--wr-paper)" }}
              type="password"
              placeholder="密码"
              aria-label="密码"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
            {loginError ? (
              <div style={{ color: "var(--wr-danger)", fontSize: 13 }}>{loginError}</div>
            ) : null}
            <button type="submit" className="wr-btn wr-btn-primary" disabled={loginBusy}>
              {loginBusy ? "登录中…" : "登录"}
            </button>
            <div className="wr-muted" style={{ fontSize: 12 }}>
              账密仅保存在本机，用于同步你的 wenku8 书架
            </div>
          </form>
        </div>
      ) : null}

      {mode === "shelf" ? (
        shelfError ? (
          <div className="wr-state" style={{ gridColumn: "1 / -1" }}>
            <div className="wr-state-title">书架加载失败</div>
            <div className="wr-state-sub" style={{ color: "var(--wr-danger)" }}>{shelfError}</div>
            <button className="wr-btn" style={{ marginTop: 12 }} onClick={() => void loadShelf()}>
              重试
            </button>
          </div>
        ) : shelfBusy && books.length === 0 ? (
          <div className="wr-state" style={{ gridColumn: "1 / -1" }}>正在加载云书架…</div>
        ) : books.length === 0 ? (
          <div className="wr-state" style={{ gridColumn: "1 / -1" }}>
            <div className="wr-state-title">云书架是空的</div>
            <div className="wr-state-sub">去 wenku8 网站或 App 把小说加入书架，再回来刷新</div>
          </div>
        ) : visibleBooks.length === 0 ? (
          <div className="wr-state" style={{ gridColumn: "1 / -1" }}>
            <div className="wr-state-title">没有匹配的书</div>
            <div className="wr-state-sub">换个书名或作者试试</div>
          </div>
        ) : (
          <div
            className={density === "standard" ? "wr-book-grid" : `wr-book-grid wr-book-grid--${density}`}
            style={{ gridTemplateColumns: DENSITY_PRESETS[density].grid }}
          >
            {visibleBooks.map((b) => {
              const state = dl != null && dl.aid === b.aid ? dl : undefined;
              const pct = state?.phase === "downloading" && state.total > 0 ? (state.done / state.total) * 100 : 0;
              const failed = coverFailed.has(b.aid);
              const imported = b.book_id != null;
              const info = infos[b.aid];
              const sub = info ? `${info.author || "未知作者"} · ${info.last_update}` : null;
              return (
                <div
                  key={b.aid}
                  className="wr-book-card"
                  data-aid={b.aid}
                  onClick={() => setDetail(b)}
                  onContextMenu={(e) => {
                    // E-1：云书架卡右键 = 详情 / 拉取(已入库=打开) / 网页版
                    e.preventDefault();
                    setCardMenu({ x: e.clientX, y: e.clientY, book: b });
                  }}
                >
                  <div className="wr-cover">
                    {failed ? (
                      <div className="wr-cover-text">
                        <div className="wr-cover-title">{titleOf(b)}</div>
                      </div>
                    ) : (
                      <img
                        src={coverUrl(b.aid)}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onError={() => setCoverFailed((s) => new Set(s).add(b.aid))}
                      />
                    )}
                  </div>
                  <div className="wr-meta">
                    <div className="wr-title" title={titleOf(b)}>{titleOf(b)}</div>
                    {/* C-1 副行：作者 · 最近更新（未取到=加载点）+ 状态内联小徽（封面/文字上不放任何角标） */}
                    <div className="wr-author wr-cloud-sub">
                      <span className="wr-cloud-sub-text" title={sub ?? undefined}>
                        {sub ?? "…"}
                      </span>
                      {imported ? <span className="wr-cloud-tag">已入库</span> : null}
                      {hasNew.has(b.aid) ? <span className="wr-cloud-tag wr-cloud-tag--new">有新章</span> : null}
                    </div>
                  </div>
                  {/* 悬浮动作层：下载进度/✓；imported=打开，否则开详情（直接拉取改由对话框发起） */}
                  <div className="wr-card-tools" data-show={state != null}>
                    {state?.phase === "downloading" ? (
                      <div
                        className="wr-dl-progress"
                        role="progressbar"
                        aria-label={`拉取进度 ${titleOf(b)}`}
                        aria-valuenow={state.done}
                        aria-valuemax={state.total || undefined}
                      >
                        <span>{state.total > 0 ? `${Math.round(pct)}%` : "…"}</span>
                        <i style={{ width: `${pct}%` }} />
                      </div>
                    ) : state?.phase === "done" && !imported ? (
                      // ✓ 过渡微标：只在书架重拉、imported 徽标落地前的窗口里显示
                      <span className="wr-dl-done">✓ 已入库</span>
                    ) : imported ? (
                      <button
                        type="button"
                        className="wr-mini-btn"
                        aria-label="打开"
                        title="打开这本书"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/read/${b.book_id}`);
                        }}
                      >
                        <IconBookOpen />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="wr-mini-btn"
                        aria-label="拉取"
                        title={state?.phase === "error" ? `拉取失败：${state.message}` : "详情与拉取"}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDetail(b);
                        }}
                      >
                        <IconDownload />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : null}

      {/* C-1 排序菜单（样式照书库排序菜单：wr-menu 原版墨线 + radio 项） */}
      {menu ? (
        <div ref={menuRef} className="wr-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
          {(Object.keys(CLOUD_SORT_LABELS) as CloudSort[]).map((k) => (
            <button
              key={k}
              className="wr-menu-item"
              role="menuitemradio"
              aria-checked={sortKey === k}
              data-checked={sortKey === k}
              onClick={() => {
                setMenu(null);
                changeSort(k);
              }}
            >
              {CLOUD_SORT_LABELS[k]}
            </button>
          ))}
        </div>
      ) : null}

      {/* E-1 云书架卡右键菜单：详情 / 拉取到书库（已入库=打开这本书）/ 网页版 */}
      {cardMenu ? (
        <div ref={menuRef} className="wr-menu" role="menu" style={{ left: cardMenu.x, top: cardMenu.y }}>
          <button
            className="wr-menu-item"
            role="menuitem"
            onClick={() => {
              const b = cardMenu.book;
              setCardMenu(null);
              setDetail(b);
            }}
          >
            详情
          </button>
          {cardMenu.book.book_id != null ? (
            <button
              className="wr-menu-item"
              role="menuitem"
              onClick={() => {
                const b = cardMenu.book;
                setCardMenu(null);
                navigate(`/read/${b.book_id}`);
              }}
            >
              打开这本书
            </button>
          ) : (
            <button
              className="wr-menu-item"
              role="menuitem"
              disabled={pullBusy}
              title={pullBusy ? "正在拉取另一本" : `拉到「${destShelfName}」`}
              onClick={() => {
                const b = cardMenu.book;
                setCardMenu(null);
                void onDownload(b.aid, destShelf);
              }}
            >
              拉取到书库
            </button>
          )}
          <button
            className="wr-menu-item"
            role="menuitem"
            onClick={() => {
              const b = cardMenu.book;
              setCardMenu(null);
              void openWebUrl(`https://www.wenku8.cc/book/${b.aid}.htm`);
            }}
          >
            网页版 ↗
          </button>
        </div>
      ) : null}

      {detail != null ? (
        <CloudBookDialog
          book={detail}
          shelves={shelves}
          destShelf={destShelf}
          onDestShelf={onDestShelfChange}
          onShelves={setShelves}
          pullBusy={pullBusy}
          onPull={(aid, shelfId) => void onDownload(aid, shelfId)}
          onClose={() => setDetail(null)}
          coverFailed={coverFailed.has(detail.aid)}
          onCoverError={(aid) => setCoverFailed((s) => new Set(s).add(aid))}
        />
      ) : null}
    </>
  );
}
