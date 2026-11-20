import { useCallback, useEffect, useLayoutEffect, useState, type FormEvent } from "react";
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
import { getSettings, listShelves, setSetting, type Shelf } from "../tauri/invoke";
import { setPageMeta } from "../ui/pageMeta";
import { subscribeAppRefresh } from "../ui/appActions";
import { IconBookOpen, IconList } from "../ui/icons";
import { showToast } from "../ui/toast";
import { showAlert } from "../ui/dialog";

// 封面直链无鉴权：卷目录 = aid 整除 1000（协议实测，docs/开发计划-v3.0.md §2）
function coverUrl(aid: number): string {
  return `http://img.wenku8.com/image/${Math.floor(aid / 1000)}/${aid}/${aid}s.jpg`;
}

// settings 表键：目标书架（'' = 默认根）
const DEST_SHELF_KEY = "wenku8.dest_shelf";

// 书籍元信息懒取：会话级缓存 + in-flight 去重（书架接口对未看过的书不返回 name；详情/新章比对共用）
const infoCache = new Map<number, Wenku8BookInfo>();
const infoInflight = new Map<number, Promise<void>>();

function ensureInfo(aid: number): Promise<void> {
  const cached = infoCache.has(aid) ? Promise.resolve() : infoInflight.get(aid);
  if (cached) return cached;
  const p = wenku8BookInfo(aid)
    .then((info) => {
      infoCache.set(aid, info);
    })
    .finally(() => {
      infoInflight.delete(aid);
    });
  infoInflight.set(aid, p);
  return p;
}

// F2 有新章比对：会话内每本书只查一次（刷新书架不重查）
const checkedNew = new Set<number>();

// P-2 云书架会话缓存：切走再切回直接渲染旧数据（不重拉不闪 loading）；
// 仅显式刷新 / 拉取完成 / 登录成功才真正重拉（重拉期间旧数据照常显示）
type CloudShelfCache = {
  books: Wenku8ShelfBook[];
  titles: Record<number, string>;
  hasNew: Set<number>;
  syncText: string | null;
  account: string;
};
let shelfCache: CloudShelfCache | null = null;

