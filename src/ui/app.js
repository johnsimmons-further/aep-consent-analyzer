/**
 * AEP Consent Status Analyzer - Unified Application Controller
 *
 * Powers both:
 * 1. The Chrome Extension Popup / Side Panel / Full-Tab Inspector
 * 2. The Standalone Web Testbench & Simulator
 */
import {
  XDM_CONSENT_VAL_DEFINITIONS,
  analyzeCookies,
  analyzeXdmConsents,
  decodeTcfStringSummary,
  evaluateVisitorConsentState,
  generateSetConsentSnippet
} from '../core/consent-engine.js';
import { AlloyConsentSimulator } from '../simulator/alloy-simulator.js';

const urlParams = new URLSearchParams(window.location.search);
const viewMode = urlParams.get('mode') || 'web';
const targetTabIdParam = urlParams.get('tabId') ? Number(urlParams.get('tabId')) : null;
const isChromeExtension =
  typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id) && Boolean(chrome.tabs);

if (viewMode === 'popup') {
  document.body.classList.add('mode-popup');
}

let simulator = null;
let currentSnapshot = null;
let currentChromeCookies = [];
let customCookieOverride = null;
let activeTabId = targetTabIdParam;

async function initApp() {
  setupTabs();
  renderXdmEnumReferenceTable();
  setupBuilderControls();
  setupTcfDecoderControls();
  setupCustomCookieControls();
  setupQuickActionButtons();

  const runtimeBadge = document.getElementById('runtimeModeBadge');
  const btnExpandFullTab = document.getElementById('btnExpandFullTab');
  const simulatorBar = document.getElementById('simulatorBar');
  const btnTogglePresets = document.getElementById('btnTogglePresets');

  simulator = new AlloyConsentSimulator((snapshot) => {
    currentSnapshot = snapshot;
    currentChromeCookies = [];
    renderAll();
  });
  setupScenarioButtons();

  btnTogglePresets?.addEventListener('click', () => {
    if (!simulatorBar) return;
    const isHidden = simulatorBar.style.display === 'none';
    simulatorBar.style.display = isHidden ? 'flex' : 'none';
  });

  if (isChromeExtension) {
    runtimeBadge.textContent =
      viewMode === 'popup'
        ? 'Chrome Extension (Live Tab)'
        : viewMode === 'sidepanel'
        ? 'Chrome Side Panel (Live Tab)'
        : 'Chrome Extension Inspector';

    if (viewMode === 'popup') {
      btnExpandFullTab.style.display = 'inline-flex';
      btnExpandFullTab.addEventListener('click', () => {
        const targetUrl = chrome.runtime.getURL(
          `index.html?mode=tab${activeTabId ? `&tabId=${activeTabId}` : ''}`
        );
        chrome.tabs.create({ url: targetUrl });
      });
    }

    simulatorBar.style.display = 'none';
    await refreshFromChromeExtensionTab();

    // Listen for live updates from content script
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.action === 'PAGE_EVENT') {
        refreshFromChromeExtensionTab();
      }
    });
  } else {
    runtimeBadge.textContent = 'Chrome Extension Preview';
    simulatorBar.style.display = 'flex';
    simulator.initGlobalAlloy();
    await simulator.loadScenario('further-ai');
  }
}

function setupTabs() {
  const buttons = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-tab');
      buttons.forEach((b) => b.classList.remove('active'));
      panels.forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(targetId)?.classList.add('active');
    });
  });
}

function setupScenarioButtons() {
  const buttons = document.querySelectorAll('.btn-scenario');
  buttons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      customCookieOverride = null;
      const scenarioKey = btn.getAttribute('data-scenario');
      if (simulator) {
        await simulator.loadScenario(scenarioKey);
      }
    });
  });
}

async function refreshFromChromeExtensionTab() {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'INSPECT_TAB',
      tabId: activeTabId
    });
    if (response?.ok) {
      activeTabId = response.tab?.id || activeTabId;
      currentSnapshot = response.snapshot || {
        url: response.tab?.url || '',
        title: response.tab?.title || '',
        documentCookie: '',
        sdkInfo: { alloyDetected: false },
        edgeEvents: []
      };
      currentChromeCookies = response.chromeCookies || [];
      const targetLabel = document.getElementById('inspectedTargetLabel');
      if (response.tab?.url) {
        targetLabel.textContent = `Inspecting: ${response.tab.url}`;
      }
      renderAll();
    }
  } catch (err) {
    console.warn('Extension tab inspection fallback:', err);
  }
}

