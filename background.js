const COOLDOWN_PREFIX = 'cooldownEnd:';
const CONFIRM_PREFIX = 'confirmEnd:';
const SWEEP_ALARM = 'sweep';
const COOLDOWN_MS = 5 * 60 * 1000;
const CONFIRM_WINDOW_MS = 5 * 60 * 1000;

// Backstop for the per-domain one-shot alarms: runs every minute and
// advances anything whose timer has already expired. Covers cases where an
// individual alarm never fires (missed wake, sleep, etc.). A tab actually
// showing the stump page also self-heals via its own poll loop; this is
// only needed when no tab is open to notice.
chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 1 });

// Dynamic rules registered via updateDynamicRules persist independently of
// this script and survive extension reloads. If a rule ever gets added
// without a matching entry landing in chrome.storage (e.g. an interrupted
// update during earlier development), it becomes an orphan: still
// redirecting its domain forever, invisible to and unremovable by any of
// our domain-keyed logic, since that only ever looks up rules by the id it
// has on file. Purge anything not currently tracked on every startup so
// state and the live ruleset can never drift apart for long.
async function cleanupOrphanedRules() {
  const { sites } = await getState();
  const trackedIds = new Set(Object.values(sites).map((s) => s.ruleId));
  const registered = await chrome.declarativeNetRequest.getDynamicRules();
  const orphanedIds = registered.map((r) => r.id).filter((id) => !trackedIds.has(id));
  if (orphanedIds.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: orphanedIds });
    console.log('Site Blocker: removed orphaned rules', orphanedIds);
  }
}
cleanupOrphanedRules();

async function sweepExpiredSites() {
  const { sites } = await getState();
  const now = Date.now();

  for (const [domain, site] of Object.entries(sites)) {
    if (site.status === 'pending' && site.unblockAt <= now) {
      await graduateToConfirm(domain);
    } else if (site.status === 'confirm' && site.confirmUntil <= now) {
      await expireConfirmWindow(domain);
    }
  }
}

// No public-suffix list bundled, so multi-part TLDs (e.g. "co.uk") are
// approximated by a short hardcoded list rather than matched exactly.
const SHORT_SUFFIXES = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

function getRegistrableDomain(hostname) {
  const parts = hostname.toLowerCase().replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (last.length === 2 && SHORT_SUFFIXES.has(secondLast)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

async function getState() {
  const { sites = {}, nextRuleId = 1 } = await chrome.storage.local.get(['sites', 'nextRuleId']);
  return { sites, nextRuleId };
}

async function saveState(state) {
  await chrome.storage.local.set(state);
}

function blockedPageUrl(domain) {
  return chrome.runtime.getURL(`blocked.html?${new URLSearchParams({ domain })}`);
}

function buildRule(id, domain) {
  // blocked.html polls the background for live status/timing itself, so the
  // redirect target only needs to identify the domain — it doesn't need to
  // change across 'blocked' / 'pending' / 'confirm'.
  return {
    id,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: { url: blockedPageUrl(domain) }
    },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: ['main_frame']
    }
  };
}

// The stored nextRuleId counter can drift from what's actually registered
// (e.g. a rule survives an extension reload that wiped chrome.storage).
// Cross-check against the live dynamic ruleset so we never try to reuse
// an id that's already taken by something else.
async function allocateRuleId(preferredId) {
  const registered = await chrome.declarativeNetRequest.getDynamicRules();
  const used = new Set(registered.map((r) => r.id));
  let id = preferredId;
  while (used.has(id)) id++;
  return id;
}

function clearTimers(domain) {
  chrome.alarms.clear(COOLDOWN_PREFIX + domain);
  chrome.alarms.clear(CONFIRM_PREFIX + domain);
}

async function blockSite(domain) {
  const state = await getState();
  const existing = state.sites[domain];
  const ruleId = existing ? existing.ruleId : await allocateRuleId(state.nextRuleId);

  if (existing) {
    // Rule already redirects this domain to blocked.html — no DNR change
    // needed, just cancel any in-flight timers and flip status back.
    clearTimers(domain);
  } else {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleId],
      addRules: [buildRule(ruleId, domain)]
    });
    state.nextRuleId = ruleId + 1;
  }

  state.sites[domain] = { status: 'blocked', ruleId };
  await saveState(state);
}

