/* ============================================================
   DOCAI · link-store — saved web sources.

   A link record is small, safe metadata: address, title, classification,
   what it evidenced, and short excerpts. The page itself is never stored in
   application state.

   Where the extracted page text is worth keeping, it goes to the existing
   IndexedDB text store — outside `_state`, so it is not written into
   localStorage, not serialized into an export, and not pushed to Firebase
   cloud sync. That boundary is the whole reason this module is separate
   from the record it creates.

   Records live in `_state.docs[biz].web`, a new array. `docs[biz].links`
   (the hand-added bookmarks) is left exactly as it was.
   ============================================================ */
(function (root) {
  "use strict";

  var U = (root.DOCAI && root.DOCAI.util) || (typeof require === "function" ? require("./util.js") : null);
  var LU = (root.DOCAI && root.DOCAI.linkUrl) || (typeof require === "function" ? require("./link-url.js") : null);
  var STORE = (root.DOCAI && root.DOCAI.store) || (typeof require === "function" ? require("./store.js") : null);

  var S = {};

  S.MAX_EXCERPT = 300;
  S.MAX_EVIDENCE = 12;

  S.list = function (state, biz) {
    var d = state && state.docs && state.docs[biz];
    return (d && d.web) || [];
  };

  S.ensure = function (state, biz) {
    state.docs[biz] = state.docs[biz] || { files: [], links: [], dnb: [], scan: { files: [] } };
    if (!state.docs[biz].web) state.docs[biz].web = [];
    return state.docs[biz].web;
  };

  /* ---------- build a record ----------
     Every field here is either something the user typed, something the page
     published about itself, or a short excerpt. No page body, no HTML. */
  S.buildRecord = function (input) {
    return {
      id: input.id || U.uid("web"),
      docaiWeb: true,
      schema: 1,

      biz: input.biz,                       // exactly one, always confirmed

      url: input.url,                       // as entered, after normalization
      normalizedUrl: input.normalizedUrl,   // comparison key
      finalUrl: input.finalUrl || "",       // after redirects, when known
      canonicalUrl: input.canonicalUrl || "",
      domain: input.domain || "",
      title: (input.title || "").slice(0, 200),

      siteType: input.siteType || "unclassified_web",
      siteTypeLabel: input.siteTypeLabel || "Unclassified / Needs Review",
      category: input.category || "unfiled",
      subcategory: input.subcategory || "",
      issuer: (input.issuer || "").slice(0, 120),

      retrievedAt: input.retrievedAt || Date.now(),
      lastCheckedAt: input.lastCheckedAt || input.retrievedAt || Date.now(),
      savedAt: Date.now(),

      retrievalStatus: input.retrievalStatus || "not-retrieved",  // retrieved | blocked | error | pasted | not-retrieved
      retrievalNote: (input.retrievalNote || "").slice(0, 300),
      httpStatus: input.httpStatus || 0,
      redirected: !!input.redirected,
      contentHash: input.contentHash || "",   // only when content was actually read

      linkedFields: input.linkedFields || [],
      linkedCheckpoints: input.linkedCheckpoints || [],
      reviewStatus: input.reviewStatus || "reviewed",

      // Short, masked, display-safe provenance for what was taken from here.
      evidence: (input.evidence || []).slice(0, S.MAX_EVIDENCE).map(function (e) {
        return {
          dest: e.dest,
          label: e.label,
          value: e.masked || e.value,
          where: e.where || "",
          source: e.source || "",
          excerpt: String(e.excerpt || "").slice(0, S.MAX_EXCERPT),
          confidence: e.confidence || "",
          manuallyApproved: !!e.manuallyApproved,
          validationWarnings: (e.validationWarnings || []).slice(0, 10)
        };
      }),
      businessEvidence: (input.businessEvidence || []).map(function (e) {
        return { kind: e.kind, matched: e.matched };
      }),

      textRef: input.textRef || null,        // key into the IndexedDB text store
      notes: (input.notes || "").slice(0, 1000),

      history: input.history || []           // recheck results, newest first
    };
  };

  /* ---------- duplicates ---------- */
  S.findExact = function (state, normalizedUrl) {
    var hits = [];
    ["centauri", "keypr"].forEach(function (biz) {
      S.list(state, biz).forEach(function (r) {
        if (r.normalizedUrl && r.normalizedUrl === normalizedUrl) hits.push({ biz: biz, record: r });
      });
    });
    return hits;
  };

  /* A likely duplicate is the same page reached by a different address —
     a canonical URL pointing at an already-saved page, the same content
     hash, or the same title on the same domain. Reported, never acted on. */
  S.findLikely = function (state, meta) {
    var hits = [];
    ["centauri", "keypr"].forEach(function (biz) {
      S.list(state, biz).forEach(function (r) {
        if (meta.normalizedUrl && r.normalizedUrl === meta.normalizedUrl) return; // exact, handled above
        var reasons = [];

        var candidates = [meta.normalizedUrl, meta.finalUrl, meta.canonicalUrl].filter(Boolean);
        var stored = [r.normalizedUrl, r.finalUrl, r.canonicalUrl].filter(Boolean);
        var crossed = candidates.some(function (a) {
          return stored.some(function (b) { return sameUrl(a, b); });
        });
        if (crossed) reasons.push("resolves to the same page after redirects or canonical URL");

        if (meta.contentHash && r.contentHash && meta.contentHash === r.contentHash) {
          reasons.push("identical page content");
        }
        if (meta.domain && r.domain && meta.domain === r.domain) {
          if (meta.title && r.title && meta.title.toLowerCase() === r.title.toLowerCase()) {
            reasons.push("same domain and same page title");
          }
          if (meta.siteType && r.siteType && meta.siteType === r.siteType &&
              meta.siteType !== "unclassified_web" && reasons.length) {
            reasons.push("same page type (" + r.siteTypeLabel + ")");
          }
        }
        if (reasons.length) hits.push({ biz: biz, record: r, reasons: reasons });
      });
    });
    return hits;
  };

  function sameUrl(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    var na = LU.normalize(a), nb = LU.normalize(b);
    return na.ok && nb.ok && na.normalized === nb.normalized;
  }

  /* ---------- content hash ----------
     Hashes what the extractors actually read, not the raw HTML: ad rotations
     and CSRF tokens change the HTML on every load, so hashing that would make
     every recheck look like a change.

     It covers the title, the visible text AND the structured data. Text alone
     is not enough — JSON-LD lives inside a <script> block that text
     extraction strips, so a business quietly changing its published NAICS
     code or address would have gone undetected. */
  S.hashPage = function (page) {
    page = page || {};
    var parts = [
      "title:" + String(page.title || ""),
      "org:" + stableStringify(page.organization),
      "text:" + String(page.text || "")
    ];
    return S.hashContent(parts.join("\n\u0000"));
  };

  // Key-sorted, so a site reordering its JSON-LD is not read as a change.
  function stableStringify(v, depth) {
    depth = depth || 0;
    if (v === null || typeof v !== "object" || depth > 8) return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) {
      return "[" + v.slice(0, 100).map(function (x) { return stableStringify(x, depth + 1); }).join(",") + "]";
    }
    var keys = Object.keys(v).sort();
    return "{" + keys.map(function (k) {
      return JSON.stringify(k) + ":" + stableStringify(v[k], depth + 1);
    }).join(",") + "}";
  }

  S.hashContent = function (text) {
    var t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return Promise.resolve("");
    var bytes;
    if (typeof TextEncoder === "function") bytes = new TextEncoder().encode(t);
    else {
      bytes = new Uint8Array(t.length);
      for (var i = 0; i < t.length; i++) bytes[i] = t.charCodeAt(i) & 255;
    }
    return U.sha256(bytes);
  };

  /* ---------- extracted text, kept out of state ---------- */
  S.putText = function (id, text, url) {
    if (!STORE || !text) return Promise.resolve(null);
    return STORE.putText("web-" + id, [{ page: 1, text: String(text).slice(0, 400000), source: "web:" + url }])
      .then(function () { return "web-" + id; })
      .catch(function () { return null; });
  };
  S.getText = function (textRef) {
    if (!STORE || !textRef) return Promise.resolve(null);
    return STORE.getText(textRef).then(function (pages) {
      return pages && pages[0] ? pages[0].text : null;
    }).catch(function () { return null; });
  };
  S.deleteText = function (textRef) {
    if (!STORE || !textRef) return Promise.resolve();
    return STORE.deleteText(textRef).catch(function () {});
  };

  /* ---------- recheck bookkeeping ---------- */
  S.recordCheck = function (record, outcome) {
    record.lastCheckedAt = outcome.at || Date.now();
    record.retrievalStatus = outcome.status;
    record.retrievalNote = String(outcome.note || "").slice(0, 300);
    if (outcome.httpStatus) record.httpStatus = outcome.httpStatus;
    if (outcome.finalUrl) record.finalUrl = outcome.finalUrl;
    record.history = record.history || [];
    record.history.unshift({
      at: record.lastCheckedAt,
      status: outcome.status,
      note: record.retrievalNote,
      changed: !!outcome.changed
    });
    if (record.history.length > 10) record.history.length = 10;
    if (outcome.contentHash) record.contentHash = outcome.contentHash;
    return record;
  };

  /* Fields that would lose their supporting source if this link went away.
     Used to warn before removing, never to block it. */
  S.dependentFields = function (record) {
    return (record && record.linkedFields) || [];
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.linkStore = S;
  if (typeof module !== "undefined" && module.exports) module.exports = S;
})(typeof globalThis !== "undefined" ? globalThis : this);
