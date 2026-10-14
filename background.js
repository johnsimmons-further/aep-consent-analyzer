/**
 * AEP Consent Analyzer - Chrome Extension Background Service Worker (Manifest V3)
 *
 * - Tracks per-tab AEP Web SDK snapshots & Edge Network events
 * - Reads all browser cookies for the inspected tab via `chrome.cookies.getAll`
 * - Updates the extension toolbar badge (`IN`, `OUT`, `PEND`, or empty)
 */
import { analyzeCookies, evaluateVisitorConsentState } from './src/core/consent-engine.js';

const tabSnapshots = new Map();
const tabEdgeEvents = new Map();

function isEdgeNetworkUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return (
    /\/ee\/(?:[^/?#]+\/)*v[12]\/(privacy\/set-consent|interact|collect)\b/i.test(url) ||
    /\/v[12]\/(privacy\/set-consent|interact|collect)\b/i.test(url) ||
    url.includes('adobedc.net')
  );
}

// Observe AEP Edge Network requests out-of-process so we never monkey-patch window.fetch in pages
if (chrome.webRequest?.onBeforeRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0 || !isEdgeNetworkUrl(details.url)) return;

      let bodyText = null;
      if (details.requestBody?.raw?.length) {
        try {
          const decoder = new TextDecoder('utf-8');
          bodyText =
            details.requestBody.raw
              .map((part) => (part.bytes ? decoder.decode(part.bytes, { stream: true }) : ''))
              .join('') + decoder.decode();
        } catch {
          bodyText = null;
        }
      }

      let endpointType = 'edge-request';
      if (details.url.includes('privacy/set-consent')) endpointType = 'set-consent';
      else if (details.url.includes('/interact')) endpointType = 'interact';
      else if (details.url.includes('/collect')) endpointType = 'collect';

      let datastreamId = null;
      try {
        const parsedUrl = new URL(details.url);
        datastreamId =
          parsedUrl.searchParams.get('configId') ||
          parsedUrl.searchParams.get('datastreamId') ||
          null;
      } catch {
        // ignore URL parse error
      }

      let parsedBody = null;
      if (bodyText) {
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          parsedBody = { raw: bodyText.slice(0, 1000) };
        }
      }

      const eventRecord = {
        id: `edge_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toISOString(),
        source: 'Edge Network (webRequest)',
        type: endpointType,
        url: details.url,
        datastreamId,
        payload: parsedBody
      };

      const existing = tabEdgeEvents.get(details.tabId) || [];
      existing.push(eventRecord);
      if (existing.length > 50) existing.shift();
      tabEdgeEvents.set(details.tabId, existing);

      // Forward to page-hook so command history & datastreamId stay synchronized
      chrome.tabs
        .sendMessage(details.tabId, {
          action: 'FORWARD_EDGE_HIT',
          payload: {
            url: details.url,
            body: bodyText,
            transport: 'webRequest'
          }
        })
        .catch(() => {});
    },
    { urls: ['<all_urls>'] },
    ['requestBody']
  );
}

function mergeSnapshotWithEdgeEvents(tabId, snapshot) {
  if (!snapshot) return snapshot;
  const bgEvents = tabEdgeEvents.get(tabId) || [];
  if (bgEvents.length === 0) return snapshot;

  const pageEvents = Array.isArray(snapshot.edgeEvents) ? snapshot.edgeEvents : [];
  const merged = [...pageEvents];
  for (const bgEv of bgEvents) {
    const isDup = merged.some(
      (pEv) =>
        pEv.type === bgEv.type &&
        Math.abs(Date.parse(pEv.timestamp) - Date.parse(bgEv.timestamp)) < 1500
    );
    if (!isDup) {
      merged.push(bgEv);
    }
  }

  return {
    ...snapshot,
    sdkInfo: {
      ...(snapshot.sdkInfo || {}),
      alloyDetected: true,
      datastreamId:
        snapshot.sdkInfo?.datastreamId ||
        bgEvents[bgEvents.length - 1]?.datastreamId ||
        null
    },
    edgeEvents: merged
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.action === 'PAGE_EVENT' && sender.tab?.id) {
    const tabId = sender.tab.id;
    if (message.type === 'STATE_UPDATE' || message.type === 'SNAPSHOT_RESPONSE') {
      const merged = mergeSnapshotWithEdgeEvents(tabId, message.payload);
      tabSnapshots.set(tabId, merged);
      updateBadgeForTab(tabId, sender.tab.url, merged);
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
      }
    } catch {
      // Content script might not be injected if tab was open before extension install
    }
  }

  snapshot = mergeSnapshotWithEdgeEvents(tab.id, snapshot);
  if (snapshot) {
    tabSnapshots.set(tab.id, snapshot);
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
  tabEdgeEvents.delete(tabId);
});
