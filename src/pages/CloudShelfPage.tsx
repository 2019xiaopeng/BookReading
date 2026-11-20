import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";

import {
  wenku8BookInfo,
  wenku8Bookshelf,
  wenku8Download,
  wenku8ErrcodeMessage,
  wenku8Login,
  wenku8Status,
  type Wenku8ProgressEvent,
  type Wenku8ShelfBook,
} from "../tauri/wenku8";
import AppShell from "../ui/AppShell";
import { IconRefresh } from "../ui/icons";

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
  const navigate = useNavigate();
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

  const loadShelf = useCallback(async () => {
    setShelfBusy(true);
    setShelfError(null);
    try {
      const list = await wenku8Bookshelf();
      setBooks(list);
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

  const titleOf = (b: Wenku8ShelfBook): string => b.name ?? titles[b.aid] ?? "正在获取书名…";

  return (
    <AppShell
      active="cloud"
      title="云书架"
      sidebarFooter={
        mode === "shelf" ? (
          <button className="wr-small-btn" disabled={shelfBusy} onClick={() => void loadShelf()}>
            <IconRefresh />
            <span>刷新</span>
          </button>
        ) : undefined
      }
    >
      <div className="wr-masthead wr-masthead--sm">
        <h1 className="wr-masthead-name">云 书 架</h1>
        <div className="wr-masthead-stats">
          {mode === "shelf" ? `wenku8 · 共 ${books.length} 本` : "wenku8 在线书架"}
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
              return (
                <div key={b.aid} className="wr-book-card" data-aid={b.aid} style={{ cursor: "default" }}>
                  <div className="wr-cover">
                    <img
                      src={coverUrl(b.aid)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                    <div className="wr-cover-text">
                      <div className="wr-cover-title">{titleOf(b)}</div>
                    </div>
                  </div>
                  <div className="wr-meta">
                    <div className="wr-title" title={titleOf(b)}>{titleOf(b)}</div>
                    {b.date ? <div className="wr-author" title={b.date}>{b.date}</div> : null}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
                      {state?.phase === "downloading" ? (
                        <>
                          <div
                            role="progressbar"
                            aria-label={`拉取进度 ${titleOf(b)}`}
                            aria-valuenow={state.done}
                            aria-valuemax={state.total || undefined}
                            style={{ height: 4, borderRadius: 2, background: "var(--wr-hairline)", overflow: "hidden" }}
                          >
                            <div style={{ height: "100%", width: `${pct}%`, background: "var(--wr-accent)" }} />
                          </div>
                          <button className="wr-btn" disabled>
                            拉取中 {state.total > 0 ? `${state.done}/${state.total}` : "…"}
                          </button>
                        </>
                      ) : state?.phase === "done" ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ color: "var(--wr-accent)", fontSize: 13, fontWeight: 650 }}>✓ 已入库</span>
                          <button className="wr-btn" onClick={() => navigate("/")}>去书库</button>
                        </div>
                      ) : (
                        <>
                          <button className="wr-btn" disabled={shelfBusy} onClick={() => void onDownload(b.aid)}>
                            拉取到书库
                          </button>
                          {state?.phase === "error" ? (
                            <div style={{ color: "var(--wr-danger)", fontSize: 12 }}>{state.message}</div>
                          ) : null}
                        </>
                      )}
                    </div>
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
