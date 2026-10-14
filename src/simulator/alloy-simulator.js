/**
 * Interactive Adobe Experience Platform Web SDK (`alloy`) & CMP Simulator
 *
 * Faithful client-side simulation of `@adobe/alloy` consent lifecycle:
 * - Implements `alloy("configure", ...)`, `alloy("setConsent", ...)`, `alloy("sendEvent", ...)`, `alloy("getLibraryInfo")`
 * - Manages real browser cookies:
 *   - `kndctr_<orgId>_AdobeOrg_consent` (`general=in` | `general=out`)
 *   - `kndctr_<orgId>_AdobeOrg_consent_check` (`1`)
 *   - `kndctr_<orgId>_AdobeOrg_identity` (ECID state when opted in)
 *   - `OptanonConsent` & `euconsent-v2` (when simulating CMP presets)
 * - Queues `sendEvent` calls when `defaultConsent === "pending"` and flushes/drops them upon `setConsent`
 */

export class AlloyConsentSimulator {
  constructor(onUpdate) {
    this.onUpdate = typeof onUpdate === 'function' ? onUpdate : () => {};
    this.config = {
      orgId: '97D1F3F459CE0AD80A495CBE@AdobeOrg',
      datastreamId: 'eb4829a0-7f19-4b15-993a-18c6f2f9e102',
      edgeDomain: 'edge.adobedc.net',
      defaultConsent: 'pending',
      version: '2.24.0'
    };
    this.ecid = null;
    this.queuedCommands = [];
    this.commandHistory = [];
    this.edgeEvents = [];
    this.tcfData = null;
    this.cmpDetected = ['OneTrust CMP (Simulated)', 'IAB TCF 2.0 (__tcfapi)'];
  }

  get orgIdPrefix() {
    return (this.config.orgId || '97D1F3F459CE0AD80A495CBE@AdobeOrg').replace(/@AdobeOrg$/i, '');
  }

  get consentCookieName() {
    return `kndctr_${this.orgIdPrefix}_AdobeOrg_consent`;
  }

  get consentCheckCookieName() {
    return `kndctr_${this.orgIdPrefix}_AdobeOrg_consent_check`;
  }

  get identityCookieName() {
    return `kndctr_${this.orgIdPrefix}_AdobeOrg_identity`;
  }

  initGlobalAlloy() {
    window.__alloyNS = ['alloy'];
    const self = this;

    window.alloy = async function (command, options = {}) {
      return self.executeCommand(command, options);
    };

    // Provide a live __tcfapi responder for TCF 2.0 inspection
    window.__tcfapi = (cmd, version, callback) => {
      if (cmd === 'getTCData' && typeof callback === 'function') {
        callback(
          self.tcfData || {
            tcString: 'COtybn4PA_zT4KjACBENAPCIAEBAAECAAIAAAAAAAAAA',
            gdprApplies: true,
            eventStatus: 'tcloaded',
            cmpId: 28,
            cmpVersion: 1,
            vendor: { consents: { 565: true } },
            purpose: { consents: { 1: true, 2: true, 3: true, 4: true, 7: true } }
          },
          true
        );
      }
    };
  }

  getCookieMap() {
    const map = {};
    if (!document.cookie) return map;
    document.cookie.split(';').forEach((part) => {
      const idx = part.indexOf('=');
      if (idx > -1) {
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        map[k] = v;
      }
    });
    return map;
  }

