/* ============================================================
   DOCAI · link-html — read a retrieved page without ever running it.

   Three hard rules:
     1. Retrieved HTML is never assigned to innerHTML, never inserted into
        the document, and never evaluated. It is only ever read as text.
     2. Parsing uses DOMParser, which builds an inert document: scripts do
        not run, and no subresource (image, stylesheet, iframe) is fetched.
        Where DOMParser is unavailable the string fallback strips tags.
     3. Anything derived from the page is treated as hostile text — every
        display path escapes it.

   Structured data is read from the string rather than the DOM so the same
   code runs under Node for testing and in the browser for real.
   ============================================================ */
(function (root) {
  "use strict";

  var U = (root.DOCAI && root.DOCAI.util) ||
    (typeof require === "function" ? require("./util.js") : null);

  var H = {};

  H.MAX_TEXT = 400000;      // characters of visible text kept
  H.MAX_JSONLD = 200000;    // characters of a single JSON-LD block parsed
  H.MAX_JSONLD_BLOCKS = 20;

  /* ---------- prototype-pollution-safe JSON ----------
     A page controls its own JSON-LD. Parsing it straight into an object
     graph that is later merged or walked is exactly how __proto__ payloads
     get in, so the reviver drops those keys outright. */
  var FORBIDDEN_KEYS = { "__proto__": 1, "constructor": 1, "prototype": 1 };

  H.safeJsonParse = function (text) {
    if (typeof text !== "string") return null;
    if (text.length > H.MAX_JSONLD) return null;
    var parsed;
    try {
      parsed = JSON.parse(text, function (key, value) {
        if (Object.prototype.hasOwnProperty.call(FORBIDDEN_KEYS, key)) return undefined;
        return value;
      });
    } catch (e) { return null; }
    return sanitizeTree(parsed, 0);
  };

  // Rebuild with null-prototype objects and a depth cap, so nothing inherits
  // from Object.prototype and a deeply nested page cannot blow the stack.
  function sanitizeTree(node, depth) {
    if (depth > 12) return null;
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) {
      var arr = [];
      for (var i = 0; i < node.length && i < 500; i++) arr.push(sanitizeTree(node[i], depth + 1));
      return arr;
    }
    var out = Object.create(null);
    var keys = Object.keys(node);
    for (var k = 0; k < keys.length && k < 200; k++) {
      var key = keys[k];
      if (Object.prototype.hasOwnProperty.call(FORBIDDEN_KEYS, key)) continue;
      out[key] = sanitizeTree(node[key], depth + 1);
    }
    return out;
  }

  /* ---------- entity decoding ----------
     Only the named entities that actually appear in metadata, plus numeric
     forms. Done by table rather than by assigning to a DOM element, because
     that route is how "decode this string" turns into "parse this HTML". */
  var ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
    mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
    ldquo: "“", rdquo: "”", trade: "™", reg: "®", copy: "©", deg: "°", eacute: "é"
  };
  H.decodeEntities = function (s) {
    return String(s == null ? "" : s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, function (m, ent) {
      var e = ent.toLowerCase();
      if (e.charAt(0) === "#") {
        var code = e.charAt(1) === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!isFinite(code) || code < 9 || code > 0x10ffff) return "";
        // Never decode into characters that could re-open a tag.
        if (code === 60 || code === 62) return "";
        try { return String.fromCodePoint(code); } catch (err) { return ""; }
      }
      if (Object.prototype.hasOwnProperty.call(ENTITIES, e)) {
        var v = ENTITIES[e];
        return (v === "<" || v === ">") ? "" : v;
      }
      return m;
    });
  };

  /* ---------- title, meta, canonical ---------- */
  H.readTitle = function (html) {
    var m = /<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(html);
    if (!m) return "";
    return H.clean(H.decodeEntities(stripTags(m[1]))).slice(0, 200);
  };

  // All <meta> tags as { name/property (lowercased) -> content }.
  H.readMeta = function (html) {
    var out = Object.create(null);
    var rx = /<meta\b([^>]*)>/gi, m;
    var count = 0;
    while ((m = rx.exec(html)) && count < 300) {
      count++;
      var attrs = readAttrs(m[1]);
      var key = attrs.property || attrs.name || attrs.itemprop || "";
      if (!key || !attrs.content) continue;
      key = key.toLowerCase().trim();
      if (Object.prototype.hasOwnProperty.call(FORBIDDEN_KEYS, key)) continue;
      if (!(key in out)) out[key] = H.clean(H.decodeEntities(attrs.content)).slice(0, 500);
    }
    return out;
  };

  H.readCanonical = function (html) {
    var rx = /<link\b([^>]*)>/gi, m;
    while ((m = rx.exec(html))) {
      var a = readAttrs(m[1]);
      if (a.rel && a.rel.toLowerCase().split(/\s+/).indexOf("canonical") >= 0 && a.href) {
        return H.decodeEntities(a.href).trim().slice(0, 500);
      }
    }
    return "";
  };

  function readAttrs(s) {
    var out = Object.create(null);
    var rx = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g, m;
    while ((m = rx.exec(s))) {
      var k = m[1].toLowerCase();
      if (Object.prototype.hasOwnProperty.call(FORBIDDEN_KEYS, k)) continue;
      out[k] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    }
    return out;
  }

  /* ---------- JSON-LD ---------- */
  H.readJsonLd = function (html) {
    var blocks = [];
    var rx = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi, m;
    var n = 0;
    while ((m = rx.exec(html)) && n < H.MAX_JSONLD_BLOCKS) {
      n++;
      var parsed = H.safeJsonParse(m[1].trim());
      if (parsed) blocks.push(parsed);
    }
    // Flatten @graph containers and arrays into a plain list of nodes.
    var nodes = [];
    function push(v, depth) {
      if (!v || typeof v !== "object" || depth > 6) return;
      if (Array.isArray(v)) { v.forEach(function (x) { push(x, depth + 1); }); return; }
      if (v["@graph"]) push(v["@graph"], depth + 1);
      if (v["@type"] || v.name || v.url) nodes.push(v);
    }
    blocks.forEach(function (b) { push(b, 0); });
    return nodes;
  };

  // Pick the JSON-LD node that describes the organisation behind the page.
  H.ORG_TYPES = ["Organization", "LocalBusiness", "Corporation", "LegalService", "Store",
    "ProfessionalService", "OnlineBusiness", "OnlineStore", "Restaurant", "NGO"];
  H.findOrganization = function (nodes) {
    var best = null, bestScore = -1;
    (nodes || []).forEach(function (n) {
      var types = typeArray(n["@type"]);
      var score = -1;
      types.forEach(function (t) {
        var i = H.ORG_TYPES.indexOf(t);
        if (i >= 0) score = Math.max(score, 100 - i);
        // A LocalBusiness subtype (e.g. "HardwareStore") still counts.
        else if (/business|store|shop|service|company|agency/i.test(t)) score = Math.max(score, 40);
      });
      if (score > bestScore) { bestScore = score; best = n; }
    });
    return bestScore >= 0 ? best : null;
  };
  function typeArray(t) {
    if (!t) return [];
    if (Array.isArray(t)) return t.filter(function (x) { return typeof x === "string"; });
    return typeof t === "string" ? [t] : [];
  }
  H.typeArray = typeArray;

  /* ---------- visible text ----------
     Structural noise is removed before the text is read. Cookie banners and
     nav bars are dropped by tag and by common class naming, which is a
     heuristic: it is applied where it helps and never relied upon. */
  var DROP_TAGS = ["script", "style", "noscript", "template", "svg", "canvas", "iframe",
    "nav", "header", "footer", "aside", "form", "button", "select"];
  var NOISE_PATTERN = /(^|[\s_-])(cookie|consent|gdpr|banner|nav|navbar|menu|breadcrumb|sidebar|advert|ads?|promo|popup|modal|newsletter|subscribe|skip-link|screen-reader|visually-hidden|sr-only)([\s_-]|$)/i;

  H.extractText = function (html) {
    // Preferred path: an inert DOMParser document. Scripts do not execute
    // and no subresources load.
    if (typeof root.DOMParser === "function") {
      try { return textFromDom(html); } catch (e) { /* fall through */ }
    }
    return textFromString(html);
  };

  function textFromDom(html) {
    var doc = new root.DOMParser().parseFromString(html, "text/html");
    if (!doc || !doc.body) return textFromString(html);

    DROP_TAGS.forEach(function (tag) {
      var els = doc.body.querySelectorAll ? doc.body.querySelectorAll(tag) : [];
      for (var i = els.length - 1; i >= 0; i--) {
        if (els[i].parentNode) els[i].parentNode.removeChild(els[i]);
      }
    });

    // Elements whose class or id marks them as chrome rather than content.
    var candidates = doc.body.querySelectorAll ? doc.body.querySelectorAll("[class],[id],[hidden],[aria-hidden]") : [];
    for (var j = candidates.length - 1; j >= 0; j--) {
      var el = candidates[j];
      if (!el.parentNode) continue;
      var hidden = el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true";
      var marker = (el.getAttribute("class") || "") + " " + (el.getAttribute("id") || "");
      if (hidden || NOISE_PATTERN.test(marker)) el.parentNode.removeChild(el);
    }

    // Block elements become line breaks so label/value pairs stay on their
    // own lines — the label-based extractors depend on that.
    var blocks = doc.body.querySelectorAll ? doc.body.querySelectorAll(
      "p,div,li,tr,br,h1,h2,h3,h4,h5,h6,dt,dd,section,article,address,td,th") : [];
    for (var k = 0; k < blocks.length; k++) {
      if (blocks[k].parentNode) blocks[k].insertAdjacentText ?
        blocks[k].insertAdjacentText("beforebegin", "\n") : null;
    }

    var text = doc.body.textContent || "";
    return H.clean(text).slice(0, H.MAX_TEXT);
  }

  function textFromString(html) {
    var s = String(html || "");
    // Drop <head> wholesale — the DOM path reads body.textContent and never
    // sees it, so the fallback should not either. Title and meta are read
    // from the original string by their own functions.
    s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/i, " ");
    DROP_TAGS.forEach(function (tag) {
      s = s.replace(new RegExp("<" + tag + "\\b[^>]*>[\\s\\S]*?<\\/" + tag + "\\s*>", "gi"), " ");
      s = s.replace(new RegExp("<" + tag + "\\b[^>]*\\/?>", "gi"), " ");
    });
    s = s.replace(/<!--[\s\S]*?-->/g, " ");
    // Block-level tags become newlines before everything else is stripped.
    s = s.replace(/<\/?(p|div|li|tr|br|h[1-6]|dt|dd|section|article|address|td|th)\b[^>]*>/gi, "\n");
    s = stripTags(s);
    return H.clean(H.decodeEntities(s)).slice(0, H.MAX_TEXT);
  }

  function stripTags(s) { return String(s || "").replace(/<[^>]*>/g, " "); }
  H.stripTags = stripTags;

  H.clean = function (s) {
    return String(s == null ? "" : s)
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t ]+/g, " ")
      .replace(/ *\n[ \n]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  };

  /* ---------- one call ----------
     Everything the pipeline needs from a page, as inert data. */
  H.parse = function (html, sourceUrl) {
    var safeHtml = String(html || "");
    var jsonld = H.readJsonLd(safeHtml);
    return {
      title: H.readTitle(safeHtml),
      meta: H.readMeta(safeHtml),
      canonical: H.readCanonical(safeHtml),
      jsonld: jsonld,
      organization: H.findOrganization(jsonld),
      text: H.extractText(safeHtml),
      sourceUrl: sourceUrl || "",
      byteLength: safeHtml.length
    };
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.linkHtml = H;
  if (typeof module !== "undefined" && module.exports) module.exports = H;
})(typeof globalThis !== "undefined" ? globalThis : this);
