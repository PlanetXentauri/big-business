# big-business

Static, build-free dashboard (`index.html` + classic scripts in `js/`). Served from
GitHub Pages off `main`; also works from `file://`.

## Business Credit Profile

The "Business Credit Profile" checklist item is backed by a provider-neutral credit
ledger (`js/doc/credit.js`) rather than a single score field:

- every metric is an **observation** with its own value, scale, risk band, **status**
  (`available` / `data_not_available` / `not_reported` / …), report date, import date
  and source (document, page, evidence, confidence);
- observations are append-only — a newer report supersedes, never overwrites; the
  current value is computed from report dates, and a manual correction keeps the
  imported reading in history;
- facts a report states that have no field of their own are kept as *extended facts*;
- `js/doc/credit-extractors.js` parses D&B Credit Insights reports section by section
  (PAYDEX, Delinquency, Failure, SER, D&B Rating, Maximum Credit Recommendation,
  Overall Business Risk, payments, public records, inquiries) plus generic labelled
  scores for any provider. Providers are registered in `DOCAI.credit.PROVIDERS`.
- `js/credit-center.js` renders the Command Center (summary, per-bureau cards, history
  and trend, source provenance, document vault with **Re-analyze**).

## Tests

```
node tests/run-node.js          # extraction, mapping, transaction, undo
node tests/run-credit-node.js   # Business Credit Profile: parser, ledger, history, re-analysis
node tests/run-link-node.js     # Autofill from Link
node tests/run-engine-node.js   # optional Claude engine (API stubbed)
```

`tests/index.html` holds the browser-only half (PDF.js, OCR, IndexedDB).