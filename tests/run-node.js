/* ============================================================
   Headless test suite for the document-autofill pipeline.

       node tests/run-node.js

   Covers everything that does not need a browser: validators, business
   matching, classification, extraction, mapping, and the save/undo
   transaction (with IndexedDB stubbed). The browser-only half — image
   preprocessing, PDF.js, OCR, real IndexedDB — lives in tests/index.html.

   No fixture contains a real EIN, account number, routing number, address
   or phone number.
   ============================================================ */
"use strict";

var fs = require("fs");
var path = require("path");

var FIXTURES = path.join(__dirname, "fixtures");
var JS = path.join(__dirname, "..", "js", "doc");

/* ---------- tiny harness ---------- */
var passed = 0, failed = 0, current = "";
var failures = [];

function suite(name) { current = name; console.log("\n[1m" + name + "[0m"); }
function ok(cond, label, detail) {
  if (cond) { passed++; console.log("  [32mPASS[0m  " + label); }
  else {
    failed++; failures.push(current + " › " + label + (detail ? "  (" + detail + ")" : ""));
    console.log("  [31mFAIL[0m  " + label + (detail ? "\n        " + detail : ""));
  }
}
function eq(got, want, label) {
  ok(JSON.stringify(got) === JSON.stringify(want), label,
    got === undefined && want === undefined ? "" : "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
}

function fixture(name) {
  // Strip the "#" header comment; it is documentation, not document text.
  return fs.readFileSync(path.join(FIXTURES, name), "utf8")
    .split("\n").filter(function (l) { return l.indexOf("#") !== 0; }).join("\n");
}

/* ---------- module loading ----------
   The modules are classic browser scripts that also export for Node. A few
   touch `document` / `URL`; those paths are not exercised here, but the
   globals must exist for the files to evaluate. */
global.document = global.document || { querySelector: function () { return null; }, createElement: function () { return {}; }, head: { appendChild: function () {} } };
global.URL = global.URL || function () {};
if (!global.URL.createObjectURL) global.URL.createObjectURL = function () { return "blob:test"; };
if (!global.URL.revokeObjectURL) global.URL.revokeObjectURL = function () {};

var U = require(path.join(JS, "util.js"));
var V = require(path.join(JS, "validators.js"));
var MATCH = require(path.join(JS, "business-matcher.js"));
var CLASS = require(path.join(JS, "classifier.js"));
var EXTRACT = require(path.join(JS, "extractors.js"));
var MAP = require(path.join(JS, "mapping.js"));

// The modules register themselves on the shared namespace; make sure the
// later ones can find the earlier ones exactly as they do in the browser.
global.DOCAI = global.DOCAI || {};
global.DOCAI.util = U; global.DOCAI.validators = V; global.DOCAI.mapping = MAP;
global.DOCAI.businessMatcher = MATCH; global.DOCAI.classifier = CLASS; global.DOCAI.extractors = EXTRACT;

/* ---------- IndexedDB stub, so the transaction layer can be tested ---------- */
var fakeBlobs = {}, fakeText = {};
global.DOCAI.store = {
  putBlob: function (id, file) { fakeBlobs[id] = file; return Promise.resolve(id); },
  getBlob: function (id) { return Promise.resolve(fakeBlobs[id] || null); },
  deleteBlob: function (id) { delete fakeBlobs[id]; return Promise.resolve(); },
  putText: function (id, pages) { fakeText[id] = pages; return Promise.resolve(); },
  getText: function (id) { return Promise.resolve(fakeText[id] || null); },
  deleteText: function (id) { delete fakeText[id]; return Promise.resolve(); },
  buildRecord: require(path.join(JS, "store.js")).buildRecord,
  findExact: require(path.join(JS, "store.js")).findExact,
  findLikely: require(path.join(JS, "store.js")).findLikely
};
var STORE_REAL = require(path.join(JS, "store.js"));
var TX = require(path.join(JS, "transaction.js"));
global.DOCAI.transaction = TX;
var REVIEW = require(path.join(JS, "review-ui.js"));
global.DOCAI.reviewUI = REVIEW;

/* ---------- shared helpers ---------- */
function pagesOf(text) { return [{ page: 1, text: text, items: [] }]; }

function freshState() {
  return {
    bp: { centauri: {}, keypr: {} },
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
  return {
    centauri: { bp: state.bp.centauri, fin: state.fin.centauri },
    keypr: { bp: state.bp.keypr, fin: state.fin.keypr }
  };
}

function fakeFile(name, type, size) {
  return { name: name, type: type, size: size || 1024 };
}

function proposalFrom(text, opts) {
  opts = opts || {};
  var pages = pagesOf(text);
  var ex = EXTRACT.extract(pages, {});
  return {
    id: "imp-test",
    file: opts.file || fakeFile("fixture.txt", "text/plain"),
    fileName: opts.fileName || "fixture.txt",
    fileType: "text/plain",
    fileSize: 1024,
    sha256: opts.sha256 || U.sha256Sync(Buffer.from(text)),
    pages: pages,
    pageCount: 1,
    business: MATCH.match(text, opts.profiles || {}),
    classification: CLASS.classify(text),
    candidates: ex.candidates.filter(function (c) { return !MAP.isInternal(c.dest); }),
    internal: ex.candidates.filter(function (c) { return MAP.isInternal(c.dest); }),
    rejected: ex.rejected,
    exactDuplicates: [],
    likelyDuplicates: [],
    meta: { statementPeriod: "", documentDate: "", issuer: "", accountLast4: "" },
    notes: [], warnings: []
  };
}

function candFor(p, dest) {
  return p.candidates.filter(function (c) { return c.dest === dest; })[0] || null;
}

/* ============================================================
   1 — validators
   ============================================================ */
suite("Validators");
eq(V.ein("EIN: 88-1234567").value, "88-1234567", "valid EIN normalizes to NN-NNNNNNN");
ok(!V.ein("12-34567").ok, "8-digit EIN is rejected");
ok(!V.ein("11-1111111").ok, "all-identical EIN is rejected");
ok(V.routing("990000013").ok, "routing number with a passing checksum is accepted");
ok(!V.routing("990000014").ok, "routing number with a failing checksum is rejected");
eq(V.routing("990000013").meta.checksum, "passed", "checksum result is recorded");
ok(V.routing("990000013").warnings.length > 0, "unassigned routing prefix produces a warning");
eq(V.date("March 7, 2024").value, "2024-03-07", "month-name date normalizes to ISO");
eq(V.date("03/07/2024").value, "2024-03-07", "US numeric date normalizes without shifting the day");
ok(V.date("03/07/2024").warnings.length > 0, "genuinely ambiguous date is flagged, not silently chosen");
ok(!V.date("02/30/2024").ok, "impossible calendar date is rejected");
ok(!V.date("03/07/24").ok, "two-digit year is rejected rather than guessed");
eq(V.currency("($1,234.56)").meta.amount, -1234.56, "parenthesised amount keeps its negative sign");
eq(V.currency("1,234.56 CR").meta.amount, -1234.56, "CR suffix is read as negative");
eq(V.currency("$1,234.56").meta.currency, "USD", "currency is preserved");
ok(V.score("80", "paydex").ok, "PAYDEX 80 is inside its published range");
ok(!V.score("180", "paydex").ok, "PAYDEX 180 is outside its range and rejected");
ok(V.score("220", "fico").ok, "FICO SBSS 220 is inside its range");
ok(!V.score("100", "equifax").ok, "Equifax 100 is below its range and rejected");
eq(V.phone("1 (217) 555-0188").value, "(217) 555-0188", "phone normalizes and drops the country code");
ok(!V.phone("(011) 555-0100").ok, "area code starting 0 is rejected");
ok(!V.naics("999999").ok, "unassigned NAICS sector is rejected");
eq(V.duns("123456789").value, "12-345-6789", "D-U-N-S formats as NN-NNN-NNNN");

suite("Credit cards never retain the full number");
var cardRes = V.card("4111111111111111");
ok(cardRes.ok, "a Luhn-valid card number is accepted");
eq(cardRes.meta.last4, "1111", "last four are kept");
eq(cardRes.meta.fullNumberRetained, false, "the result records that the PAN was not retained");
ok(JSON.stringify(cardRes).indexOf("4111111111111111") < 0, "the full card number appears nowhere in the result");
ok(!V.card("4111111111111112").ok, "a card number failing Luhn is rejected as a misread");

suite("Masking");
eq(U.maskAccount("000123456789"), "····6789", "account numbers mask to the last four");
eq(U.maskEin("88-1234567"), "··-···4567", "EINs mask to the last four");
eq(U.maskRouting("990000013"), "·····0013", "routing numbers mask to the last four");
eq(U.maskFor("fin.acctNumber", "000123456789"), "····6789", "the destination-based masker picks the right rule");
eq(U.maskFor("bp.legalName", "Centauri World LLC"), "Centauri World LLC", "non-sensitive fields are not masked");
ok(U.isSensitive("fin.routingNumber"), "routing number is classified sensitive");
ok(!U.isSensitive("bp.website"), "website is not classified sensitive");

/* ============================================================
   2 — business matching
   ============================================================ */
suite("Business matching");
var st = freshState();
st.bp.centauri = { legalName: "Centauri World LLC", ein: "88-1234567", principalAddr: "100 Example Street, Springfield, IL 62701" };
st.bp.keypr = { legalName: "Keypr On Company", ein: "91-7654321" };
var prof = profilesOf(st);

var mCent = MATCH.match(fixture("articles-centauri.txt"), prof);
eq(mCent.decision, "confident", "articles of organization match one business confidently");
eq(mCent.business, "centauri", "…and it is Centauri World LLC");
ok(mCent.evidence.length > 0, "the decision carries its evidence");
ok(mCent.reasons.join(" ").indexOf("legal name") >= 0, "the reason names the evidence used");

var mKey = MATCH.match(fixture("ein-letter-keypr.txt"), prof);
eq(mKey.business, "keypr", "the EIN letter matches Keypr On Company");

var mBoth = MATCH.match(fixture("ambiguous-both.txt"), prof);
eq(mBoth.decision, "ambiguous", "a document naming both businesses is ambiguous");
eq(mBoth.business, null, "…and proposes neither");
ok(mBoth.requiresManualChoice, "…and demands a manual choice");

var mNone = MATCH.match(fixture("unknown-document.txt"), prof);
eq(mNone.decision, "none", "an unrelated document matches nothing");
ok(mNone.requiresManualChoice, "…and still requires a manual choice");

var mWeak = MATCH.match("Please call (217) 555-0188 to confirm.", {
  centauri: { bp: { phone: "(217) 555-0188" }, fin: {} }, keypr: { bp: {}, fin: {} }
});
eq(mWeak.decision, "ambiguous", "a phone number alone is not enough to decide");

suite("Evidence excerpts never carry a secret in the clear");
// An excerpt captured for a legal-name or brand match quotes the surrounding
// document text, which on an IRS letter sits right next to the EIN.
var evJson = JSON.stringify(mKey.evidence);
ok(evJson.indexOf("7654321") < 0, "the EIN does not appear in ANY evidence excerpt, whatever the match kind");
mKey.evidence.forEach(function (e) {
  ok(!/\b\d{2}-\d{7}\b/.test(e.excerpt), "no EIN pattern survives in the " + e.kind + " excerpt");
  ok(!/\d{7,}/.test(e.excerpt), "no long digit run survives in the " + e.kind + " excerpt");
});
var pMask = proposalFrom(fixture("bank-statement-centauri.txt"), { profiles: prof });
pMask.candidates.forEach(function (c) {
  ok(!/\d{7,}/.test(c.excerpt), "candidate excerpt for " + c.dest + " carries no long digit run");
});
var clsMask = CLASS.classify(fixture("bank-statement-centauri.txt"));
clsMask.evidence.forEach(function (e) {
  ok(!/\d{7,}/.test(e.excerpt), "classification excerpt carries no long digit run");
});

/* ============================================================
   3 — classification
   ============================================================ */
suite("Classification");
eq(CLASS.classify(fixture("articles-centauri.txt")).typeId, "articles", "articles of organization");
eq(CLASS.classify(fixture("ein-letter-keypr.txt")).typeId, "ein_letter", "EIN confirmation letter");
eq(CLASS.classify(fixture("bank-statement-centauri.txt")).typeId, "bank_statement", "bank statement");
eq(CLASS.classify(fixture("card-statement-keypr.txt")).typeId, "card_statement", "credit card statement");
eq(CLASS.classify(fixture("credit-report-centauri.txt")).typeId, "dnb_report", "D&B credit report");
eq(CLASS.classify(fixture("unknown-document.txt")).typeId, "unclassified", "meeting notes stay unclassified");
eq(CLASS.classify(fixture("unknown-document.txt")).category, "unfiled", "…and are filed as needing review");
eq(CLASS.classify(fixture("bank-statement-centauri.txt")).category, "banking", "type carries its filing category");
ok(CLASS.classify(fixture("articles-centauri.txt")).reasons.length > 0, "classification states its reasoning");

/* ============================================================
   4 — extraction, validation and anti-hallucination
   ============================================================ */
suite("Extraction — articles of organization");
var pArt = proposalFrom(fixture("articles-centauri.txt"), { profiles: prof });
eq((candFor(pArt, "bp.legalName") || {}).value, "CENTAURI WORLD LLC", "legal name");
eq((candFor(pArt, "bp.stateRegNum") || {}).value, "L24000999001", "state document number");
eq((candFor(pArt, "bp.stateFormation") || {}).value, "Illinois", "state of formation");
eq((candFor(pArt, "bp.agentName") || {}).value, "Placeholder Agent Services", "registered agent name");
ok((candFor(pArt, "bp.agentAddress") || {}).value.indexOf("Springfield") > 0, "multi-line agent address is assembled");
eq((candFor(pArt, "bp.formationDate") || {}).value, "2024-03-07", "formation date normalizes to ISO");

suite("Extraction — every candidate carries its evidence");
pArt.candidates.forEach(function (c) {
  ok(!!c.dest && !!c.label, "destination and label present for " + c.dest);
});
var legal = candFor(pArt, "bp.legalName");
ok(legal.page === 1, "candidate records its page number");
ok(legal.excerpt.length > 0, "candidate records a source excerpt");
ok(legal.raw.length > 0, "candidate keeps the raw text separately from the normalized value");
ok(["High", "Medium", "Low"].indexOf(legal.confidence) >= 0, "confidence is High/Medium/Low, never a percentage");
ok(legal.reasons.length > 0, "confidence comes with stated reasons");
ok(!/\d+\s*%/.test(legal.reasons.join(" ")), "no fabricated precision percentage appears in the reasons");

suite("Extraction — banking");
var pBank = proposalFrom(fixture("bank-statement-centauri.txt"), { profiles: prof });
eq((candFor(pBank, "fin.routingNumber") || {}).value, "990000013", "routing number extracted");
eq((candFor(pBank, "fin.acctNumber") || {}).value, "000123456789", "account number preserved exactly");
eq((candFor(pBank, "fin.bankName") || {}).value, "First Example Bank", "bank name");
eq((candFor(pBank, "fin.acctType") || {}).value, "Business Checking", "account type");
eq((candFor(pBank, "fin.routingNumber") || {}).validation.meta.checksum, "passed", "the routing checksum is recorded as passed");
eq((candFor(pBank, "fin.routingNumber") || {}).confidence, "Medium",
  "a validation warning downgrades confidence — this fixture uses an unassigned 99 prefix so it cannot be a real bank");
ok((candFor(pBank, "fin.routingNumber") || {}).validation.warnings.length > 0, "…and the warning is carried for display");
ok(candFor(pBank, "fin.acctNumber").sensitive, "the account number is flagged sensitive");

suite("Extraction — cards and credit scores");
var pCard = proposalFrom(fixture("card-statement-keypr.txt"), { profiles: prof });
ok((candFor(pCard, "fin.card1") || {}).value.indexOf("4321") > 0, "card 1 keeps the last four");
ok((candFor(pCard, "fin.card1") || {}).value.indexOf("VISA") >= 0, "card 1 keeps the issuer");
eq((candFor(pCard, "fin.cardDue") || {}).value, "2024-05-22", "payment due date");
eq((candFor(pCard, "fin.creditLimitTotal") || {}).value, "$15,000.00", "credit limit");

var pCredit = proposalFrom(fixture("credit-report-centauri.txt"), { profiles: prof });
eq((candFor(pCredit, "fin.paydex") || {}).value, "80", "PAYDEX score");
eq((candFor(pCredit, "fin.intelliscore") || {}).value, "76", "Experian Intelliscore");
eq((candFor(pCredit, "fin.equifax") || {}).value, "540", "Equifax business score");
eq((candFor(pCredit, "fin.fico") || {}).value, "220", "FICO SBSS");
eq((candFor(pCredit, "bp.duns") || {}).value, "12-345-6789", "D-U-N-S number");

suite("Anti-hallucination — invalid values are dropped, not repaired");
var pBad = proposalFrom(fixture("bad-values.txt"), { profiles: prof });
eq(candFor(pBad, "bp.ein"), null, "a malformed EIN produces no candidate");
ok(!pBad.candidates.some(function (c) { return String(c.value).indexOf("990000014") >= 0; }),
  "a pattern search after a label cannot capture the next label's value");
eq(candFor(pBad, "fin.routingNumber"), null, "a routing number failing checksum produces no candidate");
eq(candFor(pBad, "fin.paydex"), null, "an out-of-range PAYDEX produces no candidate");
eq(candFor(pBad, "fin.intelliscore"), null, "an out-of-range Intelliscore produces no candidate");
eq(candFor(pBad, "bp.phone"), null, "an invalid phone number produces no candidate");
eq(candFor(pBad, "bp.naics"), null, "an unassigned NAICS code produces no candidate");
eq(candFor(pBad, "bp.formationDate"), null, "an impossible date produces no candidate");
ok(pBad.rejected.length >= 5, "every rejection is recorded for display (" + pBad.rejected.length + " recorded)");
pBad.rejected.forEach(function (r) { ok(r.errors.length > 0, "rejection for " + r.dest + " states why"); });

suite("Anti-hallucination — nothing is invented for absent fields");
var pEmpty = proposalFrom(fixture("unknown-document.txt"), { profiles: prof });
eq(candFor(pEmpty, "bp.ein"), null, "no EIN is invented for a document without one");
eq(candFor(pEmpty, "bp.legalName"), null, "no legal name is invented");
eq(candFor(pEmpty, "fin.bankName"), null, "no bank name is invented");

suite("Ownership and platform fields — coverage the old parser had");
var ownerDoc = [
  "SBA LOAN APPLICATION",
  "CENTAURI WORLD LLC",
  "Managing Member: Alex Placeholder",
  "Ownership Percentage: 100%",
  "Social Security Number: 078-05-1120",
  "Date of Birth: 04/12/1985",
  "Home Address: 42 Placeholder Lane, Springfield, IL 62704",
  "Annual Revenue: $250,000.00",
  "Amazon Seller ID: A1B2C3D4E5F6G",
  "Hosting Provider: Example Host",
  "Domain Registrar: Example Registrar"
].join("\n");
var pOwner = proposalFrom(ownerDoc, { profiles: prof });
eq((candFor(pOwner, "bp.owners") || {}).value, "Alex Placeholder", "managing member extracted");
eq((candFor(pOwner, "bp.ownershipPct") || {}).value, "100%", "ownership percentage extracted");
eq((candFor(pOwner, "bp.ownerSsn") || {}).value, "078-05-1120", "SSN extracted in strict form");
ok((candFor(pOwner, "bp.ownerSsn") || {}).sensitive, "…and flagged sensitive");
eq((candFor(pOwner, "bp.ownerDob") || {}).value, "1985-04-12", "date of birth normalized");
ok((candFor(pOwner, "bp.ownerHomeAddr") || {}).value.indexOf("Springfield") > 0, "owner home address extracted");
eq((candFor(pOwner, "bp.annualRevenue") || {}).value, "$250,000.00", "annual revenue extracted");
eq((candFor(pOwner, "bp.hostingProvider") || {}).value, "Example Host", "hosting provider extracted");

suite("SSN validator refuses anything it cannot be sure of");
ok(V.ssn("078-05-1120").ok, "a correctly formed SSN is accepted");
ok(!V.ssn("078051120").ok, "a bare nine-digit run is refused — too many things are nine digits");
ok(!V.ssn("000-05-1120").ok, "area 000 is never issued");
ok(!V.ssn("666-05-1120").ok, "area 666 is never issued");
ok(!V.ssn("900-05-1120").ok, "area 9xx is never issued");
ok(!V.ssn("078-00-1120").ok, "group 00 is invalid");
ok(!V.ssn("078-05-0000").ok, "serial 0000 is invalid");
eq(U.maskFor("bp.ownerSsn", "078-05-1120"), "···-··-1120", "SSN masks to the last four in ordinary views");
eq(U.maskFor("bp.ownerDob", "1985-04-12"), "····-··-··", "date of birth is fully masked in ordinary views");

/* ============================================================
   5 — mapping
   ============================================================ */
suite("Mapping");
eq(MAP.get("bp.ein").checkpoint, "ein", "EIN maps to the EIN strength checkpoint");
eq(MAP.get("fin.bankName").checkpoint, "bank", "bank name maps to the bank account checkpoint");
eq(MAP.get("fin.bankName").store, "fin", "financial fields target the fin store");
eq(MAP.get("bp.legalName").store, "bp", "profile fields target the bp store");
ok(MAP.isInternal("meta.statementPeriod"), "statement period is internal and never written to a record");
eq(MAP.checkpointsFor(["bp.ein", "bp.legalName", "fin.paydex"]), ["ein", "entity", "scores"], "checkpoints resolve from written destinations");
eq(MAP.checkpointsFor([]), [], "nothing written satisfies no checkpoint");

// Every destination an extractor can produce must exist in the registry,
// otherwise a value could be extracted with nowhere legitimate to go.
suite("Mapping covers every extractor destination");
var missing = [];
EXTRACT.SPECS.forEach(function (s) { if (!MAP.get(s.dest)) missing.push(s.dest); });
["fin.card1", "fin.card2", "fin.card3"].forEach(function (d) { if (!MAP.get(d)) missing.push(d); });
eq(missing, [], "no extractor destination is unmapped");

suite("Review — Low confidence is a warning, not a save block");
var reviewState = freshState();
var reviewProposal = proposalFrom(fixture("articles-centauri.txt"), { profiles: profilesOf(reviewState) });
var reviewCandidate = candFor(reviewProposal, "bp.formationDate");
reviewCandidate.confidence = "Low";
reviewCandidate.validation.warnings = ["Ambiguous numeric date — confirm the intended month and day"];
REVIEW.open(reviewProposal, {
  state: reviewState, activeBiz: "centauri",
  commit: function () {}, render: function () {}
});
REVIEW.toggle(reviewCandidate.id, true);
var reviewHtml = REVIEW.html();
ok(reviewHtml.indexOf("MANUALLY APPROVED") >= 0,
  "a selected Low-confidence value is visibly marked as manually approved");
ok(reviewHtml.indexOf("It will be saved exactly as shown") >= 0,
  "the review explains that Low confidence does not block saving");
ok(reviewHtml.indexOf("SAVE SELECTED") >= 0 && reviewHtml.indexOf("warning value(s) manually approved") >= 0,
  "the final Save area counts the manually selected warning value");
REVIEW.close();

/* ============================================================
   6 — transaction: save, conflicts, undo
   ============================================================ */
suite("Save — only ticked fields are written");
var s1 = freshState();
var p1 = proposalFrom(fixture("articles-centauri.txt"), { profiles: profilesOf(s1) });
var chain = TX.save(s1, p1, {
  biz: "centauri",
  docType: "articles",
  docTypeLabel: "Articles of Organization / Incorporation",
  category: "formation",
  saveDocument: true,
  fields: [
    { dest: "bp.legalName", value: "CENTAURI WORLD LLC", resolution: "replace", confidence: "High" },
    { dest: "bp.formationDate", value: "2024-03-07", resolution: "replace", confidence: "Low",
      manuallyApproved: true, validationWarnings: ["Ambiguous numeric date — manually confirmed"] }
  ]
}, {}).then(function (j1) {
  eq(s1.bp.centauri.legalName, "CENTAURI WORLD LLC", "the ticked field is written");
  eq(s1.bp.centauri.formationDate, "2024-03-07", "a manually approved Low-confidence value is also written");
  eq(s1.bp.centauri.stateRegNum, undefined, "an unticked field is not written");
  eq(s1.bp.keypr.legalName, undefined, "nothing is written to the other business");
  eq(s1.docs.centauri.files.length, 1, "the document is filed under the matched business");
  eq(s1.docs.keypr.files.length, 0, "…and not under the other one");
  eq(s1.docs.centauri.files[0].category, "formation", "the document carries its category");
  eq(s1.docs.centauri.files[0].linkedFields, ["bp.legalName", "bp.formationDate"], "the document records the fields it filled");
  eq(j1.checkpoints, ["entity"], "the write satisfies the entity checkpoint");
  eq(j1.fieldWrites[1].manuallyApproved, true, "the Low-confidence approval is recorded in the transaction");
  eq(j1.fieldWrites[1].confidence, "Low", "the saved value keeps its confidence label for audit");
  ok((s1.strengthFiles.centauri.entity || []).length === 1, "the document is attached to that checkpoint");

  suite("Undo restores the previous state exactly");
  return TX.undo(s1, {});
}).then(function (r) {
  ok(r.ok, "undo reports success");
  eq(s1.bp.centauri.legalName, undefined, "a field the import created is removed");
  eq(s1.docs.centauri.files.length, 0, "the document record is removed");
  eq((s1.strengthFiles.centauri.entity || []).length, 0, "the checkpoint attachment is removed");
  ok(!TX.canUndo(), "there is nothing left to undo");

  /* ---------- conflicts ---------- */
  suite("Conflicts — existing values are never overwritten silently");
  var s2 = freshState();
  s2.bp.centauri.principalAddr = "100 Example Street, Springfield, IL 62701";
  s2.bp.centauri.phone = "(217) 555-0100";
  var p2 = proposalFrom(fixture("conflict-update.txt"), { profiles: profilesOf(s2) });

  return TX.save(s2, p2, {
    biz: "centauri", docType: "annual_report", category: "formation", saveDocument: false,
    fields: [
      { dest: "bp.principalAddr", value: "250 Second Avenue, Springfield, IL 62702", resolution: "keep" },
      { dest: "bp.phone", value: "(217) 555-0188", resolution: "replace" }
    ]
  }, {}).then(function () { return { s2: s2, p2: p2 }; });
}).then(function (c) {
  var s2 = c.s2;
  eq(s2.bp.centauri.principalAddr, "100 Example Street, Springfield, IL 62701",
    "a conflict resolved as 'keep' leaves the existing value untouched");
  eq(s2.bp.centauri.phone, "(217) 555-0188", "a conflict resolved as 'replace' writes the new value");
  ok(s2.docaiHistory.centauri["bp.phone"].length === 1, "the replaced value is preserved in history");
  eq(s2.docaiHistory.centauri["bp.phone"][0].value, "(217) 555-0100", "…and it is the old value that was kept");
  eq(s2.docaiHistory.centauri["bp.phone"][0].kind, "replaced", "…recorded as a replacement");
  ok(s2.docaiHistory.centauri["bp.principalAddr"].length === 1, "the rejected new value is kept as an alternate");
  eq(s2.docaiHistory.centauri["bp.principalAddr"][0].kind, "alternate", "…recorded as an alternate");

  suite("Undo also reverses an overwrite");
  return TX.undo(s2, {}).then(function () {
    eq(s2.bp.centauri.phone, "(217) 555-0100", "the overwritten value is restored");
    eq(s2.docaiHistory.centauri["bp.phone"], undefined, "the history entry the import added is removed");
  });
}).then(function () {
  /* ---------- document only ---------- */
  suite("Save document only");
  var s3 = freshState();
  var p3 = proposalFrom(fixture("bank-statement-centauri.txt"), { profiles: profilesOf(s3) });
  return TX.saveDocumentOnly(s3, p3, { biz: "centauri", docType: "bank_statement", category: "banking" }, {})
    .then(function () {
      eq(Object.keys(s3.fin.centauri).length, 0, "no financial field is written");
      eq(Object.keys(s3.bp.centauri).length, 0, "no profile field is written");
      eq(s3.docs.centauri.files.length, 1, "the document itself is filed");
      return TX.undo(s3, {});
    });
}).then(function () {
  /* ---------- cancel ---------- */
  suite("Cancel mutates nothing");
  var s4 = freshState();
  var before = JSON.stringify(s4);
  proposalFrom(fixture("articles-centauri.txt"), { profiles: profilesOf(s4) });   // extraction only
  eq(JSON.stringify(s4), before, "running the pipeline without saving leaves state byte-identical");

  /* ---------- duplicates ---------- */
  suite("Duplicate detection");
  var s5 = freshState();
  var text5 = fixture("bank-statement-centauri.txt");
  var p5 = proposalFrom(text5, { profiles: profilesOf(s5) });
  p5.meta = { statementPeriod: "03/01/2024 - 03/31/2024", documentDate: "2024-03-31", issuer: "First Example Bank", accountLast4: "6789" };
  return TX.save(s5, p5, {
    biz: "centauri", docType: "bank_statement", category: "banking", saveDocument: true, fields: []
  }, {}).then(function () {
    var exact = STORE_REAL.findExact(s5, p5.sha256);
    eq(exact.length, 1, "an identical file is found by SHA-256");
    eq(exact[0].biz, "centauri", "…under the business it was filed in");
    eq(STORE_REAL.findExact(s5, "0".repeat(64)).length, 0, "a different hash matches nothing");

    var likely = STORE_REAL.findLikely(s5, {
      biz: "centauri", sha256: "different-hash", docType: "bank_statement",
      issuer: "First Example Bank", statementPeriod: "03/01/2024 - 03/31/2024",
      documentDate: "2024-03-31", accountLast4: "6789"
    });
    eq(likely.length, 1, "a different file with the same type, issuer and period is a likely duplicate");
    ok(likely[0].reasons.length >= 2, "the likely-duplicate warning states its reasons");

    var notLikely = STORE_REAL.findLikely(s5, {
      biz: "centauri", sha256: "different-hash", docType: "card_statement",
      issuer: "Other Bank", statementPeriod: "05/01/2024 - 05/31/2024"
    });
    eq(notLikely.length, 0, "an unrelated document is not flagged");
    return TX.undo(s5, {});
  });
}).then(function () {
  /* ---------- cross-business safety ---------- */
  suite("No value can cross between businesses");
  var s6 = freshState();
  s6.bp.keypr.legalName = "Keypr On Company";
  var p6 = proposalFrom(fixture("articles-centauri.txt"), { profiles: profilesOf(s6) });
  return TX.save(s6, p6, {
    biz: "centauri", docType: "articles", category: "formation", saveDocument: true,
    fields: p6.candidates.map(function (c) { return { dest: c.dest, value: c.value, resolution: "replace" }; })
  }, {}).then(function () {
    eq(s6.bp.keypr.legalName, "Keypr On Company", "the other business's existing value is untouched");
    eq(s6.bp.keypr.stateRegNum, undefined, "no imported value lands on the other business");
    eq(s6.docs.keypr.files.length, 0, "no document lands on the other business");
    ok(Object.keys(s6.bp.centauri).length > 3, "the matched business did receive the values");
    return TX.undo(s6, {});
  });
}).then(function () {
  /* ---------- rejects an unconfirmed business ---------- */
  suite("Saving without a confirmed business is refused");
  var s7 = freshState();
  var p7 = proposalFrom(fixture("ambiguous-both.txt"), { profiles: profilesOf(s7) });
  return TX.save(s7, p7, { biz: null, fields: [{ dest: "bp.ein", value: "88-1234567" }] }, {})
    .then(function () { ok(false, "save should have been refused"); })
    .catch(function (e) {
      ok(/no business/i.test(e.message), "save is refused with a clear message");
      eq(Object.keys(s7.bp.centauri).length, 0, "…and nothing was written to either business");
      eq(Object.keys(s7.bp.keypr).length, 0, "…confirmed for both");
    });
}).then(function () {
  /* ---------- migration ---------- */
  suite("Existing data survives untouched");
  var legacy = {
    bp: { centauri: { legalName: "Centauri World LLC" }, keypr: {} },
    fin: { centauri: { bankName: "Old Bank" }, keypr: {} },
    strength: { centauri: {}, keypr: {} }, strengthData: { centauri: {}, keypr: {} },
    strengthFiles: { centauri: {}, keypr: {} },
    docs: {
      centauri: {
        files: [{ id: "doc-old-1", name: "legacy.png", type: "image/png", size: 900, ts: 1, dataUri: "data:image/png;base64,AAAA", ref: false }],
        links: [], dnb: [], scan: { files: [] }
      },
      keypr: { files: [], links: [], dnb: [], scan: { files: [] } }
    },
    docaiHistory: { centauri: {}, keypr: {} }
  };
  var legacyBefore = JSON.stringify(legacy.docs.centauri.files[0]);
  var p8 = proposalFrom(fixture("credit-report-centauri.txt"), { profiles: profilesOf(legacy) });
  return TX.save(legacy, p8, {
    biz: "centauri", docType: "dnb_report", category: "credit", saveDocument: true,
    fields: [{ dest: "fin.paydex", value: "80", resolution: "replace" }]
  }, {}).then(function () {
    eq(JSON.stringify(legacy.docs.centauri.files[1]), legacyBefore, "the pre-existing legacy file record is unchanged");
    eq(legacy.docs.centauri.files[1].dataUri, "data:image/png;base64,AAAA", "…including its base64 payload");
    eq(legacy.bp.centauri.legalName, "Centauri World LLC", "pre-existing profile values are unchanged");
    eq(legacy.fin.centauri.bankName, "Old Bank", "pre-existing financial values are unchanged");
    eq(legacy.fin.centauri.paydex, "80", "the new value is added alongside them");
    eq(legacy.docs.centauri.files[0].dataUri, null, "the new record stores no base64 in state");
    ok(legacy.docs.centauri.files[0].blobId, "…it points at a blob instead");
  });
}).then(function () {
  /* ---------- privacy ---------- */
  suite("Privacy — no document text or secret reaches serialized state");
  var s9 = freshState();
  var text9 = fixture("bank-statement-centauri.txt");
  var p9 = proposalFrom(text9, { profiles: profilesOf(s9) });
  return TX.save(s9, p9, {
    biz: "centauri", docType: "bank_statement", category: "banking", saveDocument: true,
    fields: [{ dest: "fin.bankName", value: "First Example Bank", resolution: "replace" }]
  }, {}).then(function () {
    var serialized = JSON.stringify(s9);
    ok(serialized.indexOf("Beginning Balance") < 0, "extracted document text is not serialized into state");
    ok(serialized.indexOf("990000013") < 0, "an unsaved routing number does not leak into state");
    ok(serialized.indexOf("000123456789") < 0, "an unsaved account number does not leak into state");
    ok(serialized.indexOf("data:") < 0, "no base64 blob is serialized into state");
    var rec = s9.docs.centauri.files[0];
    eq(rec.dataUri, null, "the document record holds no inline payload");
    ok(!!rec.sha256, "…but does hold its hash for duplicate detection");
  });
}).then(function () {
  /* ---------- end to end ---------- */
  suite("End to end: upload → extract → classify → review → edit → save → verify → undo");
  var s = freshState();
  s.bp.centauri = { legalName: "Centauri World LLC" };
  var text = fixture("bank-statement-centauri.txt");
  var p = proposalFrom(text, { profiles: profilesOf(s), fileName: "march-statement.txt" });

  // extract + classify
  eq(p.classification.typeId, "bank_statement", "1. classified as a bank statement");
  eq(p.business.business, "centauri", "2. matched to Centauri World LLC on document evidence");
  ok(p.candidates.length >= 4, "3. produced candidates with evidence");

  // review: only High confidence would be pre-ticked
  var preTicked = p.candidates.filter(function (c) { return c.confidence === "High"; });
  ok(preTicked.length > 0, "4. some candidates are High confidence");
  ok(p.candidates.some(function (c) { return c.confidence !== "High"; }),
    "5. and some are not, so they would start unticked");

  // edit one value the way the review screen does
  var bank = candFor(p, "fin.bankName");
  var editedValue = "First Example Bank — Main Branch";

  var stateBefore = JSON.stringify(s);
  return TX.save(s, p, {
    biz: "centauri", docType: "bank_statement",
    docTypeLabel: "Bank Statement", category: "banking", saveDocument: true,
    fields: [
      { dest: "fin.bankName", value: editedValue, resolution: "replace" },
      { dest: "fin.routingNumber", value: candFor(p, "fin.routingNumber").value, resolution: "replace" }
    ]
  }, {}).then(function (journal) {
    eq(s.fin.centauri.bankName, editedValue, "6. the edited value is what got saved");
    eq(s.fin.centauri.routingNumber, "990000013", "7. the untouched value saved as extracted");
    eq(s.fin.centauri.acctNumber, undefined, "8. an unticked field was not saved");
    eq(s.docs.centauri.files.length, 1, "9. the document is filed");
    eq(s.docs.centauri.files[0].category, "banking", "10. under the banking category");
    eq(s.docs.centauri.files[0].biz, "centauri", "11. against the right business");
    eq(s.docs.keypr.files.length, 0, "12. and nothing reached the other business");
    eq(journal.checkpoints, ["bank"], "13. the bank checkpoint is satisfied");
    return TX.undo(s, {});
  }).then(function () {
    eq(JSON.stringify(s), stateBefore, "14. undo restores state byte-for-byte");
  });
}).then(function () {
  console.log("\n" + "─".repeat(58));
  if (failed) {
    console.log("[31m" + failed + " failed[0m, " + passed + " passed");
    failures.forEach(function (f) { console.log("  · " + f); });
    process.exit(1);
  }
  console.log("[32mAll " + passed + " checks passed.[0m");
  process.exit(0);
}).catch(function (e) {
  console.error("\n[31mSuite crashed:[0m", e && e.stack || e);
  process.exit(1);
});
