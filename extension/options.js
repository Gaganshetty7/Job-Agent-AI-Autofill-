const DEFAULTS = {
  backendUrl: "http://localhost:8000",
  thAuto: 90,
  thSuggest: 70,
};

const $ = (id) => document.getElementById(id);

async function load() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  $("backendUrl").value = cfg.backendUrl;
  $("thAuto").value = cfg.thAuto;
  $("thSuggest").value = cfg.thSuggest;
}

$("save").addEventListener("click", async () => {
  const cfg = {
    backendUrl: $("backendUrl").value.trim().replace(/\/$/, ""),
    thAuto: Number($("thAuto").value),
    thSuggest: Number($("thSuggest").value),
  };
  await chrome.storage.local.set(cfg);
  const status = $("status");
  status.style.display = "block";
  setTimeout(() => (status.style.display = "none"), 1500);
});

load();
