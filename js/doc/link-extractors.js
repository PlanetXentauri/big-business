/* ============================================================
   DOCAI · link-extractors — candidate values from a web page.

   Produces exactly the candidate shape the document pipeline uses, so the
   review screen, mapping registry, conflict handling, transaction and undo
   all work unchanged. The extra fields a web source carries — source URL,
   page title, structured-data property — ride along inside `web`.

   Source ranking is the whole point of this module. A value published as
   schema.org JSON-LD was put there deliberately by the site owner and is
   worth far more than the same string scraped out of a footer:

     JSON-LD organization property   High
     Open Graph / HTML metadata      Medium
     Labelled visible text           Medium
     Bare pattern in body text       Low

   Nothing is invented. A field the page does not evidence stays empty.
   ============================================================ */
(function (root) {
  "use strict";

  var U = (root.DOCAI && root.DOCAI.util) || (typeof require === "function" ? require("./util.js") : null);
  var V = (root.DOCAI && root.DOCAI.validators) || (typeof require === "function" ? require("./validators.js") : null);
  var LU = (root.DOCAI && root.DOCAI.linkUrl) || (typeof require === "function" ? require("./link-url.js") : null);

  var E = {};

  var SOURCE_RANK = { jsonld: 4, meta: 3, labelled: 2, pattern: 1 };
  var SOURCE_LABEL = {
    jsonld: "schema.org structured data",
    meta: "page metadata",
    labelled: "labelled text on the page",
    pattern: "a pattern in the page text"
  };

  function candidate(ctx, spec, rawValue, source, where, excerpt) {
    if (rawValue == null) return null;
    var raw = String(rawValue).trim();
    if (!raw) return null;

    var v = V.run(spec.kind, raw, spec.scoreType);
    if (!v.ok) {
      var key = spec.dest + "|" + raw.slice(0, 80);
      if (!ctx.rejectedSeen[key]) {
        ctx.rejectedSeen[key] = true;
        ctx.rejected.push({
          dest: spec.dest, label: spec.label, raw: raw.slice(0, 80),
          page: 1, errors: v.errors, where: where
        });
      }
      return null;
    }

    var reasons = [];
    var level;
    if (source === "jsonld") {
      level = "High";
      reasons.push("Published by the site as " + SOURCE_LABEL.jsonld + " (" + where + ")");
      reasons.push("Structured data is written deliberately by the site owner, not inferred from wording");
    } else if (source === "meta") {
      level = "Medium";
      reasons.push("Read from " + SOURCE_LABEL.meta + " (" + where + ")");
    } else if (source === "labelled") {
      level = "Medium";
      reasons.push("Found next to the label “" + where + "” in the page text");
    } else {
      level = "Low";
      reasons.push("Matched " + SOURCE_LABEL.pattern + " with no label naming it");
      reasons.push("Web page text is unreliable evidence on its own — check it against the page");
    }

    if (v.warnings && v.warnings.length) {
      level = level === "High" ? "Medium" : "Low";
      v.warnings.forEach(function (w) { reasons.push("Validation warning: " + w); });
    }

    return {
      id: U.uid("wcand"),
      dest: spec.dest,
      label: spec.label,
      kind: spec.kind,
      raw: v.raw,
      value: v.value,
      page: 1,
      excerpt: U.maskSecrets(excerpt || raw),
      bbox: null,
      validation: { ok: true, errors: [], warnings: v.warnings, meta: v.meta },
      confidence: level,
      reasons: reasons,
      alternates: [],
      sensitive: U.isSensitive(spec.dest),
      // Web-specific provenance, shown by the review screen.
      web: {
        sourceUrl: ctx.url,
        pageTitle: ctx.title,
        source: source,
        sourceLabel: SOURCE_LABEL[source],
        where: where,
        retrievedAt: ctx.retrievedAt
      },
      _rank: SOURCE_RANK[source] || 0
    };
  }

  /* ---------- specs ---------- */
  E.SPECS = {
    legalName: { dest: "bp.legalName", label: "Legal business name", kind: "legalName" },
    dba: { dest: "bp.dba", label: "DBA / trade name", kind: "legalName" },
    phone: { dest: "bp.phone", label: "Business phone", kind: "phone" },
    email: { dest: "bp.email", label: "Business email", kind: "email" },
    website: { dest: "bp.website", label: "Website / domain", kind: "url" },
    principalAddr: { dest: "bp.principalAddr", label: "Principal business address", kind: "address" },
    naics: { dest: "bp.naics", label: "NAICS code", kind: "naics" },
    duns: { dest: "bp.duns", label: "D-U-N-S number", kind: "duns" },
    ein: { dest: "bp.ein", label: "EIN", kind: "ein" },
    entityType: { dest: "bp.entityType", label: "Entity type", kind: "freetext" },
    stateFormation: { dest: "bp.stateFormation", label: "State of formation", kind: "state" },
    stateRegNum: { dest: "bp.stateRegNum", label: "State registration / document #", kind: "stateRegNum" },
    formationDate: { dest: "bp.formationDate", label: "Formation date", kind: "date" },
    agentName: { dest: "bp.agentName", label: "Registered agent name", kind: "legalName" },
    agentAddress: { dest: "bp.agentAddress", label: "Registered agent address", kind: "address" },
    licenses: { dest: "bp.licenses", label: "Business licenses / permits", kind: "freetext" },
    salesTaxPermit: { dest: "bp.salesTaxPermit", label: "Sales tax permit / resale #", kind: "freetext" },
    insurance: { dest: "bp.insurance", label: "Insurance policy #", kind: "freetext" },
    trademarks: { dest: "bp.trademarks", label: "Trademark registration #", kind: "freetext" },
    processors: { dest: "bp.processors", label: "Payment processors", kind: "freetext" }
  };

  /* ---------- 1. schema.org organization ----------
     The most trustworthy source available on a web page. */
  function fromJsonLd(ctx, org) {
    if (!org) return;
    var add = function (specKey, value, prop) {
      var c = candidate(ctx, E.SPECS[specKey], value, "jsonld", prop, prop + ": " + String(value).slice(0, 120));
      if (c) ctx.add(c);
    };

    if (org.legalName) add("legalName", org.legalName, "Organization.legalName");
    if (org.name) add("legalName", org.name, "Organization.name");
    if (org.alternateName) add("dba", org.alternateName, "Organization.alternateName");
    if (org.telephone) add("phone", org.telephone, "Organization.telephone");
    if (org.email) add("email", String(org.email).replace(/^mailto:/i, ""), "Organization.email");
    if (org.url) add("website", org.url, "Organization.url");
    if (org.naics) add("naics", org.naics, "Organization.naics");
    if (org.duns) add("duns", org.duns, "Organization.duns");
    if (org.taxID) add("ein", org.taxID, "Organization.taxID");
    if (org.vatID) add("ein", org.vatID, "Organization.vatID");
    if (org.foundingDate) add("formationDate", org.foundingDate, "Organization.foundingDate");

    // Address may be a PostalAddress object or a plain string.
    var a = org.address;
    if (a && typeof a === "object" && !Array.isArray(a)) {
      var parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode]
        .filter(function (x) { return x && typeof x === "string"; });
      if (parts.length >= 2) add("principalAddr", parts.join(", "), "Organization.address (PostalAddress)");
    } else if (typeof a === "string") {
      add("principalAddr", a, "Organization.address");
    }

    // contactPoint may be one object or several.
    var cps = org.contactPoint;
    if (cps) {
      (Array.isArray(cps) ? cps : [cps]).slice(0, 4).forEach(function (cp) {
        if (!cp || typeof cp !== "object") return;
        if (cp.telephone) add("phone", cp.telephone, "Organization.contactPoint.telephone");
        if (cp.email) add("email", String(cp.email).replace(/^mailto:/i, ""), "Organization.contactPoint.email");
      });
    }
  }

  /* ---------- 2. HTML metadata ---------- */
  function fromMeta(ctx, meta) {
    if (!meta) return;
    var add = function (specKey, value, prop) {
      var c = candidate(ctx, E.SPECS[specKey], value, "meta", prop, prop + ": " + String(value).slice(0, 120));
      if (c) ctx.add(c);
    };
    if (meta["og:site_name"]) add("legalName", meta["og:site_name"], "og:site_name");
    if (meta["application-name"]) add("dba", meta["application-name"], "application-name");
    if (meta["og:url"]) add("website", meta["og:url"], "og:url");
    if (meta["og:phone_number"]) add("phone", meta["og:phone_number"], "og:phone_number");
    if (meta["og:email"]) add("email", meta["og:email"], "og:email");
    // Open Graph business contact block, when the site publishes one.
    var b = meta;
    var addrParts = [b["business:contact_data:street_address"], b["business:contact_data:locality"],
      b["business:contact_data:region"], b["business:contact_data:postal_code"]]
      .filter(function (x) { return x; });
    if (addrParts.length >= 2) add("principalAddr", addrParts.join(", "), "business:contact_data:*");
    if (b["business:contact_data:phone_number"]) add("phone", b["business:contact_data:phone_number"], "business:contact_data:phone_number");
    if (b["business:contact_data:email"]) add("email", b["business:contact_data:email"], "business:contact_data:email");
  }

  /* ---------- 3. labelled visible text ----------
     Government registries and licence lookups render label/value pairs, which
     is exactly what the document pipeline is built to read. */
  E.LABELS = [
    ["legalName", ["entity name", "legal name", "business name", "company name", "name of entity",
      "registered name", "corporate name", "legal business name"]],
    ["dba", ["doing business as", "trade name", "assumed name", "fictitious name", "d/b/a", "also known as"]],
    ["entityType", ["entity type", "business type", "company type", "type of entity", "entity kind"]],
    ["stateRegNum", ["entity number", "file number", "document number", "filing number", "registration number",
      "charter number", "control number", "license number", "certificate number"]],
    ["formationDate", ["date of formation", "formation date", "date filed", "filing date", "date incorporated",
      "incorporation date", "registration date", "effective date", "date of organization"]],
    ["stateFormation", ["state of formation", "state of incorporation", "jurisdiction", "formed in",
      "state of organization", "home state"]],
    ["agentName", ["registered agent", "registered agent name", "statutory agent", "agent name"]],
    ["agentAddress", ["registered agent address", "registered office", "agent address"]],
    ["principalAddr", ["principal address", "business address", "principal office", "mailing address",
      "street address", "principal place of business", "address"]],
    ["phone", ["phone", "telephone", "phone number", "business phone", "contact number", "tel"]],
    ["email", ["email", "e-mail", "email address", "contact email"]],
    ["website", ["website", "web site", "web address", "url", "homepage"]],
    ["naics", ["naics", "naics code", "industry code"]],
    ["duns", ["d-u-n-s", "duns", "duns number", "d-u-n-s number"]],
    ["ein", ["ein", "employer identification number", "federal tax id", "federal ein", "tax id"]],
    ["licenses", ["license type", "license status", "permit number", "permit type"]],
    ["salesTaxPermit", ["sales tax", "resale certificate", "seller's permit", "tax registration"]],
    ["insurance", ["policy number", "policy no", "coverage"]],
    ["trademarks", ["serial number", "registration no", "trademark number"]]
  ];

  function fromLabels(ctx, text) {
    if (!text) return;
    var lines = text.split("\n");
    var lower = text.toLowerCase();

    // Longest label first so "registered agent address" beats "registered agent".
    var pairs = [];
    E.LABELS.forEach(function (entry) {
      entry[1].forEach(function (label) { pairs.push({ key: entry[0], label: label }); });
    });
    pairs.sort(function (a, b) { return b.label.length - a.label.length; });

    var claimed = {};
    pairs.forEach(function (p) {
      var from = 0, at;
      while ((at = lower.indexOf(p.label, from)) >= 0) {
        from = at + p.label.length;
        if (claimed[at]) continue;
        if (at > 0 && /[a-z0-9]/.test(lower[at - 1])) continue;
        // The label must be followed by a separator, not more letters.
        var after = text.slice(from, from + 3);
        if (!/^\s*[::\-–—|]/.test(after) && !/^\s*\n/.test(after)) continue;

        var tail = text.slice(from, from + 240).replace(/^[\s:：#.\-–—|]*/, "");
        var value = tail.split("\n")[0].trim();
        if (value.length < 2) {
          var nextLine = (tail.split("\n")[1] || "").trim();
          if (nextLine.length >= 2 && !/[:：]\s*$/.test(nextLine)) value = nextLine;
        }
        if (value.length < 2) continue;

        claimed[at] = true;
        var c = candidate(ctx, E.SPECS[p.key], value.slice(0, 200), "labelled",
          text.substr(at, p.label.length), U.excerpt(text, at, p.label.length + value.length, 40));
        if (c) ctx.add(c);
      }
    });
  }

  /* ---------- 4. bare patterns ----------
     Lowest rank, and only for things whose shape is distinctive. Everything
     found this way starts unticked in the review screen. */
  function fromPatterns(ctx, text) {
    if (!text) return;

    // Email — skip the noise addresses every site carries.
    var emailRx = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, m;
    var seenEmail = {};
    while ((m = emailRx.exec(text))) {
      var e = m[0].toLowerCase();
      if (seenEmail[e]) continue;
      seenEmail[e] = true;
      if (/(example|sentry|wixpress|\.png|\.jpg|@2x)/.test(e)) continue;
      var c = candidate(ctx, E.SPECS.email, m[0], "pattern", "page text",
        U.excerpt(text, m.index, m[0].length, 45));
      if (c) ctx.add(c);
      if (Object.keys(seenEmail).length > 5) break;
    }

    // Phone — needs a nearby word suggesting it is a phone number.
    var phoneRx = /(?:\+?1[\s.\-])?\(?\b\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/g;
    var seenPhone = {};
    while ((m = phoneRx.exec(text))) {
      if (seenPhone[m[0]]) continue;
      seenPhone[m[0]] = true;
      var win = text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 40);
      if (!/phone|tel|call|contact|fax|mobile|office/i.test(win)) continue;
      var pc = candidate(ctx, E.SPECS.phone, m[0], "pattern", "page text",
        U.excerpt(text, m.index, m[0].length, 45));
      if (pc) ctx.add(pc);
      if (Object.keys(seenPhone).length > 4) break;
    }

    // EIN and D-U-N-S only when the page names them — an EIN is not something
    // to infer from a nine-digit string on a web page.
    var einRx = /\b\d{2}-\d{7}\b/g;
    while ((m = einRx.exec(text))) {
      var ew = text.slice(Math.max(0, m.index - 90), m.index + m[0].length + 40);
      if (!/ein|employer identification|federal tax/i.test(ew)) continue;
      var ec = candidate(ctx, E.SPECS.ein, m[0], "pattern", "page text",
        U.maskSecrets(U.excerpt(text, m.index, m[0].length, 45)));
      if (ec) ctx.add(ec);
      break;
    }
    var dunsRx = /\b\d{2}-\d{3}-\d{4}\b/g;
    while ((m = dunsRx.exec(text))) {
      var dw = text.slice(Math.max(0, m.index - 90), m.index + m[0].length + 40);
      if (!/d.?u.?n.?s|dun\s*&?\s*bradstreet/i.test(dw)) continue;
      var dc = candidate(ctx, E.SPECS.duns, m[0], "pattern", "page text",
        U.excerpt(text, m.index, m[0].length, 45));
      if (dc) ctx.add(dc);
      break;
    }
  }

  /* ---------- 5. the page's own address ----------
     A page that IS the business website evidences the website field. */
  function fromUrl(ctx) {
    if (!ctx.url) return;
    var c = candidate(ctx, E.SPECS.website, ctx.url, "meta", "the address of this page",
      "Retrieved from " + ctx.url);
    if (c) {
      c.confidence = "Medium";
      c.reasons = ["This is the address of the page that was analysed",
        "Confirm it is the business's own site rather than a directory or third-party listing"];
      ctx.add(c);
    }
  }

  /* ---------- entry point ---------- */
  E.extract = function (page, opts) {
    opts = opts || {};
    var byDest = {};
    var ctx = {
      url: page.url || "",
      title: page.title || "",
      retrievedAt: page.retrievedAt || Date.now(),
      rejected: [],
      rejectedSeen: {},
      add: function (c) {
        var list = byDest[c.dest] || (byDest[c.dest] = []);
        for (var i = 0; i < list.length; i++) {
          if (list[i].value === c.value) {
            // Same value from a better source: keep the better provenance.
            if (c._rank > list[i]._rank) list[i] = c;
            return;
          }
        }
        list.push(c);
      }
    };

    fromJsonLd(ctx, page.organization);
    fromMeta(ctx, page.meta);
    fromLabels(ctx, page.text);
    fromPatterns(ctx, page.text);
    if (opts.includePageUrl !== false) fromUrl(ctx);

    var out = [];
    Object.keys(byDest).forEach(function (dest) {
      var list = byDest[dest].sort(function (a, b) {
        if (b._rank !== a._rank) return b._rank - a._rank;
        return (b.validation.warnings.length ? 0 : 1) - (a.validation.warnings.length ? 0 : 1);
      });
      var primary = list[0];
      primary.alternates = list.slice(1, 4).map(function (a) {
        return {
          value: a.value, raw: a.raw, page: 1, excerpt: a.excerpt,
          confidence: a.confidence, reasons: a.reasons, web: a.web
        };
      });
      if (primary.alternates.length) {
        primary.reasons.push(primary.alternates.length +
          " other value(s) for this field appear on the page — review them before saving");
        if (primary.confidence === "High") primary.confidence = "Medium";
      }
      delete primary._rank;
      out.push(primary);
    });

    return {
      candidates: out.sort(function (a, b) { return a.dest.localeCompare(b.dest); }),
      rejected: ctx.rejected
    };
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.linkExtractors = E;
  if (typeof module !== "undefined" && module.exports) module.exports = E;
})(typeof globalThis !== "undefined" ? globalThis : this);
