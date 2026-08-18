/* ============================================================
   DOCAI · image — preprocessing for photographed documents.

   Everything here is non-destructive. The original File is never modified
   and is what gets stored; preprocessing produces a separate canvas used
   only to feed OCR. If a step cannot be done reliably it is skipped and
   said so, rather than applied on a guess.
   ============================================================ */
(function (root) {
  "use strict";

  var I = {};

  /* ---------- EXIF orientation ----------
     Read straight from the JPEG APP1 segment. createImageBitmap can do this
     natively, but support is uneven, so the tag is parsed and applied here. */
  I.readExifOrientation = function (arrayBuffer) {
    try {
      var view = new DataView(arrayBuffer);
      if (view.byteLength < 4 || view.getUint16(0, false) !== 0xFFD8) return 1; // not JPEG
      var offset = 2, length = view.byteLength;
      while (offset < length - 1) {
        if (view.getUint8(offset) !== 0xFF) break;
        var marker = view.getUint8(offset + 1);
        if (marker === 0xE1) { // APP1
          var exifStart = offset + 4;
          if (view.getUint32(exifStart, false) !== 0x45786966) return 1; // "Exif"
          var tiff = exifStart + 6;
          var little = view.getUint16(tiff, false) === 0x4949;
          var ifdOffset = view.getUint32(tiff + 4, little);
          var dir = tiff + ifdOffset;
          var entries = view.getUint16(dir, little);
          for (var i = 0; i < entries; i++) {
            var entry = dir + 2 + i * 12;
            if (view.getUint16(entry, little) === 0x0112) {
              var o = view.getUint16(entry + 8, little);
              return (o >= 1 && o <= 8) ? o : 1;
            }
          }
          return 1;
        }
        if ((marker & 0xFFF0) === 0xFFC0 || marker === 0xDA) break;
        offset += 2 + view.getUint16(offset + 2, false);
      }
    } catch (e) { /* any parse trouble means "assume upright" */ }
    return 1;
  };

  // Draw the bitmap with the EXIF transform applied, so downstream code only
  // ever sees an upright image.
  I.applyOrientation = function (bitmap, orientation) {
    var w = bitmap.width, h = bitmap.height;
    var swap = orientation >= 5 && orientation <= 8;
    var canvas = document.createElement("canvas");
    canvas.width = swap ? h : w;
    canvas.height = swap ? w : h;
    var ctx = canvas.getContext("2d");
    switch (orientation) {
      case 2: ctx.translate(w, 0); ctx.scale(-1, 1); break;
      case 3: ctx.translate(w, h); ctx.rotate(Math.PI); break;
      case 4: ctx.translate(0, h); ctx.scale(1, -1); break;
      case 5: ctx.rotate(0.5 * Math.PI); ctx.scale(1, -1); break;
      case 6: ctx.rotate(0.5 * Math.PI); ctx.translate(0, -h); break;
      case 7: ctx.rotate(0.5 * Math.PI); ctx.translate(w, -h); ctx.scale(-1, 1); break;
      case 8: ctx.rotate(-0.5 * Math.PI); ctx.translate(-w, 0); break;
      default: break;
    }
    ctx.drawImage(bitmap, 0, 0);
    return canvas;
  };

  /* ---------- quality assessment ----------
     Cheap, explainable measures. Variance of the Laplacian for focus, and
     the spread of the luminance histogram for contrast. These are reported
     as warnings, never used to silently reject a file. */
  I.assess = function (canvas) {
    var w = canvas.width, h = canvas.height;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    // Sample a centre crop; scanning every pixel of a 12 MP photo is wasteful.
    var sw = Math.min(w, 900), sh = Math.min(h, 900);
    var sx = Math.max(0, Math.floor((w - sw) / 2)), sy = Math.max(0, Math.floor((h - sh) / 2));
    var data = ctx.getImageData(sx, sy, sw, sh).data;

    var gray = new Float32Array(sw * sh);
    var hist = new Uint32Array(256);
    for (var i = 0, p = 0; i < data.length; i += 4, p++) {
      var g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      gray[p] = g;
      hist[g | 0]++;
    }

    // focus: variance of a 4-neighbour Laplacian
    var sum = 0, sumSq = 0, n = 0;
    for (var y = 1; y < sh - 1; y++) {
      for (var x = 1; x < sw - 1; x++) {
        var k = y * sw + x;
        var lap = 4 * gray[k] - gray[k - 1] - gray[k + 1] - gray[k - sw] - gray[k + sw];
        sum += lap; sumSq += lap * lap; n++;
      }
    }
    var mean = n ? sum / n : 0;
    var focus = n ? (sumSq / n - mean * mean) : 0;

    // contrast: how far apart ink and paper actually are.
    // A percentile spread cannot see this — on a normal document the text
    // covers well under 2% of the pixels, so both percentiles land on the
    // paper and every page looks identically flat. Otsu splits the histogram
    // at its most separable point and compares the two class means, which is
    // the real ink-to-paper distance whatever the coverage.
    var spread = otsuSeparation(hist, sw * sh);

    var warnings = [];
    if (focus < 60) warnings.push("The photo looks blurry or out of focus — text recognition will be unreliable. A sharper photo or a screenshot will read much better.");
    if (spread < 60) warnings.push("Very low contrast — the document is hard to separate from its background.");
    if (Math.min(w, h) < 700) warnings.push("Low resolution (" + w + "×" + h + ") — small print may not be readable.");

    return {
      focus: Math.round(focus),
      contrastSpread: spread,
      width: w, height: h,
      warnings: warnings,
      usable: warnings.length === 0 || focus >= 25
    };
  };

  /* Otsu's method: find the threshold that best separates the histogram into
     two classes, then report the distance between their means. Returns 0 when
     the image is a single flat tone. */
  function otsuSeparation(hist, total) {
    if (!total) return 0;
    var sum = 0, i;
    for (i = 0; i < 256; i++) sum += i * hist[i];

    var sumB = 0, wB = 0, best = -1, bestT = 0;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; bestT = i; }
    }

    // Means of the two classes either side of the chosen threshold.
    var dSum = 0, dN = 0, lSum = 0, lN = 0;
    for (i = 0; i <= bestT; i++) { dSum += i * hist[i]; dN += hist[i]; }
    for (i = bestT + 1; i < 256; i++) { lSum += i * hist[i]; lN += hist[i]; }
    if (!dN || !lN) return 0;
    return Math.round((lSum / lN) - (dSum / dN));
  }

  /* ---------- skew detection ----------
     Estimates the dominant text angle by projecting row-darkness at a range
     of candidate angles and keeping the angle whose profile varies most —
     text lines line up only when the page is straight. Deliberately limited
     to +/- 8 degrees: beyond that this measure stops being trustworthy, and
     a wrong rotation is worse than none. */
  I.detectSkew = function (canvas) {
    var maxDim = 800;
    var scale = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
    var w = Math.max(1, Math.round(canvas.width * scale));
    var h = Math.max(1, Math.round(canvas.height * scale));
    var small = document.createElement("canvas");
    small.width = w; small.height = h;
    var sctx = small.getContext("2d", { willReadFrequently: true });
    sctx.drawImage(canvas, 0, 0, w, h);
    var d = sctx.getImageData(0, 0, w, h).data;

    var dark = new Uint8Array(w * h);
    var sum = 0;
    for (var i = 0, p = 0; i < d.length; i += 4, p++) {
      var g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      sum += g;
    }
    var mean = sum / (w * h);
    for (var i2 = 0, p2 = 0; i2 < d.length; i2 += 4, p2++) {
      var g2 = 0.299 * d[i2] + 0.587 * d[i2 + 1] + 0.114 * d[i2 + 2];
      dark[p2] = g2 < mean * 0.75 ? 1 : 0;
    }

    var best = { angle: 0, score: -1 };
    for (var deg = -8; deg <= 8; deg += 0.5) {
      var rad = deg * Math.PI / 180, tan = Math.tan(rad);
      var rows = new Uint32Array(h);
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x += 2) {
          var yy = y + ((x - w / 2) * tan) | 0;
          if (yy >= 0 && yy < h && dark[yy * w + x]) rows[y]++;
        }
      }
      var m = 0, k;
      for (k = 0; k < h; k++) m += rows[k];
      m /= h;
      var variance = 0;
      for (k = 0; k < h; k++) { var dv = rows[k] - m; variance += dv * dv; }
      if (variance > best.score) best = { angle: deg, score: variance };
    }

    // Below half a degree the estimate is noise, so it is reported as "no
    // skew" and the image is left untouched.
    return {
      angle: Math.abs(best.angle) < 0.75 ? 0 : best.angle,
      confident: Math.abs(best.angle) >= 0.75 && best.score > 0,
      score: best.score
    };
  };

  I.rotate = function (canvas, degrees) {
    if (!degrees) return canvas;
    var rad = -degrees * Math.PI / 180;
    var out = document.createElement("canvas");
    out.width = canvas.width; out.height = canvas.height;
    var ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return out;
  };

  /* ---------- contrast / readability ----------
     Grayscale plus a percentile stretch. Adaptive thresholding was tried and
     rejected: Tesseract does its own binarisation and does it better, and a
     hard threshold destroys faint print that it would otherwise recover. */
  I.enhance = function (canvas) {
    var w = canvas.width, h = canvas.height;
    var out = document.createElement("canvas");
    out.width = w; out.height = h;
    var ctx = out.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0);
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;

    var hist = new Uint32Array(256), i;
    for (i = 0; i < d.length; i += 4) {
      hist[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++;
    }
    // 0.1%, not 1%: text covers only a sliver of a page, and a 1% floor
    // clips the ink away entirely, leaving the stretch a no-op.
    var total = w * h, acc = 0, lo = 0, hi = 255;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.001) { lo = i; break; } }
    acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.001) { hi = i; break; } }
    if (hi - lo < 10) { hi = 255; lo = 0; } // already flat; leave it alone

    var range = hi - lo;
    for (i = 0; i < d.length; i += 4) {
      var g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      var v = ((g - lo) / range) * 255;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return out;
  };

  // Upscale small images: Tesseract wants roughly 300 DPI equivalent and
  // reads a small photo much better when it is enlarged first.
  I.upscaleIfSmall = function (canvas, minSide) {
    minSide = minSide || 1100;
    var m = Math.min(canvas.width, canvas.height);
    if (m >= minSide) return canvas;
    var f = Math.min(3, minSide / m);
    var out = document.createElement("canvas");
    out.width = Math.round(canvas.width * f);
    out.height = Math.round(canvas.height * f);
    var ctx = out.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return out;
  };

  /* ---------- full pipeline for one photo ----------
     Returns the processed canvas plus a written record of what was and was
     not done, which the review screen shows verbatim. */
  I.prepare = function (file) {
    var steps = [], warnings = [];
    var orientation = 1;

    return file.arrayBuffer().then(function (ab) {
      orientation = I.readExifOrientation(ab);
      return createImageBitmap(new Blob([ab], { type: file.type || "image/jpeg" }));
    }).then(function (bitmap) {
      var canvas = I.applyOrientation(bitmap, orientation);
      try { bitmap.close(); } catch (e) {}
      steps.push(orientation === 1
        ? "No EXIF rotation needed"
        : "Applied EXIF orientation " + orientation + " so the page is upright");

      var quality = I.assess(canvas);
      quality.warnings.forEach(function (w) { warnings.push(w); });
      steps.push("Quality check: focus " + quality.focus + ", contrast spread " + quality.contrastSpread +
        " (" + quality.width + "×" + quality.height + ")");

      var skew = I.detectSkew(canvas);
      if (skew.confident) {
        canvas = I.rotate(canvas, skew.angle);
        steps.push("Deskewed by " + skew.angle.toFixed(1) + "°");
      } else {
        steps.push("No reliable skew detected — left unrotated rather than guessing");
      }

      canvas = I.upscaleIfSmall(canvas);
      if (canvas.width !== quality.width) steps.push("Upscaled to " + canvas.width + "×" + canvas.height + " for text recognition");

      canvas = I.enhance(canvas);
      steps.push("Converted to grayscale with a contrast stretch");

      return { canvas: canvas, steps: steps, warnings: warnings, quality: quality, orientation: orientation };
    });
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.image = I;
  if (typeof module !== "undefined" && module.exports) module.exports = I;
})(typeof globalThis !== "undefined" ? globalThis : this);
