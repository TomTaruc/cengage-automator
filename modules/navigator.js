// modules/navigator.js
// Handles clicking Next, Submit, Check Answer, and Continue buttons in MindTap.

import { delay } from "./utils.js";

// Priority-ordered list of "advance" button patterns
const ADVANCE_BUTTON_PATTERNS = [
  // Text-based matches (case-insensitive)
  { text: /^(submit|submit answer|submit all)$/i },
  { text: /^(check answer|check|grade)$/i },
  { text: /^(next|next question|next page|next activity)$/i },
  { text: /^(continue|proceed|go|done)$/i },
  { text: /^(finish|complete)$/i },
];

const ADVANCE_SELECTORS = [
  // Specific Cengage/MindTap button selectors
  "button[data-testid='submit-btn']",
  "button[data-testid='next-btn']",
  "button[data-testid='check-btn']",
  "[class*='btn-submit']",
  "[class*='btn-next']",
  "[class*='btn-check']",
  "[class*='submit-button']",
  "[class*='next-button']",
  "[class*='check-button']",
  "[class*='btn-primary']",   // Common primary action button
  "button[type='submit']"
];

/**
 * Find a button that matches advance patterns.
 */
function findAdvanceButton() {
  // 1. Try specific attribute selectors first
  for (const sel of ADVANCE_SELECTORS) {
    const btn = document.querySelector(sel);
    if (btn && !btn.disabled && isVisible(btn)) return btn;
  }

  // 2. Scan all buttons by text
  const allButtons = [...document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit'], a[class*='btn']")];
  for (const pattern of ADVANCE_BUTTON_PATTERNS) {
    for (const btn of allButtons) {
      if (btn.disabled || !isVisible(btn)) continue;
      const text = (btn.innerText || btn.value || btn.getAttribute("aria-label") || "").trim();
      if (pattern.text.test(text)) return btn;
    }
  }
  return null;
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

/**
 * Wait for a DOM mutation indicating the page has advanced.
 */
function waitForPageAdvance(timeout = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, timeout);

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      observer.disconnect();
      resolve(true);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * Scroll button into view, then click it.
 */
async function clickButton(btn, speed) {
  btn.scrollIntoView({ behavior: "smooth", block: "center" });
  await delay(300);
  btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await delay(100);
  btn.click();
  console.log("[Automator] Navigator: Clicked button:", btn.innerText || btn.value || btn.className);
}

/**
 * Try to advance (click Next / Submit) and wait for page update.
 * Returns true if a button was found and clicked.
 */
export async function advance(speed = 1000) {
  await delay(speed * 0.5);
  const btn = findAdvanceButton();
  if (!btn) {
    console.warn("[Automator] Navigator: No advance button found.");
    return false;
  }
  await clickButton(btn, speed);
  // Wait for DOM update
  await waitForPageAdvance(10000);
  await delay(speed);
  return true;
}

/**
 * Look for a confirmation dialog ("Yes, submit", "OK", "Confirm") and accept it.
 */
export async function confirmDialog(speed = 500) {
  await delay(speed);
  const patterns = [/^(yes|ok|confirm|accept|submit)$/i];
  const allButtons = [...document.querySelectorAll("button, [role='button']")];
  for (const pattern of patterns) {
    for (const btn of allButtons) {
      if (!btn.disabled && isVisible(btn)) {
        const text = btn.innerText?.trim() || "";
        if (pattern.test(text)) {
          btn.click();
          await delay(speed);
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Check if the assignment appears to be complete (end screen visible).
 */
export function isAssignmentComplete() {
  const endKeywords = ["great job", "assignment complete", "you've finished",
                       "congratulations", "well done", "score:", "activity complete",
                       "lab complete", "you scored"];
  const body = document.body.innerText.toLowerCase();
  return endKeywords.some(kw => body.includes(kw));
}
