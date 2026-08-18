/* Runs only on the Big Business GitHub Pages origin. It crosses Chrome's
   isolated-world boundary by posting one validated-by-the-app review event. */
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== "BIG_BUSINESS_IMPORT_CAPTURE") return;
  window.postMessage({
    channel: "big-business-browser-helper-v1",
    type: "IMPORT_CAPTURE",
    payload: message.capture
  }, window.location.origin);
  sendResponse({ ok: true });
});
