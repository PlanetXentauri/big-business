/* ============================================================
   DOCAI · util — hashing, masking, small shared helpers.
   Classic script (no modules) so file:// and GitHub Pages both work.
   Nothing here touches the network.
   ============================================================ */
(function (root) {
  "use strict";

  var U = {};

  /* ---------- ids ---------- */
  U.uid = function (p) {
    return p + "-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
  };

  /* ---------- SHA-256 ----------
     Uses WebCrypto when available (https / localhost, and Node).
     Falls back to a compact pure-JS implementation for file://, where
     crypto.subtle is absent — duplicate detection must never silently die. */
  function toHex(buf) {
    var b = new Uint8Array(buf), s = "", i;
    for (i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];

  function sha256Bytes(bytes) {
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = bytes.length, withOne = l + 1, padded = withOne + ((56 - withOne % 64) + 64) % 64;
    var total = padded + 8, m = new Uint8Array(total);
    m.set(bytes); m[l] = 0x80;
    var bitLen = l * 8;
    var hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
    m[total - 8] = (hi >>> 24) & 255; m[total - 7] = (hi >>> 16) & 255;
    m[total - 6] = (hi >>> 8) & 255; m[total - 5] = hi & 255;
    m[total - 4] = (lo >>> 24) & 255; m[total - 3] = (lo >>> 16) & 255;
    m[total - 2] = (lo >>> 8) & 255; m[total - 1] = lo & 255;

    var w = new Uint32Array(64), i, j;
    for (i = 0; i < total; i += 64) {
      for (j = 0; j < 16; j++) {
        w[j] = (m[i + j * 4] << 24) | (m[i + j * 4 + 1] << 16) | (m[i + j * 4 + 2] << 8) | m[i + j * 4 + 3];
      }
      for (j = 16; j < 64; j++) {
        var g0 = w[j - 15], g1 = w[j - 2];
        var s0 = ((g0 >>> 7) | (g0 << 25)) ^ ((g0 >>> 18) | (g0 << 14)) ^ (g0 >>> 3);
        var s1 = ((g1 >>> 17) | (g1 << 15)) ^ ((g1 >>> 19) | (g1 << 13)) ^ (g1 >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (j = 0; j < 64; j++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[j] + w[j]) >>> 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var mj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + mj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) {
      out[i * 4] = (h[i] >>> 24) & 255; out[i * 4 + 1] = (h[i] >>> 16) & 255;
      out[i * 4 + 2] = (h[i] >>> 8) & 255; out[i * 4 + 3] = h[i] & 255;
    }
    return out;
  }

  U.sha256Sync = function (bytes) { return toHex(sha256Bytes(bytes)); };

  U.sha256 = function (bytes) {
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var subtle = (root.crypto && root.crypto.subtle) || null;
    if (subtle) {
      // pass the exact slice, never the whole backing buffer
      var ab = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
      return subtle.digest("SHA-256", ab).then(toHex).catch(function () { return U.sha256Sync(view); });
    }
    return Promise.resolve(U.sha256Sync(view));
  };

  U.hashFile = function (file) {
    return file.arrayBuffer().then(function (ab) { return U.sha256(new Uint8Array(ab)); });
  };

  /* ---------- masking ----------
     Sensitive values are stored intact but shown masked. Each masker keeps
     just enough tail to be recognisable and never reveals the middle. */
  U.maskAccount = function (v) {
    var s = String(v == null ? "" : v).replace(/\s+/g, "");
    if (!s) return "";
    if (s.length <= 4) return "····";
    return "····" + s.slice(-4);
  };
  U.maskRouting = function (v) {
    var s = U.digits(v);
    if (!s) return "";
    if (s.length !== 9) return "·".repeat(s.length);
    return "·····" + s.slice(-4);
  };
  U.maskEin = function (v) {
    var s = U.digits(v);
    if (!s) return "";
    if (s.length !== 9) return "··-·······";
    return "··-···" + s.slice(-4);
  };
  U.maskSsn = function (v) {
    var s = U.digits(v);
    if (!s) return "";
    if (s.length !== 9) return "···-··-····";
    return "···-··-" + s.slice(-4);
  };
  U.maskCard = function (v) {
    var s = U.digits(v);
    if (s.length < 4) return "";
    return "···· " + s.slice(-4);
  };
  function maskLongRuns(v) {
    return String(v == null ? "" : v).replace(/\d{5,}/g, function (m) {
      return "····" + m.slice(-4);
    });
  }

  // Destination fields sensitive enough to mask in ordinary views.
  U.SENSITIVE = {
    "fin.acctNumber": U.maskAccount,
    "fin.routingNumber": U.maskRouting,
    "fin.card1": maskLongRuns,
    "fin.card2": maskLongRuns,
    "fin.card3": maskLongRuns,
    "bp.acctRouting": maskLongRuns,
    "bp.ein": U.maskEin,
    "bp.ownerSsn": U.maskSsn,
    "bp.ownerDob": function (v) { return String(v || "").replace(/\d/g, "·"); },
    "bp.creditCards": maskLongRuns
  };
  /* Mask secrets anywhere in free text.
     Evidence excerpts are quoted straight out of the document, so an excerpt
     captured for an unrelated match — a legal name, a brand — can still have
     an EIN or an account number sitting next to it. Every excerpt goes
     through here before it is displayed or stored.
     Digit runs of 7+ are masked; formatted phone numbers top out at 4 digits
     in a row and are left readable. */
  U.maskSecrets = function (s) {
    return String(s == null ? "" : s)
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, function (m) { return "···-··-" + m.slice(-4); })
      .replace(/\b\d{2}-\d{7}\b/g, function (m) { return "··-···" + m.slice(-4); })
      .replace(/\b\d{2}-\d{3}-\d{4}\b/g, function (m) { return "··-···-" + m.slice(-4); })
      .replace(/\d{7,}/g, function (m) { return "····" + m.slice(-4); });
  };

  U.isSensitive = function (dest) { return Object.prototype.hasOwnProperty.call(U.SENSITIVE, dest); };
  U.maskFor = function (dest, value) {
    var fn = U.SENSITIVE[dest];
    return fn ? fn(value) : value;
  };

  /* ---------- text ---------- */
  U.esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  U.digits = function (s) { return String(s == null ? "" : s).replace(/\D/g, ""); };

  // Collapse for comparison: case, punctuation and entity suffixes folded away.
  U.foldName = function (s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[.,'"()]/g, "")
      .replace(/\b(l\s*l\s*c|llc|inc|incorporated|corp|corporation|company|co|ltd|limited liability company)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  U.foldAddress = function (s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[.,#]/g, " ")
      .replace(/\bstreet\b/g, "st").replace(/\bavenue\b/g, "ave").replace(/\bboulevard\b/g, "blvd")
      .replace(/\bdrive\b/g, "dr").replace(/\broad\b/g, "rd").replace(/\blane\b/g, "ln")
      .replace(/\bsuite\b/g, "ste").replace(/\bapartment\b/g, "apt")
      .replace(/\bnorth\b/g, "n").replace(/\bsouth\b/g, "s")
      .replace(/\beast\b/g, "e").replace(/\bwest\b/g, "w")
      .replace(/\s+/g, " ").trim();
  };

  // Short excerpt centred on a match, for evidence display.
  U.excerpt = function (text, index, len, radius) {
    radius = radius == null ? 60 : radius;
    var start = Math.max(0, index - radius);
    var end = Math.min(text.length, index + (len || 0) + radius);
    return (start > 0 ? "…" : "") +
      text.slice(start, end).replace(/\s+/g, " ").trim() +
      (end < text.length ? "…" : "");
  };

  /* ---------- object URL lifetime ----------
     Every URL handed out here is tracked and revoked, so previews never leak. */
  var liveUrls = [];
  U.objectUrl = function (blob) {
    var u = URL.createObjectURL(blob);
    liveUrls.push(u);
    return u;
  };
  U.revokeAll = function () {
    liveUrls.splice(0).forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.util = U;
  if (typeof module !== "undefined" && module.exports) module.exports = U;
})(typeof globalThis !== "undefined" ? globalThis : this);
