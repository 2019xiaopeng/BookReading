// 合成测试书（只用于无头验证：翻页动画 / 插图 / 跨章 / 高亮），内容全部是中性示例句，不含任何真实书名。
// 用法：node tools/cdp/make-synth-epub.mjs [输出路径]   （默认 temp/synth-turn.epub）
// 结构：8 章正文（第 3 章带两张插图、第 8 章很短）+ 两段落在第 1、2 章的高亮 CFI（见 HIGHLIGHTS）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deflateRawSync, deflateSync } from "node:zlib";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (bytes) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

/** 极简 ZIP 写入（Deflate / Stored，ASCII 文件名） */
function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => [n & 255, (n >>> 8) & 255];
  const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  for (const [name, data, stored] of files) {
    const raw = typeof data === "string" ? enc.encode(data) : data;
    const body = stored ? raw : deflateRawSync(raw, { level: 9 }); // ZIP 用裸 deflate（无 zlib 头尾）
    const nameBytes = enc.encode(name);
    const crc = CRC(raw);
    const local = new Uint8Array(30 + nameBytes.length);
    local.set([0x50, 0x4b, 0x03, 0x04, 20, 0, ...u16(stored ? 0 : 0x0800), ...u16(stored ? 0 : 8), 0, 0, 0, 0, ...u32(crc), ...u32(body.length), ...u32(raw.length), ...u16(nameBytes.length), 0, 0]);
    local.set(nameBytes, 30);
    parts.push(local, body);
    const entry = new Uint8Array(46 + nameBytes.length);
    // 中央目录项：扩展段 / 注释 / 起始盘 / 内外部属性 共 12 字节全零，之后是本地头偏移
    entry.set([0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, ...u16(stored ? 0 : 0x0800), ...u16(stored ? 0 : 8), 0, 0, 0, 0, ...u32(crc), ...u32(body.length), ...u32(raw.length), ...u16(nameBytes.length), ...new Uint8Array(12), ...u32(offset)]);
    entry.set(nameBytes, 46);
    central.push(entry);
    offset += local.length + body.length;
  }
  const cd = concat(central);
  const eocd = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(cd.length), ...u32(offset), 0, 0]);
  return concat([...parts, cd, eocd]);
}
function concat(list) {
  const out = new Uint8Array(list.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of list) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

/** 纯色横向渐变 PNG（RGB，无依赖） */
function png(w, h, from, to) {
  const ihdr = new Uint8Array(13);
  ihdr.set([w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, 8, 2, 0, 0, 0]);
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const k = x / (w - 1);
      for (let c = 0; c < 3; c++) raw[y * (w * 3 + 1) + 1 + x * 3 + c] = Math.round(from[c] + (to[c] - from[c]) * k);
    }
  }
  const enc = new TextEncoder();
  const chunk = (type, data) => {
    const body = concat([enc.encode(type), data]);
    const crc = CRC(body);
    return concat([new Uint8Array([body.length >>> 24, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255]), body, new Uint8Array([crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255])]);
  };
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

const SENTENCES = [
  "清晨的光线落在窗台上，纸页被照得微微发暖，翻动时带起一阵很轻的风。",
  "远处的山脊在薄雾里显出深浅不一的层次，像有人用淡墨一层层叠上去。",
  "茶凉到一半，杯壁上凝出细小的水珠，顺着弧度慢慢滑到桌面的书角旁。",
  "巷子里的石板路被雨水洗过，倒映出屋檐下一盏还没熄灭的灯。",
  "他把这一段读了两遍，在页边用铅笔轻轻画了一道短线，又觉得多余地擦掉了。",
  "风从半开的窗缝钻进来，掀动了桌上的几张便签，露出底下压着的一枚旧书签。",
  "树影在午后的墙上缓慢移动，从窗框的这一头走到那一头，正好是一章的长度。",
  "她说喜欢纸质书的理由很简单：可以停下来，也不会有人催促翻到下一页。",
  "雨声渐密，屋檐下的麻雀缩成一团，偶尔抖一抖羽毛，又安静下来。",
  "夜色沉下去以后，台灯的光圈成了房间里唯一清楚的边界，其余都是模糊的。",
];
const paras = (n, seed = 0) =>
  Array.from({ length: n }, (_, i) => SENTENCES[(i + seed) % SENTENCES.length] + SENTENCES[(i * 3 + seed + 1) % SENTENCES.length] + SENTENCES[(i * 7 + seed + 4) % SENTENCES.length] + SENTENCES[(i * 5 + seed + 6) % SENTENCES.length] + SENTENCES[(i * 2 + seed + 8) % SENTENCES.length]).map((s) => `<p>${s}</p>`);

