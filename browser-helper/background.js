"use strict";

const DASHBOARD_URL = "https://planetxentauri.github.io/big-business/";
const DASHBOARD_PATTERN = "https://planetxentauri.github.io/big-business/*";

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== "CAPTURE_ACTIVE_PAGE") return;
  captureAndSend().then(sendResponse).catch(function (error) {
    sendResponse({ ok: false, reason: error && error.message ? error.message : "The page could not be captured." });
  });
  return true;
});

async function captureAndSend() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const source = tabs[0];
  if (!source || !source.id) throw new Error("No active webpage was found.");
  if (!/^https?:/i.test(source.url || "")) {
    throw new Error("Open a normal http or https webpage first. Browser settings and internal pages cannot be read.");
  }
  if ((source.url || "").startsWith(DASHBOARD_URL)) {
    throw new Error("Open the source webpage first, then click the helper there.");
  }

  let injection;
  try {
    injection = await chrome.scripting.executeScript({
      target: { tabId: source.id },
      func: captureRenderedPage
    });
  } catch (error) {
    throw new Error("This page does not allow the helper to read it. Save it as a PDF or screenshot instead.");
  }
  const capture = injection && injection[0] && injection[0].result;
  if (!capture || !capture.url) throw new Error("The page did not return any readable content.");

  let dashboardTabs = await chrome.tabs.query({ url: DASHBOARD_PATTERN });
  let dashboard = dashboardTabs[0];
  if (!dashboard) {
    dashboard = await chrome.tabs.create({ url: DASHBOARD_URL, active: true });
    await waitForComplete(dashboard.id, 15000);
  } else {
    await chrome.tabs.update(dashboard.id, { active: true });
    if (dashboard.windowId) await chrome.windows.update(dashboard.windowId, { focused: true });
  }

  await sendWithRetry(dashboard.id, capture);
  return { ok: true, title: capture.title || capture.url, truncated: capture.truncated };
}

function captureRenderedPage() {
  const MAX_TEXT = 500000;
  const MAX_JSONLD = 200000;
  const MAX_JSONLD_TOTAL = 250000;
  const MAX_JSONLD_BLOCKS = 20;

  const bodyText = document.body ? String(document.body.innerText || "") : "";
  const cleanText = bodyText.replace(/\u0000/g, "").slice(0, MAX_TEXT);
  const meta = Object.create(null);
  document.querySelectorAll("meta[name],meta[property]").forEach(function (node) {
    const key = String(node.getAttribute("property") || node.getAttribute("name") || "").toLowerCase();
    if (!/^(description|application-name|author|og:[a-z0-9:_-]+|twitter:[a-z0-9:_-]+)$/i.test(key)) return;
    if (!(key in meta)) meta[key] = String(node.getAttribute("content") || "").slice(0, 1000);
  });

  const jsonld = [];
  let jsonTotal = 0;
  document.querySelectorAll('script[type="application/ld+json"]').forEach(function (node) {
    if (jsonld.length >= MAX_JSONLD_BLOCKS) return;
    const raw = String(node.textContent || "").slice(0, MAX_JSONLD);
    if (!raw || jsonTotal + raw.length > MAX_JSONLD_TOTAL) return;
    jsonTotal += raw.length;
    jsonld.push(raw);
  });

  const canonicalNode = document.querySelector('link[rel~="canonical"]');
  return {
    kind: "page-capture",
    version: 1,
    url: location.href,
    title: String(document.title || "").slice(0, 300),
    canonical: canonicalNode ? String(canonicalNode.href || "").slice(0, 2048) : "",
    text: cleanText,
    meta: meta,
    jsonld: jsonld,
    capturedAt: Date.now(),
    truncated: bodyText.length > MAX_TEXT
  };
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let done = false;
    const timer = setTimeout(finish, timeoutMs, new Error("Big Business took too long to open."));
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      error ? reject(error) : resolve();
    }
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") finish();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function sendWithRetry(tabId, capture) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, {
        type: "BIG_BUSINESS_IMPORT_CAPTURE",
        capture: capture
      });
      if (result && result.ok) return;
    } catch (error) { lastError = error; }
    await new Promise(function (resolve) { setTimeout(resolve, 350); });
  }
  throw lastError || new Error("Big Business did not accept the captured page. Refresh it and try again.");
}
