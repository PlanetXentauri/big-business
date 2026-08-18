/* ============================================================
   DOCAI · mapping — where a confirmed value is allowed to land.

   Nothing writes to state without an entry here. A destination names its
   store ("bp" profile / "fin" financials), its field key, the human label
   used in the review screen, and the Strength checkpoint it satisfies.

   `meta.*` destinations are pipeline-internal (statement period, document
   date). They are used for duplicate detection and filing, and are never
   written into the profile or financial records.
   ============================================================ */
(function (root) {
  "use strict";

  var M = {};

  /* Strength checkpoint ids are the ones already defined in index.html's
     STRENGTH_ITEMS. Keeping the same ids means an imported value lights up
     the existing AUTO badge with no change to the strength renderer. */
  M.DESTINATIONS = {
    // ---- profile / legal identity
    "bp.legalName": { store: "bp", key: "legalName", label: "Legal business name", section: "Profile · Legal identity", checkpoint: "entity" },
    "bp.dba": { store: "bp", key: "dba", label: "DBA / trade name", section: "Profile · Legal identity" },
    "bp.entityType": { store: "bp", key: "entityType", label: "Entity type", section: "Profile · Legal identity" },
    "bp.stateFormation": { store: "bp", key: "stateFormation", label: "State of formation", section: "Profile · Legal identity" },
    "bp.stateRegNum": { store: "bp", key: "stateRegNum", label: "State registration / document #", section: "Profile · Legal identity", checkpoint: "goodstanding" },
    "bp.formationDate": { store: "bp", key: "formationDate", label: "Formation date", section: "Profile · Legal identity" },
    "bp.ein": { store: "bp", key: "ein", label: "EIN", section: "Profile · Legal identity", checkpoint: "ein", sensitive: true },
    "bp.duns": { store: "bp", key: "duns", label: "D-U-N-S number", section: "Profile · Legal identity", checkpoint: "duns" },
    "bp.naics": { store: "bp", key: "naics", label: "NAICS code", section: "Profile · Legal identity", checkpoint: "naics" },

    // ---- registered agent
    "bp.agentName": { store: "bp", key: "agentName", label: "Registered agent name", section: "Profile · Registered agent", checkpoint: "agent" },
    "bp.agentAddress": { store: "bp", key: "agentAddress", label: "Registered agent address", section: "Profile · Registered agent" },

    // ---- addresses
    "bp.principalAddr": { store: "bp", key: "principalAddr", label: "Principal business address", section: "Profile · Addresses", checkpoint: "addr" },
    "bp.mailingAddr": { store: "bp", key: "mailingAddr", label: "Mailing address", section: "Profile · Addresses" },
    "bp.warehouseAddr": { store: "bp", key: "warehouseAddr", label: "Physical / warehouse address", section: "Profile · Addresses" },

    // ---- contact
    "bp.phone": { store: "bp", key: "phone", label: "Business phone", section: "Profile · Contact", checkpoint: "phone" },
    "bp.email": { store: "bp", key: "email", label: "Business email", section: "Profile · Contact", checkpoint: "email" },
    "bp.website": { store: "bp", key: "website", label: "Website / domain", section: "Profile · Contact", checkpoint: "website" },

    // ---- compliance held on the profile
    "bp.processors": { store: "bp", key: "processors", label: "Payment processors", section: "Profile · Banking & finance", checkpoint: "processor" },
    "bp.licenses": { store: "bp", key: "licenses", label: "Business licenses / permits", section: "Profile · Tax & compliance", checkpoint: "license" },
    "bp.salesTaxPermit": { store: "bp", key: "salesTaxPermit", label: "Sales tax permit / resale certificate #", section: "Profile · Tax & compliance", checkpoint: "salestax" },
    "bp.insurance": { store: "bp", key: "insurance", label: "Insurance policies", section: "Profile · Tax & compliance", checkpoint: "insurance" },
    "bp.trademarks": { store: "bp", key: "trademarks", label: "Trademark registration #s", section: "Profile · Platform / operations", checkpoint: "trademark" },
    "bp.acctRouting": { store: "bp", key: "acctRouting", label: "Account & routing numbers", section: "Profile · Banking & finance", sensitive: true },
    "bp.creditCards": { store: "bp", key: "creditCards", label: "Business credit cards", section: "Profile · Banking & finance", sensitive: true },

    // ---- financials · banking
    "fin.bankName": { store: "fin", key: "bankName", label: "Bank name", section: "Financials · Banking", checkpoint: "bank" },
    "fin.acctType": { store: "fin", key: "acctType", label: "Account type", section: "Financials · Banking" },
    "fin.acctNumber": { store: "fin", key: "acctNumber", label: "Account number", section: "Financials · Banking", sensitive: true },
    "fin.routingNumber": { store: "fin", key: "routingNumber", label: "Routing number", section: "Financials · Banking", sensitive: true },
    "fin.bankContact": { store: "fin", key: "bankContact", label: "Banker / branch contact", section: "Financials · Banking" },
    "fin.bankOnline": { store: "fin", key: "bankOnline", label: "Online banking URL", section: "Financials · Banking" },
    "fin.secondaryBank": { store: "fin", key: "secondaryBank", label: "Secondary bank & account", section: "Financials · Banking", sensitive: true },

    // ---- financials · cards
    "fin.card1": { store: "fin", key: "card1", label: "Card 1 (issuer · last 4 · limit)", section: "Financials · Credit cards", checkpoint: "card", sensitive: true },
    "fin.card2": { store: "fin", key: "card2", label: "Card 2 (issuer · last 4 · limit)", section: "Financials · Credit cards", sensitive: true },
    "fin.card3": { store: "fin", key: "card3", label: "Card 3 (issuer · last 4 · limit)", section: "Financials · Credit cards", sensitive: true },
    "fin.cardDue": { store: "fin", key: "cardDue", label: "Payment due dates", section: "Financials · Credit cards" },
    "fin.cardApr": { store: "fin", key: "cardApr", label: "APR / terms", section: "Financials · Credit cards" },

    // ---- financials · business credit
    "fin.paydex": { store: "fin", key: "paydex", label: "D&B PAYDEX score", section: "Financials · Business credit", checkpoint: "scores" },
    "fin.intelliscore": { store: "fin", key: "intelliscore", label: "Experian Intelliscore", section: "Financials · Business credit", checkpoint: "scores" },
    "fin.equifax": { store: "fin", key: "equifax", label: "Equifax Business score", section: "Financials · Business credit", checkpoint: "scores" },
    "fin.fico": { store: "fin", key: "fico", label: "FICO SBSS", section: "Financials · Business credit", checkpoint: "scores" },
    "fin.tradelines": { store: "fin", key: "tradelines", label: "Net-30 / tradeline accounts", section: "Financials · Business credit", checkpoint: "tradelines" },
    "fin.creditLimitTotal": { store: "fin", key: "creditLimitTotal", label: "Total credit available", section: "Financials · Business credit" },
    "fin.creditNotes": { store: "fin", key: "creditNotes", label: "Credit building notes", section: "Financials · Business credit" },

    // ---- ownership
    "bp.owners": { store: "bp", key: "owners", label: "Owner(s) / officers & titles", section: "Profile · Ownership & management" },
    "bp.ownershipPct": { store: "bp", key: "ownershipPct", label: "Ownership %", section: "Profile · Ownership & management" },
    "bp.ownerSsn": { store: "bp", key: "ownerSsn", label: "Owner SSN / ITIN", section: "Profile · Ownership & management", sensitive: true },
    "bp.ownerDob": { store: "bp", key: "ownerDob", label: "Owner DOB", section: "Profile · Ownership & management", sensitive: true },
    "bp.ownerHomeAddr": { store: "bp", key: "ownerHomeAddr", label: "Owner home address", section: "Profile · Ownership & management" },

    // ---- contact, revenue, platform, digital
    "bp.custService": { store: "bp", key: "custService", label: "Customer service email / phone", section: "Profile · Contact" },
    "bp.annualRevenue": { store: "bp", key: "annualRevenue", label: "Annual revenue estimate", section: "Profile · Banking & finance" },
    "bp.amazonId": { store: "bp", key: "amazonId", label: "Amazon Seller Central ID", section: "Profile · Platform / operations" },
    "bp.walmartId": { store: "bp", key: "walmartId", label: "Walmart Seller ID", section: "Profile · Platform / operations" },
    "bp.gs1Prefix": { store: "bp", key: "gs1Prefix", label: "GS1 / UPC prefix", section: "Profile · Platform / operations" },
    "bp.brandRegistry": { store: "bp", key: "brandRegistry", label: "Brand registry status", section: "Profile · Platform / operations" },
    "bp.domainRegistrar": { store: "bp", key: "domainRegistrar", label: "Domain registrar & renewal", section: "Profile · Digital assets" },
    "bp.hostingProvider": { store: "bp", key: "hostingProvider", label: "Hosting provider", section: "Profile · Digital assets" },
    "bp.annualReportDue": { store: "bp", key: "annualReportDue", label: "Annual report due date", section: "Profile · Tax & compliance" },

    // ---- pipeline-internal, never written to a business record
    "meta.statementPeriod": { store: "meta", key: "statementPeriod", label: "Statement period", section: "Document metadata", internal: true },
    "meta.documentDate": { store: "meta", key: "documentDate", label: "Document date", section: "Document metadata", internal: true }
  };

  M.get = function (dest) { return M.DESTINATIONS[dest] || null; };
  M.isInternal = function (dest) {
    var d = M.get(dest);
    return !!(d && d.internal);
  };
  M.label = function (dest) {
    var d = M.get(dest);
    return d ? d.label : dest;
  };
  M.section = function (dest) {
    var d = M.get(dest);
    return d ? d.section : "Unmapped";
  };

  /* Checkpoints a set of saved destinations satisfies. A checkpoint only
     counts once a value has actually been written, which is what keeps
     unreviewed extraction out of the completion percentage. */
  M.checkpointsFor = function (dests) {
    var out = [];
    (dests || []).forEach(function (dest) {
      var d = M.get(dest);
      if (d && d.checkpoint && out.indexOf(d.checkpoint) < 0) out.push(d.checkpoint);
    });
    return out;
  };

  /* Group candidates by the section they will be written to, so the review
     screen reads like the dashboard the user already knows. */
  M.groupBySection = function (candidates) {
    var groups = [], index = {};
    (candidates || []).forEach(function (c) {
      var section = M.section(c.dest);
      if (!index[section]) { index[section] = { section: section, items: [] }; groups.push(index[section]); }
      index[section].items.push(c);
    });
    return groups;
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.mapping = M;
  if (typeof module !== "undefined" && module.exports) module.exports = M;
})(typeof globalThis !== "undefined" ? globalThis : this);
