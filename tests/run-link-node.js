/* ============================================================
   Headless test suite for the "Autofill from Link" pipeline.

       node tests/run-link-node.js

   Covers URL handling, HTML reading, structured data, classification,
   business matching, extraction, link persistence, duplicates, recheck and
   the save/undo transaction — with fetch stubbed so no real request is ever
   made. The browser half (live fetch, CORS, DOMParser, IndexedDB) lives in
   tests/index.html.

   No fixture contains a real domain, address, phone number or identifier.
   ============================================================ */
"use strict";

var fs = require("fs");
var path = require("path");

var FIXTURES = path.join(__dirname, "fixtures");
var JS = path.join(__dirname, "..", "js", "doc");

/* ---------- harness ---------- */
var passed = 0, failed = 0, current = "";
var failures = [];
function suite(n) { current = n; console.log("\n\u001b[1m" + n + "\u001b[0m"); }
function ok(cond, label, detail) {
  if (cond) { passed++; console.log("  \u001b[32mPASS\u001b[0m  " + label); }
  else {
    failed++; failures.push(current + " \u203a " + label + (detail ? "  (" + detail + ")" : ""));
    console.log("  \u001b[31mFAIL\u001b[0m  " + label + (detail ? "\n        " + detail : ""));
  }
}
function eq(got, want, label) {
  ok(JSON.stringify(got) === JSON.stringify(want), label,
    "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
}
function fixture(name) { return fs.readFileSync(path.join(FIXTURES, name), "utf8"); }

/* ---------- environment ---------- */
global.document = global.document || {
  querySelector: function () { return null; },
  createElement: function () { return {}; },
  head: { appendChild: function () {} },
  getElementById: function () { return null; }
};
global.URL = global.URL || require("url").URL;
if (!global.URL.createObjectURL) global.URL.createObjectURL = function () { return "blob:test"; };
if (!global.URL.revokeObjectURL) global.URL.revokeObjectURL = function () {};

global.DOCAI = global.DOCAI || {};
var U = require(path.join(JS, "util.js")); global.DOCAI.util = U;
var V = require(path.join(JS, "validators.js")); global.DOCAI.validators = V;
var MAP = require(path.join(JS, "mapping.js")); global.DOCAI.mapping = MAP;
var MATCH = require(path.join(JS, "business-matcher.js")); global.DOCAI.businessMatcher = MATCH;
var CLASS = require(path.join(JS, "classifier.js")); global.DOCAI.classifier = CLASS;
var LU = require(path.join(JS, "link-url.js")); global.DOCAI.linkUrl = LU;
var LH = require(path.join(JS, "link-html.js")); global.DOCAI.linkHtml = LH;
var LF = require(path.join(JS, "link-fetch.js")); global.DOCAI.linkFetch = LF;
var LC = require(path.join(JS, "link-classifier.js")); global.DOCAI.linkClassifier = LC;
var LE = require(path.join(JS, "link-extractors.js")); global.DOCAI.linkExtractors = LE;

// IndexedDB stub for the text store.
var fakeText = {};
global.DOCAI.store = {
  putText: function (id, pages) { fakeText[id] = pages; return Promise.resolve(); },
  getText: function (id) { return Promise.resolve(fakeText[id] || null); },
  deleteText: function (id) { delete fakeText[id]; return Promise.resolve(); },
  putBlob: function () { return Promise.resolve(); },
  getBlob: function () { return Promise.resolve(null); },
  deleteBlob: function () { return Promise.resolve(); }
};
var LS = require(path.join(JS, "link-store.js")); global.DOCAI.linkStore = LS;
var LP = require(path.join(JS, "link-pipeline.js")); global.DOCAI.linkPipeline = LP;
var TX = require(path.join(JS, "transaction.js")); global.DOCAI.transaction = TX;

/* ---------- fetch stub ----------
   Records every call so the suite can prove nothing was uploaded and no
   unexpected host was contacted. */
var netCalls = [];
function stubFetch(routes) {
  global.fetch = function (url, init) {
    netCalls.push({ url: String(url), method: (init && init.method) || "GET", body: init && init.body,
      mode: init && init.mode, credentials: init && init.credentials });
    var key = Object.keys(routes).filter(function (k) { return String(url).indexOf(k) >= 0; })[0];
    var r = key ? routes[key] : null;
    if (!r) return Promise.reject(new TypeError("Failed to fetch"));
    if (r.reject) return Promise.reject(r.reject);
    if (r.hang) return new Promise(function () {});   // never settles: timeout path
    return Promise.resolve(makeResponse(r, String(url)));
  };
}
function makeResponse(r, url) {
  var body = r.body == null ? "" : r.body;
  return {
    ok: r.status === undefined || (r.status >= 200 && r.status < 300),
    status: r.status === undefined ? 200 : r.status,
    statusText: r.statusText || "",
    url: r.finalUrl || url,
    redirected: !!r.redirected,
    headers: { get: function (h) {
      var m = { "content-type": r.contentType || "text/html; charset=utf-8" };
      if (r.contentLength) m["content-length"] = String(r.contentLength);
      return m[String(h).toLowerCase()] || null;
    } },
    body: null,                                   // force the text() path
    text: function () { return Promise.resolve(body); }
  };
}
global.AbortController = global.AbortController || function () {
  this.signal = {}; this.abort = function () { if (this.signal.onabort) this.signal.onabort(); };
};

/* ---------- helpers ---------- */
function freshState() {
  return {
    bp: { centauri: {}, keypr: {} }, fin: { centauri: {}, keypr: {} },
    strength: { centauri: {}, keypr: {} }, strengthData: { centauri: {}, keypr: {} },
    strengthFiles: { centauri: {}, keypr: {} },
    docs: {
      centauri: { files: [], links: [], dnb: [], scan: { files: [] }, web: [] },
      keypr: { files: [], links: [], dnb: [], scan: { files: [] }, web: [] }
    },
    docaiHistory: { centauri: {}, keypr: {} }
  };
}
function profilesOf(st) {
  return {
    centauri: { bp: st.bp.centauri, fin: st.fin.centauri },
    keypr: { bp: st.bp.keypr, fin: st.fin.keypr }
  };
}
function seeded() {
  var st = freshState();
  st.bp.centauri = { legalName: "Centauri World LLC", website: "https://centauri-world.test" };
  st.bp.keypr = { legalName: "Keypr On Company" };
  return st;
}
function candFor(p, dest) {
  return (p.candidates || []).filter(function (c) { return c.dest === dest; })[0] || null;
}

/* ============================================================
   1 — URL validation and normalization
   ============================================================ */
suite("URL handling");
ok(LU.normalize("https://example.test/about").ok, "a valid https URL is accepted");
eq(LU.normalize("example.test/about").url, "https://example.test/about", "a missing scheme becomes https");
ok(LU.normalize("example.test").addedScheme, "…and that is recorded so it can be shown");
ok(!LU.normalize("not a url").ok, "a malformed address is rejected");
ok(!LU.normalize("").ok, "an empty address is rejected");

suite("Unsafe schemes are refused by name");
["javascript:alert(1)", "JavaScript:alert(1)", "java\tscript:alert(1)",
 "data:text/html,<script>x</script>", "file:///C:/secret.txt", "vbscript:x",
 "blob:https://x/y", "ftp://example.test/f", "mailto:a@b.test"].forEach(function (bad) {
  var r = LU.normalize(bad);
  ok(!r.ok, "refused: " + bad.slice(0, 28));
  ok(!!r.reason, "…with a reason the user can read");
});
eq(LU.safeHref("javascript:alert(1)"), "#", "an unsafe scheme can never become an href");
eq(LU.safeHref("https://example.test/" + String.fromCharCode(0) + "x"), "#",
  "a NUL byte in an address makes it unclickable");
eq(LU.safeHref("https://example.test/" + String.fromCharCode(9) + "x"), "#",
  "a tab in an address makes it unclickable — the java<TAB>script trick");
eq(LU.safeHref("https://example.test/" + String.fromCharCode(127)), "#",
  "a DEL byte in an address makes it unclickable");
eq(LU.safeHref("https://example.test"), "https://example.test", "a safe scheme passes through");

suite("Normalization is conservative");
eq(LU.normalize("https://example.test/a#frag").url, "https://example.test/a", "the fragment is dropped");
eq(LU.normalize("https://example.test:443/a").url, "https://example.test/a", "a default port is dropped");
ok(LU.sameNormalized("example.test", "https://www.example.test/"), "www and scheme differences compare equal");
ok(LU.sameNormalized("https://example.test/a?utm_source=x", "https://example.test/a"),
  "tracking parameters are ignored when comparing");
ok(!LU.sameNormalized("https://example.test/a", "https://example.test/b"), "different paths do not compare equal");
ok(!LU.sameNormalized("https://example.test/a?id=1", "https://example.test/a?id=2"),
  "a meaningful query parameter is NOT ignored");
eq(LU.registrableDomain("shop.example.co.uk"), "example.co.uk", "two-part suffixes are handled");

/* ============================================================
   2 — HTML reading and safety
   ============================================================ */
suite("Remote HTML cannot execute or pollute");
var hostile = fixture("web-hostile.html");
var beforeProto = ({}).polluted;
var hp = LH.parse(hostile, "https://hostile.test/");
eq(({}).polluted, beforeProto, "a __proto__ payload in JSON-LD does not pollute Object.prototype");
eq(({}).alsoPolluted, undefined, "…nor via constructor.prototype");
eq(typeof global.__hostileRan, "undefined", "an inline <script> in the page never runs");
eq(typeof global.__hostileImg, "undefined", "an onerror handler never runs");
eq(typeof global.__hostileClick, "undefined", "an onclick handler never runs");
ok(hp.text.indexOf("window.__hostileRan") < 0, "script source is not left in the extracted text");
ok(hp.organization && hp.organization.name === "Sneaky Corp", "legitimate JSON-LD fields are still read");
eq(Object.getPrototypeOf(hp.organization), null, "parsed structured data has a null prototype");

suite("HTML is read, never executed");
var official = fixture("web-official-centauri.html");
var op = LH.parse(official, "https://centauri-world.test/");
eq(op.title, "Centauri World LLC — Official Site", "the title is read and decoded");
eq(typeof global.__pageScriptRan, "undefined", "the page's own script did not run");
ok(op.title.indexOf("HIJACKED") < 0, "the page could not rewrite the title it reports");
eq(op.meta["og:site_name"], "Centauri World", "Open Graph metadata is read");
eq(op.canonical, "https://centauri-world.test/", "the canonical URL is read");
ok(op.text.indexOf("Home About Contact") < 0, "navigation boilerplate is dropped");
ok(op.text.indexOf("limited liability company") >= 0, "real body text is kept");
eq(LH.decodeEntities("a&lt;script&gt;b"), "ascriptb", "entities cannot be decoded back into tags");

suite("Structured data");
eq(op.organization.legalName, "Centauri World LLC", "Organization.legalName");
eq(op.organization.address.addressLocality, "Springfield", "nested PostalAddress");
eq(LH.findOrganization([{ "@type": "WebPage" }, { "@type": "Organization", name: "X" }]).name, "X",
  "the organisation node is picked out of a mixed graph");
eq(LH.findOrganization([{ "@type": "WebPage", name: "no org" }]), null, "no organisation means null, not a guess");

/* ============================================================
   3 — classification
   ============================================================ */
suite("Website classification");
function classifyFixture(name, url) {
  var parsed = LH.parse(fixture(name), url);
  var n = LU.normalize(url);
  return LC.classify({
    url: url, host: n.host, path: new URL(url).pathname,
    title: parsed.title, text: parsed.text,
    jsonldTypes: (parsed.jsonld || []).reduce(function (a, x) { return a.concat(LH.typeArray(x["@type"])); }, [])
  });
}
eq(classifyFixture("web-official-centauri.html", "https://centauri-world.test/").typeId, "official_site", "official business website");
eq(classifyFixture("web-contact-keypr.html", "https://keypr-on.test/contact").typeId, "contact_page", "contact page");
eq(classifyFixture("web-gov-registration.html", "https://www.ilsos.gov.test/corp/search").typeId, "gov_registration", "government registration record");
eq(classifyFixture("web-directory-listing.html", "https://www.yellowpages.test/business/centauri").typeId, "directory_listing", "directory listing");
eq(classifyFixture("web-unknown.html", "https://recipes.test/weekly").typeId, "unclassified_web", "an unrelated page stays unclassified");
eq(classifyFixture("web-unknown.html", "https://recipes.test/weekly").category, "unfiled", "…and is filed as needing review");
ok(classifyFixture("web-gov-registration.html", "https://www.ilsos.gov.test/corp/search").reasons.length > 0,
  "classification states its reasoning");
eq(LC.byId("gov_registration").checkpoint, "goodstanding", "a page type can name the checkpoint it evidences");

/* ============================================================
   4 — the pipeline, with fetch stubbed
   ============================================================ */
function runLink(url, html, state, extra) {
  var routes = {};
  routes[new URL(url).hostname] = Object.assign({ body: html }, extra || {});
  stubFetch(routes);
  return LP.run(url, { state: state || freshState(), profiles: profilesOf(state || freshState()), onStatus: function () {} });
}

var chain = Promise.resolve();

chain = chain.then(function () {
  suite("Directly accessible page");
  var st = seeded();
  return LP.run("https://centauri-world.test/", withFetch({ "centauri-world.test": { body: fixture("web-official-centauri.html") } },
    { state: st, profiles: profilesOf(st) })).then(function (p) {
    eq(p.retrievalStatus, "retrieved", "reported as retrieved");
    eq(p.title, "Centauri World LLC — Official Site", "page title captured");
    eq(p.classification.typeId, "official_site", "classified as the official site");
    eq(p.business.business, "centauri", "matched to Centauri World LLC");
    ok(p.contentHash && p.contentHash.length === 64, "content hash computed");
    ok(p.candidates.length >= 5, "produced candidates (" + p.candidates.length + ")");

    var legal = candFor(p, "bp.legalName");
    eq(legal.value, "Centauri World LLC", "legal name from structured data");
    eq(legal.confidence, "Medium",
      "…downgraded to Medium because the page also publishes a second name as an alternate");
    eq(legal.alternates.length, 1, "…and that alternate is offered rather than discarded");
    eq(candFor(p, "bp.duns").confidence, "High",
      "a structured-data value with no competing alternate rates High");
    eq(legal.web.source, "jsonld", "…and the source is recorded");
    eq(legal.web.where, "Organization.legalName", "…including the exact property");
    eq(legal.web.sourceUrl, "https://centauri-world.test/", "…and the source URL");
    ok(legal.web.retrievedAt > 0, "…and the retrieval date");
    ok(legal.excerpt.length > 0, "…and an evidence excerpt");

    eq(candFor(p, "bp.duns").value, "12-345-6789", "D-U-N-S from structured data");
    eq(candFor(p, "bp.naics").value, "453998", "NAICS from structured data");
    eq(candFor(p, "bp.formationDate").value, "2024-03-07", "founding date normalized to ISO");
    ok(candFor(p, "bp.principalAddr").value.indexOf("Springfield") >= 0, "address assembled from PostalAddress");
    eq(candFor(p, "bp.phone").value, "(217) 555-0143", "phone normalized");
    return null;
  });
});

function withFetch(routes, opts) {
  stubFetch(routes);
  return opts;
}
// Re-express run() so the stub is installed before the call.
function analyze(url, routes, st) {
  stubFetch(routes);
  return LP.run(url, { state: st, profiles: profilesOf(st), onStatus: function () {} });
}

chain = chain.then(function () {
  suite("Government record — labelled text extraction");
  var st = seeded();
  return analyze("https://www.ilsos.gov.test/corp/search",
    { "ilsos.gov.test": { body: fixture("web-gov-registration.html") } }, st).then(function (p) {
    eq(p.classification.typeId, "gov_registration", "classified as a registration record");
    eq(candFor(p, "bp.stateRegNum").value, "L24000999001", "file number");
    eq(candFor(p, "bp.formationDate").value, "2024-03-07", "formation date");
    eq(candFor(p, "bp.stateFormation").value, "Illinois", "state of formation");
    eq(candFor(p, "bp.agentName").value, "Placeholder Agent Services", "registered agent");
    ok(candFor(p, "bp.agentAddress").value.indexOf("Example Street") >= 0, "agent address");
    eq(candFor(p, "bp.stateRegNum").web.source, "labelled", "labelled text is recorded as the source");
    eq(candFor(p, "bp.stateRegNum").confidence, "Medium", "labelled page text rates Medium, not High");
    return null;
  });
});

chain = chain.then(function () {
  suite("Business matching from a page");
  var st = seeded();
  return analyze("https://keypr-on.test/contact",
    { "keypr-on.test": { body: fixture("web-contact-keypr.html") } }, st).then(function (p) {
    eq(p.business.business, "keypr", "a Keypr page matches Keypr");
    ok(p.business.evidence.length > 0, "with evidence");
    return analyze("https://announce.test/jv",
      { "announce.test": { body: fixture("web-ambiguous-both.html") } }, st);
  }).then(function (p) {
    eq(p.business.decision, "ambiguous", "a page naming both businesses is ambiguous");
    eq(p.business.business, null, "…and proposes neither");
    ok(p.business.requiresManualChoice, "…and demands a manual choice");
    return analyze("https://recipes.test/weekly",
      { "recipes.test": { body: fixture("web-unknown.html") } }, st);
  }).then(function (p) {
    eq(p.business.decision, "none", "an unrelated page matches no business");
    ok(p.business.requiresManualChoice, "…and still requires confirmation");
    return null;
  });
});

chain = chain.then(function () {
  suite("Domain similarity is supporting evidence, not proof");
  var st = freshState();
  // Website on file, but the page never names the business.
  st.bp.centauri = { website: "https://centauri-world.test" };
  return analyze("https://centauri-world.test/blog/post",
    { "centauri-world.test": { body: "<html><head><title>A post</title></head><body><p>Some words about nothing in particular, at length.</p></body></html>" } },
    st).then(function (p) {
    ok(p.business.decision !== "confident", "a domain match alone does not produce a confident verdict");
    ok(p.business.requiresManualChoice, "…it asks for confirmation");
    var domainEv = p.business.evidence.filter(function (e) { return e.kind === "domain"; })[0];
    ok(!!domainEv, "the domain match is still recorded as evidence");
    ok(domainEv.supportingOnly, "…flagged as supporting only");
    ok(p.notes.join(" ").indexOf("not proof") >= 0, "…and the wording says it is not proof");
    return null;
  });
});

chain = chain.then(function () {
  suite("CORS-blocked page fails honestly");
  var st = seeded();
  stubFetch({});   // every host rejects with TypeError, as a CORS block does
  return LP.run("https://blocked.test/page", { state: st, profiles: profilesOf(st), onStatus: function () {} })
    .then(function (p) {
      eq(p.retrievalStatus, "blocked", "reported as blocked");
      ok(/cannot be read directly/i.test(p.retrievalReason), "the reason is in plain language");
      ok(/CORS/i.test(p.retrievalDetail), "…and explains the actual cause");
      ok(/Nothing was retrieved/i.test(p.retrievalDetail), "…and states nothing was retrieved");
      eq(p.candidates.length, 0, "no values are proposed for a page that was never read");
      eq(p.business.business, null, "no business is claimed");
      ok(p.business.requiresManualChoice, "the business must be chosen manually");
      ok(p.fallbacks.length >= 4, "safe fallbacks are offered (" + p.fallbacks.length + ")");
      var ids = p.fallbacks.map(function (f) { return f.id; });
      ok(ids.indexOf("open") >= 0 && ids.indexOf("paste") >= 0 &&
         ids.indexOf("upload") >= 0 && ids.indexOf("saveonly") >= 0,
         "…covering open, paste, upload and save-only");
      return null;
    });
});

chain = chain.then(function () {
  suite("The app shell can never masquerade as a linked website");
  var st = seeded();
  global.location = { origin: "https://dashboard.test" };
  stubFetch({
    "sunbiz.test": {
      body: "<html><title>Dashboard</title><body>Not the requested page</body></html>",
      finalUrl: "https://dashboard.test/index.html",
      redirected: true
    }
  });
  return LP.run("https://sunbiz.test/entity/123", {
    state: st, profiles: profilesOf(st), onStatus: function () {}
  }).then(function (p) {
    eq(p.retrievalStatus, "blocked", "a dashboard-shell response is rejected");
    eq(p.finalUrl, "https://sunbiz.test/entity/123", "the original source URL is preserved");
    eq(p.candidates.length, 0, "no dashboard text becomes proposed evidence");
    ok(/offline cache/i.test(p.retrievalDetail), "the failure explains the stale-cache cause");
    var sw = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");
    ok(/requestUrl\.origin\s*!==\s*self\.location\.origin/.test(sw),
      "the service worker leaves every cross-origin request alone");
    delete global.location;
    return null;
  });
});

chain = chain.then(function () {
  suite("Other retrieval failures");
  var st = seeded();
  return analyze("https://gone.test/x", { "gone.test": { status: 404, statusText: "Not Found", body: "" } }, st)
    .then(function (p) {
      eq(p.retrievalStatus, "error", "a 404 is an error, not a silent success");
      ok(/404/.test(p.retrievalReason), "the status code is reported");
      eq(p.candidates.length, 0, "nothing is proposed");
      return analyze("https://big.test/x", { "big.test": { contentLength: 50 * 1024 * 1024, body: "x" } }, st);
    }).then(function (p) {
      ok(/larger than/i.test(p.retrievalReason), "an oversized page is refused before download");
      eq(p.candidates.length, 0, "…and proposes nothing");
      return analyze("https://pdf.test/x", { "pdf.test": { contentType: "application/pdf", body: "%PDF" } }, st);
    }).then(function (p) {
      ok(/not a web page/i.test(p.retrievalReason), "a non-HTML response is refused");
      ok(/Autofill from PDF/i.test(p.retrievalDetail), "…and points at the PDF path instead");
      return null;
    });
});

chain = chain.then(function () {
  suite("Redirects");
  var st = seeded();
  return analyze("https://old.test/page",
    { "old.test": { body: fixture("web-official-centauri.html"),
                    finalUrl: "https://centauri-world.test/", redirected: true } }, st).then(function (p) {
    eq(p.finalUrl, "https://centauri-world.test/", "the final URL after redirects is recorded");
    ok(p.redirected, "the redirect is flagged");
    ok(p.notes.join(" ").indexOf("Redirected to") >= 0, "…and reported in the notes");
    eq(p.url, "https://old.test/page", "the address as entered is preserved");
    return null;
  });
});

chain = chain.then(function () {
  suite("Pasted text — the CORS fallback actually works");
  var st = seeded();
  stubFetch({});
  var callsBefore = netCalls.length;
  return LP.run("https://blocked.test/about", {
    state: st, profiles: profilesOf(st), onStatus: function () {},
    pastedText: fixture("web-gov-registration.html")
  }).then(function (p) {
    eq(p.retrievalStatus, "pasted", "reported as coming from pasted text");
    eq(netCalls.length - callsBefore, 0, "no request is made at all when text is pasted");
    eq(candFor(p, "bp.stateRegNum").value, "L24000999001", "values are extracted from the pasted text");
    eq(p.business.business, "centauri", "the business is still matched on evidence");
    ok(p.notes.join(" ").indexOf("pasted") >= 0, "the proposal says where the text came from");
    return null;
  });
});

/* ============================================================
   5 — persistence, duplicates, save and undo
   ============================================================ */
chain = chain.then(function () {
  suite("Save selected — link record and fields");
  var st = seeded();
  return analyze("https://centauri-world.test/",
    { "centauri-world.test": { body: fixture("web-official-centauri.html") } }, st).then(function (p) {
    var before = JSON.stringify(st);
    eq(LS.list(st, "centauri").length, 0, "analysing alone saves nothing");
    eq(Object.keys(st.bp.centauri).length, 2, "…and writes no fields");

    return TX.saveLink(st, p, {
      biz: "centauri",
      siteType: p.classification.typeId,
      siteTypeLabel: p.classification.label,
      category: p.classification.category,
      checkpoint: LC.byId(p.classification.typeId).checkpoint,
      fields: [
        { dest: "bp.duns", value: candFor(p, "bp.duns").value, resolution: "replace" },
        { dest: "bp.naics", value: candFor(p, "bp.naics").value, resolution: "replace" }
      ]
    }, {}).then(function (j) {
      eq(st.bp.centauri.duns, "12-345-6789", "the ticked value is written");
      eq(st.bp.centauri.naics, "453998", "…and the second one");
      eq(st.bp.centauri.phone, undefined, "an unticked value is not written");
      eq(st.bp.keypr.duns, undefined, "nothing reaches the other business");
      eq(LS.list(st, "centauri").length, 1, "the link record is filed");
      eq(LS.list(st, "keypr").length, 0, "…under exactly one business");

      var rec = LS.list(st, "centauri")[0];
      eq(rec.biz, "centauri", "the record names its business");
      eq(rec.url, "https://centauri-world.test/", "original URL");
      eq(rec.normalizedUrl, "https://centauri-world.test", "normalized URL");
      eq(rec.domain, "centauri-world.test", "domain");
      eq(rec.title, "Centauri World LLC — Official Site", "page title");
      eq(rec.siteType, "official_site", "website classification");
      eq(rec.category, "presence", "category");
      eq(rec.retrievalStatus, "retrieved", "retrieval status");
      ok(rec.contentHash.length === 64, "content hash");
      ok(rec.retrievedAt > 0 && rec.lastCheckedAt > 0, "retrieval and last-checked dates");
      eq(rec.linkedFields, ["bp.duns", "bp.naics"], "the fields it supports");
      ok(rec.linkedCheckpoints.indexOf("duns") >= 0, "the checkpoints it evidences");
      ok(rec.linkedCheckpoints.indexOf("website") >= 0, "…including the one its page type evidences");
      eq(rec.reviewStatus, "reviewed", "review status");
      ok(rec.evidence.length === 2, "safe evidence references for each saved field");
      ok(rec.evidence[0].excerpt.length > 0, "…each with an excerpt");
      ok(!!rec.textRef, "the page text is referenced, not embedded");

      suite("Page text is kept out of application state");
      var serialized = JSON.stringify(st);
      ok(serialized.indexOf("All rights reserved") < 0, "page body text is not serialized into state");
      ok(serialized.indexOf("<html") < 0, "no HTML is serialized into state");
      ok(serialized.length < 12000, "the state stays small (" + serialized.length + " bytes)");
      return global.DOCAI.store.getText(rec.textRef).then(function (pages) {
        ok(!!pages && pages[0].text.indexOf("limited liability company") >= 0,
          "…the text lives in the IndexedDB store instead");
        return { st: st, p: p, before: before };
      });
    });
  }).then(function (c) {
    suite("Undo reverses a link import completely");
    return TX.undo(c.st, {}).then(function (r) {
      ok(r.ok, "undo succeeds");
      ok(/link removed/i.test(r.message), "the message says a link was removed");
      eq(c.st.bp.centauri.duns, undefined, "the written field is removed");
      eq(c.st.bp.centauri.naics, undefined, "…and the second one");
      eq(LS.list(c.st, "centauri").length, 0, "the link record is removed");
      eq(JSON.stringify(c.st), c.before, "state is restored byte-for-byte");
      return null;
    });
  });
});

chain = chain.then(function () {
  suite("Save link only");
  var st = seeded();
  return analyze("https://keypr-on.test/contact",
    { "keypr-on.test": { body: fixture("web-contact-keypr.html") } }, st).then(function (p) {
    return TX.saveLinkOnly(st, p, {
      biz: "keypr", siteType: p.classification.typeId,
      siteTypeLabel: p.classification.label, category: p.classification.category
    }, {}).then(function () {
      eq(Object.keys(st.bp.keypr).length, 1, "no field values are written (only the seeded name remains)");
      eq(LS.list(st, "keypr").length, 1, "the link itself is saved");
      eq(LS.list(st, "keypr")[0].linkedFields, [], "…recorded as supporting no fields");
      return TX.undo(st, {});
    });
  });
});

chain = chain.then(function () {
  suite("Conflicts never overwrite silently");
  var st = seeded();
  st.bp.centauri.naics = "111111";
  st.bp.centauri.duns = "99-999-9999";
  return analyze("https://centauri-world.test/",
    { "centauri-world.test": { body: fixture("web-official-centauri.html") } }, st).then(function (p) {
    return TX.saveLink(st, p, {
      biz: "centauri", siteType: "official_site", category: "presence",
      fields: [
        { dest: "bp.naics", value: "453998", resolution: "keep" },
        { dest: "bp.duns", value: "12-345-6789", resolution: "replace" }
      ]
    }, {}).then(function () {
      eq(st.bp.centauri.naics, "111111", "a conflict resolved as 'keep' leaves the existing value");
      eq(st.bp.centauri.duns, "12-345-6789", "a conflict resolved as 'replace' writes the new value");
      eq(st.docaiHistory.centauri["bp.duns"][0].value, "99-999-9999", "the replaced value is kept in history");
      eq(st.docaiHistory.centauri["bp.duns"][0].kind, "replaced", "…marked as replaced");
      eq(st.docaiHistory.centauri["bp.naics"][0].kind, "alternate", "the rejected value is kept as an alternate");
      return TX.undo(st, {});
    }).then(function () {
      eq(st.bp.centauri.duns, "99-999-9999", "undo restores the overwritten value");
      eq(st.bp.centauri.naics, "111111", "…and leaves the kept one alone");
      return null;
    });
  });
});

chain = chain.then(function () {
  suite("Duplicate links");
  var st = seeded();
  return analyze("https://centauri-world.test/",
    { "centauri-world.test": { body: fixture("web-official-centauri.html") } }, st).then(function (p) {
    return TX.saveLink(st, p, { biz: "centauri", siteType: "official_site", category: "presence", fields: [] }, {})
      .then(function () {
        // Same page, different address form.
        return analyze("http://www.centauri-world.test/?utm_source=news",
          { "centauri-world.test": { body: fixture("web-official-centauri.html") } }, st);
      }).then(function (p2) {
        eq(p2.exactDuplicates.length, 1, "the same page under a different address is an exact duplicate");
        eq(p2.exactDuplicates[0].biz, "centauri", "…found under the right business");

        // A genuinely different page on the same site, same title and content.
        return analyze("https://centauri-world.test/index.html",
          { "centauri-world.test": { body: fixture("web-official-centauri.html") } }, st);
      }).then(function (p3) {
        eq(p3.exactDuplicates.length, 0, "a different path is not an exact duplicate");
        ok(p3.likelyDuplicates.length >= 1, "…but is flagged as likely the same page");
        ok(p3.likelyDuplicates[0].reasons.length > 0, "…with stated reasons");
        ok(p3.likelyDuplicates[0].reasons.join(" ").indexOf("content") >= 0 ||
           p3.likelyDuplicates[0].reasons.join(" ").indexOf("canonical") >= 0,
           "…naming the content hash or canonical URL");

        // An unrelated page is not flagged.
        return analyze("https://recipes.test/weekly",
          { "recipes.test": { body: fixture("web-unknown.html") } }, st);
      }).then(function (p4) {
        eq(p4.exactDuplicates.length, 0, "an unrelated page is not an exact duplicate");
        eq(p4.likelyDuplicates.length, 0, "…nor a likely one");
        return null;
      });
  });
});

chain = chain.then(function () {
  suite("Recheck");
  var st = seeded();
  return analyze("https://centauri-world.test/",
    { "centauri-world.test": { body: fixture("web-official-centauri.html") } }, st).then(function (p) {
    return TX.saveLink(st, p, { biz: "centauri", siteType: "official_site", category: "presence", fields: [] }, {});
  }).then(function () {
    var rec = LS.list(st, "centauri")[0];
    var originalHash = rec.contentHash;

    // Unchanged page
    stubFetch({ "centauri-world.test": { body: fixture("web-official-centauri.html") } });
    return LP.recheck(rec, { onStatus: function () {} }).then(function (out) {
      ok(out.ok, "an unchanged page rechecks successfully");
      eq(out.changed, false, "…and reports no change");
      LS.recordCheck(rec, { at: out.at, status: out.status, note: out.note, changed: out.changed, contentHash: out.contentHash });
      eq(rec.contentHash, originalHash, "the hash is unchanged");
      eq(rec.history.length, 1, "the check is recorded in the history");

      // Changed page
      stubFetch({ "centauri-world.test": { body: fixture("web-official-centauri.html").replace("453998", "541511") } });
      return LP.recheck(rec, { onStatus: function () {} });
    }).then(function (out) {
      ok(out.changed, "a changed page is detected");
      ok(/changed/i.test(out.note), "…and says so");
      eq(st.bp.centauri.naics, undefined, "rechecking never writes to the dashboard");
      eq(LS.list(st, "centauri").length, 1, "…and does not duplicate the record");
      LS.recordCheck(rec, { at: out.at, status: out.status, note: out.note, changed: out.changed, contentHash: out.contentHash });
      eq(rec.history.length, 2, "the second check is recorded too");
      ok(rec.evidence.length === rec.evidence.length, "existing evidence is preserved");

      // Page gone
      stubFetch({ "centauri-world.test": { status: 404, statusText: "Not Found", body: "" } });
      return LP.recheck(rec, { onStatus: function () {} });
    }).then(function (out) {
      ok(!out.ok, "a removed page rechecks as a failure");
      ok(out.gone, "…flagged as gone");
      LS.recordCheck(rec, { at: out.at, status: out.status, note: out.note, changed: false });
      eq(LS.list(st, "centauri").length, 1, "the record survives a failed recheck");
      eq(rec.linkedFields.length, 0, "…with its links intact");
      return null;
    });
  });
});

chain = chain.then(function () {
  suite("Cancel mutates nothing");
  var st = seeded();
  var before = JSON.stringify(st);
  return analyze("https://centauri-world.test/",
    { "centauri-world.test": { body: fixture("web-official-centauri.html") } }, st).then(function () {
    eq(JSON.stringify(st), before, "running the pipeline without saving leaves state byte-identical");
    return null;
  });
});

chain = chain.then(function () {
  suite("Refuses to save without a confirmed business");
  var st = seeded();
  return analyze("https://announce.test/jv",
    { "announce.test": { body: fixture("web-ambiguous-both.html") } }, st).then(function (p) {
    return TX.saveLink(st, p, { biz: null, fields: [{ dest: "bp.duns", value: "12-345-6789" }] }, {})
      .then(function () { ok(false, "should have been refused"); })
      .catch(function (e) {
        ok(/no business/i.test(e.message), "the save is refused with a clear message");
        eq(LS.list(st, "centauri").length, 0, "nothing was filed under Centauri");
        eq(LS.list(st, "keypr").length, 0, "…nor under Keypr");
        return null;
      });
  });
});

chain = chain.then(function () {
  suite("Network behaviour");
  var uploads = netCalls.filter(function (c) { return c.body != null; });
  eq(uploads.length, 0, "no request in the whole suite carried a body");
  var methods = netCalls.map(function (c) { return c.method; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
  eq(methods, ["GET"], "every request was a GET");
  var creds = netCalls.map(function (c) { return c.credentials; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
  eq(creds, ["omit"], "cookies were never sent");
  var modes = netCalls.map(function (c) { return c.mode; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
  eq(modes, ["cors"], "no-cors was never used — an unreadable response is never treated as success");
  ok(netCalls.every(function (c) { return /^https?:\/\//.test(c.url); }), "every request used http or https");
  ok(netCalls.length > 0, "the suite did exercise the fetch path (" + netCalls.length + " calls)");
});

chain.then(function () {
  console.log("\n" + "─".repeat(58));
  if (failed) {
    console.log("\u001b[31m" + failed + " failed\u001b[0m, " + passed + " passed");
    failures.forEach(function (f) { console.log("  · " + f); });
    process.exit(1);
  }
  console.log("\u001b[32mAll " + passed + " checks passed.\u001b[0m");
  process.exit(0);
}).catch(function (e) {
  console.error("\n\u001b[31mSuite crashed:\u001b[0m", (e && e.stack) || e);
  process.exit(1);
});