function setupQuickActionButtons() {
  document.getElementById('btnRefreshScan')?.addEventListener('click', async () => {
    customCookieOverride = null;
    if (isChromeExtension) {
      await refreshFromChromeExtensionTab();
    } else if (simulator) {
      currentSnapshot = simulator.getSnapshot();
      renderAll();
    }
  });

  document.getElementById('btnQuickOptIn')?.addEventListener('click', async () => {
    const { payload } = generateSetConsentSnippet({
      standard: 'Adobe',
      version: '2.0',
      collectVal: 'y',
      shareVal: 'y',
      personalizeVal: 'y',
      emailVal: 'y',
      timestamp: new Date().toISOString()
    });
    await dispatchSetConsentToTarget(payload);
  });

  document.getElementById('btnQuickOptOut')?.addEventListener('click', async () => {
    const { payload } = generateSetConsentSnippet({
      standard: 'Adobe',
      version: '2.0',
      collectVal: 'n',
      shareVal: 'n',
      personalizeVal: 'n',
      emailVal: 'n',
      timestamp: new Date().toISOString()
    });
    await dispatchSetConsentToTarget(payload);
  });

  document.getElementById('btnFireTestPageView')?.addEventListener('click', async () => {
    if (!isChromeExtension && simulator) {
      await simulator.executeCommand('sendEvent', {
        xdm: {
          eventType: 'web.webpagedetails.pageViews',
          web: {
            webPageDetails: {
              name: `Test PageView (${new Date().toLocaleTimeString()})`,
              URL: window.location.href
            }
          }
        }
      });
    } else if (isChromeExtension && activeTabId) {
      await refreshFromChromeExtensionTab();
    }
  });
}

async function dispatchSetConsentToTarget(payload) {
  if (isChromeExtension && activeTabId) {
    try {
      await chrome.tabs.sendMessage(activeTabId, {
        action: 'EXECUTE_SET_CONSENT',
        payload
      });
      setTimeout(() => refreshFromChromeExtensionTab(), 250);
    } catch {
      // Fallback if content script not reachable
    }
  } else if (simulator) {
    await simulator.executeCommand('setConsent', payload);
  }
}

function renderAll() {
  if (!currentSnapshot) return;

  const cookieInput =
    customCookieOverride !== null
      ? customCookieOverride
      : currentChromeCookies.length > 0
      ? currentChromeCookies
      : currentSnapshot.documentCookie || '';

  const cookieAnalysis = analyzeCookies(cookieInput);
  const edgeEvents = (currentSnapshot.edgeEvents || []).map((ev) => ({
    ...ev,
    consentAnalysis: analyzeXdmConsents(ev.payload)
  }));

  const evaluation = evaluateVisitorConsentState({
    cookieAnalysis,
    sdkInfo: currentSnapshot.sdkInfo || {},
    edgeEvents,
    tcfState: currentSnapshot.tcfData || null
  });

  renderHeroBanner(evaluation, currentSnapshot);
  renderDiagnostics(evaluation.diagnostics);
  renderCookiesTable(cookieAnalysis);
  renderCommandTimeline(currentSnapshot.sdkInfo || {});
  renderEdgeEventsAndXdmInspector(edgeEvents);
}

function renderKpiWithDataElement(el, fieldObj, fallbackText) {
  if (!el) return;
  if (fieldObj?.isDataElement) {
    const resolvedVal =
      fieldObj.resolved !== null && fieldObj.resolved !== undefined
        ? fieldObj.resolved === ''
          ? '"" (empty)'
          : String(fieldObj.resolved)
        : 'undefined';
    const deName = fieldObj.tokens?.[0]?.name || '';
    const lowerVal = resolvedVal.toLowerCase();
    let badgeClass = 'de-val-info';
    if (lowerVal === 'in' || lowerVal === 'y') badgeClass = 'de-val-in';
    else if (lowerVal === 'out' || lowerVal === 'n') badgeClass = 'de-val-out';
    else if (lowerVal === 'pending' || lowerVal === 'p') badgeClass = 'de-val-pending';

    el.innerHTML = `
      <div class="kpi-de-wrapper">
        <div class="kpi-de-token">${escapeHtml(fieldObj.raw)}</div>
        <div class="kpi-de-resolved-row" title="_satellite.getVar('${escapeHtml(deName)}')">
          <span class="kpi-de-label">Value:</span>
          <span class="kpi-de-badge ${badgeClass}">${escapeHtml(resolvedVal)}</span>
        </div>
      </div>
    `;
    return;
  }

  el.textContent = fieldObj?.effective || fallbackText;
}

