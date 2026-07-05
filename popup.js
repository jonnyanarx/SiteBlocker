const domainEl = document.getElementById('domain');
const statusEl = document.getElementById('status');
const blockBtn = document.getElementById('blockBtn');
const unblockBtn = document.getElementById('unblockBtn');

let currentUrl = null;
let currentDomain = null;
let countdownTimer = null;

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function render(site) {
  clearInterval(countdownTimer);

  if (!site) {
    statusEl.textContent = 'Not blocked';
    blockBtn.hidden = false;
    unblockBtn.hidden = true;
    return;
  }

  if (site.status === 'blocked') {
    statusEl.textContent = 'Blocked';
    blockBtn.hidden = true;
    unblockBtn.hidden = false;
    return;
  }

  // pending / confirm — no action to offer from here; a stray click on
  // "Block" would silently cancel the flow and re-block, which looks like
  // the unblock "didn't work". The confirm click itself only happens on
  // the stump page.
  blockBtn.hidden = true;
  unblockBtn.hidden = true;
  const tick = () => {
    if (site.status === 'pending') {
      const remaining = site.unblockAt - Date.now();
      statusEl.textContent = remaining > 0
        ? `Pending — available in ${formatCountdown(remaining)}`
        : 'Almost there…';
    } else {
      // confirm
      const remaining = site.confirmUntil - Date.now();
      statusEl.textContent = remaining > 0
        ? `Ready — confirm within ${formatCountdown(remaining)}`
        : 'Window closing…';
    }
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const blockedPagePrefix = chrome.runtime.getURL('blocked.html');

// When the tab is on our own stump page, the tab's actual URL is
// chrome-extension://.../blocked.html?domain=..., not the real site. Pull
// the original domain from that query string instead of the tab URL.
function resolveSiteUrl(tabUrl) {
  if (tabUrl.startsWith(blockedPagePrefix)) {
    const domain = new URL(tabUrl).searchParams.get('domain');
    return domain ? `https://${domain}/` : null;
  }
  if (/^https?:/.test(tabUrl)) return tabUrl;
  return null;
}

async function refresh() {
  const tab = await getActiveTab();
  const siteUrl = resolveSiteUrl(tab?.url || '');
  currentUrl = siteUrl;

  if (!siteUrl) {
    domainEl.textContent = '';
    statusEl.textContent = 'Not applicable on this page';
    blockBtn.hidden = true;
    unblockBtn.hidden = true;
    return;
  }

  const res = await chrome.runtime.sendMessage({ action: 'getStatusForUrl', url: siteUrl });
  currentDomain = res.domain;
  domainEl.textContent = res.domain;
  render(res.site);
}

// chrome.tabs.update(tabId, {url}) to the tab's OWN current URL is not
// guaranteed to force a fresh navigation in Chrome — if the tab is already
// sitting on the real site (the common case for "Block current site"),
// navigating to the identical URL can be a no-op, leaving the old page
// visible even though the new redirect rule is live. tabs.reload()
// explicitly forces a real reload, so use that unless we actually need to
// navigate away from the stump page to a different URL.
function forceRevisit(tab, targetUrl) {
  if (!tab?.id) return;
  if (tab.url === targetUrl) {
    chrome.tabs.reload(tab.id, { bypassCache: true });
  } else {
    chrome.tabs.update(tab.id, { url: targetUrl });
  }
}

blockBtn.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ action: 'block', url: currentUrl });
  if (!res?.ok) {
    statusEl.textContent = `Error: ${res?.error || 'unknown'}`;
    return;
  }
  const tab = await getActiveTab();
  forceRevisit(tab, currentUrl);
  window.close();
});

unblockBtn.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ action: 'unblock', domain: currentDomain });
  if (!res?.ok) {
    statusEl.textContent = `Error: ${res?.error || 'unknown'}`;
    return;
  }
  const tab = await getActiveTab();
  forceRevisit(tab, currentUrl);
  window.close();
});

refresh();
