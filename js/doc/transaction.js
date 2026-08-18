/* ============================================================
   DOCAI · transaction — the only code that writes an import to state.

   One import is one transaction. Either the document, the field values and
   the checkpoint links all land, or none of them do. Every write records the
   value it replaced, so a single Undo puts the dashboard back exactly as it
   was — including values the import overwrote after an explicit "replace"
   choice.

   Conflict resolutions are recorded, not inferred:
     keep     — existing value stays, nothing written
     replace  — new value written, old value preserved in history
     alternate— existing value stays, new value filed in history as an alternate
   ============================================================ */
(function (root) {
  "use strict";

  var D = root.DOCAI || {};
  var U = D.util, STORE = D.store, MAP = D.mapping;

  var T = {};

  // Only the most recent import can be undone; anything older has been built
  // on by later edits and silently rewinding it would be worse than useless.
  T.lastImport = null;

  function storeFor(state, biz, which) {
    if (which === "fin") return (state.fin[biz] = state.fin[biz] || {});
    return (state.bp[biz] = state.bp[biz] || {});
  }

  /* ---------- save ----------
     `decisions` is what the review screen collected:
       biz            confirmed business id
       docType        confirmed document type id
       category       confirmed category id
       saveDocument   whether to keep the original file
       fields[]       { dest, value, resolution }   — only the ones ticked
  */
  T.save = function (state, proposal, decisions, hooks) {
    hooks = hooks || {};
    var biz = decisions.biz;
    if (!biz || (biz !== "centauri" && biz !== "keypr")) {
      return Promise.reject(new Error("No business was confirmed — nothing was saved."));
    }

    var journal = {
      id: U.uid("tx"),
      at: Date.now(),
      biz: biz,
      fileName: proposal.fileName,
      fieldWrites: [],      // { store, key, dest, before, had, after }
      historyWrites: [],    // { dest, entryId }
      docId: null,
      blobId: null,
      textId: null,
      checkpoints: []
    };

    var fields = (decisions.fields || []).filter(function (f) {
      return f && f.dest && !MAP.isInternal(f.dest) && String(f.value).trim() !== "";
    });

    // --- stage the document first: if the blob cannot be stored, nothing
    //     else has happened yet and the whole import can be abandoned.
    var docId = U.uid("doc");
    var wantDocument = decisions.saveDocument !== false;
    var blobStep = wantDocument
      ? STORE.putBlob(docId, proposal.file)
          .then(function () { journal.blobId = docId; return true; })
          .catch(function (e) {
            // Storing the file failed. The values can still be saved, but the
            // user is told plainly rather than left thinking the file is kept.
            journal.blobError = e.message;
            return false;
          })
      : Promise.resolve(false);

    return blobStep.then(function (blobStored) {
      var textStep = (wantDocument && blobStored)
        ? STORE.putText(docId, proposal.pages).then(function () { journal.textId = docId; }).catch(function () {})
        : Promise.resolve();

      return textStep.then(function () {
        // ---- field writes
        fields.forEach(function (f) {
          var dest = MAP.get(f.dest);
          if (!dest) return;
          var target = storeFor(state, biz, dest.store);
          var before = target[dest.key];
          var had = before !== undefined && before !== null && String(before) !== "";

          if (f.resolution === "keep" && had) {
            // Existing value wins; the new one is filed as history only.
            addHistory(state, biz, f.dest, f.value, proposal, "alternate", journal);
            return;
          }
          if (f.resolution === "alternate" && had) {
            addHistory(state, biz, f.dest, f.value, proposal, "alternate", journal);
            return;
          }

          journal.fieldWrites.push({
            store: dest.store, key: dest.key, dest: f.dest,
            before: had ? before : undefined, had: had, after: f.value
          });
          if (had) addHistory(state, biz, f.dest, before, proposal, "replaced", journal);
          target[dest.key] = f.value;
        });

        // ---- checkpoints satisfied by what was actually written
        var written = journal.fieldWrites.map(function (w) { return w.dest; });
        journal.checkpoints = MAP.checkpointsFor(written);

        // ---- document record
        if (wantDocument) {
          var rec = STORE.buildRecord({
            id: docId,
            biz: biz,
            name: proposal.fileName,
            type: proposal.fileType,
            size: proposal.fileSize,
            sha256: proposal.sha256,
            blobId: docId,
            hasBlob: blobStored,
            documentDate: (proposal.meta && proposal.meta.documentDate) || "",
            docType: decisions.docType || proposal.classification.typeId,
            docTypeLabel: decisions.docTypeLabel || proposal.classification.label,
            category: decisions.category || proposal.classification.category,
            issuer: (proposal.meta && proposal.meta.issuer) || "",
            pageCount: proposal.pageCount,
            statementPeriod: (proposal.meta && proposal.meta.statementPeriod) || "",
            accountLast4: (proposal.meta && proposal.meta.accountLast4) || "",
            linkedFields: written,
            linkedCheckpoints: journal.checkpoints,
            reviewStatus: "reviewed",
            businessEvidence: (proposal.business.evidence || []).map(function (e) {
              return { kind: e.kind, matched: e.matched };
            }),
            textRef: journal.textId
          });

          state.docs[biz] = state.docs[biz] || { files: [], links: [], dnb: [], scan: { files: [] } };
          state.docs[biz].files.unshift(rec);
          journal.docId = docId;

          // Attach the document to every Strength checkpoint it evidences,
          // so the file is one click away from the item it proves.
          journal.checkpoints.forEach(function (cp) {
            state.strengthFiles[biz] = state.strengthFiles[biz] || {};
            var arr = (state.strengthFiles[biz][cp] = state.strengthFiles[biz][cp] || []);
            arr.push({
              id: U.uid("skf"), name: proposal.fileName, type: proposal.fileType,
              size: proposal.fileSize, ts: Date.now(), dataUri: null, ref: !blobStored,
              docai: true, blobId: blobStored ? docId : null, linkOf: docId
            });
          });
        }

        T.lastImport = journal;
        if (hooks.commit) hooks.commit();
        return journal;
      });
    });
  };

  /* ---------- value history ----------
     Nothing is ever destroyed by an import. A replaced value and any
     alternate the user chose not to take both land here, stamped with the
     document they came from. */
  function addHistory(state, biz, dest, value, proposal, kind, journal) {
    state.docaiHistory = state.docaiHistory || {};
    state.docaiHistory[biz] = state.docaiHistory[biz] || {};
    var list = (state.docaiHistory[biz][dest] = state.docaiHistory[biz][dest] || []);
    var entry = {
      id: U.uid("hist"),
      value: value,
      kind: kind,                       // "replaced" | "alternate"
      at: Date.now(),
      fromFile: proposal.fileName,
      fromDoc: journal.docId || null,
      sha256: proposal.sha256
    };
    list.unshift(entry);
    if (list.length > 20) list.length = 20;   // bounded; this is a safety net, not an archive
    journal.historyWrites.push({ dest: dest, entryId: entry.id, biz: biz });
  }

  /* ---------- undo ----------
     Reverses exactly what the journal recorded. A field the import created
     is removed; a field it overwrote is put back to its previous value. */
  T.undo = function (state, hooks) {
    hooks = hooks || {};
    var j = T.lastImport;
    if (!j) return Promise.resolve({ ok: false, message: "There is no recent import to undo." });

    // fields
    j.fieldWrites.forEach(function (w) {
      var target = w.store === "fin" ? state.fin[j.biz] : state.bp[j.biz];
      if (!target) return;
      if (w.had) target[w.key] = w.before;
      else delete target[w.key];
    });

    // history entries this import added
    j.historyWrites.forEach(function (h) {
      var list = state.docaiHistory && state.docaiHistory[h.biz] && state.docaiHistory[h.biz][h.dest];
      if (!list) return;
      var i = list.findIndex(function (e) { return e.id === h.entryId; });
      if (i >= 0) list.splice(i, 1);
      if (!list.length) delete state.docaiHistory[h.biz][h.dest];
    });

    // document record and its checkpoint attachments
    if (j.docId) {
      var files = state.docs[j.biz] && state.docs[j.biz].files;
      if (files) {
        var k = files.findIndex(function (f) { return f.id === j.docId; });
        if (k >= 0) files.splice(k, 1);
      }
      j.checkpoints.forEach(function (cp) {
        var arr = state.strengthFiles[j.biz] && state.strengthFiles[j.biz][cp];
        if (!arr) return;
        var left = arr.filter(function (f) { return f.linkOf !== j.docId; });
        // Leave no empty array behind, so undo restores the original shape.
        if (left.length) state.strengthFiles[j.biz][cp] = left;
        else delete state.strengthFiles[j.biz][cp];
      });
    }

    T.lastImport = null;
    if (hooks.commit) hooks.commit();

    // Blob cleanup happens after state is consistent; a failure here leaves
    // an orphan, which is harmless and collectable, rather than a dangling
    // reference, which is not.
    var cleanup = [];
    if (j.blobId) cleanup.push(STORE.deleteBlob(j.blobId).catch(function () {}));
    if (j.textId) cleanup.push(STORE.deleteText(j.textId).catch(function () {}));

    return Promise.all(cleanup).then(function () {
      return {
        ok: true,
        message: "Undid the import of “" + j.fileName + "” — " +
          j.fieldWrites.length + " field(s) restored" + (j.docId ? " and the document removed." : ".")
      };
    });
  };

  T.canUndo = function () { return !!T.lastImport; };
  T.describeLast = function () {
    var j = T.lastImport;
    if (!j) return "";
    return j.fileName + " → " + (j.biz === "centauri" ? "Centauri World LLC" : "Keypr On Company") +
      " · " + j.fieldWrites.length + " field(s)";
  };

  /* ---------- save the document only ----------
     Used by the "Save document only" button: files the original, writes no
     values, and is undoable in exactly the same way. */
  T.saveDocumentOnly = function (state, proposal, decisions, hooks) {
    var d = {};
    Object.keys(decisions || {}).forEach(function (k) { d[k] = decisions[k]; });
    d.fields = [];
    d.saveDocument = true;
    return T.save(state, proposal, d, hooks);
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.transaction = T;
  if (typeof module !== "undefined" && module.exports) module.exports = T;
})(typeof globalThis !== "undefined" ? globalThis : this);
