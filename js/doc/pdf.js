/* ============================================================
   DOCAI · pdf — per-page text extraction with positions.

   Embedded text is always preferred over OCR: it is exact, it is fast, and
   it carries real coordinates. Pages that carry no usable text are reported
   back as needing OCR rather than being silently skipped, so a mixed
   text/scanned PDF comes out whole.

   PDF.js is fetched from a CDN the first time it is needed. That request
   carries library code only — the document itself never leaves the browser.
   ============================================================ */
(function (root) {
  "use strict";

  var P = {};

  P.PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  P.PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  // A page with less than this much text is treated as scanned artwork.
  P.MIN_TEXT_PER_PAGE = 25;

  function loadScript(src) {
    return new Promise(function (res, rej) {
      if (document.querySelector('script[src="' + src + '"]')) return res();
      var s = document.createElement("script");
      s.src = src;
      s.onload = res;
      s.onerror = function () { rej(new Error("Couldn't load " + src.split("/").pop() + " — check your internet connection.")); };
      document.head.appendChild(s);
    });
  }

  P.ensureLib = function () {
    if (root.pdfjsLib) {
      root.pdfjsLib.GlobalWorkerOptions.workerSrc = P.PDFJS_WORKER;
      return Promise.resolve(root.pdfjsLib);
    }
    return loadScript(P.PDFJS_URL).then(function () {
      if (!root.pdfjsLib) throw new Error("PDF.js loaded but did not register itself.");
      root.pdfjsLib.GlobalWorkerOptions.workerSrc = P.PDFJS_WORKER;
      return root.pdfjsLib;
    });
  };

  /* ---------- open ----------
     Password-protected and corrupt files are turned into plain-language
     errors rather than PDF.js internals. */
  P.open = function (arrayBuffer) {
    return P.ensureLib().then(function (lib) {
      var task = lib.getDocument({ data: arrayBuffer, isEvalSupported: false });
      return task.promise.catch(function (e) {
        var name = e && (e.name || "");
        if (name === "PasswordException" || /password/i.test(e && e.message || "")) {
          throw new Error("This PDF is password-protected. Remove the password and try again — the password cannot be read here.");
        }
        if (name === "InvalidPDFException" || /invalid|corrupt|structure/i.test(e && e.message || "")) {
          throw new Error("This PDF appears to be corrupt or is not a valid PDF file.");
        }
        throw new Error("Couldn't open the PDF: " + (e && e.message ? e.message : "unknown error"));
      });
    });
  };

  /* ---------- text with positions ----------
     PDF.js gives each text item a transform matrix; the offsets are converted
     into a top-left-origin box so highlighting matches what the user sees. */
  function itemsFrom(textContent, viewport) {
    var out = [];
    (textContent.items || []).forEach(function (it) {
      if (!it.str || !it.str.trim()) return;
      var t = it.transform || [1, 0, 0, 1, 0, 0];
      var x = t[4], yBottom = t[5];
      var h = Math.abs(it.height || t[3] || 10);
      var w = it.width || (it.str.length * h * 0.5);
      out.push({
        str: it.str,
        bbox: {
          x: x,
          y: Math.max(0, viewport.height - yBottom - h), // flip to top-left origin
          w: w,
          h: h,
          pageW: viewport.width,
          pageH: viewport.height
        }
      });
    });
    return out;
  }

  // Items come back in draw order, not reading order. Grouping by baseline
  // and sorting left-to-right recovers lines, which is what the label-based
  // extractors depend on.
  function linesFrom(items) {
    if (!items.length) return "";
    var sorted = items.slice().sort(function (a, b) {
      var dy = a.bbox.y - b.bbox.y;
      if (Math.abs(dy) > Math.max(3, a.bbox.h * 0.6)) return dy;
      return a.bbox.x - b.bbox.x;
    });
    var lines = [], cur = [], curY = null;
    sorted.forEach(function (it) {
      if (curY === null || Math.abs(it.bbox.y - curY) <= Math.max(3, it.bbox.h * 0.6)) {
        cur.push(it);
        curY = curY === null ? it.bbox.y : curY;
      } else {
        lines.push(cur); cur = [it]; curY = it.bbox.y;
      }
    });
    if (cur.length) lines.push(cur);

    return lines.map(function (ln) {
      // Re-insert a separator where there is a visible horizontal gap, so a
      // two-column "Label      Value" layout does not run together.
      var text = "";
      for (var i = 0; i < ln.length; i++) {
        if (i > 0) {
          var gap = ln[i].bbox.x - (ln[i - 1].bbox.x + ln[i - 1].bbox.w);
          text += gap > ln[i].bbox.h * 0.8 ? "  " : (/\s$/.test(text) ? "" : " ");
        }
        text += ln[i].str;
      }
      return text.replace(/\s+$/, "");
    }).join("\n");
  }

  /* ---------- extract every page ----------
     onProgress(done, total, note) keeps the UI responsive; the caller yields
     to the event loop between pages. */
  P.extractPages = function (arrayBuffer, onProgress) {
    var pdf;
    return P.open(arrayBuffer).then(function (doc) {
      pdf = doc;
      var total = pdf.numPages;
      var pages = [];
      var chain = Promise.resolve();

      for (var i = 1; i <= total; i++) {
        (function (n) {
          chain = chain.then(function () {
            if (onProgress) onProgress(n - 1, total, "Reading page " + n + " of " + total + "…");
            return pdf.getPage(n).then(function (page) {
              var viewport = page.getViewport({ scale: 1 });
              return page.getTextContent().then(function (tc) {
                var items = itemsFrom(tc, viewport);
                var text = linesFrom(items);
                pages.push({
                  page: n,
                  text: text,
                  items: items,
                  source: "embedded",
                  needsOcr: text.replace(/\s/g, "").length < P.MIN_TEXT_PER_PAGE,
                  width: viewport.width,
                  height: viewport.height,
                  _pdfPage: page
                });
              });
            });
          });
        })(i);
      }

      return chain.then(function () {
        pages.sort(function (a, b) { return a.page - b.page; });
        if (onProgress) onProgress(total, total, "Read " + total + " page(s).");
        return { pages: pages, numPages: total, pdf: pdf };
      });
    });
  };

  /* ---------- render a page to a canvas ----------
     Used both to OCR image-only pages and to show the review preview. */
  P.renderPage = function (page, scale) {
    var viewport = page.getViewport({ scale: scale || 2 });
    var canvas = document.createElement("canvas");
    canvas.width = Math.min(4000, Math.round(viewport.width));
    canvas.height = Math.min(4000, Math.round(viewport.height));
    var ctx = canvas.getContext("2d");
    // White ground: transparent PDF backgrounds otherwise OCR as black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () { return canvas; });
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.pdf = P;
  if (typeof module !== "undefined" && module.exports) module.exports = P;
})(typeof globalThis !== "undefined" ? globalThis : this);
