/* ============================================================
   DOCAI · link-url — URL validation, normalization and comparison.

   The gatekeeper for everything the link pipeline touches. Only http and
   https ever get through; javascript:, data:, file: and friends are refused
   by name so the reason can be shown rather than a generic "invalid URL".

   Normalization is deliberately conservative. Removing a query string or
   forcing a trailing slash can change which page you land on, so the only
   things stripped are the ones that provably do not: the fragment, common
   tracking parameters, and a default port.
   ============================================================ */
(function (root) {
  "use strict";

  var L = {};

  // Schemes that must never be fetched or turned into a clickable link.
  L.BLOCKED_SCHEMES = {
    "javascript:": "javascript: URLs run code — they are never opened or fetched here",
    "data:": "data: URLs embed their own content and can carry scripts",
    "file:": "file: URLs point at the local disk, not a website",
    "blob:": "blob: URLs reference in-memory data, not a website",
    "vbscript:": "vbscript: URLs run code",
    "about:": "about: URLs are browser-internal pages",
    "chrome:": "chrome: URLs are browser-internal pages",
    "ftp:": "ftp: is not a web page protocol",
    "mailto:": "mailto: opens an email client rather than a page",
    "tel:": "tel: dials a number rather than opening a page"
  };

  // Query parameters that only track the visitor. Dropping them makes two
  // links to the same page compare equal without changing the destination.
  L.TRACKING_PARAMS = [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
    "gclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "igshid", "ref_src", "_ga"
  ];

  function fail(reason, detail) {
    return { ok: false, reason: reason, detail: detail || "", url: "", normalized: "" };
  }

  /* ---------- validate + normalize ----------
     Returns { ok, url, normalized, host, domain, scheme, addedScheme, changes[] }
     `url` is what will actually be requested; `normalized` is the comparison
     key used for duplicate detection. They differ: `normalized` also folds
     case and drops tracking parameters. */
  L.normalize = function (input) {
    var raw = String(input == null ? "" : input).trim();
    if (!raw) return fail("Enter a website address first.");

    // Strip wrapping quotes or angle brackets people paste from emails.
    raw = raw.replace(/^[<"']+/, "").replace(/[>"']+$/, "");
    if (!raw) return fail("Enter a website address first.");

    // Reject blocked schemes before the URL parser normalizes them away.
    var lower = raw.toLowerCase().replace(/\s+/g, "");
    var blockedKeys = Object.keys(L.BLOCKED_SCHEMES);
    for (var i = 0; i < blockedKeys.length; i++) {
      if (lower.indexOf(blockedKeys[i]) === 0) {
        return fail("That is a " + blockedKeys[i] + " address, which cannot be opened or analysed here.",
          L.BLOCKED_SCHEMES[blockedKeys[i]]);
      }
    }
    // A scheme-relative URL (//example.com) inherits this page's scheme.
    var addedScheme = false;
    if (/^\/\//.test(raw)) { raw = "https:" + raw; addedScheme = true; }

    // No scheme at all: assume https, but only when it actually looks like a host.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      if (!/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:[\/?#]|$)/i.test(raw)) {
        return fail("That does not look like a website address.",
          "Expected something like example.com or https://example.com/page");
      }
      raw = "https://" + raw;
      addedScheme = true;
    }

    var u;
    try { u = new URL(raw); } catch (e) { return fail("That is not a valid web address.", raw.slice(0, 120)); }

    if (u.protocol !== "http:" && u.protocol !== "https:") {
      var why = L.BLOCKED_SCHEMES[u.protocol] || "Only http:// and https:// pages can be analysed.";
      return fail("“" + u.protocol + "” addresses are not supported.", why);
    }
    if (!u.hostname || u.hostname.indexOf(".") < 0) {
      // Single-label hosts (localhost, intranet names) are not public pages.
      if (u.hostname !== "localhost") return fail("That address has no valid domain name.", u.hostname);
    }
    if (/\s/.test(u.hostname)) return fail("That address has spaces in its domain name.");

    var changes = [];
    if (addedScheme) changes.push("Added https:// because no scheme was given");

    // --- the URL that will actually be requested
    var request = new URL(u.href);
    if (request.hash) { request.hash = ""; changes.push("Removed the #fragment, which the server never sees"); }
    if ((request.protocol === "https:" && request.port === "443") ||
        (request.protocol === "http:" && request.port === "80")) {
      request.port = "";
      changes.push("Removed the redundant default port");
    }

    // --- the comparison key
    var norm = new URL(request.href);
    norm.hostname = norm.hostname.toLowerCase().replace(/^www\./, "");
    norm.protocol = "https:";                    // http and https of one page are one page
    var dropped = [];
    L.TRACKING_PARAMS.forEach(function (p) {
      if (norm.searchParams.has(p)) { norm.searchParams.delete(p); dropped.push(p); }
    });
    if (dropped.length) changes.push("Ignored tracking parameter(s) when comparing: " + dropped.join(", "));
    // Sort remaining params so ?a=1&b=2 and ?b=2&a=1 compare equal.
    norm.searchParams.sort();
    var normStr = norm.href.replace(/\/$/, "");

    return {
      ok: true,
      url: request.href,
      normalized: normStr,
      host: request.hostname,
      domain: L.registrableDomain(request.hostname),
      scheme: request.protocol.replace(":", ""),
      addedScheme: addedScheme,
      changes: changes
    };
  };

  /* A rough registrable domain. This is not a public-suffix-list lookup —
     it keeps the last two labels, plus a third for the common two-part
     suffixes. Used only for grouping and as supporting match evidence, never
     as proof on its own, so an occasional miss is harmless. */
  var TWO_PART_SUFFIXES = ["co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "com.au", "co.nz", "com.br", "co.za", "com.mx"];
  L.registrableDomain = function (host) {
    var h = String(host || "").toLowerCase().replace(/^www\./, "");
    var parts = h.split(".");
    if (parts.length <= 2) return h;
    var lastTwo = parts.slice(-2).join(".");
    if (TWO_PART_SUFFIXES.indexOf(lastTwo) >= 0 && parts.length >= 3) return parts.slice(-3).join(".");
    return lastTwo;
  };

  /* Safe for an href. Anything that is not plain http/https becomes "#", so a
     stored record that somehow holds a hostile scheme cannot be clicked. */
  // Control characters smuggled into an address. Browsers strip some of
  // these before navigating, which is how "java<TAB>script:" style tricks
  // slip past a naive scheme check. Built with a RegExp constructor so no
  // raw control byte ever appears in this source file.
  var CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]");

  L.safeHref = function (url) {
    var s = String(url == null ? "" : url).trim();
    if (!/^https?:\/\//i.test(s)) return "#";
    if (CONTROL_CHARS.test(s)) return "#";
    return s;
  };

  L.sameNormalized = function (a, b) {
    var na = L.normalize(a), nb = L.normalize(b);
    return na.ok && nb.ok && na.normalized === nb.normalized;
  };

  // Short form for display: host plus a trimmed path.
  L.display = function (url, max) {
    max = max || 60;
    var s = String(url || "").replace(/^https?:\/\//i, "").replace(/\/$/, "");
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.linkUrl = L;
  if (typeof module !== "undefined" && module.exports) module.exports = L;
})(typeof globalThis !== "undefined" ? globalThis : this);
