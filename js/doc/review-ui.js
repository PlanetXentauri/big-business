/* ============================================================
   DOCAI · review-ui — the screen that stands between extraction and saving.

   Everything the pipeline inferred is shown here with its evidence, and
   nothing leaves this screen without an explicit press of Save. High
   confidence candidates start ticked as a convenience; Medium and Low start
   unticked, because a value nobody looked at should not be able to ride
   along with the ones that were checked.

   The markup uses the dashboard's own classes (.card, .form-panel, .btn,
   .chip) so the review reads as part of the app, not a bolted-on dialog.
   ============================================================ */
(function (root) {
  "use strict";

  var D = root.DOCAI || {};
  var U = D.util, MAP = D.mapping, CLASS = D.classifier, STORE = D.store, TX = D.transaction;

  var R = {};

  // Live review session. Held here rather than in the app's `ui` object so a
  // stray render() cannot lose it, and so Cancel has exactly one thing to clear.
  R.session = null;

  var BIZ_LABEL = { centauri: "🌐 CENTAURI WORLD LLC", keypr: "🔑 KEYPR ON COMPANY" };
  var CONF_COLOR = { High: "var(--green)", Medium: "var(--amber)", Low: "#ef4444" };

  /* ---------- open ---------- */
  R.open = function (proposal, ctx) {
    var isLink = proposal.source === "link";
    var detectedBiz = proposal.business.business || null;
    var sameBizDuplicate = isLink && detectedBiz && (proposal.exactDuplicates || []).some(function (d) {
      return d.biz === detectedBiz;
    });
    R.session = {
      proposal: proposal,
      isLink: isLink,
      ctx: ctx,                          // { state, commit, render, activeBiz }
      biz: detectedBiz,
      docType: proposal.classification.typeId,
      category: proposal.classification.category,
      siteType: isLink ? proposal.classification.typeId : null,
      showPaste: false,
      // Only High starts ticked. Anything less has to be looked at.
      checked: proposal.candidates.reduce(function (acc, c) {
        acc[c.id] = c.confidence === "High";
        return acc;
      }, {}),
      edited: {},
      resolutions: {},                   // dest -> keep | replace | alternate
      expanded: {},
      previewUrl: null,
      // Reusing the already-saved source is the safe default: selected
      // values can save without creating a silent duplicate copy.
      duplicateChoice: sameBizDuplicate ? "link" : null,
      status: ""
    };
    // Pre-resolve conflicts to "keep" so an unattended save can never
    // overwrite: replacing is always something the user turns on.
    proposal.candidates.forEach(function (c) {
      if (R.existingValue(c.dest) !== "") R.session.resolutions[c.dest] = "keep";
    });
    return R.session;
  };

  R.close = function () {
    if (R.session && R.session.previewUrl) {
      try { URL.revokeObjectURL(R.session.previewUrl); } catch (e) {}
    }
    U.revokeAll();
    R.session = null;
  };

  R.existingValue = function (dest) {
    var s = R.session;
    if (!s || !s.biz) return "";
    var d = MAP.get(dest);
    if (!d || d.internal) return "";
    var store = d.store === "fin" ? s.ctx.state.fin[s.biz] : s.ctx.state.bp[s.biz];
    var v = store && store[d.key];
    return v == null ? "" : String(v);
  };

  R.currentValue = function (c) {
    var s = R.session;
    return Object.prototype.hasOwnProperty.call(s.edited, c.id) ? s.edited[c.id] : c.value;
  };

  /* ---------- render ---------- */
  R.html = function () {
    var s = R.session;
    if (!s) return "";
    var p = s.proposal;

    var LR = D.linkReview;
    var out = '<div class="form-panel" id="docai-review" style="gap:14px">';

    if (s.isLink && LR) {
      out += LR.header(p);
      out += LR.retrievalBlock(p, s);
      out += LR.duplicates(p, s);
      out += businessBlock(p, s);
      out += LR.siteTypeBlock(p, s);
    } else {
      out += header(p);
      out += duplicates(p, s);
      out += businessBlock(p, s);
      out += documentBlock(p, s);
    }
    out += notesBlock(p);

    if (!p.candidates.length) {
      out += '<div class="empty" style="padding:20px">' +
        (s.isLink
          ? 'No values could be evidenced on this page. You can still save the link itself — nothing has been changed.'
          : 'No values could be evidenced in this document. You can still file the document itself — nothing has been changed.') +
        '</div>';
    } else {
      out += fieldsBlock(p, s);
    }

    out += rejectedBlock(p, s);
    out += actions(p, s);
    out += '</div>';
    return out;
  };

  function header(p) {
    return '<div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:200px">' +
      '<div style="font-size:12px;letter-spacing:0.2em;color:var(--accent);font-weight:700">REVIEW IMPORT — NOTHING IS SAVED YET</div>' +
      '<div style="font-size:15px;color:#e2e8f0;margin-top:4px;word-break:break-all">' + U.esc(p.fileName) + '</div>' +
      '<div style="font-size:12px;color:#8794ab;margin-top:2px">' +
      fmtSize(p.fileSize) + ' · ' + p.pageCount + ' page(s) · SHA-256 ' + U.esc(p.sha256.slice(0, 12)) + '…' +
      '</div></div>' +
      '<button class="btn btn-ghost" style="font-size:11px;padding:5px 10px" onclick="DOCAI.reviewUI.preview()">👁 OPEN ORIGINAL</button>' +
      '</div>' +
      '<div id="docai-preview"></div>';
  }

  function fmtSize(n) {
    return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? Math.round(n / 1024) + " KB" : (n || 0) + " B";
  }

  /* ---------- duplicates ---------- */
  function duplicates(p, s) {
    var out = "";
    if (p.exactDuplicates && p.exactDuplicates.length) {
      var d = p.exactDuplicates[0];
      out += '<div class="card" style="padding:14px 16px;border-left:3px solid #ef4444;background:rgba(239,68,68,0.07)">' +
        '<div style="font-size:12px;letter-spacing:0.18em;color:#ef4444;font-weight:800;margin-bottom:6px">⚠ EXACT DUPLICATE</div>' +
        '<div style="font-size:14px;color:#e2e8f0">This file is byte-for-byte identical to <b>' + U.esc(d.file.name) + '</b>, ' +
        'already filed under ' + U.esc(BIZ_LABEL[d.biz]) + ' on ' + new Date(d.file.ts).toLocaleDateString() + '.</div>' +
        '<div style="font-size:13px;color:#9aa8c2;margin-top:8px">Choose what to do — no copy is created unless you ask for one:</div>' +
        '<div class="row" style="margin-top:8px;flex-wrap:wrap">' +
        '<button class="btn btn-ghost" style="flex:1;min-width:130px" onclick="DOCAI.reviewUI.openExisting(\'' + d.biz + '\',\'' + d.file.id + '\')">📂 OPEN EXISTING</button>' +
        '<button class="btn btn-ghost" style="flex:1;min-width:130px" onclick="DOCAI.reviewUI.setDup(\'link\')">🔗 LINK TO MORE FIELDS</button>' +
        '<button class="btn btn-ghost" style="flex:1;min-width:130px" onclick="DOCAI.reviewUI.setDup(\'meta\')">✎ UPDATE METADATA ONLY</button>' +
        '<button class="btn btn-ghost" style="flex:1;min-width:130px" onclick="DOCAI.reviewUI.setDup(\'both\')">➕ KEEP BOTH ON PURPOSE</button>' +
        '</div>' +
        (s.duplicateChoice ? '<div style="font-size:13px;color:var(--accent);margin-top:8px">Selected: ' + U.esc(dupLabel(s.duplicateChoice)) + '</div>' : '') +
        '</div>';
    }
    if (p.likelyDuplicates && p.likelyDuplicates.length) {
      var l = p.likelyDuplicates[0];
      out += '<div class="card" style="padding:12px 16px;border-left:3px solid var(--amber);background:rgba(245,158,11,0.06)">' +
        '<div style="font-size:12px;letter-spacing:0.18em;color:var(--amber);font-weight:800;margin-bottom:4px">⚠ LIKELY DUPLICATE</div>' +
        '<div style="font-size:14px;color:#e2e8f0">Very similar to <b>' + U.esc(l.file.name) + '</b> — ' + U.esc(l.reasons.join(", ")) + '.</div>' +
        '<div style="font-size:12px;color:#8794ab;margin-top:4px">The files differ, so this is not blocked — check it is not the same statement downloaded twice.</div>' +
        '</div>';
    }
    return out;
  }
  function dupLabel(k) {
    return { link: "link the existing document to more fields", meta: "update the existing document's metadata only", both: "keep both copies deliberately" }[k] || k;
  }

  /* ---------- business ---------- */
  function businessBlock(p, s) {
    var b = p.business;
    var needsChoice = b.requiresManualChoice || !s.biz;
    var color = needsChoice ? "var(--amber)" : "var(--green)";

    var out = '<div class="card" style="padding:14px 16px;border-left:3px solid ' + color + '">' +
      '<div style="font-size:12px;letter-spacing:0.18em;color:' + color + ';font-weight:800;margin-bottom:8px">' +
      (needsChoice ? "⚠ CONFIRM THE BUSINESS" : "✓ DETECTED BUSINESS") + '</div>';

    // Warn loudly when the document points somewhere other than the tab the
    // user is looking at — this is the mistake that is hardest to reverse.
    if (b.business && s.ctx.activeBiz && b.business !== s.ctx.activeBiz) {
      out += '<div style="font-size:13px;color:var(--amber);background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.35);border-radius:8px;padding:8px 10px;margin-bottom:8px">' +
        (s.isLink ? 'This page matches <b>' : 'This document matches <b>') + U.esc(BIZ_LABEL[b.business]) + '</b>, not the business you are viewing ' +
        '(' + U.esc(BIZ_LABEL[s.ctx.activeBiz]) + '). Saving will file it under the matched business.</div>';
    }

    out += '<div class="row" style="gap:8px;margin-bottom:8px">';
    ["centauri", "keypr"].forEach(function (id) {
      var on = s.biz === id;
      out += '<button class="btn ' + (on ? "btn-red" : "btn-ghost") + '" style="flex:1" ' +
        'onclick="DOCAI.reviewUI.setBiz(\'' + id + '\')">' + (on ? "✓ " : "") + U.esc(BIZ_LABEL[id]) + '</button>';
    });
    out += '</div>';

    out += '<div style="font-size:13px;color:#9aa8c2">' +
      '<b style="color:' + (CONF_COLOR[b.confidence] || "#8794ab") + '">' + U.esc(b.confidence) + ' confidence</b> · ' +
      U.esc(b.reasons.join(" ")) + '</div>';

    if (b.evidence && b.evidence.length) {
      out += '<div style="margin-top:8px;font-size:12px;color:#8794ab">EVIDENCE USED</div>' +
        '<div class="col" style="gap:4px;margin-top:4px">' +
        b.evidence.map(function (e) {
          return '<div style="font-size:12px;color:#9aa8c2;background:rgba(255,255,255,0.03);border-radius:6px;padding:6px 9px">' +
            '<span class="chip" style="background:rgba(255,255,255,0.06);color:#94a3b8;margin-right:6px">' + U.esc(e.kind) + '</span>' +
            U.esc(BIZ_LABEL[e.business]) + ' — matched <b>' + U.esc(e.matched) + '</b>' +
            (e.excerpt ? '<div style="color:#6b7a90;margin-top:3px;font-style:italic">“' + U.esc(e.excerpt) + '”</div>' : '') +
            '</div>';
        }).join("") + '</div>';
    } else {
      out += '<div style="margin-top:6px;font-size:12px;color:#8794ab">No identifying evidence was found — pick the business yourself.</div>';
    }
    return out + '</div>';
  }

  /* ---------- document type and category ---------- */
  function documentBlock(p, s) {
    var c = p.classification;
    var out = '<div class="card" style="padding:14px 16px">' +
      '<div style="font-size:12px;letter-spacing:0.18em;color:#94a3b8;font-weight:800;margin-bottom:8px">DOCUMENT TYPE</div>' +
      '<select id="docai-doctype" onchange="DOCAI.reviewUI.setDocType(this.value)" style="margin-bottom:8px">';
    var types = [CLASS.UNCLASSIFIED].concat(CLASS.TYPES);
    types.forEach(function (t) {
      out += '<option value="' + t.id + '"' + (t.id === s.docType ? " selected" : "") + '>' + U.esc(t.label) + '</option>';
    });
    out += '</select>';

    out += '<div style="font-size:13px;color:#9aa8c2">' +
      '<b style="color:' + (CONF_COLOR[c.confidence] || "#8794ab") + '">' + U.esc(c.confidence) + ' confidence</b> · ' +
      U.esc(c.reasons.join(" ")) + '</div>';

    if (c.evidence && c.evidence.length) {
      out += '<div style="margin-top:6px;font-size:12px;color:#6b7a90;font-style:italic">' +
        c.evidence.slice(0, 3).map(function (e) { return "“" + U.esc(e.matched) + "”"; }).join(" · ") + '</div>';
    }

    var cat = CLASS.CATEGORIES[s.category] || CLASS.CATEGORIES.unfiled;
    out += '<div style="margin-top:10px;font-size:12px;letter-spacing:0.18em;color:#94a3b8;font-weight:800">FILED UNDER</div>' +
      '<select id="docai-category" onchange="DOCAI.reviewUI.setCategory(this.value)">';
    Object.keys(CLASS.CATEGORIES).forEach(function (k) {
      out += '<option value="' + k + '"' + (k === s.category ? " selected" : "") + '>' + U.esc(CLASS.CATEGORIES[k].label) + '</option>';
    });
    out += '</select>';
    return out + '</div>';
  }

  /* ---------- processing notes ---------- */
  function notesBlock(p) {
    var items = (p.warnings || []).map(function (w) { return { level: "warn", text: w }; })
      .concat((p.notes || []).map(function (n) { return { level: "note", text: n }; }));
    if (!items.length) return "";
    return '<details style="background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:8px;padding:8px 12px">' +
      '<summary style="cursor:pointer;font-size:12px;letter-spacing:0.15em;color:#94a3b8;font-weight:700">HOW THIS FILE WAS READ (' + items.length + ')</summary>' +
      '<div class="col" style="gap:4px;margin-top:8px">' +
      items.map(function (i) {
        return '<div style="font-size:12px;color:' + (i.level === "warn" ? "var(--amber)" : "#8794ab") + '">' +
          (i.level === "warn" ? "⚠ " : "· ") + U.esc(i.text) + '</div>';
      }).join("") + '</div></details>';
  }

  /* ---------- the candidate fields ---------- */
  function fieldsBlock(p, s) {
    var groups = MAP.groupBySection(p.candidates);
    var high = p.candidates.filter(function (c) { return c.confidence === "High"; }).length;

    var out = '<div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">' +
      '<div style="font-size:12px;letter-spacing:0.18em;color:var(--accent);font-weight:800">' +
      'PROPOSED VALUES — ' + p.candidates.length + '</div>' +
      '<span class="chip" style="background:rgba(255,255,255,0.05);color:#94a3b8">' + high + ' HIGH CONFIDENCE PRE-TICKED</span>' +
      '<button class="btn btn-ghost" style="font-size:11px;padding:4px 9px;margin-left:auto" onclick="DOCAI.reviewUI.checkAll(true)">TICK ALL</button>' +
      '<button class="btn btn-ghost" style="font-size:11px;padding:4px 9px" onclick="DOCAI.reviewUI.checkAll(false)">UNTICK ALL</button>' +
      '</div>';

    groups.forEach(function (g) {
      out += '<div style="font-size:12px;letter-spacing:0.15em;color:#6b7a90;font-weight:700;margin:10px 0 6px">' +
        U.esc(g.section.toUpperCase()) + '</div>';
      g.items.forEach(function (c) { out += fieldRow(c, s); });
    });
    return out + '</div>';
  }

  function fieldRow(c, s) {
    var checked = !!s.checked[c.id];
    var manuallyApproved = checked && c.confidence !== "High";
    var existing = R.existingValue(c.dest);
    var conflict = existing !== "";
    var resolution = s.resolutions[c.dest] || "replace";
    var value = R.currentValue(c);
    var expanded = !!s.expanded[c.id];
    var color = CONF_COLOR[c.confidence] || "#8794ab";
    var shown = c.sensitive ? U.maskFor(c.dest, value) : value;

    var out = '<div class="card" style="padding:12px 14px;margin-bottom:8px;border-left:3px solid ' +
      (checked ? color : "rgba(255,255,255,0.08)") + '">';

    // header line: tick, label, confidence
    out += '<div style="display:flex;gap:10px;align-items:flex-start">' +
      '<input type="checkbox" id="dc-' + c.id + '" ' + (checked ? "checked" : "") +
      ' onchange="DOCAI.reviewUI.toggle(\'' + c.id + '\',this.checked)" style="width:auto;flex-shrink:0;margin-top:3px">' +
      '<div style="flex:1;min-width:0">' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<span style="font-size:14px;font-weight:700;color:#e2e8f0">' + U.esc(c.label) + '</span>' +
      '<span class="chip" style="background:' + color + '22;color:' + color + ';border:1px solid ' + color + '55">' + U.esc(c.confidence.toUpperCase()) + '</span>' +
      (manuallyApproved ? '<span class="chip" style="background:rgba(16,185,129,0.14);color:var(--green);border:1px solid rgba(16,185,129,0.45)">✓ MANUALLY APPROVED</span>' : '') +
      (c.sensitive ? '<span class="chip" style="background:rgba(255,255,255,0.06);color:#94a3b8">🔒 MASKED</span>' : '') +
      (conflict ? '<span class="chip" style="background:rgba(245,158,11,0.15);color:var(--amber);border:1px solid rgba(245,158,11,0.4)">CONFLICT</span>' : '') +
      '<span style="font-size:11px;color:#6b7a90;margin-left:auto">page ' + c.page + '</span>' +
      '</div>' +
      '<div style="font-size:11px;color:#6b7a90;margin-top:2px">→ ' + U.esc(MAP.section(c.dest)) + ' · ' + U.esc(MAP.label(c.dest)) + '</div>';

    // value editor
    out += '<div class="row" style="margin-top:6px">' +
      '<input id="dv-' + c.id + '" value="' + U.esc(value) + '" ' +
      'oninput="DOCAI.reviewUI.edit(\'' + c.id + '\',this.value)" style="flex:1">' +
      '</div>';
    if (c.sensitive) {
      out += '<div style="font-size:11px;color:#6b7a90;margin-top:3px">Shown in full here so you can check it. Stored intact, displayed as ' +
        U.esc(shown) + ' everywhere else.</div>';
    }

    // conflict resolution
    if (conflict) {
      var existingShown = c.sensitive ? U.maskFor(c.dest, existing) : existing;
      out += '<div style="margin-top:8px;background:rgba(245,158,11,0.07);border:1px solid rgba(245,158,11,0.28);border-radius:8px;padding:9px 11px">' +
        '<div style="font-size:12px;color:var(--amber);font-weight:700;margin-bottom:6px">THIS FIELD ALREADY HAS A VALUE</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">' +
        '<div><div style="font-size:11px;color:#6b7a90">CURRENT</div><div style="color:#e2e8f0;word-break:break-word">' + U.esc(existingShown) + '</div></div>' +
        '<div><div style="font-size:11px;color:#6b7a90">FROM THIS DOCUMENT</div><div style="color:var(--gold);word-break:break-word">' + U.esc(c.sensitive ? U.maskFor(c.dest, value) : value) + '</div></div>' +
        '</div><div class="row" style="margin-top:8px;flex-wrap:wrap">' +
        resButton(c, "keep", "KEEP CURRENT", resolution) +
        resButton(c, "replace", "REPLACE", resolution) +
        resButton(c, "alternate", "KEEP BOTH", resolution) +
        '</div>' +
        '<div style="font-size:11px;color:#6b7a90;margin-top:6px">' + U.esc(resHint(resolution)) + '</div>' +
        '</div>';
    }

    // Validation warnings remain visible, but a reviewed warning is not a
    // hard block. Definitively invalid candidates live in rejectedBlock and
    // are never offered with a checkbox at all.
    if (c.validation.warnings.length) {
      out += '<div style="margin-top:6px">' + c.validation.warnings.map(function (w) {
        return '<div style="font-size:12px;color:var(--amber)">⚠ ' + U.esc(w) + '</div>';
      }).join("") + '</div>';
    }
    if (manuallyApproved) {
      out += '<div style="font-size:12px;color:var(--green);margin-top:6px">✓ You reviewed and selected this ' +
        U.esc(c.confidence) + '-confidence value. It will be saved exactly as shown when you press the final Save button.</div>';
    }

    // where a web value came from, always visible — the source is the point
    if (c.web && D.linkReview) out += D.linkReview.provenance(c);

    // evidence toggle
    out += '<div style="margin-top:6px"><span style="font-size:12px;color:#8794ab;cursor:pointer;text-decoration:underline" ' +
      'onclick="DOCAI.reviewUI.expand(\'' + c.id + '\')">' + (expanded ? "Hide" : "Show") + ' source &amp; reasoning</span></div>';

    if (expanded) {
      out += '<div style="margin-top:6px;background:rgba(255,255,255,0.03);border-radius:8px;padding:9px 11px">' +
        '<div style="font-size:11px;color:#6b7a90;margin-bottom:3px">FROM ' + U.esc(s.proposal.fileName) + ', PAGE ' + c.page + '</div>' +
        '<div style="font-size:12px;color:#9aa8c2;font-style:italic">“' + U.esc(c.excerpt) + '”</div>' +
        (c.bbox ? '<div style="font-size:11px;color:#6b7a90;margin-top:4px">Located at x' + Math.round(c.bbox.x) + ', y' + Math.round(c.bbox.y) +
          ' on the page <span style="cursor:pointer;text-decoration:underline" onclick="DOCAI.reviewUI.showRegion(\'' + c.id + '\')">— highlight it</span></div>' : '') +
        '<div style="font-size:11px;color:#6b7a90;margin-top:6px">WHY THIS CONFIDENCE</div>' +
        c.reasons.map(function (r) { return '<div style="font-size:12px;color:#9aa8c2">· ' + U.esc(r) + '</div>'; }).join("") +
        '<div style="font-size:11px;color:#6b7a90;margin-top:6px">RAW TEXT AS IT APPEARED</div>' +
        '<div style="font-size:12px;color:#9aa8c2;word-break:break-all">' + U.esc(c.sensitive ? U.maskFor(c.dest, c.raw) : c.raw) + '</div>' +
        '</div>';
    }

    // alternates
    if (c.alternates && c.alternates.length) {
      out += '<div style="margin-top:8px;background:rgba(59,130,246,0.07);border:1px solid rgba(59,130,246,0.3);border-radius:8px;padding:9px 11px">' +
        '<div style="font-size:12px;color:#93c5fd;font-weight:700;margin-bottom:5px">' + c.alternates.length +
        ' OTHER CANDIDATE(S) FOR THIS FIELD</div>' +
        c.alternates.map(function (a, i) {
          return '<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">' +
            '<span style="flex:1;min-width:0;font-size:13px;color:#e2e8f0;word-break:break-word">' +
            U.esc(c.sensitive ? U.maskFor(c.dest, a.value) : a.value) +
            ' <span style="color:#6b7a90;font-size:11px">(' + U.esc(a.confidence) + ', page ' + a.page + ')</span></span>' +
            '<button class="btn btn-ghost" style="font-size:11px;padding:4px 9px" onclick="DOCAI.reviewUI.useAlternate(\'' + c.id + '\',' + i + ')">USE THIS</button>' +
            '</div>';
        }).join("") + '</div>';
    }

    return out + '</div></div></div>';
  }

  function resButton(c, key, label, current) {
    var on = current === key;
    return '<button class="btn ' + (on ? "btn-red" : "btn-ghost") + '" style="flex:1;font-size:11px;padding:6px 8px" ' +
      'onclick="DOCAI.reviewUI.resolve(\'' + c.dest + '\',\'' + key + '\')">' + (on ? "✓ " : "") + label + '</button>';
  }
  function resHint(r) {
    return {
      keep: "The current value stays. The new one is filed in this field's history, not thrown away.",
      replace: "The new value is written. The old one is filed in this field's history and can be recovered.",
      alternate: "The current value stays and the new one is kept alongside it as an alternate."
    }[r] || "";
  }

  /* ---------- values the validators threw out ---------- */
  function rejectedBlock(p) {
    if (!p.rejected || !p.rejected.length) return "";
    return '<details style="background:rgba(239,68,68,0.05);border:1px solid rgba(239,68,68,0.22);border-radius:8px;padding:8px 12px">' +
      '<summary style="cursor:pointer;font-size:12px;letter-spacing:0.15em;color:#ef4444;font-weight:700">' +
      'REJECTED BY VALIDATION (' + p.rejected.length + ') — NOT OFFERED</summary>' +
      '<div class="col" style="gap:4px;margin-top:8px">' +
      p.rejected.map(function (r) {
        return '<div style="font-size:12px;color:#9aa8c2">' +
          '<b>' + U.esc(r.label) + '</b> (page ' + r.page + '): ' + U.esc(r.errors.join("; ")) + '</div>';
      }).join("") +
      '<div style="font-size:11px;color:#6b7a90;margin-top:6px">These failed a definitive check, so they are shown here rather than presented as values you could save.</div>' +
      '</div></details>';
  }

  /* ---------- actions ---------- */
  function actions(p, s) {
    var ticked = p.candidates.filter(function (c) { return s.checked[c.id]; }).length;
    var reviewedWarnings = p.candidates.filter(function (c) {
      return s.checked[c.id] && c.confidence !== "High";
    }).length;
    var replacing = p.candidates.filter(function (c) {
      return s.checked[c.id] && R.existingValue(c.dest) !== "" && s.resolutions[c.dest] === "replace";
    }).length;
    var blocked = !s.biz;
    var exactLink = s.isLink && p.exactDuplicates && p.exactDuplicates.length;
    var saveLabel = s.isLink
      ? (exactLink && s.duplicateChoice === "link"
          ? '✅ SAVE ' + ticked + ' VALUE(S) TO EXISTING LINK'
          : exactLink && (s.duplicateChoice === "meta" || s.duplicateChoice === "recheck")
            ? '✅ UPDATE SAVED LINK'
            : '✅ SAVE ' + ticked + ' VALUE(S) + LINK')
      : '✅ SAVE SELECTED (' + ticked + ')';

    var out = "";
    if (s.status) {
      out += '<div style="font-size:13px;color:var(--accent);padding:8px 12px;background:var(--accent-dim);border:1px solid var(--accent-brd);border-radius:8px">' +
        U.esc(s.status) + '</div>';
    }
    if (blocked) {
      out += '<div style="font-size:13px;color:var(--amber);padding:8px 12px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.35);border-radius:8px">' +
        'Choose the destination business above to enable Save. Checked Medium and Low values are allowed; their confidence color is a warning, not a save block.</div>';
    }

    out += '<div style="font-size:12px;color:#8794ab">' +
      ticked + ' value(s) ticked' +
      (reviewedWarnings ? ' · <span style="color:var(--green)">' + reviewedWarnings + ' warning value(s) manually approved</span>' : '') +
      (replacing ? ' · <span style="color:var(--amber)">' + replacing + ' will replace an existing value</span>' : '') +
      (s.biz ? ' · filing under <b style="color:#e2e8f0">' + U.esc(BIZ_LABEL[s.biz]) + '</b>' : '') +
      (s.isLink ? '<br>The link itself is saved as a web source either way — Save selected does both.' : '') +
      '</div>';

    out += '<div class="row" style="flex-wrap:wrap">' +
      '<button class="btn btn-red" style="flex:2;min-width:150px"' + (blocked ? ' disabled' : '') +
      ' onclick="DOCAI.reviewUI.saveSelected()">' +
      saveLabel + '</button>' +
      '<button class="btn btn-ghost" style="flex:1;min-width:140px" onclick="DOCAI.reviewUI.saveDocOnly()">' +
      (s.isLink ? '🔗 SAVE LINK ONLY' : '📂 SAVE DOCUMENT ONLY') + '</button>' +
      '<button class="btn btn-ghost" style="flex:1;min-width:100px" onclick="DOCAI.reviewUI.cancel()">✕ CANCEL</button>' +
      '</div>';

    if (TX.canUndo()) {
      out += '<div class="row"><button class="btn btn-ghost" style="flex:1;font-size:11px" onclick="DOCAI.reviewUI.undo()">↩ UNDO LAST IMPORT — ' +
        U.esc(TX.describeLast()) + '</button></div>';
    }
    return out;
  }

  /* ---------- handlers ---------- */
  function repaint() { if (R.session && R.session.ctx.render) R.session.ctx.render(); }

  R.setBiz = function (id) {
    var s = R.session; if (!s) return;
    s.biz = id;
    // Conflicts are business-specific, so re-evaluate them against the new
    // target and default every one of them back to "keep".
    s.resolutions = {};
    s.proposal.candidates.forEach(function (c) {
      if (R.existingValue(c.dest) !== "") s.resolutions[c.dest] = "keep";
    });
    if (s.isLink && s.proposal.exactDuplicates && s.proposal.exactDuplicates.length) {
      s.duplicateChoice = s.proposal.exactDuplicates.some(function (d) { return d.biz === id; }) ? "link" : null;
    }
    repaint();
  };
  R.setDocType = function (id) {
    var s = R.session; if (!s) return;
    s.docType = id;
    var t = CLASS.byId(id);
    if (t) s.category = t.category;
    repaint();
  };
  R.setCategory = function (id) { if (R.session) { R.session.category = id; repaint(); } };
  R.setDup = function (choice) { if (R.session) { R.session.duplicateChoice = choice; repaint(); } };
  R.toggle = function (id, on) { if (R.session) { R.session.checked[id] = !!on; repaint(); } };
  R.edit = function (id, v) { if (R.session) R.session.edited[id] = v; };  // no repaint: keeps focus in the input
  R.expand = function (id) { if (R.session) { R.session.expanded[id] = !R.session.expanded[id]; repaint(); } };
  R.resolve = function (dest, how) { if (R.session) { R.session.resolutions[dest] = how; repaint(); } };
  R.checkAll = function (on) {
    var s = R.session; if (!s) return;
    s.proposal.candidates.forEach(function (c) { s.checked[c.id] = !!on; });
    repaint();
  };
  R.useAlternate = function (id, i) {
    var s = R.session; if (!s) return;
    var c = s.proposal.candidates.filter(function (x) { return x.id === id; })[0];
    if (!c || !c.alternates[i]) return;
    var alt = c.alternates[i];
    // Swap primary and alternate so nothing is lost by choosing.
    var wasPrimary = { value: c.value, raw: c.raw, page: c.page, excerpt: c.excerpt, confidence: c.confidence, reasons: c.reasons };
    c.value = alt.value; c.raw = alt.raw; c.page = alt.page;
    c.excerpt = alt.excerpt; c.confidence = alt.confidence; c.reasons = alt.reasons;
    c.alternates[i] = wasPrimary;
    delete s.edited[c.id];
    repaint();
  };

  R.preview = function () {
    var s = R.session; if (!s) return;
    var el = document.getElementById("docai-preview");
    if (!el) return;
    if (s.previewUrl) { try { URL.revokeObjectURL(s.previewUrl); } catch (e) {} s.previewUrl = null; el.innerHTML = ""; return; }
    s.previewUrl = URL.createObjectURL(s.proposal.file);
    var t = (s.proposal.fileType || "").toLowerCase();
    if (t.indexOf("image/") === 0) {
      el.innerHTML = '<img src="' + s.previewUrl + '" style="max-width:100%;border-radius:10px;border:1px solid var(--border)">';
    } else if (t === "application/pdf") {
      el.innerHTML = '<embed src="' + s.previewUrl + '" type="application/pdf" style="width:100%;height:420px;border-radius:10px;border:1px solid var(--border)">';
    } else {
      el.innerHTML = '<a href="' + s.previewUrl + '" target="_blank" rel="noopener" style="color:#93c5fd;font-size:13px">Open ' + U.esc(s.proposal.fileName) + '</a>';
    }
  };

  R.showRegion = function (id) {
    var s = R.session; if (!s) return;
    var c = s.proposal.candidates.filter(function (x) { return x.id === id; })[0];
    if (!c || !c.bbox) return;
    if (!s.previewUrl) R.preview();
    var el = document.getElementById("docai-preview");
    if (!el) return;
    var img = el.querySelector("img");
    if (!img) { s.status = "Region highlighting is available for photos; open the PDF to see page " + c.page + "."; repaint(); return; }
    // Overlay a box scaled to the rendered image size.
    var wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;display:inline-block;max-width:100%";
    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(img);
    var box = document.createElement("div");
    var sx = img.clientWidth / (img.naturalWidth || 1);
    var sy = img.clientHeight / (img.naturalHeight || 1);
    box.style.cssText = "position:absolute;border:2px solid #E8B64C;background:rgba(232,182,76,0.18);pointer-events:none;" +
      "left:" + (c.bbox.x * sx) + "px;top:" + (c.bbox.y * sy) + "px;" +
      "width:" + (c.bbox.w * sx) + "px;height:" + (c.bbox.h * sy) + "px;";
    wrap.appendChild(box);
  };

  R.openExisting = function (biz, id) {
    var s = R.session; if (!s) return;
    var f = (s.ctx.state.docs[biz].files || []).filter(function (x) { return x.id === id; })[0];
    if (!f) return;
    if (f.blobId) {
      STORE.getBlob(f.blobId).then(function (blob) {
        if (!blob) { s.status = "That document's file is no longer in storage."; repaint(); return; }
        window.open(U.objectUrl(blob), "_blank");
      });
    } else if (f.dataUri) {
      fetch(f.dataUri).then(function (r) { return r.blob(); }).then(function (b) {
        window.open(U.objectUrl(b), "_blank");
      });
    } else {
      s.status = "That document was stored as a reference only — the file itself is not available.";
      repaint();
    }
  };

  /* ---------- save ---------- */
  function collectFields() {
    var s = R.session;
    return s.proposal.candidates.filter(function (c) { return s.checked[c.id]; }).map(function (c) {
      return {
        dest: c.dest,
        value: R.currentValue(c),
        resolution: R.existingValue(c.dest) !== "" ? (s.resolutions[c.dest] || "keep") : "replace",
        confidence: c.confidence,
        manuallyApproved: c.confidence !== "High",
        validationWarnings: ((c.validation && c.validation.warnings) || []).slice()
      };
    });
  }

  function selectedDuplicate(s) {
    return (s.proposal.exactDuplicates || []).filter(function (d) { return d.biz === s.biz; })[0] || null;
  }

  R.saveSelected = function () {
    var s = R.session; if (!s) return;
    if (!s.biz) { s.status = "Choose the business first."; repaint(); return; }
    if (s.proposal.exactDuplicates.length && !s.duplicateChoice) {
      s.status = s.isLink
        ? "This link is already saved — choose one of the options above first."
        : "This is an exact duplicate — choose one of the duplicate options above first.";
      repaint(); return;
    }
    var decisions = s.isLink ? {
      biz: s.biz,
      siteType: s.siteType,
      siteTypeLabel: ((D.linkClassifier && D.linkClassifier.byId(s.siteType)) || {}).label,
      category: s.category,
      checkpoint: ((D.linkClassifier && D.linkClassifier.byId(s.siteType)) || {}).checkpoint,
      keepText: true,
      duplicateChoice: s.duplicateChoice,
      existingWebId: selectedDuplicate(s) && selectedDuplicate(s).record.id,
      fields: collectFields()
    } : {
      biz: s.biz,
      docType: s.docType,
      docTypeLabel: (CLASS.byId(s.docType) || {}).label,
      category: s.category,
      saveDocument: s.duplicateChoice !== "meta" && s.duplicateChoice !== "link",
      fields: collectFields()
    };
    if (s.isLink && (s.duplicateChoice === "meta" || s.duplicateChoice === "recheck")) {
      decisions.fields = [];
    }
    s.status = "Saving…"; repaint();

    (s.isLink ? TX.saveLink : TX.save)(s.ctx.state, s.proposal, decisions, { commit: s.ctx.commit })
      .then(function (journal) {
        // "Saved 0 values" reads like a failure when the real reason is that
        // every conflict was resolved as "keep", so say which happened.
        var kept = decisions.fields.length - journal.fieldWrites.length;
        var msg = "✓ Saved " + journal.fieldWrites.length + " value(s) to " + BIZ_LABEL[journal.biz] +
          (kept > 0 ? " · kept " + kept + " existing value(s) and filed the new one(s) as alternates" : "") +
          (journal.docId ? " · document filed." : journal.webUpdatedId ? " · existing web source updated." : journal.webId ? " · web source saved." : ".") +
          (journal.blobError ? " The file itself could not be stored: " + journal.blobError : "");
        R.close();
        if (s.ctx.onSaved) s.ctx.onSaved(msg);
      })
      .catch(function (e) {
        s.status = "Save failed: " + e.message + " — nothing was changed.";
        repaint();
      });
  };

  R.saveDocOnly = function () {
    var s = R.session; if (!s) return;
    if (!s.biz) { s.status = "Choose the business first."; repaint(); return; }

    if (s.isLink) {
      s.status = "Saving the link…"; repaint();
      var lc = (D.linkClassifier && D.linkClassifier.byId(s.siteType)) || {};
      var existing = selectedDuplicate(s);
      TX.saveLinkOnly(s.ctx.state, s.proposal, {
        biz: s.biz, siteType: s.siteType, siteTypeLabel: lc.label,
        category: s.category, checkpoint: lc.checkpoint, keepText: true,
        duplicateChoice: s.duplicateChoice,
        existingWebId: existing && existing.record.id
      }, { commit: s.ctx.commit })
        .then(function (journal) {
          var msg = journal.webUpdatedId
            ? "✓ Updated the already-saved link under " + BIZ_LABEL[journal.biz] + ". No duplicate was created."
            : "✓ Saved the link under " + BIZ_LABEL[journal.biz] + ". No field values were changed.";
          R.close();
          if (s.ctx.onSaved) s.ctx.onSaved(msg);
        })
        .catch(function (e) { s.status = "Couldn't save the link: " + e.message; repaint(); });
      return;
    }

    s.status = "Filing the document…"; repaint();
    TX.saveDocumentOnly(s.ctx.state, s.proposal, {
      biz: s.biz, docType: s.docType,
      docTypeLabel: (CLASS.byId(s.docType) || {}).label,
      category: s.category
    }, { commit: s.ctx.commit })
      .then(function (journal) {
        var msg = "✓ Filed “" + journal.fileName + "” under " + BIZ_LABEL[journal.biz] + ". No field values were changed.";
        R.close();
        if (s.ctx.onSaved) s.ctx.onSaved(msg);
      })
      .catch(function (e) { s.status = "Couldn't file the document: " + e.message; repaint(); });
  };

  R.cancel = function () {
    var s = R.session; if (!s) return;
    var ctx = s.ctx;
    R.close();
    if (ctx.onCancelled) ctx.onCancelled("Import cancelled — nothing was saved.");
  };

  R.undo = function () {
    var s = R.session;
    var ctx = s ? s.ctx : R.lastCtx;
    if (!ctx) return;
    TX.undo(ctx.state, { commit: ctx.commit }).then(function (r) {
      if (ctx.onSaved) ctx.onSaved(r.message);
    });
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.reviewUI = R;
  if (typeof module !== "undefined" && module.exports) module.exports = R;
})(typeof globalThis !== "undefined" ? globalThis : this);
