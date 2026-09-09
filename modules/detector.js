// modules/detector.js
// Detects which type of MindTap activity is currently loaded.

export const ActivityType = {
  MCQ:    "mcq",
  FILLIN: "fillin",
  LAB:    "lab",
  CODING: "coding",
  UNKNOWN:"unknown"
};

/**
 * Inspect the current document and return an ActivityType.
 */
export function detectActivity() {
  // --- Coding Lab (CodeMirror / Monaco / textarea with code class) ---
  if (
    document.querySelector(".CodeMirror") ||
    document.querySelector(".monaco-editor") ||
    document.querySelector("[data-cy='code-editor']") ||
    document.querySelector(".coding-lab") ||
    document.querySelector(".ace_editor")
  ) {
    return ActivityType.CODING;
  }

  // --- Lab simulation (step-based instruction panel) ---
  if (
    document.querySelector(".lab-step") ||
    document.querySelector("[class*='labStep']") ||
    document.querySelector("[class*='lab-instruction']") ||
    document.querySelector("[class*='step-instruction']") ||
    document.querySelector(".activity-step") ||
    (document.querySelector("[class*='instruction']") &&
     document.querySelector("[class*='task-pane']"))
  ) {
    return ActivityType.LAB;
  }

  // --- Multiple choice (radio or clickable option cards) ---
  const radios = document.querySelectorAll("input[type='radio'], input[type='checkbox']");
  const optionCards = document.querySelectorAll(
    "[class*='option'], [class*='choice'], [class*='answer-option'], [role='radio'], [role='option']"
  );
  if (radios.length > 0 || optionCards.length > 0) {
    return ActivityType.MCQ;
  }

  // --- Fill-in-the-blank ---
  const inputs = document.querySelectorAll(
    "input[type='text'], input[type='number'], textarea, [contenteditable='true']"
  );
  if (inputs.length > 0) {
    return ActivityType.FILLIN;
  }

  return ActivityType.UNKNOWN;
}
