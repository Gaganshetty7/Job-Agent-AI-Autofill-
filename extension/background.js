const DEFAULTS = {
  backendUrl: "http://localhost:8000",
  thAuto: 90,
  thSuggest: 70,
  enabled: true,
};

async function getConfig() {
  return await chrome.storage.local.get(DEFAULTS);
}

async function syncActionState() {
  const cfg = await getConfig();
  chrome.action.setBadgeText({ text: cfg.enabled ? "ON" : "OFF" });
  chrome.action.setTitle({ title: cfg.enabled ? "JobAgent is on" : "JobAgent is off" });
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["profile", "enabled"]);
  if (!existing.profile) {
    await chrome.storage.local.set({ profile: {} });
  }
  const stored = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({ backendUrl: stored.backendUrl, thAuto: stored.thAuto, thSuggest: stored.thSuggest, enabled: stored.enabled });
  await syncActionState();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled) {
    syncActionState();
  }
});

async function matchBubbles(bubbles) {
  const cfg = await getConfig();
  const res = await fetch(`${cfg.backendUrl}/match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ html_bubbles: bubbles }),
  });
  if (!res.ok) throw new Error(`Backend error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function pairFields(fieldNames, profileKeys) {
  const cfg = await getConfig();
  const res = await fetch(`${cfg.backendUrl}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ field_names: fieldNames, profile_keys: profileKeys }),
  });
  if (!res.ok) throw new Error(`Backend error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function submitPair(fieldNames, values, currentProfile) {
  const cfg = await getConfig();
  const profileKeys = Object.keys(currentProfile);

  const res = await fetch(`${cfg.backendUrl}/pair-submitted`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      field_names: fieldNames,
      values: values,
      profile_keys: profileKeys,
      current_profile: currentProfile,
    }),
  });

  if (!res.ok) throw new Error(`Backend error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const mappings = data.mappings || [];

  const store = await chrome.storage.local.get({ profile: {} });
  const profile = store.profile;

  for (let i = 0; i < mappings.length; i++) {
    const mapping = mappings[i];
    const value = values[i];
    if (!mapping || mapping.key === "unknown" || mapping.confidence < 0.4 || !value) continue;

    const key = mapping.key;
    if (!profile[key]) profile[key] = [];
    if (!Array.isArray(profile[key])) profile[key] = [String(profile[key])];
    
    if (!profile[key].includes(value)) {
      profile[key].push(value);
    }
  }

  await chrome.storage.local.set({ profile });
  return profile;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "JOBAGENT_MATCH_BUBBLES") {
    matchBubbles(msg.bubbles)
      .then((result) => sendResponse({ ok: true, field_names: result.field_names }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg.type === "JOBAGENT_PAIR_FIELDS") {
    pairFields(msg.fieldNames, msg.profileKeys)
      .then((result) => sendResponse({ ok: true, mappings: result.mappings }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg.type === "JOBAGENT_LEARN_SUBMISSION") {
    submitPair(msg.fieldNames, msg.values, msg.currentProfile)
      .then((updatedProfile) => {
        if (sender.tab?.id) {
          chrome.tabs.sendMessage(sender.tab.id, { type: "JOBAGENT_PROFILE_UPDATED", profile: updatedProfile });
        }
        sendResponse({ ok: true });
      })
      .catch((err) => {
        console.error("JobAgent learn error:", err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }
  if (msg.type === "JOBAGENT_GET_CONFIG") {
    getConfig().then((cfg) => sendResponse({ ok: true, cfg }));
    return true;
  }
  if (msg.type === "JOBAGENT_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
  }
});
