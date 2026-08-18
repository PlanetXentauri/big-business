/* ============================================================
   DOCAI · business-matcher — decides which business a document belongs to.

   The currently selected business is never an input to this decision. The
   only thing that counts is evidence found in the document text, compared
   against what is already stored for each business.

   Returns one of four verdicts:
     confident  — one business, strong evidence, nothing pointing elsewhere
     ambiguous  — both businesses have real evidence; a human must choose
     none       — nothing identifying was found
     (and `warnOtherBusiness` when the match is not the one on screen)
   ============================================================ */
(function (root) {
  "use strict";

  var U = (root.DOCAI && root.DOCAI.util) ||
    (typeof require === "function" ? require("./util.js") : null);

  var M = {};

  /* Canonical identities. These are the two businesses this dashboard
     tracks; brand names are the ones already present in the app's own
     default data, not private information. */
  M.IDENTITIES = {
    centauri: {
      id: "centauri",
      label: "Centauri World LLC",
      legalNames: ["Centauri World LLC", "Centauri World, LLC", "Centauri World L.L.C."],
      brands: ["Centauri World", "Centauri"]
    },
    keypr: {
      id: "keypr",
      label: "Keypr On Company",
      legalNames: ["Keypr On Company", "Keypr On Co.", "Keypr On Co"],
      brands: ["Keypr On", "KEYPRONYX", "Keypr"]
    }
  };

  /* How much each kind of evidence is worth. Identifiers that are unique by
     construction (EIN, D-U-N-S, state filing number) outrank text that could
     coincide. Nothing here is a percentage — these are comparison weights,
     surfaced to the user as High/Medium/Low with the reasons spelled out. */
  M.WEIGHTS = {
    ein: 100,
    duns: 100,
    stateRegNum: 70,
    legalName: 60,
    accountLast4: 55,
    brand: 35,
    domain: 30,
    email: 30,
    phone: 25,
    address: 20
  };

  var STRONG = 55;   // at or above this, a single item can carry a decision
  var DECIDE = 60;   // minimum total score for a confident verdict
  var MARGIN = 2;    // winner must beat the runner-up by this factor

  function ev(kind, business, matched, excerpt, weight) {
    return {
      kind: kind,
      business: business,
      matched: matched,
      // Masked at the point of creation, so no caller can forget.
      excerpt: U.maskSecrets(excerpt),
      weight: weight == null ? (M.WEIGHTS[kind] || 10) : weight
    };
  }

  function findAll(text, needle) {
    // Case-insensitive literal search returning every offset.
    var hits = [], low = text.toLowerCase(), n = String(needle).toLowerCase(), i = 0;
    if (!n) return hits;
    while ((i = low.indexOf(n, i)) >= 0) { hits.push(i); i += n.length; }
    return hits;
  }

  /* ---------- evidence gathering ---------- */

  // Text with punctuation folded away, so "Centauri World, L.L.C." and
  // "CENTAURI WORLD LLC" both match the same stored name.
  function foldedText(text) {
    return " " + U.foldName(text.replace(/\n/g, " ")) + " ";
  }

  M.collect = function (text, profiles) {
    var out = [];
    var folded = foldedText(text);
    var lower = text.toLowerCase();

    Object.keys(M.IDENTITIES).forEach(function (bizId) {
      var ident = M.IDENTITIES[bizId];
      var bp = (profiles && profiles[bizId] && profiles[bizId].bp) || {};
      var fin = (profiles && profiles[bizId] && profiles[bizId].fin) || {};

      // --- legal name (canonical spellings and whatever the user has saved)
      var names = ident.legalNames.slice();
      if (bp.legalName) names.push(bp.legalName);
      names.forEach(function (nm) {
        var f = U.foldName(nm);
        if (f && folded.indexOf(" " + f + " ") >= 0) {
          // Report the canonical label, not whichever stored spelling folded
          // into a match — the excerpt below carries the document's own wording.
          var at = lower.indexOf(f.split(" ")[0]);
          out.push(ev("legalName", bizId, ident.label,
            U.excerpt(text, at < 0 ? 0 : at, nm.length),
            M.WEIGHTS.legalName));
        }
      });

      // --- brand / DBA
      var brands = ident.brands.slice();
      if (bp.dba) brands.push(bp.dba);
      if (bp.brands) String(bp.brands).split(/[,;·]/).forEach(function (b) { if (b.trim()) brands.push(b.trim()); });
      brands.forEach(function (b) {
        if (b.length < 4) return; // too short to be distinctive
        var hits = findAll(text, b);
        if (hits.length) {
          out.push(ev("brand", bizId, b, U.excerpt(text, hits[0], b.length), M.WEIGHTS.brand));
        }
      });

      // --- unique identifiers already on file
      [["ein", bp.ein], ["duns", bp.duns], ["stateRegNum", bp.stateRegNum]].forEach(function (pair) {
        var kind = pair[0], stored = pair[1];
        if (!stored) return;
        var d = U.digits(stored);
        if (d.length < 6) return;
        // match either the raw stored form or its bare digits
        var forms = [stored, d];
        if (kind === "ein" && d.length === 9) forms.push(d.slice(0, 2) + "-" + d.slice(2));
        if (kind === "duns" && d.length === 9) forms.push(d.slice(0, 2) + "-" + d.slice(2, 5) + "-" + d.slice(5));
        for (var i = 0; i < forms.length; i++) {
          var hits = findAll(text, forms[i]);
          if (hits.length) {
            out.push(ev(kind, bizId, maskIdentifier(kind, forms[i]),
              maskExcerpt(kind, U.excerpt(text, hits[0], forms[i].length)), M.WEIGHTS[kind]));
            break;
          }
        }
      });

      // --- bank account owner: last four of a stored account number
      var acct = fin.acctNumber || "";
      var ad = U.digits(acct);
      if (ad.length >= 4) {
        var last4 = ad.slice(-4);
        // only count it when the document frames it as an account
        var rx = new RegExp("(?:account|acct|ending|xxxx|\\*{2,}|·{2,})[^0-9]{0,12}" + last4 + "\\b", "i");
        var m = rx.exec(text);
        if (m) {
          out.push(ev("accountLast4", bizId, "····" + last4,
            U.excerpt(text, m.index, m[0].length), M.WEIGHTS.accountLast4));
        }
      }

      // --- domain / website
      if (bp.website) {
        var host = String(bp.website).replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[\/?#]/)[0];
        if (host && host.indexOf(".") > 0) {
          var h = findAll(text, host);
          if (h.length) out.push(ev("domain", bizId, host, U.excerpt(text, h[0], host.length), M.WEIGHTS.domain));
        }
      }

      // --- email
      if (bp.email) {
        var e = findAll(text, bp.email);
        if (e.length) out.push(ev("email", bizId, bp.email, U.excerpt(text, e[0], bp.email.length), M.WEIGHTS.email));
      }

      // --- phone (compared on digits so formatting differences do not matter)
      if (bp.phone) {
        var pd = U.digits(bp.phone).slice(-10);
        if (pd.length === 10) {
          var textDigits = text.replace(/[^\d]/g, "");
          if (textDigits.indexOf(pd) >= 0) {
            var loose = new RegExp(pd.slice(0, 3) + "\\D{0,3}" + pd.slice(3, 6) + "\\D{0,3}" + pd.slice(6));
            var pm = loose.exec(text);
            out.push(ev("phone", bizId, bp.phone,
              pm ? U.excerpt(text, pm.index, pm[0].length) : "(digits matched across formatting)",
              M.WEIGHTS.phone));
          }
        }
      }

      // --- address (folded comparison, needs the street number to line up)
      ["principalAddr", "mailingAddr", "warehouseAddr"].forEach(function (key) {
        if (!bp[key]) return;
        var stored = U.foldAddress(bp[key]);
        var head = stored.split(",")[0].trim();
        if (head.length < 8) return;
        var foldedDoc = U.foldAddress(text.replace(/\n/g, " "));
        if (foldedDoc.indexOf(head) >= 0) {
          out.push(ev("address", bizId, bp[key], head, M.WEIGHTS.address));
        }
      });
    });

    return dedupe(out);
  };

  /* One piece of evidence per business per kind. Without this, "Centauri
     World LLC" would score once for each stored spelling variant and once
     more for each overlapping brand, inflating the total on what is really
     a single observation. The longest match wins because it is the most
     specific one. */
  function dedupe(list) {
    var best = {};
    list.forEach(function (e) {
      var key = e.business + "|" + e.kind;
      var cur = best[key];
      if (!cur || String(e.matched).length > String(cur.matched).length) best[key] = e;
    });
    return Object.keys(best).map(function (k) { return best[k]; })
      .sort(function (a, b) { return b.weight - a.weight; });
  }

  // Identifiers are masked the moment they become evidence, so nothing
  // sensitive is written into the review screen or any log.
  function maskIdentifier(kind, v) {
    if (kind === "ein") return U.maskEin(v);
    if (kind === "duns") return "··-···-" + U.digits(v).slice(-4);
    return v;
  }
  function maskExcerpt(kind, s) { return U.maskSecrets(s); }

  /* ---------- verdict ---------- */
  M.match = function (text, profiles) {
    var evidence = M.collect(text || "", profiles || {});
    var score = { centauri: 0, keypr: 0 };
    var strongest = { centauri: 0, keypr: 0 };

    evidence.forEach(function (e) {
      score[e.business] += e.weight;
      if (e.weight > strongest[e.business]) strongest[e.business] = e.weight;
    });

    var order = ["centauri", "keypr"].sort(function (a, b) { return score[b] - score[a]; });
    var top = order[0], other = order[1];

    var result = {
      decision: "none",
      business: null,
      confidence: "Low",
      reasons: [],
      evidence: evidence,
      scores: { centauri: score.centauri, keypr: score.keypr },
      requiresManualChoice: false
    };

    if (score[top] === 0) {
      result.reasons.push("No legal name, EIN, D-U-N-S number, brand, address, phone, email or account number from either business appears in this document.");
      result.requiresManualChoice = true;
      return result;
    }

    var bothPresent = score.centauri > 0 && score.keypr > 0;
    var decisiveTop = strongest[top] >= STRONG;
    var decisiveOther = strongest[other] >= STRONG;

    // Both businesses carry strong evidence — this must be a human decision.
    if (bothPresent && decisiveTop && decisiveOther) {
      result.decision = "ambiguous";
      result.requiresManualChoice = true;
      result.reasons.push("Strong evidence for both businesses appears in this document — " +
        describe(evidence, "centauri") + " and " + describe(evidence, "keypr") + ".");
      result.reasons.push("Pick the correct business before saving; nothing will be assigned automatically.");
      return result;
    }

    // Clear enough to propose one business.
    if (score[top] >= DECIDE && (!bothPresent || score[top] >= score[other] * MARGIN)) {
      result.decision = "confident";
      result.business = top;
      result.confidence = strongest[top] >= M.WEIGHTS.ein ? "High" : (strongest[top] >= STRONG ? "High" : "Medium");
      result.reasons.push("Matched on " + describe(evidence, top) + ".");
      if (bothPresent) {
        result.reasons.push("The other business also appears (" + describe(evidence, other) +
          ") but only in weaker forms — confirm before saving.");
        result.requiresManualChoice = true;
        result.confidence = "Medium";
      }
      return result;
    }

    // Something was found, but not enough to stand behind.
    result.decision = "ambiguous";
    result.requiresManualChoice = true;
    result.confidence = "Low";
    result.reasons.push("Only weak evidence found (" + describe(evidence, top) +
      ") — not enough to assign a business without confirmation.");
    return result;
  };

  function describe(evidence, biz) {
    var kinds = {};
    evidence.filter(function (e) { return e.business === biz; })
      .forEach(function (e) { kinds[e.kind] = (kinds[e.kind] || 0) + 1; });
    var names = {
      ein: "EIN", duns: "D-U-N-S number", stateRegNum: "state filing number",
      legalName: "legal name", accountLast4: "bank account last four",
      brand: "brand name", domain: "website domain", email: "email address",
      phone: "phone number", address: "address"
    };
    var parts = Object.keys(kinds).map(function (k) { return names[k] || k; });
    if (!parts.length) return "nothing";
    var label = M.IDENTITIES[biz].label;
    return label + " by " + (parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1]);
  }

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.businessMatcher = M;
  if (typeof module !== "undefined" && module.exports) module.exports = M;
})(typeof globalThis !== "undefined" ? globalThis : this);
