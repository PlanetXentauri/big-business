/* ============================================================
   DOCAI · engine-schema — the Precise Business Autofill Engine contract.

   One JSON shape describes what an extraction engine proposes, whoever
   produced it. The local deterministic engine and the opt-in Claude engine
   both emit this, and the review screen consumes only this.

   Two things live here:
     · SCHEMA   — the JSON Schema sent to the API as `output_config.format`,
                  so the model is constrained to the contract rather than
                  asked nicely to follow it.
     · validate — a local checker run over ANY engine response before it is
                  shown. A schema-constrained response is still untrusted
                  input; this is what makes that safe to say.

   Nothing here calls the network or touches state.
   ============================================================ */
(function (root) {
  "use strict";

  var E = {};

  E.SCHEMA_VERSION = 1;

  E.BUSINESS_RESULTS = ["centauri", "keypr", "ambiguous", "no_match"];
  E.CONFIDENCE = ["High", "Medium", "Low"];
  E.CONFLICT_STATES = ["empty_destination", "same_value", "different_value", "multiple_candidates"];
  E.TEXT_SOURCES = ["embedded_pdf", "ocr", "browser_capture", "pasted_text"];
  E.STATUSES = ["review_required", "no_candidates", "blocked", "error", "local_processing_required"];

  E.CLASSIFICATION_TYPES = [
    "articles", "state_registration", "annual_report", "good_standing", "registered_agent",
    "ein_confirmation", "address_proof", "bank_statement", "bank_confirmation", "voided_check",
    "credit_card_statement", "dnb_report", "experian_credit_report", "equifax_credit_report",
    "fico_sbss_report", "tradeline_statement", "payment_processor_statement", "license", "permit",
    "sales_tax_permit", "resale_certificate", "insurance_policy", "insurance_certificate",
    "google_business_verification", "directory_evidence", "trademark_filing", "trademark_registration",
    "contract", "invoice", "receipt", "tax_document", "official_site",
    "government_registration_page", "directory_page", "contact_page", "unclassified"
  ];

  E.EVIDENCE_KINDS = ["legal_name", "dba", "ein", "duns", "address", "phone", "email",
    "domain", "bank_owner", "other"];

  /* ---------- the schema sent to the API ----------
     Deliberately strict: `additionalProperties: false` everywhere and every
     enum closed, so the model cannot invent a destination name or a
     confidence value the dashboard does not understand. */
  function enumStr(values) { return { type: "string", enum: values }; }
  function strOrNull() { return { type: ["string", "null"] }; }
  function intOrNull() { return { type: ["integer", "null"] }; }

  E.buildSchema = function (allowedDestinations) {
    var destination = allowedDestinations && allowedDestinations.length
      ? { type: "string", enum: allowedDestinations }
      : { type: "string" };

    return {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "requestId", "status", "source", "businessDecision",
        "classification", "candidates", "rejected", "unmappedFindings", "sourceRouting",
        "review", "warnings"],
      properties: {
        schemaVersion: { type: "integer", enum: [1] },
        requestId: { type: "string" },
        status: enumStr(E.STATUSES),

        source: {
          type: "object", additionalProperties: false,
          required: ["sourceType", "retrievalStatus"],
          properties: {
            sourceType: enumStr(["photo", "pdf", "link"]),
            filename: { type: "string" },
            originalUrl: { type: "string" },
            finalUrl: { type: "string" },
            title: { type: "string" },
            sha256: { type: "string" },
            pageCount: { type: "integer" },
            retrievalStatus: { type: "string" }
          }
        },

        businessDecision: {
          type: "object", additionalProperties: false,
          required: ["result", "confidence", "requiresConfirmation", "evidence", "reasons"],
          properties: {
            result: enumStr(E.BUSINESS_RESULTS),
            confidence: enumStr(E.CONFIDENCE),
            requiresConfirmation: { type: "boolean" },
            warning: { type: "string" },
            evidence: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["kind", "business", "matchedValue", "excerpt"],
                properties: {
                  kind: enumStr(E.EVIDENCE_KINDS),
                  business: enumStr(["centauri", "keypr"]),
                  matchedValue: { type: "string" },
                  excerpt: { type: "string" },
                  page: intOrNull(),
                  sourceUrl: { type: "string" }
                }
              }
            },
            reasons: { type: "array", items: { type: "string" } }
          }
        },

        classification: {
          type: "object", additionalProperties: false,
          required: ["type", "label", "confidence", "reasons"],
          properties: {
            type: enumStr(E.CLASSIFICATION_TYPES),
            label: { type: "string" },
            category: { type: "string" },
            confidence: enumStr(E.CONFIDENCE),
            reasons: { type: "array", items: { type: "string" } },
            evidence: { type: "array", items: { type: "string" } }
          }
        },

        candidates: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            required: ["candidateId", "destination", "rawValue", "normalizedValue",
              "confidence", "confidenceReasons", "conflictState", "requiresResolution",
              "recommendedPrechecked", "evidenceExcerpt"],
            properties: {
              candidateId: { type: "string" },
              destination: destination,
              destinationSection: { type: "string" },
              destinationLabel: { type: "string" },
              rawValue: { type: "string" },
              normalizedValue: { type: "string" },
              displayValue: { type: "string" },
              sensitive: { type: "boolean" },
              filename: { type: "string" },
              sourceUrl: { type: "string" },
              page: intOrNull(),
              evidenceExcerpt: { type: "string" },
              boundingRegion: {
                type: ["object", "null"], additionalProperties: false,
                properties: {
                  x: { type: "number" }, y: { type: "number" },
                  width: { type: "number" }, height: { type: "number" }
                }
              },
              textSource: enumStr(E.TEXT_SOURCES),
              validation: {
                type: "object", additionalProperties: false,
                required: ["valid"],
                properties: {
                  valid: { type: "boolean" },
                  checks: { type: "array", items: { type: "string" } },
                  warnings: { type: "array", items: { type: "string" } },
                  errors: { type: "array", items: { type: "string" } }
                }
              },
              confidence: enumStr(E.CONFIDENCE),
              confidenceReasons: { type: "array", items: { type: "string" } },
              alternatives: { type: "array", items: { type: "string" } },
              existingValue: { type: "string" },
              conflictState: enumStr(E.CONFLICT_STATES),
              requiresResolution: { type: "boolean" },
              recommendedPrechecked: { type: "boolean" }
            }
          }
        },

        rejected: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            required: ["destination", "rawValue", "errors"],
            properties: {
              destination: { type: "string" },
              rawValue: { type: "string" },
              page: intOrNull(),
              evidenceExcerpt: { type: "string" },
              errors: { type: "array", items: { type: "string" } }
            }
          }
        },

        unmappedFindings: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            required: ["label", "value"],
            properties: {
              label: { type: "string" },
              value: { type: "string" },
              page: intOrNull(),
              evidenceExcerpt: { type: "string" }
            }
          }
        },

        sourceRouting: {
          type: "object", additionalProperties: false,
          required: ["business", "primaryCategory", "duplicateStatus"],
          properties: {
            business: enumStr(["centauri", "keypr", "unconfirmed"]),
            primaryCategory: { type: "string" },
            subcategory: { type: "string" },
            documentOrLinkType: { type: "string" },
            linkedDestinations: { type: "array", items: { type: "string" } },
            existingSourceId: { type: "string" },
            duplicateStatus: enumStr(["none", "exact", "likely"]),
            duplicateReasons: { type: "array", items: { type: "string" } }
          }
        },

        review: {
          type: "object", additionalProperties: false,
          required: ["required"],
          properties: {
            required: { type: "boolean" },
            allowSaveSelected: { type: "boolean" },
            allowSaveSourceOnly: { type: "boolean" },
            allowCancel: { type: "boolean" },
            allowUndoAfterSave: { type: "boolean" },
            notes: { type: "array", items: { type: "string" } }
          }
        },

        warnings: { type: "array", items: { type: "string" } }
      }
    };
  };

  /* ---------- local validation of an engine response ----------
     Run over every response before anything is displayed. A response that
     came back schema-constrained is still text produced by a model reading
     an untrusted document, so the contract is checked here rather than
     assumed. Returns { ok, errors[], warnings[], value } where `value` is a
     cleaned copy safe to hand to the review screen. */
  E.validate = function (raw, opts) {
    opts = opts || {};
    var errors = [], warnings = [];

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, errors: ["Response was not a JSON object."], warnings: [], value: null };
    }
    if (raw.schemaVersion !== E.SCHEMA_VERSION) {
      errors.push("schemaVersion was " + JSON.stringify(raw.schemaVersion) +
        ", expected " + E.SCHEMA_VERSION + ".");
    }
    if (E.STATUSES.indexOf(raw.status) < 0) {
      errors.push("status " + JSON.stringify(raw.status) + " is not a known status.");
    }
    if (opts.requestId && raw.requestId !== opts.requestId) {
      errors.push("requestId did not match the request that was sent.");
    }

    var bd = raw.businessDecision;
    if (!bd || typeof bd !== "object") errors.push("businessDecision is missing.");
    else {
      if (E.BUSINESS_RESULTS.indexOf(bd.result) < 0) {
        errors.push("businessDecision.result " + JSON.stringify(bd.result) + " is not valid.");
      }
      if (E.CONFIDENCE.indexOf(bd.confidence) < 0) {
        errors.push("businessDecision.confidence must be High, Medium or Low.");
      }
      // The contract says a person always confirms. Enforce it rather than
      // trusting the engine to have set it.
      if (bd.requiresConfirmation !== true) {
        warnings.push("Engine did not set requiresConfirmation; forcing it on.");
      }
    }

    var cls = raw.classification;
    if (!cls || typeof cls !== "object") errors.push("classification is missing.");
    else if (E.CLASSIFICATION_TYPES.indexOf(cls.type) < 0) {
      errors.push("classification.type " + JSON.stringify(cls.type) + " is not in the registry.");
    }

    if (!Array.isArray(raw.candidates)) errors.push("candidates must be an array.");
    if (!Array.isArray(raw.rejected)) warnings.push("rejected was missing; treated as empty.");

    if (errors.length) return { ok: false, errors: errors, warnings: warnings, value: null };

    // ---- build the cleaned copy
    var allowed = opts.allowedDestinations || null;
    var seenIds = {};
    var candidates = [], dropped = [];

    (raw.candidates || []).forEach(function (c, i) {
      var why = [];
      if (!c || typeof c !== "object") { dropped.push({ index: i, reasons: ["not an object"] }); return; }
      if (typeof c.destination !== "string" || !c.destination) why.push("no destination");
      if (allowed && allowed.indexOf(c.destination) < 0) why.push("destination is not in the mapping registry");
      if (E.CONFIDENCE.indexOf(c.confidence) < 0) why.push("confidence is not High/Medium/Low");
      if (typeof c.normalizedValue !== "string" || !c.normalizedValue.trim()) why.push("no normalized value");
      // Every value must cite evidence — a candidate with none is exactly
      // what this contract exists to prevent.
      if (typeof c.evidenceExcerpt !== "string" || !c.evidenceExcerpt.trim()) why.push("no evidence excerpt");
      if (E.CONFLICT_STATES.indexOf(c.conflictState) < 0) why.push("conflictState is not valid");

      var id = String(c.candidateId || "");
      if (!id) why.push("no candidateId");
      else if (seenIds[id]) why.push("duplicate candidateId");

      if (why.length) { dropped.push({ index: i, destination: c.destination, reasons: why }); return; }
      seenIds[id] = true;

      candidates.push({
        candidateId: id,
        destination: c.destination,
        destinationSection: str(c.destinationSection),
        destinationLabel: str(c.destinationLabel),
        rawValue: str(c.rawValue),
        normalizedValue: String(c.normalizedValue),
        displayValue: str(c.displayValue),
        sensitive: !!c.sensitive,
        filename: str(c.filename),
        sourceUrl: str(c.sourceUrl),
        page: (typeof c.page === "number") ? c.page : null,
        evidenceExcerpt: String(c.evidenceExcerpt),
        boundingRegion: c.boundingRegion || null,
        textSource: E.TEXT_SOURCES.indexOf(c.textSource) >= 0 ? c.textSource : "",
        validation: {
          valid: !!(c.validation && c.validation.valid),
          checks: arr(c.validation && c.validation.checks),
          warnings: arr(c.validation && c.validation.warnings),
          errors: arr(c.validation && c.validation.errors)
        },
        confidence: c.confidence,
        confidenceReasons: arr(c.confidenceReasons),
        alternatives: arr(c.alternatives),
        existingValue: str(c.existingValue),
        conflictState: c.conflictState,
        requiresResolution: !!c.requiresResolution,
        // Precheck is decided here, not by the engine: only High confidence
        // with no conflict may arrive ticked, whatever the engine asked for.
        recommendedPrechecked: c.confidence === "High" &&
          c.conflictState === "empty_destination" &&
          c.recommendedPrechecked === true
      });
    });

    dropped.forEach(function (d) {
      warnings.push("Dropped a proposed value" +
        (d.destination ? " for " + d.destination : "") + ": " + d.reasons.join("; ") + ".");
    });

    var value = {
      schemaVersion: E.SCHEMA_VERSION,
      requestId: str(raw.requestId),
      status: raw.status,
      source: raw.source || {},
      businessDecision: {
        result: bd.result,
        confidence: bd.confidence,
        requiresConfirmation: true,           // always, regardless of the response
        warning: str(bd.warning),
        evidence: arr(bd.evidence).filter(function (e) {
          return e && E.EVIDENCE_KINDS.indexOf(e.kind) >= 0 &&
            (e.business === "centauri" || e.business === "keypr");
        }),
        reasons: arr(bd.reasons).map(String)
      },
      classification: {
        type: cls.type, label: str(cls.label), category: str(cls.category),
        confidence: E.CONFIDENCE.indexOf(cls.confidence) >= 0 ? cls.confidence : "Low",
        reasons: arr(cls.reasons).map(String),
        evidence: arr(cls.evidence).map(String)
      },
      candidates: candidates,
      rejected: arr(raw.rejected),
      unmappedFindings: arr(raw.unmappedFindings),
      sourceRouting: raw.sourceRouting || { business: "unconfirmed", primaryCategory: "", duplicateStatus: "none" },
      review: {
        required: true,                        // never negotiable
        allowSaveSelected: true,
        allowSaveSourceOnly: true,
        allowCancel: true,
        allowUndoAfterSave: true,
        notes: arr(raw.review && raw.review.notes).map(String)
      },
      warnings: arr(raw.warnings).map(String).concat(warnings)
    };

    return { ok: true, errors: [], warnings: warnings, value: value };
  };

  function str(v) { return typeof v === "string" ? v : ""; }
  function arr(v) { return Array.isArray(v) ? v : []; }

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.engineSchema = E;
  if (typeof module !== "undefined" && module.exports) module.exports = E;
})(typeof globalThis !== "undefined" ? globalThis : this);
