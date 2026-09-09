// background.js — Service Worker (MV3)
// Handles Gemini AI calls (avoids CORS issues in content scripts).
// Relays STATUS_UPDATE messages from content scripts to the popup.

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── AI Request (from any content script) ──────────────────────────────────
  if (msg.type === "ASK_AI") {
    handleAI(msg.prompt, msg.apiKey).then(sendResponse);
    return true; // keep channel open for async response
  }

  // ── Settings fetch ────────────────────────────────────────────────────────
  if (msg.type === "GET_SETTINGS") {
    chrome.storage.sync.get(["apiKey", "speed", "enabled"], (data) => sendResponse(data));
    return true;
  }

  // ── STATUS_UPDATE relay ───────────────────────────────────────────────────
  if (msg.type === "STATUS_UPDATE" && sender.tab) {
    chrome.runtime.sendMessage(msg).catch(() => {});
    return false;
  }

  // ── VM_ACTION relay (Cross-frame communication) ───────────────────────────
  // If the instructions are in an iframe but the VM canvas is in the top frame,
  // the iframe sends VM_ACTION here, and we broadcast it to all frames in the tab.
  if (msg.type === "VM_ACTION" && sender.tab) {
    chrome.tabs.sendMessage(sender.tab.id, msg).catch(() => {});
    return false;
  }
});

// ─── Gemini API Call ──────────────────────────────────────────────────────────
// BUG-02 FIX: Raised maxOutputTokens to 2048 so coding lab solutions are never truncated.
// BUG-13 FIX: Surface API errors (bad key, quota exceeded) instead of silently returning "".
async function handleAI(prompt, apiKey) {
  if (!apiKey) return { error: "No API key provided." };
  try {
    const resp = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
      })
    });

    if (!resp.ok) {
      // HTTP-level error (401 invalid key, 429 quota, 500 server)
      const errBody = await resp.text().catch(() => resp.statusText);
      return { error: `Gemini API error ${resp.status}: ${errBody.slice(0, 120)}` };
    }

    const data = await resp.json();

    // BUG-13 FIX: Check for application-level error payload
    if (data.error) {
      return { error: `Gemini error: ${data.error.message || JSON.stringify(data.error)}` };
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // Detect finish reason — SAFETY means the answer was blocked
    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason === "SAFETY") {
      return { error: "Gemini blocked the response for safety reasons." };
    }

    return { text: text.trim() };
  } catch (e) {
    return { error: `Network error: ${e.message}` };
  }
}
