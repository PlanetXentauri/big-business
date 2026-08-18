/* ============================================================
   DOCAI · classifier — an extensible registry of document types.

   Each type declares the signals that identify it. A type wins only when it
   clears a minimum score AND beats the runner-up; otherwise the document is
   left as "Unclassified / Needs Review" rather than forced into a bucket.

   To add a type, append an entry to TYPES. Nothing else needs to change:
   the pipeline, review screen and document library all read from here.
   ============================================================ */
(function (root) {
  "use strict";

  var U = (root.DOCAI && root.DOCAI.util) ||
    (typeof require === "function" ? require("./util.js") : null);

  var C = {};

  /* Signals:
       must    — every regex must appear, or the type is disqualified
       strong  — 40 points each, distinctive to this type
       weak    — 12 points each, supporting
       negative— 35 point penalty, wording that argues against this type
     category  — where the original file is filed in Business Documents
     fields    — extractor groups worth running for this type            */
  C.TYPES = [
    {
      id: "articles",
      label: "Articles of Organization / Incorporation",
      category: "formation",
      strong: [/articles of (organization|incorporation)/i, /certificate of (formation|organization)/i],
      weak: [/limited liability company/i, /secretary of state/i, /registered agent/i, /organizer/i, /\bfiled\b/i],
      fields: ["entity", "agent", "address", "formation"]
    },
    {
      id: "annual_report",
      label: "State Registration / Annual Report",
      category: "formation",
      strong: [/annual report/i, /statement of information/i, /biennial report/i],
      weak: [/secretary of state/i, /due (date|by)/i, /filing fee/i, /report year/i],
      negative: [/articles of organization/i],
      fields: ["entity", "agent", "address", "formation"]
    },
    {
      id: "good_standing",
      label: "Certificate of Good Standing",
      category: "formation",
      strong: [/certificate of (good standing|existence|status)/i, /in good standing/i],
      weak: [/secretary of state/i, /duly (organized|formed)/i, /authorized to transact/i],
      fields: ["entity", "formation"]
    },
    {
      id: "registered_agent",
      label: "Registered Agent Document",
      category: "formation",
      strong: [/registered agent (service|agreement|acceptance|change)/i, /statement of change of registered agent/i,
        /acceptance of appointment/i],
      weak: [/registered office/i, /statutory agent/i],
      fields: ["agent", "entity"]
    },
    {
      id: "ein_letter",
      label: "EIN Confirmation Letter (IRS CP 575 / 147C)",
      category: "tax",
      strong: [/employer identification number/i, /\bcp\s?575\b/i, /\b147c\b/i, /internal revenue service/i],
      weak: [/\bein\b/i, /department of the treasury/i, /form ss-4/i, /thank you for applying/i],
      fields: ["entity", "ein", "address"]
    },
    {
      id: "address_proof",
      label: "Address Proof (Utility / Lease)",
      category: "address",
      strong: [/utility (bill|statement)/i, /lease agreement/i, /proof of address/i, /service address/i],
      weak: [/account holder/i, /billing period/i, /landlord/i, /premises/i],
      fields: ["address", "entity"]
    },
    {
      id: "bank_statement",
      label: "Bank Statement",
      category: "banking",
      strong: [/(account|statement) summary/i, /beginning balance/i, /ending balance/i, /statement period/i],
      weak: [/deposits and (other )?credits/i, /withdrawals/i, /routing number/i, /checking|savings/i, /available balance/i],
      negative: [/minimum payment due/i, /credit limit/i],
      fields: ["bank", "period", "entity", "address"]
    },
    {
      id: "bank_confirmation",
      label: "Bank Account Confirmation / Voided Check",
      category: "banking",
      strong: [/voided check/i, /direct deposit (form|authorization)/i, /account verification letter/i,
        /bank (account )?confirmation/i],
      weak: [/routing number/i, /account number/i, /\bvoid\b/i, /aba/i],
      negative: [/beginning balance/i],
      fields: ["bank", "entity"]
    },
    {
      id: "card_statement",
      label: "Credit Card Statement",
      category: "credit",
      strong: [/minimum payment due/i, /credit limit/i, /new balance/i, /payment due date/i],
      weak: [/purchases and adjustments/i, /\bapr\b/i, /available credit/i, /cash advance/i, /previous balance/i],
      fields: ["card", "period", "entity"]
    },
    {
      id: "dnb_report",
      label: "D&B / PAYDEX Report",
      category: "credit",
      strong: [/paydex/i, /dun\s*&?\s*bradstreet/i, /d-u-n-s/i],
      weak: [/business credit file/i, /failure score/i, /delinquency predictor/i, /supplier evaluation risk/i],
      fields: ["credit", "entity", "duns"]
    },
    {
      id: "experian_report",
      label: "Experian Business Credit Report",
      category: "credit",
      strong: [/intelliscore/i, /experian business/i],
      weak: [/business credit score/i, /financial stability risk/i, /credit ranking/i],
      fields: ["credit", "entity"]
    },
    {
      id: "equifax_report",
      label: "Equifax Business Credit Report",
      category: "credit",
      strong: [/equifax business/i, /business credit risk score/i, /business failure score/i],
      weak: [/payment index/i, /credit risk/i],
      fields: ["credit", "entity"]
    },
    {
      id: "fico_sbss",
      label: "FICO SBSS Report",
      category: "credit",
      strong: [/\bsbss\b/i, /fico.{0,20}small business scoring/i],
      weak: [/\bsba\b/i, /loan application/i, /score range/i],
      fields: ["credit", "entity"]
    },
    {
      id: "tradeline",
      label: "Net-30 / Tradeline Invoice or Statement",
      category: "credit",
      strong: [/net[\s\-]?30/i, /net[\s\-]?(15|45|60)/i, /trade (line|reference)/i],
      weak: [/uline|quill|grainger|summa office|crown office/i, /terms:/i, /purchase order/i, /reports to/i],
      fields: ["tradeline", "entity", "period"]
    },
    {
      id: "processor_statement",
      label: "Payment Processor Statement",
      category: "banking",
      strong: [/\bstripe\b/i, /\bpaypal\b/i, /\bsquare\b/i, /merchant (statement|services|account)/i],
      weak: [/gross volume/i, /processing fees/i, /payout/i, /transaction fees/i, /chargeback/i],
      fields: ["processor", "period", "entity"]
    },
    {
      id: "license",
      label: "License or Permit",
      category: "licenses",
      strong: [/business license/i, /certificate of occupancy/i, /\bpermit\b/i, /license (number|no)/i],
      weak: [/issued (on|to)/i, /expires/i, /department of/i, /city of|county of/i],
      negative: [/resale certificate/i, /sales tax/i],
      fields: ["license", "entity", "address"]
    },
    {
      id: "sales_tax_permit",
      label: "Sales Tax Permit / Resale Certificate",
      category: "tax",
      strong: [/resale certificate/i, /sales tax (permit|license)/i, /seller'?s permit/i, /certificate of registration/i],
      weak: [/sales and use tax/i, /department of revenue/i, /exemption/i, /taxpayer/i],
      fields: ["salestax", "entity", "address"]
    },
    {
      id: "insurance",
      label: "Insurance Policy / Certificate",
      category: "insurance",
      strong: [/certificate of (liability )?insurance/i, /\bacord\b/i, /insurance policy/i, /policy number/i],
      weak: [/general liability/i, /product liability/i, /coverage/i, /insurer/i, /effective date/i, /premium/i],
      fields: ["insurance", "entity", "period"]
    },
    {
      id: "gbp_verification",
      label: "Google Business Profile Verification",
      category: "presence",
      strong: [/google business profile/i, /google my business/i, /business profile (is )?verified/i],
      weak: [/verification code/i, /postcard/i, /maps listing/i],
      fields: ["entity", "address", "presence"]
    },
    {
      id: "directory_411",
      label: "Directory / 411 Listing Evidence",
      category: "presence",
      strong: [/listyourself/i, /\b411\b.{0,20}(listing|directory)/i, /directory (listing|assistance)/i],
      weak: [/white pages/i, /yellow pages/i, /listing confirmation/i],
      fields: ["entity", "address", "presence"]
    },
    {
      id: "trademark",
      label: "Trademark Filing / Registration",
      category: "ip",
      strong: [/\buspto\b/i, /trademark (registration|application)/i, /principal register/i],
      weak: [/serial number/i, /registration number/i, /international class/i, /first use/i],
      fields: ["trademark", "entity"]
    },
    {
      id: "contract",
      label: "Contract",
      category: "contracts",
      strong: [/this agreement is (made|entered)/i, /\bagreement\b.{0,40}\bbetween\b/i, /terms and conditions/i],
      weak: [/party of the first part/i, /whereas/i, /hereby agrees/i, /signature/i, /effective as of/i],
      negative: [/invoice/i],
      fields: ["entity", "period"]
    },
    {
      id: "invoice",
      label: "Invoice",
      category: "invoices",
      strong: [/\binvoice\b/i, /invoice (number|no|#)/i, /amount due/i],
      weak: [/bill to/i, /ship to/i, /due date/i, /subtotal/i, /\bqty\b/i],
      negative: [/statement period/i],
      fields: ["period", "entity"]
    },
    {
      id: "receipt",
      label: "Receipt",
      category: "invoices",
      strong: [/\breceipt\b/i, /thank you for your (purchase|payment)/i, /payment received/i],
      weak: [/subtotal/i, /\btax\b/i, /\btotal\b/i, /change due/i, /cardholder/i],
      negative: [/amount due/i, /statement period/i],
      fields: ["period", "entity"]
    },
    {
      id: "tax_document",
      label: "Tax Document",
      category: "tax",
      strong: [/form (1120|1065|940|941|1099|w-9|w9)/i, /schedule [ce]\b/i, /tax return/i],
      weak: [/internal revenue service/i, /taxable income/i, /tax year/i, /department of the treasury/i],
      negative: [/employer identification number.{0,40}assigned/i],
      fields: ["entity", "ein", "period"]
    }
  ];

  C.UNCLASSIFIED = {
    id: "unclassified",
    label: "Unclassified / Needs Review",
    category: "unfiled",
    fields: ["entity", "ein", "address", "bank", "card", "credit"]
  };

  /* Categories are the Business Documents sections a confirmed file is
     routed into. `label` is what the user sees. */
  C.CATEGORIES = {
    formation: { label: "⚖️ Formation & State Filings" },
    tax: { label: "🧾 Tax & Registration" },
    address: { label: "📍 Address Proof" },
    banking: { label: "🏦 Banking" },
    credit: { label: "📈 Credit & Tradelines" },
    licenses: { label: "📜 Licenses & Permits" },
    insurance: { label: "🛡️ Insurance" },
    presence: { label: "🌐 Online Presence" },
    ip: { label: "™️ Trademarks & IP" },
    contracts: { label: "📝 Contracts" },
    invoices: { label: "🧾 Invoices & Receipts" },
    unfiled: { label: "❓ Unclassified — Needs Review" }
  };

  var STRONG_PTS = 40, WEAK_PTS = 12, NEG_PTS = 35;
  var MIN_SCORE = 40;     // at least one strong signal, or several weak ones
  var MIN_MARGIN = 12;    // must clear the runner-up by this much

  C.classify = function (text) {
    var t = String(text || "");
    var scored = [];

    C.TYPES.forEach(function (type) {
      if (type.must && !type.must.every(function (rx) { return rx.test(t); })) return;

      var hits = [], score = 0;
      (type.strong || []).forEach(function (rx) {
        var m = rx.exec(t);
        if (m) { score += STRONG_PTS; hits.push({ weight: "strong", matched: m[0], excerpt: U.maskSecrets(U.excerpt(t, m.index, m[0].length, 45)) }); }
      });
      (type.weak || []).forEach(function (rx) {
        var m = rx.exec(t);
        if (m) { score += WEAK_PTS; hits.push({ weight: "weak", matched: m[0], excerpt: U.maskSecrets(U.excerpt(t, m.index, m[0].length, 45)) }); }
      });
      (type.negative || []).forEach(function (rx) {
        var m = rx.exec(t);
        if (m) { score -= NEG_PTS; hits.push({ weight: "against", matched: m[0], excerpt: U.maskSecrets(U.excerpt(t, m.index, m[0].length, 45)) }); }
      });

      if (score > 0) scored.push({ type: type, score: score, hits: hits });
    });

    scored.sort(function (a, b) { return b.score - a.score; });

    var top = scored[0], next = scored[1];
    var result = {
      type: C.UNCLASSIFIED,
      typeId: C.UNCLASSIFIED.id,
      label: C.UNCLASSIFIED.label,
      category: C.UNCLASSIFIED.category,
      categoryLabel: C.CATEGORIES[C.UNCLASSIFIED.category].label,
      confidence: "Low",
      reasons: [],
      evidence: [],
      alternatives: scored.slice(0, 4).map(function (s) {
        return { id: s.type.id, label: s.type.label, category: s.type.category, score: s.score };
      })
    };

    if (!top) {
      result.reasons.push("No document-type signals were found in the extracted text.");
      return result;
    }
    if (top.score < MIN_SCORE) {
      result.reasons.push("Closest match was " + top.type.label + " but the signals were too weak to commit to it.");
      result.reasons.push("Filed as unclassified so it is not mixed in with confirmed documents.");
      return result;
    }
    if (next && (top.score - next.score) < MIN_MARGIN) {
      result.reasons.push("Two types scored almost the same — " + top.type.label + " and " + next.type.label + ".");
      result.reasons.push("Left unclassified rather than guessing between them; pick one in the review screen.");
      return result;
    }

    var strongHits = top.hits.filter(function (h) { return h.weight === "strong"; });
    result.type = top.type;
    result.typeId = top.type.id;
    result.label = top.type.label;
    result.category = top.type.category;
    result.categoryLabel = C.CATEGORIES[top.type.category].label;
    result.confidence = strongHits.length >= 2 ? "High" : (strongHits.length === 1 ? "Medium" : "Low");
    result.evidence = top.hits.filter(function (h) { return h.weight !== "against"; }).slice(0, 6);
    result.reasons.push("Matched " + strongHits.length + " distinctive phrase(s) for " + top.type.label +
      (next ? ", clear of the next best match (" + next.type.label + ")" : "") + ".");
    if (result.confidence !== "High") {
      result.reasons.push("Only " + strongHits.length + " distinctive phrase matched — confirm the type before saving.");
    }
    return result;
  };

  C.byId = function (id) {
    if (id === C.UNCLASSIFIED.id) return C.UNCLASSIFIED;
    for (var i = 0; i < C.TYPES.length; i++) if (C.TYPES[i].id === id) return C.TYPES[i];
    return null;
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.classifier = C;
  if (typeof module !== "undefined" && module.exports) module.exports = C;
})(typeof globalThis !== "undefined" ? globalThis : this);
