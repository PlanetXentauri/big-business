/* ============================================================
   DOCAI · browser-helper bridge

   Receives a page capture from the optional Big Business browser extension,
   validates and caps it, and converts it to inert HTML for the existing link
   pipeline. The helper can start a review; it can never save data.
   ============================================================ */
(function (root) {
  "use strict";

  var D = root.DOCAI || {};
  var LU = D.linkUrl;
  var LH = D.linkHtml;
  var B = {};

  B.CHANNEL = "big-business-browser-helper-v1";
  B.MAX_TEXT = 500000;
  B.MAX_TITLE = 300;
  B.MAX_META_VALUE = 1000;
  B.MAX_JSONLD_TOTAL = 250000;
  B.MAX_JSONLD_BLOCKS = 20;

  function text(v, max) {
    return String(v == null ? "" : v).replace(/\u0000/g, "").slice(0, max);
  }

  function escapeHtml(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  B.validate = function (payload) {
    if (!payload || typeof payload !== "object" || payload.kind !== "page-capture") {
      return { ok: false, reason: "The browser helper sent an unrecognized message." };
    }
    if (!LU || !LH) return { ok: false, reason: "The link engine is not ready." };

    var norm = LU.normalize(text(payload.url, 8192));
    if (!norm.ok) return { ok: false, reason: norm.reason + (norm.detail ? " " + norm.detail : "") };

    var capture = {
      kind: "page-capture",
      version: 1,
      url: norm.url,
      title: text(payload.title, B.MAX_TITLE),
      text: text(payload.text, B.MAX_TEXT),
      canonical: "",
      meta: Object.create(null),
      jsonld: [],
      capturedAt: Number(payload.capturedAt) || Date.now(),
      truncated: !!payload.truncated
    };

    if (payload.canonical) {
      var canonical = LU.normalize(text(payload.canonical, 2048));
      if (canonical.ok) capture.canonical = canonical.url;
    }

    var allowedMeta = /^(description|application-name|author|og:[a-z0-9:_-]+|twitter:[a-z0-9:_-]+)$/i;
    if (payload.meta && typeof payload.meta === "object") {
      Object.keys(payload.meta).slice(0, 50).forEach(function (key) {
        if (!allowedMeta.test(key)) return;
        capture.meta[key.toLowerCase()] = text(payload.meta[key], B.MAX_META_VALUE);
      });
    }

    var total = 0;
    (Array.isArray(payload.jsonld) ? payload.jsonld : []).slice(0, B.MAX_JSONLD_BLOCKS).forEach(function (raw) {
      raw = text(raw, LH.MAX_JSONLD || 200000);
      if (!raw || total + raw.length > B.MAX_JSONLD_TOTAL) return;
      // Parse now so malformed data, deep trees and prototype keys never
      // cross into the dashboard's extraction path.
      var parsed = LH.safeJsonParse(raw);
      if (!parsed) return;
      var safe = JSON.stringify(parsed).replace(/</g, "\\u003c");
      total += safe.length;
      capture.jsonld.push(safe);
    });

    if (!capture.text.trim() && !capture.jsonld.length) {
      return { ok: false, reason: "The helper could not find visible text or structured data on this page." };
    }
    return { ok: true, capture: capture };
  };

  B.toInertHtml = function (capture) {
    var out = "<!doctype html><html><head><meta charset=\"utf-8\">";
    if (capture.title) out += "<title>" + escapeHtml(capture.title) + "</title>";
    if (capture.canonical) out += "<link rel=\"canonical\" href=\"" + escapeHtml(capture.canonical) + "\">";
    Object.keys(capture.meta || {}).forEach(function (key) {
      out += "<meta property=\"" + escapeHtml(key) + "\" content=\"" + escapeHtml(capture.meta[key]) + "\">";
    });
    (capture.jsonld || []).forEach(function (safeJson) {
      out += "<script type=\"application/ld+json\">" + safeJson + "</script>";
    });
    // A pre element preserves useful label/value line breaks. The content is
    // escaped, so source-page markup and handlers can never enter the app.
    out += "</head><body><pre>" + escapeHtml(capture.text) + "</pre></body></html>";
    return out;
  };

  B.install = function (handler) {
    if (!root.addEventListener || typeof handler !== "function") return function () {};
    function receive(event) {
      if (event.source !== root || event.origin !== root.location.origin) return;
      var msg = event.data;
      if (!msg || msg.channel !== B.CHANNEL || msg.type !== "IMPORT_CAPTURE") return;
      var checked = B.validate(msg.payload);
      if (!checked.ok) {
        handler(null, checked.reason);
        return;
      }
      handler(checked.capture, null);
    }
    root.addEventListener("message", receive);
    return function () { root.removeEventListener("message", receive); };
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.browserHelper = B;
  if (typeof module !== "undefined" && module.exports) module.exports = B;
})(typeof globalThis !== "undefined" ? globalThis : this);