// Phase 1: user clicked "Unblock current site". Starts the cooldown before
// the confirm window even opens.
async function unblockSite(domain) {
  const state = await getState();
  const existing = state.sites[domain];
  if (!existing) return;

  const unblockAt = Date.now() + COOLDOWN_MS;
  state.sites[domain] = { status: 'pending', ruleId: existing.ruleId, unblockAt };
  await saveState(state);

  chrome.alarms.create(COOLDOWN_PREFIX + domain, { when: unblockAt });
  console.log('Site Blocker: cooldown started for', domain, '- confirm window opens at', new Date(unblockAt).toLocaleTimeString());
}

// Phase 2: cooldown elapsed. Opens a limited window during which the user
// must actively confirm, rather than unblocking automatically.
async function graduateToConfirm(domain) {
  const state = await getState();
  const existing = state.sites[domain];
  if (!existing || existing.status !== 'pending') return;

  const confirmUntil = Date.now() + CONFIRM_WINDOW_MS;
  state.sites[domain] = { status: 'confirm', ruleId: existing.ruleId, confirmUntil };
  await saveState(state);

  chrome.alarms.create(CONFIRM_PREFIX + domain, { when: confirmUntil });
  console.log('Site Blocker: confirm window open for', domain, 'until', new Date(confirmUntil).toLocaleTimeString());
}

// User clicked "Unblock the site" during the confirm window: this is the
// only path that actually removes the block.
async function confirmUnblock(domain) {
  const state = await getState();
  const existing = state.sites[domain];
  if (!existing || existing.status !== 'confirm') return false;

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [existing.ruleId]
  });

  delete state.sites[domain];
  await saveState(state);
  clearTimers(domain);
  console.log('Site Blocker: confirmed unblock for', domain);
  return true;
}

// Confirm window ran out with no click: the opportunity is missed, back to
// square one (still blocked, same rule, no timers running).
async function expireConfirmWindow(domain) {
  const state = await getState();
  const existing = state.sites[domain];
  if (!existing || existing.status !== 'confirm') return;

  state.sites[domain] = { status: 'blocked', ruleId: existing.ruleId };
  await saveState(state);
  clearTimers(domain);
  console.log('Site Blocker: confirm window missed for', domain, '- reblocked');
}

// Backstop for navigations that never go through declarativeNetRequest at
// all — notably Chrome's page preloading/prerendering, which can render a
// page in a hidden background tab (e.g. from address-bar autocomplete) and
// then just activate it, with no fresh network request for our redirect
// rule to catch. onCommitted fires for the real, visible top-level
// navigation regardless of how it got there, so re-check it here and force
// the redirect ourselves if DNR missed it.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return; // top-level frame only

  let domain;
  try {
    domain = getRegistrableDomain(new URL(details.url).hostname);
  } catch {
    return; // not an http(s) URL (e.g. chrome:// pages)
  }

  const { sites } = await getState();
  const site = sites[domain];
  if (!site) return;

  if (details.url !== blockedPageUrl(domain)) {
    console.log('Site Blocker: webNavigation backstop caught a DNR miss for', domain);
    chrome.tabs.update(details.tabId, { url: blockedPageUrl(domain) });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (alarm.name === SWEEP_ALARM) {
      await sweepExpiredSites();
      return;
    }
    if (alarm.name.startsWith(COOLDOWN_PREFIX)) {
      await graduateToConfirm(alarm.name.slice(COOLDOWN_PREFIX.length));
      return;
    }
    if (alarm.name.startsWith(CONFIRM_PREFIX)) {
      await expireConfirmWindow(alarm.name.slice(CONFIRM_PREFIX.length));
      return;
    }
  } catch (err) {
    // These are one-shot alarms — if the handler throws and nothing catches
    // it, the domain could get stuck with no retry. The 1-minute sweep
    // alarm is the backstop for exactly this.
    console.error('Site Blocker: alarm handler failed', alarm.name, err);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case 'getStatusForUrl': {
          const domain = getRegistrableDomain(new URL(message.url).hostname);
          const { sites } = await getState();
          sendResponse({ domain, site: sites[domain] || null });
          break;
        }
        case 'block': {
          const domain = getRegistrableDomain(new URL(message.url).hostname);
          await blockSite(domain);
          sendResponse({ ok: true, domain });
          break;
        }
        case 'unblock': {
          await unblockSite(message.domain);
          sendResponse({ ok: true });
          break;
        }
        case 'confirmUnblock': {
          const ok = await confirmUnblock(message.domain);
          sendResponse({ ok });
          break;
        }
        case 'expireConfirm': {
          await expireConfirmWindow(message.domain);
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown action' });
      }
    } catch (err) {
      // Always respond, even on failure — otherwise the sender's
      // sendMessage() promise hangs forever instead of rejecting.
      console.error('Site Blocker background error:', err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true;
});