function renderHeroBanner(evaluation, snapshot) {
  const hero = document.getElementById('statusHero');
  const badge = document.getElementById('heroBadge');
  const sourceText = document.getElementById('heroSourceText');
  const subText = document.getElementById('heroSubText');

  hero.className = `status-hero state-${evaluation.effectiveState}`;
  badge.className = `status-badge ${evaluation.effectiveState}`;

  const labelMap = {
    'opted-in': 'OPTED IN (TRACKING ALLOWED)',
    'opted-out': 'OPTED OUT (TRACKING BLOCKED)',
    pending: 'PENDING CONSENT (EVENTS QUEUED)',
    unknown: 'UNINITIALIZED / NO CONSENT SIGNAL'
  };
  badge.textContent = labelMap[evaluation.effectiveState] || 'UNKNOWN';
  sourceText.textContent = `Source: ${evaluation.stateSource}`;

  const cmps = snapshot.cmpDetected?.length
    ? `Detected CMPs: ${snapshot.cmpDetected.join(' • ')}`
    : 'No CMP global APIs detected on page';
  subText.textContent = cmps;

  renderKpiWithDataElement(
    document.getElementById('kpiOrgId'),
    evaluation.fields?.orgId,
    evaluation.orgId || 'Not configured'
  );
  renderKpiWithDataElement(
    document.getElementById('kpiDatastreamId'),
    evaluation.fields?.datastreamId,
    evaluation.datastreamId || 'Not configured'
  );
  renderKpiWithDataElement(
    document.getElementById('kpiDefaultConsent'),
    evaluation.fields?.defaultConsent,
    evaluation.defaultConsent || 'Not detected'
  );

  document.getElementById('kpiConsentCookie').textContent =
    evaluation.consentCookieValue || 'None (Not Set)';
  document.getElementById('kpiIdentityCookie').textContent = evaluation.hasIdentityCookie
    ? 'Present (ECID Active)'
    : 'Not Set (No ECID)';
  document.getElementById('kpiQueuedEvents').textContent = String(
    snapshot.sdkInfo?.queuedEventCount || 0
  );
}

function renderDiagnostics(diagnostics = []) {
  const container = document.getElementById('diagnosticsContainer');
  if (!diagnostics.length) {
    container.innerHTML = `<div class="empty-state">No consent warnings or conflicts detected.</div>`;
    return;
  }

  container.innerHTML = diagnostics
    .map(
      (d) => `
      <div class="diag-item severity-${escapeHtml(d.severity)}">
        <div class="diag-title">
          <span>${escapeHtml(d.title)}</span>
          ${
            d.docUrl
              ? `<a class="diag-link" href="${escapeHtml(d.docUrl)}" target="_blank" rel="noopener">Official AEP Docs &#x2197;</a>`
              : ''
          }
        </div>
        <div class="diag-detail">${escapeHtml(d.detail)}</div>
      </div>
    `
    )
    .join('');
}

function renderCookiesTable(cookieAnalysis) {
  const tbody = document.getElementById('cookieTableBody');
  const rows = [];

  for (const c of cookieAnalysis.aepConsentCookies) {
    const statusClass =
      c.generalStatus === 'in'
        ? 'opted-in'
        : c.generalStatus === 'out'
        ? 'opted-out'
        : 'unknown';
    rows.push({
      name: c.name,
      category: 'AEP Consent Cookie',
      statusHtml: `<span class="pill ${statusClass}">general = ${escapeHtml(c.generalStatus)}</span>`,
      rawValue: c.value,
      role: 'Stores the visitor’s Web SDK consent choice for 180 days so Alloy knows whether to send or block hits on subsequent page views.'
    });
  }

  for (const c of cookieAnalysis.aepConsentCheckCookies) {
    const isCluster = c.helperType === 'cluster';
    rows.push({
      name: c.name,
      category: isCluster ? 'AEP Edge Cluster' : 'AEP Consent Helper',
      statusHtml: `<span class="pill info">${isCluster ? `Cluster: ${escapeHtml(c.value)}` : `Active (${escapeHtml(c.value)})`}</span>`,
      rawValue: c.value,
      role: isCluster
        ? 'Stores the Adobe Edge Network regional routing cluster (e.g., irl1, va6, or2) for 30 minutes to maintain session affinity.'
        : 'Short-lived (2-hour TTL) session cookie signaling whether Edge Network consent state is already synchronized.'
    });
  }

  for (const c of cookieAnalysis.aepIdentityCookies) {
    rows.push({
      name: c.name,
      category: 'AEP Identity (ECID)',
      statusHtml: `<span class="pill opted-in">ECID Present</span>`,
      rawValue: c.value,
      role: 'Stores the visitor’s Experience Cloud ID (ECID). Should only be created after consent is granted when defaultConsent="pending".'
    });
  }

  for (const c of cookieAnalysis.cmpCookies) {
    const summary = c.decoded?.groups
      ? `Groups: ${c.decoded.groups}`
      : c.decoded?.optOutSale
      ? `OptOutSale: ${c.decoded.optOutSale}`
      : c.value.slice(0, 40);
    rows.push({
      name: c.name,
      category: `CMP (${c.cmpType})`,
      statusHtml: `<span class="pill info">${escapeHtml(summary)}</span>`,
      rawValue: c.value.slice(0, 80) + (c.value.length > 80 ? '...' : ''),
      role: 'Consent Management Platform state cookie; custom site code maps this into XDM and passes it to alloy("setConsent").'
    });
  }

  if (rows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-state">
          No <code>kndctr_&lt;orgId&gt;_AdobeOrg_consent</code>, <code>kndctr_*_identity</code>, or CMP cookies currently set for this visitor.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td class="mono" style="font-weight: 600;">${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.category)}</td>
        <td>${r.statusHtml}</td>
        <td class="mono">${escapeHtml(r.rawValue)}</td>
        <td style="color: var(--text-secondary);">${escapeHtml(r.role)}</td>
      </tr>
    `
    )
    .join('');
}

