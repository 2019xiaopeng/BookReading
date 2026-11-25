// 「自动整理」规则试算的页面侧代码（在真实 dev 窗口的页面上下文里执行；由 dryrun-organize.mjs 读入后经 CDP 求值）。
// 只读：不调用任何写命令。输出只有计数与直方图，不输出书名。
// 写成独立文件（而非嵌在模板字符串里）是为了能用 `node --check tools/cdp/dryrun-organize.page.js` 直接校验，避免双重转义。
(async () => {
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args ?? {});
  const [shelves, books] = await Promise.all([inv("list_shelves"), inv("list_books")]);
  const byId = new Map(shelves.map((s) => [s.id, s]));
  const pathOf = (id) => {
    const names = [];
    let cur = byId.get(id ?? -1);
    let g = 0;
    while (cur && g++ < 20) {
      names.unshift(cur.name);
      cur = byId.get(cur.parent_id);
    }
    return names.join("/");
  };
  const isManga = (b) => b.format === "images";
  const KANA = /[぀-ヿ]/;
  const norm = (s) => (s ?? "").normalize("NFKC").toLowerCase().replace(/[\s_\-・:：~～]/g, "");
  const PLACEHOLDER = /^(|null|不详|未知|佚名|无名氏|其他|暂无|无|未知作者|不明)$/;
  const count = (m, k) => {
    if (m instanceof Map) m.set(k, (m.get(k) ?? 0) + 1);
    else m[k] = (m[k] ?? 0) + 1;
  };
  const out = { books: books.length };

  // ── 规则 1：作者清洗 ──
  const authorFix = {};
  const cleanAuthor = (a) => {
    const raw = (a ?? "").trim();
    let s = raw;
    const notes = [];
    if (PLACEHOLDER.test(norm(s).replace(/[()（）]/g, ""))) {
      notes.push("placeholder");
      return { author: "", notes };
    }
    const m = s.match(/^([^,，。；;]{1,30})[,，。;；]\s*(.{12,})$/);
    if (m) {
      s = m[1].trim();
      notes.push("introPollution");
    }
    let before = s;
    s = s.replace(/^[（(]\s*(日本|日|美国|美|英国|英|韩国|韩|台湾|台|中国|中)\s*[)）]\s*/, "");
    if (s !== before) notes.push("nationalityPrefix");
    before = s;
    s = s.replace(/@\S+$/, "");
    if (s !== before) notes.push("siteSuffix");
    return { author: s, notes };
  };
  const cleaned = new Map();
  for (const b of books) {
    const r = cleanAuthor(b.author);
    cleaned.set(b.id, r);
    for (const n of r.notes) count(authorFix, n);
  }

  // ── 规则 2：作者归并（"社团 (作家)" 三形态；大小写 / 全半角不敏感）──
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    parent.set(x, r);
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const keysOf = (a) => {
    const s = (a ?? "").trim();
    if (!s) return [];
    const m = s.match(/^(.+?)\s*[（(]\s*(.+?)\s*[)）]\s*$/);
    return m ? [norm(m[1]), norm(m[2]), norm(s)] : [norm(s)];
  };
  const forms = new Map(); // bookId -> keys
  for (const b of books) {
    const ks = keysOf(cleaned.get(b.id).author);
    forms.set(b.id, ks);
    for (const k of ks) find(k);
  }
  const partOwner = new Map(); // 社团名 / 作家名（来自 "A (B)" 形态）→ 该书的完整键
  for (const b of books) {
    const ks = forms.get(b.id);
    if (ks.length === 3 && !partOwner.has(ks[0])) partOwner.set(ks[0], ks[2]);
    if (ks.length === 3 && !partOwner.has(ks[1])) partOwner.set(ks[1], ks[2]);
  }
  let authorMerges = 0;
  for (const b of books) {
    const ks = forms.get(b.id);
    if (ks.length === 1 && partOwner.has(ks[0]) && partOwner.get(ks[0]) !== ks[0]) {
      union(ks[0], partOwner.get(ks[0]));
      authorMerges++;
    }
  }

  // ── 规则 3：标签提取（翻译状态等，来自标题里的方括号标签与 source_tags）──
  const tagHits = {};
  for (const b of books) {
    const t = ((b.title ?? "") + " " + (b.source_tags ?? "")).normalize("NFKC");
    const translated = /(中国翻訳|中国語|中文|中譯|汉化|漢化|翻訳|翻译)/.test(t);
    if (translated) count(tagHits, "已汉化");
    else if (isManga(b) && KANA.test(b.title ?? "")) count(tagHits, "生肉");
    if (/無修正|无修正/.test(t)) count(tagHits, "无修正");
    if (/DL\s*版/i.test(t)) count(tagHits, "DL版");
    if (/AI[- ]?generated|AI生成/i.test(t)) count(tagHits, "AI生成");
  }

  // ── 规则 4：系列键 + 卷号解析 ──
  const VOLUME_TAIL =
    /(第\s*[零一二三四五六七八九十百千\d]+\s*[~～\-]?\s*[零一二三四五六七八九十百千\d]*\s*[卷冊册話话回集章]|LEVEL[\s_：:]*\d+|Vol\.?\s*\d+|[+＋]\d+(\.\d+)?|[\s_：:\-]+\d+(\.\d+)?(~\d+)?)\s*$/;
  const seriesKey = (title) => {
    let s = title ?? "";
    s = s.replace(/【[^】]*】/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/[（(][^）)]*[）)]/g, " ");
    s = s.split(/[〜～｜|]/)[0];
    s = s.replace(VOLUME_TAIL, "").trim();
    return norm(s);
  };
  const volumeOf = (title) => {
    const t = (title ?? "").replace(/【[^】]*】/g, " ").replace(/\[[^\]]*\]/g, " ");
    let m = t.match(/LEVEL[\s_：:]*(\d+)/i);
    if (m) return +m[1];
    m = t.match(/第\s*(\d+)\s*[~～\-]?\s*(\d+)?\s*[巻卷册話话回]/);
    if (m) return +m[1];
    m = t.match(/(\d+)\s*[~～\-]\s*(\d+)\s*$/);
    if (m) return +m[1];
    m = t.match(/(\d+(\.\d+)?)\s*$/);
    if (m) return parseFloat(m[1]);
    return null;
  };
  const groups = new Map();
  for (const b of books) {
    const a = cleaned.get(b.id).author;
    const key = seriesKey(b.title);
    if (!a || key.length < 2) continue;
    const k = find(norm(a)) + "|" + key;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  const seriesGroups = [...groups.values()].filter((g) => g.length >= 2);
  const seriesSizeHist = {};
  for (const g of seriesGroups) count(seriesSizeHist, g.length >= 5 ? "5+" : String(g.length));
  const withVolume = books.filter((b) => volumeOf(b.title) != null).length;

  // ── 规则 5：漫画作者归架（漫画根下、作者组 ≥ K 本 → 建 / 归入「漫画 / 作者」子架）──
  const shelving = {};
  const rootManga = books.filter((b) => isManga(b) && pathOf(b.shelf_id) === "漫画");
  const byAuthor = new Map();
  const displayOf = new Map(); // 作者组 → 最长的展示名
  for (const b of books) {
    const a = cleaned.get(b.id).author;
    if (!a) continue;
    const g = find(norm(a));
    if (!displayOf.has(g) || displayOf.get(g).length < a.length) displayOf.set(g, a);
  }
  for (const b of rootManga) {
    const a = cleaned.get(b.id).author;
    if (!a) continue;
    const g = find(norm(a));
    if (!byAuthor.has(g)) byAuthor.set(g, []);
    byAuthor.get(g).push(b);
  }
  for (const K of [2, 3, 4]) {
    const eligible = [...byAuthor.values()].filter((g) => g.length >= K);
    shelving[K] = {
      rootManga: rootManga.length,
      newShelves: eligible.length,
      moved: eligible.reduce((s, g) => s + g.length, 0),
      stayInRoot: rootManga.length - eligible.reduce((s, g) => s + g.length, 0),
    };
  }

  // ── 规则 6：小说 / 轻小说判定（作者或书名含假名）──
  const novels = books.filter((b) => !isManga(b));
  const lightLike = novels.filter((b) => KANA.test(cleaned.get(b.id).author ?? "") || KANA.test(b.title ?? "")).length;
  const inLightShelf = novels.filter((b) => pathOf(b.shelf_id).startsWith("轻小说")).length;
  const lightInNovels = novels.filter(
    (b) => pathOf(b.shelf_id) === "小说" && (KANA.test(cleaned.get(b.id).author ?? "") || KANA.test(b.title ?? "")),
  ).length;

  // ── 规则 7：缺失作者推断（同系列键的其他书有作者）──
  const missing = books.filter((b) => !cleaned.get(b.id).author);
  const seriesWithAuthor = new Set();
  for (const b of books) if (cleaned.get(b.id).author) seriesWithAuthor.add(seriesKey(b.title));
  const inferred = missing.filter((b) => seriesWithAuthor.has(seriesKey(b.title))).length;

  // ── 规则 8：小说标题尾注（《》书名号、完结 / 章数 / 出品等）──
  const titleFix = {};
  for (const b of novels) {
    const t = (b.title ?? "").trim();
    if (/^[《「].*[》」]$/.test(t)) count(titleFix, "书名号包裹");
    if (/(【完结】|完结\)|全书完|章\+|集完结|出品|書籍|书籍|定製|定制|篇\d)/.test(t)) count(titleFix, "尾注（完结/章数/出品）");
  }

  // ── 现状：现有作者子架的规模分布（佐证阈值 K）──
  const shelfSizes = new Map();
  for (const b of books) count(shelfSizes, pathOf(b.shelf_id));
  const existingAuthorShelfSizes = [...shelfSizes.entries()]
    .filter(([p]) => p.startsWith("漫画/"))
    .map(([, n]) => n)
    .sort((a, b) => b - a);
  const rootAuthorHist = {};
  for (const g of byAuthor.values()) count(rootAuthorHist, g.length >= 5 ? "5+" : String(g.length));

  out.authorFix = authorFix;
  out.authorMerges = authorMerges;
  out.tagHits = tagHits;
  out.series = { groups: seriesGroups.length, books: seriesGroups.reduce((s, g) => s + g.length, 0), sizeHist: seriesSizeHist, withParsableVolume: withVolume };
  out.shelving = shelving;
  out.rootAuthorGroupSizes = rootAuthorHist;
  out.novels = { total: novels.length, lightLike, inLightShelf, lightLikeInsideNovelShelf: lightInNovels };
  out.missingAuthor = { total: missing.length, inferable: inferred };
  out.titleFix = titleFix;
  out.existingAuthorShelfSizes = existingAuthorShelfSizes;
  return JSON.stringify(out);
})()
