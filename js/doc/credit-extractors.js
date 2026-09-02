/* ============================================================
   DOCAI · credit-extractors — commercial credit reports → observations.

   A credit report is not a form with labelled blanks; it is a set of
   gauges, each on its own scale, with "DATA NOT AVAILABLE" printed where a
   score does not exist yet. So this parser is section-aware: it identifies
   which page describes which metric and reads the value, scale, risk band
   and supporting figures from that section only. Two numbers standing next
   to each other on the summary page are never assumed to belong to the
   same metric.

   Two text layouts are handled. PDF.js (what the app uses) rebuilds lines by
   baseline and separates columns with a double space; plain text extraction
   puts each cell on its own line. Every lookup below works on either.

   Output observations carry status separately from value:
     available / data_not_available / not_reported / not_detected
   and every one names its page, section and quoted evidence.
   ============================================================ */
(function (root) {
  "use strict";

  var U = (root.DOCAI && root.DOCAI.util) ||
    (typeof require === "function" ? require("./util.js") : null);
  var V = (root.DOCAI && root.DOCAI.validators) ||
    (typeof require === "function" ? require("./validators.js") : null);

  var X = {};
  X.VERSION = 1;

  var DNA = "DATA NOT AVAILABLE";
  var RISK_RX = /^(LOW-MODERATE|MODERATE-HIGH|MODERATE|LOW|HIGH)(?:\s+RISK)?$/i;

  /* ---------- text helpers ---------- */
  function lines(text) {
    return String(text || "").split(/\r?\n/).map(function (l) { return l.replace(/\s+$/, ""); });
  }
  function cells(line) {
    return String(line || "").split(/\s{2,}/).map(function (c) { return c.trim(); }).filter(Boolean);
  }
  function norm(s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); }
  function titleRisk(s) {
    var t = String(s || "").replace(/\s+RISK$/i, "").trim();
    if (!t) return "";
    return t.split("-").map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }).join("-");
  }
  function isoDate(s) {
    if (!s) return "";
    var v = V.date(s);
    return v.ok ? v.value : "";
  }
  function quote(s) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, 160); }

  /* A label's value: on the same line ("Registered Name  KEYPR ON COMPANY"
     or "Registered Name: X"), else in the same column of one of the next
     few lines. Exact cell match only — "Raw Score: D&B calculates…" in the
     glossary does not match "Raw Score". */
  /* `known` lists the other labels that share the page, so a neighbouring
     header cell ("Line of Business  Employees") is never read as a value. */
  function labelValue(L, label, rx, depth, known) {
    depth = depth || 3;
    var want = norm(label);
    var isKnown = function (cell) {
      var n = norm(cell).replace(/:$/, "");
      return n === want || (known || []).some(function (k) { return norm(k) === n; });
    };
    for (var i = 0; i < L.length; i++) {
      var cs = cells(L[i]);
      var col = -1;
      for (var c = 0; c < cs.length; c++) if (norm(cs[c]) === want || norm(cs[c]) === want + ":") { col = c; break; }
      if (col < 0) {
        // "Label  value" in one cell (single spaces) — plain-text layouts.
        var m = new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:?\\s+(.+)$", "i").exec(L[i].trim());
        if (m && rx.test(m[1].trim()) && !isKnown(m[1])) return { value: m[1].trim(), line: i, excerpt: L[i].trim() };
        continue;
      }
      if (cs[col + 1] && rx.test(cs[col + 1]) && !isKnown(cs[col + 1])) {
        return { value: cs[col + 1], line: i, excerpt: L[i].trim() };
      }
      for (var j = i + 1; j <= Math.min(L.length - 1, i + depth); j++) {
        var cs2 = cells(L[j]);
        if (cs2.length > col && rx.test(cs2[col]) && !isKnown(cs2[col])) return { value: cs2[col], line: j, excerpt: L[i].trim() + " → " + L[j].trim() };
      }
    }
    return null;
  }

  /* The risk band printed on a gauge page: a standalone cell such as
     "MODERATE-HIGH" or "LOW-MODERATE RISK". Legend rows ("HIGH RISK  8-9")
     and the "Low Risk  High Risk" axis are skipped. */
  function riskOn(L) {
    for (var i = 0; i < L.length; i++) {
      var cs = cells(L[i]);
      if (cs.length >= 2 && cs.every(function (c) { return /^(Low|High) Risk$/i.test(c); })) continue;
      var hasRange = cs.some(function (c) { return /^\d(?:-\d)?$/.test(c); });
      for (var c = 0; c < cs.length; c++) {
        if (!RISK_RX.test(cs[c])) continue;
        if (hasRange && cs.length <= 2) break;       // legend row
        if (/^(HIGH|MODERATE|LOW-MODERATE|LOW) RISK$/i.test(cs[c]) && hasRange) break;
        return { risk: titleRisk(cs[c]), excerpt: L[i].trim(), line: i };
      }
    }
    return null;
  }

  /* The number in a gauge. With PDF.js items the value is the numeral drawn
     in the largest type on the page — the one big number. From text alone,
     it is the standalone in-range number that is not part of the scale
     ("1 … 100"), the chart axis (100 80 60 40 20 0), the legend, or the
     Raw Score / Class row. */
  function gaugeValue(page, L, min, max) {
    var byFont = null, byText = null, notes = [];
    if (page.items && page.items.length) {
      var nums = page.items.filter(function (it) { return /^\d{1,4}$/.test(String(it.str).trim()); })
        .map(function (it) { return { n: parseInt(it.str, 10), h: (it.bbox && it.bbox.h) || 0, str: it.str.trim() }; })
        .filter(function (it) { return it.n >= min && it.n <= max; });
      if (nums.length) {
        nums.sort(function (a, b) { return b.h - a.h; });
        var top = nums[0];
        var next = nums.filter(function (it) { return it.h < top.h - 0.5; })[0];
        if (top.h >= 13 && (!next || top.h >= next.h * 1.35)) byFont = top.n;
      }
    }
    var cands = [];
    var runLen = 0;
    for (var i = 0; i < L.length; i++) {
      var cs = cells(L[i]);
      var numeric = cs.filter(function (c) { return /^\d{1,4}$/.test(c); });
      // chart axis: a run of single-number lines
      if (cs.length === 1 && numeric.length === 1) runLen++; else runLen = 0;
      if (runLen >= 2) { cands = cands.filter(function (c) { return c.line < i - runLen + 1; }); }
      var prev = i > 0 ? cells(L[i - 1]) : [];
      var afterRaw = prev.some(function (c) { return /^raw score$/i.test(c) || /^class$/i.test(c); });
      var scaleLine = numeric.indexOf(String(min)) >= 0 && numeric.indexOf(String(max)) >= 0;
      var legend = cs.some(function (c) { return /^(HIGH|MODERATE|LOW-MODERATE|LOW) RISK$/i.test(c); }) && cs.some(function (c) { return /^\d(?:-\d)?$/.test(c); });
      if (afterRaw || scaleLine || legend) continue;
      for (var c = 0; c < cs.length; c++) {
        if (!/^\d{1,4}$/.test(cs[c])) continue;
        var n = parseInt(cs[c], 10);
        if (n < min || n > max) continue;
        if (/^\d+\s+(months?|years?|days?)/i.test(cs[c] + " " + (cs[c + 1] || ""))) continue;
        cands.push({ n: n, line: i, excerpt: L[i].trim() });
      }
    }
    // Drop axis runs retroactively: lines that were part of a run of >= 4.
    var run = [], keep = [];
    for (var k = 0; k < cands.length; k++) {
      var c1 = cands[k];
      if (run.length && c1.line === run[run.length - 1].line + 1 && cells(L[c1.line]).length === 1) run.push(c1);
      else { if (run.length < 4) keep = keep.concat(run); run = [c1]; }
    }
    if (run.length < 4) keep = keep.concat(run);
    var distinct = keep.map(function (c) { return c.n; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (distinct.length === 1) byText = keep[0];
    else if (distinct.length > 1) notes.push("several standalone numbers in range: " + distinct.join(", "));

    if (byFont != null && byText && byFont === byText.n) return { value: byFont, confidence: "High", method: "font-size + layout", excerpt: byText.excerpt, notes: notes };
    if (byFont != null && byText) { notes.push("layout suggested " + byText.n + ", the large numeral reads " + byFont); return { value: byFont, confidence: "Medium", method: "font-size", excerpt: byText.excerpt, notes: notes }; }
    if (byFont != null) return { value: byFont, confidence: "High", method: "font-size", excerpt: "", notes: notes };
    if (byText) return { value: byText.n, confidence: "Medium", method: "layout", excerpt: byText.excerpt, notes: notes };
    return { value: null, confidence: "", method: "", excerpt: "", notes: notes };
  }

  /* Factors the report lists as affecting a score or rating. */
  var FACTOR_RX = [
    /No payment experiences(?: reported)?/i, /Limited time under present management control/i,
    /Limited time in business/i, /Higher risk region based on delinquency rates/i,
    /Higher risk industry based on delinquency rates/i, /Limited business activity signals reported/i,
    /Financial statements not reported/i, /Phone number not reported/i,
    /Business belongs to a region with above average risk/i, /Business belongs to an industry with above average/i,
    /Payment experiences reported/i
  ];
  function factorsOn(text) {
    var out = [];
    FACTOR_RX.forEach(function (rx) {
      var m = rx.exec(text);
      if (m) {
        var f = m[0].replace(/\s+/g, " ").trim();
        if (out.indexOf(f) < 0) out.push(f);
      }
    });
    return out;
  }

  /* ---------- provider detection ---------- */
  X.detect = function (text) {
    var t = String(text || "");
    var scores = {
      dnb: (/dun\s*&?\s*bradstreet/i.test(t) ? 2 : 0) + (/D\s?&?\s?B Credit Insights/i.test(t) ? 3 : 0) + (/paydex/i.test(t) ? 2 : 0) + (/d-u-n-s/i.test(t) ? 1 : 0),
      experian: (/experian/i.test(t) ? 2 : 0) + (/intelliscore/i.test(t) ? 3 : 0) + (/financial stability risk/i.test(t) ? 1 : 0),
      equifax: (/equifax/i.test(t) ? 2 : 0) + (/business credit risk score/i.test(t) ? 2 : 0) + (/business failure score/i.test(t) ? 1 : 0) + (/payment index/i.test(t) ? 1 : 0),
      fico: (/\bsbss\b/i.test(t) ? 3 : 0),
      creditsafe: (/creditsafe/i.test(t) ? 3 : 0)
    };
    var best = null;
    Object.keys(scores).forEach(function (k) { if (scores[k] > 0 && (!best || scores[k] > scores[best])) best = k; });
    var format = "generic";
    if (best === "dnb" && /Credit Insights/i.test(t) && /(Risk Assessment - Scores and Ratings|Prepared for [^\n]+ on )/i.test(t)) format = "dnb_credit_insights";
    return { provider: best, format: format, scores: scores };
  };

  /* ---------- the D&B Credit Insights parser ---------- */
  function insightsPages(pages) {
    return (pages || []).map(function (p) {
      var L = lines(p.text);
      var t = p.text || "";
      return {
        page: p, n: p.page, text: t, L: L,
        isSummary: /PAYDEX[®]?\s+DELINQUENCY SCORE/i.test(t) || (/PAYDEX/i.test(t) && /DELINQUENCY SCORE/i.test(t) && /FAILURE SCORE/i.test(t) && /SER RATING/i.test(t)),
        isPaydex: /PAYDEX[®]?\s+Score/i.test(t) && /Payment Behavior/i.test(t),
        isDelinquency: /^Delinquency Score$/m.test(t) && /Raw Score/.test(t) && !/^Failure Score$/m.test(t),
        isFailure: /^Failure Score$/m.test(t) && /Raw Score/.test(t) && !/^Delinquency Score$/m.test(t),
        isSer: /Supplier Evaluation Risk/i.test(t) && /SER RATING/.test(t),
        isMcr: /^Maximum Credit Recommendation$/m.test(t) && /Overall Business Risk/.test(t),
        isRating: /^D&B Rating$/m.test(t) && /(Previous Rating|Previous Score)/i.test(t),
        isPayment: /^Payment History$/m.test(t) && /Trade Payments/.test(t),
        isTradeLines: /^Trade Lines$/m.test(t),
        isOps: /SUITS/.test(t) && /JUDGMENTS/.test(t) && /LIENS/.test(t) && /D-U-N-S Number/.test(t),
        isInquiries: /TOTAL INQUIRIES/.test(t),
        isRegistration: /Business Registration/.test(t) && /Registered Name/.test(t),
        isActivities: /Business Activities and Employees/.test(t),
        isSubmissions: /Submitted Documents/.test(t) && /Total Submissions/.test(t)
      };
    });
  }

  X.parseDnbInsights = function (pages) {
    var P = insightsPages(pages);
    var full = pages.map(function (p) { return p.text; }).join("\n");
    var out = { provider: "dnb", format: "dnb_credit_insights", reportLabel: "D&B Credit Insights",
      reportDate: "", businessName: "", identifiers: {}, observations: [], extended: [], notes: [], version: X.VERSION };

    var dm = /Prepared for [^\n]*? on ([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/.exec(full);
    if (dm) out.reportDate = isoDate(dm[1]);
    var bm = /(?:^|\n)D\s?B Credit Insights\s*\n([^\n]{3,80})\n/.exec(full) || /([^\n]{3,80})\s+Prepared for /.exec(full);
    if (bm) out.businessName = bm[1].trim();
    var dunsM = /D-U-N-S Number[^\d]{0,40}(\d{2}-?\d{3}-?\d{4})/.exec(full);
    if (dunsM) { var dv = V.duns(dunsM[1]); if (dv.ok) out.identifiers.duns = dv.value; }

    var seen = {};
    function add(o) {
      if (seen[o.metricType]) {
        var prev = seen[o.metricType];
        if (prev.valueText !== o.valueText && o.status === "available" && prev.status === "available") {
          out.notes.push(o.displayName + " appears twice with different values (" + prev.valueText + " on page " + prev.source.page + ", " + o.valueText + " on page " + o.source.page + "); the first was kept.");
        }
        return;
      }
      seen[o.metricType] = o;
      out.observations.push(o);
    }
    function obs(metricType, page, fields) {
      var o = {
        provider: "dnb", metricType: metricType, displayName: fields.displayName,
        value: fields.value == null ? null : fields.value, valueText: fields.valueText || "",
        riskLevel: fields.riskLevel || "", status: fields.status,
        scaleMin: fields.scaleMin, scaleMax: fields.scaleMax,
        details: fields.details || {}, effectiveDate: fields.effectiveDate || out.reportDate,
        source: { page: page, section: fields.section || "", evidence: fields.evidence || "",
          confidence: fields.confidence || "Medium", reasons: fields.reasons || [], reportLabel: out.reportLabel, extractionVersion: X.VERSION }
      };
      return o;
    }

    // --- summary row: PAYDEX | DELINQUENCY | FAILURE, in that column order.
    var summary = null;
    P.filter(function (p) { return p.isSummary; }).forEach(function (p) {
      if (summary) return;
      var rx = /^(DATA NOT AVAILABLE|\d{1,3})\s+(DATA NOT AVAILABLE|\d{1,3})\s+(DATA NOT AVAILABLE|\d{1,3})$/;
      for (var i = 0; i < p.L.length; i++) {
        var m = rx.exec(p.L[i].trim());
        if (m) { summary = { paydex: m[1], delinquency: m[2], failure: m[3], page: p.n, excerpt: p.L[i].trim() }; break; }
      }
    });

    // --- PAYDEX
    P.filter(function (p) { return p.isPaydex || p.isSummary; }).forEach(function (p) {
      if (seen.paydex) return;
      var value = null, status = "not_detected", evidence = "", conf = "Medium", reasons = [];
      if (summary) {
        if (summary.paydex === DNA) { status = "data_not_available"; evidence = "PAYDEX® — " + DNA + " (summary row: “" + summary.excerpt + "”)"; conf = "High"; reasons.push("Read from the PAYDEX column of the scores summary row"); }
        else { var n = parseInt(summary.paydex, 10); if (n >= 1 && n <= 100) { value = n; status = "available"; evidence = "PAYDEX® — " + n + " (summary row: “" + summary.excerpt + "”)"; conf = "High"; reasons.push("Read from the PAYDEX column of the scores summary row"); } }
      }
      // confirm on the PAYDEX section itself
      var idx = -1;
      for (var i = 0; i < p.L.length; i++) {
        var cs = cells(p.L[i]);
        if (cs.some(function (c) { return /^PAYDEX[®]?$/i.test(c); })) { idx = i; break; }
      }
      if (idx >= 0) {
        for (var j = idx + 1; j <= Math.min(p.L.length - 1, idx + 5); j++) {
          var cj = cells(p.L[j]);
          if (cj[0] === DNA) {
            if (status === "not_detected") { status = "data_not_available"; evidence = "PAYDEX® — " + DNA; conf = "High"; }
            reasons.push("The PAYDEX section prints “DATA NOT AVAILABLE”");
            break;
          }
          if (/^\d{1,3}$/.test(cj[0]) && status === "not_detected") {
            var v = parseInt(cj[0], 10);
            if (v >= 1 && v <= 100) { value = v; status = "available"; evidence = "PAYDEX® — " + v; reasons.push("Read from the PAYDEX section"); break; }
          }
        }
      }
      if (status === "not_detected") return;
      var details = {};
      var paymentDna = P.some(function (q) { return q.isPayment && /OVERALL PAYMENT[\s\S]{0,80}DATA NOT AVAILABLE/.test(q.text); });
      var factors = factorsOn(full);
      if (status === "data_not_available") {
        details.reason = paymentDna || factors.some(function (f) { return /no payment experiences/i.test(f); })
          ? "Insufficient payment information reported — the report shows no trade payment experiences."
          : "The report recognises PAYDEX but prints no score.";
      }
      details.factors = factors.filter(function (f) { return /payment/i.test(f); });
      add(obs("paydex", p.n, { displayName: "PAYDEX", value: value, valueText: value != null ? String(value) : "", status: status,
        scaleMin: 1, scaleMax: 100, section: "Risk Assessment — PAYDEX® Score", evidence: evidence, confidence: conf, reasons: reasons, details: details }));
    });

    // --- Delinquency / Failure (percentile scores with raw score, class, probabilities)
    function scorePage(p, metricType, displayName, probLabel, summaryKey, band) {
      var g = gaugeValue(p.page, p.L, 1, 100);
      var risk = riskOn(p.L);
      var details = { factors: factorsOn(p.text) };
      var raw = labelValue(p.L, "Raw Score", /^[\d,]{2,6}$/, 3);
      var cls = labelValue(p.L, "Class", /^\d$/, 3);
      var prob = labelValue(p.L, probLabel, /^\d+(\.\d+)?%$/, 5);
      var ind = labelValue(p.L, "Industry Avg. Probability", /^\d+(\.\d+)?%$/, 5);
      if (raw) details.rawScore = parseInt(raw.value.replace(/,/g, ""), 10);
      if (cls) details.class = parseInt(cls.value, 10);
      if (prob) details.probability = prob.value;
      if (ind) details.industryAverage = ind.value;
      var reasons = [];
      var conf = g.confidence || "Medium";
      if (g.value != null) reasons.push("Gauge value read by " + g.method + " on page " + p.n);
      if (summary && summary[summaryKey] && summary[summaryKey] !== DNA) {
        var sv = parseInt(summary[summaryKey], 10);
        if (g.value == null) { g.value = sv; conf = "Medium"; reasons.push("Taken from the summary row; the section page did not yield a value"); }
        else if (sv === g.value) { conf = "High"; reasons.push("Matches the " + displayName + " column of the summary row"); }
        else { conf = "Low"; reasons.push("Summary row shows " + sv + " but the section page shows " + g.value + " — review"); }
      }
      g.notes.forEach(function (n) { reasons.push(n); });
      var status = g.value != null ? "available" : (/DATA NOT AVAILABLE/.test(p.text) ? "data_not_available" : "not_reported");
      var evidence = band.toUpperCase() + " — " + (g.value != null ? g.value : "—") + (risk ? " — " + risk.risk.toUpperCase() : "");
      add(obs(metricType, p.n, { displayName: displayName, value: g.value, valueText: g.value != null ? String(g.value) : "", status: status,
        riskLevel: risk ? risk.risk : "", scaleMin: 1, scaleMax: 100, section: "Risk Assessment — " + displayName,
        evidence: evidence + (g.excerpt ? " · “" + quote(g.excerpt) + "”" : ""), confidence: conf, reasons: reasons, details: details }));
    }
    P.filter(function (p) { return p.isDelinquency; }).forEach(function (p) { scorePage(p, "delinquency_score", "Delinquency Score", "Probability of Delinquency", "delinquency", "Delinquency Score — Repayment Risk"); });
    P.filter(function (p) { return p.isFailure; }).forEach(function (p) { scorePage(p, "failure_score", "Failure Score", "Probability of Failure", "failure", "Failure Score — Insolvency Risk"); });

    // --- SER rating (1–9, lower is better)
    P.filter(function (p) { return p.isSer; }).forEach(function (p) {
      var g = gaugeValue(p.page, p.L, 1, 9);
      var risk = riskOn(p.L);
      var reasons = g.value != null ? ["Gauge value read by " + g.method + " on page " + p.n] : [];
      g.notes.forEach(function (n) { reasons.push(n); });
      var status = g.value != null ? "available" : (/DATA NOT AVAILABLE/.test(p.text) ? "data_not_available" : "not_reported");
      add(obs("ser_rating", p.n, { displayName: "Supplier Evaluation Risk Rating", value: g.value, valueText: g.value != null ? String(g.value) : "", status: status,
        riskLevel: risk ? risk.risk : "", scaleMin: 1, scaleMax: 9, section: "Risk Assessment — Supplier Evaluation Risk (SER®) Rating",
        evidence: "SER RATING — SUPPLIER RISK — " + (g.value != null ? g.value : "—") + (risk ? " — " + risk.risk.toUpperCase() : ""),
        confidence: g.confidence || "Medium", reasons: reasons, details: { factors: factorsOn(p.text), scaleNote: "1 = low risk, 9 = high risk" } }));
    });

    // --- Maximum Credit Recommendation and Overall Business Risk
    P.filter(function (p) { return p.isMcr; }).forEach(function (p) {
      var m = /Maximum Credit Recommendation\s{2,}(US\$\s?[\d,]+(?:\.\d{2})?)/.exec(p.text) || /D&B GUIDANCE[\s\S]{0,120}?(US\$\s?[\d,]+(?:\.\d{2})?)/.exec(p.text) || /(US\$\s?[\d,]+(?:\.\d{2})?)/.exec(p.text);
      if (m) {
        var cv = V.currency(m[1].replace(/^US/, ""));
        if (cv.ok) {
          var basis = /recommended limit is based on ([^.\n]+(?:\n[^.\n]+)?)\./.exec(p.text);
          add(obs("max_credit_recommendation", p.n, { displayName: "Maximum Credit Recommendation", value: cv.meta.amount, valueText: "US$ " + cv.meta.amount.toLocaleString("en-US"),
            status: "available", section: "Risk Assessment — Maximum Credit Recommendation", evidence: "MAXIMUM CREDIT RECOMMENDATION — D&B GUIDANCE — " + m[1].replace(/\s+/g, " "),
            confidence: "High", reasons: ["Labelled “Maximum Credit Recommendation” on its own page"],
            details: basis ? { basis: basis[1].replace(/\s+/g, " ").trim() } : {} }));
        }
      } else if (/Maximum Credit Recommendation[\s\S]{0,200}DATA NOT AVAILABLE/.test(p.text)) {
        add(obs("max_credit_recommendation", p.n, { displayName: "Maximum Credit Recommendation", status: "data_not_available", section: "Risk Assessment — Maximum Credit Recommendation", evidence: "MAXIMUM CREDIT RECOMMENDATION — DATA NOT AVAILABLE", confidence: "High" }));
      }
      var om = /Overall Business Risk\s{2,}(Low-Moderate|Moderate-High|Moderate|Low|High)\b/i.exec(p.text);
      var riskText = om ? titleRisk(om[1]) : "";
      var evidence = om ? om[0].replace(/\s+/g, " ") : "";
      if (!riskText) {
        var r = riskOn(p.L.filter(function (l) { return !/Low Risk\s+High Risk/i.test(l); }));
        if (r) { riskText = r.risk; evidence = "OVERALL BUSINESS RISK — " + r.risk.toUpperCase(); }
      }
      var thinks = {};
      var t1 = /12 months:\s*([A-Z][A-Z ,'\-]+)/.exec(p.text);
      var t2 = /discontinuation:\s*([A-Z][A-Z ,'\-\n]+?)(?=\n(?:Based|Overall)|$)/.exec(p.text);
      var t3 = /payments:\s*([A-Z][A-Z ,'\-\n]+?)(?=\n(?:Overall|Maximum)|$)/.exec(p.text);
      if (t1) thinks.overall = t1[1].replace(/\s+/g, " ").trim();
      if (t2) thinks.discontinuation = t2[1].replace(/\s+/g, " ").trim();
      if (t3) thinks.delinquency = t3[1].replace(/\s+/g, " ").trim();
      if (riskText) {
        add(obs("overall_business_risk", p.n, { displayName: "Overall Business Risk", value: null, valueText: riskText, riskLevel: riskText, status: "available",
          section: "Risk Assessment — Overall Business Risk", evidence: evidence, confidence: om ? "High" : "Medium",
          reasons: [om ? "Labelled “Overall Business Risk” followed by the category" : "Category read from the gauge on the recommendation page"],
          details: { assessment: thinks, note: "A risk category from D&B, kept as text — not converted to a number." } }));
      }
      Object.keys(thinks).forEach(function (k) {
        out.extended.push({ provider: "dnb", key: "dnb_thinks_" + k, label: "Dun & Bradstreet Thinks — " + ({ overall: "next 12 months", discontinuation: "risk of discontinuation", delinquency: "risk of severe delinquency" })[k], valueText: thinks[k], page: p.n, section: "Risk Assessment — Overall Business Risk", evidence: thinks[k] });
      });
    });

    // --- D&B Rating: current, as-of, previous
    P.filter(function (p) { return p.isRating; }).forEach(function (p) {
      var L = p.L;
      var tok = /^(--|-|DATA NOT AVAILABLE|[A-Z]{1,2}\d{0,2}|\d[A-Z]{1,2}\d?)$/;
      var current = "", asOf = "", previous = "", previousAsOf = "", conf = "Medium", reasons = [];
      var pi = -1;
      for (var i = 0; i < L.length; i++) {
        var cs = cells(L[i]);
        if (cs.length === 1 && /^Previous (Rating|Score)$/i.test(cs[0])) { pi = i; break; }
      }
      if (pi >= 1) {
        var am = /As of ([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/.exec(L[pi - 1]);
        if (am) asOf = isoDate(am[1]);
        var before = cells(L[pi - (am ? 2 : 1)] || "");
        var last = before[before.length - 1];
        if (last && tok.test(last)) current = last;
        var after = cells(L[pi + 1] || "");
        if (after[0] && tok.test(after[0])) previous = after[0];
        reasons.push("Read from the D&B RATING gauge: current value, its as-of date, and the previous rating");
      }
      if (p.page.items && p.page.items.length) {
        var big = p.page.items.filter(function (it) { return tok.test(String(it.str).trim()) && it.bbox && it.bbox.h >= 14; })
          .sort(function (a, b) { return b.bbox.h - a.bbox.h; })[0];
        if (big) {
          var bv = big.str.trim();
          if (!current) { current = bv; reasons.push("Current rating is the large-type value on the page"); }
          else if (current === bv) conf = "High";
          else reasons.push("Large-type value " + bv + " differs from the layout reading " + current);
        }
      }
      var pm = /My [Pp]revious (?:Rating|Score)\s+As of ([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/.exec(p.text);
      if (pm) previousAsOf = isoDate(pm[1]);
      if (!asOf) { var am2 = /As of ([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/.exec(p.text); if (am2) asOf = isoDate(am2[1]); }
      if (!current && !previous) return;
      var absent = !current || current === "--" || current === "-" || current === DNA;
      var expl = /This represents the absence of a D&B Rating[^.]*\./.exec(p.text);
      add(obs("dnb_rating", p.n, { displayName: "D&B Rating", value: null, valueText: absent ? "" : current,
        status: absent ? "data_not_available" : "available", effectiveDate: asOf || out.reportDate,
        section: "Risk Assessment — D&B Rating",
        evidence: "D&B RATING — " + (current || "—") + (asOf ? " — As of " + asOf : "") + (previous ? " — Previous Rating " + previous : ""),
        confidence: conf, reasons: reasons,
        details: { current: current || "", asOf: asOf, previous: previous || "", previousAsOf: previousAsOf,
          reason: absent ? (expl ? expl[0].replace(/\s+/g, " ") : "The report shows no current D&B Rating.") : "" } }));
    });

    // --- payment history
    P.filter(function (p) { return p.isPayment; }).forEach(function (p) {
      var period = /Payment History\s*\n\s*([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\s*-\s*([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/.exec(p.text);
      if (period) out.extended.push({ provider: "dnb", key: "payment_history_period", label: "Payment history period", valueText: period[1] + " – " + period[2], page: p.n, section: "Payment History", evidence: period[0].replace(/\s+/g, " ") });
      function pay(metricType, label, rx, name, kind) {
        var v = labelValue(p.L, label, rx, 3);
        if (!v) return;
        var dna = v.value === DNA;
        var val = null, text = dna ? "" : v.value;
        if (!dna && kind === "percent") { val = parseFloat(v.value); }
        if (!dna && kind === "currency") { var cv = V.currency(v.value.replace(/^US/, "")); if (cv.ok) { val = cv.meta.amount; text = "US$ " + cv.meta.amount.toLocaleString("en-US"); } }
        add(obs(metricType, p.n, { displayName: name, value: val, valueText: text, status: dna ? "data_not_available" : "available",
          section: "Payment History — Trade Payments", evidence: label + " — " + v.value, confidence: "High",
          reasons: ["Labelled “" + label + "” in the Trade Payments panel"], details: dna ? { reason: "No trade payment experiences have been reported to D&B." } : {} }));
      }
      pay("payment_behavior", "OVERALL PAYMENT", /^(DATA NOT AVAILABLE|\d{1,3}(?:\s*(?:days?|%))?|(?:Pays|Slow|Prompt|Within|Beyond)[A-Za-z0-9 ]{0,30})$/i, "Overall Payment Behavior", "text");
      pay("trade_within_terms", "% OF TRADE WITHIN TERMS", /^(DATA NOT AVAILABLE|\d{1,3}%)$/, "% of Trade Within Terms", "percent");
      pay("highest_past_due", "HIGHEST PAST DUE", /^(DATA NOT AVAILABLE|US?\$?\s?[\d,]+(?:\.\d{2})?)$/, "Highest Past Due", "currency");
    });
    P.filter(function (p) { return p.isTradeLines; }).forEach(function (p) {
      var m = /Trade Lines[\s\S]{0,400}?\n(DATA NOT AVAILABLE)\s*$/m.exec(p.text) || /Trade Lines[\s\S]{0,400}?(DATA NOT AVAILABLE)/.exec(p.text);
      if (m) {
        add(obs("trade_lines", p.n, { displayName: "Trade Lines Reported", value: 0, valueText: "", status: "data_not_available", section: "Payment History — Trade Lines",
          evidence: "Trade Lines — DATA NOT AVAILABLE", confidence: "High", reasons: ["The Trade Lines table prints “DATA NOT AVAILABLE”"], details: { reason: "No trade lines have been reported to D&B yet." } }));
      }
    });

    // --- public records (Company Operations)
    P.filter(function (p) { return p.isOps; }).forEach(function (p) {
      [["suits", "SUITS", "Suits"], ["judgments", "JUDGMENTS", "Judgments"], ["liens", "LIENS", "Liens"], ["ucc_filings", "UCC FILINGS", "UCC Filings"]].forEach(function (d) {
        var v = labelValue(p.L, d[1], /^\d{1,4}$/, 2);
        if (!v) return;
        add(obs(d[0], p.n, { displayName: d[2], value: parseInt(v.value, 10), valueText: v.value, status: "available", section: "Company Operations — Public Records",
          evidence: d[1] + " — " + v.value, confidence: "High", reasons: ["Count printed under the “" + d[1] + "” heading"] }));
      });
      var opsLabels = ["D-U-N-S Number", "Ownership", "Annual Sales", "Mailing Address", "Line of Business", "Employees", "Website / Phone", "Principal", "Age", "Latest Filing Date", "(in thousands)", "(Undetermined at Headquarters)"];
      [["Ownership", /^.{1,60}$/], ["Annual Sales", /^.{1,40}$/], ["Line of Business", /^.{2,60}$/], ["Employees", /^\d{1,7}$|^Undetermined$/i], ["Age", /^\d+ years?$/i]].forEach(function (d) {
        var v = labelValue(p.L, d[0], d[1], 2, opsLabels);
        if (v && v.value !== "--" && v.value !== "-") out.extended.push({ provider: "dnb", key: "ops_" + d[0].toLowerCase().replace(/\W+/g, "_"), label: d[0], valueText: v.value, page: p.n, section: "Company Operations", evidence: quote(v.excerpt) });
      });
      var ys = /\(Year Started (\d{4})\)/.exec(p.text);
      if (ys) out.extended.push({ provider: "dnb", key: "ops_year_started", label: "Year started", valueText: ys[1], page: p.n, section: "Company Operations", evidence: ys[0] });
    });

    // --- business registration (as D&B holds it)
    P.filter(function (p) { return p.isRegistration; }).forEach(function (p) {
      var asOf = /official source as of:\s*([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/.exec(p.text);
      if (asOf) out.extended.push({ provider: "dnb", key: "registration_as_of", label: "Business registration as of", valueText: asOf[1], page: p.n, section: "Business Registration", evidence: asOf[0] });
      var regLabels = ["Registered Name", "Corporation Type", "Business Commenced On", "State of Incorporation", "Date Incorporated", "Registered ID", "Registration Status", "Date Status Attained", "Filing Date", "Where Filed"];
      regLabels.forEach(function (label) {
        var v = labelValue(p.L, label, /^.{1,80}$/, 1, regLabels);
        if (v && v.value !== "-" && v.value !== "--") out.extended.push({ provider: "dnb", key: "reg_" + label.toLowerCase().replace(/\W+/g, "_"), label: "Registration — " + label, valueText: v.value, page: p.n, section: "Business Registration", evidence: quote(v.excerpt) });
      });
    });

    // --- SIC / NAICS / employees as D&B lists them
    P.filter(function (p) { return p.isActivities; }).forEach(function (p) {
      var sic = /\n(\d{4})\s{2,}([A-Za-z][^\n]{2,60}?)(?:\s{2,}-)?\s*$/m.exec(p.text) || /\n(\d{4,8})\s{2,}([A-Za-z][^\n]{2,60}?)(?:\s{2,}-)?\s*$/m.exec(p.text);
      var naics = /NAICS Code[\s\S]{0,80}?\n(\d{6})\s+([A-Za-z][^\n]{2,80})/.exec(p.text);
      if (sic) out.extended.push({ provider: "dnb", key: "sic_code", label: "SIC code (D&B)", valueText: sic[1] + " — " + sic[2].trim(), page: p.n, section: "Business Activities", evidence: quote(sic[0]) });
      if (naics) out.extended.push({ provider: "dnb", key: "naics_code", label: "NAICS code (D&B)", valueText: naics[1] + " — " + naics[2].trim(), page: p.n, section: "Business Activities", evidence: quote(naics[0]) });
      var fin = labelValue(p.L, "Financing Status", /^.{2,40}$/, 1, ["Description", "Employees", "Financing Status", "SIC Code", "SIC Description", "Percentage of Business", "NAICS Code", "NAICS Description", "Business Information"]);
      if (fin) out.extended.push({ provider: "dnb", key: "financing_status", label: "Financing status", valueText: fin.value, page: p.n, section: "Business Activities", evidence: quote(fin.excerpt) });
    });

    // --- inquiries
    P.filter(function (p) { return p.isInquiries; }).forEach(function (p) {
      var period = /Inquiries\s*\n\s*([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\s*-\s*([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/.exec(p.text);
      var total = labelValue(p.L, "TOTAL INQUIRIES", /^\d{1,4}$/, 2);
      var uniq = labelValue(p.L, "UNIQUE CUSTOMER", /^\d{1,4}$/, 3) || labelValue(p.L, "UNIQUE CUSTOMER INQUIRIES", /^\d{1,4}$/, 2);
      var details = period ? { period: period[1] + " – " + period[2] } : {};
      if (total) add(obs("total_inquiries", p.n, { displayName: "Total Inquiries", value: parseInt(total.value, 10), valueText: total.value, status: "available", section: "Inquiries",
        evidence: "TOTAL INQUIRIES — " + total.value + (period ? " (" + period[1] + " – " + period[2] + ")" : ""), confidence: "Medium", reasons: ["Count printed under “TOTAL INQUIRIES”; the chart on the same page shares its numerals, so confirm"], details: details }));
      if (uniq) add(obs("unique_customer_inquiries", p.n, { displayName: "Unique Customer Inquiries", value: parseInt(uniq.value, 10), valueText: uniq.value, status: "available", section: "Inquiries",
        evidence: "UNIQUE CUSTOMER INQUIRIES — " + uniq.value, confidence: "Medium", reasons: ["Count printed under “UNIQUE CUSTOMER INQUIRIES”"], details: details }));
      var rows = /\n([A-Z][A-Za-z ]{3,40})\s{2,}(\d{1,4})\s{2,}([^\n]{3,40}?)\s{2,}(\d{1,3}%)\s{2,}(\d{4}-\d{2}-\d{2})/.exec(p.text);
      if (rows) out.extended.push({ provider: "dnb", key: "inquiry_summary", label: "Inquiries summary", valueText: rows[1].trim() + " · " + rows[2] + " · " + rows[3].trim() + " · " + rows[4] + " · " + rows[5], page: p.n, section: "Inquiries", evidence: quote(rows[0]) });
    });

    // --- submitted documents
    P.filter(function (p) { return p.isSubmissions; }).forEach(function (p) {
      ["Total Submissions", "Approved", "In Process", "Remaining"].forEach(function (label) {
        var v = labelValue(p.L, label, /^\d{1,4}$/, 2);
        if (v) out.extended.push({ provider: "dnb", key: "submissions_" + label.toLowerCase().replace(/\W+/g, "_"), label: "Submitted documents — " + label, valueText: v.value, page: p.n, section: "Extended Data — Submitted Documents", evidence: quote(v.excerpt) });
      });
    });

    // The same fact printed on several pages is one fact.
    var seenX = {};
    out.extended = out.extended.filter(function (e) {
      var k = e.key + "|" + e.valueText;
      if (seenX[k]) return false;
      seenX[k] = true;
      return true;
    });
    if (!out.observations.length) out.notes.push("Recognised as a D&B Credit Insights report, but no metric sections could be read.");
    return out;
  };

  /* ---------- generic labelled scores (any provider) ----------
     "PAYDEX Score: 80", "Intelliscore Plus: 76" and the like. A colon or
     an explicit "score of" is required, so a bare number near a metric name
     is never taken as that metric's value. */
  X.GENERIC = [
    { provider: "dnb", metricType: "paydex", name: "PAYDEX", rx: /PAYDEX(?:®)?(?:\s+Score)?\s*(?::|is|of)\s*(\d{1,3})\b/i, min: 1, max: 100 },
    { provider: "dnb", metricType: "delinquency_score", name: "Delinquency Score", rx: /Delinquency (?:Predictor )?Score\s*(?::|is|of)\s*(\d{1,3})\b/i, min: 1, max: 100 },
    { provider: "dnb", metricType: "failure_score", name: "Failure Score", rx: /(?<!Business )Failure Score\s*(?::|is|of)\s*(\d{1,3})\b/i, min: 1, max: 100 },
    { provider: "dnb", metricType: "ser_rating", name: "Supplier Evaluation Risk Rating", rx: /(?:Supplier Evaluation Risk|SER)(?:\s*\(SER\))?\s*Rating\s*(?::|is|of)\s*(\d)\b/i, min: 1, max: 9 },
    { provider: "experian", metricType: "intelliscore_plus", name: "Intelliscore Plus", rx: /Intelliscore(?:\s+Plus)?(?:\s+Score)?\s*(?::|is|of)\s*(\d{1,3})\b/i, min: 1, max: 100 },
    { provider: "experian", metricType: "financial_stability_risk", name: "Financial Stability Risk", rx: /Financial Stability Risk(?:\s+(?:Score|Rating))?\s*(?::|is|of)\s*(\d)\b/i, min: 1, max: 5 },
    { provider: "equifax", metricType: "business_credit_risk_score", name: "Business Credit Risk Score", rx: /Business Credit Risk Score\s*(?::|is|of)\s*(\d{3})\b/i, min: 101, max: 992 },
    { provider: "equifax", metricType: "business_failure_score", name: "Business Failure Score", rx: /Business Failure Score\s*(?::|is|of)\s*(\d{4})\b/i, min: 1000, max: 1880 },
    { provider: "equifax", metricType: "payment_index", name: "Payment Index", rx: /Payment Index\s*(?::|is|of)\s*(\d{1,3})\b/i, min: 0, max: 100 },
    { provider: "fico", metricType: "sbss", name: "FICO SBSS Score", rx: /(?:FICO\s+)?SBSS(?:\s+Score)?\s*(?::|is|of)\s*(\d{1,3})\b/i, min: 0, max: 300 },
    { provider: "creditsafe", metricType: "creditsafe_score", name: "Creditsafe Score", rx: /Creditsafe (?:Score|Rating)\s*(?::|is|of)\s*(\d{1,3})\b/i, min: 1, max: 100 }
  ];

  X.parseGeneric = function (pages, det) {
    var out = { provider: det.provider, format: "generic", reportLabel: det.provider && root.DOCAI && root.DOCAI.credit && root.DOCAI.credit.PROVIDERS[det.provider] ? root.DOCAI.credit.PROVIDERS[det.provider].reportLabel : "",
      reportDate: "", businessName: "", identifiers: {}, observations: [], extended: [], notes: [], rejected: [], version: X.VERSION };
    var full = pages.map(function (p) { return p.text; }).join("\n");
    var dm = /(?:Report Date|Date of Report|As of|Prepared(?: for [^\n]*?)? on|Generated on)\s*:?\s*([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i.exec(full);
    if (dm) out.reportDate = isoDate(dm[1]);
    var dunsM = /D-U-N-S(?: Number)?[^\d]{0,20}(\d{2}-?\d{3}-?\d{4})/i.exec(full);
    if (dunsM) { var dv = V.duns(dunsM[1]); if (dv.ok) out.identifiers.duns = dv.value; }

    pages.forEach(function (p) {
      X.GENERIC.forEach(function (g) {
        var m = g.rx.exec(p.text || "");
        if (!m) return;
        if (out.observations.some(function (o) { return o.provider === g.provider && o.metricType === g.metricType; })) return;
        var n = parseInt(m[1], 10);
        if (n < g.min || n > g.max) {
          out.rejected.push({ provider: g.provider, metricType: g.metricType, label: g.name, raw: m[1], page: p.page, errors: [g.name + " must be between " + g.min + " and " + g.max + " — found " + n] });
          return;
        }
        out.observations.push({
          provider: g.provider, metricType: g.metricType, displayName: g.name, value: n, valueText: String(n), status: "available",
          scaleMin: g.min, scaleMax: g.max, details: {}, effectiveDate: out.reportDate,
          source: { page: p.page, section: "", evidence: quote(m[0]), confidence: "High", reasons: ["Labelled “" + m[0].replace(/\s*[:].*$/, "") + "” with the value on the same line"], reportLabel: out.reportLabel, extractionVersion: X.VERSION }
        });
      });
      // "PAYDEX: Data not available" style statements
      var dna = /PAYDEX(?:®)?(?:\s+Score)?\s*:\s*(?:N\/A|Not Available|DATA NOT AVAILABLE|Unavailable)/i.exec(p.text || "");
      if (dna && !out.observations.some(function (o) { return o.metricType === "paydex"; })) {
        out.observations.push({ provider: "dnb", metricType: "paydex", displayName: "PAYDEX", value: null, valueText: "", status: "data_not_available",
          scaleMin: 1, scaleMax: 100, details: {}, effectiveDate: out.reportDate,
          source: { page: p.page, section: "", evidence: quote(dna[0]), confidence: "High", reasons: ["The document states the PAYDEX is not available"], reportLabel: out.reportLabel, extractionVersion: X.VERSION } });
      }
    });
    if (!out.provider && out.observations.length) out.provider = out.observations[0].provider;
    return out;
  };

  /* ---------- entry point ---------- */
  X.extract = function (pages, opts) {
    pages = pages || [];
    var full = pages.map(function (p) { return p.text || ""; }).join("\n");
    var det = X.detect(full);
    if (!det.provider) return null;
    var res = det.format === "dnb_credit_insights" ? X.parseDnbInsights(pages) : X.parseGeneric(pages, det);
    res.detection = det;
    return res;
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.creditExtractors = X;
  if (typeof module !== "undefined" && module.exports) module.exports = X;
})(typeof globalThis !== "undefined" ? globalThis : this);
