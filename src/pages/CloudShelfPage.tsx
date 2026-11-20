import { useCallback, useEffect, useState, type FormEvent } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  wenku8BookInfo,
  wenku8Bookshelf,
  wenku8Download,
  wenku8ErrcodeMessage,
  wenku8Login,
  wenku8Logout,
  wenku8Status,
  type Wenku8ProgressEvent,
  type Wenku8ShelfBook,
} from "../tauri/wenku8";
import AppShell from "../ui/AppShell";
import { useSidebarActions } from "../ui/sidebarActions";
import { IconDownload, IconRefresh } from "../ui/icons";

// 封面直链无鉴权：卷目录 = aid 整除 1000（协议实测，docs/开发计划-v3.0.md §2）
function coverUrl(aid: number): string {
  return `http://img.wenku8.com/image/${Math.floor(aid / 1000)}/${aid}/${aid}s.jpg`;
}

// 书名懒取：会话级缓存 + in-flight 去重（书架接口对未看过的书不返回 name）
const titleCache = new Map<number, string>();
const titleInflight = new Map<number, Promise<void>>();

function ensureTitle(aid: number): Promise<void> {
  const cached = titleCache.has(aid) ? Promise.resolve() : titleInflight.get(aid);
  if (cached) return cached;
  const p = wenku8BookInfo(aid)
    .then((info) => {
      titleCache.set(aid, info.title);
    })
    .finally(() => {
      titleInflight.delete(aid);
    });
  titleInflight.set(aid, p);
  return p;
}

// 单卡拉取状态：downloading 有进度条，done/error 为终态
type DlState =
  | { phase: "downloading"; done: number; total: number }
  | { phase: "done" }
  | { phase: "error"; message: string };

export default function CloudShelfPage() {
  const [mode, setMode] = useState<"checking" | "login" | "shelf">("checking");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [books, setBooks] = useState<Wenku8ShelfBook[]>([]);
  const [shelfBusy, setShelfBusy] = useState(false);
  const [shelfError, setShelfError] = useState<string | null>(null);
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [dl, setDl] = useState<Record<number, DlState>>({});
  const [account, setAccount] = useState("");
  // D3 上下文行：上次成功拉取云书架的时间（HH:mm）
  const [syncText, setSyncText] = useState<string | null>(null);
  // D1 封面占位：远端封面拉挂的书才在封面 overlay 上显示书名（有封面不显示，照书库卡）
  const [coverFailed, setCoverFailed] = useState<Set<number>>(new Set());

  const loadShelf = useCallback(async () => {
    setShelfBusy(true);
    setShelfError(null);
    try {
      const list = await wenku8Bookshelf();
      setBooks(list);
      setSyncText(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }));
      for (const b of list) {
        if (b.name != null) continue;
        // 已有缓存的书直接播种进 state，未有的取到再补
        const hit = titleCache.get(b.aid);
        if (hit != null) setTitles((t) => ({ ...t, [b.aid]: hit }));
        else void ensureTitle(b.aid).then(() => {
          const got = titleCache.get(b.aid);
          if (got != null) setTitles((t) => ({ ...t, [b.aid]: got }));
        });
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
    // 拉取进度事件按 aid 过滤，只更新 downloading 中的卡
    void listen<Wenku8ProgressEvent>("wr:wenku8-progress", (e) => {
      const { aid, done, total } = e.payload;
      setDl((prev) => {
        const cur = prev[aid];
        if (!cur || cur.phase !== "downloading") return prev;
        return { ...prev, [aid]: { phase: "downloading", done, total } };
      });
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
          setUsername(s.username ?? "");
          setMode("login");
          return;
        }
        setMode("shelf");
        void loadShelf();
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
        setMode("shelf");
        void loadShelf();
      } else {
        setLoginError(wenku8ErrcodeMessage(res.errcode));
      }
    } catch (err) {
      setLoginError(String(err));
    } finally {
      setLoginBusy(false);
    }
  }

  async function onDownload(aid: number) {
    setDl((prev) => ({ ...prev, [aid]: { phase: "downloading", done: 0, total: 0 } }));
    try {
      await wenku8Download(aid);
      setDl((prev) => ({ ...prev, [aid]: { phase: "done" } }));
    } catch (err) {
      setDl((prev) => ({ ...prev, [aid]: { phase: "error", message: String(err) } }));
    }
  }

  // D3 退出登录：清本机账密后回登录卡（invoke 失败也照常回，下次进入 status 会纠偏）
  async function onLogout() {
    try {
      await wenku8Logout();
    } catch {}
    setBooks([]);
    setDl({});
    setTitles({});
    setSyncText(null);
    setAccount("");
    setUsername("");
    setPassword("");
    setMode("login");
  }

  // B5 刷新=页面槽（本视图自带，替换书库的刷新）；登录/检查态无刷新动作
  useSidebarActions(
    "page",
    mode === "shelf"
      ? [{ label: "刷新", icon: <IconRefresh />, disabled: shelfBusy, onClick: () => void loadShelf() }]
      : null,
  );

  const titleOf = (b: Wenku8ShelfBook): string => b.name ?? titles[b.aid] ?? "正在获取书名…";

  return (
    <AppShell
      active="cloud"
      title="云书架"
      contextRow={
        mode === "shelf" ? (
          <>
            <span className="wr-quick-context">
              {account || "wenku8"} · 上次同步 {syncText ?? (shelfBusy ? "同步中…" : "—")}
            </span>
            <button type="button" className="wr-quick-chip wr-quick-chip--act" onClick={() => void onLogout()}>
              退出登录
            </button>
          </>
        ) : undefined
      }
    >
      <div className="wr-masthead">
        <h1 className="wr-masthead-name">云 书 架</h1>
        <div className="wr-masthead-stats">
          {mode === "shelf" ? `wenku8 · ${account || "已登录"} · 共 ${books.length} 本` : "wenku8 在线书架"}
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
              const state = dl[b.aid];
              const pct = state?.phase === "downloading" && state.total > 0 ? (state.done / state.total) * 100 : 0;
              const failed = coverFailed.has(b.aid);
              return (
                <div key={b.aid} className="wr-book-card" data-aid={b.aid} style={{ cursor: "default" }}>
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
                  {/* D1 悬浮动作层（书库卡同款 wr-card-tools）：下载钮/进度墨线/✓ 已入库微标 */}
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
                    ) : state?.phase === "done" ? (
                      <span className="wr-dl-done">✓ 已入库</span>
                    ) : (
                      <button
                        type="button"
                        className="wr-mini-btn"
                        aria-label="拉取到书库"
                        title={state?.phase === "error" ? `拉取失败：${state.message}` : "拉取到书库"}
                        disabled={shelfBusy}
                        onClick={() => void onDownload(b.aid)}
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
    </AppShell>
  );
}