function renderCommandTimeline(sdkInfo) {
  const tbody = document.getElementById('commandTimelineBody');
  const history = sdkInfo.commandHistory || [];
  if (!history.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-state">
          No <code>alloy(...)</code> commands captured yet on this page.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = [...history]
    .reverse()
    .map((item) => {
      let pillClass = 'info';
      if (item.status.includes('queued')) pillClass = 'pending';
      else if (item.status.includes('blocked') || item.status.includes('dropped') || item.status.includes('general=out'))
        pillClass = 'opted-out';
      else if (item.status.includes('dispatched') || item.status.includes('flushed') || item.status.includes('general=in'))
        pillClass = 'opted-in';

      const timeStr = item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : '';
      return `
        <tr>
          <td class="mono">${escapeHtml(timeStr)}</td>
          <td class="mono" style="font-weight: 700;">${escapeHtml(item.instanceName || 'alloy')}("${escapeHtml(item.command)}")</td>
          <td><span class="pill ${pillClass}">${escapeHtml(item.status)}</span></td>
          <td class="mono" style="max-width: 420px; overflow: hidden; text-overflow: ellipsis;">
            ${escapeHtml(JSON.stringify(item.options || {}))}
          </td>
        </tr>
      `;
    })
    .join('');
}

function renderEdgeEventsAndXdmInspector(edgeEvents) {
  const selector = document.getElementById('edgeEventSelector');
  const textarea = document.getElementById('xdmJsonTextarea');

  if (!edgeEvents.length) {
    const defaultSample = generateSetConsentSnippet({
      standard: 'Adobe',
      version: '2.0',
      collectVal: 'y',
      shareVal: 'y',
      personalizeVal: 'y',
      emailVal: 'y',
      includeIdSpecific: true
    }).payload;

    selector.innerHTML = `<option value="sample">Sample Adobe 2.0 XDM Consent Payload</option>`;
    if (!textarea.value.trim()) {
      textarea.value = JSON.stringify(defaultSample, null, 2);
    }
    runXdmInspectorOnCurrentTextarea();
    return;
  }

  // Prefer selecting the most recent `set-consent` hit by default so the XDM inspector shows consent
  let defaultIdx = edgeEvents.length - 1;
  for (let i = edgeEvents.length - 1; i >= 0; i--) {
    if (edgeEvents[i].type === 'set-consent' || edgeEvents[i].command === 'setConsent') {
      defaultIdx = i;
      break;
    }
  }

  selector.innerHTML = edgeEvents
    .map((ev, idx) => {
      const time = new Date(ev.timestamp).toLocaleTimeString();
      return `<option value="${idx}" ${idx === defaultIdx ? 'selected' : ''}>
        #${idx + 1} [${ev.type.toUpperCase()}] ${time} — ${ev.source}
      </option>`;
    })
    .join('');

  const selectedEvent = edgeEvents[defaultIdx];
  textarea.value = JSON.stringify(selectedEvent.payload, null, 2);
  runXdmInspectorOnCurrentTextarea();

  selector.onchange = () => {
    const idx = Number(selector.value);
    if (!Number.isNaN(idx) && edgeEvents[idx]) {
      textarea.value = JSON.stringify(edgeEvents[idx].payload, null, 2);
      runXdmInspectorOnCurrentTextarea();
    }
  };
}

function runXdmInspectorOnCurrentTextarea() {
  const textarea = document.getElementById('xdmJsonTextarea');
  const findingsContainer = document.getElementById('xdmFindingsContainer');
  const breakdownBody = document.getElementById('xdmBreakdownBody');

  let parsed = null;
  try {
    parsed = JSON.parse(textarea.value);
  } catch (err) {
    findingsContainer.innerHTML = `
      <div class="diag-item severity-error">
        <div class="diag-title">Invalid JSON Syntax</div>
        <div class="diag-detail">${escapeHtml(err.message)}</div>
      </div>
    `;
    breakdownBody.innerHTML = '';
    return;
  }

  const analysis = analyzeXdmConsents(parsed);
  findingsContainer.innerHTML = (analysis.findings || [])
    .map(
      (f) => `
      <div class="diag-item severity-${escapeHtml(f.severity)}">
        <div class="diag-title">
          <span>${escapeHtml(f.title)}</span>
          ${
            f.docUrl
              ? `<a class="diag-link" href="${escapeHtml(f.docUrl)}" target="_blank" rel="noopener">Docs &#x2197;</a>`
              : ''
          }
        </div>
        <div class="diag-detail">${escapeHtml(f.detail)}</div>
      </div>
    `
    )
    .join('');

  if (!analysis.fieldBreakdown?.length) {
    breakdownBody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-state">No standard XDM <code>consents</code> fields found in this JSON object.</td>
      </tr>
    `;
    return;
  }

  breakdownBody.innerHTML = analysis.fieldBreakdown
    .map(
      (f) => `
      <tr>
        <td class="mono" style="font-weight: 600;">${escapeHtml(f.path)}</td>
        <td>${escapeHtml(f.category)}</td>
        <td><span class="pill ${escapeHtml(f.status)}">${escapeHtml(f.label)}</span></td>
        <td>
          ${
            f.enforcedByWebSdk
              ? '<span class="pill opted-in">Web SDK Automatic</span>'
              : '<span class="pill info">Downstream Profile/CDP</span>'
          }
        </td>
        <td style="color: var(--text-secondary);">${escapeHtml(f.notes)}</td>
      </tr>
    `
    )
    .join('');
}

