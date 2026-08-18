/* ============================================================
   DOCAI · extractors — turn document text into candidate values.

   A candidate is never a bare string. Every one carries where it came from,
   what the validator said about it, and why it was given its confidence
   level. If a value cannot be evidenced, it is not produced at all — a blank
   field is the correct output for information the document does not contain.

   Candidate shape:
     { dest, label, kind, raw, value, page, excerpt, bbox,
       validation:{ok,errors,warnings,meta}, confidence, reasons[], alternates[] }
   ============================================================ */
(function (root) {
  "use strict";

  var U = (root.DOCAI && root.DOCAI.util) ||
    (typeof require === "function" ? require("./util.js") : null);
  var V = (root.DOCAI && root.DOCAI.validators) ||
    (typeof require === "function" ? require("./validators.js") : null);

  var E = {};

  /* ---------- pages ----------
     Text arrives as an array of { page, text, items[] }. Extractors work on
     one flat string but keep an index so any offset resolves back to a page. */
  function flatten(pages) {
    var full = "", map = [];
    (pages || []).forEach(function (p) {
      map.push({ start: full.length, end: full.length + p.text.length, page: p.page, items: p.items || [] });
      full += p.text + "\n\n";
    });
    return { text: full, map: map };
  }
  function pageAt(map, index) {
    for (var i = 0; i < map.length; i++) if (index >= map[i].start && index <= map[i].end) return map[i].page;
    return map.length ? map[map.length - 1].page : 1;
  }
  // Best-effort bounding box: find the text item on that page containing the match.
  function bboxAt(map, index, matched) {
    for (var i = 0; i < map.length; i++) {
      if (index < map[i].start || index > map[i].end) continue;
      var items = map[i].items || [];
      var needle = String(matched).trim().slice(0, 24).toLowerCase();
      if (!needle) return null;
      for (var j = 0; j < items.length; j++) {
        if (items[j].str && items[j].str.toLowerCase().indexOf(needle) >= 0 && items[j].bbox) {
          return items[j].bbox;
        }
      }
      return null;
    }
    return null;
  }

  /* ---------- candidate construction ---------- */
  function candidate(ctx, spec, raw, index, matchedLen, reasons) {
    var v = V.run(spec.kind, raw, spec.scoreType);
    if (!v.ok) {
      // Rejected by a deterministic validator. Recorded for the diagnostics
      // panel but never offered as a value to save.
      var key = spec.dest + "|" + String(raw).slice(0, 80);
      if (!ctx.rejectedSeen[key]) {
        ctx.rejectedSeen[key] = true;
        ctx.rejected.push({
          dest: spec.dest, label: spec.label, raw: String(raw).slice(0, 80),
          page: pageAt(ctx.map, index), errors: v.errors
        });
      }
      return null;
    }

    var conf = gradeConfidence(spec, v, reasons);
    return {
      id: U.uid("cand"),
      dest: spec.dest,
      label: spec.label,
      kind: spec.kind,
      raw: v.raw,
      value: v.value,
      page: pageAt(ctx.map, index),
      // The excerpt is quoted document text and may contain identifiers
      // unrelated to this field, so it is masked regardless of destination.
      excerpt: U.maskSecrets(U.excerpt(ctx.text, index, matchedLen, 55)),
      bbox: bboxAt(ctx.map, index, raw),
      validation: { ok: true, errors: [], warnings: v.warnings, meta: v.meta },
      confidence: conf.level,
      reasons: conf.reasons,
      alternates: [],
      sensitive: U.isSensitive(spec.dest)
    };
  }

  /* Confidence is High / Medium / Low with stated reasons. No percentages —
     there is no calibrated probability behind any of this, and a fake number
     would imply precision the method does not have. */
  function gradeConfidence(spec, v, reasons) {
    var out = (reasons || []).slice();
    var level;

    var checksummed = v.meta && (v.meta.checksum === "passed");
    var labelled = out.some(function (r) { return /labelled|label/i.test(r); });

    if (checksummed) {
      level = "High";
      out.unshift("Passed the arithmetic checksum for this identifier type");
    } else if (labelled && spec.kind !== "freetext") {
      level = "High";
      out.unshift("Format matches " + (spec.kindLabel || spec.kind) + " and validation passed");
    } else if (labelled) {
      level = "Medium";
    } else {
      level = "Medium";
      out.unshift("Found by pattern without a nearby label");
    }

    if (v.warnings && v.warnings.length) {
      level = level === "High" ? "Medium" : "Low";
      v.warnings.forEach(function (w) { out.push("Validation warning: " + w); });
    }
    if (spec.alwaysLow) level = "Low";
    return { level: level, reasons: out };
  }

  /* ---------- field specifications ----------
     `labels` are the phrases that introduce a value in real documents.
     `rx` is the shape the value itself must have. A spec with no rx accepts
     whatever follows the label, subject to its validator. */
  E.SPECS = [
    // --- entity identity
    { group: "entity", dest: "bp.legalName", label: "Legal business name", kind: "legalName",
      labels: ["name of the limited liability company", "limited liability company name", "name of the corporation",
        "legal business name", "legal name", "entity name", "name of entity", "company name", "business legal name",
        "registered name", "name of business"] },
    { group: "entity", dest: "bp.dba", label: "DBA / trade name", kind: "legalName",
      labels: ["doing business as", "trade name", "fictitious name", "also known as", "d/b/a", "dba"] },
    { group: "entity", dest: "bp.entityType", label: "Entity type", kind: "freetext",
      labels: ["entity type", "company type", "type of entity", "business structure", "organization type"] },
    { group: "entity", dest: "bp.stateFormation", label: "State of formation", kind: "state",
      labels: ["state of formation", "state of organization", "state of incorporation", "jurisdiction of formation",
        "organized under the laws of", "formed in", "incorporated in"] },
    { group: "formation", dest: "bp.stateRegNum", label: "State registration / document #", kind: "stateRegNum",
      labels: ["document number", "file number", "filing number", "registration number", "entity number",
        "charter number", "control number", "document no", "file no"] },
    { group: "formation", dest: "bp.formationDate", label: "Formation date", kind: "date",
      labels: ["date of formation", "formation date", "date filed", "filed on", "effective date",
        "date of organization", "date incorporated", "incorporation date", "organized on"] },

    // --- tax identifiers
    { group: "ein", dest: "bp.ein", label: "EIN", kind: "ein",
      labels: ["employer identification number", "federal tax id", "federal ein", "taxpayer identification number",
        "tax id number", "fein", "ein"],
      rx: /\b\d{2}[-\s]?\d{7}\b/ },
    { group: "duns", dest: "bp.duns", label: "D-U-N-S number", kind: "duns",
      labels: ["d-u-n-s number", "duns number", "d&b number", "d-u-n-s", "duns"],
      rx: /\b\d{2}-?\d{3}-?\d{4}\b/ },
    { group: "entity", dest: "bp.naics", label: "NAICS code", kind: "naics",
      labels: ["naics code", "naics", "primary industry code", "sic code"],
      rx: /\b\d{2,6}\b/ },

    // --- registered agent
    { group: "agent", dest: "bp.agentName", label: "Registered agent name", kind: "legalName",
      labels: ["name of registered agent", "registered agent name", "registered agent", "statutory agent"] },
    { group: "agent", dest: "bp.agentAddress", label: "Registered agent address", kind: "address",
      labels: ["address of the registered agent", "registered agent address", "registered office address",
        "registered office", "statutory agent address"], multiline: true },

    // --- addresses
    { group: "address", dest: "bp.principalAddr", label: "Principal business address", kind: "address",
      labels: ["principal place of business", "principal office address", "principal business address",
        "principal address", "business address", "street address of principal office", "service address"], multiline: true },
    { group: "address", dest: "bp.mailingAddr", label: "Mailing address", kind: "address",
      labels: ["mailing address", "mail address"], multiline: true },
    { group: "address", dest: "bp.warehouseAddr", label: "Physical / warehouse address", kind: "address",
      labels: ["warehouse address", "physical address", "fulfillment address"], multiline: true },

    // --- contact
    { group: "contact", dest: "bp.phone", label: "Business phone", kind: "phone",
      labels: ["business phone", "phone number", "telephone", "phone", "tel"],
      rx: /(?:\+?1[\s.\-])?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/ },
    { group: "contact", dest: "bp.email", label: "Business email", kind: "email",
      labels: ["business email", "email address", "e-mail", "email"],
      rx: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/ },
    { group: "contact", dest: "bp.website", label: "Website / domain", kind: "url",
      labels: ["website", "web site", "web address", "domain", "url", "homepage"],
      rx: /(?:https?:\/\/)?(?:www\.)?[A-Za-z0-9\-]+\.(?:com|net|org|io|co|us|shop|store|biz)\b[^\s,;]*/ },

    // --- banking
    { group: "bank", dest: "fin.bankName", label: "Bank name", kind: "freetext",
      labels: ["bank name", "financial institution", "name of bank", "depository"] },
    { group: "bank", dest: "fin.routingNumber", label: "Routing number", kind: "routing",
      labels: ["routing number", "routing no", "aba routing number", "aba number", "aba", "rtn"],
      rx: /\b\d{9}\b/ },
    { group: "bank", dest: "fin.acctNumber", label: "Account number", kind: "account",
      labels: ["account number", "account no", "acct number", "acct no", "acct #", "account #"],
      rx: /\b[\d\-*x·]{4,20}\b/i },
    { group: "bank", dest: "fin.acctType", label: "Account type", kind: "freetext",
      labels: ["account type", "type of account"],
      rx: /\b(?:business\s+)?(?:checking|savings|money market)\b/i },
    { group: "bank", dest: "fin.bankContact", label: "Banker / branch contact", kind: "freetext",
      labels: ["banker", "branch contact", "account manager", "relationship manager"] },
    { group: "bank", dest: "fin.bankOnline", label: "Online banking URL", kind: "url",
      labels: ["online banking", "banking url", "login url"] },

    // --- cards
    { group: "card", dest: "fin.cardDue", label: "Payment due date", kind: "date",
      labels: ["payment due date", "due date", "payment due"] },
    { group: "card", dest: "fin.cardApr", label: "APR / terms", kind: "freetext",
      labels: ["annual percentage rate", "purchase apr", "apr", "interest rate", "purchase rate"],
      rx: /\d{1,2}\.\d{1,3}\s*%/ },
    { group: "card", dest: "fin.creditLimitTotal", label: "Total credit available", kind: "currency",
      // "available credit" is deliberately absent: it is the unused
      // remainder, not the limit, and sharing a destination made a card
      // statement report the wrong figure.
      labels: ["credit limit", "total credit line", "total credit available"],
      rx: /\$?[\d,]+(?:\.\d{2})?/ },

    // --- business credit scores
    { group: "credit", dest: "fin.paydex", label: "D&B PAYDEX score", kind: "score", scoreType: "paydex",
      labels: ["paydex score", "paydex"], rx: /\b\d{1,3}\b/ },
    { group: "credit", dest: "fin.intelliscore", label: "Experian Intelliscore", kind: "score", scoreType: "intelliscore",
      labels: ["intelliscore plus", "intelliscore", "experian business score"], rx: /\b\d{1,3}\b/ },
    { group: "credit", dest: "fin.equifax", label: "Equifax Business score", kind: "score", scoreType: "equifax",
      labels: ["business credit risk score", "equifax business score", "equifax score"], rx: /\b\d{1,3}\b/ },
    { group: "credit", dest: "fin.fico", label: "FICO SBSS", kind: "score", scoreType: "fico",
      labels: ["fico sbss", "sbss score", "sbss"], rx: /\b\d{1,3}\b/ },

    // --- tradelines, processors, licences, insurance, trademarks
    { group: "tradeline", dest: "fin.tradelines", label: "Net-30 / tradeline account", kind: "freetext",
      labels: ["net-30", "net 30", "tradeline", "trade line", "vendor account", "terms"] },
    { group: "processor", dest: "bp.processors", label: "Payment processor", kind: "freetext",
      labels: ["payment processor", "merchant account", "payment gateway", "merchant id"] },
    { group: "license", dest: "bp.licenses", label: "Business license / permit #", kind: "freetext",
      labels: ["license number", "license no", "permit number", "permit no", "business license"] },
    { group: "salestax", dest: "bp.salesTaxPermit", label: "Sales tax permit / resale #", kind: "freetext",
      labels: ["resale certificate number", "sales tax permit number", "seller's permit number",
        "certificate of registration number", "account id", "tax permit number"] },
    { group: "insurance", dest: "bp.insurance", label: "Insurance policy #", kind: "freetext",
      labels: ["policy number", "policy no", "certificate number"] },
    { group: "trademark", dest: "bp.trademarks", label: "Trademark registration #", kind: "freetext",
      labels: ["registration number", "serial number", "reg. no", "uspto registration"] },
    { group: "presence", dest: "bp.website", label: "Website / domain", kind: "url",
      labels: ["website", "web address"] },

    // --- ownership (kept from the previous parser's coverage)
    { group: "owner", dest: "bp.owners", label: "Owner(s) / officers & titles", kind: "freetext",
      labels: ["managing member", "authorized member", "authorized person", "officer name", "owner name",
        "member name", "manager name", "authorized representative", "principal name", "president"] },
    { group: "owner", dest: "bp.ownershipPct", label: "Ownership %", kind: "freetext",
      labels: ["ownership percentage", "percentage of ownership", "ownership %", "percent owned", "% owned"],
      rx: /\d{1,3}(?:\.\d+)?\s*%/ },
    { group: "owner", dest: "bp.ownerSsn", label: "Owner SSN / ITIN", kind: "ssn",
      labels: ["social security number", "social security no", "ssn/itin", "itin", "ssn"],
      rx: /\b\d{3}-\d{2}-\d{4}\b/ },
    { group: "owner", dest: "bp.ownerDob", label: "Owner DOB", kind: "date",
      labels: ["date of birth", "birth date", "birthdate", "dob"] },
    { group: "owner", dest: "bp.ownerHomeAddr", label: "Owner home address", kind: "address",
      labels: ["home address", "residential address", "residence address", "personal address"], multiline: true },

    // --- contact and revenue
    { group: "contact", dest: "bp.custService", label: "Customer service email / phone", kind: "freetext",
      labels: ["customer service", "customer support", "support email", "support phone"] },
    { group: "bank", dest: "bp.annualRevenue", label: "Annual revenue estimate", kind: "currency",
      labels: ["annual revenue", "yearly revenue", "gross annual", "annual sales", "gross revenue",
        "annual gross sales", "estimated annual"],
      rx: /\$?[\d,]+(?:\.\d{2})?/ },
    { group: "bank", dest: "fin.secondaryBank", label: "Secondary bank & account", kind: "freetext",
      labels: ["secondary bank", "second account", "additional account"] },

    // --- platform / operations
    { group: "platform", dest: "bp.amazonId", label: "Amazon Seller Central ID", kind: "freetext",
      labels: ["seller central account", "merchant token", "amazon seller id", "merchant id", "amazon account id"],
      rx: /\b[A-Z0-9]{10,16}\b/ },
    { group: "platform", dest: "bp.walmartId", label: "Walmart Seller ID", kind: "freetext",
      labels: ["walmart seller id", "walmart account", "supplier id", "seller center id", "partner id"] },
    { group: "platform", dest: "bp.gs1Prefix", label: "GS1 / UPC prefix", kind: "freetext",
      labels: ["gs1 company prefix", "company prefix", "upc company prefix", "upc prefix", "gs1"],
      rx: /\b0?\d{5,10}\b/ },
    { group: "platform", dest: "bp.brandRegistry", label: "Brand registry status", kind: "freetext",
      labels: ["brand registry", "registry status", "brand registered"] },

    // --- digital assets
    { group: "digital", dest: "bp.domainRegistrar", label: "Domain registrar & renewal", kind: "freetext",
      labels: ["domain registered with", "registrar name", "registrar", "domain expires", "renewal date"] },
    { group: "digital", dest: "bp.hostingProvider", label: "Hosting provider", kind: "freetext",
      labels: ["hosting provider", "hosted by", "hosted on", "hosting company", "server provider"] },

    // --- compliance dates
    { group: "salestax", dest: "bp.annualReportDue", label: "Annual report due date", kind: "date",
      labels: ["annual report due", "report due date", "next annual report"] },

    // --- statement period (drives duplicate detection, not a saved field)
    { group: "period", dest: "meta.statementPeriod", label: "Statement period", kind: "freetext",
      labels: ["statement period", "billing period", "period covered", "for the period"] },
    { group: "period", dest: "meta.documentDate", label: "Document date", kind: "date",
      labels: ["statement date", "date issued", "issue date", "closing date", "as of"] }
  ];

  /* ---------- the label pass ----------
     A value found immediately after its own label is the strongest signal a
     text document offers, so this runs first and its results outrank the
     pattern pass. */
  function labelPass(ctx, specs) {
    var lower = ctx.text.toLowerCase();

    // Every (label, spec) pair, longest label first. "Registered Agent
    // Address" must be considered before "Registered Agent", otherwise the
    // shorter label claims the same position and captures a label fragment
    // as if it were a value.
    var pairs = [];
    specs.forEach(function (spec) {
      spec.labels.forEach(function (label) { pairs.push({ label: label, spec: spec }); });
    });
    pairs.sort(function (a, b) { return b.label.length - a.label.length; });

    var claimed = {}; // start offset -> already taken by a longer label

    pairs.forEach(function (pair) {
      var label = pair.label, spec = pair.spec;
      var from = 0, at;
      while ((at = lower.indexOf(label, from)) >= 0) {
        from = at + label.length;
        if (claimed[at]) continue;
        // The label must start at a word boundary, or "ein" matches "protein".
        if (at > 0 && /[a-z0-9]/.test(lower[at - 1])) continue;
        if (/[a-z0-9]/.test(lower[from] || "")) continue;

        var tail = ctx.text.slice(from, from + (spec.multiline ? 320 : 160));
        var raw = readValue(tail, spec);
        if (!raw) continue;

        claimed[at] = true;
        var offset = from + tail.indexOf(raw);
        var c = candidate(ctx, spec, raw, offset, raw.length,
          ["Labelled in the document as “" + ctx.text.substr(at, label.length) + "”"]);
        if (c) ctx.add(c);
      }
    });
  }

  // Pull the value that follows a label: same line first, then the next
  // non-empty line, which is how most forms and certificates lay values out.
  function readValue(tail, spec) {
    var cleaned = tail.replace(/^[\s:：#.\-–—]*/, "");
    var lines = cleaned.split(/\r?\n/);
    var first = (lines[0] || "").trim();

    if (spec.rx) {
      // Search the label's own line first.
      var m = spec.rx.exec(first);
      if (m) return m[0];
      // Then the next line, but only if it does not carry a label of its own.
      // Without this guard, "EIN: 12-34567" followed by "Routing Number:
      // 990000014" hands the routing number back as the EIN.
      var next = (lines[1] || "").trim();
      if (next && !/^[A-Za-z][A-Za-z .\/'-]{2,40}\s*:/.test(next)) {
        m = spec.rx.exec(next);
        if (m) return m[0];
      }
      return null;
    }

    if (spec.multiline) {
      // Addresses run across lines; gather until a blank line or a new label.
      var acc = [];
      for (var i = 0; i < lines.length && acc.length < 4; i++) {
        var l = lines[i].trim();
        if (!l) { if (acc.length) break; continue; }
        if (/[a-z].*:\s*$/i.test(l) && acc.length) break;
        acc.push(l);
        if (/\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/.test(l)) break; // ends at the ZIP
      }
      var joined = acc.join(", ").replace(/\s*,\s*,/g, ",").trim();
      return joined.length >= 8 ? joined.slice(0, 200) : null;
    }

    if (first.length >= 2 && !/^(is|are|the|of|and|as follows)[.:]?$/i.test(first)) {
      return first.replace(/\s{2,}.*$/, "").slice(0, 160);
    }
    for (var j = 1; j < Math.min(lines.length, 3); j++) {
      var n = lines[j].trim();
      if (n.length >= 2 && !/:$/.test(n)) return n.slice(0, 160);
    }
    return null;
  }

  /* ---------- the pattern pass ----------
     For identifiers whose shape is distinctive enough to find unlabelled.
     Every hit here is Medium at best and requires supporting context words
     nearby, so a stray nine-digit number is not read as a routing number. */
  E.PATTERNS = [
    { dest: "bp.ein", spec: null, rx: /\b\d{2}-\d{7}\b/g, context: /ein|employer identification|federal tax|taxpayer/i },
    { dest: "bp.duns", spec: null, rx: /\b\d{2}-\d{3}-\d{4}\b/g, context: /d.?u.?n.?s|dun\s*&?\s*bradstreet|d&b/i },
    { dest: "fin.routingNumber", spec: null, rx: /\b\d{9}\b/g, context: /routing|aba|rtn|transit/i },
    { dest: "bp.email", spec: null, rx: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, context: null },
    { dest: "bp.phone", spec: null, rx: /\(?\b\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/g, context: /phone|tel|call|fax|contact/i }
  ];

  function patternPass(ctx, specs) {
    var byDest = {};
    specs.forEach(function (s) { byDest[s.dest] = s; });

    E.PATTERNS.forEach(function (p) {
      var spec = byDest[p.dest];
      if (!spec) return;
      var rx = new RegExp(p.rx.source, "g"), m;
      while ((m = rx.exec(ctx.text))) {
        if (p.context) {
          var win = ctx.text.slice(Math.max(0, m.index - 90), m.index + m[0].length + 90);
          if (!p.context.test(win)) continue;
        }
        var c = candidate(ctx, spec, m[0], m.index, m[0].length,
          ["Recognised by format" + (p.context ? " with supporting wording nearby" : "") + ", not next to an explicit label"]);
        if (c) ctx.add(c);
      }
    });
  }

  /* ---------- card pass ----------
     Cards are handled separately because the useful output is issuer plus
     last four, and up to three distinct cards map to three fields. */
  function cardPass(ctx) {
    var rx = /\b(visa|mastercard|master card|amex|american express|discover)\b[^\n]{0,50}?(?:ending(?:\s+in)?|last\s*4|acct|account|[x*·]{2,})[^\d]{0,8}(\d{4})\b/gi;
    var alt = /\b(?:[x*·]{4,}[\s\-]?)+(\d{4})\b/g;
    var seen = {}, slot = 1, m;

    while ((m = rx.exec(ctx.text)) && slot <= 3) {
      if (seen[m[2]]) continue;
      seen[m[2]] = true;
      pushCard(ctx, slot++, m[1], m[2], m.index, m[0]);
    }
    while ((m = alt.exec(ctx.text)) && slot <= 3) {
      if (seen[m[1]]) continue;
      var win = ctx.text.slice(Math.max(0, m.index - 120), m.index + 120);
      if (!/card|credit|visa|mastercard|amex|discover/i.test(win)) continue;
      seen[m[1]] = true;
      pushCard(ctx, slot++, "", m[1], m.index, m[0]);
    }
  }
  function pushCard(ctx, slot, issuerText, last4, index, matched) {
    var issuer = V.cardIssuer(issuerText || "");
    var spec = { dest: "fin.card" + slot, label: "Card " + slot + " (issuer · last 4 · limit)", kind: "freetext" };
    var value = (issuer ? issuer + " " : "") + "····" + last4;
    var c = candidate(ctx, spec, value, index, matched.length,
      ["Card identified by issuer name and last four digits",
        "The full card number is never read or stored — only issuer and last four"]);
    if (c) {
      c.validation.meta.last4 = last4;
      c.validation.meta.issuer = issuer;
      c.validation.meta.fullNumberRetained = false;
      c.sensitive = true;
      ctx.add(c);
    }
  }

  /* ---------- entry point ---------- */
  E.extract = function (pages, opts) {
    opts = opts || {};
    var flat = flatten(pages);
    var groups = opts.groups && opts.groups.length ? opts.groups : null;
    var specs = E.SPECS.filter(function (s) { return !groups || groups.indexOf(s.group) >= 0; });

    var byDest = {};
    var ctx = {
      text: flat.text,
      map: flat.map,
      rejected: [],
      rejectedSeen: {},
      add: function (c) {
        var list = byDest[c.dest] || (byDest[c.dest] = []);
        // Same normalized value found twice is one observation, not two.
        for (var i = 0; i < list.length; i++) {
          if (list[i].value === c.value) {
            if (rank(c) > rank(list[i])) list[i] = c;
            return;
          }
        }
        list.push(c);
      }
    };

    labelPass(ctx, specs);
    patternPass(ctx, specs);
    if (!groups || groups.indexOf("card") >= 0) cardPass(ctx);

    // One primary per destination, the rest offered as alternates so the
    // review screen can show them instead of silently discarding them.
    var out = [];
    Object.keys(byDest).forEach(function (dest) {
      var list = byDest[dest].sort(function (a, b) { return rank(b) - rank(a); });
      var primary = list[0];
      primary.alternates = list.slice(1, 4).map(function (a) {
        return { value: a.value, raw: a.raw, page: a.page, excerpt: a.excerpt, confidence: a.confidence, reasons: a.reasons };
      });
      if (primary.alternates.length) {
        primary.reasons.push(primary.alternates.length + " other candidate value(s) found for this field — review them before saving");
        if (primary.confidence === "High") primary.confidence = "Medium";
      }
      out.push(primary);
    });

    return {
      candidates: out.sort(function (a, b) { return a.page - b.page || a.dest.localeCompare(b.dest); }),
      rejected: ctx.rejected,
      text: flat.text
    };
  };

  var CONF_RANK = { High: 3, Medium: 2, Low: 1 };
  function rank(c) {
    return CONF_RANK[c.confidence] * 10 - (c.validation.warnings.length);
  }

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.extractors = E;
  if (typeof module !== "undefined" && module.exports) module.exports = E;
})(typeof globalThis !== "undefined" ? globalThis : this);
