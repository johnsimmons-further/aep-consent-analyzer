/**
 * AEP Consent Analyzer - Isolated Content Script Bridge
 *
 * Bridges messages between the MAIN-world `page-hook.js` and the Chrome Extension
 * service worker (`background.js`) / popup UI.
 */
(function initContentScriptBridge() {
  let latestPageSnapshot = null;

  // Forward messages from MAIN-world page-hook.js to background service worker
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source !== 'AEP_CONSENT_ANALYZER_PAGE') return;

    const { type, payload, timestamp } = event.data;
    if (type === 'STATE_UPDATE' || type === 'SNAPSHOT_RESPONSE') {
      latestPageSnapshot = payload;
    }

    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
      chrome.runtime
        .sendMessage({
          action: 'PAGE_EVENT',
          type,
          payload,
          timestamp
        })
        .catch(() => {
          // Popup or background may not be listening right now
        });
    }
  });

  // Listen for requests from Popup / SidePanel / Background
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== 'object') return false;

      if (message.action === 'GET_PAGE_SNAPSHOT') {
        const handleSnapshot = (event) => {
          if (
            event.source === window &&
            event.data?.source === 'AEP_CONSENT_ANALYZER_PAGE' &&
            event.data?.type === 'SNAPSHOT_RESPONSE'
          ) {
            window.removeEventListener('message', handleSnapshot);
            sendResponse({ ok: true, snapshot: event.data.payload });
          }
        };
        window.addEventListener('message', handleSnapshot);

        // Request fresh snapshot from page-hook.js
        window.postMessage(
          {
            source: 'AEP_CONSENT_ANALYZER_EXTENSION',
            type: 'REQUEST_SNAPSHOT'
          },
          '*'
        );

        // Fallback timeout if MAIN world hasn't responded within 450ms
        setTimeout(() => {
          window.removeEventListener('message', handleSnapshot);
          sendResponse({
            ok: true,
            snapshot: latestPageSnapshot || {
              url: window.location.href,
              hostname: window.location.hostname,
              title: document.title,
              documentCookie: document.cookie,
              sdkInfo: { alloyDetected: false },
              edgeEvents: [],
              cmpDetected: []
            }
          });
        }, 450);

        return true; // keep async message channel open
      }

      if (message.action === 'EXECUTE_SET_CONSENT') {
        window.postMessage(
          {
            source: 'AEP_CONSENT_ANALYZER_EXTENSION',
            type: 'EXECUTE_SET_CONSENT',
            payload: message.payload
          },
          '*'
        );
        sendResponse({ ok: true });
        return false;
      }

      return false;
    });
  }
})();
