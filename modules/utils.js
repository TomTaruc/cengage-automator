// modules/utils.js
// Shared utility helpers.

/**
 * Pause execution for `ms` milliseconds.
 */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(ms, 100)));
}

/**
 * Send a status update message to the popup.
 */
export function sendStatus(message, type = "info") {
  try {
    chrome.runtime.sendMessage({ type: "STATUS_UPDATE", message, statusType: type });
  } catch (_) {}
  console.log(`[Automator][${type.toUpperCase()}] ${message}`);
}

/**
 * Wait for an element matching `selector` to appear in the DOM.
 * @param {string} selector
 * @param {number} timeout ms
 * @returns {Promise<Element|null>}
 */
export function waitForElement(selector, timeout = 8000) {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);

    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearTimeout(timer);
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * Get the speed delay in ms from a speed setting (1-3).
 * 1 = slow (2000ms), 2 = medium (1000ms), 3 = fast (400ms)
 */
export function speedToMs(speed) {
  switch (parseInt(speed, 10)) {
    case 3: return 400;
    case 2: return 1000;
    default: return 2000;
  }
}
