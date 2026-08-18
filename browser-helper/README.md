# Big Business Page Helper

This optional Chrome/Edge/Brave extension sends the currently rendered page
to Big Business when a website blocks normal cross-origin reading.

## Install locally

1. Download or clone this repository and keep the `browser-helper` folder.
2. Open your browser's extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `browser-helper` folder.
5. Pin **Big Business Page Helper** to the toolbar.

## Use

1. Open the source webpage.
2. Click the helper icon.
3. Click **Send Page to Big Business**.
4. Big Business opens and shows its normal evidence-based review.
5. Confirm the business, choose fields, and save. The original URL is kept.

## Privacy and permissions

- `activeTab`: reads only the page where you click the helper.
- `scripting`: performs that one user-requested capture.
- `tabs`: finds or opens the Big Business dashboard tab.
- Dashboard host permission: delivers the capture only to the Big Business
  GitHub Pages origin.

The helper has no server, analytics, fetch call, or external API. It reads
`document.body.innerText`, title, canonical URL, selected metadata, and JSON-LD.
It does not read input values, password fields, cookies, or browser history.
Nothing is saved until the dashboard review is approved.

Browser-internal pages, built-in PDF viewers, and pages that forbid extension
injection cannot be captured; use PDF or Photo autofill for those.