  setBrowserCookie(name, value, maxAgeSeconds = 15552000) {
    document.cookie = `${name}=${value}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
  }

  deleteBrowserCookie(name) {
    document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
  }

  clearAllAepCookies() {
    const cookies = this.getCookieMap();
    Object.keys(cookies).forEach((name) => {
      if (
        name.startsWith('kndctr_') ||
        name === 'OptanonConsent' ||
        name === 'euconsent-v2' ||
        name === 'usprivacy'
      ) {
        this.deleteBrowserCookie(name);
      }
    });
    this.ecid = null;
  }

  ensureEcidCookie() {
    const cookies = this.getCookieMap();
    if (cookies[this.identityCookieName]) {
      return this.ecid;
    }
    // Generate realistic 38-digit Adobe ECID
    let digits = '';
    for (let i = 0; i < 38; i++) {
      digits += Math.floor(Math.random() * 10).toString();
    }
    this.ecid = digits;
    // Set kndctr_<orgId>_AdobeOrg_identity cookie
    this.setBrowserCookie(this.identityCookieName, `CiY${btoa(digits.slice(0, 18))}==`);
    return this.ecid;
  }

  getCurrentGeneralConsent() {
    const cookies = this.getCookieMap();
    const rawConsent = cookies[this.consentCookieName];
    if (rawConsent) {
      if (rawConsent.includes('general=in') || rawConsent === 'in') return 'in';
      if (rawConsent.includes('general=out') || rawConsent === 'out') return 'out';
    }
    return this.config.defaultConsent || 'in';
  }

  async executeCommand(command, options = {}) {
    const cmdId = `sim_cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    if (command === 'getLibraryInfo') {
      return {
        libraryInfo: {
          version: this.config.version,
          configs: { ...this.config }
        }
      };
    }

    if (command === 'configure') {
      this.config = {
        ...this.config,
        ...options,
        defaultConsent: options.defaultConsent || 'in'
      };
      this.commandHistory.push({
        id: cmdId,
        timestamp: now,
        instanceName: 'alloy',
        command: 'configure',
        options: { ...this.config },
        status: 'configured'
      });

      // If defaultConsent is "in" and no opt-out cookie exists, ECID is generated immediately
      const currentConsent = this.getCurrentGeneralConsent();
      if (currentConsent === 'in') {
        this.ensureEcidCookie();
      }

      this.notify();
      return {};
    }

    if (command === 'sendEvent') {
      const currentConsent = this.getCurrentGeneralConsent();

      if (currentConsent === 'pending') {
        const queuedEntry = {
          id: cmdId,
          timestamp: now,
          instanceName: 'alloy',
          command: 'sendEvent',
          options: JSON.parse(JSON.stringify(options)),
          status: 'queued-pending-consent'
        };
        this.queuedCommands.push(queuedEntry);
        this.commandHistory.push(queuedEntry);
        this.notify();
        return { status: 'queued-until-setConsent' };
      }

      if (currentConsent === 'out') {
        this.commandHistory.push({
          id: cmdId,
          timestamp: now,
          instanceName: 'alloy',
          command: 'sendEvent',
          options: JSON.parse(JSON.stringify(options)),
          status: 'blocked-by-opt-out'
        });
        this.notify();
        return { status: 'dropped-opted-out' };
      }

      // currentConsent === 'in' -> dispatch interact hit
      this.ensureEcidCookie();
      this.commandHistory.push({
        id: cmdId,
        timestamp: now,
        instanceName: 'alloy',
        command: 'sendEvent',
        options: JSON.parse(JSON.stringify(options)),
        status: 'dispatched-to-edge'
      });

      this.recordEdgeNetworkHit('interact', {
        events: [
          {
            xdm: {
              eventType: options.xdm?.eventType || 'web.webpagedetails.pageViews',
              timestamp: now,
              web: options.xdm?.web || {
                webPageDetails: { URL: window.location.href, name: document.title }
              },
              ...options.xdm
            }
          }
        ]
      });

      this.notify();
      return { status: 'dispatched' };
    }

    if (command === 'setConsent') {
      const resolvedGeneral = this.resolveGeneralFromSetConsentPayload(options);

      // Write first-party kndctr_<orgId>_AdobeOrg_consent cookie (180 days TTL)
      this.setBrowserCookie(this.consentCookieName, `general=${resolvedGeneral}`, 15552000);
      // Write session helper kndctr_<orgId>_AdobeOrg_consent_check cookie (2 hours TTL)
      this.setBrowserCookie(this.consentCheckCookieName, '1', 7200);

      this.commandHistory.push({
        id: cmdId,
        timestamp: now,
        instanceName: 'alloy',
        command: 'setConsent',
        options: JSON.parse(JSON.stringify(options)),
        status: `applied (general=${resolvedGeneral})`
      });

      // Dispatch /ee/v2/privacy/set-consent hit to Edge Network
      this.recordEdgeNetworkHit('set-consent', JSON.parse(JSON.stringify(options)));

      if (resolvedGeneral === 'in') {
        this.ensureEcidCookie();
        // Flush any queued sendEvent calls
        const toFlush = [...this.queuedCommands];
        this.queuedCommands = [];
        for (const q of toFlush) {
          q.status = 'flushed-after-consent';
          this.recordEdgeNetworkHit('interact', {
            events: [
              {
                xdm: {
                  eventType: q.options?.xdm?.eventType || 'web.webpagedetails.pageViews',
                  timestamp: new Date().toISOString(),
                  ...q.options?.xdm
                }
              }
            ],
            meta: { flushedFromPendingQueue: true }
          });
        }
      } else {
        // Opted out: drop queued events
        this.queuedCommands.forEach((q) => {
          q.status = 'dropped-by-opt-out';
        });
        this.queuedCommands = [];
      }

      this.notify();
      return { general: resolvedGeneral };
    }

    return {};
  }

