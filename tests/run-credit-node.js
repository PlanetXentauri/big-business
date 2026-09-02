/* ============================================================
   Headless test suite for the Business Credit Profile.

       node tests/run-credit-node.js

   Covers the D&B Credit Insights parser against a sanitized copy of a real
   report (in both the PDF.js text layout and, via the .items.json sidecar,
   the font-size path), the provider-neutral credit ledger, the save
   transaction (history, conflicts, mirroring, undo), re-analysis of a
   filed document, the profile-strength verdict and the cross-provider
   schema. IndexedDB is stubbed; nothing here needs a browser.
   ============================================================ */
"use strict";

var fs = require("fs");
var path = require("path");

var FIXTURES = path.join(__dirname, "fixtures");
var JS = path.join(__dirname, "..", "js", "doc");

/* ---------- tiny harness ---------- */
var passed = 0, failed = 0, current = "";
var failures = [];
function suite(name) { current = name; console.log("\n\x1b[1m" + name + "\x1b[0m"); }
function ok(cond, label, detail) {
  if (cond) { passed++; console.log("  \x1b[32mPASS\x1b[0m  " + label); }
  else {
    failed++; failures.push(current + " › " + label + (detail ? "  (" + detail + ")" : ""));
    console.log("  \x1b[31mFAIL\x1b[0m  " + label + (detail ? "\n        " + detail : ""));
  }
}
function eq(got, want, label) {
  ok(JSON.stringify(got) === JSON.stringify(want), label, "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
}

/* ---------- module loading ---------- */
global.document = global.document || { querySelector: function () { return null; }, createElement: function () { return {}; }, head: { appendChild: function () {} } };
global.URL = global.URL || function () {};
if (!global.URL.createObjectURL) global.URL.createObjectURL = function () { return "blob:test"; };
if (!global.URL.revokeObjectURL) global.URL.revokeObjectURL = function () {};

global.DOCAI = global.DOCAI || {};
var U = require(path.join(JS, "util.js"));
var V = require(path.join(JS, "validators.js"));
var MATCH = require(path.join(JS, "business-matcher.js"));
var CLASS = require(path.join(JS, "classifier.js"));
var MAP = require(path.join(JS, "mapping.js"));
var CR = require(path.join(JS, "credit.js"));
var CX = require(path.join(JS, "credit-extractors.js"));
var EXTRACT = require(path.join(JS, "extractors.js"));
global.DOCAI.util = U; global.DOCAI.validators = V; global.DOCAI.mapping = MAP;
global.DOCAI.businessMatcher = MATCH; global.DOCAI.classifier = CLASS; global.DOCAI.extractors = EXTRACT;
global.DOCAI.credit = CR; global.DOCAI.creditExtractors = CX;
MAP.registerCredit();

var fakeBlobs = {}, fakeText = {};
var STORE_REAL = require(path.join(JS, "store.js"));
global.DOCAI.store = {
  putBlob: function (id, file) { fakeBlobs[id] = file; return Promise.resolve(id); },
  getBlob: function (id) { return Promise.resolve(fakeBlobs[id] || null); },
  deleteBlob: function (id) { delete fakeBlobs[id]; return Promise.resolve(); },
  putText: function (id, pages) { fakeText[id] = pages; return Promise.resolve(); },
  getText: function (id) { return Promise.resolve(fakeText[id] || null); },
  deleteText: function (id) { delete fakeText[id]; return Promise.resolve(); },
  buildRecord: STORE_REAL.buildRecord, findExact: STORE_REAL.findExact, findLikely: STORE_REAL.findLikely
};
var PIPE = require(path.join(JS, "pipeline.js"));
global.DOCAI.pipeline = PIPE;
var TX = require(path.join(JS, "transaction.js"));
global.DOCAI.transaction = TX;
var REVIEW = require(path.join(JS, "review-ui.js"));
global.DOCAI.reviewUI = REVIEW;

/* ---------- fixtures ---------- */
function fixturePages(name, withItems) {
  var raw = fs.readFileSync(path.join(FIXTURES, name + ".txt"), "utf8")
    .split("\n").filter(function (l) { return l.indexOf("#") !== 0; }).join("\n");
  var parts = raw.split(/^=== PAGE (\d+) ===\n/m);
  var pages = [];
  for (var i = 1; i < parts.length; i += 2) {
    pages.push({ page: parseInt(parts[i], 10), text: parts[i + 1].replace(/\n+$/, ""), items: [], source: "embedded" });
  }
  if (withItems) {
    var items = JSON.parse(fs.readFileSync(path.join(FIXTURES, name + ".items.json"), "utf8"));
    pages.forEach(function (p) {
      var it = items.filter(function (x) { return x.page === p.page; })[0];
      p.items = it ? it.items : [];
    });
  }
  return pages;
}
function fixtureText(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8")
    .split("\n").filter(function (l) { return l.indexOf("#") !== 0; }).join("\n");
}
function freshState() {
  return {
    bp: { centauri: {}, keypr: { legalName: "Keypr On Company", duns: "12-345-6789" } },
    fin: { centauri: {}, keypr: {} },
    strength: { centauri: {}, keypr: {} },
    strengthData: { centauri: {}, keypr: {} },
    strengthFiles: { centauri: {}, keypr: {} },
    docs: {
      centauri: { files: [], links: [], dnb: [], scan: { files: [] } },
      keypr: { files: [], links: [], dnb: [], scan: { files: [] } }
    },
    docaiHistory: { centauri: {}, keypr: {} }
  };
}
function profilesOf(state) {
  return { centauri: { bp: state.bp.centauri, fin: state.fin.centauri }, keypr: { bp: state.bp.keypr, fin: state.fin.keypr } };
}
function fakeFile(name) { return { name: name, type: "application/pdf", size: 4096 }; }
function proposalFromPages(pages, opts) {
  opts = opts || {};
  var text = pages.map(function (p) { return p.text; }).join("\n\n");
  var ex = EXTRACT.extract(pages, {});
  return {
    id: "imp-test", file: opts.file || fakeFile(opts.fileName || "report.pdf"), fileName: opts.fileName || "report.pdf",
    fileType: "application/pdf", fileSize: 4096, sha256: opts.sha256 || U.sha256Sync(Buffer.from(text)),
    pages: pages, pageCount: pages.length,
    business: MATCH.match(text, opts.profiles || {}), classification: CLASS.classify(text),
    candidates: ex.candidates.filter(function (c) { return !MAP.isInternal(c.dest); }),
    internal: ex.candidates.filter(function (c) { return MAP.isInternal(c.dest); }),
    rejected: ex.rejected, credit: ex.credit,
    exactDuplicates: [], likelyDuplicates: [],
    meta: { statementPeriod: "", documentDate: (ex.credit && ex.credit.reportDate) || "", issuer: "", accountLast4: "" },
    notes: [], warnings: [], reanalysis: opts.reanalysis || null
  };
}
function obsOf(res, metricType) { return res.observations.filter(function (o) { return o.metricType === metricType; })[0] || null; }
function candFor(p, dest) { return p.candidates.filter(function (c) { return c.dest === dest; })[0] || null; }
function creditFields(p) {
  return p.candidates.filter(function (c) { return c.credit; }).map(function (c) {
    return { dest: c.dest, value: c.value, credit: c.credit, confidence: c.confidence, resolution: "" };
  });
}

/* ============================================================
   1 — the D&B Credit Insights parser
   ============================================================ */
var MAY = fixturePages("dnb-insights-keypr-may", true);
var MAY_TEXT = fixturePages("dnb-insights-keypr-may", false);
var MAR = fixturePages("dnb-insights-keypr-mar", true);

suite("Provider detection");
var det = CX.detect(MAY.map(function (p) { return p.text; }).join("\n"));
eq(det.provider, "dnb", "the report is recognised as Dun & Bradstreet");
eq(det.format, "dnb_credit_insights", "…in the Credit Insights format");
eq(CX.detect("Experian Business Credit Report\nIntelliscore Plus: 76").provider, "experian", "an Experian report is recognised");
eq(CX.detect("Equifax Business\nBusiness Credit Risk Score: 540").provider, "equifax", "an Equifax report is recognised");
eq(CX.detect("Meeting notes about coffee."), { provider: null, format: "generic", scores: { dnb: 0, experian: 0, equifax: 0, fico: 0, creditsafe: 0 } }, "an unrelated document names no provider");

[["font-size path", MAY], ["text-only path", MAY_TEXT]].forEach(function (mode) {
  var res = CX.extract(mode[1], {});
  suite("D&B Credit Insights — " + mode[0]);
  eq(res.provider, "dnb", "provider is D&B");
  eq(res.reportDate, "2026-05-18", "report date is the date the report was prepared");
  eq(res.businessName, "Keypr On Company", "the business named on the report is read");
  eq(res.identifiers.duns, "12-345-6789", "the D-U-N-S number is read as the provider identifier");

  var paydex = obsOf(res, "paydex");
  ok(!!paydex, "PAYDEX is recognised as a metric");
  eq(paydex && paydex.status, "data_not_available", "PAYDEX status is DATA NOT AVAILABLE");
  eq(paydex && paydex.value, null, "PAYDEX carries no value");
  eq(paydex && paydex.source.page, 1, "PAYDEX cites page 1");
  ok(paydex && /DATA NOT AVAILABLE/.test(paydex.source.evidence), "PAYDEX evidence quotes the report's own wording");
  ok(paydex && /payment/i.test(paydex.details.reason), "the unavailability is explained from the report (no payment experiences)");

  var del = obsOf(res, "delinquency_score");
  eq(del && del.value, 24, "Delinquency Score is 24");
  eq(del && [del.scaleMin, del.scaleMax], [1, 100], "…on a 1–100 scale");
  eq(del && del.riskLevel, "Moderate-High", "…Moderate-High risk");
  eq(del && del.details.rawScore, 476, "…raw score 476");
  eq(del && del.details.class, 4, "…class 4");
  eq(del && del.details.probability, "8.68%", "…probability of delinquency 8.68%");
  eq(del && del.details.industryAverage, "7.34%", "…industry average 7.34%");
  eq(del && del.source.page, 2, "…from page 2");
  eq(del && del.status, "available", "…and it is AVAILABLE");
  ok(del && del.details.factors.indexOf("No payment experiences reported") >= 0, "…with the factors the report lists");

  var fail = obsOf(res, "failure_score");
  eq(fail && fail.value, 28, "Failure Score is 28");
  eq(fail && fail.riskLevel, "Moderate-High", "…Moderate-High risk");
  eq(fail && fail.details.rawScore, 1434, "…raw score 1434");
  eq(fail && fail.details.class, 4, "…class 4");
  eq(fail && fail.details.probability, "0.52%", "…probability of failure 0.52%");
  eq(fail && fail.details.industryAverage, "0.40%", "…industry average 0.40%");
  eq(fail && fail.source.page, 3, "…from page 3");

  var ser = obsOf(res, "ser_rating");
  eq(ser && ser.value, 6, "Supplier Evaluation Risk Rating is 6");
  eq(ser && [ser.scaleMin, ser.scaleMax], [1, 9], "…on a 1–9 scale — never shown as 6 out of 100");
  eq(ser && ser.riskLevel, "Low-Moderate", "…Low-Moderate risk");
  eq(ser && ser.source.page, 4, "…from page 4");

  var mcr = obsOf(res, "max_credit_recommendation");
  eq(mcr && mcr.value, 5000, "Maximum Credit Recommendation is 5,000");
  eq(mcr && mcr.source.page, 5, "…from page 5");
  eq(CR.metricDef("dnb", "max_credit_recommendation").kind, "currency", "…and it is a currency amount, not a score");

  var obr = obsOf(res, "overall_business_risk");
  eq(obr && obr.valueText, "Moderate", "Overall Business Risk is Moderate");
  eq(obr && obr.value, null, "…kept as a category with no numeric value");
  eq(obr && obr.riskLevel, "Moderate", "…and the risk level is the category itself");

  var rating = obsOf(res, "dnb_rating");
  eq(rating && rating.status, "data_not_available", "D&B Rating is currently unavailable (\"--\")");
  eq(rating && rating.details.current, "--", "…the report's own symbol is kept");
  eq(rating && rating.details.previous, "DS", "…previous rating DS");
  eq(rating && rating.details.asOf, "2026-03-25", "…as of Mar 25, 2026");
  eq(rating && rating.details.previousAsOf, "2025-05-06", "…previous rating as of May 6, 2025");
  eq(rating && rating.source.page, 6, "…from page 6");

  eq(obsOf(res, "payment_behavior") && obsOf(res, "payment_behavior").status, "data_not_available", "Overall Payment Behavior is DATA NOT AVAILABLE");
  eq(obsOf(res, "trade_lines") && obsOf(res, "trade_lines").status, "data_not_available", "Trade lines are DATA NOT AVAILABLE");
  eq([obsOf(res, "suits").value, obsOf(res, "judgments").value, obsOf(res, "liens").value, obsOf(res, "ucc_filings").value], [0, 0, 0, 0], "public records: 0 suits, 0 judgments, 0 liens, 0 UCC filings");
  eq(obsOf(res, "total_inquiries") && obsOf(res, "total_inquiries").value, 2, "2 total inquiries");
  eq(obsOf(res, "unique_customer_inquiries") && obsOf(res, "unique_customer_inquiries").value, 1, "1 unique customer inquiry");

  var counted = res.observations.filter(function (o) { return CR.metricDef("dnb", o.metricType).counted; });
  eq(counted.length, 7, "seven credit metrics are tracked from this report");
  res.observations.forEach(function (o) {
    ok(o.source.page > 0 && !!o.source.section && !!o.source.evidence && !!o.source.confidence,
      o.metricType + " carries page, section, evidence and confidence");
  });
  ok(res.extended.length >= 15, "extended facts the UI has no field for are kept (" + res.extended.length + ")");
  ok(res.extended.some(function (e) { return e.key === "reg_registered_name" && e.valueText === "KEYPR ON COMPANY"; }), "…including the registered name as D&B holds it");
  ok(res.extended.some(function (e) { return e.key === "dnb_thinks_overall"; }), "…and D&B's own assessment statements");
  eq(res.extended.filter(function (e) { return e.key === "payment_history_period"; }).length, 1, "a fact printed on two pages is stored once");
});

suite("Header-less export — same report without the 'Prepared for' running header");
var NOHDR = fixturePages("dnb-insights-keypr-may-noheader", true);
var NOHDR_TEXT = fixturePages("dnb-insights-keypr-may-noheader", false);
ok(!/Prepared for|Credit Insights/.test(NOHDR.map(function (p) { return p.text; }).join("\n")), "the fixture really carries no header");
eq(CX.detect(NOHDR.map(function (p) { return p.text; }).join("\n")).format, "dnb_credit_insights", "the layout is still recognised by its sections");
[["font-size path", NOHDR], ["text-only path", NOHDR_TEXT]].forEach(function (mode) {
  var r = CX.extract(mode[1], {});
  eq(r.reportDate, "2026-05-18", mode[0] + ": report date inferred from the end of the history period");
  ok(r.notes.some(function (n) { return /history period/.test(n); }), mode[0] + ": …and the inference is stated");
  eq(obsOf(r, "paydex") && obsOf(r, "paydex").status, "data_not_available", mode[0] + ": PAYDEX still DATA NOT AVAILABLE with the summary row split");
  eq(obsOf(r, "delinquency_score") && obsOf(r, "delinquency_score").value, 24, mode[0] + ": Delinquency 24");
  eq(obsOf(r, "failure_score") && obsOf(r, "failure_score").value, 28, mode[0] + ": Failure 28");
  eq(obsOf(r, "ser_rating") && obsOf(r, "ser_rating").value, 6, mode[0] + ": SER 6");
  eq(obsOf(r, "max_credit_recommendation") && obsOf(r, "max_credit_recommendation").value, 5000, mode[0] + ": recommendation 5,000");
  eq(obsOf(r, "dnb_rating") && obsOf(r, "dnb_rating").details.previous, "DS", mode[0] + ": previous rating DS");
  eq(r.observations.filter(function (o) { return CR.metricDef("dnb", o.metricType).counted; }).length, 7, mode[0] + ": seven credit metrics");
  eq(r.identifiers.duns, "12-345-6789", mode[0] + ": D-U-N-S read");
});

suite("Nearby numbers are never borrowed");
var resMay = CX.extract(MAY, {});
var p1 = obsOf(resMay, "paydex");
ok(p1.value !== 24 && p1.value !== 28, "24 and 28 are not assigned to PAYDEX");
ok(!resMay.observations.some(function (o) { return o.metricType === "paydex" && o.value != null; }), "no PAYDEX value is invented");
eq(obsOf(resMay, "ser_rating").scaleMax, 9, "6 is not treated as a 6/100 credit score");
ok(obsOf(resMay, "max_credit_recommendation").metricType !== "paydex" && CR.metricDef("dnb", "max_credit_recommendation").cls === "recommendation", "$5,000 is a recommendation, not a score");
eq(typeof obsOf(resMay, "overall_business_risk").valueText, "string", "“Moderate” stays a category");
eq(obsOf(resMay, "overall_business_risk").value, null, "…and is never turned into a number");

suite("The earlier report reads its own values");
var resMar = CX.extract(MAR, {});
eq(resMar.reportDate, "2026-03-25", "March report date");
eq(obsOf(resMar, "delinquency_score").value, 13, "March Delinquency Score is 13");
eq(obsOf(resMar, "failure_score").value, 19, "March Failure Score is 19");
eq(obsOf(resMar, "ser_rating").value, 7, "March SER is 7");
eq(obsOf(resMar, "ser_rating").riskLevel, "Moderate", "…Moderate risk");
eq(obsOf(resMar, "overall_business_risk").valueText, "Moderate-High", "March Overall Business Risk is Moderate-High");
eq(obsOf(resMar, "dnb_rating").status, "available", "March D&B Rating exists");
eq(obsOf(resMar, "dnb_rating").valueText, "DS", "…and is DS");
eq(obsOf(resMar, "dnb_rating").details.previous, "--", "…with no previous rating");

suite("Generic labelled scores — any provider");
var gen = CX.extract([{ page: 1, text: fixtureText("credit-report-centauri.txt"), items: [] }], {});
eq(gen.format, "generic", "the plain labelled form is parsed generically");
eq(obsOf(gen, "paydex").value, 80, "PAYDEX Score: 80");
eq(obsOf(gen, "paydex").provider, "dnb", "…belongs to D&B");
eq(obsOf(gen, "failure_score").value, 91, "Failure Score: 91");
eq(obsOf(gen, "intelliscore_plus").provider, "experian", "Intelliscore belongs to Experian");
eq(obsOf(gen, "business_credit_risk_score").value, 540, "Equifax Business Credit Risk Score: 540");
eq(obsOf(gen, "sbss").value, 220, "FICO SBSS: 220");
var bad = CX.extract([{ page: 1, text: "DUN & BRADSTREET\nPAYDEX Score: 180\nFailure Score: 12", items: [] }], {});
eq(obsOf(bad, "paydex"), null, "an out-of-range PAYDEX produces no observation");
ok(bad.rejected.some(function (r) { return r.metricType === "paydex"; }), "…and is recorded as rejected with a reason");
var noColon = CX.extract([{ page: 1, text: "Dun & Bradstreet report\nPAYDEX 1 100\nThe PAYDEX score is an illustration", items: [] }], {});
eq(obsOf(noColon, "paydex"), null, "a number merely near the word PAYDEX is not a PAYDEX score");
var dnaGeneric = CX.extract([{ page: 1, text: "Dun & Bradstreet\nPAYDEX: Not Available\nFailure Score: 40", items: [] }], {});
eq(obsOf(dnaGeneric, "paydex").status, "data_not_available", "“PAYDEX: Not Available” is a legitimate state");

/* ============================================================
   2 — mapping, extraction candidates
   ============================================================ */
suite("Mapping — credit destinations");
eq(MAP.get("credit.dnb.delinquency_score").store, "credit", "credit destinations target the credit store");
eq(MAP.get("credit.dnb.delinquency_score").checkpoint, "scores", "…and satisfy the Business Credit Profile checkpoint");
eq(MAP.section("credit.dnb.paydex"), "Business Credit · Dun & Bradstreet", "…grouped under the provider");
ok(!!MAP.get("credit.experian.some_future_metric"), "an unregistered metric of a known provider still resolves");
eq(MAP.get("credit.nobody.x"), null, "an unknown provider does not");
eq(MAP.get("credit.dnb.paydex").noEngine, true, "credit destinations are kept out of the Claude engine enum");
eq(MAP.checkpointsFor(["credit.dnb.failure_score"]), ["scores"], "a written credit metric resolves to the scores checkpoint");

suite("Extraction — a D&B report yields one candidate per metric");
var st0 = freshState();
var pMay = proposalFromPages(MAY, { profiles: profilesOf(st0), fileName: "dnb_report_2026-05-18.pdf" });
eq(pMay.classification.typeId, "dnb_report", "classified as a D&B report");
eq(pMay.business.business, "keypr", "matched to Keypr On Company");
ok(!!pMay.credit && pMay.credit.provider === "dnb", "the proposal carries the credit parse");
var cDel = candFor(pMay, "credit.dnb.delinquency_score");
ok(!!cDel, "Delinquency Score is a candidate");
eq(cDel.value, "24 / 100 · Moderate-High", "…displayed on its own scale with its risk band");
eq(cDel.confidence, "High", "…High confidence when page and summary agree");
var cPay = candFor(pMay, "credit.dnb.paydex");
eq(cPay.value, "Data not available", "PAYDEX candidate shows its status, not a number");
eq(candFor(pMay, "fin.paydex"), null, "nothing is proposed for the legacy PAYDEX field");
eq(candFor(pMay, "bp.duns").value, "12-345-6789", "the D-U-N-S also fills the profile field");
ok(pMay.candidates.filter(function (c) { return c.credit; }).length >= 17, "every observation became a candidate");

/* ============================================================
   3 — transaction: save, summary, undo
   ============================================================ */
suite("Save — observations land on the Business Credit Profile");
var s1 = freshState();
var before1 = JSON.stringify(s1);
var p1s = proposalFromPages(MAY, { profiles: profilesOf(s1), fileName: "dnb_report_2026-05-18.pdf" });
var NOW = Date.parse("2026-09-02T12:00:00");
var chain = TX.save(s1, p1s, {
  biz: "keypr", docType: "dnb_report", docTypeLabel: "D&B / PAYDEX Report", category: "credit", saveDocument: true,
  fields: creditFields(p1s).concat([{ dest: "bp.duns", value: "12-345-6789", resolution: "keep" }])
}, {}).then(function (j) {
  var ledger = s1.credit.keypr;
  ok(ledger.observations.length >= 17, "observations were recorded (" + ledger.observations.length + ")");
  var cur = CR.current(s1, "keypr", NOW);
  eq(cur["dnb.delinquency_score"].value, 24, "current Delinquency Score is 24");
  eq(cur["dnb.paydex"].status, "data_not_available", "current PAYDEX status is DATA NOT AVAILABLE");
  eq(cur["dnb.delinquency_score"].effectiveDate, "2026-05-18", "the report date is the observation's effective date");
  ok(cur["dnb.delinquency_score"].importedAt >= j.at, "the import date is recorded separately");
  eq(cur["dnb.delinquency_score"].source.documentId, j.docId, "the observation cites the filed document");
  eq(cur["dnb.delinquency_score"].source.page, 2, "…and its page");
  ok(/DELINQUENCY SCORE/.test(cur["dnb.delinquency_score"].source.evidence), "…and quotes evidence");
  eq(cur["dnb.delinquency_score"].source.method, "auto", "…as an automatic reading");
  eq(j.checkpoints.indexOf("scores") >= 0, true, "the Business Credit Profile checkpoint is satisfied");
  ok((s1.strengthFiles.keypr.scores || []).length === 1, "the report is attached to that checkpoint");
  eq(s1.fin.keypr.paydex, undefined, "no PAYDEX is mirrored into the legacy field when it is unavailable");

  var sum = CR.summary(s1, "keypr", NOW);
  eq(sum.status, "established", "the profile is ESTABLISHED even though PAYDEX is unavailable");
  eq(sum.complete, true, "…which completes the checklist requirement");
  eq([sum.bureausDetected, sum.bureausTotal], [1, 3], "1 of 3 major bureaus detected");
  eq(sum.activeScores, 3, "3 active scores (Delinquency, Failure, SER)");
  eq(sum.creditRecommendation.text, "$5,000", "credit recommendation $5,000");
  eq(sum.overallRisk.text, "Moderate", "overall risk Moderate");
  eq(sum.lastReportDate, "2026-05-18", "last updated from the report date, not the import date");
  eq(sum.providers.dnb.status, "profile_detected", "D&B profile detected");
  eq(sum.providers.dnb.accountIdentifier, "12-345-6789", "…with its D-U-N-S");
  eq(sum.providers.dnb.metricsTracked, 7, "…7 metrics tracked");
  eq(sum.providers.experian.status, "no_report", "Experian: no report (neutral)");
  eq(sum.providers.equifax.status, "no_report", "Equifax: no report (neutral)");
  eq(sum.snapshot.publicRecords, { suits: 0, judgments: 0, liens: 0, ucc: 0 }, "snapshot public records");
  eq(sum.snapshot.inquiries, { total: 2, unique: 1 }, "snapshot inquiries");
  ok(sum.actions.some(function (a) { return a.metric === "PAYDEX" && /payment experiences/i.test(a.title); }), "action: PAYDEX is waiting for payment experiences");
  ok(sum.actions.some(function (a) { return /trade accounts/i.test(a.next); }), "…with the suggested next step of adding reporting trade accounts");
  ok(sum.quality.some(function (q) { return q.metricKey === "dnb.paydex" && /payment/i.test(q.reason); }), "data-quality note explains the PAYDEX gap");
  ok(!sum.actions.some(function (a) { return /bad|poor|fail/i.test(a.title) && /experian|equifax/i.test(a.metric); }), "a missing bureau report is not described as a bad score");

  eq(ledger.documents.length, 1, "the report is in the credit document vault");
  eq(ledger.documents[0].metricCount >= 17, true, "…with its metric count");
  eq(ledger.documents[0].extractionVersion, CX.VERSION, "…and the parser version used");
  ok(ledger.extended.length >= 15, "extended facts were stored with the document");
  var rec = s1.docs.keypr.files[0];
  eq(rec.creditExtraction.provider, "dnb", "the document record carries the credit summary");
  eq(rec.creditExtraction.reportDate, "2026-05-18", "…and the report date");
  eq(rec.documentDate, "2026-05-18", "the document's own date is the report date");

  suite("Undo — every credit write is reversed");
  return TX.undo(s1, {}).then(function (r) {
    ok(r.ok && /credit observation/.test(r.message), "undo reports the credit observations removed");
    eq(JSON.stringify(s1), before1, "state is byte-identical to before the import");
  });
}).then(function () {
  /* ---------- history across two reports ---------- */
  suite("History — a newer report supersedes, never overwrites");
  var s2 = freshState();
  var pMar = proposalFromPages(MAR, { profiles: profilesOf(s2), fileName: "dnb_report_2026-03-25.pdf" });
  return TX.save(s2, pMar, { biz: "keypr", docType: "dnb_report", category: "credit", saveDocument: true, fields: creditFields(pMar) }, {})
    .then(function () {
      var cur = CR.current(s2, "keypr", NOW);
      eq(cur["dnb.delinquency_score"].value, 13, "after the March report the Delinquency Score is 13");
      eq(cur["dnb.dnb_rating"].valueText, "DS", "…and the D&B Rating is DS");
      var pMay2 = proposalFromPages(MAY, { profiles: profilesOf(s2), fileName: "dnb_report_2026-05-18.pdf" });
      var cDel2 = candFor(pMay2, "credit.dnb.delinquency_score");
      REVIEW.open(pMay2, { state: s2, activeBiz: "keypr", commit: function () {}, render: function () {} });
      var cmp = REVIEW.creditCompare(cDel2);
      eq(cmp.relation, "newer", "the review sees the May report as newer");
      eq(REVIEW.session.resolutions[cDel2.dest], "alternate", "…and defaults to keeping both with the dates deciding");
      var html = REVIEW.html();
      ok(html.indexOf("USE NEW") >= 0 && html.indexOf("ADD AS HISTORICAL") >= 0 && html.indexOf("KEEP BOTH") >= 0 && html.indexOf("KEEP CURRENT") >= 0, "all four conflict choices are offered");
      ok(html.indexOf("report Mar 25, 2026") >= 0 && html.indexOf("report May 18, 2026") >= 0, "both report dates are shown side by side");
      REVIEW.close();
      return TX.save(s2, pMay2, { biz: "keypr", docType: "dnb_report", category: "credit", saveDocument: true, fields: creditFields(pMay2) }, {}).then(function () { return s2; });
    }).then(function (s2) {
      var cur = CR.current(s2, "keypr", NOW);
      eq(cur["dnb.delinquency_score"].value, 24, "May's 24 is now current");
      var hist = CR.history(s2, "keypr", "dnb.delinquency_score");
      eq(hist.map(function (o) { return o.value; }), [24, 13], "history holds May 24 and March 13, newest first");
      eq(hist[1].effectiveDate, "2026-03-25", "the older observation keeps its own report date");
      eq(cur["dnb.dnb_rating"].status, "data_not_available", "the D&B Rating is now unavailable (--)");
      eq(CR.history(s2, "keypr", "dnb.dnb_rating")[1].valueText, "DS", "…and DS is preserved in history");
      var trend = CR.trend(s2, "keypr", "dnb.delinquency_score");
      eq(trend.map(function (t) { return t.month; }), ["2026-03", "2026-04", "2026-05"], "the trend spans March to May month by month");
      eq(trend.map(function (t) { return t.value; }), [13, null, 24], "April has no report, so it is null — not zero");
      eq(s2.credit.keypr.documents.length, 2, "both reports are in the vault");
      eq(CR.summary(s2, "keypr", NOW).lastReportDate, "2026-05-18", "last updated follows the newest report");

      suite("History — an older report imported later stays history");
      var s3 = freshState();
      var pA = proposalFromPages(MAY, { profiles: profilesOf(s3), fileName: "may.pdf" });
      return TX.save(s3, pA, { biz: "keypr", docType: "dnb_report", category: "credit", saveDocument: true, fields: creditFields(pA) }, {}).then(function () {
        var pB = proposalFromPages(MAR, { profiles: profilesOf(s3), fileName: "mar.pdf" });
        REVIEW.open(pB, { state: s3, activeBiz: "keypr", commit: function () {}, render: function () {} });
        eq(REVIEW.creditCompare(candFor(pB, "credit.dnb.failure_score")).relation, "older", "the review recognises the March report as older");
        REVIEW.close();
        return TX.save(s3, pB, { biz: "keypr", docType: "dnb_report", category: "credit", saveDocument: true, fields: creditFields(pB) }, {}).then(function () {
          var cur = CR.current(s3, "keypr", NOW);
          eq(cur["dnb.failure_score"].value, 28, "the newer value stays current although imported first");
          eq(CR.history(s3, "keypr", "dnb.failure_score").length, 2, "both observations are retained");
        });
      });
    });
}).then(function () {
  /* ---------- conflicts ---------- */
  suite("Conflicts — same report date, different value");
  var s4 = freshState();
  CR.record(s4, "keypr", CR.buildObservation({ provider: "dnb", metricType: "delinquency_score", value: 24, valueText: "24", status: "available", effectiveDate: "2026-05-18", importedAt: 1, source: { documentId: "doc-a", evidence: "a" } }));
  var second = CR.record(s4, "keypr", CR.buildObservation({ provider: "dnb", metricType: "delinquency_score", value: 31, valueText: "31", status: "available", effectiveDate: "2026-05-18", importedAt: 2, source: { documentId: "doc-b", evidence: "b" } })).obs;
  var cur4 = CR.current(s4, "keypr", NOW)["dnb.delinquency_score"];
  eq(cur4.displayStatus, "conflict", "two live readings with the same date and different values are a CONFLICT");
  eq(CR.conflicts(s4, "keypr").length, 1, "…listed for review");
  eq(CR.compare({ effectiveDate: "2026-05-18", valueText: "24", status: "available" }, { effectiveDate: "2026-05-18", valueText: "31", status: "available" }).defaultResolution, "keep", "the review defaults to KEEP CURRENT when dates cannot decide");
  eq(CR.compare({ effectiveDate: "", valueText: "24", status: "available" }, { effectiveDate: "", valueText: "31", status: "available" }).ambiguous, true, "undated readings are ambiguous");
  CR.resolveConflict(s4, "keypr", cur4.id, second.id, "use_new");
  var after4 = CR.current(s4, "keypr", NOW)["dnb.delinquency_score"];
  eq(after4.value, 31, "USE NEW pins the new reading as current");
  eq(after4.displayStatus, "available", "…and the conflict clears");
  eq(CR.history(s4, "keypr", "dnb.delinquency_score").length, 2, "…without deleting the other reading");

  suite("Manual entries and verification");
  var s5 = freshState();
  CR.record(s5, "keypr", CR.buildObservation({ provider: "dnb", metricType: "delinquency_score", value: 24, valueText: "24", status: "available", effectiveDate: "2026-05-18", importedAt: 1, source: { documentId: "doc-a", evidence: "a" } }));
  var man = CR.manual(s5, "keypr", "dnb", "delinquency_score", { value: 27, valueText: "27", note: "Corrected from the portal" });
  var cur5 = CR.current(s5, "keypr", NOW)["dnb.delinquency_score"];
  eq(cur5.value, 27, "a manual correction becomes current");
  ok(cur5.flags.indexOf("manual") >= 0, "…flagged MANUAL");
  eq(CR.history(s5, "keypr", "dnb.delinquency_score").filter(function (o) { return o.source.method === "auto"; })[0].value, 24, "the imported 24 is preserved in history");
  CR.verify(s5, "keypr", man.id, true);
  ok(CR.current(s5, "keypr", NOW)["dnb.delinquency_score"].flags.indexOf("verified") >= 0, "a verified observation is flagged VERIFIED");

  suite("Stale readings");
  var s6 = freshState();
  CR.record(s6, "keypr", CR.buildObservation({ provider: "dnb", metricType: "failure_score", value: 40, valueText: "40", status: "available", effectiveDate: "2025-01-10", importedAt: 1, source: {} }));
  eq(CR.current(s6, "keypr", NOW)["dnb.failure_score"].displayStatus, "stale", "a reading older than " + CR.STALE_DAYS + " days is shown as STALE");
  eq(CR.ensure(s6, "keypr").observations[0].status, "available", "…without altering the stored status");

  suite("Formatting keeps each scale");
  eq(CR.formatValue({ kind: "score", value: 24, scaleMax: 100, status: "available" }), "24 / 100", "percentile scores show their 100 scale");
  eq(CR.formatValue({ kind: "score", value: 6, scaleMax: 9, status: "available" }), "6 / 9", "SER shows its 9 scale");
  eq(CR.formatValue({ kind: "currency", value: 5000, status: "available" }), "$5,000", "currency formats as money");
  eq(CR.formatValue({ kind: "category", valueText: "Moderate", status: "available" }), "Moderate", "categories stay words");
  eq(CR.formatValue({ kind: "score", value: null, status: "data_not_available" }), "—", "unavailable shows a dash");
  eq(CR.statusLabel("data_not_available"), "DATA NOT AVAILABLE", "status labels are explicit");

  /* ---------- multi-provider schema ---------- */
  suite("Multi-provider schema");
  eq(Object.keys(CR.PROVIDERS).indexOf("experian") >= 0 && Object.keys(CR.PROVIDERS).indexOf("equifax") >= 0, true, "Experian and Equifax are first-class providers");
  ok(!!CR.PROVIDERS.experian.metrics.intelliscore_plus && !!CR.PROVIDERS.experian.metrics.financial_stability_risk, "Experian metrics are modelled (Intelliscore Plus, Financial Stability Risk)");
  ok(!!CR.PROVIDERS.equifax.metrics.business_credit_risk_score && !!CR.PROVIDERS.equifax.metrics.payment_index, "Equifax metrics are modelled");
  ok(!!CR.PROVIDERS.fico && !!CR.PROVIDERS.creditsafe, "further providers slot in without touching the UI");
  eq(CR.metricDef("dnb", "brand_new_metric", { displayName: "Brand New" }).label, "Brand New", "an unknown metric type gets a generic definition rather than an error");
  var s7 = freshState();
  var pGen = proposalFromPages([{ page: 1, text: fixtureText("credit-report-centauri.txt"), items: [] }], { profiles: profilesOf(s7), fileName: "scores.txt" });
  return TX.save(s7, pGen, { biz: "centauri", docType: "dnb_report", category: "credit", saveDocument: true, fields: creditFields(pGen) }, {}).then(function () {
    var sum = CR.summary(s7, "centauri", NOW);
    eq(sum.bureausDetected, 3, "all three major bureaus detected from one labelled sheet");
    eq(sum.status, "strong", "…which is STRONG DATA");
    eq(s7.fin.centauri.paydex, "80", "an available PAYDEX is mirrored into the legacy field");
    eq(s7.fin.centauri.intelliscore, "76", "…as is Intelliscore");
    eq(s7.fin.centauri.equifax, "540", "…and the Equifax score");
    eq(s7.fin.centauri.fico, "220", "…and FICO SBSS");
    return TX.undo(s7, {}).then(function () {
      eq(s7.fin.centauri.paydex, undefined, "undo removes the mirrored legacy value too");
      eq(s7.credit, undefined, "…and the credit ledger");
    });
  });
}).then(function () {
  /* ---------- checklist states ---------- */
  suite("Checklist states");
  var e = freshState();
  eq(CR.summary(e, "keypr", NOW).status, "not_started", "nothing on file → NOT STARTED");
  CR.registerDocument(e, "keypr", { docId: "d1", provider: "dnb", reportDate: "2026-05-18", fileName: "x.pdf" });
  eq(CR.summary(e, "keypr", NOW).status, "partial", "a provider file with no usable score → PARTIAL");
  CR.record(e, "keypr", CR.buildObservation({ provider: "dnb", metricType: "paydex", status: "data_not_available", effectiveDate: "2026-05-18", source: { documentId: "d1" } }));
  eq(CR.summary(e, "keypr", NOW).status, "partial", "…still PARTIAL when the only metric is unavailable");
  CR.record(e, "keypr", CR.buildObservation({ provider: "dnb", metricType: "delinquency_score", value: 24, valueText: "24", status: "available", effectiveDate: "2026-05-18", source: { documentId: "d1" } }));
  eq(CR.summary(e, "keypr", NOW).status, "established", "one available metric → ESTABLISHED");
  ok(/D&B profile established · 1 metric detected/.test(CR.summary(e, "keypr", NOW).line), "…with a human-readable line: " + CR.summary(e, "keypr", NOW).line);
  CR.record(e, "keypr", CR.buildObservation({ provider: "experian", metricType: "intelliscore_plus", value: 70, valueText: "70", status: "available", effectiveDate: "2026-05-18", source: {} }));
  eq(CR.summary(e, "keypr", NOW).status, "strong", "two bureaus established → STRONG DATA");

  /* ---------- re-analysis ---------- */
  suite("Re-analysis — the newest parser over a filed document, no duplicate");
  var s8 = freshState();
  var p8 = proposalFromPages(MAY, { profiles: profilesOf(s8), fileName: "dnb_report_2026-05-18.pdf" });
  // First import saves only two of the metrics, the way an older parser might have.
  var partial = creditFields(p8).filter(function (f) { return /delinquency_score|paydex$/.test(f.dest); });
  return TX.save(s8, p8, { biz: "keypr", docType: "dnb_report", category: "credit", saveDocument: true, fields: partial }, {}).then(function (j) {
    var docId = j.docId;
    var rec = s8.docs.keypr.files[0];
    eq(CR.ensure(s8, "keypr").observations.filter(function (o) { return o.source.documentId === docId; }).length, 2, "two observations cite the document");
    var stored = fakeText[docId];
    ok(!!stored, "the extracted text was stored with the document");
    return PIPE.runPages(stored, { name: rec.name, type: rec.type, size: rec.size, sha256: rec.sha256 }, {
      state: s8, profiles: profilesOf(s8), reanalyze: { docId: docId, record: rec }
    }).then(function (re) {
      ok(!!re.reanalysis && re.reanalysis.docId === docId, "the re-analysis proposal knows which document it re-reads");
      eq(re.exactDuplicates.length, 1, "the pipeline still sees the exact duplicate (it is the same file)");
      REVIEW.open(re, { state: s8, activeBiz: "keypr", commit: function () {}, render: function () {} });
      var cDel = candFor(re, "credit.dnb.delinquency_score"), cFail = candFor(re, "credit.dnb.failure_score");
      eq(cDel.reanalysis, "same", "a metric already saved from this document is SAME AS SAVED");
      eq(cFail.reanalysis, "new", "a metric the old import missed is NEW");
      eq(REVIEW.session.checked[cDel.id], false, "…same values start unticked");
      eq(REVIEW.session.checked[cFail.id], true, "…new High-confidence values start ticked");
      var html = REVIEW.html();
      ok(html.indexOf("RE-ANALYSIS") >= 0 && html.indexOf("EXACT DUPLICATE") < 0, "the review is framed as a re-analysis, not a duplicate warning");
      var before = JSON.stringify(s8.docs.keypr.files[0]);
      var fields = creditFields(re);   // tick everything, including the two already saved
      REVIEW.close();
      return TX.save(s8, re, { biz: "keypr", docType: "dnb_report", category: "credit", reanalyzeDocId: docId, fields: fields }, {}).then(function (j2) {
        eq(s8.docs.keypr.files.length, 1, "no second document record is created");
        eq(j2.docId, null, "…and no second blob");
        var mine = CR.ensure(s8, "keypr").observations.filter(function (o) { return o.source.documentId === docId; });
        eq(mine.filter(function (o) { return o.metricType === "delinquency_score"; }).length, 1, "the already-saved metric is not duplicated");
        ok(mine.length >= 17, "the newly discovered metrics now cite the same document (" + mine.length + ")");
        ok(!!s8.docs.keypr.files[0].reanalyzedAt, "the document record notes the re-analysis");
        eq(s8.docs.keypr.files[0].creditExtraction.version, CX.VERSION, "…and the parser version");
        eq(CR.summary(s8, "keypr", NOW).providers.dnb.metricsTracked, 7, "the profile now tracks all seven metrics");
        return TX.undo(s8, {}).then(function () {
          eq(JSON.stringify(s8.docs.keypr.files[0]), before, "undo restores the document record exactly");
          eq(CR.ensure(s8, "keypr").observations.filter(function (o) { return o.source.documentId === docId; }).length, 2, "…and removes only the re-analysis observations");
        });
      });
    });
  });
}).then(function () {
  suite("Extended facts survive without a field");
  var s9 = freshState();
  var n = CR.addExtended(s9, "keypr", [{ provider: "dnb", key: "k1", label: "Fact", valueText: "v", page: 3 }, { provider: "dnb", key: "k1", label: "Fact", valueText: "v", page: 3 }], "doc-1", "2026-05-18");
  eq(n, 1, "an identical fact from the same document is stored once");
  eq(CR.ensure(s9, "keypr").extended[0].effectiveDate, "2026-05-18", "…stamped with the report date");
  eq(CR.addExtended(s9, "keypr", [{ provider: "dnb", key: "k1", label: "Fact", valueText: "v2", page: 3 }], "doc-1"), 1, "a changed value is a new fact");

  suite("Importing a PDF that is already on file attaches its credit data to that record");
  var s11 = freshState();
  var first = proposalFromPages(MAY, { profiles: profilesOf(s11), fileName: "dnb.pdf", sha256: "same-bytes" });
  return TX.saveDocumentOnly(s11, first, { biz: "keypr", docType: "dnb_report", category: "credit" }, {}).then(function (j0) {
    // The file was filed once by an older engine (no observations). Now it is
    // imported again: an exact duplicate, handled as "link to more fields".
    var again = proposalFromPages(MAY, { profiles: profilesOf(s11), fileName: "dnb.pdf", sha256: "same-bytes" });
    again.exactDuplicates = STORE_REAL.findExact(s11, "same-bytes");
    eq(again.exactDuplicates.length, 1, "the second import is recognised as an exact duplicate");
    var calls = [];
    REVIEW.open(again, { state: s11, activeBiz: "keypr", commit: function () {}, render: function () {} });
    REVIEW.setDup("link");
    REVIEW.checkAll(true);
    var origSave = TX.save;
    TX.save = function (state, proposal, decisions, hooks) { calls.push(decisions); return origSave(state, proposal, decisions, hooks); };
    REVIEW.saveSelected();
    TX.save = origSave;
    return new Promise(function (r) { setTimeout(r, 50); }).then(function () {
      eq(calls[0].reanalyzeDocId, j0.docId, "the save targets the document already on file");
      eq(calls[0].saveDocument, false, "…and files no second copy");
      eq(s11.docs.keypr.files.length, 1, "still one document record");
      var mine = CR.ensure(s11, "keypr").observations.filter(function (o) { return o.source.documentId === j0.docId; });
      ok(mine.length >= 17, "the observations cite the existing document (" + mine.length + ")");
      eq(CR.ensure(s11, "keypr").documents[0].docId, j0.docId, "the vault lists that document");
      eq(CR.summary(s11, "keypr", NOW).status, "established", "and the profile is ESTABLISHED");
    });
  }).then(function () {
  suite("Save document only still registers the report and its facts");
  var s10 = freshState();
  var p10 = proposalFromPages(MAY, { profiles: profilesOf(s10), fileName: "dnb.pdf" });
  return TX.saveDocumentOnly(s10, p10, { biz: "keypr", docType: "dnb_report", category: "credit" }, {}).then(function () {
    eq(CR.ensure(s10, "keypr").observations.length, 0, "no observation is recorded without a tick");
    eq(CR.ensure(s10, "keypr").documents.length, 1, "the document is in the vault");
    ok(CR.ensure(s10, "keypr").extended.length > 0, "its extended facts are kept");
    eq(CR.summary(s10, "keypr", NOW).status, "partial", "the profile is PARTIAL: a file exists, no usable score yet");
  });
  });
}).then(function () {
  console.log("\n" + "─".repeat(58));
  if (failed) {
    console.log("\x1b[31m" + failed + " failed\x1b[0m, " + passed + " passed");
    failures.forEach(function (f) { console.log("  · " + f); });
    process.exit(1);
  }
  console.log("\x1b[32mAll " + passed + " checks passed.\x1b[0m");
  process.exit(0);
}).catch(function (e) {
  console.error("\n\x1b[31mSuite crashed:\x1b[0m", e && e.stack || e);
  process.exit(1);
});
