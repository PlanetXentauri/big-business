/* ============================================================
   DOCAI · pipeline — ingestion from file to a reviewable proposal.

   The pipeline never writes anything. It produces a proposal object; only
   the transaction module, driven by an explicit Save, changes state. That
   separation is what guarantees nothing saves before review.

   Stages:
     1  validate type and size        9  extract candidate fields
     2  hash for duplicates          10  normalize and validate (in extractors)
     3  preprocess / inspect         11  map to destinations
     4  embedded PDF text            12  map to a document category
     5  OCR pages without text       13  present review  (caller)
     6  keep pages and positions     14  save as one transaction (transaction.js)
     7  detect business              15  undo                  (transaction.js)
     8  classify document
   ============================================================ */
(function (root) {
  "use strict";

  var D = root.DOCAI || {};
  var U = D.util, IMG = D.image, PDFX = D.pdf, OCR = D.ocr;
  var MATCH = D.businessMatcher, CLASS = D.classifier, EXTRACT = D.extractors;
  var MAP = D.mapping, STORE = D.store;

  var P = {};

  P.MAX_BYTES = 50 * 1024 * 1024;
  P.ACCEPTED = {
    "application/pdf": "pdf",
    "image/jpeg": "image", "image/jpg": "image", "image/png": "image",
    "image/webp": "image", "image/gif": "image", "image/bmp": "image",
    "image/tiff": "image", "image/heic": "image", "image/heif": "image",
    "text/plain": "text", "text/markdown": "text", "text/csv": "text", "application/json": "text"
  };

  P.kindOf = function (file) {
    var t = (file.type || "").toLowerCase();
    if (P.ACCEPTED[t]) return P.ACCEPTED[t];
    var ext = (file.name || "").split(".").pop().toLowerCase();
    if (ext === "pdf") return "pdf";
    if (["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif"].indexOf(ext) >= 0) return "image";
    if (["txt", "md", "csv", "json", "text"].indexOf(ext) >= 0) return "text";
    return null;
  };

  function noop() {}

  /* ---------- stage 1 ---------- */
  P.validateFile = function (file) {
    if (!file) return { ok: false, error: "No file was provided." };
    if (!file.size) return { ok: false, error: "That file is empty (0 bytes)." };
    if (file.size > P.MAX_BYTES) {
      return { ok: false, error: "That file is " + Math.round(file.size / 1048576) + " MB. The limit is " +
        Math.round(P.MAX_BYTES / 1048576) + " MB so the browser does not run out of memory." };
    }
    var kind = P.kindOf(file);
    if (!kind) {
      return { ok: false, error: "“" + (file.name || "that file") + "” is not a type this can read. Use a PDF, a photo (JPEG, PNG, WebP, HEIC), or a text file." };
    }
    return { ok: true, kind: kind };
  };

  /* ---------- stages 3-6: get text out of the file ---------- */
  function readPdf(file, onStatus) {
    var pages, pdfDoc;
    return file.arrayBuffer()
      .then(function (ab) { return PDFX.extractPages(ab, function (done, total, note) { onStatus(note); }); })
      .then(function (r) {
        pages = r.pages;
        pdfDoc = r.pdf;
        var scanned = pages.filter(function (p) { return p.needsOcr; });
        if (!scanned.length) {
          return { pages: pages, notes: ["All " + pages.length + " page(s) had embedded text — no image recognition was needed."] };
        }

        // Mixed or fully scanned: OCR only the pages that need it.
        var notes = [(pages.length - scanned.length) + " of " + pages.length +
          " page(s) had embedded text; running recognition on the remaining " + scanned.length + "."];
        var chain = Promise.resolve();
        var ocrNotes = [];

        scanned.forEach(function (p, i) {
          chain = chain.then(function () {
            onStatus("Recognising text on page " + p.page + " (" + (i + 1) + " of " + scanned.length + ")…");
            return PDFX.renderPage(p._pdfPage, 2)
              .then(function (canvas) {
                return OCR.recognize(canvas, function (frac, note) {
                  onStatus("Page " + p.page + ": " + note);
                });
              })
              .then(function (res) {
                p.text = res.text || "";
                p.items = res.items || [];
                p.source = "ocr";
                p.ocrConfidence = res.meanConfidence;
                if (i === 0) ocrNotes.push(OCR.qualityNote(res));
              })
              .catch(function (e) {
                p.text = p.text || "";
                p.source = "ocr-failed";
                ocrNotes.push("Page " + p.page + " could not be read: " + e.message);
              });
          });
        });

        return chain.then(function () { return { pages: pages, notes: notes.concat(ocrNotes) }; });
      })
      .then(function (out) {
        // Release PDF.js resources; the original file is what gets stored.
        pages.forEach(function (p) { delete p._pdfPage; });
        if (pdfDoc && pdfDoc.destroy) { try { pdfDoc.destroy(); } catch (e) {} }
        return out;
      });
  }

  function readImage(file, onStatus) {
    onStatus("Preparing the photo…");
    return IMG.prepare(file).then(function (prep) {
      onStatus("Reading the text — this runs entirely in your browser…");
      return OCR.recognize(prep.canvas, function (frac, note) { onStatus(note); })
        .then(function (res) {
          var notes = prep.steps.slice();
          notes.push(OCR.qualityNote(res));
          prep.warnings.forEach(function (w) { notes.push(w); });
          return {
            pages: [{ page: 1, text: res.text || "", items: res.items || [], source: "ocr", ocrConfidence: res.meanConfidence }],
            notes: notes,
            warnings: prep.warnings,
            quality: prep.quality
          };
        });
    });
  }

  function readText(file, onStatus) {
    onStatus("Reading the text file…");
    return file.text().then(function (t) {
      return { pages: [{ page: 1, text: t, items: [], source: "text" }], notes: ["Read as plain text — no recognition needed."] };
    });
  }

  /* ---------- the run ---------- */
  P.run = function (file, options) {
    options = options || {};
    var onStatus = options.onStatus || noop;
    var state = options.state;
    var profiles = options.profiles || {};

    var gate = P.validateFile(file);
    if (!gate.ok) return Promise.reject(new Error(gate.error));

    var proposal = {
      id: U.uid("imp"),
      file: file,
      fileName: file.name || "document",
      fileType: file.type || "",
      fileSize: file.size,
      kind: gate.kind,
      notes: [],
      warnings: [],
      createdAt: Date.now()
    };

    onStatus("Checking the file…");

    return U.hashFile(file).then(function (sha) {
      proposal.sha256 = sha;

      // Stage 2 — exact duplicates are known before any work is done.
      proposal.exactDuplicates = state ? STORE.findExact(state, sha) : [];

      var reader = gate.kind === "pdf" ? readPdf : gate.kind === "image" ? readImage : readText;
      return reader(file, onStatus);
    }).then(function (read) {
      proposal.pages = read.pages;
      proposal.pageCount = read.pages.length;
      proposal.notes = proposal.notes.concat(read.notes || []);
      proposal.warnings = proposal.warnings.concat(read.warnings || []);
      proposal.quality = read.quality || null;

      var fullText = read.pages.map(function (p) { return p.text; }).join("\n\n");
      proposal.textLength = fullText.replace(/\s/g, "").length;

      if (proposal.textLength < 15) {
        proposal.warnings.push("Almost no text could be read from this file. Nothing will be proposed — the document can still be saved on its own.");
        proposal.business = { decision: "none", business: null, confidence: "Low", evidence: [], reasons: ["No readable text to match against."], requiresManualChoice: true };
        proposal.classification = CLASS.classify("");
        proposal.candidates = [];
        proposal.rejected = [];
        proposal.likelyDuplicates = [];
        return proposal;
      }

      onStatus("Working out which business this belongs to…");
      proposal.business = MATCH.match(fullText, profiles);      // stage 7

      onStatus("Identifying the document type…");
      proposal.classification = CLASS.classify(fullText);        // stage 8

      onStatus("Pulling out values…");
      var groups = (proposal.classification.type.fields || []).slice();
      // An unclassified document gets the broad sweep rather than nothing.
      var ex = EXTRACT.extract(read.pages, { groups: groups.length ? groups : null });  // stages 9-10
      proposal.candidates = ex.candidates.filter(function (c) { return !MAP.isInternal(c.dest); });
      proposal.internal = ex.candidates.filter(function (c) { return MAP.isInternal(c.dest); });
      proposal.rejected = ex.rejected;

      // Stage 11-12 — destinations and category are already carried by the
      // candidates and the classification; assemble the filing metadata.
      var period = find(proposal.internal, "meta.statementPeriod");
      var docDate = find(proposal.internal, "meta.documentDate");
      var acct = find(proposal.candidates, "fin.acctNumber");
      var card = find(proposal.candidates, "fin.card1");

      proposal.meta = {
        statementPeriod: period ? period.value : "",
        documentDate: docDate ? docDate.value : (find(proposal.candidates, "bp.formationDate") || {}).value || "",
        issuer: guessIssuer(fullText, proposal.classification),
        accountLast4: acct ? (acct.validation.meta.last4 || "") : (card ? (card.validation.meta.last4 || "") : "")
      };

      // Stage 2b — likely duplicates need the classification to be meaningful.
      proposal.likelyDuplicates = (state && proposal.business.business)
        ? STORE.findLikely(state, {
            biz: proposal.business.business,
            sha256: proposal.sha256,
            docType: proposal.classification.typeId,
            issuer: proposal.meta.issuer,
            statementPeriod: proposal.meta.statementPeriod,
            documentDate: proposal.meta.documentDate,
            accountLast4: proposal.meta.accountLast4
          })
        : [];

      onStatus("");
      return proposal;
    });
  };

  function find(list, dest) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].dest === dest) return list[i];
    return null;
  }

  /* The issuing organisation, taken from the top of the document where
     letterheads live. Only used for filing and duplicate hints. */
  function guessIssuer(text, classification) {
    var head = text.slice(0, 400);
    var known = [
      /internal revenue service/i, /department of the treasury/i, /secretary of state/i,
      /dun\s*&?\s*bradstreet/i, /experian/i, /equifax/i, /transunion/i,
      /chase/i, /bank of america/i, /wells fargo/i, /truist/i, /\bpnc\b/i, /citibank/i,
      /capital one/i, /american express/i, /discover/i, /navy federal/i,
      /mercury/i, /bluevine/i, /novo\b/i, /relay/i, /\bstripe\b/i, /\bpaypal\b/i, /\bsquare\b/i,
      /\buline\b/i, /\bquill\b/i, /grainger/i, /\buspto\b/i, /department of revenue/i
    ];
    for (var i = 0; i < known.length; i++) {
      var m = known[i].exec(head);
      if (m) return m[0].replace(/\s+/g, " ").trim();
    }
    // Fall back to the first line that looks like an organisation name.
    var lines = head.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    for (var j = 0; j < Math.min(lines.length, 4); j++) {
      if (lines[j].length >= 6 && lines[j].length <= 60 && /[A-Za-z]{4}/.test(lines[j])) return lines[j];
    }
    return "";
  }

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.pipeline = P;
  if (typeof module !== "undefined" && module.exports) module.exports = P;
})(typeof globalThis !== "undefined" ? globalThis : this);
