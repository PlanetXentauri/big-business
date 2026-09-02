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
       fields[]       { dest, value, resolution, confidence,
                        manuallyApproved, validationWarnings } — ticked only
  */
  T.save = function (state, proposal, decisions, hooks) {
    hooks = hooks || {};
    var biz = decisions.biz;
    if (!biz || (biz !== "centauri" && biz !== "keypr")) {
      return Promise.reject(new Error("No business was confirmed — nothing was saved."));
    }
    var CR = root.DOCAI && root.DOCAI.credit;

    // Re-analysis of a document already on file: same transaction, but the
    // existing record is the destination — no second copy, no second blob.
    var reanalyzeId = decisions.reanalyzeDocId || null;
    var existingRec = null;
    if (reanalyzeId) {
      existingRec = ((state.docs[biz] && state.docs[biz].files) || []).filter(function (f) { return f.id === reanalyzeId; })[0] || null;
      if (!existingRec) return Promise.reject(new Error("The document being re-analysed is no longer on file — nothing was saved."));
    }

    var journal = {
      id: U.uid("tx"),
      at: Date.now(),
      biz: biz,
      fileName: proposal.fileName,
      fieldWrites: [],      // { store, key, dest, before, had, after }
      historyWrites: [],    // { dest, entryId }
      creditWrites: [],     // { dest, metricKey, obsId }
      creditBefore: undefined,
      docId: null,
      blobId: null,
      textId: null,
      checkpoints: [],
      checkpointAttachments: [],
      docUpdatedId: null,
      docUpdatedBefore: null
    };

    var fields = (decisions.fields || []).filter(function (f) {
      return f && f.dest && !MAP.isInternal(f.dest) && (f.credit || String(f.value).trim() !== "");
    });

    // --- stage the document first: if the blob cannot be stored, nothing
    //     else has happened yet and the whole import can be abandoned.
    var docId = reanalyzeId || U.uid("doc");
    var wantDocument = decisions.saveDocument !== false && !reanalyzeId;
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
        // The whole credit ledger for this business is snapshotted once, so
        // undo can put back every observation, document and extended fact
        // this import touches in one move.
        if (CR && (proposal.credit || fields.some(function (f) { return f.credit; }))) {
          journal.creditRootExisted = !!state.credit;
          journal.creditBefore = state.credit && state.credit[biz] ? JSON.parse(JSON.stringify(state.credit[biz])) : null;
        }
        // Which document the observations cite: the one being filed now, the
        // one being re-analysed, or none if the file itself is not kept.
        var sourceDocId = (wantDocument || reanalyzeId) ? docId : null;

        // ---- field writes
        fields.forEach(function (f) {
          var dest = MAP.get(f.dest);
          if (!dest) return;
          if (dest.store === "credit") { creditWrite(f, dest); return; }
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
          if (had && String(before) === String(f.value)) return;   // already on file — nothing to write

          journal.fieldWrites.push({
            store: dest.store, key: dest.key, dest: f.dest,
            before: had ? before : undefined, had: had, after: f.value,
            confidence: f.confidence || "",
            manuallyApproved: !!f.manuallyApproved,
            validationWarnings: (f.validationWarnings || []).slice()
          });
          if (had) addHistory(state, biz, f.dest, before, proposal, "replaced", journal);
          target[dest.key] = f.value;
        });

        function creditWrite(f, dest) {
          if (!CR || !f.credit) return;
          var input = JSON.parse(JSON.stringify(f.credit));
          input.source = input.source || {};
          input.source.documentId = sourceDocId;
          input.source.fileName = proposal.fileName;
          input.source.method = f.creditEdited ? "manual" : "auto";
          input.importedAt = journal.at;
          if (f.creditEdited) {
            // A value changed in review is a manual entry: the document's own
            // reading is kept in history under the name of the document.
            var original = CR.buildObservation(JSON.parse(JSON.stringify(f.credit)));
            original.source.documentId = sourceDocId; original.source.fileName = proposal.fileName;
            original.importedAt = journal.at; original.historical = true;
            var kept = CR.record(state, biz, original, { resolution: "historical" });
            if (!kept.duplicate) journal.creditWrites.push({ dest: f.dest, metricKey: kept.obs.metricKey, obsId: kept.obs.id, historical: true });
            input.value = f.creditValue != null ? f.creditValue : input.value;
            input.valueText = f.value;
            input.status = f.creditStatus || (input.value != null || f.value ? "available" : input.status);
            input.note = "Edited during review; the document read " + (f.credit.valueText || f.credit.status) + ".";
            input.source.evidence = (input.source.evidence || "") + " (edited in review)";
          }
          var obs = CR.buildObservation(input);
          var res = CR.record(state, biz, obs, { resolution: f.resolution || "" });
          if (res.duplicate) return;
          journal.creditWrites.push({ dest: f.dest, metricKey: obs.metricKey, obsId: obs.id });

          // Mirror a well-known numeric score into the legacy single-value
          // field, through the same journal so undo restores it too.
          var m = CR.mirrorFor(res.obs);
          if (m) {
            var cur = CR.current(state, biz)[obs.metricKey];
            if (cur && cur.id === res.obs.id) {
              var fin = storeFor(state, biz, "fin");
              var before = fin[m.key];
              var had = before !== undefined && before !== null && String(before) !== "";
              if (!had || String(before) !== m.value) {
                journal.fieldWrites.push({ store: "fin", key: m.key, dest: "fin." + m.key, before: had ? before : undefined, had: had, after: m.value, confidence: f.confidence || "", mirrorOf: obs.metricKey });
                fin[m.key] = m.value;
              }
            }
          }
        }

        // ---- checkpoints satisfied by what was actually written
        var written = journal.fieldWrites.map(function (w) { return w.dest; })
          .concat(journal.creditWrites.filter(function (w) { return !w.historical; }).map(function (w) { return w.dest; }));
        journal.checkpoints = MAP.checkpointsFor(written);

        // ---- the credit ledger: document + extended facts
        var creditDoc = null;
        if (CR && proposal.credit && (wantDocument || reanalyzeId)) {
          var s = CR.ensure(state, biz);
          var extendedAdded = CR.addExtended(state, biz, proposal.credit.extended, docId, proposal.credit.reportDate);
          var fromDoc = s.observations.filter(function (o) { return o.source.documentId === docId; }).length;
          creditDoc = CR.registerDocument(state, biz, {
            docId: docId, fileName: proposal.fileName, provider: proposal.credit.provider,
            reportLabel: proposal.credit.reportLabel || "", reportDate: proposal.credit.reportDate || "",
            importedAt: existingRec ? existingRec.ts : journal.at, pageCount: proposal.pageCount,
            metricCount: fromDoc, extendedCount: s.extended.filter(function (e) { return e.documentId === docId; }).length,
            extractionVersion: proposal.credit.version, reanalyzedAt: reanalyzeId ? journal.at : null,
            accountIdentifier: (proposal.credit.identifiers && proposal.credit.identifiers.duns) || ""
          });
          journal.creditExtendedAdded = extendedAdded;
        }

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
          if (creditDoc) rec.creditExtraction = creditSummary(proposal, creditDoc);

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
        } else if (reanalyzeId && existingRec) {
          // Enrich the existing record in place; keep its previous shape for undo.
          journal.docUpdatedId = existingRec.id;
          journal.docUpdatedBefore = JSON.parse(JSON.stringify(existingRec));
          existingRec.linkedFields = unique((existingRec.linkedFields || []).concat(written));
          existingRec.linkedCheckpoints = unique((existingRec.linkedCheckpoints || []).concat(journal.checkpoints));
          existingRec.reanalyzedAt = journal.at;
          existingRec.reviewStatus = "reviewed";
          if (creditDoc) existingRec.creditExtraction = creditSummary(proposal, creditDoc);
          if (proposal.credit && proposal.credit.reportDate && !existingRec.documentDate) existingRec.documentDate = proposal.credit.reportDate;
          journal.checkpoints.forEach(function (cp) {
            state.strengthFiles[biz] = state.strengthFiles[biz] || {};
            var arr = (state.strengthFiles[biz][cp] = state.strengthFiles[biz][cp] || []);
            if (arr.some(function (f) { return f.linkOf === existingRec.id; })) return;
            var att = {
              id: U.uid("skf"), name: existingRec.name, type: existingRec.type,
              size: existingRec.size, ts: Date.now(), dataUri: null, ref: !existingRec.hasBlob,
              docai: true, blobId: existingRec.hasBlob ? existingRec.blobId : null, linkOf: existingRec.id
            };
            arr.push(att);
            journal.checkpointAttachments.push({ checkpoint: cp, id: att.id });
          });
        }

        T.lastImport = journal;
        if (hooks.commit) hooks.commit();
        return journal;
      });
    });
  };

  function creditSummary(proposal, creditDoc) {
    return {
      provider: proposal.credit.provider,
      reportLabel: proposal.credit.reportLabel || "",
      reportDate: proposal.credit.reportDate || "",
      version: proposal.credit.version,
      metricCount: creditDoc.metricCount,
      extendedCount: creditDoc.extendedCount,
      reanalyzedAt: creditDoc.reanalyzedAt || null
    };
  }

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

    // the credit ledger, restored wholesale from its pre-import snapshot
    if (j.creditBefore !== undefined) {
      if (!j.creditRootExisted) delete state.credit;
      else if (j.creditBefore === null) delete state.credit[j.biz];
      else state.credit[j.biz] = j.creditBefore;
    }

    // document record and its checkpoint attachments
    if (j.docId) {
      var files = state.docs[j.biz] && state.docs[j.biz].files;
      if (files) {
        var k = files.findIndex(function (f) { return f.id === j.docId; });
        if (k >= 0) files.splice(k, 1);
      }
      detachCheckpoints(state, j, j.docId);
    }

    // a re-analysed document: put the record back exactly as it was
    if (j.docUpdatedId && j.docUpdatedBefore && !j.webUpdatedId) {
      var docs = state.docs[j.biz] && state.docs[j.biz].files;
      if (docs) {
        var at = docs.findIndex(function (f) { return f.id === j.docUpdatedId; });
        if (at >= 0) docs[at] = j.docUpdatedBefore;
      }
      detachAddedCheckpoints(state, j);
    }

    // link record and its checkpoint attachments
    if (j.webId) {
      var web = state.docs[j.biz] && state.docs[j.biz].web;
      if (web) {
        var w = web.findIndex(function (r) { return r.id === j.webId; });
        if (w >= 0) web.splice(w, 1);
        // Only remove the array if this import is what created it.
        if (!web.length && j.webArrayCreated) delete state.docs[j.biz].web;
      }
      detachCheckpoints(state, j, j.webId);
    }

    // An exact-duplicate save can enrich an existing link instead of
    // creating a second record. Restore that record and remove only the
    // checkpoint attachments this import added.
    if (j.webUpdatedId && j.webUpdatedBefore) {
      var existingWeb = state.docs[j.biz] && state.docs[j.biz].web;
      if (existingWeb) {
        var existingAt = existingWeb.findIndex(function (r) { return r.id === j.webUpdatedId; });
        if (existingAt >= 0) existingWeb[existingAt] = j.webUpdatedBefore;
      }
      detachAddedCheckpoints(state, j);
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
      var credit = (j.creditWrites || []).length;
      return {
        ok: true,
        message: "Undid the import of “" + j.fileName + "” — " +
          j.fieldWrites.length + " field(s) restored" +
          (credit ? ", " + credit + " credit observation(s) removed" : "") +
          (j.docId ? " and the document removed." : j.webId ? " and the saved link removed." :
            j.webUpdatedId ? " and the saved link restored." : j.docUpdatedId ? " and the document record restored." : ".")
      };
    });
  };

  // Remove the checkpoint attachments an import created, leaving no empty
  // array behind so undo restores the original shape exactly.
  function detachCheckpoints(state, j, ownerId) {
    j.checkpoints.forEach(function (cp) {
      var arr = state.strengthFiles[j.biz] && state.strengthFiles[j.biz][cp];
      if (!arr) return;
      var left = arr.filter(function (f) { return f.linkOf !== ownerId; });
      if (left.length) state.strengthFiles[j.biz][cp] = left;
      else delete state.strengthFiles[j.biz][cp];
    });
  }

  T.canUndo = function () { return !!T.lastImport; };
  T.describeLast = function () {
    var j = T.lastImport;
    if (!j) return "";
    var what = j.kind === "link" ? "🔗 " : (j.docUpdatedId && !j.webUpdatedId ? "↻ " : "");
    var credit = (j.creditWrites || []).length;
    return what + String(j.fileName).slice(0, 60) + " → " +
      (j.biz === "centauri" ? "Centauri World LLC" : "Keypr On Company") +
      " · " + j.fieldWrites.length + " field(s)" + (credit ? " · " + credit + " credit metric(s)" : "");
  };

  /* ============================================================
     Web sources.

     A link import is the same transaction with a different artifact: instead
     of a blob and a document record it writes a link record. Field writes,
     conflict resolution, value history, checkpoint attachment and undo are
     the shared code above and below — a link and a PDF are equally
     reversible, and neither can overwrite anything silently.
     ============================================================ */
  T.saveLink = function (state, proposal, decisions, hooks) {
    hooks = hooks || {};
    var LS = (root.DOCAI && root.DOCAI.linkStore);
    var biz = decisions.biz;
    if (!biz || (biz !== "centauri" && biz !== "keypr")) {
      return Promise.reject(new Error("No business was confirmed — nothing was saved."));
    }
    if (!LS) return Promise.reject(new Error("The link store did not load."));

    var journal = {
      id: U.uid("tx"),
      at: Date.now(),
      biz: biz,
      kind: "link",
      fileName: proposal.title || proposal.url,
      fieldWrites: [],
      historyWrites: [],
      docId: null,
      webId: null,
      webUpdatedId: null,
      webUpdatedBefore: null,
      textId: null,
      blobId: null,
      checkpoints: [],
      checkpointAttachments: []
    };

    var fields = (decisions.fields || []).filter(function (f) {
      return f && f.dest && !MAP.isInternal(f.dest) && String(f.value).trim() !== "";
    });

    var duplicateChoice = decisions.duplicateChoice || "";
    var duplicate = (proposal.exactDuplicates || []).filter(function (d) {
      return d.biz === biz && (!decisions.existingWebId || d.record.id === decisions.existingWebId);
    })[0] || null;
    var updateExisting = !!duplicate && duplicateChoice && duplicateChoice !== "both";
    if ((proposal.exactDuplicates || []).length && !duplicateChoice) {
      return Promise.reject(new Error("This link is already saved — choose how to handle the existing link."));
    }
    if (duplicateChoice && duplicateChoice !== "both" && !duplicate) {
      return Promise.reject(new Error("The saved link belongs to a different business. Choose that business or keep both intentionally."));
    }
    if (duplicateChoice === "meta" || duplicateChoice === "recheck") fields = [];

    var recordId = updateExisting ? duplicate.record.id : U.uid("web");

    // Page text goes to IndexedDB, never into state. If that fails the import
    // still proceeds — the text is a convenience, the record is the point.
    var textStep = updateExisting
      ? Promise.resolve(duplicate.record.textRef || null)
      : (decisions.keepText !== false && proposal.pageText)
      ? LS.putText(recordId, proposal.pageText, proposal.finalUrl || proposal.url)
          .then(function (ref) { journal.textId = ref; return ref; })
          .catch(function () { return null; })
      : Promise.resolve(null);

    return textStep.then(function (textRef) {
      // ---- field writes (identical rules to a document import)
      fields.forEach(function (f) {
        var dest = MAP.get(f.dest);
        if (!dest) return;
        var target = storeFor(state, biz, dest.store);
        var before = target[dest.key];
        var had = before !== undefined && before !== null && String(before) !== "";

        if ((f.resolution === "keep" || f.resolution === "alternate") && had) {
          addHistory(state, biz, f.dest, f.value, proposal, "alternate", journal);
          return;
        }
        journal.fieldWrites.push({
          store: dest.store, key: dest.key, dest: f.dest,
          before: had ? before : undefined, had: had, after: f.value,
          confidence: f.confidence || "",
          manuallyApproved: !!f.manuallyApproved,
          validationWarnings: (f.validationWarnings || []).slice()
        });
        if (had) addHistory(state, biz, f.dest, before, proposal, "replaced", journal);
        target[dest.key] = f.value;
      });

      var written = journal.fieldWrites.map(function (w) { return w.dest; });
      journal.checkpoints = MAP.checkpointsFor(written);

      // A page type can evidence a checkpoint on its own — a Google Business
      // Profile page is proof of that checkpoint even when it fills no field.
      var typeCheckpoint = decisions.checkpoint || (proposal.classification && proposal.classification.checkpoint);
      if (typeCheckpoint && journal.checkpoints.indexOf(typeCheckpoint) < 0) {
        journal.checkpoints.push(typeCheckpoint);
        journal.typeCheckpoint = typeCheckpoint;
      }
      if (updateExisting && duplicateChoice === "link") {
        journal.checkpoints = unique(journal.checkpoints.concat(
          MAP.checkpointsFor(fields.map(function (f) { return f.dest; }))
        ));
      }

      // ---- link evidence
      var evidence = fields.map(function (f) {
        var c = findCandidate(proposal, f.dest);
        return {
          dest: f.dest,
          label: MAP.label(f.dest),
          value: f.value,
          masked: U.isSensitive(f.dest) ? U.maskFor(f.dest, f.value) : f.value,
          where: c && c.web ? c.web.where : "",
          source: c && c.web ? c.web.source : "",
          excerpt: c ? c.excerpt : "",
          confidence: f.confidence || (c ? c.confidence : ""),
          manuallyApproved: !!f.manuallyApproved,
          validationWarnings: (f.validationWarnings || []).slice()
        };
      });

      var rec = LS.buildRecord({
        id: recordId,
        biz: biz,
        url: proposal.url,
        normalizedUrl: proposal.normalizedUrl,
        finalUrl: proposal.finalUrl,
        canonicalUrl: proposal.canonicalUrl,
        domain: proposal.domain,
        title: proposal.title,
        siteType: decisions.siteType || proposal.classification.typeId,
        siteTypeLabel: decisions.siteTypeLabel || proposal.classification.label,
        category: decisions.category || proposal.classification.category,
        issuer: proposal.issuer,
        retrievedAt: proposal.retrievedAt,
        retrievalStatus: proposal.retrievalStatus,
        retrievalNote: proposal.retrievalReason || (proposal.notes || [])[0] || "",
        httpStatus: proposal.httpStatus,
        redirected: proposal.redirected,
        contentHash: proposal.contentHash,
        linkedFields: written,
        linkedCheckpoints: journal.checkpoints,
        reviewStatus: "reviewed",
        evidence: evidence,
        businessEvidence: (proposal.business.evidence || []),
        textRef: textRef,
        notes: decisions.notes || ""
      });

      if (updateExisting) {
        var current = duplicate.record;
        journal.webUpdatedId = current.id;
        journal.webUpdatedBefore = JSON.parse(JSON.stringify(current));

        if (duplicateChoice === "meta" || duplicateChoice === "recheck") {
          current.title = rec.title || current.title;
          current.finalUrl = rec.finalUrl || current.finalUrl;
          current.canonicalUrl = rec.canonicalUrl || current.canonicalUrl;
          current.domain = rec.domain || current.domain;
          current.siteType = rec.siteType;
          current.siteTypeLabel = rec.siteTypeLabel;
          current.category = rec.category;
          current.issuer = rec.issuer || current.issuer;
          current.retrievalStatus = rec.retrievalStatus;
          current.retrievalNote = rec.retrievalNote;
          current.httpStatus = rec.httpStatus;
          current.redirected = rec.redirected;
          current.contentHash = rec.contentHash || current.contentHash;
          current.lastCheckedAt = Date.now();
        }

        var supported = fields.map(function (f) { return f.dest; });
        current.linkedFields = unique((current.linkedFields || []).concat(supported));
        current.linkedCheckpoints = unique((current.linkedCheckpoints || []).concat(journal.checkpoints));
        current.evidence = mergeEvidence(current.evidence || [], evidence, LS.MAX_EVIDENCE || 12);
        current.reviewStatus = "reviewed";
        rec = current;
      } else {
        // Remember whether this import created the array, so undo can restore
        // the exact original shape without deleting one that pre-existed.
        journal.webArrayCreated = !(state.docs[biz] && state.docs[biz].web);
        LS.ensure(state, biz).unshift(rec);
        journal.webId = rec.id;
      }

      // Attach to every checkpoint it evidences, so the source sits beside
      // the item it proves.
      journal.checkpoints.forEach(function (cp) {
        state.strengthFiles[biz] = state.strengthFiles[biz] || {};
        var arr = (state.strengthFiles[biz][cp] = state.strengthFiles[biz][cp] || []);
        if (updateExisting && arr.some(function (f) { return f.linkOf === rec.id; })) return;
        var attachment = {
          id: U.uid("skf"),
          name: (proposal.title || proposal.domain || proposal.url).slice(0, 120),
          type: "text/uri-list",
          size: 0, ts: Date.now(), dataUri: null, ref: false,
          docaiWeb: true, url: proposal.finalUrl || proposal.url, linkOf: rec.id
        };
        arr.push(attachment);
        journal.checkpointAttachments.push({ checkpoint: cp, id: attachment.id });
      });

      T.lastImport = journal;
      if (hooks.commit) hooks.commit();
      return journal;
    });
  };

  function unique(values) {
    return values.filter(function (v, i, all) { return all.indexOf(v) === i; });
  }

  function detachAddedCheckpoints(state, j) {
    (j.checkpointAttachments || []).forEach(function (added) {
      var arr = state.strengthFiles[j.biz] && state.strengthFiles[j.biz][added.checkpoint];
      if (!arr) return;
      var left = arr.filter(function (f) { return f.id !== added.id; });
      if (left.length) state.strengthFiles[j.biz][added.checkpoint] = left;
      else delete state.strengthFiles[j.biz][added.checkpoint];
    });
  }

  function mergeEvidence(existing, incoming, limit) {
    var replaced = incoming.map(function (e) { return e.dest; });
    return incoming.concat(existing.filter(function (e) {
      return replaced.indexOf(e.dest) < 0;
    })).slice(0, limit);
  }

  function findCandidate(proposal, dest) {
    var list = proposal.candidates || [];
    for (var i = 0; i < list.length; i++) if (list[i].dest === dest) return list[i];
    return null;
  }

  /* Save the link and nothing else. Still a full transaction, still undoable. */
  T.saveLinkOnly = function (state, proposal, decisions, hooks) {
    var d = {};
    Object.keys(decisions || {}).forEach(function (k) { d[k] = decisions[k]; });
    d.fields = [];
    return T.saveLink(state, proposal, d, hooks);
  };

  /* ---------- save the document only ----------
     Used by the "Save document only" button: files the original, writes no
     values, and is undoable in exactly the same way. */
  T.saveDocumentOnly = function (state, proposal, decisions, hooks) {
    var d = {};
    Object.keys(decisions || {}).forEach(function (k) { d[k] = decisions[k]; });
    d.fields = [];
    d.saveDocument = !d.reanalyzeDocId;
    return T.save(state, proposal, d, hooks);
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.transaction = T;
  if (typeof module !== "undefined" && module.exports) module.exports = T;
})(typeof globalThis !== "undefined" ? globalThis : this);
