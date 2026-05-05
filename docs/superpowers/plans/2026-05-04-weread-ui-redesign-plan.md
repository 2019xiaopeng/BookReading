# 微信读书风 UI 重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按“微信读书风（桌面为主 + 抽屉面板）”统一书架/收藏/阅读器 UI，并修复 `ResizeObserver loop completed with undelivered notifications` 造成的噪音与潜在性能问题。

**Architecture:** 在不改变既有业务接口的前提下，引入统一 App Shell（左侧导航 + 顶部工具条 + 主内容），阅读页引入右侧抽屉承载目录/书签/标注/收藏句子/搜索/设置，并把选中文本动作从弹窗切换为原位操作条。增加前端日志过滤与可复用的错误归类。

**Tech Stack:** React + TypeScript + Vite + Tauri v2（plugin-fs / plugin-dialog）+ epub.js + Vitest

---

## File Map（本计划涉及文件）

**Create**
- `/workspace/src/ui/AppShell.tsx`
- `/workspace/src/ui/Drawer.tsx`
- `/workspace/src/ui/weread.css`
- `/workspace/src/tauri/frontendLogFilters.ts`
- `/workspace/src/tauri/frontendLogFilters.test.ts`
- `/workspace/src/reader/components/SelectionToolbar.tsx`

**Modify**
- `/workspace/src/styles/global.css`
- `/workspace/src/main.tsx`
- `/workspace/src/tauri/frontendLog.ts`
- `/workspace/src/pages/LibraryPage.tsx`
- `/workspace/src/pages/FavoritesPage.tsx`
- `/workspace/src/pages/ReaderPage.tsx`
- `/workspace/src/reader/epub/reader.ts`
- `/workspace/src-tauri/capabilities/default.json`

---

## Task 1: 过滤/归类前端噪音错误（ResizeObserver）

**Why:** 当前 `ResizeObserver loop completed with undelivered notifications.` 会被当作 window.error 记录，影响排障信噪比；部分环境下该错误会持续刷屏并影响性能观感。

**Files**
- Create: `/workspace/src/tauri/frontendLogFilters.ts`
- Test: `/workspace/src/tauri/frontendLogFilters.test.ts`
- Modify: `/workspace/src/tauri/frontendLog.ts`

- [ ] **Step 1: Write failing tests (Vitest)**

```ts
// /workspace/src/tauri/frontendLogFilters.test.ts
import { describe, expect, test } from "vitest";
import { shouldIgnoreWindowErrorMessage } from "./frontendLogFilters";

describe("frontendLogFilters", () => {
  test("ignores ResizeObserver loop errors", () => {
    expect(shouldIgnoreWindowErrorMessage("ResizeObserver loop completed with undelivered notifications.")).toBe(true);
  });

  test("does not ignore ordinary errors", () => {
    expect(shouldIgnoreWindowErrorMessage("EPUB 打开失败：xxx")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test`  
Expected: FAIL（module not found 或函数未实现）

- [ ] **Step 3: Implement minimal filter**

```ts
// /workspace/src/tauri/frontendLogFilters.ts
export function shouldIgnoreWindowErrorMessage(message: string): boolean {
  const m = (message ?? "").trim();
  if (!m) return true;
  if (m.includes("ResizeObserver loop completed")) return true;
  if (m.includes("ResizeObserver loop limit exceeded")) return true;
  return false;
}
```

- [ ] **Step 4: Wire filter into window.error logging**

```ts
// /workspace/src/tauri/frontendLog.ts (in installFrontendLogging)
import { shouldIgnoreWindowErrorMessage } from "./frontendLogFilters";

window.addEventListener("error", (ev) => {
  if (shouldIgnoreWindowErrorMessage(String(ev.message))) return;
  ...
});
```

- [ ] **Step 5: Verify GREEN**

Run: `npm test`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tauri/frontendLogFilters.ts src/tauri/frontendLogFilters.test.ts src/tauri/frontendLog.ts
git commit -m "fix(log): ignore ResizeObserver loop noise"
```

---

## Task 2: WeRead 风格样式层（不侵入业务）

**Why:** 统一视觉“骨相”：纸感、克制按钮、卡片、抽屉、顶部工具条与左侧导航的风格一致性。

**Files**
- Create: `/workspace/src/ui/weread.css`
- Modify: `/workspace/src/styles/global.css`
- Modify: `/workspace/src/main.tsx`

- [ ] **Step 1: Add weread.css skeleton (no wiring yet)**

```css
/* /workspace/src/ui/weread.css */
:root {
  --wr-bg: #f6f4ef;
  --wr-paper: #fbfaf7;
  --wr-ink: rgba(22, 24, 26, 0.92);
  --wr-muted: rgba(22, 24, 26, 0.56);
  --wr-hairline: rgba(22, 24, 26, 0.12);
  --wr-accent: #1aad19;
  --wr-radius-xl: 22px;
  --wr-radius-lg: 16px;
  --wr-radius-md: 12px;
}

