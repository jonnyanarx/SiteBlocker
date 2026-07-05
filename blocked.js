const params = new URLSearchParams(location.search);
const domain = params.get('domain');

const messageEl = document.getElementById('message');
const unblockBtn = document.getElementById('unblockNowBtn');

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

let navigating = false;

function goToSite() {
  if (navigating) return;
  navigating = true;
  location.href = `https://${domain}/`;
}

unblockBtn.addEventListener('click', async () => {
  unblockBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ action: 'confirmUnblock', domain });
    if (res?.ok) {
      goToSite();
      return;
    }
  } catch (err) {
    console.error('Site Blocker: confirmUnblock failed', err);
  }
  unblockBtn.disabled = false;
});

// Polls the background for ground truth every second instead of trusting a
// one-time snapshot baked into this page's URL at redirect time. That way a
// tab left open on this page always reflects reality, even if it's been
// sitting here since before the site's state last changed.
async function poll() {
  if (navigating) return;

  let res;
  try {
    res = await chrome.runtime.sendMessage({ action: 'getStatusForUrl', url: `https://${domain}/` });
  } catch (err) {
    console.error('Site Blocker: status poll failed', err);
    return;
  }

  const site = res?.site;

  if (!site) {
    // Already fully unblocked in the background — this page is stale.
    goToSite();
    return;
  }

  if (site.status === 'blocked') {
    unblockBtn.hidden = true;
    messageEl.textContent = 'The site is blocked, go do something useful.';
    return;
  }

  if (site.status === 'pending') {
    unblockBtn.hidden = true;
    const remaining = site.unblockAt - Date.now();
    messageEl.textContent = remaining > 0
      ? `The page will be available in ${formatCountdown(remaining)}`
      : 'Almost there…';
    return;
  }

  // status === 'confirm'
  const remaining = site.confirmUntil - Date.now();
  if (remaining <= 0) {
    // Missed the window. Tell the background to flip back to 'blocked'
    // *before* reloading, so the fresh load doesn't race a still-stale
    // 'confirm' status and bounce right back into this same branch.
    try {
      await chrome.runtime.sendMessage({ action: 'expireConfirm', domain });
    } catch (err) {
      console.error('Site Blocker: expireConfirm failed', err);
    }
    location.reload();
    return;
  }

  unblockBtn.hidden = false;
  unblockBtn.disabled = false;
  messageEl.textContent = `You have ${formatCountdown(remaining)} to unblock the site.`;
}

poll();
setInterval(poll, 1000);
