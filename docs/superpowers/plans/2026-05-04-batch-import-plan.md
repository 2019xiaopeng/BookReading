# Batch Multi-Select EPUB Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow selecting multiple EPUB files and importing them sequentially with per-file error logging and a single refresh at the end.

**Architecture:** Keep changes in the Library page only: switch the file picker to multi-select, normalize the result to a list, import each file sequentially with error isolation, then refresh once. No backend changes or new UI.

**Tech Stack:** React + TypeScript, Tauri dialog plugin

---

## File Structure

- Modify: `src/pages/LibraryPage.tsx` — update `onImport` to accept multiple files and import sequentially.

### Task 1: Enable multi-select import on Library page

**Files:**
- Modify: `src/pages/LibraryPage.tsx`

- [ ] **Step 1: Update `onImport` to accept multiple selections and import sequentially**

```tsx
  async function onImport() {
    if (loading) return;
    setLoading(true);
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "EPUB", extensions: ["epub"] }],
      });
      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;

      for (const path of paths) {
        try {
          await importBook({
            source_path: path,
            title: null,
            author: null,
            cover_bytes_base64: null,
            cover_ext: null,
          });
        } catch (e) {
          logFrontend(`ui: import failed ${path} ${String(e)}`);
        }
      }

      await refresh();
    } finally {
      setLoading(false);
    }
  }
```

- [ ] **Step 2: Manual verification**

Run: `npm run tauri dev`

Expected: App launches. Click “导入 EPUB”, select multiple `.epub` files, all are imported in order. Canceling the dialog does nothing. Books list refreshes after imports.

- [ ] **Step 3: Commit**

```bash
git add src/pages/LibraryPage.tsx
git commit -m "feat: allow multi-select epub import"
```

---

## File Structure (Versioning)

- Modify: `package.json` — bump `version`.
- Modify: `src-tauri/tauri.conf.json` — bump `version`.
- Modify: `src-tauri/Cargo.toml` — bump `version`.

### Task 2: Bump app version to 1.0.0

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Update version fields to 1.0.0**

```json
// package.json
{
  "version": "1.0.0"
}
```

```json
// src-tauri/tauri.conf.json
{
  "version": "1.0.0"
}
```

```toml
# src-tauri/Cargo.toml
[package]
version = "1.0.0"
```

- [ ] **Step 2: Commit**

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "chore: bump version to 1.0.0"
```

---

### Task 3: Build release artifacts

**Files:**
- None

- [ ] **Step 1: Build the Tauri app**

Run: `npm run tauri build`

Expected: Build completes without errors and artifacts are emitted under `src-tauri/target/release/bundle`.

- [ ] **Step 2: (Optional) Record build output location for handoff**

Expected: Note the installer/bundle path appropriate for Windows distribution.