function writeShelfCache(patch: Partial<CloudShelfCache>): void {
  shelfCache = {
    books: shelfCache?.books ?? [],
    titles: shelfCache?.titles ?? {},
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
}

// 拉取锁：页面级一次一本（downloading 期间其它拉取钮禁用）
type DlState =
  | { phase: "downloading"; done: number; total: number }
  | { phase: "done" }
  | { phase: "error"; message: string };

// F1 详情对话框：大封面 + 完整元信息 + 卷章目录（默认收起）+ 简介 + 底部目标书架/拉取
function CloudBookDialog({
  book,
  shelves,
  destShelf,
  onDestShelf,
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
      <div
        className="wr-panel wr-prompt wr-dialog wr-cloud-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`书籍详情 ${title}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="wr-prompt-title">书籍详情</div>
        {/* P-3 正文独立滚动（max 78vh）：长简介/目录展开也不把底部动作区顶出屏 */}
        <div className="wr-cloud-body">
          <div className="wr-details">
            <div className="wr-details-cover" style={{ cursor: "default" }}>
              {coverFailed ? (
                <div className="wr-cover-title">{title}</div>
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
        </div>
        <div className="wr-prompt-actions">
          {imported ? (
            <span className="wr-muted" style={{ fontSize: 12, marginRight: "auto", alignSelf: "center" }}>
              已入库，增量更新将随后续版本提供
            </span>
          ) : (
            <label
              className="wr-muted"
              style={{ fontSize: 12, marginRight: "auto", alignSelf: "center", display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              拉到
              {/* P-5 目标书架下拉换 wr-select（不透明 panel-solid）：原生弹层取控件底色，半透明在夜间会合成白底看不清 */}
              <select
                className="wr-select"
                style={{ width: 150, padding: "5px 10px" }}
                aria-label="目标书架"
                value={destShelf}
                onChange={(e) => onDestShelf(e.currentTarget.value)}
              >
                <option value="">默认（根）</option>
                {shelves.map((s) => (
                  <option key={s.id} value={String(s.id)}>{s.name}</option>
                ))}
              </select>
            </label>
          )}
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
  const [titles, setTitles] = useState<Record<number, string>>(() => shelfCache?.titles ?? {});
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

  // state 与会话缓存同步写（P-2：切页回来 titles/徽标即时还原）
  function applyTitle(aid: number, title: string): void {
    setTitles((t) => ({ ...t, [aid]: title }));
    if (shelfCache) writeShelfCache({ titles: { ...shelfCache.titles, [aid]: title } });
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
        if (b.name == null) {
          // 已有缓存的书直接播种进 state，未有的取到再补
          const hit = infoCache.get(b.aid);
          if (hit != null) applyTitle(b.aid, hit.title);
          else void ensureInfo(b.aid)
            .then(() => {
              const got = infoCache.get(b.aid);
              if (got != null) applyTitle(b.aid, got.title);
            })
            .catch(() => {});
        }
        if (b.book_id != null && !checkedNew.has(b.aid)) {
          checkedNew.add(b.aid);
          const lastCid = b.last_cid;
          // F2 错峰 300ms：整架 imported 卡不至于同拍打满中继
          setTimeout(() => {
            void ensureInfo(b.aid)
              .then(() => {
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
          if (!disposed) setDestShelf(s2[DEST_SHELF_KEY] ?? "");
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
        void getSettings().then((s) => setDestShelf(s[DEST_SHELF_KEY] ?? "")).catch(() => {});
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

  // F4 网页版入口（照 SettingsDialog openUrl 先例：失败退复制链接提示）
  async function openWeb() {
    const url = "http://www.wenku8.cc/";
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

  // D3 退出登录：清本机账密与会话缓存后回登录卡（invoke 失败也照常回，下次进入 status 会纠偏）
  async function onLogout() {
    try {
      await wenku8Logout();
    } catch {}
    shelfCache = null;
    setBooks([]);
    setDl(null);
    setTitles({});
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

  const titleOf = (b: Wenku8ShelfBook): string => b.name ?? titles[b.aid] ?? "正在获取书名…";
  const pullBusy = dl?.phase === "downloading";

  // 批次8：壳常驻，本页元信息布局期写入 pageMeta store（切页零闪烁；登录卡态不渲染上下文行）
  useLayoutEffect(() => {
    setPageMeta({
      active: "cloud",
      title: "云书架",
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
  }, [mode, account, syncText, shelfBusy]);

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
        ) : (
          <div className="wr-book-grid">
            {books.map((b) => {
              const state = dl != null && dl.aid === b.aid ? dl : undefined;
              const pct = state?.phase === "downloading" && state.total > 0 ? (state.done / state.total) * 100 : 0;
              const failed = coverFailed.has(b.aid);
              const imported = b.book_id != null;
              return (
                <div key={b.aid} className="wr-book-card" data-aid={b.aid} onClick={() => setDetail(b)}>
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
                    {b.date ? <div className="wr-author" title={b.date}>{b.date}</div> : null}
                  </div>
                  {/* F2 已入库/有新章徽标（右上角，悬浮动作层之下） */}
                  {imported ? <span className="wr-cloud-badge">已入库</span> : null}
                  {hasNew.has(b.aid) ? <span className="wr-cloud-badge wr-cloud-badge--new">有新章</span> : null}
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
                        aria-label="详情"
                        title={state?.phase === "error" ? `拉取失败：${state.message}` : "详情与拉取"}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDetail(b);
                        }}
                      >
                        <IconList />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : null}

      {detail != null ? (
        <CloudBookDialog
          book={detail}
          shelves={shelves}
          destShelf={destShelf}
          onDestShelf={onDestShelfChange}
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