  resolveGeneralFromSetConsentPayload(options) {
    const arr = Array.isArray(options?.consent)
      ? options.consent
      : options?.consent
      ? [options.consent]
      : [];

    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const std = (item.standard || '').toLowerCase();
      if (std === 'adobe') {
        const val = item.value || {};
        if (val.general === 'out' || val.general?.val === 'out') return 'out';
        if (val.general === 'in' || val.general?.val === 'in') return 'in';

        const collectVal = val.collect?.val || val.consents?.collect?.val;
        if (collectVal) {
          if (['n', 'dn', 'LO', 'p'].includes(collectVal)) return 'out';
          return 'in';
        }
      }
      if (std.includes('iab') || std.includes('tcf')) {
        if (this.tcfData && this.tcfData.vendor565Consent === false) {
          return 'out';
        }
        return 'in';
      }
    }
    return 'in';
  }

  recordEdgeNetworkHit(type, payload) {
    const reqId = crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const apiVer = this.config.edgeDomain === 'dcp.further.ai' ? 'v1' : 'v2';
    const endpoint =
      type === 'set-consent'
        ? `https://${this.config.edgeDomain}/ee/${apiVer}/privacy/set-consent?configId=${this.config.datastreamId}&requestId=${reqId}`
        : `https://${this.config.edgeDomain}/ee/${apiVer}/interact?configId=${this.config.datastreamId}&requestId=${reqId}`;

    this.edgeEvents.push({
      id: `edge_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      source: 'Edge Network (Simulated)',
      type,
      url: endpoint,
      datastreamId: this.config.datastreamId,
      orgId: this.config.orgId,
      payload
    });
  }

  /**
   * High-level scenario presets for testing AEP Consent behaviors
   */
  async loadScenario(scenarioKey) {
    this.queuedCommands = [];
    this.commandHistory = [];
    this.edgeEvents = [];
    this.launchInfo = null;
    this.dataLayerConsentEvents = [];
    this.clearAllAepCookies();

    if (scenarioKey === 'further-ai') {
      // Exact live configuration from https://further.ai/ (launch-92fc70ea517e.min.js)
      this.config = {
        orgId: '3B3D659E533B28590A490D4D@AdobeOrg',
        datastreamId: '95424b78-8ba9-40b5-af27-15357996da6e',
        edgeDomain: 'dcp.further.ai',
        defaultConsent: 'pending',
        version: '2.37.0'
      };
      this.cmpDetected = [
        'OneTrust (Groups: ,C0001,C0002,C0003,C0004, -> C0002=in)',
        'Adobe Tags / Launch (further.ai)',
        'Data Layer Manager (appEventData)'
      ];
      this.launchInfo = {
        propertyName: 'further.ai',
        propertyId: 'PR4bf9705ee532458da79a683811ad139f',
        environment: 'production',
        turbineVersion: '29.1.0',
        aepConsentDataElement: 'in',
        onetrustActiveGroupsDataElement: ',C0001,C0002,C0003,C0004,',
        ecidDataElement: ''
      };
      this.dataLayerConsentEvents = [
        {
          event: 'Consent Loaded',
          OnetrustActiveGroups: ',C0001,C0002,C0003,C0004,'
        }
      ];

      this.setBrowserCookie(
        'OptanonConsent',
        'isGpcEnabled=0&datestamp=Tue+Oct+13+2026&version=202610.1.0&groups=C0001:1,C0002:1,C0003:1,C0004:1'
      );

      // 1. Launch initializes adobe-alloy with defaultConsent: "pending"
      await this.executeCommand('configure', {
        orgId: '3B3D659E533B28590A490D4D@AdobeOrg',
        datastreamId: '95424b78-8ba9-40b5-af27-15357996da6e',
        edgeDomain: 'dcp.further.ai',
        defaultConsent: 'pending'
      });

      // 2. Launch Rule "Library Loaded | [Web SDK Target]" fires propositionFetch (queued while pending)
      await this.executeCommand('sendEvent', {
        renderDecisions: true,
        decisionScopes: ['__view__'],
        xdm: {
          eventType: 'decisioning.propositionFetch'
        }
      });

      // 3. Launch Rule "Page Load Completed | [Web SDK]" fires pageViews (queued while pending)
      await this.executeCommand('sendEvent', {
        xdm: {
          eventType: 'web.webpagedetails.pageViews',
          web: {
            webPageDetails: {
              URL: 'https://further.ai/',
              name: 'further',
              siteSection: 'home'
            }
          }
        }
      });

      // 4. OptanonWrapper pushes "Consent Loaded" / "Consent Updated" to window.appEventData,
      // and Launch Rule "Consent Loaded | [Web SDK]" / "Consent Updated | [Web SDK]" fires setConsent:
      await this.executeCommand('setConsent', {
        consent: [
          {
            standard: 'Adobe',
            version: '1.0',
            value: {
              general: 'in'
            }
          }
        ]
      });

      // Set cluster cookie returned by dcp.further.ai
      this.setBrowserCookie(`kndctr_${this.orgIdPrefix}_AdobeOrg_cluster`, 'irl1', 1800);
      this.notify();
      return;
    }

    // Default testbench config for standard scenarios
    this.config = {
      orgId: '97D1F3F459CE0AD80A495CBE@AdobeOrg',
      datastreamId: 'eb4829a0-7f19-4b15-993a-18c6f2f9e102',
      edgeDomain: 'edge.adobedc.net',
      defaultConsent: 'pending',
      version: '2.24.0'
    };
    this.cmpDetected = ['OneTrust CMP (Simulated)', 'IAB TCF 2.0 (__tcfapi)'];

    if (scenarioKey === 'gdpr-pending') {
      // Scenario 1: Strict GDPR Opt-In (defaultConsent = "pending", PageView queued)
      this.setBrowserCookie('OptanonConsent', 'isGpcEnabled=0&datestamp=Tue+Oct+13+2026&version=202610.1.0&groups=C0001:1,C0002:0,C0003:0,C0004:0');
      await this.executeCommand('configure', {
        orgId: this.config.orgId,
        datastreamId: this.config.datastreamId,
        edgeDomain: this.config.edgeDomain,
        defaultConsent: 'pending'
      });
      await this.executeCommand('sendEvent', {
        xdm: {
          eventType: 'web.webpagedetails.pageViews',
          web: { webPageDetails: { name: 'Home - Checkout Landing', URL: window.location.href } }
        }
      });
      return;
    }

    if (scenarioKey === 'adobe20-opt-in') {
      // Scenario 2: Full Adobe 2.0 Standard XDM Opt-In + Granular Marketing Preferences
      this.setBrowserCookie('OptanonConsent', 'isGpcEnabled=0&datestamp=Tue+Oct+13+2026&version=202610.1.0&groups=C0001:1,C0002:1,C0003:1,C0004:1');
      await this.executeCommand('configure', {
        orgId: this.config.orgId,
        datastreamId: this.config.datastreamId,
        edgeDomain: this.config.edgeDomain,
        defaultConsent: 'pending'
      });
      await this.executeCommand('sendEvent', {
        xdm: {
          eventType: 'web.webpagedetails.pageViews',
          web: { webPageDetails: { name: 'Product Detail Page', URL: window.location.href } }
        }
      });
      await this.executeCommand('setConsent', {
        consent: [
          {
            standard: 'Adobe',
            version: '2.0',
            value: {
              collect: { val: 'y' },
              share: { val: 'y' },
              personalize: { content: { val: 'y' } },
              marketing: {
                preferred: 'email',
                any: { val: 'y' },
                email: { val: 'y' },
                push: { val: 'n', reason: 'Too Frequent', time: new Date().toISOString() },
                sms: { val: 'n' }
              },
              idSpecific: {
                Email: {
                  'visitor@example.com': {
                    marketing: {
                      email: { val: 'y', time: new Date().toISOString() }
                    }
                  }
                }
              },
              metadata: {
                time: new Date().toISOString()
              }
            }
          }
        ]
      });
      return;
    }

    if (scenarioKey === 'strict-opt-out') {
      // Scenario 3: Visitor Rejects Cookies in CMP (general=out, collect.val="n")
      this.setBrowserCookie('OptanonConsent', 'isGpcEnabled=1&datestamp=Tue+Oct+13+2026&version=202610.1.0&groups=C0001:1,C0002:0,C0003:0,C0004:0');
      await this.executeCommand('configure', {
        orgId: this.config.orgId,
        datastreamId: this.config.datastreamId,
        edgeDomain: this.config.edgeDomain,
        defaultConsent: 'pending'
      });
      await this.executeCommand('sendEvent', {
        xdm: {
          eventType: 'web.webpagedetails.pageViews'
        }
      });
      await this.executeCommand('setConsent', {
        consent: [
          {
            standard: 'Adobe',
            version: '2.0',
            value: {
              collect: { val: 'n' },
              share: { val: 'n' },
              personalize: { content: { val: 'n' } },
              marketing: {
                any: { val: 'n' },
                email: { val: 'n' }
              },
              metadata: {
                time: new Date().toISOString()
              }
            }
          }
        ]
      });
      return;
    }

    if (scenarioKey === 'misconfigured-leak') {
      // Scenario 4: Misconfigured Compliance Issue (defaultConsent="in" before consent + missing metadata.time + adID on Profile)
      await this.executeCommand('configure', {
        orgId: this.config.orgId,
        datastreamId: this.config.datastreamId,
        edgeDomain: this.config.edgeDomain,
        defaultConsent: 'in'
      });
      await this.executeCommand('sendEvent', {
        xdm: {
          eventType: 'web.webpagedetails.pageViews',
          consents: {
            collect: { val: 'y' }
          }
        }
      });
      this.tcfData = {
        tcString: 'COtybn4PA_zT4KjACBENAPCIAEBAAECAAIAAAAAAAAAA',
        gdprApplies: true,
        eventStatus: 'useractioncomplete',
        cmpId: 28,
        cmpVersion: 1,
        vendor565Consent: false,
        purposeConsents: { 1: false }
      };
      this.notify();
    }
  }

  getSnapshot() {
    return {
      url: window.location.href,
      hostname: window.location.hostname || 'localhost',
      title: document.title,
      documentCookie: document.cookie,
      sdkInfo: {
        alloyDetected: true,
        instanceNames: ['alloy'],
        orgId: this.config.orgId,
        datastreamId: this.config.datastreamId,
        edgeDomain: this.config.edgeDomain,
        defaultConsent: this.config.defaultConsent,
        libraryVersion: this.config.version,
        launchInfo: this.launchInfo || null,
        dataLayerConsentEvents: this.dataLayerConsentEvents || [],
        queuedEventCount: this.queuedCommands.length,
        queuedCommands: this.queuedCommands,
        commandHistory: this.commandHistory
      },
      edgeEvents: this.edgeEvents,
      tcfData: this.tcfData,
      cmpDetected: this.cmpDetected
    };
  }

  notify() {
    this.onUpdate(this.getSnapshot());
  }
}
