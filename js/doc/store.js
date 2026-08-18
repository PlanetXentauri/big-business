/* ============================================================
   DOCAI · store — document metadata and blob storage.

   Blobs go to IndexedDB, never into localStorage as base64. That is what
   makes it possible to keep a 20 MB scanned PDF at all: the existing
   localStorage path silently degraded anything over 3 MB to "reference
   only", losing the file.

   Backward compatibility is deliberate and total:
     · legacy entries with a `dataUri` keep working, untouched and unread
     · nothing already in _state is rewritten, moved or deleted
     · export / import / cloud sync see exactly the state shape they saw before
   The one visible difference is that new blobs live outside _state, so they
   are no longer uploaded to Firebase when cloud sync is on.
   ============================================================ */
(function (root) {
  "use strict";

  var S = {};

  S.DB_NAME = "bigboss-docai";
  S.DB_VERSION = 1;
  S.BLOBS = "blobs";     // id -> { id, blob, type, name, size, ts }
  S.TEXT = "text";       // id -> { id, pages:[{page,text}] }  (extracted text)

  var dbPromise = null;

  S.db = function () {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (res, rej) {
      if (!root.indexedDB) return rej(new Error("This browser has no IndexedDB, so documents cannot be stored."));
      var r = root.indexedDB.open(S.DB_NAME, S.DB_VERSION);
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains(S.BLOBS)) db.createObjectStore(S.BLOBS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(S.TEXT)) db.createObjectStore(S.TEXT, { keyPath: "id" });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error || new Error("Couldn't open the document database.")); };
    });
    return dbPromise;
  };

  function tx(storeName, mode, fn) {
    return S.db().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(storeName, mode);
        var store = t.objectStore(storeName);
        var req;
        try { req = fn(store); } catch (e) { rej(e); return; }
        // Capture the value in onsuccess. Reading req.result after the
        // transaction completes cannot distinguish "no such record" from
        // "not a request", and returning the request object itself made a
        // missing blob look like a present one.
        var value;
        if (req && typeof req.addEventListener === "function") {
          req.onsuccess = function () { value = req.result; };
        }
        t.oncomplete = function () { res(value); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error || new Error("Storage transaction aborted — the disk may be full.")); };
      });
    });
  }

  /* ---------- blobs ---------- */
  S.putBlob = function (id, file) {
    return tx(S.BLOBS, "readwrite", function (store) {
      return store.put({
        id: id,
        blob: file,
        type: file.type || "",
        name: file.name || "",
        size: file.size || 0,
        ts: Date.now()
      });
    }).then(function () { return id; });
  };

  S.getBlob = function (id) {
    return tx(S.BLOBS, "readonly", function (store) { return store.get(id); })
      .then(function (rec) { return rec ? rec.blob : null; });
  };

  S.deleteBlob = function (id) {
    return tx(S.BLOBS, "readwrite", function (store) { return store.delete(id); });
  };

  S.hasBlob = function (id) {
    return tx(S.BLOBS, "readonly", function (store) { return store.count(id); })
      .then(function (n) { return (n || 0) > 0; });
  };

  /* ---------- extracted text ----------
     Kept out of _state so document contents are never serialised into the
     localStorage blob, the export file, or the cloud sync payload. */
  S.putText = function (id, pages) {
    var slim = (pages || []).map(function (p) { return { page: p.page, text: p.text, source: p.source }; });
    return tx(S.TEXT, "readwrite", function (store) { return store.put({ id: id, pages: slim, ts: Date.now() }); });
  };

  S.getText = function (id) {
    return tx(S.TEXT, "readonly", function (store) { return store.get(id); })
      .then(function (rec) { return rec ? rec.pages : null; });
  };

  S.deleteText = function (id) {
    return tx(S.TEXT, "readwrite", function (store) { return store.delete(id); });
  };

  /* ---------- document metadata ----------
     Metadata lives in _state.docs[biz].files alongside the existing entries,
     so the current Business Documents renderer keeps working unchanged. A
     DOCAI record is marked with `docai:true` and points at its blob by id. */
  S.buildRecord = function (input) {
    return {
      // identity
      id: input.id,
      docai: true,
      schema: 1,
      biz: input.biz,

      // file
      name: input.name,
      type: input.type || "",
      size: input.size || 0,
      sha256: input.sha256,
      blobId: input.blobId || input.id,
      hasBlob: !!input.hasBlob,

      // dates
      ts: input.ts || Date.now(),          // imported at
      documentDate: input.documentDate || "",
      expiresOn: input.expiresOn || "",

      // classification
      docType: input.docType || "unclassified",
      docTypeLabel: input.docTypeLabel || "Unclassified / Needs Review",
      category: input.category || "unfiled",
      subcategory: input.subcategory || "",
      issuer: input.issuer || "",
      pageCount: input.pageCount || 0,
      statementPeriod: input.statementPeriod || "",
      accountLast4: input.accountLast4 || "",

      // links and provenance
      linkedFields: input.linkedFields || [],     // destination strings written from this doc
      linkedCheckpoints: input.linkedCheckpoints || [],
      reviewStatus: input.reviewStatus || "reviewed",
      businessEvidence: input.businessEvidence || [],
      textRef: input.textRef || input.id,          // key into the TEXT store

      // keeps the existing Business Documents renderer happy
      af: true,
      ref: !input.hasBlob,
      dataUri: null
    };
  };

  /* ---------- duplicate detection ---------- */
  S.findExact = function (state, sha256) {
    var hits = [];
    ["centauri", "keypr"].forEach(function (biz) {
      var files = (state.docs && state.docs[biz] && state.docs[biz].files) || [];
      files.forEach(function (f) { if (f.sha256 && f.sha256 === sha256) hits.push({ biz: biz, file: f }); });
    });
    return hits;
  };

  /* A likely duplicate is the same business, same type, same issuer, and the
     same period or account tail — the shape of re-downloading last month's
     statement twice. Reported, never acted on automatically. */
  S.findLikely = function (state, meta) {
    var hits = [];
    var files = (state.docs && state.docs[meta.biz] && state.docs[meta.biz].files) || [];
    files.forEach(function (f) {
      if (!f.docai) return;
      if (f.sha256 && f.sha256 === meta.sha256) return; // already an exact hit
      var reasons = [];
      if (f.docType && meta.docType && f.docType === meta.docType && meta.docType !== "unclassified") {
        reasons.push("same document type (" + (f.docTypeLabel || f.docType) + ")");
      } else { return; }
      if (f.issuer && meta.issuer && f.issuer.toLowerCase() === String(meta.issuer).toLowerCase()) reasons.push("same issuer");
      if (f.statementPeriod && meta.statementPeriod && f.statementPeriod === meta.statementPeriod) reasons.push("same statement period");
      if (f.documentDate && meta.documentDate && f.documentDate === meta.documentDate) reasons.push("same document date");
      if (f.accountLast4 && meta.accountLast4 && f.accountLast4 === meta.accountLast4) reasons.push("same account ending " + meta.accountLast4);
      if (reasons.length >= 2) hits.push({ biz: meta.biz, file: f, reasons: reasons });
    });
    return hits;
  };

  /* ---------- housekeeping ---------- */
  S.usage = function () {
    if (!root.navigator || !navigator.storage || !navigator.storage.estimate) {
      return Promise.resolve(null);
    }
    return navigator.storage.estimate().then(function (e) {
      return { usage: e.usage, quota: e.quota };
    }).catch(function () { return null; });
  };

  // Blobs whose metadata no longer references them (after an undo, say).
  S.orphans = function (state) {
    var referenced = {};
    ["centauri", "keypr"].forEach(function (biz) {
      ((state.docs && state.docs[biz] && state.docs[biz].files) || []).forEach(function (f) {
        if (f.blobId) referenced[f.blobId] = true;
      });
    });
    return tx(S.BLOBS, "readonly", function (store) { return store.getAllKeys(); })
      .then(function (keys) {
        return (keys || []).filter(function (k) { return !referenced[k]; });
      });
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.store = S;
  if (typeof module !== "undefined" && module.exports) module.exports = S;
})(typeof globalThis !== "undefined" ? globalThis : this);