const CHAPTERS = [
  { n: 18 },
  { n: 16, seed: 3 },
  { n: 16, seed: 6, figures: [3, 9] },
  { n: 16, seed: 9 },
  { n: 16, seed: 2 },
  { n: 16, seed: 5 },
  { n: 16, seed: 8 },
  { n: 2, seed: 1 },
];
const chapterXhtml = (i) => {
  const c = CHAPTERS[i];
  const body = paras(c.n, c.seed).map((p, k) => (c.figures?.includes(k) ? `<figure><img src="../images/fig${(c.figures.indexOf(k) % 2) + 1}.png" alt="插图"/><figcaption>图 ${k + 1} 示例插图</figcaption></figure>${p}` : p));
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
<head><meta charset="utf-8"/><title>第${i + 1}章</title><link rel="stylesheet" type="text/css" href="../style.css"/></head>
<body><h1>第${i + 1}章 示例章节</h1>${body.join("\n")}</body>
</html>`;
};
const files = [
  ["mimetype", "application/epub+zip", true],
  ["META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`],
  [
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:synth-turn-book</dc:identifier><dc:title>合成测试书（翻页验证用）</dc:title><dc:creator>示例作者</dc:creator><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-11-25T00:00:00Z</meta></metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="fig1" href="images/fig1.png" media-type="image/png"/>
<item id="fig2" href="images/fig2.png" media-type="image/png"/>
${CHAPTERS.map((_, i) => `<item id="c${i + 1}" href="text/ch0${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join("\n")}
</manifest>
<spine>${CHAPTERS.map((_, i) => `<itemref idref="c${i + 1}"/>`).join("")}</spine>
</package>`,
  ],
  ["OEBPS/nav.xhtml", `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN"><head><title>目录</title></head><body><nav epub:type="toc"><h1>目录</h1><ol>${CHAPTERS.map((_, i) => `<li><a href="text/ch0${i + 1}.xhtml">第${i + 1}章</a></li>`).join("")}</ol></nav></body></html>`],
  ["OEBPS/style.css", `body{font-family:serif;margin:0;padding:0}p{text-indent:2em;margin:0 0 .6em 0;text-align:justify}h1{font-size:1.4em;margin:.4em 0 1em 0;text-align:center}figure{margin:.8em 0;text-align:center}figure img{max-width:70%;height:auto}figcaption{font-size:.8em;color:#666}`],
  ["OEBPS/images/fig1.png", png(240, 150, [36, 110, 160], [250, 214, 120])],
  ["OEBPS/images/fig2.png", png(240, 150, [150, 70, 60], [60, 150, 110])],
  ...CHAPTERS.map((_, i) => [`OEBPS/text/ch0${i + 1}.xhtml`, chapterXhtml(i)]),
];
const out = process.argv[2] ?? "temp/synth-turn.epub";
mkdirSync(dirname(out), { recursive: true });
const bytes = zip(files);
writeFileSync(out, bytes);

/** 第 1、2 章各一段高亮（正文段直接挂在 body 下：h1 之后第 2、3 个 p） */
const HIGHLIGHTS = [
  { id: "synth-h1", book_id: "synth-turn", cfi_range: "epubcfi(/6/2!/4/6/1:6,/4/6/1:52)", color: "#ffe600", note: null, text: null, created_at: 0 },
  { id: "synth-h2", book_id: "synth-turn", cfi_range: "epubcfi(/6/4!/4/8/1:20,/4/8/1:64)", color: "#ffe600", note: null, text: null, created_at: 0 },
];
console.log(JSON.stringify({ out, bytes: bytes.length, highlights: HIGHLIGHTS }));
