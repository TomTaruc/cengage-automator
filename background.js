// background.js — Service Worker (MV3)
// Handles AI calls for multiple providers (Gemini, OpenAI, OpenRouter).
// Avoids CORS issues in content scripts.
// Relays STATUS_UPDATE messages from content scripts to the popup.

const PROVIDERS = {
  gemini: {
    // Model updated to gemini-2.5-flash (gemini-2.0-flash was deprecated Sep 2026)
    endpoint: (model) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${model || "gemini-2.5-flash"}:generateContent`,
    defaultModel: "gemini-2.5-flash",
    fallbackModels: ["gemini-2.5-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash"]
  },
  openai: {
    endpoint: () => "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o-mini",
    fallbackModels: ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo"]
  },
  openrouter: {
    endpoint: () => "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "openai/gpt-4o-mini",
    fallbackModels: ["openai/gpt-4o-mini", "google/gemini-2.5-flash", "anthropic/claude-3-haiku"]
  }
};

// ─── Auto-reload lab tabs on extension update ─────────────────────────────────
// When the extension is reloaded/updated, content scripts are NOT re-injected
// into already-open tabs. Auto-reload LOD/Cengage tabs so they get fresh scripts.
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      const url = tab.url || "";
      if (
        url.includes("labondemand.com") ||
        url.includes("labclient.labondemand.com") ||
        url.includes("cengage.com") ||
        url.includes("mindtap")
      ) {
        chrome.tabs.reload(tab.id);
      }
    }
  });
});

// ─── Frame Registry ───────────────────────────────────────────────────────────
// Cross-origin iframes can't be reached by chrome.tabs.sendMessage unless we
// know their frameId. Content scripts register themselves here on load.
// Key: tabId, Value: Set of {frameId, url}
const frameRegistry = new Map();

chrome.tabs.onRemoved.addListener((tabId) => frameRegistry.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") frameRegistry.delete(tabId);
});

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Frame self-registration ───────────────────────────────────────────────
  if (msg.type === "FRAME_REGISTER" && sender.tab) {
    const tabId = sender.tab.id;
    const frameId = sender.frameId ?? 0;
    if (!frameRegistry.has(tabId)) frameRegistry.set(tabId, new Map());
    frameRegistry.get(tabId).set(frameId, msg.url || "");
    sendResponse({ ok: true });
    return false;
  }

  // ── POPUP_BROADCAST — send to all registered frames in a tab ─────────────
  if (msg.type === "POPUP_BROADCAST") {
    const { tabId, payload } = msg;
    if (!tabId || !payload) { sendResponse({ error: "missing tabId or payload" }); return false; }

    const frames = frameRegistry.get(tabId);
    if (!frames || frames.size === 0) {
      // No registered frames — fall back to broadcast (may only hit top frame)
      chrome.tabs.sendMessage(tabId, payload, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          sendResponse({ error: "no registered frames and broadcast failed" });
        } else {
          sendResponse(resp);
        }
      });
      return true;
    }

    // Send to ALL registered frames, resolve with first successful response
    let resolved = false;
    let pending = frames.size;
    for (const [frameId] of frames) {
      chrome.tabs.sendMessage(tabId, payload, { frameId }, (resp) => {
        pending--;
        if (!resolved && !chrome.runtime.lastError && resp) {
          resolved = true;
          sendResponse(resp);
        } else if (!resolved && pending === 0) {
          sendResponse({ error: "all registered frames failed to respond" });
        }
      });
    }
    return true;
  }

  // ── AI Request ────────────────────────────────────────────────────────────
  if (msg.type === "ASK_AI") {
    handleAI(msg.prompt, msg.apiKey, msg.imageBase64, msg.provider, msg.model)
      .then(sendResponse);
    return true;
  }

  // ── Settings fetch ────────────────────────────────────────────────────────
  if (msg.type === "GET_SETTINGS") {
    chrome.storage.sync.get(
      ["apiKey", "openaiKey", "openrouterKey", "provider", "model", "speed", "enabled"],
      (data) => sendResponse(data)
    );
    return true;
  }

  // ── CLIPBOARD_WRITE fallback ───────────────────────────────────────────────
  if (msg.type === "CLIPBOARD_WRITE") {
    (async () => {
      try {
        await chrome.storage.session.set({ pendingClipboard: msg.text });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── STATUS_UPDATE relay ───────────────────────────────────────────────────
  if (msg.type === "STATUS_UPDATE" && sender.tab) {
    chrome.runtime.sendMessage(msg).catch(() => {});
    return false;
  }

  // ── VM_ACTION relay ───────────────────────────────────────────────────────
  if (msg.type === "VM_ACTION" && sender.tab) {
    chrome.tabs.sendMessage(sender.tab.id, msg).catch(() => {});
    return false;
  }

  // ── CAPTURE_SCREEN ────────────────────────────────────────────────────────
  if (msg.type === "CAPTURE_SCREEN" && sender.tab) {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "jpeg", quality: 60 }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        const base64 = dataUrl ? dataUrl.split(",")[1] : null;
        sendResponse({ imageBase64: base64 });
      }
    });
    return true;
  }

  // ── NATIVE_KEY ────────────────────────────────────────────────────────────
  if (msg.type === "NATIVE_KEY" && sender.tab) {
    ensureDebugger(sender.tab.id, () => {
      dispatchNativeKey(sender.tab.id, msg.key, msg.modifiers || 0, msg.text || "", () => {
        sendResponse({ ok: true });
      });
    });
    return true;
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

// ─── Multi-Provider AI Call ───────────────────────────────────────────────────
async function handleAI(prompt, apiKey, imageBase64 = null, provider = "gemini", model = null) {
  // Normalize provider
  const prov = (provider || "gemini").toLowerCase();

  if (!apiKey) return { error: "No API key provided." };

  try {
    switch (prov) {
      case "openai":
        return await callOpenAI(prompt, apiKey, model, imageBase64);
      case "openrouter":
        return await callOpenRouter(prompt, apiKey, model, imageBase64);
      case "gemini":
      default:
        return await callGemini(prompt, apiKey, model, imageBase64);
    }
  } catch (e) {
    return { error: `Network error: ${e.message}` };
  }
}

// ─── Gemini ───────────────────────────────────────────────────────────────────
async function callGemini(prompt, apiKey, model, imageBase64) {
  const resolvedModel = model || PROVIDERS.gemini.defaultModel;
  const endpoint = PROVIDERS.gemini.endpoint(resolvedModel);

  const parts = [{ text: prompt }];
  if (imageBase64) {
    parts.push({ inlineData: { mimeType: "image/jpeg", data: imageBase64 } });
  }

  const resp = await fetch(`${endpoint}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
    })
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => resp.statusText);
    // Auto-retry with fallback model if this model is gone (404)
    if (resp.status === 404 && resolvedModel !== "gemini-2.5-flash") {
      console.warn(`[AI] Gemini model ${resolvedModel} unavailable, retrying with gemini-2.5-flash`);
      return await callGemini(prompt, apiKey, "gemini-2.5-flash", imageBase64);
    }
    return { error: `Gemini API error ${resp.status}: ${errBody.slice(0, 200)}` };
  }

  const data = await resp.json();
  if (data.error) return { error: `Gemini error: ${data.error.message || JSON.stringify(data.error)}` };

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const finishReason = data?.candidates?.[0]?.finishReason;
  if (finishReason === "SAFETY") return { error: "Gemini blocked the response for safety reasons." };

  return { text: text.trim() };
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────
async function callOpenAI(prompt, apiKey, model, imageBase64) {
  const resolvedModel = model || PROVIDERS.openai.defaultModel;

  const messages = [];
  if (imageBase64) {
    // Vision-capable request
    messages.push({
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: "low" } }
      ]
    });
  } else {
    messages.push({ role: "user", content: prompt });
  }

  const resp = await fetch(PROVIDERS.openai.endpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: resolvedModel,
      messages,
      temperature: 0.1,
      max_tokens: 4096
    })
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => resp.statusText);
    return { error: `OpenAI API error ${resp.status}: ${errBody.slice(0, 200)}` };
  }

  const data = await resp.json();
  if (data.error) return { error: `OpenAI error: ${data.error.message}` };

  const text = data?.choices?.[0]?.message?.content ?? "";
  return { text: text.trim() };
}

