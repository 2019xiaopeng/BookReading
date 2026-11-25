// Tauri IPC 假后端：无头浏览器里代替真实 Tauri 后端（设置 / 书架 / 书籍 / 体检 / 更新等命令的假数据 + 探针记录）。
// 用法：const c = await connect(9333); await c.send("Page.addScriptToEvaluateOnNewDocument", { source: ipcShimSource(MOCK) }); 再 Page.navigate。
// 页面内可改 window.__MOCK__.data 调整假数据；MOCK.calls / .written / .unknown 记录调用。
const S = (id, title, path, extra = {}) => ({ id, title, author: null, cover_path: null, library_path: path, added_at: 1_700_000_000, last_opened_at: null, note: null, pinned_at: null, reading_percent: null, is_favorite: false, format: "epub", page_count: null, shelf_id: null, sort_order: null, deleted_at: null, description: null, content_chars: null, file_size: 3_145_728, tags: [], ...extra });

export const MOCK = {
  settings: {
    theme: "ink", fontSizePercent: "125", pageAnimation: "paper", turnSpeedMs: "260", layoutMode: "auto", lineHeight: "1.8",
    fontFamily: "songti", fontWeight: "400", letterSpacing: "0", paragraphSpacing: "0.2", textIndent: "0", pageMargin: "24",
    justify: "false", readingMode: "paginated", reader_bg: JSON.stringify({ type: "preset" }), reader_font: JSON.stringify({ type: "preset" }),
    ttsRate: "1.1", bg_veil: "88", import_mode: "copy", close_action: "tray", update_check: "on", "continue_card.enabled": "1",
    library_density: "large", trash_retention_days: "30", "wenku8.dest_shelf": "", "wenku8.sort": "updated", "wenku8.endpoint": "auto",
    "proxy.enabled": "1", "proxy.host": "127.0.0.1", "proxy.port": "7897",
    image_reader_settings: JSON.stringify({ fit: "height", layout: "double", rtl: true, mode: "paged", pageAnimation: "slide", webtoonWidth: 75, autoScrollSpeed: 60, doubleOffset: 1 }),
    pdf_reader_settings: JSON.stringify({ fit: "width", layout: "single", rtl: false, mode: "webtoon", pageAnimation: "none", webtoonWidth: 80, autoScrollSpeed: 90, doubleOffset: 0 }),
  },
  shelves: [
    { id: 1, name: "轻小说", parent_id: null, sort_order: 1, created_at: 0 },
    { id: 2, name: "漫画", parent_id: null, sort_order: 2, created_at: 0 },
    { id: 3, name: "日漫生肉（一个名字特别特别长的嵌套书架，用来测换行与省略）", parent_id: 2, sort_order: 1, created_at: 0 },
  ],
  books: [
    S("a1", "斗破苍穹", "library/epub/9f1c2a70-重复.epub", { shelf_id: 1, file_size: 2_147_483_648, added_at: 1_695_000_000 }),
    S("a2", "斗破苍穹", "E:\\下载\\网络小说\\完结\\斗破苍穹（精校版全本）.epub", { added_at: 1_705_000_000 }),
    S("c1", "进击的巨人 第01卷", "library/images/c1-7b3e9f10", { format: "images", shelf_id: 3, added_at: 1_698_000_000 }),
    S("c2", "进击的巨人 第01卷", "D:\\漫画\\ 进击的巨人\\Attack on Titan\\第01卷", { format: "images", shelf_id: 2, added_at: 1_706_000_000 }),
    S("m1", "海贼王 第98卷", "F:\\已挪走的目录\\One Piece\\v98", { format: "images" }),
    S("m2", "三体", "library/epub/3b9d-三体.epub"),
    S("m3", "一个名字特别特别长的失链漫画标题用来测试在窄窗口下会不会把操作列挤出弹窗 第99卷", "H:\\External\\Comics\\Very Long Folder Name\\Another Long Folder\\vol-99", { format: "images" }),
    S("m4", "球状闪电", "library/epub/77aa-球状闪电.epub"),
    S("k1", "封面丢失的书甲", "library/epub/k1.epub"),
    S("k2", "封面丢失的书乙", "library/epub/k2.epub"),
  ],
  stats: {
    library_root: "D:\\Some Rather Long Path\\BookLibrary\\一个中文目录\\books",
    db_path: "C:\\Users\\Someone\\AppData\\Roaming\\com.root.bookreading\\bookreading.db",
    library_bytes: 312_457_128_964, covers_bytes: 412_883_968, bg_bytes: 2_410_368, db_bytes: 18_874_368, logs_bytes: 1_204_608, trash_count: 3,
  },
  health: {
    duplicates: [
      { label: "斗破苍穹", bookIds: ["a1", "a2"] },
      { label: "进击的巨人 第01卷", bookIds: ["c1", "c2"] },
    ],
    missingSources: [
      { bookId: "m1", title: "海贼王 第98卷", path: "F:\\已挪走的目录\\One Piece\\v98", kind: "folder" },
      { bookId: "m2", title: "三体", path: "library/epub/3b9d-三体.epub", kind: "library" },
      { bookId: "m3", title: "一个名字特别特别长的失链漫画标题用来测试在窄窗口下会不会把操作列挤出弹窗 第99卷", path: "H:\\External\\Comics\\Very Long Folder Name\\Another Long Folder\\vol-99", kind: "folder" },
      { bookId: "m4", title: "球状闪电", path: "library/epub/77aa-球状闪电.epub", kind: "library" },
    ],
    missingCovers: [
      { bookId: "k1", title: "封面丢失的书甲", coverPath: "covers/k1.png" },
      { bookId: "k2", title: "封面丢失的书乙", coverPath: "covers/k2.png" },
    ],
  },
};

