/**
 * AEP Consent Analyzer - Page Hook (MAIN World)
 *
 * Runs in the page's MAIN execution context at `document_start` to:
 * 1. Intercept Adobe Experience Platform Web SDK (`alloy`) commands:
 *    - `configure` (captures `defaultConsent`, `orgId`, `datastreamId` / `edgeConfigId`)
 *    - `setConsent` (captures Adobe 1.0, Adobe 2.0 XDM `consents`, and IAB TCF 2.0 payloads)
 *    - `sendEvent` (tracks whether events are queued while `defaultConsent === "pending"` or dispatched)
 * 2. Intercept Adobe Edge Network HTTP requests (`fetch`, `XMLHttpRequest`, `navigator.sendBeacon`)
 *    matching `/ee/` or `/v1/privacy/set-consent`, `/v1/interact`, `/v1/collect`.
 * 3. Inspect CMP APIs (`__tcfapi`, `OneTrust`, `OptanonActiveGroups`, `__uspapi`, `adobeDataLayer`).
 */
(function initAepConsentPageHook() {
  if (window.__AEP_CONSENT_HOOK_INSTALLED__) return;
  window.__AEP_CONSENT_HOOK_INSTALLED__ = true;

  const state = {
    alloyDetected: false,
    instanceNames: [],
    orgId: null,
    datastreamId: null,
    edgeDomain: null,
    defaultConsent: null,
    libraryVersion: null,
    ecid: null,
    queuedCommands: [],
    commandHistory: [],
    edgeEvents: [],
    tcfData: null,
    cmpDetected: [],
    launchConfigBindings: {},
    resolvedDataElements: {}
  };

  function emitToExtension(type, payload) {
    window.postMessage(
      {
        source: 'AEP_CONSENT_ANALYZER_PAGE',
        type,
        payload,
        timestamp: new Date().toISOString()
      },
      '*'
    );
  }

  function recordCommand(instanceName, command, options, status = 'called') {
    const entry = {
      id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      instanceName,
      command,
      options: safeClone(options),
      status
    };

    if (command === 'configure' && options && typeof options === 'object') {
      state.alloyDetected = true;
      state.orgId = options.orgId || state.orgId;
      state.datastreamId = options.datastreamId || options.edgeConfigId || state.datastreamId;
      state.edgeDomain = options.edgeDomain || state.edgeDomain;
      state.defaultConsent = options.defaultConsent || state.defaultConsent || 'in'; // Alloy defaults to "in" if omitted
    }

    if (command === 'setConsent') {
      state.alloyDetected = true;
      // Once setConsent is called, previously queued commands are flushed or dropped
      const generalOrCollect = extractConsentIntent(options);
      state.queuedCommands.forEach((q) => {
        q.status = generalOrCollect === 'out' ? 'dropped-by-opt-out' : 'flushed-after-consent';
      });
      state.queuedCommands = [];
      state.edgeEvents.push({
        id: entry.id,
        timestamp: entry.timestamp,
        source: `alloy("${command}")`,
        type: 'set-consent',
        command: 'setConsent',
        orgId: state.orgId,
        datastreamId: state.datastreamId,
        payload: safeClone(options)
      });
    }

    if (command === 'sendEvent') {
      state.alloyDetected = true;
      const hasConsentCookie = /kndctr_[^=]+_AdobeOrg_consent=/.test(document.cookie);
      if (state.defaultConsent === 'pending' && !hasConsentCookie) {
        entry.status = 'queued-pending-consent';
        state.queuedCommands.push(entry);
      }
    }

    state.commandHistory.push(entry);
    if (state.commandHistory.length > 50) state.commandHistory.shift();

    emitToExtension('STATE_UPDATE', buildSnapshot());
  }

  function extractConsentIntent(options) {
    if (!options || typeof options !== 'object') return 'unknown';
    const arr = Array.isArray(options.consent) ? options.consent : [options.consent];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const val = item.value;
      if (val?.general === 'out' || val?.general?.val === 'out') return 'out';
      if (val?.general === 'in' || val?.general?.val === 'in') return 'in';
      const collectVal = val?.collect?.val || val?.consents?.collect?.val;
      if (collectVal === 'n' || collectVal === 'dn' || collectVal === 'LO') return 'out';
      if (collectVal) return 'in';
    }
    return 'unknown';
  }

  function wrapAlloyFunction(fn, name) {
    if (!fn || fn.__aepConsentWrapped) return fn;
    const wrapped = function (...args) {
      try {
        const [command, options] = args;
        if (typeof command === 'string') {
          recordCommand(name, command, options);
        }
      } catch {
        // ignore hook errors
      }
      return fn.apply(this, args);
    };
    wrapped.__aepConsentWrapped = true;
    // Copy properties (like .q queue)
    try {
      Object.assign(wrapped, fn);
    } catch {
      // ignore
    }
    return wrapped;
  }

  function scanAndHookAlloy() {
    const names = new Set(['alloy']);
    if (Array.isArray(window.__alloyNS)) {
      window.__alloyNS.forEach((n) => names.add(n));
      state.alloyDetected = true;
    }

    for (const name of names) {
      if (typeof window[name] === 'function') {
        state.alloyDetected = true;
        if (!state.instanceNames.includes(name)) {
          state.instanceNames.push(name);
        }
        // Inspect existing .q queue if SDK hasn't loaded yet
        if (Array.isArray(window[name].q)) {
          window[name].q.forEach((queuedArgs) => {
            if (Array.isArray(queuedArgs) && typeof queuedArgs[0] === 'string') {
              recordCommand(name, queuedArgs[0], queuedArgs[1], 'pre-queue');
            }
          });
        }
        if (!window[name].__aepConsentWrapped) {
          window[name] = wrapAlloyFunction(window[name], name);
        }
      }
    }
  }

  // Hook Edge Network URLs (`fetch`, `XMLHttpRequest`, `navigator.sendBeacon`)
  function isEdgeNetworkUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return (
      /\/ee\/(?:[^/?#]+\/)*v[12]\/(privacy\/set-consent|interact|collect)\b/i.test(url) ||
      /\/v[12]\/(privacy\/set-consent|interact|collect)\b/i.test(url) ||
      url.includes('adobedc.net')
    );
  }

  function parseEdgeRequest(url, bodyText, transport = 'fetch') {
    if (!isEdgeNetworkUrl(url)) return;
    state.alloyDetected = true;

    let endpointType = 'edge-request';
    if (url.includes('privacy/set-consent')) endpointType = 'set-consent';
    else if (url.includes('/interact')) endpointType = 'interact';
    else if (url.includes('/collect')) endpointType = 'collect';

    let datastreamId = state.datastreamId;
    try {
      const parsedUrl = new URL(url, window.location.origin);
      if (parsedUrl.hostname && !state.edgeDomain) {
        state.edgeDomain = parsedUrl.hostname;
      }
      datastreamId =
        parsedUrl.searchParams.get('configId') ||
        parsedUrl.searchParams.get('datastreamId') ||
        datastreamId;
      if (datastreamId) state.datastreamId = datastreamId;
    } catch {
      // ignore URL parse error
    }

    let parsedBody = null;
    if (bodyText && typeof bodyText === 'string') {
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        parsedBody = { raw: bodyText.slice(0, 1000) };
      }
    } else if (bodyText && typeof bodyText === 'object') {
      parsedBody = safeClone(bodyText);
    }

    // If Adobe Launch invoked its internal Alloy closure rather than window.alloy,
    // ensure our commandHistory and queue state also reflect this Edge Network call.
    const nowMs = Date.now();
    const recentDuplicate = state.commandHistory.find(
      (c) =>
        nowMs - Date.parse(c.timestamp) < 800 &&
        ((endpointType === 'set-consent' && c.command === 'setConsent') ||
          (endpointType === 'interact' && c.command === 'sendEvent'))
    );

    if (!recentDuplicate && parsedBody) {
      if (endpointType === 'set-consent' && parsedBody.consent) {
        const generalIntent = extractConsentIntent(parsedBody);
        state.queuedCommands.forEach((q) => {
          q.status = generalIntent === 'out' ? 'dropped-by-opt-out' : 'flushed-after-consent';
        });
        state.queuedCommands = [];
        state.commandHistory.push({
          id: `cmd_edge_${nowMs}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          instanceName: state.instanceNames[0] || 'alloy',
          command: 'setConsent',
          options: { consent: safeClone(parsedBody.consent) },
          status: `dispatched (${generalIntent !== 'unknown' ? `general=${generalIntent}` : 'Edge'})`
        });
      } else if (endpointType === 'interact' && Array.isArray(parsedBody.events)) {
        state.commandHistory.push({
          id: `cmd_edge_${nowMs}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          instanceName: state.instanceNames[0] || 'alloy',
          command: 'sendEvent',
          options: safeClone(parsedBody.events[0] || parsedBody),
          status: 'dispatched-to-edge'
        });
      }
      if (state.commandHistory.length > 50) state.commandHistory.shift();
    }

    const eventRecord = {
      id: `edge_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      source: `Edge Network (${transport})`,
      type: endpointType,
      url,
      datastreamId,
      orgId: state.orgId,
      payload: parsedBody
    };

    state.edgeEvents.push(eventRecord);
    if (state.edgeEvents.length > 50) state.edgeEvents.shift();

    emitToExtension('EDGE_NETWORK_HIT', eventRecord);
    emitToExtension('STATE_UPDATE', buildSnapshot());
  }

  // Note: We intentionally do NOT monkey-patch global window.fetch, XMLHttpRequest, or
  // navigator.sendBeacon in the page context, because doing so places page-hook.js in the
  // call stack of unrelated third-party requests that may violate a site's Content Security Policy.
  // Instead, Edge Network HTTP requests are observed out-of-process by background.js via chrome.webRequest.

  /**
   * Resolve any `%something here%` Adobe Tags / Launch Data Element syntax using `_satellite.getVar('something here')`
   */
  function resolveLaunchSetting(rawValue, sat, resolvedMap) {
    if (typeof rawValue !== 'string') {
      return {
        raw: rawValue ?? null,
        resolved: rawValue ?? null,
        isDataElement: false,
        tokens: []
      };
    }

    const tokenRegex = /%([^%]+)%/g;
    const tokens = [];
    let match;
    while ((match = tokenRegex.exec(rawValue)) !== null) {
      const fullToken = match[0];
      const deName = match[1];
      let val = undefined;
      if (sat && typeof sat.getVar === 'function') {
        try {
          val = sat.getVar(deName);
          if (val === undefined && deName.trim() !== deName) {
            val = sat.getVar(deName.trim());
          }
        } catch {
          // ignore _satellite.getVar errors
        }
      }
      const clonedVal = safeClone(val);
      if (resolvedMap && deName) {
        resolvedMap[deName] = clonedVal;
      }
      tokens.push({
        token: fullToken,
        name: deName,
        value: clonedVal
      });
    }

    if (tokens.length === 0) {
      return {
        raw: rawValue,
        resolved: rawValue,
        isDataElement: false,
        tokens: []
      };
    }

    const resolvedValue = rawValue.replace(/%([^%]+)%/g, (full, deName) => {
      const entry = tokens.find((t) => t.name === deName);
      if (entry && entry.value !== undefined && entry.value !== null) {
        return typeof entry.value === 'object' ? JSON.stringify(entry.value) : String(entry.value);
      }
      return full;
    });

    return {
      raw: rawValue,
      resolved: resolvedValue,
      isDataElement: true,
      tokens
    };
  }

  function scanObjectForLaunchTokens(obj, sat, resolvedMap, depth = 0) {
    if (!obj || depth > 5) return;
    if (typeof obj === 'string') {
      if (/%[^%]+%/.test(obj)) {
        resolveLaunchSetting(obj, sat, resolvedMap);
      }
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((item) => scanObjectForLaunchTokens(item, sat, resolvedMap, depth + 1));
      return;
    }
    if (typeof obj === 'object') {
      Object.values(obj).forEach((val) =>
        scanObjectForLaunchTokens(val, sat, resolvedMap, depth + 1)
      );
    }
  }

  /**
   * Inspect Adobe Tags / Launch (`window._satellite`) & Event-Driven Data Layer (`window.appEventData`)
   * Captures configuration on sites like https://further.ai/ and https://www.redhat.com/ where `adobe-alloy` is managed by Launch
   */
  function inspectAdobeLaunchAndDataLayer() {
    try {
      const sat = window._satellite;
      if (sat && typeof sat === 'object') {
        const container = sat._container || (typeof sat.container === 'object' ? sat.container : null);
        if (container) {
          const stage = (container.environment?.stage || 'production').toLowerCase();
          const alloyExt = container.extensions?.['adobe-alloy'];
          const instances = alloyExt?.settings?.instances;
          if (Array.isArray(instances) && instances.length > 0) {
            const inst = instances[0];
            state.alloyDetected = true;
            if (inst.name && !state.instanceNames.includes(inst.name)) {
              state.instanceNames.push(inst.name);
            }

            const rawDsId =
              stage === 'development'
                ? inst.developmentEdgeConfigId ||
                  inst.stagingEdgeConfigId ||
                  inst.edgeConfigId ||
                  inst.datastreamId
                : stage === 'staging'
                ? inst.stagingEdgeConfigId || inst.edgeConfigId || inst.datastreamId
                : inst.edgeConfigId ||
                  inst.stagingEdgeConfigId ||
                  inst.developmentEdgeConfigId ||
                  inst.datastreamId;

            const orgBinding = resolveLaunchSetting(
              inst.orgId || sat.company?.orgId,
              sat,
              state.resolvedDataElements
            );
            const edgeDomainBinding = resolveLaunchSetting(
              inst.edgeDomain,
              sat,
              state.resolvedDataElements
            );
            const dsBinding = resolveLaunchSetting(rawDsId, sat, state.resolvedDataElements);
            const consentBinding = resolveLaunchSetting(
              inst.defaultConsent,
              sat,
              state.resolvedDataElements
            );

            state.launchConfigBindings = {
              orgId: orgBinding,
              edgeDomain: edgeDomainBinding,
              datastreamId: dsBinding,
              defaultConsent: consentBinding
            };

            state.orgId = orgBinding.raw || state.orgId;
            state.edgeDomain = edgeDomainBinding.raw || state.edgeDomain;
            state.datastreamId = dsBinding.raw || state.datastreamId;
            state.defaultConsent = consentBinding.raw || state.defaultConsent || 'in';

            // Scan any other settings inside the Alloy extension instance
            scanObjectForLaunchTokens(inst, sat, state.resolvedDataElements);
          }

          // Also scan Adobe Alloy rule actions for %dataElement% tokens (e.g., %AEP Consent%)
          if (Array.isArray(container.rules)) {
            container.rules.forEach((rule) => {
              if (Array.isArray(rule?.actions)) {
                rule.actions.forEach((act) => {
                  if (
                    typeof act?.modulePath === 'string' &&
                    act.modulePath.includes('adobe-alloy')
                  ) {
                    scanObjectForLaunchTokens(act.settings, sat, state.resolvedDataElements);
                  }
                });
              }
            });
          }

          // Also resolve if state fields themselves contain %...% tokens
          ['orgId', 'datastreamId', 'defaultConsent', 'edgeDomain'].forEach((key) => {
            if (typeof state[key] === 'string' && /%[^%]+%/.test(state[key])) {
              const binding = resolveLaunchSetting(state[key], sat, state.resolvedDataElements);
              state.launchConfigBindings[key] = binding;
            }
          });

          let aepConsentVar = undefined;
          let onetrustGroupsVar = undefined;
          let ecidVar = undefined;
          if (typeof sat.getVar === 'function') {
            try {
              if (container.dataElements?.['AEP Consent']) {
                aepConsentVar = sat.getVar('AEP Consent');
                state.resolvedDataElements['AEP Consent'] = safeClone(aepConsentVar);
              }
            } catch {
              // ignore
            }
            try {
              if (container.dataElements?.['OnetrustActiveGroups']) {
                onetrustGroupsVar = sat.getVar('OnetrustActiveGroups');
                state.resolvedDataElements['OnetrustActiveGroups'] = safeClone(onetrustGroupsVar);
              }
            } catch {
              // ignore
            }
            try {
              if (container.dataElements?.['ECID']) {
                ecidVar = sat.getVar('ECID');
                state.resolvedDataElements['ECID'] = safeClone(ecidVar);
              }
            } catch {
              // ignore
            }
          }

          state.launchInfo = {
            propertyName: container.property?.name || null,
            propertyId: container.property?.id || null,
            environment: container.environment?.stage || null,
            buildDate: container.buildInfo?.buildDate || null,
            turbineVersion: container.buildInfo?.turbineVersion || null,
            aepConsentDataElement: aepConsentVar ?? null,
            onetrustActiveGroupsDataElement: onetrustGroupsVar || window.OnetrustActiveGroups || null,
            ecidDataElement: ecidVar ?? null
          };
        }
      }

      // Inspect Event-Driven Data Layer (`window.appEventData` used on further.ai / redhat.com)
      if (Array.isArray(window.appEventData)) {
        const consentEvents = window.appEventData.filter(
          (item) =>
            item &&
            typeof item === 'object' &&
            typeof item.event === 'string' &&
            item.event.toLowerCase().includes('consent')
        );
        if (consentEvents.length > 0) {
          state.dataLayerConsentEvents = safeClone(consentEvents);
        }
      }
    } catch {
      // ignore Launch inspection errors
    }
  }

  function inspectCmpAndTcf() {
    const cmps = [];
    if (typeof window.__tcfapi === 'function') {
      cmps.push('IAB TCF 2.0 (__tcfapi)');
      try {
        window.__tcfapi('getTCData', 2, (tcData, success) => {
          if (success && tcData) {
            const vendor565 = Boolean(tcData.vendor?.consents?.[565] || tcData.vendor?.consents?.['565']);
            state.tcfData = {
              tcString: tcData.tcString || null,
              gdprApplies: tcData.gdprApplies,
              eventStatus: tcData.eventStatus,
              cmpId: tcData.cmpId,
              cmpVersion: tcData.cmpVersion,
              vendor565Consent: vendor565,
              purposeConsents: tcData.purpose?.consents || {}
            };
          }
        });
      } catch {
        // ignore
      }
    }
    const otGroups = window.OnetrustActiveGroups || window.OptanonActiveGroups;
    if (window.OneTrust || otGroups) {
      const hasC0002 = typeof otGroups === 'string' && otGroups.includes('C0002');
      cmps.push(
        `OneTrust (${otGroups ? `Groups: ${otGroups} -> C0002=${hasC0002 ? 'in' : 'out'}` : 'detected'})`
      );
    }
    if (window._satellite) {
      const propName = window._satellite._container?.property?.name;
      cmps.push(`Adobe Tags / Launch${propName ? ` (${propName})` : ''}`);
    }
    if (Array.isArray(window.appEventData)) {
      cmps.push(`Data Layer Manager (appEventData)`);
    }
    if (typeof window.__uspapi === 'function') {
      cmps.push('IAB USPrivacy (__uspapi)');
    }
    if (typeof window.__gpp === 'function') {
      cmps.push('IAB GPP (__gpp)');
    }
    if (window.Cookiebot) {
      cmps.push('Cookiebot');
    }
    if (window.truste || window.PrivacyManagerAPI) {
      cmps.push('TrustArc');
    }
    state.cmpDetected = cmps;
  }

  async function queryAlloyRuntimeInfo() {
    scanAndHookAlloy();
    inspectAdobeLaunchAndDataLayer();
    const primaryName = state.instanceNames[0] || (typeof window.alloy === 'function' ? 'alloy' : null);
    if (!primaryName || typeof window[primaryName] !== 'function') return;

    try {
      const libRes = await Promise.race([
        window[primaryName]('getLibraryInfo'),
        new Promise((resolve) => setTimeout(() => resolve(null), 350))
      ]);
      if (libRes?.libraryInfo) {
        state.libraryVersion = libRes.libraryInfo.version || state.libraryVersion;
        const cfg = libRes.libraryInfo.configs || {};
        state.orgId = state.orgId || cfg.orgId;
        state.datastreamId = state.datastreamId || cfg.datastreamId || cfg.edgeConfigId;
        state.edgeDomain = state.edgeDomain || cfg.edgeDomain;
        state.defaultConsent = state.defaultConsent || cfg.defaultConsent;
      }
    } catch {
      // ignore if getLibraryInfo is unsupported or pending
    }
  }

  function safeClone(obj) {
    if (obj === undefined) return undefined;
    if (obj === null || typeof obj !== 'object') return obj;
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch {
      return String(obj);
    }
  }

  function buildSnapshot() {
    scanAndHookAlloy();
    inspectAdobeLaunchAndDataLayer();
    inspectCmpAndTcf();

    // Update queued status based on current cookie
    const hasConsentCookie = /kndctr_[^=]+_AdobeOrg_consent=/.test(document.cookie);
    if (hasConsentCookie && state.queuedCommands.length > 0) {
      state.queuedCommands = [];
    }

    return {
      url: window.location.href,
      hostname: window.location.hostname,
      title: document.title,
      documentCookie: document.cookie,
      sdkInfo: {
        alloyDetected: state.alloyDetected,
        instanceNames: state.instanceNames,
        orgId: state.orgId,
        datastreamId: state.datastreamId,
        edgeDomain: state.edgeDomain,
        defaultConsent: state.defaultConsent,
        libraryVersion: state.libraryVersion,
        ecid: state.ecid,
        launchInfo: state.launchInfo || null,
        launchConfigBindings: state.launchConfigBindings || {},
        resolvedDataElements: state.resolvedDataElements || {},
        dataLayerConsentEvents: state.dataLayerConsentEvents || [],
        queuedEventCount: state.queuedCommands.length,
        queuedCommands: state.queuedCommands,
        commandHistory: state.commandHistory
      },
      edgeEvents: state.edgeEvents,
      tcfData: state.tcfData,
      cmpDetected: state.cmpDetected
    };
  }

  // Listen for Search Discovery / Further Data Layer Manager consent custom events (used on further.ai)
  ['SDI-DLM:Consent Loaded', 'SDI-DLM:Consent Updated'].forEach((evtName) => {
    window.addEventListener(evtName, () => {
      setTimeout(() => {
        emitToExtension('STATE_UPDATE', buildSnapshot());
      }, 100);
    });
  });

  // Listen for inspection or live command requests from the extension content script
  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data) return;
    const { source, type, payload } = event.data;
    if (source !== 'AEP_CONSENT_ANALYZER_EXTENSION') return;

    if (type === 'REQUEST_SNAPSHOT') {
      await queryAlloyRuntimeInfo();
      emitToExtension('SNAPSHOT_RESPONSE', buildSnapshot());
    } else if (type === 'EDGE_NETWORK_HIT_FROM_BG' && payload) {
      parseEdgeRequest(payload.url, payload.body, payload.transport || 'webRequest');
    } else if (type === 'EXECUTE_SET_CONSENT' && payload) {
      const fnName = state.instanceNames[0] || 'alloy';
      if (typeof window[fnName] === 'function') {
        try {
          window[fnName]('setConsent', payload);
        } catch (err) {
          emitToExtension('COMMAND_ERROR', { message: err.message });
        }
      } else {
        // If Alloy is not on the page, record a simulated setConsent in the hook
        recordCommand('alloy (simulated)', 'setConsent', payload);
      }
      setTimeout(() => {
        emitToExtension('SNAPSHOT_RESPONSE', buildSnapshot());
      }, 150);
    }
  });

  function hasAepPresenceOnPage() {
    return Boolean(
      state.alloyDetected ||
        state.orgId ||
        state.datastreamId ||
        /kndctr_[^=]+_AdobeOrg_/i.test(document.cookie)
    );
  }

  // Periodic scan during startup
  scanAndHookAlloy();
  inspectAdobeLaunchAndDataLayer();
  window.addEventListener('DOMContentLoaded', () => {
    scanAndHookAlloy();
    inspectAdobeLaunchAndDataLayer();
    if (hasAepPresenceOnPage()) {
      emitToExtension('STATE_UPDATE', buildSnapshot());
    }
  });
  window.addEventListener('load', async () => {
    await queryAlloyRuntimeInfo();
    if (hasAepPresenceOnPage()) {
      emitToExtension('STATE_UPDATE', buildSnapshot());
    }
  });
})();
