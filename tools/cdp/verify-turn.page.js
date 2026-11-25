// verify-turn.mjs 的页面侧助手：经 CDP 注入阅读页（独立文件，便于 node --check 校验）。
// 提供：按键翻页 / 状态快照 / 暂停动画并定位进度（确定性逐帧取证）/ 截图像素统计（判空白）。
window.__VT = {
  reset() {
    window.__anims.length = 0;
  },
  key(k) {
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
  async waitAnims(timeout) {
    const t0 = performance.now();
    while (!window.__anims.length) {
      if (performance.now() - t0 > (timeout || 4000)) return false;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return true;
  },
  /** 暂停全部伪元素动画并定位到进度 t（0–1） */
  seek(t) {
    for (const x of window.__anims) {
      x.a.pause();
      x.a.currentTime = t * x.duration;
    }
    return window.__anims.map((x) => x.pseudo);
  },
  cancel() {
    for (const x of window.__anims) {
      try {
        x.a.cancel();
      } catch (e) {
        // 已结束
      }
    }
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