function renderXdmEnumReferenceTable() {
  const tbody = document.getElementById('xdmEnumReferenceBody');
  if (!tbody) return;
  tbody.innerHTML = Object.values(XDM_CONSENT_VAL_DEFINITIONS)
    .map(
      (def) => `
      <tr>
        <td class="mono" style="font-weight: 700;">"${escapeHtml(def.code)}"</td>
        <td>${escapeHtml(def.label)}</td>
        <td>${escapeHtml(def.category)}</td>
        <td><span class="pill ${escapeHtml(def.status)}">${escapeHtml(def.status.toUpperCase())}</span></td>
        <td style="color: var(--text-secondary);">${escapeHtml(def.description)}</td>
      </tr>
    `
    )
    .join('');

  document.getElementById('btnAnalyzeXdmJson')?.addEventListener('click', () => {
    runXdmInspectorOnCurrentTextarea();
  });
}

function setupBuilderControls() {
  const controls = [
    'builderStandard',
    'builderCollectVal',
    'builderShareVal',
    'builderPersonalizeVal',
    'builderPreferredChannel',
    'builderEmailVal',
    'builderPushVal',
    'builderSmsVal',
    'builderIncludeIdSpecific'
  ];

  const getBuilderOptions = () => {
    const stdRaw = document.getElementById('builderStandard').value;
    let standard = 'Adobe';
    let version = '2.0';
    if (stdRaw === 'Adobe-1.0') {
      standard = 'Adobe';
      version = '1.0';
    } else if (stdRaw === 'IAB-TCF-2.0') {
      standard = 'IAB TCF';
      version = '2.0';
    }

    return {
      standard,
      version,
      collectVal: document.getElementById('builderCollectVal').value,
      shareVal: document.getElementById('builderShareVal').value,
      personalizeVal: document.getElementById('builderPersonalizeVal').value,
      preferredChannel: document.getElementById('builderPreferredChannel').value,
      emailVal: document.getElementById('builderEmailVal').value,
      pushVal: document.getElementById('builderPushVal').value,
      smsVal: document.getElementById('builderSmsVal').value,
      includeIdSpecific: document.getElementById('builderIncludeIdSpecific').checked,
      timestamp: new Date().toISOString()
    };
  };

  const updatePreview = () => {
    const { code } = generateSetConsentSnippet(getBuilderOptions());
    document.getElementById('builderCodeOutput').textContent = code;
  };

  controls.forEach((id) => {
    document.getElementById(id)?.addEventListener('change', updatePreview);
  });

  document.getElementById('btnExecuteBuiltConsent')?.addEventListener('click', async () => {
    const { payload } = generateSetConsentSnippet(getBuilderOptions());
    await dispatchSetConsentToTarget(payload);
    // Switch to Live tab or update XDM inspector
    document.getElementById('xdmJsonTextarea').value = JSON.stringify(payload, null, 2);
    runXdmInspectorOnCurrentTextarea();
  });

  document.getElementById('btnCopyBuiltSnippet')?.addEventListener('click', async (e) => {
    const code = document.getElementById('builderCodeOutput').textContent;
    try {
      await navigator.clipboard.writeText(code);
      const btn = e.currentTarget;
      const orig = btn.textContent;
      btn.textContent = 'Copied to Clipboard!';
      setTimeout(() => {
        btn.textContent = orig;
      }, 1500);
    } catch {
      // ignore
    }
  });

  updatePreview();
}