export function ipcShimSource(mock) {
  return `
(() => {
  const MOCK = window.__MOCK__ = { data: ${JSON.stringify(mock)}, calls: [], unknown: new Set(), written: [] };
  let cbId = 0;
  const commands = {
    "plugin:app|version": () => "3.2.0-preview",
    "plugin:event|listen": () => ++cbId + 1000,
    "plugin:event|unlisten": () => null,
    "plugin:event|emit": () => null,
    "plugin:window|is_maximized": () => false,
    "plugin:window|is_fullscreen": () => false,
    "plugin:window|theme": () => "light",
    "plugin:window|scale_factor": () => 1,
    "plugin:window|inner_position": () => ({ x: 0, y: 0 }),
    "plugin:window|outer_position": () => ({ x: 0, y: 0 }),
    "plugin:window|inner_size": () => ({ width: 1280, height: 800 }),
    "plugin:window|outer_size": () => ({ width: 1280, height: 800 }),
    get_settings: () => ({ ...MOCK.data.settings }),
    set_setting: (a) => { MOCK.data.settings[a.key] = a.value; MOCK.written.push([a.key, a.value]); return null; },
    set_settings: (a) => { Object.assign(MOCK.data.settings, a.values); for (const k of Object.keys(a.values)) MOCK.written.push([k, a.values[k]]); return null; },
    list_shelves: () => MOCK.data.shelves.map((s) => ({ ...s })),
    list_books: () => MOCK.data.books.map((b) => ({ ...b })),
    list_tags: () => [],
    list_reading_times: () => [],
    storage_stats: () => ({ ...MOCK.data.stats }),
    "wenku8_status": () => ({ has_saved: true, username: "reader@example" }),
    wenku8_endpoint_status: () => ({ setting: "auto", session: "relay", relay_ok: true, direct_ok: false }),
    scan_library_health: () => JSON.parse(JSON.stringify(MOCK.data.health)),
    delete_books_from_disk: (a) => a.bookIds.length,
    delete_books: () => null,
    clear_cache: () => ({ freed_bytes: 0 }),
    check_app_update: () => ({ hasUpdate: false }),
    "plugin:path|resolve_directory": () => null,
    append_frontend_log: () => null,
  };
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      MOCK.calls.push(cmd);
      const f = commands[cmd];
      if (!f) { MOCK.unknown.add(cmd); throw new Error("mock: unknown command " + cmd); }
      return f(args ?? {});
    },
    transformCallback: (cb, once) => { const id = ++cbId; window["_" + id] = cb; return id; },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    convertFileSrc: (path, protocol) => "http://" + (protocol || "asset") + ".localhost/" + encodeURIComponent(String(path)),
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
})();
`;
}
