const toggle = document.getElementById('enabledToggle');
const status = document.getElementById('status');
const settingsBtn = document.getElementById('settingsBtn');

async function loadState() {
  const data = await chrome.storage.local.get({ enabled: true });
  toggle.checked = !!data.enabled;
  updateStatus();
}

function updateStatus() {
  status.textContent = toggle.checked ? 'Extension is on' : 'Extension is off';
}

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  await chrome.storage.local.set({ enabled });
  updateStatus();
});

settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

loadState();
