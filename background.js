// background.js — Service Worker (MV3)
// Handles Gemini AI calls (avoids CORS issues in content scripts).
// Relays STATUS_UPDATE messages from content scripts to the popup.

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── AI Request (from any content script) ──────────────────────────────────
  if (msg.type === "ASK_AI") {
    handleAI(msg.prompt, msg.apiKey, msg.imageBase64).then(sendResponse);
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

  // ── CAPTURE_SCREEN ──────────────────────────────────────────────────────────
  if (msg.type === "CAPTURE_SCREEN" && sender.tab) {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "jpeg", quality: 60 }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        // Strip the "data:image/jpeg;base64," prefix for Gemini
        const base64 = dataUrl ? dataUrl.split(",")[1] : null;
        sendResponse({ imageBase64: base64 });
      }
    });
    return true;
  }

  // ── NATIVE_KEY (Debugger Keystroke Injection) ─────────────────────────────
  if (msg.type === "NATIVE_KEY" && sender.tab) {
    ensureDebugger(sender.tab.id, () => {
      dispatchNativeKey(sender.tab.id, msg.key, msg.modifiers || 0, msg.text || "", () => {
        sendResponse({ ok: true });
      });
    });
    return true; // Keep channel open for async response
  }

  if (msg.type === "DETACH_DEBUGGER" && sender.tab) {
    if (attachedTabs.has(sender.tab.id)) {
       chrome.debugger.detach({ tabId: sender.tab.id }, () => {
         attachedTabs.delete(sender.tab.id);
         sendResponse({ ok: true });
       });
       return true;
    }
    sendResponse({ ok: true });
    return false;
  }
});

// ─── Gemini API Call ──────────────────────────────────────────────────────────
// BUG-02 FIX: Raised maxOutputTokens to 2048 so coding lab solutions are never truncated.
// BUG-13 FIX: Surface API errors (bad key, quota exceeded) instead of silently returning "".
async function handleAI(prompt, apiKey, imageBase64 = null) {
  if (!apiKey) return { error: "No API key provided." };
  
  try {
    const parts = [{ text: prompt }];
    
    if (imageBase64) {
      parts.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: imageBase64
        }
      });
    }

    const resp = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
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

// ─── Debugger API Bridge (Native Keystrokes) ──────────────────────────────────
const attachedTabs = new Set();

chrome.debugger.onDetach.addListener((source) => {
  attachedTabs.delete(source.tabId);
});

function ensureDebugger(tabId, callback) {
  if (attachedTabs.has(tabId)) return callback();
  chrome.debugger.attach({ tabId }, "1.3", () => {
    if (chrome.runtime.lastError) {
      console.warn("Debugger attach failed:", chrome.runtime.lastError.message);
      return callback(); // Proceed anyway, it might fail downstream
    }
    attachedTabs.add(tabId);
    callback();
  });
}

const KEY_CODES = {
  "enter": 13, "tab": 9, "escape": 27, "space": 32, "backspace": 8, "delete": 46,
  "arrowup": 38, "arrowdown": 40, "arrowleft": 37, "arrowright": 39,
  "home": 36, "end": 35,
  "a": 65, "b": 66, "c": 67, "d": 68, "e": 69, "f": 70, "g": 71, "h": 72, "i": 73,
  "j": 74, "k": 75, "l": 76, "m": 77, "n": 78, "o": 79, "p": 80, "q": 81, "r": 82,
  "s": 83, "t": 84, "u": 85, "v": 86, "w": 87, "x": 88, "y": 89, "z": 90,
  "0": 48, "1": 49, "2": 50, "3": 51, "4": 52, "5": 53, "6": 54, "7": 55, "8": 56, "9": 57
};

function dispatchNativeKey(tabId, keyName, modifiers, textStr, callback) {
  const code = KEY_CODES[keyName.toLowerCase()] || 0;
  const downParams = { type: "rawKeyDown", windowsVirtualKeyCode: code, key: keyName, modifiers };
  const upParams = { type: "keyUp", windowsVirtualKeyCode: code, key: keyName, modifiers };

  chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", downParams, () => {
    if (textStr) {
      chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: "char", text: textStr, unmodifiedText: textStr, modifiers
      }, () => {
        chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", upParams, callback);
      });
    } else {
      chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", upParams, callback);
    }
  });
}
