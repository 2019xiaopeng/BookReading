import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { IconBook, IconStar } from "./icons";
import type { Theme } from "../reader/settings/types";

export default function AppShell(props: {
  active: "library" | "favorites" | "reader";
  theme?: Theme;
  title: string;
  search?: {
    value: string;
    placeholder: string;
    onChange: (v: string) => void;
  };
  seg?: {
    items: { key: string; label: string }[];
    active: string;
    onChange: (key: string) => void;
  };
  sidebarFooter?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const theme = props.theme ?? "light";

  return (
    <div className="wr-shell" data-theme={theme}>
      <div className="wr-panel wr-side">
        <div className="wr-side-top">
          <div className="wr-brand">
            <div className="wr-brand-name">BookReading</div>
            <div className="wr-brand-sub">weread-inspired</div>
          </div>
          <div className="wr-pill" title="状态">
            <span className="wr-dot" />
            <span style={{ fontSize: 12 }}>本地库</span>
          </div>
        </div>

        <div className="wr-nav" role="navigation">
          <button className="wr-nav-btn" data-active={props.active === "library"} onClick={() => navigate("/")}>
            <div className="wr-nav-title">
              <IconBook />
              书架
            </div>
            <div className="wr-nav-sub">最近阅读、导入与管理</div>
          </button>
          <button className="wr-nav-btn" data-active={props.active === "favorites"} onClick={() => navigate("/favorites")}>
            <div className="wr-nav-title">
              <IconStar />
              收藏
            </div>
            <div className="wr-nav-sub">书籍与收藏句子</div>
          </button>
        </div>

        <div className="wr-side-bottom">{props.sidebarFooter}</div>
      </div>

      <div className="wr-panel wr-main">
        <div className="wr-main-topbar">
          {props.search ? (
            <div className="wr-search">
              <span className="wr-search-icon" aria-hidden />
              <input
                className="wr-search-input"
                value={props.search.value}
                onChange={(e) => props.search?.onChange(e.currentTarget.value)}
                placeholder={props.search.placeholder}
              />
            </div>
          ) : (
            <div style={{ fontWeight: 750 }}>{props.title}</div>
          )}

          {props.seg ? (
            <div className="wr-seg" aria-label="视图切换">
              {props.seg.items.map((it) => (
                <button
                  key={it.key}
                  className="wr-seg-btn"
                  data-active={props.seg?.active === it.key}
                  onClick={() => props.seg?.onChange(it.key)}
                >
                  {it.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div style={{ minHeight: 0, overflow: "auto" }}>{props.children}</div>
      </div>
    </div>
  );
}