.wr-shell { height: 100vh; display: grid; grid-template-columns: 280px 1fr; gap: 16px; padding: 16px; overflow: hidden; background: var(--wr-bg); color: var(--wr-ink); }
.wr-panel { border: 1px solid var(--wr-hairline); border-radius: var(--wr-radius-xl); background: var(--wr-paper); overflow: hidden; }
.wr-topbar { height: 62px; display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--wr-hairline); }
.wr-input { border: 1px solid var(--wr-hairline); border-radius: 999px; padding: 10px 14px; width: 100%; background: rgba(0,0,0,0.03); }
.wr-btn { border: 1px solid var(--wr-hairline); border-radius: 999px; padding: 10px 14px; background: rgba(0,0,0,0.03); cursor: pointer; }
.wr-btn-primary { border-color: rgba(26,173,25,0.32); background: linear-gradient(180deg, rgba(26,173,25,0.96), rgba(26,173,25,0.76)); color: #fff; }
```

- [ ] **Step 2: Import weread.css**

```ts
// /workspace/src/main.tsx
import "./ui/weread.css";
```

- [ ] **Step 3: Ensure existing global tokens still work**

Run: `npm run build`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/ui/weread.css src/main.tsx
git commit -m "style(weread): add base stylesheet"
```

---

## Task 3: AppShell（左导航 + 顶部工具条）落地到书架/收藏

**Why:** 先把“外壳”统一，避免每页各自布局导致体验割裂。

**Files**
- Create: `/workspace/src/ui/AppShell.tsx`
- Modify: `/workspace/src/pages/LibraryPage.tsx`
- Modify: `/workspace/src/pages/FavoritesPage.tsx`

- [ ] **Step 1: Implement AppShell skeleton**

```tsx
// /workspace/src/ui/AppShell.tsx
import { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

export default function AppShell(props: {
  active: "library" | "favorites" | "reader";
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <div className="wr-shell">
      <div className="wr-panel" style={{ display: "flex", flexDirection: "column" }}>
        <div className="wr-topbar" style={{ borderBottom: "1px solid var(--wr-hairline)" }}>
          <div style={{ fontWeight: 800 }}>BookReading</div>
        </div>
        <div style={{ padding: 10, display: "grid", gap: 8 }}>
          <button className="wr-btn" data-active={props.active === "library"} onClick={() => navigate("/")}>书架</button>
          <button className="wr-btn" data-active={props.active === "favorites"} onClick={() => navigate("/favorites")}>收藏</button>
        </div>
        <div style={{ marginTop: "auto", padding: 12, borderTop: "1px solid var(--wr-hairline)", display: "grid", gap: 10 }}>
          {props.right}
        </div>
      </div>

      <div className="wr-panel" style={{ display: "grid", gridTemplateRows: "62px 1fr", minWidth: 0 }}>
        <div className="wr-topbar">
          <div style={{ fontWeight: 750 }}>{props.title}</div>
          <div style={{ flex: 1 }} />
        </div>
        <div style={{ minHeight: 0 }}>{props.children}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Migrate LibraryPage**
  - 用 `AppShell active="library"` 包裹
  - 主内容区仅保留书卡网格
  - 右上角动作（导入）放到 `AppShell` 的 `right` 区域

- [ ] **Step 3: Migrate FavoritesPage**
  - 用 `AppShell active="favorites"`
  - Tab 与列表套用 WeRead 样式类（先不做抽屉）

- [ ] **Step 4: Verify**

Run: `npm run build`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/AppShell.tsx src/pages/LibraryPage.tsx src/pages/FavoritesPage.tsx
git commit -m "style(weread): apply app shell to library and favorites"
```

---

## Task 4: 阅读页右侧抽屉（目录/书签/标注/收藏/搜索/设置）

**Why:** 用抽屉承载所有阅读工具，避免按钮堆叠破坏沉浸。

**Files**
- Create: `/workspace/src/ui/Drawer.tsx`
- Modify: `/workspace/src/pages/ReaderPage.tsx`
- Modify: `/workspace/src/reader/components/*Panel.tsx`

- [ ] **Step 1: Implement Drawer base**

```tsx
// /workspace/src/ui/Drawer.tsx
import { ReactNode } from "react";

export default function Drawer(props: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (!props.open) return null;
  return (
    <div
      style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.28)", display: "grid", justifyItems: "end" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="wr-panel" style={{ width: 380, height: "100%", borderRadius: 0, borderLeft: "1px solid var(--wr-hairline)" }}>
        <div className="wr-topbar">
          <div style={{ fontWeight: 800 }}>{props.title}</div>
          <div style={{ flex: 1 }} />
          <button className="wr-btn" onClick={props.onClose}>关闭</button>
        </div>
        <div style={{ padding: 14, overflow: "auto", height: "calc(100% - 62px)" }}>{props.children}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: ReaderPage wiring**
  - 添加 `drawerOpen` 状态，点击顶部工具条按钮切换 `sideTab` 并打开抽屉
  - 把目录/书签/标注/收藏/搜索/设置面板统一放入 Drawer
  - `Ctrl+F`：设置 `sideTab="search"` 且打开抽屉，聚焦输入框

- [ ] **Step 3: Panel style unification**
  - `BookmarksPanel / HighlightsPanel / SearchPanel / SettingsPanel` 去掉白底硬编码，改用 `wr-panel` 语义类与统一列表样式

- [ ] **Step 4: Verify**

Run: `npm run build`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/Drawer.tsx src/pages/ReaderPage.tsx src/reader/components/*.tsx
git commit -m "style(weread): add reader drawer for toc and tools"
```

---

## Task 5: 选中文本操作条（替代 confirm/prompt）+ 笔记输入在抽屉内完成

**Why:** 弹窗会打断阅读节奏，且在桌面端显得粗糙；微信读书风应使用原位操作条 + 抽屉编辑。

**Files**
- Create: `/workspace/src/reader/components/SelectionToolbar.tsx`
- Modify: `/workspace/src/pages/ReaderPage.tsx`
- Modify: `/workspace/src/reader/epub/reader.ts`

- [ ] **Step 1: Add SelectionToolbar component**

```tsx
// /workspace/src/reader/components/SelectionToolbar.tsx
export default function SelectionToolbar(props: {
  open: boolean;
  text: string;
  onHighlight: () => void;
  onFavorite: () => void;
  onNote: () => void;
  onClose: () => void;
}) {
  if (!props.open) return null;
  return (
    <div style={{ position: "absolute", left: 16, right: 16, bottom: 16, zIndex: 30 }}>
      <div className="wr-panel" style={{ padding: 10, borderRadius: 999, display: "flex", gap: 10, alignItems: "center" }}>
        <div style={{ flex: 1, minWidth: 0, color: "var(--wr-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {props.text}
        </div>
        <button className="wr-btn" onClick={props.onHighlight}>高亮</button>
        <button className="wr-btn" onClick={props.onFavorite}>收藏</button>
        <button className="wr-btn" onClick={props.onNote}>笔记</button>
        <button className="wr-btn" onClick={props.onClose}>关闭</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Extend createReader to report selection events**
  - 现有 `onSelected({ cfiRange, text })` 保持，但 ReaderPage 不再弹窗

- [ ] **Step 3: ReaderPage state machine**
  - 新增 `selection` state：`{ cfiRange, text } | null`
  - 选中时显示 `SelectionToolbar`
  - 点击“高亮/收藏”直接调用 `addHighlight/addFavoriteQuote`
  - “笔记”打开抽屉并切到 `highlights` 或 `favorites` 的编辑态（最小可用：用 `window.prompt` 替换为抽屉内 `<textarea>`）

- [ ] **Step 4: Verify**

Run: `npm run build`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/reader/components/SelectionToolbar.tsx src/pages/ReaderPage.tsx src/reader/epub/reader.ts
git commit -m "feat(weread): selection toolbar and drawer-based note flow"
```

---

## Task 6: 回归验证清单（手工 + 日志）

**Files:** none

- [ ] **Step 1: Dev run**

Run: `npm run tauri dev`

- [ ] **Step 2: Smoke list**
  - 书架：导入/打开/收藏/删除可用
  - 收藏页：书籍/句子 tab、筛选、跳转定位可用
  - 阅读页：目录/书签/标注/收藏/搜索/设置在右侧抽屉完整可达
  - 选中文本：出现操作条（高亮/收藏/笔记）
  - 全屏/不同窗口大小：正文不溢出（图片/长英文/URL）
  - `frontend.log` 不再出现 ResizeObserver loop 的刷屏

---

## Execution Handoff

Plan complete and saved to `/workspace/docs/superpowers/plans/2026-05-04-weread-ui-redesign-plan.md`.

Two execution options:
1. Subagent-Driven (recommended) — I dispatch a fresh subagent per task, review between tasks
2. Inline Execution — Execute tasks in this session with checkpoints

Which approach?

