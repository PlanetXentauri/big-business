/* ============================================================
   DOCAI · link-fetch — read-only page retrieval, with honest failure.

   What a static page can actually do, stated plainly: a browser will only
   let this read a cross-origin response when the target site sends an
   Access-Control-Allow-Origin header. Most sites do not. There is no way
   around that from a static site without a server or a third-party proxy,
   and routing the user's pages through someone else's proxy is not a
   trade this makes.

   `no-cors` is deliberately NOT used. It returns an opaque response whose
   body cannot be read, so it could only ever produce the illusion of a
   successful fetch. A blocked page is reported as blocked.

   Nothing is ever uploaded. This module only issues GET requests to the
   address the user typed, and reads the reply.
   ============================================================ */
(function (root) {
  "use strict";

  var LU = (root.DOCAI && root.DOCAI.linkUrl) ||
    (typeof require === "function" ? require("./link-url.js") : null);

  var F = {};

  F.TIMEOUT_MS = 15000;
  F.MAX_BYTES = 3 * 1024 * 1024;    // 3 MB of HTML is already an enormous page

  /* Result shape — always the same, success or failure:
       { ok, status, finalUrl, redirected, html, bytes, truncated,
         retrievedAt, reason, detail, blocked, fallbacks[] }               */
  function result(extra) {
    var base = {
      ok: false, status: 0, finalUrl: "", redirected: false, html: "",
      bytes: 0, truncated: false, retrievedAt: Date.now(),
      reason: "", detail: "", blocked: false, fallbacks: []
    };
    Object.keys(extra || {}).forEach(function (k) { base[k] = extra[k]; });
    return base;
  }

  // What the user can do instead when retrieval fails. Offered rather than
  // implied, so a blocked page is still a usable starting point.
  F.FALLBACKS = [
    { id: "open", label: "Open the page in a new tab", detail: "Look at it yourself and copy what you need." },
    { id: "paste", label: "Paste the visible page text", detail: "Select the page, copy, and paste it here — it runs through the same extraction." },
    { id: "upload", label: "Save the page as PDF or take a screenshot", detail: "Then use Autofill from PDF or Photo, which never needs network access." },
    { id: "saveonly", label: "Save the link without extracting", detail: "Keeps it filed under this business as a web source." }
  ];

  F.available = function () {
    return typeof root.fetch === "function" && typeof root.AbortController === "function";
  };

  /* ---------- retrieve ---------- */
  F.retrieve = function (url, opts) {
    opts = opts || {};
    var onStatus = opts.onStatus || function () {};

    var norm = LU.normalize(url);
    if (!norm.ok) {
      return Promise.resolve(result({
        reason: norm.reason, detail: norm.detail, fallbacks: []
      }));
    }

    if (!F.available()) {
      return Promise.resolve(result({
        finalUrl: norm.url, blocked: true,
        reason: "This browser cannot fetch pages in the background.",
        detail: "fetch() or AbortController is unavailable.",
        fallbacks: F.FALLBACKS
      }));
    }

    var controller = new root.AbortController();
    var timedOut = false;
    var timer = root.setTimeout(function () { timedOut = true; controller.abort(); },
      opts.timeoutMs || F.TIMEOUT_MS);

    onStatus("Requesting " + LU.display(norm.url, 50) + "…");

    // credentials:"omit" — never send this browser's cookies to a third party.
    // redirect:"follow" — the browser caps the chain itself (20) and reports
    // the final URL; "manual" would yield an opaque response we cannot read.
    return root.fetch(norm.url, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: controller.signal
    }).then(function (res) {
      root.clearTimeout(timer);

      var finalUrl = res.url || norm.url;
      var redirected = !!res.redirected || (finalUrl && finalUrl !== norm.url);

      if (!res.ok) {
        return result({
          status: res.status, finalUrl: finalUrl, redirected: redirected,
          reason: "The site answered with " + res.status + " " + (res.statusText || "") + ".",
          detail: res.status === 404 ? "The page may have moved or been removed."
            : res.status === 403 ? "The site refused the request — this is common for pages behind bot protection."
            : res.status >= 500 ? "The site is having trouble on its end."
            : "",
          fallbacks: F.FALLBACKS
        });
      }

      var ctype = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
      if (ctype && !/text\/html|application\/xhtml|text\/plain|application\/xml|text\/xml/i.test(ctype)) {
        return result({
          status: res.status, finalUrl: finalUrl, redirected: redirected,
          reason: "That address is not a web page (" + ctype.split(";")[0] + ").",
          detail: /pdf/i.test(ctype)
            ? "It looks like a PDF — download it and use Autofill from PDF, which reads it properly."
            : "Only HTML pages can be analysed here.",
          fallbacks: F.FALLBACKS
        });
      }

      var declared = res.headers && res.headers.get && parseInt(res.headers.get("content-length") || "0", 10);
      if (declared && declared > F.MAX_BYTES) {
        return result({
          status: res.status, finalUrl: finalUrl, redirected: redirected,
          reason: "That page is " + Math.round(declared / 1048576) + " MB, larger than the " +
            Math.round(F.MAX_BYTES / 1048576) + " MB limit.",
          detail: "The limit exists so a huge page cannot freeze the dashboard.",
          fallbacks: F.FALLBACKS
        });
      }

      onStatus("Reading the page…");
      return readCapped(res, onStatus).then(function (read) {
        return result({
          ok: true, status: res.status, finalUrl: finalUrl, redirected: redirected,
          html: read.text, bytes: read.bytes, truncated: read.truncated
        });
      });
    }).catch(function (e) {
      root.clearTimeout(timer);

      if (timedOut || (e && e.name === "AbortError")) {
        return result({
          finalUrl: norm.url,
          reason: "The page took longer than " + Math.round((opts.timeoutMs || F.TIMEOUT_MS) / 1000) +
            " seconds to respond, so the request was stopped.",
          detail: "The site may be slow, or may be refusing to answer.",
          fallbacks: F.FALLBACKS
        });
      }

      // A cross-origin block surfaces as an opaque TypeError with no detail.
      // This is by far the most common outcome, so it gets a real explanation
      // rather than the browser's bare message.
      return result({
        finalUrl: norm.url, blocked: true,
        reason: "This page cannot be read directly from the dashboard.",
        detail: "Browsers only allow a page to read another site when that site explicitly permits it " +
          "(a CORS header). Most sites do not, and many also sit behind login walls or bot protection. " +
          "Nothing was retrieved and nothing was sent anywhere.",
        fallbacks: F.FALLBACKS
      });
    });
  };

  /* Read the body in chunks and stop at the cap, so an unbounded or
     deliberately huge response cannot exhaust memory. */
  function readCapped(res, onStatus) {
    if (!res.body || typeof res.body.getReader !== "function") {
      // No streaming support: fall back to text() and trim after the fact.
      return res.text().then(function (t) {
        var truncated = t.length > F.MAX_BYTES;
        return { text: truncated ? t.slice(0, F.MAX_BYTES) : t, bytes: t.length, truncated: truncated };
      });
    }
    var reader = res.body.getReader();
    var chunks = [], total = 0, truncated = false;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        total += r.value.length;
        if (total > F.MAX_BYTES) {
          truncated = true;
          chunks.push(r.value.slice(0, Math.max(0, r.value.length - (total - F.MAX_BYTES))));
          try { reader.cancel(); } catch (e) {}
          return;
        }
        chunks.push(r.value);
        if (chunks.length % 20 === 0) onStatus("Reading the page… " + Math.round(total / 1024) + " KB");
        return pump();
      });
    }
    return pump().then(function () {
      var merged = new Uint8Array(Math.min(total, F.MAX_BYTES));
      var at = 0;
      chunks.forEach(function (c) {
        if (at + c.length <= merged.length) { merged.set(c, at); at += c.length; }
      });
      var text = new TextDecoder("utf-8", { fatal: false }).decode(merged);
      return { text: text, bytes: total, truncated: truncated };
    });
  }

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.linkFetch = F;
  if (typeof module !== "undefined" && module.exports) module.exports = F;
})(typeof globalThis !== "undefined" ? globalThis : this);
