import { useEffect, useState } from "react";

import { readBookMedia, type MediaEntry } from "../../tauri/invoke";
import { IconClose, IconRefresh, IconVideo } from "../../ui/icons";

/** V-1：扩展名 → MIME（B-1 剥离清单 mp4/mp3/m4a/ogg/wav/avi 外加常见音视频兜底） */
export function mediaMimeFor(ext: string): string {
  const e = (ext ?? "").toLowerCase().replace(/^\./, "");
  if (e === "mp4" || e === "m4v") return "video/mp4";
  if (e === "webm") return "video/webm";
  if (e === "avi") return "video/x-msvideo";
  if (e === "mp3") return "audio/mpeg";
  if (e === "m4a" || e === "aac") return "audio/mp4";
  if (e === "ogg" || e === "oga" || e === "opus") return "audio/ogg";
  if (e === "wav") return "audio/wav";
  if (e === "flac") return "audio/flac";
  return "application/octet-stream";
}

/** V-1：视频扩展名 → <video>；其余（音频/未知）→ <audio> */
export function isVideoExt(ext: string): boolean {
  const e = (ext ?? "").toLowerCase().replace(/^\./, "");
  return e === "mp4" || e === "m4v" || e === "webm" || e === "avi";
}

export function formatMediaSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Player = { url: string; video: boolean; name: string };

/**
 * V-1 媒体面板：原书 zip 内音视频清单（list_book_media 的前端半）。
 * 点击项按需读单条目字节（readBookMedia，不整包进内存）→ blob URL → 内嵌播放浮层；
 * 关闭浮层/换条目即 revokeObjectURL。
 */
export default function MediaPanel(props: { bookId: string; items: MediaEntry[] }) {
  const [player, setPlayer] = useState<Player | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 换条目/关闭时回收旧 blob（卸载兜底同一 effect）
  useEffect(() => {
    return () => {
      if (player) URL.revokeObjectURL(player.url);
    };
  }, [player]);

  const open = (entry: MediaEntry) => {
    if (busy) return;
    setError(null);
    setBusy(entry.name);
    void readBookMedia(props.bookId, entry.name)
      .then((bytes) => {
        setPlayer({
          url: URL.createObjectURL(new Blob([bytes], { type: mediaMimeFor(entry.ext) })),
          video: isVideoExt(entry.ext),
          name: entry.name,
        });
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(null));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 600 }}>媒体</div>
        <div className="wr-muted" style={{ fontSize: 12 }}>
          来自原书，点击播放
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {props.items.map((m) => (
          <button key={m.name} className="wr-btn" style={{ justifyContent: "flex-start" }} onClick={() => open(m)} disabled={busy === m.name}>
            {m.ext && !isVideoExt(m.ext) ? "♪" : <IconVideo />}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>{m.name}</span>
            <span className="wr-muted" style={{ marginLeft: "auto", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
              {busy === m.name ? <IconRefresh /> : formatMediaSize(m.size)}
            </span>
          </button>
        ))}
      </div>

      {error ? (
        <div role="alert" className="wr-muted" style={{ fontSize: 12 }}>
          读取失败：{error}
        </div>
      ) : null}

      {player ? (
        <div
          className="wr-media-overlay"
          role="dialog"
          aria-label={`播放 ${player.name}`}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: "var(--wr-z-overlay)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            background: "var(--wr-scrim)",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setPlayer(null);
          }}
        >
          <div
            className="wr-media-stage"
            style={{
              maxWidth: 720,
              width: "100%",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              padding: 16,
              borderRadius: 12,
              background: "var(--panel-solid)",
              border: "1px solid var(--wr-hairline)",
            }}
          >
            <div className="wr-media-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>
                {player.name}
              </span>
              <button type="button" className="wr-btn wr-icon-btn" aria-label="关闭" onClick={() => setPlayer(null)}>
                <IconClose />
              </button>
            </div>
            {player.video ? (
              <video src={player.url} controls autoPlay style={{ maxWidth: "100%", maxHeight: "70vh" }} />
            ) : (
              <audio src={player.url} controls autoPlay style={{ width: "100%" }} />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
