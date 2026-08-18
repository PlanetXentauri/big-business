/* ============================================================
   DOCAI · link-classifier — what kind of page is this?

   Same discipline as the document classifier: a type wins only when it
   clears a minimum score and beats the runner-up. Otherwise the page is
   "Unclassified / Needs Review" rather than forced into a bucket.

   Signals can come from the host, the path, the page title, the JSON-LD
   @type, or the visible text. Host and path are the strongest, because a
   government registry lives at a predictable address in a way that page
   wording never matches.

   To add a type, append to TYPES. Nothing else needs changing.
   ============================================================ */
(function (root) {
  "use strict";

  var U = (root.DOCAI && root.DOCAI.util) ||
    (typeof require === "function" ? require("./util.js") : null);

  var C = {};

  /* host    — matched against the hostname          (50 pts)
     path    — matched against pathname + search      (30 pts)
     jsonld  — matched against JSON-LD @type values   (40 pts)
     title   — matched against <title>                (25 pts)
     text    — matched against visible text           (12 pts)
     negative— argues against this type              (-35 pts)
     category / checkpoint — where a saved link is filed and what it evidences */
  C.TYPES = [
    {
      id: "official_site",
      label: "Official Business Website",
      category: "presence",
      checkpoint: "website",
      jsonld: [/^Organization$/, /^Corporation$/, /^LocalBusiness$/, /Business$/, /^Store$/],
      text: [/all rights reserved/i, /©\s*\d{4}/, /privacy policy/i, /terms of (service|use)/i],
      title: [/home|official (site|website)/i]
    },
    {
      id: "contact_page",
      label: "Contact Page",
      category: "presence",
      checkpoint: "nap",
      path: [/\/contact(-us)?\b/i, /\/get-in-touch\b/i, /\/reach-us\b/i],
      title: [/contact/i],
      text: [/contact (us|our team)/i, /send us a message/i, /business hours/i],
      jsonld: [/^ContactPage$/]
    },
    {
      id: "about_page",
      label: "About Page",
      category: "presence",
      path: [/\/about(-us)?\b/i, /\/our-(story|company)\b/i, /\/who-we-are\b/i],
      title: [/about/i],
      text: [/our (story|mission|history)/i, /founded in \d{4}/i, /we were established/i],
      jsonld: [/^AboutPage$/],
      negative: [/\/contact\b/i]
    },
    {
      id: "directory_listing",
      label: "Directory / 411 Listing",
      category: "presence",
      checkpoint: "b411",
      host: [/yellowpages\./i, /whitepages\./i, /listyourself\./i, /manta\.com/i, /bbb\.org/i,
        /yelp\./i, /superpages\./i, /citysearch\./i, /foursquare\./i, /hotfrog\./i, /brownbook\./i],
      path: [/\/(business|listing|directory)\//i],
      text: [/business listing/i, /claim this (business|listing)/i, /directory assistance/i]
    },
    {
      id: "google_business",
      label: "Google Business Profile / Map Listing",
      category: "presence",
      checkpoint: "gbp",
      host: [/google\.[a-z.]+$/i, /maps\.app\.goo\.gl/i, /goo\.gl/i, /business\.google\./i],
      path: [/\/maps\//i, /\/place\//i, /\/localservices\//i],
      text: [/google business profile/i, /reviews on google/i]
    },
    {
      id: "gov_registration",
      label: "State / Government Registration Record",
      category: "formation",
      checkpoint: "goodstanding",
      host: [/\.gov$/i, /\.gov\./i, /\.state\.[a-z]{2}\.us$/i, /sos\.[a-z]+/i, /secretaryofstate/i,
        /sunbiz\.org/i, /opencorporates\.com/i],
      path: [/corp|entity|business.?search|filing|registrat/i],
      text: [/secretary of state/i, /entity (number|name|status)/i, /registered agent/i,
        /date of (formation|incorporation)/i, /good standing/i, /file number/i]
    },
    {
      id: "license_lookup",
      label: "License / Permit Lookup",
      category: "licenses",
      checkpoint: "license",
      host: [/\.gov$/i, /\.gov\./i, /license/i, /dbpr/i, /idfpr/i],
      path: [/licen[cs]e|permit|credential|verif/i],
      text: [/license (number|status|type)/i, /permit number/i, /expiration date/i, /licensee/i],
      negative: [/sales tax/i]
    },
    {
      id: "sales_tax_registration",
      label: "Sales Tax / Resale Registration",
      category: "tax",
      checkpoint: "salestax",
      host: [/revenue\./i, /tax\./i, /\.gov$/i],
      path: [/sales.?tax|resale|seller.?permit|use.?tax/i],
      text: [/sales and use tax/i, /resale certificate/i, /seller'?s permit/i, /certificate of registration/i]
    },
    {
      id: "insurance_verification",
      label: "Insurance Verification Page",
      category: "insurance",
      checkpoint: "insurance",
      host: [/insur/i],
      path: [/insur|coverage|policy|certificate/i],
      text: [/certificate of insurance/i, /general liability/i, /policy number/i, /coverage (period|limits)/i,
        /effective date/i]
    },
    {
      id: "credit_profile",
      label: "D&B / Business-Credit Profile",
      category: "credit",
      checkpoint: "duns",
      host: [/dnb\.com/i, /dandb\.com/i, /experian\./i, /equifax\./i, /creditsafe\./i, /nav\.com/i],
      path: [/business.?(credit|directory|profile)|duns/i],
      text: [/d-u-n-s/i, /paydex/i, /intelliscore/i, /business credit (file|report|score)/i]
    },
    {
      id: "trademark_record",
      label: "Trademark Record",
      category: "ip",
      checkpoint: "trademark",
      host: [/uspto\.gov/i, /tsdr\./i, /trademarks?\./i, /wipo\.int/i],
      path: [/trademark|tmsearch|tsdr/i],
      text: [/serial number/i, /registration number/i, /international class/i, /principal register/i,
        /first use in commerce/i]
    },
    {
      id: "banking_processor",
      label: "Banking / Payment-Processor Page",
      category: "banking",
      checkpoint: "processor",
      host: [/stripe\.com/i, /paypal\.com/i, /squareup\.com/i, /\bbank\b/i, /mercury\.com/i,
        /bluevine\.com/i, /novo\.co/i, /relayfi\.com/i],
      path: [/dashboard|account|merchant|payment|banking/i],
      text: [/merchant account/i, /payment processing/i, /routing number/i, /online banking/i],
      // A logged-in dashboard is not a public evidence page.
      negative: [/sign in|log in to your account/i]
    },
    {
      id: "marketplace_profile",
      label: "Marketplace / Seller Profile",
      category: "presence",
      host: [/amazon\.[a-z.]+$/i, /walmart\.com/i, /ebay\./i, /etsy\.com/i, /alibaba\./i, /shopify\./i],
      path: [/seller|shop|store|sp\?|profile/i],
      text: [/sold by/i, /seller profile/i, /about this seller/i, /storefront/i]
    },
    {
      id: "social_profile",
      label: "Social-Media Business Profile",
      category: "presence",
      checkpoint: "social",
      host: [/facebook\.com/i, /instagram\.com/i, /linkedin\.com/i, /x\.com$/i, /twitter\.com/i,
        /tiktok\.com/i, /youtube\.com/i, /pinterest\./i],
      path: [/company|pages|profile|user|@/i],
      text: [/followers/i, /follow us/i, /posts?\b/i]
    },
    {
      id: "news_reference",
      label: "News / Third-Party Reference",
      category: "presence",
      jsonld: [/^NewsArticle$/, /^Article$/, /^BlogPosting$/, /^ReportageNewsArticle$/],
      path: [/\/news\/|\/press\/|\/article\/|\/blog\//i],
      text: [/published (on|at)/i, /by [A-Z][a-z]+ [A-Z][a-z]+/, /press release/i]
    }
  ];

  C.UNCLASSIFIED = {
    id: "unclassified_web",
    label: "Unclassified / Needs Review",
    category: "unfiled"
  };

  var HOST_PTS = 50, PATH_PTS = 30, JSONLD_PTS = 40, TITLE_PTS = 25, TEXT_PTS = 12, NEG_PTS = 35;
  var MIN_SCORE = 40, MIN_MARGIN = 12;

  /* `page` is { url, host, path, title, text, jsonldTypes[] } */
  C.classify = function (page) {
    page = page || {};
    var host = String(page.host || "");
    var path = String(page.path || "");
    var title = String(page.title || "");
    var text = String(page.text || "");
    var types = page.jsonldTypes || [];

    var scored = [];
    C.TYPES.forEach(function (type) {
      var score = 0, hits = [];

      (type.host || []).forEach(function (rx) {
        if (rx.test(host)) { score += HOST_PTS; hits.push({ where: "domain", matched: host, weight: "strong" }); }
      });
      (type.path || []).forEach(function (rx) {
        var m = rx.exec(path);
        if (m) { score += PATH_PTS; hits.push({ where: "URL path", matched: m[0], weight: "strong" }); }
      });
      (type.jsonld || []).forEach(function (rx) {
        types.forEach(function (t) {
          if (rx.test(t)) { score += JSONLD_PTS; hits.push({ where: "structured data @type", matched: t, weight: "strong" }); }
        });
      });
      (type.title || []).forEach(function (rx) {
        var m = rx.exec(title);
        if (m) { score += TITLE_PTS; hits.push({ where: "page title", matched: m[0], weight: "medium" }); }
      });
      (type.text || []).forEach(function (rx) {
        var m = rx.exec(text);
        if (m) {
          score += TEXT_PTS;
          hits.push({ where: "page text", matched: m[0].slice(0, 60), weight: "weak",
            excerpt: U.maskSecrets(U.excerpt(text, m.index, m[0].length, 45)) });
        }
      });
      (type.negative || []).forEach(function (rx) {
        if (rx.test(path) || rx.test(text)) {
          score -= NEG_PTS;
          hits.push({ where: "counter-signal", matched: String(rx), weight: "against" });
        }
      });

      if (score > 0) scored.push({ type: type, score: score, hits: hits });
    });

    scored.sort(function (a, b) { return b.score - a.score; });
    var top = scored[0], next = scored[1];

    var out = {
      typeId: C.UNCLASSIFIED.id,
      label: C.UNCLASSIFIED.label,
      category: C.UNCLASSIFIED.category,
      checkpoint: null,
      confidence: "Low",
      reasons: [],
      evidence: [],
      alternatives: scored.slice(0, 4).map(function (s) {
        return { id: s.type.id, label: s.type.label, score: s.score };
      })
    };

    if (!top) {
      out.reasons.push("Nothing on this page identified what kind of page it is.");
      return out;
    }
    if (top.score < MIN_SCORE) {
      out.reasons.push("Closest match was " + top.type.label + ", but the signals were too weak to commit to it.");
      out.reasons.push("Left unclassified so it is not filed as something it may not be.");
      return out;
    }
    if (next && (top.score - next.score) < MIN_MARGIN) {
      out.reasons.push("Two page types scored almost the same — " + top.type.label + " and " + next.type.label + ".");
      out.reasons.push("Left unclassified rather than guessing; choose one in the review screen.");
      return out;
    }

    var strong = top.hits.filter(function (h) { return h.weight === "strong"; });
    out.typeId = top.type.id;
    out.label = top.type.label;
    out.category = top.type.category;
    out.checkpoint = top.type.checkpoint || null;
    out.confidence = strong.length >= 2 ? "High" : (strong.length === 1 ? "Medium" : "Low");
    out.evidence = top.hits.filter(function (h) { return h.weight !== "against"; }).slice(0, 6);
    out.reasons.push("Identified as " + top.type.label + " from " +
      out.evidence.map(function (h) { return h.where; })
        .filter(function (v, i, a) { return a.indexOf(v) === i; }).join(", ") + ".");
    if (out.confidence !== "High") {
      out.reasons.push("Only " + strong.length + " strong signal matched — confirm the page type before saving.");
    }
    return out;
  };

  C.byId = function (id) {
    if (id === C.UNCLASSIFIED.id) return C.UNCLASSIFIED;
    for (var i = 0; i < C.TYPES.length; i++) if (C.TYPES[i].id === id) return C.TYPES[i];
    return null;
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.linkClassifier = C;
  if (typeof module !== "undefined" && module.exports) module.exports = C;
})(typeof globalThis !== "undefined" ? globalThis : this);
