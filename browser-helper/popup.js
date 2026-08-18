"use strict";

var button = document.getElementById("send");
var statusBox = document.getElementById("status");

button.addEventListener("click", function () {
  button.disabled = true;
  statusBox.className = "";
  statusBox.textContent = "Reading the visible page…";
  chrome.runtime.sendMessage({ type: "CAPTURE_ACTIVE_PAGE" }, function (result) {
    button.disabled = false;
    if (chrome.runtime.lastError) {
      showBad(chrome.runtime.lastError.message);
      return;
    }
    if (!result || !result.ok) {
      showBad((result && result.reason) || "The page could not be sent.");
      return;
    }
    statusBox.className = "ok";
    statusBox.textContent = "✓ Sent to Big Business. Review the proposed fields there." +
      (result.truncated ? " The page was very large, so only the first part was read." : "");
  });
});

function showBad(message) {
  statusBox.className = "bad";
  statusBox.textContent = "⚠ " + message;
}