function setupTcfDecoderControls() {
  const input = document.getElementById('tcfStringInput');
  const container = document.getElementById('tcfDecodeResultContainer');

  const runDecode = () => {
    const res = decodeTcfStringSummary(input.value);
    if (!res.valid) {
      container.innerHTML = `
        <div class="diag-item severity-warning">
          <div class="diag-title">TCF 2.0 Decode Notice</div>
          <div class="diag-detail">${escapeHtml(res.summary)}</div>
        </div>
      `;
      return;
    }

    const v565Status =
      res.vendor565Consent === true
        ? 'opted-in'
        : res.vendor565Consent === false
        ? 'opted-out'
        : 'info';

    container.innerHTML = `
      <div class="diag-item severity-${res.vendor565Consent === false ? 'error' : 'success'}" style="margin-bottom: 12px;">
        <div class="diag-title">
          <span>Adobe Experience Platform (IAB Vendor ID #565): ${
            res.vendor565Consent === true
              ? 'CONSENT GRANTED'
              : res.vendor565Consent === false
              ? 'CONSENT DENIED'
              : 'NOT IN BITFIELD'
          }</span>
        </div>
        <div class="diag-detail">${escapeHtml(res.summary)}</div>
      </div>
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">TCF Version</div>
          <div class="kpi-value">v${res.version}.0</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">CMP ID &amp; Version</div>
          <div class="kpi-value">#${res.cmpId} (v${res.cmpVersion})</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Publisher Country</div>
          <div class="kpi-value">${escapeHtml(res.countryCode)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Purposes Granted (1-10)</div>
          <div class="kpi-value">${res.purposesConsented.join(', ') || 'None'}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Adobe Vendor #565</div>
          <div class="kpi-value"><span class="pill ${v565Status}">${
      res.vendor565Consent === true ? 'Granted' : 'Denied / Unset'
    }</span></div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Last Updated</div>
          <div class="kpi-value">${escapeHtml(res.lastUpdated)}</div>
        </div>
      </div>
    `;
  };

  document.getElementById('btnDecodeTcf')?.addEventListener('click', runDecode);
  runDecode();
}

function setupCustomCookieControls() {
  document.getElementById('btnAnalyzeCustomCookie')?.addEventListener('click', () => {
    const val = document.getElementById('customCookieInput').value.trim();
    if (val) {
      customCookieOverride = val;
      renderAll();
    }
  });

  document.getElementById('btnResetCustomCookie')?.addEventListener('click', () => {
    customCookieOverride = null;
    document.getElementById('customCookieInput').value = '';
    renderAll();
  });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

initApp();
