/**
 * AEP Consent Analyzer - Chrome Extension Background Service Worker (Manifest V3)
 *
 * - Tracks per-tab AEP Web SDK snapshots & Edge Network events
 * - Reads all browser cookies for the inspected tab via `chrome.cookies.getAll`
 * - Updates the extension toolbar badge (`IN`, `OUT`, `PEND`, or empty)
 */
import { analyzeCookies, evaluateVisitorConsentState } from './src/core/consent-engine.js';

const tabSnapshots = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.action === 'PAGE_EVENT' && sender.tab?.id) {
    const tabId = sender.tab.id;
    if (message.type === 'STATE_UPDATE' || message.type === 'SNAPSHOT_RESPONSE') {
      tabSnapshots.set(tabId, message.payload);
      updateBadgeForTab(tabId, sender.tab.url, message.payload);
    }
    return false;
  }

  if (message.action === 'INSPECT_TAB') {
    const targetTabId = message.tabId;
    inspectTabById(targetTabId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});

async function inspectTabById(tabId) {
  let tab = null;
  if (tabId) {
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      tab = null;
    }
  }
  if (!tab) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = activeTab;
  }

  if (!tab || !tab.id) {
    throw new Error('No active browser tab found.');
  }

  // 1. Request fresh snapshot from content script
  let snapshot = tabSnapshots.get(tab.id) || null;
  if (tab.url && /^https?:/i.test(tab.url)) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'GET_PAGE_SNAPSHOT' });
      if (response?.ok && response.snapshot) {
        snapshot = response.snapshot;
        tabSnapshots.set(tab.id, snapshot);
      }
    } catch {
      // Content script might not be injected if tab was open before extension install
    }
  }

  // 2. Read full cookies via chrome.cookies API (includes expirationDate, domain, sameSite, httpOnly)
  let chromeCookies = [];
  if (tab.url && /^https?:/i.test(tab.url)) {
    try {
      chromeCookies = await chrome.cookies.getAll({ url: tab.url });
    } catch {
      chromeCookies = [];
    }
  }

  if (snapshot) {
    updateBadgeForTab(tab.id, tab.url, snapshot, chromeCookies);
  }

  return {
    tab: {
      id: tab.id,
      url: tab.url,
      title: tab.title
    },
    snapshot,
    chromeCookies
  };
}

async function updateBadgeForTab(tabId, url, snapshot, existingCookies = null) {
  try {
    let cookies = existingCookies;
    if (!cookies && url && /^https?:/i.test(url)) {
      cookies = await chrome.cookies.getAll({ url });
    }
    const cookieInput =
      cookies && cookies.length > 0 ? cookies : snapshot?.documentCookie || '';
    const cookieAnalysis = analyzeCookies(cookieInput);
    const evaluation = evaluateVisitorConsentState({
      cookieAnalysis,
      sdkInfo: snapshot?.sdkInfo || {},
      edgeEvents: snapshot?.edgeEvents || [],
      tcfState: snapshot?.tcfData || null
    });

    let badgeText = '';
    let badgeColor = '#64748b';

    if (evaluation.effectiveState === 'opted-in') {
      badgeText = 'IN';
      badgeColor = '#10b981';
    } else if (evaluation.effectiveState === 'opted-out') {
      badgeText = 'OUT';
      badgeColor = '#ef4444';
    } else if (evaluation.effectiveState === 'pending') {
      badgeText = 'PEND';
      badgeColor = '#f59e0b';
    }

    await chrome.action.setBadgeText({ tabId, text: badgeText });
    if (badgeText) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: badgeColor });
    }
  } catch {
    // ignore badge errors on closed tabs
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabSnapshots.delete(tabId);
});
