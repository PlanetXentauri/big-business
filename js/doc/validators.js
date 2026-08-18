/* ============================================================
   DOCAI · validators — deterministic checks and normalizers.

   Two rules govern everything in this file:
     1. A validator never invents a value. If the input does not clearly
        contain what is claimed, it returns ok:false and the caller drops it.
     2. `raw` is preserved exactly as it appeared in the document; `value`
        is the normalized form. They are always kept side by side.

   Every result has the shape:
     { ok, raw, value, warnings[], errors[], meta{} }
   ============================================================ */
(function (root) {
  "use strict";

  var U = (root.DOCAI && root.DOCAI.util) ||
    (typeof require === "function" ? require("./util.js") : null);

  var V = {};

  function res(raw, value, errors, warnings, meta) {
    return {
      ok: !errors || !errors.length,
      raw: raw == null ? "" : String(raw),
      value: value == null ? "" : String(value),
      errors: errors || [],
      warnings: warnings || [],
      meta: meta || {}
    };
  }

  /* ---------- EIN ----------
     Nine digits, formatted NN-NNNNNNN. The IRS publishes valid campus
     prefixes; an unknown prefix is a warning, not a rejection, because the
     list changes over time and rejecting would lose real data. */
  var EIN_PREFIXES = [
    "01","02","03","04","05","06","10","11","12","13","14","15","16","20","21","22","23","24","25","26","27",
    "30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","50","51",
    "52","53","54","55","56","57","58","59","60","61","62","63","64","65","66","67","68","71","72","73","74",
    "75","76","77","80","81","82","83","84","85","86","87","88","90","91","92","93","94","95","98","99"
  ];
  V.ein = function (raw) {
    var d = U.digits(raw);
    if (!d) return res(raw, "", ["No digits found"]);
    if (d.length !== 9) return res(raw, "", ["EIN must be exactly 9 digits — found " + d.length]);
    if (/^(\d)\1{8}$/.test(d)) return res(raw, "", ["All nine digits identical — not a real EIN"]);
    var formatted = d.slice(0, 2) + "-" + d.slice(2);
    var warnings = [];
    if (EIN_PREFIXES.indexOf(d.slice(0, 2)) < 0) {
      warnings.push("Prefix " + d.slice(0, 2) + " is not a currently published IRS campus prefix");
    }
    return res(raw, formatted, [], warnings, { digits: d });
  };

  /* ---------- ABA routing number ----------
     Nine digits with the standard 3-7-1 weighted checksum. This one is a hard
     reject on failure: the checksum is definitive, so a failure means OCR
     misread a digit and the value must not be offered as if it were good. */
  V.routing = function (raw) {
    var d = U.digits(raw);
    if (!d) return res(raw, "", ["No digits found"]);
    if (d.length !== 9) return res(raw, "", ["Routing number must be exactly 9 digits — found " + d.length]);
    var w = [3, 7, 1, 3, 7, 1, 3, 7, 1], sum = 0;
    for (var i = 0; i < 9; i++) sum += parseInt(d[i], 10) * w[i];
    if (sum % 10 !== 0) return res(raw, "", ["Checksum failed — this is not a valid ABA routing number"]);
    var warnings = [];
    var f2 = parseInt(d.slice(0, 2), 10);
    var validRange = (f2 >= 0 && f2 <= 12) || (f2 >= 21 && f2 <= 32) || (f2 >= 61 && f2 <= 72) || f2 === 80;
    if (!validRange) warnings.push("Leading pair " + d.slice(0, 2) + " is outside the assigned Federal Reserve ranges");
    return res(raw, d, [], warnings, { checksum: "passed" });
  };

  /* ---------- account number ----------
     Preserved exactly. No checksum exists, so the only checks are shape
     plausibility. The masked form is carried in meta for display. */
  V.account = function (raw) {
    var s = String(raw == null ? "" : raw).trim();
    var d = U.digits(s);
    if (!d) return res(raw, "", ["No digits found"]);
    if (d.length < 4) return res(raw, "", ["Too short to be an account number"]);
    var warnings = [];
    if (d.length > 17) warnings.push("Longer than 17 digits — unusual for a US account number");
    if (d.length < 6) warnings.push("Only " + d.length + " digits — may be a partial or masked number");
    return res(raw, d, [], warnings, { masked: U.maskAccount(d), last4: d.slice(-4) });
  };

  /* ---------- credit card ----------
     Deliberately lossy. The full PAN is never returned or stored: only the
     issuer and last four survive, and the Luhn check runs on the candidate
     before it is discarded so a misread is not recorded as a real card. */
  V.card = function (raw) {
    var d = U.digits(raw);
    if (d.length < 4) return res(raw, "", ["No card digits found"]);
    var issuer = V.cardIssuer(d);
    if (d.length >= 13 && d.length <= 19) {
      if (!luhn(d)) return res(raw, "", ["Card number failed the Luhn check — likely misread"]);
      // Full number verified, then intentionally dropped.
      return res(maskRaw(raw), (issuer ? issuer + " " : "") + "····" + d.slice(-4), [], [],
        { issuer: issuer, last4: d.slice(-4), fullNumberRetained: false });
    }
    // Already partial (e.g. "ending in 4321") — keep only what was shown.
    return res(raw, (issuer ? issuer + " " : "") + "····" + d.slice(-4), [], [],
      { issuer: issuer, last4: d.slice(-4), fullNumberRetained: false });
  };
  function maskRaw(raw) {
    return String(raw == null ? "" : raw).replace(/\d{5,}/g, function (m) { return "····" + m.slice(-4); });
  }
  function luhn(d) {
    var sum = 0, alt = false;
    for (var i = d.length - 1; i >= 0; i--) {
      var n = parseInt(d[i], 10);
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    return sum % 10 === 0;
  }
  V.cardIssuer = function (raw) {
    var d = U.digits(raw);
    if (/^4/.test(d)) return "VISA";
    if (/^5[1-5]/.test(d) || /^2(2[2-9]|[3-6]\d|7[01]|720)/.test(d)) return "MASTERCARD";
    if (/^3[47]/.test(d)) return "AMEX";
    if (/^6(011|5|4[4-9])/.test(d)) return "DISCOVER";
    if (/^3(0[0-5]|[68])/.test(d)) return "DINERS";
    var t = String(raw == null ? "" : raw).toLowerCase();
    if (/\bvisa\b/.test(t)) return "VISA";
    if (/master\s*card|\bmc\b/.test(t)) return "MASTERCARD";
    if (/\bamex\b|american express/.test(t)) return "AMEX";
    if (/\bdiscover\b/.test(t)) return "DISCOVER";
    return "";
  };

  /* ---------- dates ----------
     Normalized to ISO without ever shifting the intended day. Ambiguous
     numeric dates (both parts <= 12) are flagged rather than guessed, and
     two-digit years are rejected outright when they could mean two centuries. */
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  V.date = function (raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return res(raw, "", ["Empty"]);
    var m, y, mo, d, warnings = [];

    // ISO: 2024-03-07
    m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; return finishDate(raw, y, mo, d, warnings); }

    // Month name: March 7, 2024 / 7 March 2024
    m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i);
    if (m) { mo = MONTHS[m[1].toLowerCase()]; d = +m[2]; y = +m[3]; return finishDate(raw, y, mo, d, warnings); }
    m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/i);
    if (m) { d = +m[1]; mo = MONTHS[m[2].toLowerCase()]; y = +m[3]; return finishDate(raw, y, mo, d, warnings); }

    // Numeric: 03/07/2024. US order assumed, but flagged when genuinely ambiguous.
    m = s.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
    if (m) {
      var a = +m[1], b = +m[2], yr = m[3];
      if (yr.length === 2) {
        return res(raw, "", ["Two-digit year is ambiguous — cannot resolve the century without guessing"]);
      }
      y = +yr;
      if (a > 12 && b <= 12) { mo = b; d = a; warnings.push("Read as day/month/year — first part exceeds 12"); }
      else { mo = a; d = b; if (b <= 12 && a <= 12 && a !== b) warnings.push("Ambiguous: could also be " + b + "/" + a + " in day/month order"); }
      return finishDate(raw, y, mo, d, warnings);
    }
    return res(raw, "", ["No recognisable date pattern"]);
  };
  function finishDate(raw, y, mo, d, warnings) {
    if (!(mo >= 1 && mo <= 12)) return res(raw, "", ["Month " + mo + " is out of range"]);
    if (!(d >= 1 && d <= 31)) return res(raw, "", ["Day " + d + " is out of range"]);
    var dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (d > dim) return res(raw, "", ["Day " + d + " does not exist in month " + mo + " of " + y]);
    if (y < 1900 || y > 2200) return res(raw, "", ["Year " + y + " is implausible"]);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return res(raw, y + "-" + p(mo) + "-" + p(d), [], warnings, { year: y, month: mo, day: d });
  }

  /* ---------- currency ----------
     Sign, magnitude and currency are all preserved. Parentheses and a
     trailing CR both mean negative on financial statements. */
  V.currency = function (raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return res(raw, "", ["Empty"]);
    var negative = /^\(.*\)$/.test(s) || /\bCR\b/i.test(s) || /^-/.test(s) || /-$/.test(s);
    var cur = "USD";
    if (/€|\bEUR\b/i.test(s)) cur = "EUR";
    else if (/£|\bGBP\b/i.test(s)) cur = "GBP";
    else if (/\bCAD\b/i.test(s)) cur = "CAD";
    var m = s.match(/\d[\d,]*(?:\.\d{1,2})?/);
    if (!m) return res(raw, "", ["No numeric amount found"]);
    var n = parseFloat(m[0].replace(/,/g, ""));
    if (!isFinite(n)) return res(raw, "", ["Amount could not be parsed"]);
    if (negative) n = -n;
    var warnings = [];
    if (!/[.,]/.test(m[0]) && Math.abs(n) > 999) warnings.push("No decimal separator — verify the magnitude");
    return res(raw, (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      [], warnings, { amount: n, currency: cur, negative: negative });
  };

  /* ---------- contact fields ---------- */
  V.email = function (raw) {
    var s = String(raw == null ? "" : raw).trim().replace(/^mailto:/i, "");
    var m = s.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
    if (!m) return res(raw, "", ["Not a valid email address"]);
    var v = m[0].toLowerCase();
    var warnings = [];
    var domain = v.split("@")[1];
    if (/^(gmail|yahoo|hotmail|outlook|aol|icloud)\./.test(domain)) {
      warnings.push("Free-provider address — lenders prefer an address on the business domain");
    }
    return res(raw, v, [], warnings, { domain: domain });
  };

  V.phone = function (raw) {
    var d = U.digits(raw);
    if (!d) return res(raw, "", ["No digits found"]);
    if (d.length === 11 && d[0] === "1") d = d.slice(1);
    if (d.length !== 10) return res(raw, "", ["US phone numbers need 10 digits — found " + d.length]);
    if (/^[01]/.test(d)) return res(raw, "", ["Area code cannot begin with 0 or 1"]);
    if (/^\d{3}[01]/.test(d)) return res(raw, "", ["Exchange code cannot begin with 0 or 1"]);
    var warnings = [];
    if (/^555/.test(d.slice(3))) warnings.push("555 exchange is commonly a placeholder");
    return res(raw, "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6), [], warnings, { digits: d });
  };

  V.url = function (raw) {
    var s = String(raw == null ? "" : raw).trim().replace(/[.,;]+$/, "");
    if (!s) return res(raw, "", ["Empty"]);
    if (!/^https?:\/\//i.test(s)) {
      if (!/^[\w\-]+(\.[\w\-]+)+/.test(s)) return res(raw, "", ["Not a recognisable domain or URL"]);
      s = "https://" + s;
    }
    var host;
    try { host = new URL(s).hostname; } catch (e) { return res(raw, "", ["Malformed URL"]); }
    if (!/\.[a-z]{2,}$/i.test(host)) return res(raw, "", ["Missing a valid top-level domain"]);
    return res(raw, s, [], [], { host: host.replace(/^www\./, "") });
  };

  /* ---------- identifiers ---------- */
  V.naics = function (raw) {
    var d = U.digits(raw);
    if (!d) return res(raw, "", ["No digits found"]);
    if (d.length < 2 || d.length > 6) return res(raw, "", ["NAICS codes are 2 to 6 digits — found " + d.length]);
    var warnings = [];
    if (d.length < 6) warnings.push(d.length + "-digit code — this is a sector level, not a full 6-digit industry code");
    var sector = parseInt(d.slice(0, 2), 10);
    var valid = [11, 21, 22, 23, 31, 32, 33, 42, 44, 45, 48, 49, 51, 52, 53, 54, 55, 56, 61, 62, 71, 72, 81, 92];
    if (valid.indexOf(sector) < 0) return res(raw, "", ["Sector " + d.slice(0, 2) + " is not an assigned NAICS sector"]);
    return res(raw, d, [], warnings, { sector: sector });
  };

  V.duns = function (raw) {
    var d = U.digits(raw);
    if (!d) return res(raw, "", ["No digits found"]);
    if (d.length !== 9) return res(raw, "", ["D-U-N-S numbers are 9 digits — found " + d.length]);
    if (/^(\d)\1{8}$/.test(d)) return res(raw, "", ["All nine digits identical — not a real D-U-N-S number"]);
    return res(raw, d.slice(0, 2) + "-" + d.slice(2, 5) + "-" + d.slice(5), [], [], { digits: d });
  };

  /* ---------- SSN / ITIN ----------
     Accepted only in the strict NNN-NN-NNNN shape with a valid area group.
     A bare nine-digit run is refused: too many other things are nine digits,
     and mistaking one for an SSN would be a serious error. */
  V.ssn = function (raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!/\b\d{3}-\d{2}-\d{4}\b/.test(s)) {
      return res(raw, "", ["Not in the NNN-NN-NNNN form — refused rather than guessed at"]);
    }
    var d = U.digits(s);
    var area = d.slice(0, 3), group = d.slice(3, 5), serial = d.slice(5);
    if (area === "000" || area === "666" || area[0] === "9") return res(raw, "", ["Area number " + area + " is never issued"]);
    if (group === "00") return res(raw, "", ["Group number cannot be 00"]);
    if (serial === "0000") return res(raw, "", ["Serial number cannot be 0000"]);
    return res(raw, area + "-" + group + "-" + serial, [], [], { masked: U.maskSsn(d) });
  };

  V.stateRegNum = function (raw) {
    var s = String(raw == null ? "" : raw).trim().replace(/[.,;]+$/, "");
    if (!s) return res(raw, "", ["Empty"]);
    if (!/\d/.test(s)) return res(raw, "", ["No digits — state filing numbers always contain digits"]);
    if (s.length < 4 || s.length > 20) return res(raw, "", ["Length " + s.length + " is outside the plausible range"]);
    return res(raw, s.toUpperCase(), [], []);
  };

  /* ---------- credit scores ----------
     Each score type has its own published range. A value outside the range
     for the named type is rejected, not clamped. */
  V.SCORE_RANGES = {
    paydex: { min: 1, max: 100, label: "D&B PAYDEX" },
    intelliscore: { min: 1, max: 100, label: "Experian Intelliscore Plus" },
    equifax: { min: 101, max: 992, label: "Equifax Business Credit Risk" },
    fico: { min: 0, max: 300, label: "FICO SBSS" }
  };
  V.score = function (raw, type) {
    var range = V.SCORE_RANGES[type];
    if (!range) return res(raw, "", ["Unknown score type: " + type]);
    var d = U.digits(raw);
    if (!d) return res(raw, "", ["No digits found"]);
    var n = parseInt(d, 10);
    if (n < range.min || n > range.max) {
      return res(raw, "", [range.label + " must be between " + range.min + " and " + range.max + " — found " + n]);
    }
    return res(raw, String(n), [], [], { score: n, scoreType: type, range: range.min + "–" + range.max });
  };

  /* ---------- names and addresses ----------
     Both keep the original text and add a folded comparison form so the
     business matcher can compare without the display value ever changing. */
  V.legalName = function (raw) {
    var s = String(raw == null ? "" : raw).trim().replace(/\s+/g, " ");
    if (s.length < 3) return res(raw, "", ["Too short to be a business name"]);
    if (s.length > 120) return res(raw, "", ["Too long to be a business name"]);
    if (!/[A-Za-z]/.test(s)) return res(raw, "", ["No letters found"]);
    return res(raw, s, [], [], { fold: U.foldName(s) });
  };

  V.address = function (raw) {
    var s = String(raw == null ? "" : raw).trim().replace(/\s+/g, " ");
    if (s.length < 8) return res(raw, "", ["Too short to be an address"]);
    if (!/\d/.test(s)) return res(raw, "", ["No street number or ZIP found"]);
    var warnings = [];
    var hasZip = /\b\d{5}(-\d{4})?\b/.test(s);
    if (!hasZip) warnings.push("No ZIP code — the address may be incomplete");
    if (/\bp\.?\s*o\.?\s*box\b/i.test(s)) warnings.push("PO Box — lenders and D&B usually require a physical address");
    return res(raw, s, [], warnings, { fold: U.foldAddress(s), hasZip: hasZip });
  };

  V.STATES = [
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware",
    "district of columbia", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
    "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota",
    "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
    "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
    "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah",
    "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming"
  ];
  V.state = function (raw) {
    var s = String(raw == null ? "" : raw).trim();
    var low = s.toLowerCase().replace(/\s+/g, " ");
    if (V.STATES.indexOf(low) < 0) return res(raw, "", ["Not a recognised US state name"]);
    return res(raw, low.replace(/\b\w/g, function (c) { return c.toUpperCase(); }), [], []);
  };

  /* ---------- dispatch ----------
     A single entry point so extractors never hand-pick a validator. */
  V.BY_KIND = {
    ein: V.ein, routing: V.routing, account: V.account, card: V.card, ssn: V.ssn,
    date: V.date, currency: V.currency, email: V.email, phone: V.phone,
    url: V.url, naics: V.naics, duns: V.duns, stateRegNum: V.stateRegNum,
    legalName: V.legalName, address: V.address, state: V.state
  };
  V.run = function (kind, raw, opt) {
    if (kind === "score") return V.score(raw, opt);
    var fn = V.BY_KIND[kind];
    if (!fn) return res(raw, String(raw == null ? "" : raw).trim(), [], []); // free text passes through unchanged
    return fn(raw);
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.validators = V;
  if (typeof module !== "undefined" && module.exports) module.exports = V;
})(typeof globalThis !== "undefined" ? globalThis : this);
