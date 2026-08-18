/* ============================================================
   DOCAI · link-pipeline — a URL becomes a reviewable proposal.

   Like the document pipeline, this writes nothing. It returns a proposal
   marked `source: "link"`, and only transaction.js — driven by an explicit
   Save — changes state.

   Stages:
     1  validate and normalize the URL
     2  check for an already-saved copy
     3  retrieve the page (or accept pasted text)
     4  read title, metadata, structured data, visible text
     5  hash the extracted text
     6  detect the business from evidence
     7  classify the page
     8  extract candidate values
     9  detect likely duplicates
    10  hand to review

   A retrieval failure is not an error state: it produces a proposal that
   carries the reason and the offered fallbacks, so the link can still be
   saved and the user can still paste the page text instead.
   ============================================================ */
(function (root) {
  "use strict";

  var D = root.DOCAI || {};
  var U = D.util, LU = D.linkUrl, LF = D.linkFetch, LH = D.linkHtml;
  var LC = D.linkClassifier, LE = D.linkExtractors, LS = D.linkStore;
  var MATCH = D.businessMatcher, MAP = D.mapping;

  var P = {};

  function noop() {}

  /* ---------- analyze a URL ---------- */
  P.run = function (rawUrl, options) {
    options = options || {};
    var onStatus = options.onStatus || noop;
    var state = options.state;
    var profiles = options.profiles || {};

    // Stage 1
    var norm = LU.normalize(rawUrl);
    if (!norm.ok) return Promise.reject(new Error(norm.reason + (norm.detail ? " " + norm.detail : "")));

    var proposal = {
      id: U.uid("wimp"),
      source: "link",
      url: norm.url,
      normalizedUrl: norm.normalized,
      displayUrl: norm.url,
      domain: norm.domain,
      host: norm.host,
      urlChanges: norm.changes,
      title: "",
      finalUrl: "",
      canonicalUrl: "",
      redirected: false,
      retrievedAt: Date.now(),
      retrievalStatus: "not-retrieved",
      retrievalReason: "",
      retrievalDetail: "",
      fallbacks: [],
      notes: [],
      warnings: [],
      candidates: [],
      rejected: [],
      exactDuplicates: [],
      likelyDuplicates: [],
      pageText: "",
      contentHash: "",
      // Kept for the shared review screen, which reads these names.
      fileName: LU.display(norm.url, 70),
      pageCount: 1
    };

    // Stage 2 — an already-saved copy is known before any request is made.
    proposal.exactDuplicates = state ? LS.findExact(state, norm.normalized) : [];

    // Pasted text path: no request at all.
    if (options.pastedText) {
      onStatus("Reading the text you pasted…");
      return finish(proposal, {
        ok: true, html: null, text: String(options.pastedText),
        status: 0, finalUrl: norm.url, redirected: false, pasted: true
      }, { state: state, profiles: profiles, onStatus: onStatus });
    }

    // Stage 3
    onStatus("Checking " + LU.display(norm.url, 50) + "…");
    return LF.retrieve(norm.url, { onStatus: onStatus, timeoutMs: options.timeoutMs })
      .then(function (res) {
        return finish(proposal, res, { state: state, profiles: profiles, onStatus: onStatus });
      });
  };

  function finish(proposal, res, ctx) {
    var onStatus = ctx.onStatus;

    if (!res.ok) {
      // Honest failure. Nothing was read, so nothing is claimed.
      proposal.retrievalStatus = res.blocked ? "blocked" : "error";
      proposal.retrievalReason = res.reason;
      proposal.retrievalDetail = res.detail;
      proposal.fallbacks = res.fallbacks || [];
      proposal.finalUrl = res.finalUrl || proposal.url;
      proposal.httpStatus = res.status || 0;
      proposal.warnings.push(res.reason);
      if (res.detail) proposal.notes.push(res.detail);

      // Without page content there is no evidence, so no business is claimed
      // and no value is proposed.
      proposal.business = {
        decision: "none", business: null, confidence: "Low", evidence: [],
        reasons: ["The page could not be read, so there is no evidence to match against."],
        requiresManualChoice: true, scores: { centauri: 0, keypr: 0 }
      };
      proposal.classification = LC.classify({
        url: proposal.url, host: proposal.host,
        path: pathOf(proposal.url), title: "", text: "", jsonldTypes: []
      });
      onStatus("");
      return proposal;
    }

    // Stage 4
    onStatus("Reading the page contents…");
    var parsed;
    if (res.pasted) {
      // Pasted text may be plain text or copied HTML; parse handles both.
      var looksHtml = /<\/?[a-z][\s\S]*>/i.test(res.text);
      parsed = looksHtml ? LH.parse(res.text, proposal.url)
        : { title: "", meta: Object.create(null), canonical: "", jsonld: [], organization: null,
            text: LH.clean(res.text).slice(0, LH.MAX_TEXT), byteLength: res.text.length };
      proposal.retrievalStatus = "pasted";
      proposal.notes.push("Analysed from text you pasted, not from a live request.");
    } else {
      parsed = LH.parse(res.html, res.finalUrl || proposal.url);
      proposal.retrievalStatus = "retrieved";
      proposal.notes.push("Retrieved directly — the site allowed a cross-origin read.");
      if (res.truncated) {
        proposal.warnings.push("The page was larger than the size limit and was read only up to the cut-off.");
      }
    }

    proposal.title = parsed.title || "";
    proposal.canonicalUrl = parsed.canonical || "";
    proposal.finalUrl = res.finalUrl || proposal.url;
    proposal.redirected = !!res.redirected;
    proposal.httpStatus = res.status || 0;
    proposal.pageText = parsed.text || "";
    proposal.byteLength = res.bytes || parsed.byteLength || 0;
    if (proposal.title) proposal.fileName = proposal.title;

    if (proposal.redirected && proposal.finalUrl !== proposal.url) {
      proposal.notes.push("Redirected to " + proposal.finalUrl);
    }
    if (proposal.canonicalUrl) {
      proposal.notes.push("The page names " + proposal.canonicalUrl + " as its canonical address.");
    }

    var textLen = proposal.pageText.replace(/\s/g, "").length;
    if (textLen < 40) {
      proposal.warnings.push("Almost no readable text was found on this page — it may be rendered entirely by scripts, " +
        "which are never executed here.");
    }

    // Stage 5
    return LS.hashPage({ title: proposal.title, text: proposal.pageText,
                         organization: parsed.organization }).then(function (hash) {
      proposal.contentHash = hash;

      var combined = [proposal.title, proposal.pageText].filter(Boolean).join("\n");

      // Stage 6 — same evidence-based matcher as the document pipeline.
      onStatus("Working out which business this page belongs to…");
      proposal.business = MATCH.match(combined, ctx.profiles || {});
      applyDomainEvidence(proposal, ctx.profiles || {});

      // Stage 7
      onStatus("Identifying the kind of page…");
      proposal.classification = LC.classify({
        url: proposal.url,
        host: proposal.host,
        path: pathOf(proposal.finalUrl || proposal.url),
        title: proposal.title,
        text: proposal.pageText,
        jsonldTypes: (parsed.jsonld || []).reduce(function (acc, n) {
          return acc.concat(LH.typeArray(n["@type"]));
        }, [])
      });

      // Stage 8
      onStatus("Pulling out values…");
      var ex = LE.extract({
        url: proposal.finalUrl || proposal.url,
        title: proposal.title,
        text: proposal.pageText,
        meta: parsed.meta,
        organization: parsed.organization,
        retrievedAt: proposal.retrievedAt
      }, { includePageUrl: proposal.classification.typeId === "official_site" });

      proposal.candidates = ex.candidates.filter(function (c) { return !MAP.isInternal(c.dest); });
      proposal.rejected = ex.rejected;
      proposal.issuer = guessIssuer(parsed, proposal);

      // Stage 9
      proposal.likelyDuplicates = ctx.state ? LS.findLikely(ctx.state, {
        normalizedUrl: proposal.normalizedUrl,
        finalUrl: proposal.finalUrl,
        canonicalUrl: proposal.canonicalUrl,
        domain: proposal.domain,
        title: proposal.title,
        siteType: proposal.classification.typeId,
        contentHash: proposal.contentHash
      }) : [];

      onStatus("");
      return proposal;
    });
  }

  /* Domain similarity is supporting evidence, never proof. A page on the
     domain already saved as a business's website adds weight, but it cannot
     by itself decide which business a page belongs to — anyone can put any
     name on any domain. */
  function applyDomainEvidence(proposal, profiles) {
    if (!proposal.domain) return;
    ["centauri", "keypr"].forEach(function (biz) {
      var site = profiles[biz] && profiles[biz].bp && profiles[biz].bp.website;
      if (!site) return;
      var stored = LU.normalize(site);
      if (!stored.ok || stored.domain !== proposal.domain) return;

      proposal.business.evidence = proposal.business.evidence || [];
      proposal.business.evidence.push({
        kind: "domain",
        business: biz,
        matched: proposal.domain,
        excerpt: "This page is on " + proposal.domain + ", the domain saved as this business's website",
        weight: 30,
        supportingOnly: true
      });
      proposal.notes.push("The page is on " + proposal.domain +
        ", which matches the website already saved for " +
        (biz === "centauri" ? "Centauri World LLC" : "Keypr On Company") +
        ". That is supporting evidence, not proof of ownership.");

      // Domain alone must not flip "no match" into a confident answer.
      if (proposal.business.decision === "none") {
        proposal.business.decision = "ambiguous";
        proposal.business.requiresManualChoice = true;
        proposal.business.reasons = [
          "Nothing on the page names either business, but the domain matches one already on file.",
          "Domain similarity alone is not proof — confirm the business yourself."
        ];
      }
    });
  }

  function pathOf(url) {
    try { return new URL(url).pathname + (new URL(url).search || ""); } catch (e) { return ""; }
  }

  // The organisation behind the page, for filing and duplicate hints.
  function guessIssuer(parsed, proposal) {
    if (parsed.organization && typeof parsed.organization.name === "string") {
      return parsed.organization.name.slice(0, 120);
    }
    if (parsed.meta && parsed.meta["og:site_name"]) return String(parsed.meta["og:site_name"]).slice(0, 120);
    return proposal.domain || "";
  }

  /* ---------- recheck ----------
     Re-runs retrieval for a saved record and reports what changed. Never
     writes to the dashboard: the caller shows the differences for review. */
  P.recheck = function (record, options) {
    options = options || {};
    var onStatus = options.onStatus || noop;
    var target = record.finalUrl || record.url;

    onStatus("Rechecking " + LU.display(target, 50) + "…");
    return LF.retrieve(target, { onStatus: onStatus, timeoutMs: options.timeoutMs }).then(function (res) {
      var at = Date.now();
      if (!res.ok) {
        return {
          ok: false, at: at,
          status: res.blocked ? "blocked" : "error",
          note: res.reason,
          detail: res.detail,
          httpStatus: res.status,
          finalUrl: res.finalUrl || target,
          changed: false,
          gone: res.status === 404 || res.status === 410
        };
      }
      var parsed = LH.parse(res.html, res.finalUrl || target);
      return LS.hashPage({ title: parsed.title, text: parsed.text,
                           organization: parsed.organization }).then(function (hash) {
        var changed = !!(record.contentHash && hash && record.contentHash !== hash);
        return {
          ok: true, at: at,
          status: "retrieved",
          note: changed ? "The page content has changed since it was saved."
            : record.contentHash ? "The page is unchanged since it was saved."
            : "Page retrieved; there was no earlier content hash to compare against.",
          httpStatus: res.status,
          finalUrl: res.finalUrl || target,
          title: parsed.title,
          titleChanged: !!(record.title && parsed.title && record.title !== parsed.title),
          contentHash: hash,
          changed: changed,
          parsed: parsed
        };
      });
    });
  };

  root.DOCAI = root.DOCAI || {};
  root.DOCAI.linkPipeline = P;
  if (typeof module !== "undefined" && module.exports) module.exports = P;
})(typeof globalThis !== "undefined" ? globalThis : this);
