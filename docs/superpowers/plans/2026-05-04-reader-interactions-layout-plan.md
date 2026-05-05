# 阅读页交互与版式修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复阅读页左右不铺满、沉浸模式误切换、正文无法选中标注/收藏，并消除主题切换导致的“回翻”观感。

**Architecture:** 将 reader 创建/销毁与设置更新解耦；把点击翻页热区收敛到“左右边距”，中间正文不拦截事件；沉浸切换只保留按钮/快捷键/HUD。

**Tech Stack:** React + TypeScript + epubjs + Vitest

---

## 文件结构与职责

- Modify: `src/pages/ReaderPage.tsx`
  - 计算“纸张舞台”可用尺寸（真实舞台宽度）
  - reader 创建 effect 仅依赖 bookId（+ cfi 参数）
  - settings 更新 effect 仅调用 controller 方法，不重建
  - 点击翻页热区改为“左右边距”
  - 禁用双击切换沉浸，保留按钮/快捷键/HUD
- Create: `src/reader/ui/paperStage.ts`
  - 纯函数：根据 viewer 宽高、边距、spreadMode 推导舞台布局（用于测试）
- Create: `src/reader/ui/paperStage.test.ts`
  - Vitest 覆盖：舞台计算与热区宽度计算
- Modify: `src/reader/settings/layoutMode.ts`（如需）
  - spread 判定使用“舞台真实宽度”

---

### Task 1: 舞台与热区计算（TDD）

**Files:**
- Create: `src/reader/ui/paperStage.ts`
- Test: `src/reader/ui/paperStage.test.ts`

- [ ] **Step 1: 写失败测试（舞台宽度占满 + 左右边距热区）**

```ts
import { describe, expect, test } from "vitest";
import { calcPaperStage } from "./paperStage";

test("paper stage fills width with margins", () => {
  const r = calcPaperStage({ viewerWidth: 1400, viewerHeight: 900, margin: 18, edgeRatio: 0.2 });
  expect(r.paperWidth).toBe(1400 - 36);
  expect(r.leftEdgeWidth).toBe(Math.round((1400 - 36) * 0.2));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现 calcPaperStage**

```ts
export function calcPaperStage(...) { ... }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/reader/ui/paperStage.ts src/reader/ui/paperStage.test.ts
git commit -m "test(reader): add paper stage sizing helpers"
```

---

### Task 2: 解耦 reader 重建，修主题切换“回翻”

**Files:**
- Modify: `src/pages/ReaderPage.tsx`

- [ ] **Step 1: 写一个最小的“不会因 theme/fontSize/layoutMode 变化重建 reader”的保护断言**
  - 在 ReaderPage 内部用 `useRef<number>` 记录 createReader 调用次数，仅在 bookId 变化时允许 +1
  - 用 `logFrontend` 输出（用于手工 smoke）；此项不做单测

- [ ] **Step 2: 重构 effect 依赖**
  - `createReader` effect 依赖：`book?.id` + `location.search`（仅首次读取 cfi）
  - settings 更新 effect：调用 `setTheme/setFontSizePercent/setSpreadMode`，禁止触发 `display`

- [ ] **Step 3: 本地 build/test**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/pages/ReaderPage.tsx
git commit -m "fix(reader): avoid reader rebuild on theme/layout changes"
```

---

### Task 3: 点击翻页热区只放左右边距，恢复正文选中

**Files:**
- Modify: `src/pages/ReaderPage.tsx`

- [ ] **Step 1: 移除“覆盖全屏”的翻页层**
  - 用 `calcPaperStage` 返回的 left/right edge 宽度与 margin 计算热区位置
  - 中间区域不放任何覆盖层

- [ ] **Step 2: 热区点击翻页与 SelectionToolbar 的关系**
  - SelectionToolbar 出现时可临时禁用热区（推荐），避免误翻页

- [ ] **Step 3: 本地 build/test**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/pages/ReaderPage.tsx src/reader/ui/paperStage.ts
git commit -m "fix(reader): edge-only pager zones to allow text selection"
```

---

### Task 4: 修沉浸误切换（禁用双击切换）

**Files:**
- Modify: `src/pages/ReaderPage.tsx`

- [ ] **Step 1: 移除 dblclick 切换沉浸**
  - 仅保留按钮、Ctrl+D、HUD 退出

- [ ] **Step 2: 本地 build/test**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/pages/ReaderPage.tsx
git commit -m "fix(reader): disable dblclick immersive toggle"
```

---

### Task 5: 手工 smoke 清单（你验收）

- [ ] **Smoke 1: 主题/护眼切换**
  - 切换 light/sepia/dark 不出现“回翻”，页面不跳动
- [ ] **Smoke 2: 选中标注/收藏**
  - 正文拖拽选中文本 → 操作条出现 → 高亮/收藏/笔记可用
- [ ] **Smoke 3: 翻页**
  - 点击左右边距可翻页；中间区域不误翻
- [ ] **Smoke 4: 沉浸**
  - 不会在阅读过程中误切换；仅按钮/快捷键/HUD 切换

