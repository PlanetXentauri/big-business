/* ============================================================
   BIG BUSINESS · Business Credit Command Center

   The dashboard's view over DOCAI.credit: one panel per business showing
   the profile status, the summary cards, one section per provider with a
   card per metric (own scale, own status, own provenance), the history and
   trend of every metric, the source-document vault with re-analysis, and
   the action items derived from what the reports actually say.

   Everything here is read from the stored ledger through DOCAI.credit.
   Nothing is computed from one number into another: no universal score,
   no rescaling between providers.

   Uses the dashboard's globals (_state, ui, esc, render, commit, BIZ) and
   its classes (.card, .chip, .btn, .stats) so it reads as part of the app.
   ============================================================ */
(function () {
  "use strict";

  var TONE = {
    ok:    { text: "var(--green)", bg: "rgba(16,185,129,0.12)", brd: "rgba(16,185,129,0.4)" },
    cyan:  { text: "var(--cyan)",  bg: "rgba(31,211,238,0.12)", brd: "rgba(31,211,238,0.4)" },
    warn:  { text: "var(--amber)", bg: "rgba(245,158,11,0.14)", brd: "rgba(245,158,11,0.4)" },
    bad:   { text: "#ef4444",      bg: "rgba(239,68,68,0.14)",  brd: "rgba(239,68,68,0.4)" },
    muted: { text: "#8794ab",      bg: "rgba(255,255,255,0.05)", brd: "rgba(255,255,255,0.12)" },
    info:  { text: "var(--purple)", bg: "rgba(139,92,246,0.14)", brd: "rgba(139,92,246,0.4)" }
  };
  function chip(text, tone) {
    var t = TONE[tone] || TONE.muted;
    return '<span class="chip" style="background:' + t.bg + ';color:' + t.text + ';border:1px solid ' + t.brd + '">' + text + '</span>';
  }
  function CR() { return window.DOCAI && DOCAI.credit; }
  function st() {
    ui.cc = ui.cc || { tab: {}, open: {}, doc: {} };
    return ui.cc;
  }
  function riskTone(level) {
    var l = String(level || "").toLowerCase();
    if (!l) return "muted";
    if (l === "low") return "ok";
    if (l === "low-moderate") return "cyan";
    if (l === "moderate") return "warn";
    return "bad";      // moderate-high, high — the report itself calls these elevated
  }
  function statusTone(o) {
    var s = o.displayStatus || o.status;
    if (s === "available") return "ok";
    if (s === "conflict" || s === "stale" || s === "pending") return "warn";
    if (s === "manual") return "info";
    return "muted";
  }
  function fmtTs(t) { return t ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"; }
  function maskId(v) { v = String(v || ""); return v ? "•••••" + v.slice(-4) : ""; }
  function arg(s) { return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'"; }

  /* ---------- the panel ---------- */
  window.creditCenterHTML = function (biz) {
    var C = CR();
    if (!C) return '<div class="empty">The credit module did not load — check that js/doc/credit.js is present.</div>';
    var sum = C.summary(_state, biz);
    var s = st();
    var tab = s.tab[biz] || "overview";
    var stateTone = sum.status === "strong" ? "ok" : sum.status === "established" ? "ok" : sum.status === "partial" ? "warn" : "muted";

    var html = '<div class="cc">';
    // ---- header: human-readable status, never a score
    html += '<div class="cc-head">' +
      '<div><div class="cc-title">🏛 BUSINESS CREDIT PROFILE</div>' +
      '<div class="cc-sub">BUSINESS CREDIT HEALTH · ' + chip("PROFILE " + sum.statusLabel, stateTone) + '</div></div>' +
      '<div class="cc-bureaus"><div>' + sum.bureausDetected + ' of ' + sum.bureausTotal + ' major bureaus detected</div>' +
      C.MAJOR.map(function (pid) {
        var ps = sum.providers[pid];
        var lab = ps.status === "profile_detected" ? "Active" : ps.status === "profile_no_scores" ? "File detected, no scores yet" : "Not yet added";
        return '<div><span style="color:#94a3b8">' + esc(ps.def.short) + ':</span> <span style="color:' + (ps.detected ? "var(--green)" : "#8794ab") + '">' + lab + '</span></div>';
      }).join("") + '</div></div>';

    // ---- summary cards
    html += '<div class="cc-stats">' +
      tile("BUREAUS DETECTED", sum.bureausDetected + ' <span class="cc-dim">/ ' + sum.bureausTotal + '</span>', sum.bureausDetected ? "var(--cyan)" : "#8794ab") +
      tile("ACTIVE SCORES", String(sum.activeScores), sum.activeScores ? "var(--green)" : "#8794ab") +
      tile("CREDIT RECOMMENDATION", sum.creditRecommendation ? esc(sum.creditRecommendation.text) : "—", sum.creditRecommendation ? "var(--gold)" : "#8794ab") +
      tile("OVERALL RISK", sum.overallRisk ? esc(sum.overallRisk.text) : "—", sum.overallRisk ? TONE[riskTone(sum.overallRisk.text)].text : "#8794ab") +
      tile("LAST REPORT", sum.lastReportDate ? esc(C.fmtDate(sum.lastReportDate)) : "—", "#e2e8f0") +
      '</div>';
    if (sum.lastImportedAt) html += '<div class="cc-note">Last report prepared ' + esc(C.fmtDate(sum.lastReportDate)) + ' · imported into Big Business ' + esc(fmtTs(sum.lastImportedAt)) + ' — the two dates are kept apart.</div>';

    // ---- tabs
    var tabs = [["overview", "OVERVIEW"]].concat(C.MAJOR.map(function (pid) { return [pid, C.PROVIDERS[pid].label.toUpperCase()]; }))
      .concat(Object.keys(sum.providers).filter(function (pid) { return C.MAJOR.indexOf(pid) < 0 && sum.providers[pid].detected; }).map(function (pid) { return [pid, (C.PROVIDERS[pid] ? C.PROVIDERS[pid].label : pid).toUpperCase()]; }))
      .concat([["documents", "DOCUMENTS (" + sum.documentCount + ")"]]);
    html += '<div class="sub-tabs cc-tabs">' + tabs.map(function (t) {
      var on = tab === t[0];
      var dot = t[0] !== "overview" && t[0] !== "documents" ? (sum.providers[t[0]] && sum.providers[t[0]].status === "profile_detected" ? "● " : "○ ") : "";
      return '<button class="sub-tab ' + (on ? "active" : "") + '" onclick="ccTab(' + arg(biz) + ',' + arg(t[0]) + ')">' + dot + esc(t[1]) + '</button>';
    }).join("") + '</div>';

    if (tab === "overview") html += overview(biz, sum);
    else if (tab === "documents") html += documents(biz, sum);
    else html += providerSection(biz, tab, sum);

    return html + '</div>';
  };

  function tile(label, value, color) {
    return '<div class="stat"><div class="lbl">' + label + '</div><div class="val" style="color:' + color + ';font-size:20px">' + value + '</div></div>';
  }

  /* ---------- overview ---------- */
  function overview(biz, sum) {
    var C = CR();
    var cur = sum.current;
    var html = '<div class="card cc-block"><div class="cc-block-title">BUSINESS CREDIT SNAPSHOT</div><div class="cc-snap">';
    C.MAJOR.forEach(function (pid) {
      var ps = sum.providers[pid];
      var lines = [];
      if (ps.status === "profile_detected") {
        lines.push('Profile: <b style="color:var(--green)">Established</b>');
        lines.push('Scores: ' + ps.activeScores + ' available');
        var pay = cur[pid + ".paydex"] || cur[pid + ".payment_index"];
        if (pay) lines.push((pay.metricType === "paydex" ? "PAYDEX" : "Payment Index") + ': ' + (pay.status === "available" ? esc(C.formatValue(pay)) : "Awaiting data"));
      } else if (ps.status === "profile_no_scores") {
        lines.push('Profile: <b style="color:var(--amber)">File detected</b>');
        lines.push('Scores: none usable yet');
      } else {
        lines.push('<span style="color:#8794ab">No report</span>');
      }
      html += '<div class="cc-snap-col"><div class="cc-snap-h">' + esc(ps.def.short) + '</div>' + lines.map(function (l) { return '<div>' + l + '</div>'; }).join("") + '</div>';
    });
    html += '</div><div class="cc-snap" style="margin-top:10px;border-top:1px solid rgba(255,255,255,0.06);padding-top:10px">' +
      '<div class="cc-snap-col"><div class="cc-snap-h">Commercial Credit Recommendation</div><div style="color:var(--gold);font-weight:800">' + (sum.creditRecommendation ? esc(sum.creditRecommendation.text) : "—") + '</div></div>' +
      '<div class="cc-snap-col"><div class="cc-snap-h">Risk Signals</div><div>' + (sum.overallRisk ? chip(esc(sum.overallRisk.text).toUpperCase(), riskTone(sum.overallRisk.text)) : '<span style="color:#8794ab">—</span>') + '</div></div>' +
      '<div class="cc-snap-col"><div class="cc-snap-h">Public Records</div>' + (sum.snapshot.publicRecords
        ? ["suits", "judgments", "liens", "ucc"].map(function (k) { var v = sum.snapshot.publicRecords[k]; return '<div>' + (v == null ? "—" : v) + ' ' + (k === "ucc" ? "UCC filings" : k) + '</div>'; }).join("")
        : '<div style="color:#8794ab">—</div>') + '</div>' +
      '<div class="cc-snap-col"><div class="cc-snap-h">Credit Inquiries</div>' + (sum.snapshot.inquiries
        ? '<div>' + sum.snapshot.inquiries.total + (sum.snapshot.inquiries.unique != null ? ' <span class="cc-dim">(' + sum.snapshot.inquiries.unique + ' unique)</span>' : '') + '</div>'
        : '<div style="color:#8794ab">—</div>') + '</div>' +
      '</div></div>';

    if (sum.conflicts.length) {
      html += '<div class="card cc-block" style="border-left:3px solid var(--amber)"><div class="cc-block-title" style="color:var(--amber)">⚠ REVIEW CONFLICTS (' + sum.conflicts.length + ')</div>';
      sum.conflicts.forEach(function (cf) {
        html += '<div class="cc-conflict"><div><b>' + esc(cf.current.displayName) + '</b> · report ' + esc(C.fmtDate(cf.current.effectiveDate) || "undated") + '</div>' +
          '<div class="cc-dim">Current: ' + esc(C.formatValue(cf.current)) + ' (' + esc(cf.current.source.fileName || cf.current.source.method) + ') · Other: ' + esc(C.formatValue(cf.rival)) + ' (' + esc(cf.rival.source.fileName || cf.rival.source.method) + ')</div>' +
          '<div class="row" style="margin-top:6px;flex-wrap:wrap">' +
          '<button class="btn btn-ghost cc-mini" onclick="ccResolve(' + arg(biz) + ',' + arg(cf.current.id) + ',' + arg(cf.rival.id) + ',\'keep\')">KEEP CURRENT</button>' +
          '<button class="btn btn-ghost cc-mini" onclick="ccResolve(' + arg(biz) + ',' + arg(cf.current.id) + ',' + arg(cf.rival.id) + ',\'use_new\')">USE NEW</button>' +
          '<button class="btn btn-ghost cc-mini" onclick="ccResolve(' + arg(biz) + ',' + arg(cf.current.id) + ',' + arg(cf.rival.id) + ',\'keep\')">KEEP BOTH</button>' +
          '<button class="btn btn-ghost cc-mini" onclick="ccResolve(' + arg(biz) + ',' + arg(cf.current.id) + ',' + arg(cf.rival.id) + ',\'historical\')">ADD AS HISTORICAL</button>' +
          '</div></div>';
      });
      html += '</div>';
    }

    html += '<div class="card cc-block"><div class="cc-block-title">ACTION ITEMS</div>';
    if (!sum.actions.length) html += '<div class="cc-dim">Nothing to suggest yet — import a credit report to get started.</div>';
    sum.actions.forEach(function (a) {
      var tone = a.tone === "wait" ? "warn" : a.tone === "neutral" ? "muted" : "cyan";
      html += '<div class="cc-action"><div>' + chip(esc(a.metric).toUpperCase(), tone) + ' <b>' + esc(a.title) + '</b></div>' +
        '<div class="cc-dim">' + esc(a.detail) + '</div>' +
        '<div style="color:#cbd5e1;margin-top:2px">→ ' + esc(a.next) + '</div></div>';
    });
    html += '</div>';

    if (sum.quality.length) {
      html += '<div class="card cc-block"><div class="cc-block-title">DATA QUALITY</div>' +
        '<div class="cc-dim" style="margin-bottom:6px">Information reported by the source, not an application error.</div>' +
        sum.quality.map(function (q) {
          return '<div class="cc-action"><div><b>' + esc(q.label) + '</b> ' + chip(esc(CR().statusLabel(q.status)), q.status === "data_not_available" ? "muted" : "warn") + '</div><div class="cc-dim">Reason: ' + esc(q.reason) + '</div></div>';
        }).join("") + '</div>';
    }
    return html;
  }

  /* ---------- a provider section ---------- */
  function providerSection(biz, pid, sum) {
    var C = CR();
    var ps = sum.providers[pid];
    var def = ps.def || { label: pid, short: pid, identifierLabel: "ID", reportLabel: pid + " report" };
    var html = '<div class="card cc-block cc-provider">' +
      '<div class="cc-prov-head"><div><div class="cc-prov-name">' + esc(def.label.toUpperCase()) + '</div>' +
      (ps.status === "profile_detected" ? '<div style="color:var(--green)">● PROFILE DETECTED</div>'
        : ps.status === "profile_no_scores" ? '<div style="color:var(--amber)">● FILE DETECTED — NO USABLE SCORES YET</div>'
        : '<div style="color:#8794ab">○ NOT CONNECTED / NO REPORT FOUND</div>') + '</div>' +
      '<div class="cc-prov-meta">' +
      (ps.accountIdentifier ? '<div>' + esc(def.identifierLabel || "ID") + ': <b>' + esc(maskId(ps.accountIdentifier)) + '</b></div>' : '') +
      (ps.lastReportDate ? '<div>Last report: <b>' + esc(C.fmtDate(ps.lastReportDate)) + '</b></div>' : '') +
      (ps.detected ? '<div>Metrics tracked: <b>' + ps.metricsTracked + '</b></div>' : '') +
      '</div></div>';

    if (!ps.detected) {
      html += '<div class="cc-dim" style="margin:10px 0">No report imported yet. That says nothing about this bureau\'s view of the business — there is simply no data here.</div>' +
        '<div class="row" style="flex-wrap:wrap"><button class="btn btn-red" onclick="pickAutofill(' + arg(biz) + ',\'afPdf\',\'fin\')">📄 ADD REPORT</button>' +
        '<button class="btn btn-ghost" onclick="ccAddManual(' + arg(biz) + ',' + arg(pid) + ')">✎ ENTER A SCORE BY HAND</button></div>';
      var ready = Object.keys((C.PROVIDERS[pid] || { metrics: {} }).metrics).filter(function (mt) { return C.PROVIDERS[pid].metrics[mt].counted; });
      if (ready.length) html += '<div class="cc-dim" style="margin-top:10px">Ready to track: ' + ready.map(function (mt) { return esc(C.PROVIDERS[pid].metrics[mt].label); }).join(" · ") + '.</div>';
      return html + '</div>';
    }

    html += '<div class="row" style="flex-wrap:wrap;margin-top:8px"><button class="btn btn-ghost cc-mini" onclick="pickAutofill(' + arg(biz) + ',\'afPdf\',\'fin\')">📄 ADD NEWER REPORT</button>' +
      '<button class="btn btn-ghost cc-mini" onclick="ccAddManual(' + arg(biz) + ',' + arg(pid) + ')">✎ MANUAL ENTRY</button></div></div>';

    var metrics = ps.metrics.slice();
    var order = Object.keys((C.PROVIDERS[pid] || { metrics: {} }).metrics);
    metrics.sort(function (a, b) {
      var ia = order.indexOf(a.metricType), ib = order.indexOf(b.metricType);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    var main = metrics.filter(function (o) { return C.metricDef(pid, o.metricType, o).counted; });
    var payment = metrics.filter(function (o) { return C.metricDef(pid, o.metricType, o).cls === "payment"; });
    var records = metrics.filter(function (o) { return C.metricDef(pid, o.metricType, o).cls === "public_record"; });
    var inquiries = metrics.filter(function (o) { return C.metricDef(pid, o.metricType, o).cls === "inquiry"; });

    html += '<div class="cc-grid">' + main.map(function (o) { return scoreCard(biz, o); }).join("") + '</div>';
    if (payment.length || records.length || inquiries.length) {
      html += '<div class="cc-grid cc-grid-3">' +
        (payment.length ? miniGroup("PAYMENT BEHAVIOR", payment, biz) : "") +
        (records.length ? miniGroup("PUBLIC RECORDS", records, biz) : "") +
        (inquiries.length ? miniGroup("INQUIRIES", inquiries, biz) : "") +
        '</div>';
    }
    return html;
  }

  function badges(o) {
    var out = [];
    if (o.source.method === "manual") out.push(chip("MANUAL", "info"));
    else if (o.source.documentId) out.push(chip("AUTO ✓", "cyan"));
    else out.push(chip("DOCUMENT", "muted"));
    if (o.verified) out.push(chip("VERIFIED", "ok"));
    if ((o.flags || []).indexOf("conflict") >= 0) out.push(chip("CONFLICT", "warn"));
    if ((o.flags || []).indexOf("stale") >= 0) out.push(chip("STALE", "warn"));
    return out.join(" ");
  }

  function gauge(o) {
    if (o.kind !== "score" || o.value == null || o.scaleMin == null || o.scaleMax == null) return "";
    var span = o.scaleMax - o.scaleMin || 1;
    var pos = Math.max(0, Math.min(1, (o.value - o.scaleMin) / span));
    var good = o.higherIsBetter === false ? 1 - pos : pos;
    var color = good >= 0.66 ? "var(--green)" : good >= 0.33 ? "var(--amber)" : "#ef4444";
    return '<div class="cc-gauge" title="' + o.scaleMin + ' – ' + o.scaleMax + (o.higherIsBetter === false ? ' (lower is better)' : '') + '">' +
      '<div class="cc-gauge-fill" style="width:' + Math.round(pos * 100) + '%;background:' + color + '"></div>' +
      '<div class="cc-gauge-ends"><span>' + o.scaleMin + '</span><span>' + o.scaleMax + '</span></div></div>';
  }

  function scoreCard(biz, o) {
    var C = CR();
    var def = C.metricDef(o.provider, o.metricType, o);
    var s = st();
    var key = biz + ":" + o.metricKey;
    var open = s.open[key] || null;
    var avail = o.status === "available";
    var tone = TONE[statusTone(o)];
    var d = o.details || {};
    var valueHtml;
    if (avail) {
      valueHtml = o.kind === "score" && o.value != null
        ? '<span class="cc-big">' + esc(String(o.value)) + '</span><span class="cc-scale"> / ' + o.scaleMax + '</span>'
        : '<span class="cc-big" style="font-size:22px">' + esc(C.formatValue(o)) + '</span>';
    } else {
      valueHtml = '<span class="cc-big" style="color:#6b7a90">—</span>';
    }
    var rows = [];
    if (d.rawScore != null) rows.push(["Raw score", d.rawScore]);
    if (d.class != null) rows.push(["Class", d.class]);
    if (d.probability) rows.push(["Probability", d.probability]);
    if (d.industryAverage) rows.push(["Industry avg", d.industryAverage]);
    if (o.metricType === "dnb_rating") { rows.push(["Current", d.current || "—"]); if (d.previous) rows.push(["Previous", d.previous]); if (d.asOf) rows.push(["As of", C.fmtDate(d.asOf)]); }
    if (o.scaleMin != null && o.kind === "score") rows.push(["Scale", o.scaleMin + "–" + o.scaleMax + (o.higherIsBetter === false ? " (lower is better)" : "")]);

    var html = '<div class="cc-card" style="border-left:3px solid ' + tone.text + '">' +
      '<div class="cc-card-top"><span class="cc-name">' + esc((def.short || o.displayName || def.label).toUpperCase()) + '</span><span>' + badges(o) + '</span></div>' +
      '<div class="cc-value">' + valueHtml + '</div>' +
      (avail && o.riskLevel && o.kind !== "category" ? '<div>' + chip(esc(o.riskLevel).toUpperCase() + ' RISK', riskTone(o.riskLevel)) + '</div>' : '') +
      (!avail ? '<div>' + chip(esc(C.statusLabel(o.displayStatus || o.status)), statusTone(o)) + '</div>' : (o.displayStatus !== o.status ? '<div>' + chip(esc(C.statusLabel(o.displayStatus)), "warn") + '</div>' : '')) +
      gauge(o) +
      (rows.length ? '<div class="cc-rows">' + rows.map(function (r) { return '<div><span>' + esc(r[0]) + '</span><b>' + esc(String(r[1])) + '</b></div>'; }).join("") + '</div>' : '') +
      (d.basis ? '<div class="cc-dim">Basis: ' + esc(d.basis) + '</div>' : '') +
      (o.kind === "category" && avail ? '<div class="cc-dim">A risk category from the bureau, kept as text — not converted to a number.</div>' : '') +
      (!avail && d.reason ? '<div class="cc-dim" style="margin-top:6px">' + esc(d.reason) + '</div>' : '') +
      (!avail && !d.reason ? '<div class="cc-dim" style="margin-top:6px">' + esc(def.short || o.displayName) + ' is recognised by ' + esc((C.provider(o.provider) || {}).short || o.provider) + ', but the current report contains no value.</div>' : '') +
      (o.note ? '<div class="cc-dim" style="margin-top:4px">' + esc(o.note) + '</div>' : '') +
      '<div class="cc-src">Source: ' + esc(o.source.reportLabel || (o.source.method === "manual" ? "Manual entry" : "Document")) +
      (o.source.page ? ' · Page ' + o.source.page : '') + (o.effectiveDate ? ' · Report ' + esc(C.fmtDate(o.effectiveDate)) : ' · No report date') + '</div>' +
      '<div class="row cc-btns">' +
      '<button class="btn btn-ghost cc-mini" onclick="ccOpen(' + arg(key) + ',\'source\')">' + (open === "source" ? "✕ SOURCE" : "VIEW SOURCE") + '</button>' +
      '<button class="btn btn-ghost cc-mini" onclick="ccOpen(' + arg(key) + ',\'history\')">' + (open === "history" ? "✕ HISTORY" : "HISTORY (" + o.observationCount + ")") + '</button>' +
      '<button class="btn btn-ghost cc-mini" title="Enter a corrected value by hand" onclick="ccEdit(' + arg(biz) + ',' + arg(o.metricKey) + ')">✎</button>' +
      '<button class="btn btn-ghost cc-mini" title="' + (o.verified ? "Remove verification" : "Mark as verified against the source") + '" onclick="ccVerify(' + arg(biz) + ',' + arg(o.id) + ',' + (o.verified ? "false" : "true") + ')">' + (o.verified ? "✓" : "VERIFY") + '</button>' +
      '</div>';
    if (open === "source") html += sourcePanel(biz, o);
    if (open === "history") html += historyPanel(biz, o);
    return html + '</div>';
  }

  function miniGroup(title, list, biz) {
    var C = CR();
    return '<div class="cc-card"><div class="cc-name" style="margin-bottom:6px">' + title + '</div>' +
      list.map(function (o) {
        var avail = o.status === "available";
        var key = biz + ":" + o.metricKey;
        return '<div class="cc-mini-row"><span>' + esc(o.displayName) + '</span>' +
          '<span style="color:' + (avail ? "#e2e8f0" : "#6b7a90") + ';font-weight:700">' + (avail ? esc(C.formatValue(o)) : esc(C.statusLabel(o.status))) + '</span>' +
          '<span class="cc-dim" style="cursor:pointer;text-decoration:underline" onclick="ccOpen(' + arg(key) + ',\'source\')">p' + (o.source.page || "?") + '</span></div>' +
          (st().open[key] === "source" ? sourcePanel(biz, o) : "");
      }).join("") + '</div>';
  }

  function sourcePanel(biz, o) {
    var C = CR();
    var docRec = docById(biz, o.source.documentId);
    return '<div class="cc-panel"><div class="cc-name">SOURCE</div>' +
      '<div>' + esc(o.source.reportLabel || (o.source.method === "manual" ? "Manual entry" : "Document")) + '</div>' +
      (o.source.fileName ? '<div class="cc-dim">' + esc(o.source.fileName) + (o.source.page ? ' · Page ' + o.source.page : '') + (o.source.section ? ' · ' + esc(o.source.section) : '') + '</div>' : '') +
      (o.source.evidence ? '<div style="margin-top:6px">Evidence:</div><div class="cc-quote">“' + esc(o.source.evidence) + '”</div>' : '') +
      '<div class="cc-rows" style="margin-top:6px"><div><span>Report prepared</span><b>' + esc(o.effectiveDate ? C.fmtDate(o.effectiveDate) : "not found") + '</b></div>' +
      '<div><span>Imported into Big Business</span><b>' + esc(fmtTs(o.importedAt)) + '</b></div>' +
      (o.source.confidence ? '<div><span>Confidence</span><b>' + esc(o.source.confidence) + '</b></div>' : '') +
      (o.source.extractionVersion ? '<div><span>Parser</span><b>v' + esc(String(o.source.extractionVersion)) + '</b></div>' : '') + '</div>' +
      ((o.source.reasons || []).length ? '<div class="cc-dim" style="margin-top:6px">' + o.source.reasons.map(function (r) { return '· ' + esc(r); }).join("<br>") + '</div>' : '') +
      (docRec ? '<div class="row" style="margin-top:8px"><button class="btn btn-ghost cc-mini" onclick="ccOpenPage(' + arg(biz) + ',' + arg(docRec.id) + ',' + (o.source.page || 1) + ')">📕 OPEN PDF' + (o.source.page ? ' AT PAGE ' + o.source.page : '') + '</button></div>'
        : (o.source.documentId ? '<div class="cc-dim" style="margin-top:6px">The source document is no longer on file.</div>' : '')) +
      '</div>';
  }

  function historyPanel(biz, o) {
    var C = CR();
    var hist = C.history(_state, biz, o.metricKey);
    var trend = C.trend(_state, biz, o.metricKey);
    var html = '<div class="cc-panel"><div class="cc-name">HISTORY — ' + hist.length + ' OBSERVATION' + (hist.length === 1 ? "" : "S") + '</div>';
    html += '<div class="cc-hist">' + hist.map(function (h) {
      var isCur = h.id === o.id;
      return '<div class="cc-hist-row' + (isCur ? " cur" : "") + '"><span>' + esc(h.effectiveDate ? C.fmtDate(h.effectiveDate) : "undated") + '</span>' +
        '<b>' + (h.status === "available" ? esc(C.formatValue(h)) : esc(C.statusLabel(h.status))) + (h.riskLevel && h.kind !== "category" ? ' <span class="cc-dim">' + esc(h.riskLevel) + '</span>' : '') + '</b>' +
        '<span>' + (h.source.method === "manual" ? chip("MANUAL", "info") : chip("AUTO", "cyan")) + (isCur ? ' ' + chip("CURRENT", "ok") : (h.historical ? ' ' + chip("HISTORICAL", "muted") : "")) + '</span>' +
        '<span class="cc-dim cc-full">' + esc(h.source.fileName || (h.source.method === "manual" ? "entered by hand" : "")) + (h.source.page ? ' · p' + h.source.page : '') + ' · imported ' + esc(fmtTs(h.importedAt)) + (h.note ? ' · ' + esc(h.note) : '') + '</span></div>';
    }).join("") + '</div>';
    if (trend) {
      html += '<div class="cc-name" style="margin-top:8px">TREND</div><div class="cc-trend">' + trend.map(function (t) {
        return '<div class="cc-trend-col"><div class="cc-dim">' + esc(t.label) + '</div><div style="font-weight:800;color:' + (t.value == null ? "#4b5563" : "#e2e8f0") + '">' + (t.value == null ? "—" : esc(String(t.value))) + '</div></div>';
      }).join("") + '</div><div class="cc-dim">A month with no report is shown as — , never as zero.</div>';
    } else if (hist.length < 2) {
      html += '<div class="cc-dim">A trend appears once a second dated report is imported.</div>';
    }
    return html + '</div>';
  }

  /* ---------- documents vault ---------- */
  function docById(biz, id) {
    if (!id) return null;
    return ((_state.docs[biz] && _state.docs[biz].files) || []).filter(function (f) { return f.id === id; })[0] || null;
  }
  function documents(biz, sum) {
    var C = CR();
    var ledger = C.ensure(_state, biz);
    var s = st();
    var html = '<div class="card cc-block"><div class="cc-block-title">SOURCE DOCUMENTS — THE EVIDENCE VAULT</div>' +
      '<div class="cc-dim" style="margin-bottom:8px">Every credit report ever imported, newest first. Re-analyze runs the newest parser over a filed document without uploading it again.</div>';
    if (!ledger.documents.length) {
      html += '<div class="empty" style="padding:16px">No credit reports on file yet.</div>' +
        '<div class="row" style="margin-top:8px"><button class="btn btn-red" onclick="pickAutofill(' + arg(biz) + ',\'afPdf\',\'fin\')">📄 IMPORT A CREDIT REPORT</button></div>';
      return html + '</div>';
    }
    ledger.documents.slice().sort(function (a, b) { return (b.reportDate || "").localeCompare(a.reportDate || "") || (b.importedAt - a.importedAt); }).forEach(function (d) {
      var rec = docById(biz, d.docId);
      var prov = C.provider(d.provider);
      var open = s.doc[biz + ":" + d.docId];
      html += '<div class="cc-doc"><div class="cc-doc-head"><div>' +
        '<div style="font-weight:700;color:#e2e8f0">' + esc(d.reportLabel || (prov ? prov.reportLabel : "Credit report")) + '</div>' +
        '<div class="cc-dim">' + esc(d.fileName) + '</div>' +
        '<div class="cc-dim">Report ' + esc(d.reportDate ? C.fmtDate(d.reportDate) : "undated") + ' · imported ' + esc(fmtTs(d.importedAt)) + (d.pageCount ? ' · ' + d.pageCount + ' pages' : '') +
        ' · ' + d.metricCount + ' credit metric' + (d.metricCount === 1 ? "" : "s") + ' saved · ' + d.extendedCount + ' extra fact' + (d.extendedCount === 1 ? "" : "s") +
        ' · parser v' + esc(String(d.extractionVersion || "?")) + (d.reanalyzedAt ? ' · re-analysed ' + esc(fmtTs(d.reanalyzedAt)) : '') + '</div></div>' +
        (rec ? '' : chip("RECORD MISSING", "warn")) + '</div>' +
        '<div class="row cc-btns" style="flex-wrap:wrap">' +
        (rec ? '<button class="btn btn-ghost cc-mini" onclick="openSavedDoc(' + arg(biz) + ',' + arg(rec.id) + ')">📂 OPEN</button>' : '') +
        (rec ? '<button class="btn btn-ghost cc-mini" onclick="docaiReanalyze(' + arg(biz) + ',' + arg(rec.id) + ')">↻ RE-ANALYZE</button>' : '') +
        '<button class="btn btn-ghost cc-mini" onclick="ccDoc(' + arg(biz + ":" + d.docId) + ')">' + (open ? "✕ EXTRACTION" : "VIEW EXTRACTION") + '</button>' +
        '</div>';
      if (open) {
        var mine = ledger.observations.filter(function (o) { return o.source.documentId === d.docId; });
        var facts = ledger.extended.filter(function (e) { return e.documentId === d.docId; });
        html += '<div class="cc-panel"><div class="cc-name">WHAT THIS DOCUMENT RECORDED</div>' +
          (mine.length ? '<div class="cc-hist">' + mine.map(function (o) {
            return '<div class="cc-hist-row"><span>' + esc(o.displayName) + '</span><b>' + (o.status === "available" ? esc(C.formatValue(o)) : esc(C.statusLabel(o.status))) + '</b><span class="cc-dim">p' + (o.source.page || "?") + '</span><span class="cc-dim">' + esc(o.source.confidence || "") + (o.historical ? " · historical" : "") + '</span></div>';
          }).join("") + '</div>' : '<div class="cc-dim">No credit metrics were saved from this document.</div>') +
          (facts.length ? '<div class="cc-name" style="margin-top:8px">EXTENDED FACTS (' + facts.length + ')</div><div class="cc-hist">' + facts.map(function (e) {
            return '<div class="cc-hist-row"><span>' + esc(e.label) + '</span><b>' + esc(e.valueText) + '</b><span class="cc-dim">p' + (e.page || "?") + '</span><span class="cc-dim">' + esc(e.section || "") + '</span></div>';
          }).join("") + '</div>' : '') + '</div>';
      }
      html += '</div>';
    });
    html += '<div class="row" style="margin-top:10px"><button class="btn btn-red" onclick="pickAutofill(' + arg(biz) + ',\'afPdf\',\'fin\')">📄 IMPORT ANOTHER REPORT</button></div>';
    return html + '</div>';
  }

  /* ---------- handlers ---------- */
  window.ccTab = function (biz, tab) { st().tab[biz] = tab; render(); };
  window.ccOpen = function (key, what) { var s = st(); s.open[key] = s.open[key] === what ? null : what; render(); };
  window.ccDoc = function (key) { var s = st(); s.doc[key] = !s.doc[key]; render(); };
  window.ccVerify = function (biz, obsId, on) { CR().verify(_state, biz, obsId, on); commit(); };
  window.ccResolve = function (biz, keepId, otherId, choice) {
    CR().resolveConflict(_state, biz, keepId, otherId, choice);
    commit();
  };
  window.ccEdit = function (biz, metricKey) {
    var C = CR();
    var cur = C.current(_state, biz)[metricKey];
    if (!cur) return;
    var def = C.metricDef(cur.provider, cur.metricType, cur);
    var scale = cur.scaleMin != null ? " (" + cur.scaleMin + "–" + cur.scaleMax + ")" : "";
    var v = prompt("Correct " + cur.displayName + scale + ". Leave empty to record it as DATA NOT AVAILABLE.\nThe imported value stays in history.", cur.status === "available" ? (cur.valueText || cur.value) : "");
    if (v === null) return;
    v = String(v).trim();
    var num = parseFloat(v.replace(/[$,%\s]/g, ""));
    var numeric = v && !isNaN(num) && /^[\s$]*[\d.,]+\s*%?$/.test(v);
    if (numeric && cur.scaleMin != null && (num < cur.scaleMin || num > cur.scaleMax)) {
      alert(cur.displayName + " must be between " + cur.scaleMin + " and " + cur.scaleMax + ". Nothing was changed.");
      return;
    }
    var risk = "";
    if (v && (def.kind === "score" || def.kind === "category")) {
      risk = prompt("Risk level as the bureau states it (Low, Low-Moderate, Moderate, Moderate-High, High) — optional:", cur.riskLevel || "") || "";
    }
    var date = prompt("Report date this value is as of (YYYY-MM-DD):", cur.effectiveDate || new Date().toISOString().slice(0, 10));
    if (date === null) return;
    var note = prompt("Note (why this was entered by hand):", "") || "";
    C.manual(_state, biz, cur.provider, cur.metricType, {
      value: numeric ? num : null, valueText: v, riskLevel: risk.trim(),
      status: v ? "available" : "data_not_available", effectiveDate: String(date).trim(), note: note
    });
    ui.afStatus = "✓ " + cur.displayName + " recorded as a MANUAL entry. The imported value is kept in its history.";
    commit();
  };
  window.ccAddManual = function (biz, pid) {
    var C = CR();
    var p = C.PROVIDERS[pid];
    if (!p) return;
    var types = Object.keys(p.metrics).filter(function (mt) { return p.metrics[mt].counted; });
    var pick = prompt("Which " + p.short + " metric?\n" + types.map(function (t, i) { return (i + 1) + ". " + p.metrics[t].label; }).join("\n"), "1");
    if (pick === null) return;
    var mt = types[parseInt(pick, 10) - 1];
    if (!mt) { alert("Pick a number from the list."); return; }
    var m = p.metrics[mt];
    var v = prompt(m.label + (m.scaleMin != null ? " (" + m.scaleMin + "–" + m.scaleMax + ")" : "") + ":", "");
    if (v === null) return;
    v = String(v).trim();
    var num = parseFloat(v.replace(/[$,%\s]/g, ""));
    var numeric = v && !isNaN(num) && /^[\s$]*[\d.,]+\s*%?$/.test(v);
    if (numeric && m.scaleMin != null && (num < m.scaleMin || num > m.scaleMax)) { alert("Out of range — nothing was changed."); return; }
    var date = prompt("Report date this value is as of (YYYY-MM-DD):", new Date().toISOString().slice(0, 10));
    if (date === null) return;
    var note = prompt("Where did this come from? (e.g. bureau portal, letter)", "") || "";
    C.manual(_state, biz, pid, mt, { value: numeric ? num : null, valueText: v, status: v ? "available" : "data_not_available", effectiveDate: String(date).trim(), note: note });
    st().tab[biz] = pid;
    ui.afStatus = "✓ " + m.label + " recorded as a MANUAL entry for " + p.label + ".";
    commit();
  };
  window.ccOpenPage = function (biz, docId, page) {
    var rec = docById(biz, docId);
    if (!rec || !rec.blobId || !window.DOCAI) { ui.afStatus = "That document's file is not available."; render(); return; }
    DOCAI.store.getBlob(rec.blobId).then(function (b) {
      if (!b) { ui.afStatus = "\"" + rec.name + "\" is no longer in document storage."; render(); return; }
      // Chrome's PDF viewer honours #page= on a blob URL; other viewers open page 1.
      window.open(DOCAI.util.objectUrl(b) + "#page=" + (page || 1), "_blank");
    });
  };

  /* Re-analyze: run the current parser over a filed document. The original
     file is read from storage (or its stored text, if the blob is gone) and
     the result opens in the same review screen, framed as a re-analysis. */
  window.docaiReanalyze = function (biz, docId) {
    var rec = docById(biz, docId);
    if (!rec || !window.DOCAI) return;
    ui.afStatus = "Re-analysing “" + rec.name + "” with the newest parser…";
    _state.activeTab = "strength";
    ui.strengthOpen.scores = true;
    render();
    var opts = { state: _state, profiles: docaiProfiles(), reanalyze: { docId: rec.id, record: rec }, onStatus: function (m) { ui.afStatus = m; render(); } };
    var run = rec.blobId
      ? DOCAI.store.getBlob(rec.blobId).then(function (b) {
          if (b) return DOCAI.pipeline.run(new File([b], rec.name, { type: rec.type || b.type || "application/pdf" }), opts);
          return DOCAI.store.getText(rec.textRef || rec.id).then(function (pages) {
            if (!pages) throw new Error("neither the file nor its text is in storage any more");
            return DOCAI.pipeline.runPages(pages, { name: rec.name, type: rec.type, size: rec.size, sha256: rec.sha256 }, opts);
          });
        })
      : Promise.reject(new Error("this document was stored as a reference only"));
    run.then(function (proposal) {
      ui.afStatus = null;
      DOCAI.reviewUI.close();
      DOCAI.reviewUI.lastCtx = docaiCtx();
      DOCAI.reviewUI.open(proposal, DOCAI.reviewUI.lastCtx);
      ui.afReview = true;
      render();
    }).catch(function (e) {
      ui.afStatus = "Couldn't re-analyse that document: " + e.message;
      render();
    });
  };
})();
