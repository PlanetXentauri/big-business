/* ============================================================
   DOCAI · credit — the Business Credit Profile data model.

   "Business credit" is not one number. Each commercial credit provider
   (Dun & Bradstreet, Experian Business, Equifax Business, and any added
   later) publishes several metrics on several scales, and a business can
   have a perfectly real credit file while one particular score is not yet
   available. This module holds all of that without flattening it:

     · every value is an OBSERVATION with its own status, scale, risk label,
       report date, import date and source (document, page, evidence)
     · observations are append-only; a newer report never overwrites an
       older one, it supersedes it — the old value stays as history
     · the CURRENT value of a metric is computed, never stored
     · a metric with no score is recorded as such ("data not available" is
       a legitimate state, distinct from "not detected in this document")
     · facts the UI has no field for are kept as EXTENDED facts so nothing
       a report says is thrown away

   Scales are never normalized across providers. A PAYDEX of 80, a
   Delinquency Score of 24 and an SER rating of 6 are shown on their own
   scales with their own risk labels. No universal score is derived.
   ============================================================ */
(function (root) {
  "use strict";

  var U = (root.DOCAI && root.DOCAI.util) ||
    (typeof require === "function" ? require("./util.js") : null);

  var C = {};

  C.SCHEMA = 1;
  C.STALE_DAYS = 180;

  /* ---------- statuses ----------
     A status describes what the SOURCE said about the metric, separately
     from whatever value it carries. */
  C.STATUSES = {
    available:          { label: "AVAILABLE",          tone: "ok" },
    data_not_available: { label: "DATA NOT AVAILABLE", tone: "muted" },
    not_reported:       { label: "NOT REPORTED",       tone: "muted" },
    not_detected:       { label: "NOT DETECTED",       tone: "muted" },
    pending:            { label: "PENDING",            tone: "warn" },
    stale:              { label: "STALE",              tone: "warn" },
    manual:             { label: "MANUAL",             tone: "info" },
    conflict:           { label: "CONFLICT",           tone: "warn" }
  };

  /* ---------- provider registry ----------
     Adding a provider is adding an entry here (and, for automatic import, a
     parser in credit-extractors.js). Nothing else in the app enumerates
     providers by name.

     Metric fields:
       label          display name
       cls            score | rating | recommendation | risk | payment |
                      public_record | inquiry | identity
       kind           score | rating | category | currency | percent |
                      count | text
       scaleMin/Max   the provider's published scale, shown, never rescaled
       higherIsBetter direction of the scale, for the gauge only
       counted        whether it counts toward "metrics tracked"            */
  C.PROVIDERS = {
    dnb: {
      id: "dnb", label: "Dun & Bradstreet", short: "D&B", major: true,
      identifierLabel: "D-U-N-S", reportLabel: "D&B Credit Insights",
      metrics: {
        paydex:                    { label: "PAYDEX", cls: "score", kind: "score", scaleMin: 1, scaleMax: 100, higherIsBetter: true, counted: true, about: "Payment index — how the business has paid its bills, from reported trade experiences." },
        delinquency_score:         { label: "Delinquency Score", cls: "score", kind: "score", scaleMin: 1, scaleMax: 100, higherIsBetter: true, counted: true, about: "Repayment risk percentile — likelihood of paying on time over the next 12 months." },
        failure_score:             { label: "Failure Score", cls: "score", kind: "score", scaleMin: 1, scaleMax: 100, higherIsBetter: true, counted: true, about: "Insolvency risk percentile — likelihood of ceasing operations in the next 12 months." },
        ser_rating:                { label: "Supplier Evaluation Risk Rating", short: "SER Rating", cls: "rating", kind: "score", scaleMin: 1, scaleMax: 9, higherIsBetter: false, counted: true, about: "Supplier risk, 1 (low) to 9 (high)." },
        dnb_rating:                { label: "D&B Rating", cls: "rating", kind: "rating", counted: true, about: "Composite rating from net worth and financial condition. \"--\" means D&B could not classify the business." },
        overall_business_risk:     { label: "Overall Business Risk", cls: "risk", kind: "category", counted: true, about: "D&B's summary risk category. A category, not a score." },
        max_credit_recommendation: { label: "Maximum Credit Recommendation", cls: "recommendation", kind: "currency", counted: true, about: "The most credit D&B suggests extending. A recommendation, not a score." },
        payment_behavior:          { label: "Overall Payment Behavior", cls: "payment", kind: "text" },
        trade_within_terms:        { label: "% of Trade Within Terms", cls: "payment", kind: "percent" },
        highest_past_due:          { label: "Highest Past Due", cls: "payment", kind: "currency" },
        trade_lines:               { label: "Trade Lines Reported", cls: "payment", kind: "count" },
        suits:                     { label: "Suits", cls: "public_record", kind: "count" },
        judgments:                 { label: "Judgments", cls: "public_record", kind: "count" },
        liens:                     { label: "Liens", cls: "public_record", kind: "count" },
        ucc_filings:               { label: "UCC Filings", cls: "public_record", kind: "count" },
        total_inquiries:           { label: "Total Inquiries", cls: "inquiry", kind: "count" },
        unique_customer_inquiries: { label: "Unique Customer Inquiries", cls: "inquiry", kind: "count" }
      }
    },
    experian: {
      id: "experian", label: "Experian Business", short: "Experian", major: true,
      identifierLabel: "BIN", reportLabel: "Experian Business Credit Report",
      metrics: {
        intelliscore_plus:        { label: "Intelliscore Plus", cls: "score", kind: "score", scaleMin: 1, scaleMax: 100, higherIsBetter: true, counted: true, about: "Experian's business credit score, 1–100." },
        financial_stability_risk: { label: "Financial Stability Risk", cls: "rating", kind: "score", scaleMin: 1, scaleMax: 5, higherIsBetter: false, counted: true, about: "Risk of severe financial distress, 1 (low) to 5 (high)." },
        payment_information:      { label: "Payment Information", cls: "payment", kind: "text" },
        days_beyond_terms:        { label: "Days Beyond Terms", cls: "payment", kind: "count" },
        tradelines:               { label: "Tradelines", cls: "payment", kind: "count" },
        credit_utilization:       { label: "Credit Utilization", cls: "payment", kind: "percent" },
        recommended_credit:       { label: "Recommended Credit Limit", cls: "recommendation", kind: "currency", counted: true },
        business_identification:  { label: "Business Identification", cls: "identity", kind: "text" },
        total_inquiries:          { label: "Inquiries", cls: "inquiry", kind: "count" }
      }
    },
    equifax: {
      id: "equifax", label: "Equifax Business", short: "Equifax", major: true,
      identifierLabel: "Equifax ID", reportLabel: "Equifax Business Credit Report",
      metrics: {
        business_credit_risk_score: { label: "Business Credit Risk Score", cls: "score", kind: "score", scaleMin: 101, scaleMax: 992, higherIsBetter: true, counted: true, about: "Likelihood of severe delinquency, 101–992." },
        business_failure_score:     { label: "Business Failure Score", cls: "score", kind: "score", scaleMin: 1000, scaleMax: 1880, higherIsBetter: true, counted: true, about: "Likelihood of business failure, 1000–1880." },
        payment_index:              { label: "Payment Index", cls: "payment", kind: "score", scaleMin: 0, scaleMax: 100, higherIsBetter: true, counted: true, about: "Payment performance, 0–100." },
        payment_trend:              { label: "Payment Trend", cls: "payment", kind: "text" },
        credit_limit_recommendation:{ label: "Credit Limit Recommendation", cls: "recommendation", kind: "currency", counted: true },
        total_inquiries:            { label: "Inquiries", cls: "inquiry", kind: "count" }
      }
    },
    fico: {
      id: "fico", label: "FICO SBSS", short: "FICO SBSS", major: false,
      reportLabel: "FICO SBSS Report",
      metrics: {
        sbss: { label: "FICO SBSS Score", cls: "score", kind: "score", scaleMin: 0, scaleMax: 300, higherIsBetter: true, counted: true, about: "Small Business Scoring Service, 0–300." }
      }
    },
    creditsafe: {
      id: "creditsafe", label: "Creditsafe", short: "Creditsafe", major: false,
      reportLabel: "Creditsafe Report",
      metrics: {
        creditsafe_score: { label: "Creditsafe Score", cls: "score", kind: "score", scaleMin: 1, scaleMax: 100, higherIsBetter: true, counted: true },
        credit_limit:     { label: "Credit Limit", cls: "recommendation", kind: "currency", counted: true }
      }
    }
  };
  C.MAJOR = ["dnb", "experian", "equifax"];

  C.provider = function (id) { return C.PROVIDERS[id] || null; };

  /* A metric definition, or a generic one for a type the registry does not
     know yet — extended providers can record metrics ahead of the UI. */
  C.metricDef = function (provider, metricType, fallback) {
    var p = C.PROVIDERS[provider];
    var m = p && p.metrics[metricType];
    if (m) return m;
    return {
      label: (fallback && fallback.displayName) || String(metricType).replace(/_/g, " "),
      cls: (fallback && fallback.cls) || "score",
      kind: (fallback && fallback.kind) || "text",
      counted: true, generic: true
    };
  };

  C.key = function (provider, metricType) { return provider + "." + metricType; };
  C.destFor = function (provider, metricType) { return "credit." + provider + "." + metricType; };
  C.parseDest = function (dest) {
    var m = /^credit\.([a-z0-9_]+)\.([a-z0-9_]+)$/.exec(String(dest || ""));
    return m ? { provider: m[1], metricType: m[2] } : null;
  };

  /* Destinations the mapping registry hands the review screen and the
     transaction. Every registered metric gets one; unknown credit.* dests
     are resolved on demand by mapping.js through C.dynamicDestination. */
  C.destinationFor = function (provider, metricType) {
    var p = C.PROVIDERS[provider];
    if (!p) return null;
    var m = C.metricDef(provider, metricType);
    return {
      store: "credit", key: C.destFor(provider, metricType),
      provider: provider, metricType: metricType,
      label: p.short + " " + (m.short || m.label),
      section: "Business Credit · " + p.label,
      checkpoint: "scores",
      noEngine: true
    };
  };
  C.dynamicDestination = function (dest) {
    var p = C.parseDest(dest);
    return p ? C.destinationFor(p.provider, p.metricType) : null;
  };
  C.registerDestinations = function (MAP) {
    Object.keys(C.PROVIDERS).forEach(function (pid) {
      Object.keys(C.PROVIDERS[pid].metrics).forEach(function (mt) {
        var dest = C.destFor(pid, mt);
        if (!MAP.DESTINATIONS[dest]) MAP.DESTINATIONS[dest] = C.destinationFor(pid, mt);
      });
    });
  };

  /* ---------- state shape ---------- */
  C.ensure = function (state, biz) {
    state.credit = state.credit || {};
    var s = state.credit[biz];
    if (!s) s = state.credit[biz] = {};
    s.schema = C.SCHEMA;
    s.observations = s.observations || [];
    s.providers = s.providers || {};
    s.documents = s.documents || [];
    s.extended = s.extended || [];
    s.conflicts = s.conflicts || [];
    return s;
  };

  /* ---------- observations ---------- */
  C.buildObservation = function (input) {
    var def = C.metricDef(input.provider, input.metricType, input);
    return {
      id: input.id || U.uid("obs"),
      provider: input.provider,
      metricType: input.metricType,
      metricKey: C.key(input.provider, input.metricType),
      displayName: input.displayName || def.label,
      cls: input.cls || def.cls,
      kind: input.kind || def.kind,
      value: (input.value === undefined || input.value === null || input.value === "") ? null : input.value,
      valueText: input.valueText || "",
      unit: input.unit || "",
      scaleMin: input.scaleMin != null ? input.scaleMin : (def.scaleMin != null ? def.scaleMin : null),
      scaleMax: input.scaleMax != null ? input.scaleMax : (def.scaleMax != null ? def.scaleMax : null),
      higherIsBetter: input.higherIsBetter != null ? input.higherIsBetter : (def.higherIsBetter != null ? def.higherIsBetter : null),
      riskLevel: input.riskLevel || "",
      status: input.status || (input.value != null || input.valueText ? "available" : "not_reported"),
      details: input.details || {},
      effectiveDate: input.effectiveDate || "",          // the report's own date, ISO
      importedAt: input.importedAt || Date.now(),        // when it entered Big Business
      source: {
        method: (input.source && input.source.method) || "auto",
        documentId: (input.source && input.source.documentId) || null,
        fileName: (input.source && input.source.fileName) || "",
        reportLabel: (input.source && input.source.reportLabel) || "",
        page: (input.source && input.source.page) || null,
        section: (input.source && input.source.section) || "",
        evidence: (input.source && input.source.evidence) || "",
        confidence: (input.source && input.source.confidence) || "",
        reasons: (input.source && input.source.reasons) || [],
        extractionVersion: (input.source && input.source.extractionVersion) || null
      },
      verified: !!input.verified,
      historical: !!input.historical,      // never becomes current
      pinned: !!input.pinned,              // explicitly chosen as current
      note: input.note || ""
    };
  };

  function sameObservation(a, b) {
    return a.metricKey === b.metricKey &&
      (a.source.documentId || "") === (b.source.documentId || "") &&
      a.source.method === b.source.method &&
      String(a.valueText) === String(b.valueText) &&
      a.status === b.status &&
      (a.effectiveDate || "") === (b.effectiveDate || "");
  }

  /* Record an observation. Resolution, when the metric already has a
     current value:
       keep        the new value goes to history only
       replace     the new value is pinned as current
       alternate   both recorded; the report dates decide which is current
       historical  same as keep
     With no resolution the date rule applies. Returns the stored
     observation (an identical one already on file is returned instead of
     being duplicated). */
  C.record = function (state, biz, input, opts) {
    opts = opts || {};
    var s = C.ensure(state, biz);
    var obs = input.metricKey ? input : C.buildObservation(input);
    for (var i = 0; i < s.observations.length; i++) {
      if (sameObservation(s.observations[i], obs)) return { obs: s.observations[i], duplicate: true };
    }
    var res = opts.resolution || "";
    if (res === "keep" || res === "historical") obs.historical = true;
    if (res === "replace") {
      s.observations.forEach(function (o) { if (o.metricKey === obs.metricKey) o.pinned = false; });
      obs.pinned = true;
    }
    s.observations.push(obs);
    return { obs: obs, duplicate: false };
  };

  C.remove = function (state, biz, obsId) {
    var s = C.ensure(state, biz);
    var before = s.observations.length;
    s.observations = s.observations.filter(function (o) { return o.id !== obsId; });
    return s.observations.length < before;
  };

  /* Ordering: a pinned observation wins; otherwise the latest report date,
     then the latest import. Observations without a report date sort last
     among their peers — a dated value always outranks an undated one. */
  function rank(a, b) {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    var da = a.effectiveDate || "", db = b.effectiveDate || "";
    if (da !== db) {
      if (!da) return 1;
      if (!db) return -1;
      return da < db ? 1 : -1;
    }
    return (b.importedAt || 0) - (a.importedAt || 0);
  }

  C.history = function (state, biz, metricKey) {
    var s = C.ensure(state, biz);
    return s.observations.filter(function (o) { return o.metricKey === metricKey; }).sort(rank);
  };

  C.daysOld = function (iso, now) {
    if (!iso) return null;
    var t = Date.parse(iso + "T12:00:00");
    if (isNaN(t)) return null;
    return Math.floor(((now || Date.now()) - t) / 86400000);
  };

  /* The current observation for every metric, with a computed display
     status layered on top (stale, conflict) without touching the record. */
  C.current = function (state, biz, now) {
    var s = C.ensure(state, biz);
    var byKey = {};
    s.observations.forEach(function (o) {
      if (o.historical) return;
      (byKey[o.metricKey] = byKey[o.metricKey] || []).push(o);
    });
    var out = {};
    Object.keys(byKey).forEach(function (k) {
      var list = byKey[k].sort(rank);
      var cur = list[0];
      var view = {};
      Object.keys(cur).forEach(function (f) { view[f] = cur[f]; });
      view.displayStatus = cur.status;
      view.flags = [];
      if (cur.source.method === "manual") view.flags.push("manual");
      if (cur.verified) view.flags.push("verified");
      // Conflict: another live observation with the same report date but a
      // different value, and nobody has pinned a choice.
      var rival = list.filter(function (o) {
        return o !== cur && !cur.pinned && (o.effectiveDate || "") === (cur.effectiveDate || "") &&
          (o.valueText !== cur.valueText || o.status !== cur.status);
      })[0];
      if (rival) { view.displayStatus = "conflict"; view.flags.push("conflict"); view.conflictWith = rival.id; }
      var age = C.daysOld(cur.effectiveDate, now);
      if (age != null && age > C.STALE_DAYS && view.displayStatus === "available") {
        view.flags.push("stale"); view.displayStatus = "stale";
      }
      view.observationCount = list.length + s.observations.filter(function (o) { return o.historical && o.metricKey === k; }).length;
      out[k] = view;
    });
    return out;
  };

  C.conflicts = function (state, biz) {
    var cur = C.current(state, biz);
    return Object.keys(cur).filter(function (k) { return cur[k].displayStatus === "conflict"; }).map(function (k) {
      var s = C.ensure(state, biz);
      var rival = s.observations.filter(function (o) { return o.id === cur[k].conflictWith; })[0];
      return { metricKey: k, current: cur[k], rival: rival };
    });
  };

  /* Resolve a conflict between two live observations of one metric. */
  C.resolveConflict = function (state, biz, keepId, otherId, choice) {
    var s = C.ensure(state, biz);
    var keep = s.observations.filter(function (o) { return o.id === keepId; })[0];
    var other = s.observations.filter(function (o) { return o.id === otherId; })[0];
    if (!keep || !other) return false;
    if (choice === "use_new") { var t = keep; keep = other; other = t; }
    s.observations.forEach(function (o) { if (o.metricKey === keep.metricKey) o.pinned = false; });
    keep.pinned = true;
    if (choice === "historical") other.historical = true;
    return true;
  };

  /* ---------- manual entry and verification ---------- */
  C.manual = function (state, biz, provider, metricType, fields) {
    var cur = C.current(state, biz)[C.key(provider, metricType)];
    var obs = C.buildObservation({
      provider: provider, metricType: metricType,
      value: fields.value, valueText: fields.valueText,
      riskLevel: fields.riskLevel || "",
      status: fields.status || (fields.value != null || fields.valueText ? "available" : "data_not_available"),
      effectiveDate: fields.effectiveDate || (cur && cur.effectiveDate) || "",
      details: fields.details || {},
      note: fields.note || "",
      source: { method: "manual", evidence: fields.note || "Entered by hand", confidence: "Manual" }
    });
    return C.record(state, biz, obs, { resolution: "replace" }).obs;
  };

  C.verify = function (state, biz, obsId, on) {
    var s = C.ensure(state, biz);
    var o = s.observations.filter(function (x) { return x.id === obsId; })[0];
    if (!o) return false;
    o.verified = on !== false;
    return true;
  };

  /* ---------- documents, providers, extended facts ---------- */
  C.registerDocument = function (state, biz, doc) {
    var s = C.ensure(state, biz);
    var existing = s.documents.filter(function (d) { return d.docId === doc.docId; })[0];
    if (existing) {
      Object.keys(doc).forEach(function (k) { if (doc[k] !== undefined) existing[k] = doc[k]; });
      return existing;
    }
    var rec = {
      docId: doc.docId, fileName: doc.fileName || "", provider: doc.provider || "",
      reportLabel: doc.reportLabel || "", reportDate: doc.reportDate || "",
      importedAt: doc.importedAt || Date.now(), pageCount: doc.pageCount || 0,
      metricCount: doc.metricCount || 0, extendedCount: doc.extendedCount || 0,
      extractionVersion: doc.extractionVersion || null, reanalyzedAt: doc.reanalyzedAt || null
    };
    s.documents.unshift(rec);
    if (doc.provider) {
      var p = (s.providers[doc.provider] = s.providers[doc.provider] || { id: doc.provider, documentIds: [] });
      if (p.documentIds.indexOf(doc.docId) < 0) p.documentIds.push(doc.docId);
      if (doc.accountIdentifier) p.accountIdentifier = doc.accountIdentifier;
      if (doc.reportDate && (!p.lastReportDate || doc.reportDate > p.lastReportDate)) p.lastReportDate = doc.reportDate;
      p.lastImportedAt = Math.max(p.lastImportedAt || 0, rec.importedAt);
      p.firstSeen = p.firstSeen || rec.importedAt;
    }
    return rec;
  };

  C.unregisterDocument = function (state, biz, docId) {
    var s = C.ensure(state, biz);
    s.documents = s.documents.filter(function (d) { return d.docId !== docId; });
    Object.keys(s.providers).forEach(function (pid) {
      var p = s.providers[pid];
      p.documentIds = (p.documentIds || []).filter(function (id) { return id !== docId; });
    });
  };

  C.addExtended = function (state, biz, facts, documentId, effectiveDate) {
    var s = C.ensure(state, biz);
    var added = 0;
    (facts || []).forEach(function (f) {
      var dup = s.extended.some(function (e) {
        return e.documentId === (documentId || null) && e.provider === f.provider && e.key === f.key && e.valueText === f.valueText;
      });
      if (dup) return;
      s.extended.push({
        id: U.uid("xf"), provider: f.provider || "", documentId: documentId || null,
        key: f.key, label: f.label || f.key, valueText: String(f.valueText == null ? "" : f.valueText),
        page: f.page || null, section: f.section || "", evidence: f.evidence || "",
        effectiveDate: f.effectiveDate || effectiveDate || "", importedAt: Date.now()
      });
      added++;
    });
    return added;
  };

  /* ---------- formatting ---------- */
  C.formatValue = function (o) {
    if (!o) return "—";
    if (o.status !== "available" && o.status !== "manual" && o.value == null && !o.valueText) return "—";
    if (o.kind === "score" && o.value != null) {
      return String(o.value) + (o.scaleMax != null ? " / " + o.scaleMax : "");
    }
    if (o.kind === "currency" && o.value != null) return C.money(o.value);
    if (o.kind === "percent" && o.value != null) return String(o.value) + "%";
    if (o.kind === "count" && o.value != null) return String(o.value);
    if (o.valueText) return o.valueText;
    if (o.value != null) return String(o.value);
    return "—";
  };
  C.money = function (n) {
    var v = Number(n) || 0;
    return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  };
  C.statusLabel = function (status) {
    return (C.STATUSES[status] || { label: String(status || "").toUpperCase() }).label;
  };
  C.fmtDate = function (iso) {
    if (!iso) return "";
    var t = Date.parse(iso + "T12:00:00");
    if (isNaN(t)) return iso;
    return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  /* The legacy single-value fields on the Financials tab are mirrored from
     the current numeric value of a few well-known metrics, so the old form
     and the old AUTO logic keep working. Only an available numeric score is
     ever mirrored; "data not available" writes nothing. */
  C.LEGACY_MIRROR = {
    "dnb.paydex": "paydex",
    "experian.intelliscore_plus": "intelliscore",
    "equifax.business_credit_risk_score": "equifax",
    "fico.sbss": "fico"
  };
  C.mirrorFor = function (o) {
    var key = C.LEGACY_MIRROR[o.metricKey];
    if (!key || o.status !== "available" || o.value == null) return null;
    return { key: key, value: String(o.value) };
  };

  /* ---------- provider status ---------- */
  C.providerStatus = function (state, biz, pid, now) {
    var s = C.ensure(state, biz);
    var cur = C.current(state, biz, now);
    var p = s.providers[pid] || null;
    var metrics = Object.keys(cur).filter(function (k) { return cur[k].provider === pid; }).map(function (k) { return cur[k]; });
    var counted = metrics.filter(function (o) { return C.metricDef(pid, o.metricType, o).counted; });
    var available = counted.filter(function (o) { return o.status === "available" || o.source.method === "manual"; });
    var docs = s.documents.filter(function (d) { return d.provider === pid; });
    var detected = !!p || metrics.length > 0 || docs.length > 0;
    return {
      id: pid,
      def: C.provider(pid),
      detected: detected,
      status: !detected ? "no_report" : (available.length ? "profile_detected" : "profile_no_scores"),
      accountIdentifier: (p && p.accountIdentifier) || "",
      lastReportDate: (p && p.lastReportDate) || docs.map(function (d) { return d.reportDate; }).sort().pop() || "",
      lastImportedAt: (p && p.lastImportedAt) || 0,
      metricsTracked: counted.length,
      metricsAvailable: available.length,
      activeScores: available.filter(function (o) { return o.kind === "score" && o.value != null; }).length,
      metrics: metrics,
      documents: docs
    };
  };

  /* ---------- the profile summary ----------
     Drives the checklist row, the summary cards and the overview. Every
     number here is read from stored observations; nothing is invented. */
  C.summary = function (state, biz, now) {
    now = now || Date.now();
    var s = C.ensure(state, biz);
    var cur = C.current(state, biz, now);
    var providers = {};
    var all = Object.keys(C.PROVIDERS).concat(Object.keys(s.providers)).filter(function (v, i, a) { return a.indexOf(v) === i; });
    all.forEach(function (pid) { providers[pid] = C.providerStatus(state, biz, pid, now); });

    var established = all.filter(function (pid) { return providers[pid].status === "profile_detected"; });
    var detected = all.filter(function (pid) { return providers[pid].detected; });
    var majorDetected = C.MAJOR.filter(function (pid) { return providers[pid].detected; });

    var scores = Object.keys(cur).map(function (k) { return cur[k]; })
      .filter(function (o) { return o.kind === "score" && o.value != null && (o.status === "available" || o.source.method === "manual"); });
    var paymentBased = Object.keys(cur).map(function (k) { return cur[k]; })
      .filter(function (o) { return (o.metricType === "paydex" || o.metricType === "payment_index") && o.status === "available" && o.value != null; });

    var status, label, line;
    if (!detected.length) {
      status = "not_started"; label = "NOT STARTED";
      line = "No commercial credit provider or credit file detected yet.";
    } else if (!established.length) {
      status = "partial"; label = "PARTIAL";
      line = detected.map(function (p) { return providers[p].def ? providers[p].def.short : p; }).join(", ") +
        " file detected, but no usable score or rating is on record yet.";
    } else if (established.length >= 2 || (scores.length >= 3 && paymentBased.length)) {
      status = "strong"; label = "STRONG DATA";
      line = established.length + " bureau(s) established · " + scores.length + " active score(s)";
    } else {
      status = "established"; label = "ESTABLISHED";
      var pid = established[0], ps = providers[pid];
      line = (ps.def ? ps.def.short : pid) + " profile established · " + ps.metricsAvailable + " metric" + (ps.metricsAvailable === 1 ? "" : "s") + " detected";
    }

    var rec = firstOf(cur, ["dnb.max_credit_recommendation", "experian.recommended_credit", "equifax.credit_limit_recommendation", "creditsafe.credit_limit"]);
    var risk = firstOf(cur, ["dnb.overall_business_risk"]);
    var dates = Object.keys(cur).map(function (k) { return cur[k].effectiveDate; }).filter(Boolean).sort();
    var imports = Object.keys(cur).map(function (k) { return cur[k].importedAt || 0; });

    return {
      status: status, statusLabel: label, line: line,
      complete: status === "established" || status === "strong",
      bureausDetected: majorDetected.length, bureausTotal: C.MAJOR.length,
      majorDetected: majorDetected, providersDetected: detected, providersEstablished: established,
      activeScores: scores.length,
      metricsTracked: Object.keys(cur).filter(function (k) { return C.metricDef(cur[k].provider, cur[k].metricType, cur[k]).counted; }).length,
      creditRecommendation: rec ? { text: C.formatValue(rec), obs: rec } : null,
      overallRisk: risk ? { text: risk.valueText || risk.riskLevel, obs: risk } : null,
      lastReportDate: dates.length ? dates[dates.length - 1] : "",
      lastImportedAt: imports.length ? Math.max.apply(null, imports) : 0,
      providers: providers,
      current: cur,
      snapshot: C.snapshot(cur),
      conflicts: C.conflicts(state, biz),
      actions: C.actions(state, biz, cur, providers),
      quality: C.quality(cur),
      documentCount: s.documents.length
    };
  };

  function firstOf(cur, keys) {
    for (var i = 0; i < keys.length; i++) {
      var o = cur[keys[i]];
      if (o && (o.status === "available" || o.source.method === "manual")) return o;
    }
    return null;
  }

  C.snapshot = function (cur) {
    function num(k) { var o = cur[k]; return o && o.status === "available" && o.value != null ? o.value : null; }
    var records = { suits: num("dnb.suits"), judgments: num("dnb.judgments"), liens: num("dnb.liens"), ucc: num("dnb.ucc_filings") };
    var anyRecords = Object.keys(records).some(function (k) { return records[k] != null; });
    var inq = { total: num("dnb.total_inquiries"), unique: num("dnb.unique_customer_inquiries") };
    return {
      publicRecords: anyRecords ? records : null,
      inquiries: inq.total != null ? inq : null
    };
  };

  /* Action items are derived from evidence actually present in the stored
     observations. A missing report is stated neutrally, never as a fault. */
  C.actions = function (state, biz, cur, providers) {
    var out = [];
    var paydex = cur["dnb.paydex"];
    var factors = [];
    Object.keys(cur).forEach(function (k) {
      ((cur[k].details && cur[k].details.factors) || []).forEach(function (f) { if (factors.indexOf(f) < 0) factors.push(f); });
    });
    var noPayments = factors.some(function (f) { return /no payment experiences/i.test(f); }) ||
      (cur["dnb.payment_behavior"] && cur["dnb.payment_behavior"].status === "data_not_available");

    if (paydex && paydex.status === "data_not_available") {
      out.push({
        metric: "PAYDEX", tone: "wait",
        title: "Waiting for sufficient payment experiences",
        detail: noPayments
          ? "The D&B report shows no trade payment experiences on file, so no PAYDEX can be calculated yet."
          : "The D&B report does not carry a PAYDEX score.",
        next: "Add vendor / trade accounts that report payment history to D&B, and pay them on time."
      });
    }
    if (factors.some(function (f) { return /financial statements not reported/i.test(f); })) {
      out.push({ metric: "SER Rating", tone: "info", title: "Financial statements not reported",
        detail: "D&B lists unreported financials as a factor in the Supplier Evaluation Risk rating.",
        next: "Upload financial statements through D-U-N-S Manager." });
    }
    var rating = cur["dnb.dnb_rating"];
    if (rating && rating.status === "data_not_available") {
      out.push({ metric: "D&B Rating", tone: "info", title: "No D&B Rating assigned yet",
        detail: "The report shows \"--\": D&B could not classify the business within its Rating Key" +
          (rating.details && rating.details.previous ? " (previous: " + rating.details.previous + ")" : "") + ".",
        next: "Reporting payments and financials to D&B is what the report itself lists as the way to change this." });
    }
    if (factors.some(function (f) { return /limited time (in business|under present management)/i.test(f); })) {
      out.push({ metric: "Time in business", tone: "info", title: "Limited time in business is a factor",
        detail: "Several D&B scores cite limited time in business or under present management.", next: "This improves on its own; keep the file accurate meanwhile." });
    }
    C.MAJOR.forEach(function (pid) {
      if (!providers[pid].detected) {
        out.push({ metric: C.PROVIDERS[pid].short, tone: "neutral", title: "No " + C.PROVIDERS[pid].short + " report imported yet",
          detail: "Nothing is known about this bureau's file — that is not a bad score, just no data.",
          next: "Import a " + C.PROVIDERS[pid].label + " report to track it here." });
      }
    });
    return out;
  };

  /* Data-quality notes: unusual or incomplete data reported by the source. */
  C.quality = function (cur) {
    var out = [];
    Object.keys(cur).forEach(function (k) {
      var o = cur[k];
      if (o.status === "data_not_available" && C.metricDef(o.provider, o.metricType, o).counted) {
        out.push({ metricKey: k, label: o.displayName, status: o.status,
          reason: (o.details && o.details.reason) || "The source recognises this metric but reports no value." });
      }
      if (o.displayStatus === "conflict") {
        out.push({ metricKey: k, label: o.displayName, status: "conflict", reason: "Two sources with the same report date disagree — review below." });
      }
      if (o.displayStatus === "stale") {
        out.push({ metricKey: k, label: o.displayName, status: "stale", reason: "The latest report is more than " + C.STALE_DAYS + " days old." });
      }
    });
    return out;
  };

  /* ---------- trend ----------
     One point per month between the earliest and latest dated observation.
     A month with no report is null, never zero. */
  C.trend = function (state, biz, metricKey) {
    var list = C.history(state, biz, metricKey).filter(function (o) { return o.effectiveDate && o.value != null; });
    if (list.length < 2) return null;
    var months = {};
    list.forEach(function (o) {
      var m = o.effectiveDate.slice(0, 7);
      if (!months[m] || months[m].effectiveDate < o.effectiveDate) months[m] = o;
    });
    var keys = Object.keys(months).sort();
    var first = keys[0], last = keys[keys.length - 1];
    var out = [];
    var y = parseInt(first.slice(0, 4), 10), mo = parseInt(first.slice(5, 7), 10);
    var guard = 0;
    while (guard++ < 120) {
      var key = y + "-" + (mo < 10 ? "0" : "") + mo;
      var o = months[key];
      out.push({ month: key, label: new Date(y, mo - 1, 1).toLocaleDateString("en-US", { month: "short" }) + (mo === 1 || out.length === 0 ? " " + y : ""), value: o ? o.value : null, obs: o || null });
      if (key === last) break;
      mo++; if (mo > 12) { mo = 1; y++; }
    }
    return out;
  };

  /* Given a metric already on file and an incoming observation, describe
     what the date rule will do — so the review screen can explain the
     default before anything is saved. */
  C.compare = function (existing, incoming) {
    if (!existing) return { relation: "new", defaultResolution: "alternate", ambiguous: false };
    var a = existing.effectiveDate || "", b = incoming.effectiveDate || "";
    var sameValue = existing.valueText === incoming.valueText && existing.status === incoming.status;
    if (a && b && b > a) return { relation: "newer", defaultResolution: "alternate", ambiguous: false, sameValue: sameValue };
    // An older report is simply recorded; the date rule keeps the newer
    // value current, and if the newer one is ever undone this one takes over.
    if (a && b && b < a) return { relation: "older", defaultResolution: "alternate", ambiguous: false, sameValue: sameValue };
    if (a && b && a === b) return { relation: sameValue ? "same" : "same_date_differs", defaultResolution: sameValue ? "alternate" : "keep", ambiguous: !sameValue, sameValue: sameValue };
    return { relation: "undated", defaultResolution: "keep", ambiguous: true, sameValue: sameValue };
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.credit = C;
  // In the browser mapping.js has already loaded; register the credit
  // destinations now so the review screen and transaction can resolve them.
  if (root.DOCAI.mapping && root.DOCAI.mapping.DESTINATIONS) C.registerDestinations(root.DOCAI.mapping);
  if (typeof module !== "undefined" && module.exports) module.exports = C;
})(typeof globalThis !== "undefined" ? globalThis : this);
