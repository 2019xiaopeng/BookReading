// verify-turn.mjs 的页面侧助手：经 CDP 注入阅读页（独立文件，便于 node --check 校验）。
// 提供：按键翻页 / 状态快照 / 暂停动画并定位进度（确定性逐帧取证）/ 截图像素统计（判空白）。
/** 提示胶囊中心相对视口中心的偏移（px）——V-13 要求「屏幕正中」 */
function centered(el) {
  const r = el.getBoundingClientRect();
  return { dx: Math.round(r.left + r.width / 2 - window.innerWidth / 2), dy: Math.round(r.top + r.height / 2 - window.innerHeight / 2), w: Math.round(r.width), h: Math.round(r.height) };
}

/** V-13 用：视觉书的合成数据——图片页在页面里用 canvas 现画成 PNG；PDF 是手写的最小 PDF（xref 偏移留空，pdf.js 会重建） */
window.__SYN = {
  /** 页面尺寸竖横交替（偶数页 400×600、奇数页 800×450）：fold 场景要用「竖页翻向横页」看覆盖层底色 */
  async png(i) {
    const wide = i % 2 === 1;
    const c = document.createElement("canvas");
    c.width = wide ? 800 : 400;
    c.height = wide ? 450 : 600;
    const g = c.getContext("2d");
    g.fillStyle = ["#f3e9d2", "#dfe9f3", "#e9f3e1", "#f3dfe6", "#ececec"][i % 5];
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#2b2b28";
    g.font = "bold 160px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(i + 1), c.width / 2, c.height / 2);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  },
  pdf(n) {
    const objs = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
    const kids = [];
    for (let i = 0; i < n; i++) {
      kids.push(`${objs.length + 1} 0 R`);
      objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /Font << /F1 ${2 * n + 3} 0 R >> >> /Contents ${objs.length + 2} 0 R >>`);
      const s = `BT /F1 120 Tf 40 400 Td (${i + 1}) Tj ET`;
      objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
    }
    objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >>`;
    objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    let out = "%PDF-1.4\n";
    objs.forEach((o, i) => {
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    return new TextEncoder().encode(`${out}trailer\n<< /Root 1 0 R /Size ${objs.length + 1} >>\n%%EOF\n`);
  },
};

window.__VT = {
  reset() {
    window.__anims.length = 0;
  },
  key(k) {
    this.lastKeyAt = Math.round(performance.now());
    for (const type of ["keydown", "keyup"]) {
      window.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
    }
  },
  state() {
    const leaf = document.querySelector(".wr-reader-leaf");
    const view = leaf && leaf.querySelector(".epub-view");
    const scroller = leaf && leaf.querySelector(".epub-container");
    return {
      spine: view ? Number(view.getAttribute("ref")) : null,
      scrollLeft: scroller ? Math.round(scroller.scrollLeft) : null,
      scrollTop: scroller ? Math.round(scroller.scrollTop) : 0,
      // 竖排章：epub.js 把滚动容器改成纵向分页
      vertical: !!(scroller && scroller.scrollHeight > scroller.clientHeight + 2),
      pageWidth: leaf ? leaf.clientWidth : null,
      iframes: leaf ? leaf.querySelectorAll("iframe").length : 0,
      turning: document.documentElement.dataset.wrTurn ?? null,
      bands: leaf ? leaf.querySelectorAll('[style*="view-transition-name"]').length : 0,
      badges: Array.from(document.querySelectorAll(".wr-page-badge")).map((b) => b.textContent),
      hl: leaf ? leaf.querySelectorAll(".epubjs-hl").length : 0,
    };
  },
  /** V-13 首/末页提示胶囊：{ text, opacity }；从没出现过 = null */
  hint() {
    const el = document.querySelector(".wr-toast--center");
    return el ? { text: el.textContent, opacity: getComputedStyle(el).opacity, centered: centered(el) } : null;
  },
  paperRect(pad) {
    const p = document.querySelector(".wr-reader-paper");
    if (!p) return null;
    const b = p.getBoundingClientRect();
    return {
      x: Math.max(0, Math.floor(b.left) - pad),
      y: Math.max(0, Math.floor(b.top) - pad),
      width: Math.ceil(b.width) + pad * 2,
      height: Math.ceil(b.height) + pad * 2,
    };
  },
  /** 等已记录的动画出现：which="hint" 等提示胶囊的淡入淡出，否则等翻页的伪元素动画 */
  async waitAnims(timeout, which) {
    const list = which === "hint" ? window.__hintAnims : window.__anims;
    const t0 = performance.now();
    while (!list.length) {
      if (performance.now() - t0 > (timeout || 4000)) return false;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return true;
  },
  /** 暂停全部已记录动画（翻页伪元素 + 提示胶囊）并定位到进度 t（0–1） */
  seek(t) {
    for (const x of [...window.__anims, ...window.__hintAnims]) {
      x.a.pause();
      x.a.currentTime = t * x.duration;
    }
    return window.__anims.map((x) => x.pseudo);
  },
  /** 取消已记录的动画：翻页的全部；提示胶囊只取消前 hintLimit 条——截图期间新冒出来的淡出动画不能动
   *  （取消了它，元素就停在透明度 1，看起来像「没有淡出」） */
  cancel(hintLimit = Infinity) {
    for (const x of [...window.__anims, ...(window.__hintAnims ?? []).slice(0, hintLimit)]) {
      try {
        x.a.cancel();
      } catch (e) {
        // 已结束
      }
    }
  },
  /** E6：按 relocated 的算法（TreeWalker 从 body 开头逐文本节点取矩形）走前 limit 个节点，返回 { nodes, ms } */
  cfiWalk(limit) {
    const doc = document.querySelector(".wr-reader-leaf iframe")?.contentDocument;
    if (!doc?.body) return null;
    const t0 = performance.now();
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    let n = 0;
    for (let node = walker.nextNode(); node && n < limit; node = walker.nextNode(), n++) {
      range.selectNodeContents(node);
      range.getBoundingClientRect();
    }
    return { nodes: n, ms: +(performance.now() - t0).toFixed(2) };
  },
  /** 取截图上一点的像素（dataUrl=CDP 截图）：E10 判「新页有没有从旧页四周透出来」用 */
  pixel(dataUrl, x, y) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const g = document.createElement("canvas").getContext("2d");
        g.canvas.width = img.width;
        g.canvas.height = img.height;
        g.drawImage(img, 0, 0);
        const d = g.getImageData(x, y, 1, 1).data;
        resolve([d[0], d[1], d[2]]);
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  },
  async waitIdle(timeout) {
    const t0 = performance.now();
    while (document.documentElement.dataset.wrTurn !== undefined) {
      if (performance.now() - t0 > (timeout || 8000)) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
    return true;
  },
  /**
   * 截图像素统计：偏离中位亮度 >40 的像素占比。正文页应有若干个百分点；空白纸面≈0。
   * dataUrl = CDP 截图；pad = 截图相对纸面四周多留的像素（统计时裁掉）。
   */
  ink(dataUrl, pad) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const g = document.createElement("canvas").getContext("2d");
        g.canvas.width = img.width;
        g.canvas.height = img.height;
        g.drawImage(img, 0, 0);
        const w = g.canvas.width - pad * 2;
        const h = g.canvas.height - pad * 2;
        const d = g.getImageData(pad, pad, w, h).data;
        const lum = new Float64Array(w * h);
        const hist = new Uint32Array(64);
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
          const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          lum[p] = l;
          hist[Math.min(63, l >> 2)] += 1;
        }
        let median = 0;
        for (let b = 0, acc = 0; b < 64; b++) {
          acc += hist[b];
          if (acc * 2 >= lum.length) {
            median = b * 4;
            break;
          }
        }
        let ink = 0;
        for (let p = 0; p < lum.length; p++) if (Math.abs(lum[p] - median) > 40) ink += 1;
        resolve({ ink: ink / lum.length, median, w, h });
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  },
};
