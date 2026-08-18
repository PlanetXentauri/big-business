/* ============================================================
   DOCAI · link-review — the parts of the review screen a web source needs.

   review-ui owns the shared machinery: the field rows, conflict resolution,
   ticking, editing, save and undo. This module supplies only the blocks that
   differ for a link — the source header, the retrieval outcome with its
   fallbacks, duplicate handling against saved links, and the page-type
   selector — plus the Saved Web Sources library.

   Every string that came from the page is escaped here. Nothing from a
   retrieved page is ever written as markup.
   ============================================================ */
(function (root) {
  "use strict";

  var D = root.DOCAI || {};
  var U = D.util, LU = D.linkUrl, LC = D.linkClassifier, LS = D.linkStore;

  var R = {};

  var BIZ_LABEL = { centauri: "🌐 CENTAURI WORLD LLC", keypr: "🔑 KEYPR ON COMPANY" };
  var CONF_COLOR = { High: "var(--green)", Medium: "var(--amber)", Low: "#ef4444" };

  var STATUS_META = {
    retrieved: { label: "READ DIRECTLY", color: "var(--green)", icon: "✓" },
    pasted: { label: "FROM PASTED TEXT", color: "var(--green)", icon: "✓" },
    blocked: { label: "COULD NOT BE READ", color: "var(--amber)", icon: "⚠" },
    error: { label: "RETRIEVAL FAILED", color: "#ef4444", icon: "✕" },
    "not-retrieved": { label: "NOT RETRIEVED", color: "#8794ab", icon: "·" }
  };
  R.STATUS_META = STATUS_META;

  // A clickable link that can never carry a hostile scheme.
  R.linkHtml = function (url, text, extraStyle) {
    var href = LU.safeHref(url);
    var label = U.esc(text || url);
    if (href === "#") {
      return '<span style="color:var(--amber);' + (extraStyle || "") + '">' + label +
        ' (not a safe link)</span>';
    }
    return '<a href="' + U.esc(href) + '" target="_blank" rel="noopener noreferrer nofollow" ' +
      'style="color:#93c5fd;text-decoration:none;word-break:break-all;' + (extraStyle || "") + '">' +
      label + '</a>';
  };

  /* ---------- header ---------- */
  R.header = function (p) {
    var meta = STATUS_META[p.retrievalStatus] || STATUS_META["not-retrieved"];
    var out = '<div>' +
      '<div style="font-size:12px;letter-spacing:0.2em;color:var(--accent);font-weight:700">' +
      'REVIEW WEB SOURCE — NOTHING IS SAVED YET</div>';

    if (p.title) {
      out += '<div style="font-size:15px;color:#e2e8f0;margin-top:5px;word-break:break-word">' +
        U.esc(p.title) + '</div>';
    }
    // The entered address remains the permanent source of record. Redirects
    // are useful metadata, but must never replace the original clickable URL.
    out += '<div style="font-size:11px;color:#6b7a90;margin-top:5px">ORIGINAL LINK</div>' +
      '<div style="font-size:12px;margin-top:2px">' + R.linkHtml(p.url, p.url) + '</div>';
    if (p.finalUrl && p.finalUrl !== p.url) {
      out += '<div style="font-size:11px;color:#6b7a90;margin-top:5px">FINAL URL AFTER REDIRECT</div>' +
        '<div style="font-size:12px;margin-top:2px">' + R.linkHtml(p.finalUrl, p.finalUrl) + '</div>';
    }

    out += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">' +
      '<span class="chip" style="background:' + meta.color + '22;color:' + meta.color +
      ';border:1px solid ' + meta.color + '55">' + meta.icon + ' ' + meta.label + '</span>' +
      '<span style="font-size:11px;color:#6b7a90">' + U.esc(p.domain || "") + '</span>' +
      '<span style="font-size:11px;color:#6b7a90">checked ' + new Date(p.retrievedAt).toLocaleString() + '</span>' +
      (p.contentHash ? '<span style="font-size:11px;color:#6b7a90">content ' + U.esc(p.contentHash.slice(0, 10)) + '…</span>' : '') +
      '</div>';

    // Anything the normalizer changed about the address is shown before use.
    if (p.urlChanges && p.urlChanges.length) {
      out += '<div style="font-size:11px;color:#6b7a90;margin-top:5px">' +
        p.urlChanges.map(function (c) { return "· " + U.esc(c); }).join("<br>") + '</div>';
    }
    if (p.redirected && p.finalUrl && p.finalUrl !== p.url) {
      out += '<div style="font-size:11px;color:var(--amber);margin-top:4px">Redirected from ' +
        U.esc(LU.display(p.url, 60)) + '</div>';
    }
    return out + '</div>';
  };

  /* ---------- retrieval outcome ----------
     When a page could not be read this is the most important block on the
     screen: it says what happened, why, and what can be done instead. */
  R.retrievalBlock = function (p, s) {
    if (p.retrievalStatus === "retrieved" || p.retrievalStatus === "pasted") return "";

    var color = p.retrievalStatus === "blocked" ? "var(--amber)" : "#ef4444";
    var out = '<div class="card" style="padding:14px 16px;border-left:3px solid ' + color +
      ';background:' + (p.retrievalStatus === "blocked" ? "rgba(245,158,11,0.07)" : "rgba(239,68,68,0.07)") + '">' +
      '<div style="font-size:12px;letter-spacing:0.18em;color:' + color + ';font-weight:800;margin-bottom:6px">' +
      '⚠ THIS PAGE WAS NOT READ</div>' +
      '<div style="font-size:14px;color:#e2e8f0">' + U.esc(p.retrievalReason) + '</div>';

    if (p.retrievalDetail) {
      out += '<div style="font-size:12px;color:#9aa8c2;margin-top:6px">' + U.esc(p.retrievalDetail) + '</div>';
    }
    out += '<div style="font-size:12px;color:#8794ab;margin-top:8px">' +
      'No values are proposed below, because nothing was read. Anything filled in would be invented.</div>';

    // Fallbacks
    out += '<div style="font-size:12px;letter-spacing:0.15em;color:#94a3b8;font-weight:700;margin:10px 0 6px">' +
      'WHAT YOU CAN DO INSTEAD</div><div class="col" style="gap:6px">';

    out += fallbackRow("Open the page in a new tab",
      "Look at it yourself and copy anything useful.",
      '<button class="btn btn-ghost" style="font-size:11px;padding:5px 10px" ' +
      'onclick="DOCAI.linkReview.openUrl(' + jsArg(p.url || p.finalUrl) + ')">↗ OPEN ORIGINAL</button>');

    out += fallbackRow("Paste the visible page text",
      "Select the page, copy it, and paste below — it runs through exactly the same extraction.",
      '<button class="btn btn-ghost" style="font-size:11px;padding:5px 10px" ' +
      'onclick="DOCAI.linkReview.togglePaste()">' + (s.showPaste ? "✕ CLOSE" : "📋 PASTE TEXT") + '</button>');

    out += fallbackRow("Save it as a PDF or screenshot",
      "Then use Autofill from PDF or Photo — those never need network access.", "");

    out += fallbackRow("Save the link on its own",
      "Files it under this business as a web source with no values taken from it.", "");

    out += '</div>';

    if (s.showPaste) {
      out += '<div style="margin-top:10px">' +
        '<textarea id="docai-paste" rows="7" placeholder="Paste the page text here…" ' +
        'style="width:100%;font-size:13px"></textarea>' +
        '<div class="row" style="margin-top:6px">' +
        '<button class="btn btn-red" style="flex:1" onclick="DOCAI.linkReview.analyzePasted()">⚡ ANALYZE PASTED TEXT</button>' +
        '</div>' +
        '<div style="font-size:11px;color:#6b7a90;margin-top:5px">The text stays in this browser. ' +
        'It is read by the same extractors that read a PDF.</div></div>';
    }
    return out + '</div>';
  };

  function fallbackRow(title, detail, action) {
    return '<div style="display:flex;gap:10px;align-items:flex-start;background:rgba(255,255,255,0.03);' +
      'border-radius:8px;padding:8px 10px">' +
      '<div style="flex:1;min-width:0">' +
      '<div style="font-size:13px;color:#e2e8f0">' + U.esc(title) + '</div>' +
      '<div style="font-size:11px;color:#8794ab;margin-top:2px">' + U.esc(detail) + '</div></div>' +
      (action || "") + '</div>';
  }

  function jsArg(s) {
    // Safe single-quoted JS string literal for an inline handler.
    return "'" + String(s == null ? "" : s)
      .replace(/\\/g, "\\\\").replace(/'/g, "\\'")
      .replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
      .replace(/\r?\n/g, " ") + "'";
  }
  R.jsArg = jsArg;

  /* ---------- duplicates ---------- */
  R.duplicates = function (p, s) {
    var out = "";
    if (p.exactDuplicates && p.exactDuplicates.length) {
      var d = p.exactDuplicates[0];
      out += '<div class="card" style="padding:14px 16px;border-left:3px solid #ef4444;background:rgba(239,68,68,0.07)">' +
        '<div style="font-size:12px;letter-spacing:0.18em;color:#ef4444;font-weight:800;margin-bottom:6px">' +
        '⚠ THIS LINK IS ALREADY SAVED</div>' +
        '<div style="font-size:14px;color:#e2e8f0">Saved as <b>' + U.esc(d.record.title || d.record.url) +
        '</b> under ' + U.esc(BIZ_LABEL[d.biz]) + ' on ' + new Date(d.record.savedAt).toLocaleDateString() + '.</div>' +
        (d.record.linkedFields && d.record.linkedFields.length
          ? '<div style="font-size:12px;color:#9aa8c2;margin-top:4px">It supports ' +
            d.record.linkedFields.length + ' field(s).</div>' : '') +
        '<div style="font-size:13px;color:#9aa8c2;margin-top:8px">Choose what to do — no second copy is made unless you ask:</div>' +
        '<div class="row" style="margin-top:8px;flex-wrap:wrap">' +
        '<button class="btn btn-ghost" style="flex:1;min-width:120px" onclick="DOCAI.linkReview.openUrl(' +
          jsArg(d.record.finalUrl || d.record.url) + ')">↗ OPEN EXISTING</button>' +
        dupBtn(s, "link", "🔗 LINK TO MORE FIELDS") +
        dupBtn(s, "meta", "✎ UPDATE METADATA") +
        dupBtn(s, "recheck", "🔄 RECHECK PAGE") +
        dupBtn(s, "both", "➕ KEEP BOTH") +
        '</div>' +
        (s.duplicateChoice ? '<div style="font-size:13px;color:var(--accent);margin-top:8px">Selected: ' +
          U.esc(dupLabel(s.duplicateChoice)) + '</div>' : '') +
        '</div>';
    }

    if (p.likelyDuplicates && p.likelyDuplicates.length) {
      var l = p.likelyDuplicates[0];
      out += '<div class="card" style="padding:12px 16px;border-left:3px solid var(--amber);background:rgba(245,158,11,0.06)">' +
        '<div style="font-size:12px;letter-spacing:0.18em;color:var(--amber);font-weight:800;margin-bottom:4px">' +
        '⚠ LIKELY THE SAME PAGE</div>' +
        '<div style="font-size:14px;color:#e2e8f0">Very similar to <b>' + U.esc(l.record.title || l.record.url) +
        '</b> — ' + U.esc(l.reasons.join(", ")) + '.</div>' +
        '<div style="font-size:12px;color:#8794ab;margin-top:4px">The addresses differ, so this is not blocked. ' +
        'Check it is not the same page reached two ways.</div></div>';
    }
    return out;
  };
  function dupBtn(s, key, label) {
    var on = s.duplicateChoice === key;
    return '<button class="btn ' + (on ? "btn-red" : "btn-ghost") + '" style="flex:1;min-width:120px" ' +
      'onclick="DOCAI.linkReview.setDup(' + jsArg(key) + ')">' + (on ? "✓ " : "") + label + '</button>';
  }
  function dupLabel(k) {
    return {
      link: "link the saved source to more fields",
      meta: "update the saved source's metadata only",
      recheck: "recheck the saved page",
      both: "keep both entries deliberately"
    }[k] || k;
  }

  /* ---------- page type ---------- */
  R.siteTypeBlock = function (p, s) {
    var c = p.classification;
    var out = '<div class="card" style="padding:14px 16px">' +
      '<div style="font-size:12px;letter-spacing:0.18em;color:#94a3b8;font-weight:800;margin-bottom:8px">WEBSITE TYPE</div>' +
      '<select id="docai-sitetype" onchange="DOCAI.linkReview.setSiteType(this.value)" style="margin-bottom:8px">';
    var types = [LC.UNCLASSIFIED].concat(LC.TYPES);
    types.forEach(function (t) {
      out += '<option value="' + U.esc(t.id) + '"' + (t.id === s.siteType ? " selected" : "") + '>' +
        U.esc(t.label) + '</option>';
    });
    out += '</select>';

    out += '<div style="font-size:13px;color:#9aa8c2"><b style="color:' +
      (CONF_COLOR[c.confidence] || "#8794ab") + '">' + U.esc(c.confidence) + ' confidence</b> · ' +
      U.esc(c.reasons.join(" ")) + '</div>';

    if (c.evidence && c.evidence.length) {
      out += '<div class="col" style="gap:3px;margin-top:6px">' + c.evidence.slice(0, 4).map(function (e) {
        return '<div style="font-size:11px;color:#6b7a90">· ' + U.esc(e.where) + ': “' +
          U.esc(String(e.matched).slice(0, 70)) + '”</div>';
      }).join("") + '</div>';
    }

    var cats = (D.classifier && D.classifier.CATEGORIES) || {};
    out += '<div style="margin-top:10px;font-size:12px;letter-spacing:0.18em;color:#94a3b8;font-weight:800">FILED UNDER</div>' +
      '<select id="docai-webcat" onchange="DOCAI.linkReview.setCategory(this.value)">';
    Object.keys(cats).forEach(function (k) {
      out += '<option value="' + U.esc(k) + '"' + (k === s.category ? " selected" : "") + '>' +
        U.esc(cats[k].label) + '</option>';
    });
    out += '</select>';

    if (c.checkpoint) {
      out += '<div style="font-size:11px;color:#6b7a90;margin-top:6px">Saving this page will also mark the ' +
        '<b>' + U.esc(c.checkpoint) + '</b> strength checkpoint as evidenced.</div>';
    }
    return out + '</div>';
  };

  /* ---------- provenance line under a field ----------
     Shown by review-ui for candidates that carry `web`. */
  R.provenance = function (c) {
    if (!c.web) return "";
    return '<div style="font-size:11px;color:#6b7a90;margin-top:4px">' +
      'From ' + U.esc(c.web.sourceLabel) + (c.web.where ? ' · ' + U.esc(c.web.where) : '') +
      '<br>' + R.linkHtml(c.web.sourceUrl, LU.display(c.web.sourceUrl, 55), "font-size:11px") +
      (c.web.pageTitle ? ' — ' + U.esc(c.web.pageTitle) : '') +
      '<br>retrieved ' + new Date(c.web.retrievedAt).toLocaleString() +
      '</div>';
  };

  /* ---------- handlers ----------
     Delegated to review-ui's session so there is one source of truth. */
  function session() { return D.reviewUI && D.reviewUI.session; }
  function repaint() { var s = session(); if (s && s.ctx.render) s.ctx.render(); }

  R.openUrl = function (url) {
    var href = LU.safeHref(url);
    if (href === "#") return;
    // noopener + noreferrer: the opened page gets no handle back to this one.
    var w = root.open(href, "_blank", "noopener,noreferrer");
    if (w) { try { w.opener = null; } catch (e) {} }
  };

  R.setDup = function (k) { var s = session(); if (s) { s.duplicateChoice = k; repaint(); } };
  R.setSiteType = function (id) {
    var s = session(); if (!s) return;
    s.siteType = id;
    var t = LC.byId(id);
    if (t && t.category) s.category = t.category;
    repaint();
  };
  R.setCategory = function (id) { var s = session(); if (s) { s.category = id; repaint(); } };
  R.togglePaste = function () { var s = session(); if (s) { s.showPaste = !s.showPaste; repaint(); } };

  R.analyzePasted = function () {
    var s = session(); if (!s) return;
    var el = document.getElementById("docai-paste");
    var text = el ? el.value : "";
    if (!text || text.trim().length < 20) {
      s.status = "Paste a bit more text — there is not enough here to read.";
      repaint(); return;
    }
    if (s.ctx.onPasted) s.ctx.onPasted(s.proposal.url, text);
  };

  /* ============================================================
     Saved Web Sources — the library in Business Documents.
     ============================================================ */
  R.libraryHtml = function (state, biz, ui) {
    var records = LS.list(state, biz);
    var open = !!(ui.docOpen && ui.docOpen.web);
    var out = '<div onclick="ui.docOpen.web=!ui.docOpen.web;render()" style="cursor:pointer;user-select:none;' +
      'display:flex;align-items:center;gap:10px;margin-bottom:8px;padding:10px 14px;background:var(--panel);' +
      'border:1px solid var(--border);border-radius:10px">' +
      '<span style="display:inline-block;transform:rotate(' + (open ? 90 : 0) + 'deg);transition:transform .2s;' +
      'color:var(--accent);font-size:13px">▶</span>' +
      '<span style="font-size:12px;letter-spacing:0.2em;color:#94a3b8;font-weight:700">🔗 LINK — SAVED WEB SOURCES</span>' +
      '<span class="chip" style="margin-left:auto;background:var(--accent-dim);color:var(--accent);' +
      'border:1px solid var(--accent-brd)">' + records.length + '</span></div>';

    if (!open) return out;

    out += '<div style="font-size:11px;color:#6b7a90;margin:-4px 0 8px 14px">' +
      'Pages analysed with 🔗 LINK. Each one shows the fields it supports and can be reopened or rechecked.</div>';

    if (!records.length) {
      return out + '<div class="empty" style="margin-bottom:12px;padding:18px">' +
        'No web sources yet — use <b>⚡ AUTOFILL FROM LINK 🌐</b> to analyse a page, ' +
        'or save a link without extracting.</div>';
    }

    out += '<div class="col" style="margin-bottom:12px;gap:8px">';
    records.forEach(function (r) {
      var meta = STATUS_META[r.retrievalStatus] || STATUS_META["not-retrieved"];
      out += '<div class="card" style="padding:12px 14px">' +
        '<div style="display:flex;gap:10px;align-items:flex-start">' +
        '<span style="flex-shrink:0">🌐</span>' +
        '<div style="flex:1;min-width:0">' +
        '<div style="font-size:14px;color:#e2e8f0;word-break:break-word">' +
        U.esc(r.title || LU.display(r.url, 60)) + '</div>' +
        '<div style="font-size:11px;margin-top:2px">' +
        R.linkHtml(r.finalUrl || r.url, LU.display(r.finalUrl || r.url, 60), "font-size:11px") + '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:5px;align-items:center">' +
        '<span class="chip" style="background:rgba(255,255,255,0.06);color:#94a3b8">' +
        U.esc(r.siteTypeLabel) + '</span>' +
        '<span class="chip" style="background:' + meta.color + '22;color:' + meta.color + '">' +
        meta.icon + ' ' + meta.label + '</span>' +
        '<span style="font-size:11px;color:#6b7a90">' + U.esc(r.domain) + '</span>' +
        '</div>' +
        '<div style="font-size:11px;color:#6b7a90;margin-top:4px">' +
        'saved ' + new Date(r.savedAt).toLocaleDateString() +
        ' · last checked ' + new Date(r.lastCheckedAt).toLocaleDateString() +
        (r.linkedFields && r.linkedFields.length
          ? ' · supports ' + r.linkedFields.length + ' field(s): ' +
            U.esc(r.linkedFields.map(function (d) { return D.mapping.label(d); }).join(", "))
          : ' · no field values taken from it') +
        '</div>' +
        (r.linkedCheckpoints && r.linkedCheckpoints.length
          ? '<div style="font-size:11px;color:#6b7a90;margin-top:2px">evidences checkpoint(s): ' +
            U.esc(r.linkedCheckpoints.join(", ")) + '</div>' : '') +
        (r.notes ? '<div style="font-size:12px;color:#9aa8c2;margin-top:4px">' + U.esc(r.notes) + '</div>' : '') +
        (r.retrievalNote ? '<div style="font-size:11px;color:' + meta.color + ';margin-top:3px">' +
          U.esc(r.retrievalNote) + '</div>' : '') +
        '</div></div>' +
        '<div class="row" style="margin-top:8px;flex-wrap:wrap">' +
        '<button class="btn btn-ghost" style="flex:1;min-width:78px;font-size:11px;padding:5px 8px" ' +
        'onclick="DOCAI.linkReview.openUrl(' + jsArg(r.url || r.finalUrl) + ')">↗ OPEN ORIGINAL</button>' +
        '<button class="btn btn-ghost" style="flex:1;min-width:78px;font-size:11px;padding:5px 8px" ' +
        'onclick="docaiRecheckLink(' + jsArg(biz) + ',' + jsArg(r.id) + ')">🔄 RECHECK</button>' +
        '<button class="btn btn-ghost" style="flex:1;min-width:78px;font-size:11px;padding:5px 8px" ' +
        'onclick="docaiEditLink(' + jsArg(biz) + ',' + jsArg(r.id) + ')">✎ EDIT</button>' +
        '<button class="btn btn-ghost" style="flex:1;min-width:78px;font-size:11px;padding:5px 8px" ' +
        'onclick="docaiRemoveLink(' + jsArg(biz) + ',' + jsArg(r.id) + ')">🗑 REMOVE</button>' +
        '</div>';

      if (r.history && r.history.length > 1) {
        out += '<details style="margin-top:6px"><summary style="cursor:pointer;font-size:11px;color:#6b7a90">' +
          'check history (' + r.history.length + ')</summary>' +
          r.history.map(function (h) {
            return '<div style="font-size:11px;color:#6b7a90;margin-top:3px">' +
              new Date(h.at).toLocaleString() + ' — ' + U.esc(h.status) +
              (h.changed ? ' (content changed)' : '') +
              (h.note ? ': ' + U.esc(h.note) : '') + '</div>';
          }).join("") + '</details>';
      }
      out += '</div>';
    });
    return out + '</div>';
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.linkReview = R;
  if (typeof module !== "undefined" && module.exports) module.exports = R;
})(typeof globalThis !== "undefined" ? globalThis : this);
