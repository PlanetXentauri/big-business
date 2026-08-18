/* ============================================================
   DOCAI · ocr — Tesseract adapter.

   Runs in Tesseract's own web worker so the page keeps responding while a
   long scan is read. Word-level boxes are kept so the review screen can
   point at where on the page a value came from.

   Tesseract's script and language data are fetched from a CDN on first use.
   That traffic is the recognition engine itself; the document is passed to
   it in-process and is never uploaded.
   ============================================================ */
(function (root) {
  "use strict";

  var O = {};

  O.TESS_URL = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js";

  var workerPromise = null;

  function loadScript(src) {
    return new Promise(function (res, rej) {
      if (document.querySelector('script[src="' + src + '"]')) return res();
      var s = document.createElement("script");
      s.src = src;
      s.onload = res;
      s.onerror = function () { rej(new Error("Couldn't load the text-recognition engine — check your internet connection.")); };
      document.head.appendChild(s);
    });
  }

  /* One worker is created and reused. Spinning one up per page costs several
     seconds each time, which is the difference between a multipage scan
     taking a minute and taking ten. */
  O.worker = function (onProgress) {
    if (workerPromise) return workerPromise;
    workerPromise = loadScript(O.TESS_URL).then(function () {
      if (!root.Tesseract) throw new Error("The text-recognition engine loaded but did not register itself.");
      if (typeof root.Tesseract.createWorker !== "function") {
        return null; // very old build: caller falls back to recognize()
      }
      return root.Tesseract.createWorker("eng", 1, {
        logger: function (m) {
          if (onProgress && m && m.status === "recognizing text") {
            onProgress(m.progress || 0, "Reading text… " + Math.round((m.progress || 0) * 100) + "%");
          }
        }
      });
    }).catch(function (e) {
      workerPromise = null;
      throw e;
    });
    return workerPromise;
  };

  O.terminate = function () {
    if (!workerPromise) return Promise.resolve();
    var p = workerPromise;
    workerPromise = null;
    return p.then(function (w) { return w && w.terminate ? w.terminate() : null; }).catch(function () {});
  };

  /* ---------- recognise one image ----------
     `input` is a canvas, blob or File. Returns text plus word boxes in the
     same shape the PDF path produces, so extractors do not care which
     path a page came from. */
  O.recognize = function (input, onProgress) {
    return O.worker(onProgress).then(function (w) {
      if (w && w.recognize) {
        return w.recognize(input).then(function (r) { return shape(r); });
      }
      // Fallback for builds without createWorker.
      return root.Tesseract.recognize(input, "eng", {
        logger: function (m) {
          if (onProgress && m && m.status === "recognizing text") {
            onProgress(m.progress || 0, "Reading text… " + Math.round((m.progress || 0) * 100) + "%");
          }
        }
      }).then(function (r) { return shape(r); });
    });
  };

  function shape(result) {
    var d = (result && result.data) || {};
    var items = [];
    var words = d.words || [];
    // Tesseract 5 nests words under blocks/paragraphs/lines when the flat
    // list is absent; walk whichever structure is present.
    if (!words.length && d.blocks) {
      d.blocks.forEach(function (b) {
        (b.paragraphs || []).forEach(function (p) {
          (p.lines || []).forEach(function (l) {
            (l.words || []).forEach(function (wd) { words.push(wd); });
          });
        });
      });
    }
    words.forEach(function (wd) {
      if (!wd || !wd.text || !wd.text.trim()) return;
      var bb = wd.bbox || {};
      items.push({
        str: wd.text,
        confidence: wd.confidence,
        bbox: {
          x: bb.x0 || 0,
          y: bb.y0 || 0,
          w: (bb.x1 || 0) - (bb.x0 || 0),
          h: (bb.y1 || 0) - (bb.y0 || 0)
        }
      });
    });

    var confident = words.filter(function (wd) { return wd && wd.confidence >= 60; }).length;
    return {
      text: d.text || "",
      items: items,
      meanConfidence: d.confidence == null ? null : Math.round(d.confidence),
      wordCount: words.length,
      lowConfidenceShare: words.length ? 1 - (confident / words.length) : 0
    };
  }

  /* A written note about recognition quality — shown to the user rather than
     folded into a number. */
  O.qualityNote = function (res) {
    if (!res || !res.wordCount) return "No text could be recognised in this image.";
    if (res.meanConfidence != null && res.meanConfidence < 55) {
      return "Text recognition confidence was low (" + res.meanConfidence + "/100 average). Values from this page should be checked carefully against the original.";
    }
    if (res.lowConfidenceShare > 0.4) {
      return "About " + Math.round(res.lowConfidenceShare * 100) + "% of the words were read with low confidence — check anything that looks wrong.";
    }
    return "Recognised " + res.wordCount + " words" +
      (res.meanConfidence != null ? " at " + res.meanConfidence + "/100 average confidence" : "") + ".";
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.ocr = O;
  if (typeof module !== "undefined" && module.exports) module.exports = O;
})(typeof globalThis !== "undefined" ? globalThis : this);