// ─── OpenRouter ───────────────────────────────────────────────────────────────
async function callOpenRouter(prompt, apiKey, model, imageBase64) {
  const resolvedModel = model || PROVIDERS.openrouter.defaultModel;

  const messages = [];
  if (imageBase64) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
      ]
    });
  } else {
    messages.push({ role: "user", content: prompt });
  }

  const resp = await fetch(PROVIDERS.openrouter.endpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/TomTaruc/cengage-automator",
      "X-Title": "Cengage Automator"
    },
    body: JSON.stringify({
      model: resolvedModel,
      messages,
      temperature: 0.1,
      max_tokens: 4096
    })
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => resp.statusText);
    return { error: `OpenRouter API error ${resp.status}: ${errBody.slice(0, 200)}` };
  }

  const data = await resp.json();
  if (data.error) return { error: `OpenRouter error: ${data.error.message || JSON.stringify(data.error)}` };

  const text = data?.choices?.[0]?.message?.content ?? "";
  return { text: text.trim() };
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
  // Control
  "enter": 13, "tab": 9, "escape": 27, "space": 32, "backspace": 8, "delete": 46,
  "arrowup": 38, "arrowdown": 40, "arrowleft": 37, "arrowright": 39,
  "home": 36, "end": 35, "pageup": 33, "pagedown": 34, "insert": 45,
  // Function keys
  "f1": 112, "f2": 113, "f3": 114, "f4": 115, "f5": 116, "f6": 117,
  "f7": 118, "f8": 119, "f9": 120, "f10": 121, "f11": 122, "f12": 123,
  // Letters
  "a": 65, "b": 66, "c": 67, "d": 68, "e": 69, "f": 70, "g": 71, "h": 72, "i": 73,
  "j": 74, "k": 75, "l": 76, "m": 77, "n": 78, "o": 79, "p": 80, "q": 81, "r": 82,
  "s": 83, "t": 84, "u": 85, "v": 86, "w": 87, "x": 88, "y": 89, "z": 90,
  // Digits
  "0": 48, "1": 49, "2": 50, "3": 51, "4": 52, "5": 53, "6": 54, "7": 55, "8": 56, "9": 57,
  // Symbols (unshifted)
  "-": 189, "=": 187, "[": 219, "]": 221, "\\": 220, ";": 186, "'": 222,
  ",": 188, ".": 190, "/": 191, "`": 192,
  // Shifted symbols (sent as char events via textStr)
  "!": 49, "@": 50, "#": 51, "$": 52, "%": 53, "^": 54, "&": 55,
  "*": 56, "(": 57, ")": 48, "_": 189, "+": 187, "{": 219, "}": 221,
  "|": 220, ":": 186, "\"": 222, "<": 188, ">": 190, "?": 191, "~": 192
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
