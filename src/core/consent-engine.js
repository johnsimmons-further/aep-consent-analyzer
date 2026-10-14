/**
 * Adobe Experience Platform (AEP) Consent Analysis Engine
 *
 * Implements the rules, schemas, and diagnostics from Adobe Experience Platform documentation:
 * - Consent Processing in AEP (Adobe 2.0 & 1.0 Standards)
 * - Configure a Dataset to Capture Consent & Preference Data
 * - XDM Consents and Preferences Field Group & Data Type
 * - Web SDK Consent Commands (defaultConsent, setConsent) & kndctr_* Cookies
 * - IAB TCF 2.0 Support in Experience Platform (Vendor ID 565)
 */

export const AEP_DOCS_LINKS = {
  overview: 'https://experienceleague.adobe.com/en/docs/experience-platform/landing/governance-privacy-security/consent/adobe/overview',
  dataset: 'https://experienceleague.adobe.com/en/docs/experience-platform/landing/governance-privacy-security/consent/adobe/dataset',
  sdk: 'https://experienceleague.adobe.com/en/docs/experience-platform/landing/governance-privacy-security/consent/sdk',
  xdmFieldGroup: 'https://experienceleague.adobe.com/en/docs/experience-platform/xdm/field-groups/profile/consents',
  xdmDataType: 'https://experienceleague.adobe.com/en/docs/experience-platform/xdm/data-types/consents',
  iabOverview: 'https://experienceleague.adobe.com/en/docs/experience-platform/landing/governance-privacy-security/consent/iab/overview',
  webSdkConsent: 'https://experienceleague.adobe.com/en/docs/experience-platform/web-sdk/commands/configure/defaultconsent'
};

/**
 * Standard XDM `val` enumerations defined in the Consents and Preferences Data Type
 */
export const XDM_CONSENT_VAL_DEFINITIONS = {
  y: {
    code: 'y',
    label: 'Yes (Opt-in)',
    status: 'opted-in',
    category: 'Choice',
    description: 'Customer explicitly opted in / granted consent.'
  },
  n: {
    code: 'n',
    label: 'No (Opt-out)',
    status: 'opted-out',
    category: 'Choice',
    description: 'Customer explicitly opted out / denied or withdrew consent.'
  },
  p: {
    code: 'p',
    label: 'Pending',
    status: 'pending',
    category: 'Choice',
    description: 'Consent confirmation is pending customer action.'
  },
  u: {
    code: 'u',
    label: 'Unknown',
    status: 'unknown',
    category: 'Choice',
    description: 'Consent status is unknown or has not been collected.'
  },
  dy: {
    code: 'dy',
    label: 'Default Yes',
    status: 'opted-in',
    category: 'Default',
    description: 'Opted in by default prior to explicit user choice.'
  },
  dn: {
    code: 'dn',
    label: 'Default No',
    status: 'opted-out',
    category: 'Default',
    description: 'Opted out by default prior to explicit user choice.'
  },
  VI: {
    code: 'VI',
    label: 'Vital Interest (VI)',
    status: 'opted-in',
    category: 'Legal Basis',
    description: 'Processing is necessary to protect the vital interests of the individual.'
  },
  VO: {
    code: 'VO',
    label: 'Voluntary Opt-in (VO)',
    status: 'opted-in',
    category: 'Legal Basis',
    description: 'Voluntary / validated opt-in basis for processing.'
  },
  LI: {
    code: 'LI',
    label: 'Legitimate Interest (LI)',
    status: 'opted-in',
    category: 'Legal Basis',
    description: 'Legitimate business interest to process data outweighs potential harm.'
  },
  LO: {
    code: 'LO',
    label: 'Legitimate Interest Opt-out (LO)',
    status: 'opted-out',
    category: 'Legal Basis',
    description: 'Customer objected/opted out of processing under legitimate interest.'
  },
  CT: {
    code: 'CT',
    label: 'Contract (CT)',
    status: 'opted-in',
    category: 'Legal Basis',
    description: 'Processing is necessary for the performance of a contract.'
  },
  CP: {
    code: 'CP',
    label: 'Compliance with Legal Obligation (CP)',
    status: 'opted-in',
    category: 'Legal Basis',
    description: 'Processing is required for compliance with a legal obligation.'
  }
};

export const MARKETING_CHANNELS = [
  { key: 'any', label: 'Any Channel', description: 'Global marketing communication preference across all channels.' },
  { key: 'email', label: 'Email', description: 'Permission to send marketing emails.' },
  { key: 'push', label: 'Push Notifications', description: 'Permission to send mobile or web push notifications.' },
  { key: 'sms', label: 'SMS / Text', description: 'Permission to send marketing text messages.' },
  { key: 'call', label: 'Phone Call', description: 'Permission to contact via telemarketing/phone calls.' },
  { key: 'directMail', label: 'Direct Mail', description: 'Permission to send physical postal marketing mail.' }
];

/**
 * Parse raw cookie string or array of Chrome cookie objects into structured AEP & CMP cookies
 */
export function analyzeCookies(cookieInput = []) {
  const cookies = normalizeCookies(cookieInput);
  const aepConsentCookies = [];
  const aepConsentCheckCookies = [];
  const aepIdentityCookies = [];
  const legacyAdobeCookies = [];
  const cmpCookies = [];

  for (const c of cookies) {
    const { name, value } = c;

    // 1. kndctr_<orgId>_AdobeOrg_consent
    const consentMatch = name.match(/^kndctr_(.+)_AdobeOrg_consent$/i);
    if (consentMatch) {
      const orgIdPrefix = consentMatch[1];
      const orgId = `${orgIdPrefix}@AdobeOrg`;
      const parsed = parseKndctrConsentCookie(value);
      aepConsentCookies.push({
        ...c,
        orgId,
        parsed,
        generalStatus: parsed.general || 'unknown'
      });
      continue;
    }

    // 2. kndctr_<orgId>_AdobeOrg_consent_check or kndctr_<orgId>_AdobeOrg_cluster
    const checkMatch = name.match(/^kndctr_(.+)_AdobeOrg_(consent_check|cluster)$/i);
    if (checkMatch) {
      aepConsentCheckCookies.push({
        ...c,
        orgId: `${checkMatch[1]}@AdobeOrg`,
        helperType: checkMatch[2].toLowerCase()
      });
      continue;
    }

    // 3. kndctr_<orgId>_AdobeOrg_identity
    const identityMatch = name.match(/^kndctr_(.+)_AdobeOrg_identity$/i);
    if (identityMatch) {
      aepIdentityCookies.push({
        ...c,
        orgId: `${identityMatch[1]}@AdobeOrg`,
        decodedNote: 'Base64/protobuf Edge Network identity state containing ECID'
      });
      continue;
    }

    // 4. Legacy AMCV / AMCVS / s_ecid / opt-out cookies
    if (/^(AMCV_|AMCVS_|s_ecid|s_cc|s_sq)/i.test(name)) {
      legacyAdobeCookies.push(c);
      continue;
    }

    // 5. Common CMP cookies (OneTrust, IAB TCF v2, USPrivacy, Usercentrics, Cookiebot, TrustArc)
    if (
      /^(OptanonConsent|OptanonAlertBoxClosed|euconsent-v2|eupubconsent-v2|usprivacy|CookieConsent|cmapi_cookie_privacy)$/i.test(
        name
      )
    ) {
      cmpCookies.push({
        ...c,
        cmpType: detectCmpCookieType(name),
        decoded: decodeCmpCookieValue(name, value)
      });
    }
  }

  return {
    allCount: cookies.length,
    aepConsentCookies,
    aepConsentCheckCookies,
    aepIdentityCookies,
    legacyAdobeCookies,
    cmpCookies
  };
}

export function unescapeCookieValue(raw) {
  if (raw === undefined || raw === null) return '';
  let val = String(raw).trim();
  for (let i = 0; i < 2; i++) {
    if (!/%[0-9A-Fa-f]{2}/.test(val)) break;
    try {
      val = decodeURIComponent(val);
    } catch {
      try {
        val = unescape(val);
      } catch {
        break;
      }
    }
  }
  return val;
}

function normalizeCookies(input) {
  if (!input) return [];
  if (typeof input === 'string') {
    return input
      .split(';')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const eqIdx = pair.indexOf('=');
        if (eqIdx === -1) return { name: pair, value: '', rawValue: '' };
        const name = pair.slice(0, eqIdx).trim();
        const rawVal = pair.slice(eqIdx + 1).trim();
        const value = unescapeCookieValue(rawVal);
        return { name, value, rawValue: rawVal };
      });
  }
  if (Array.isArray(input)) {
    return input.map((c) => {
      const rawVal = c.value || '';
      const decodedVal = unescapeCookieValue(rawVal);
      return {
        ...c,
        rawValue: rawVal,
        value: decodedVal
      };
    });
  }
  return [];
}

/**
 * Parse the value of `kndctr_<orgId>_AdobeOrg_consent`
 * Typical values set by Alloy / Edge Network:
 * - "general=in"
 * - "general=out"
 * - JSON or query-string key/value pairs
 */
export function parseKndctrConsentCookie(value) {
  if (!value) return { general: null, raw: '' };
  const trimmed = unescapeCookieValue(value);

  // Check if JSON
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      return {
        general: obj.general?.val || obj.general || null,
        details: obj,
        raw: trimmed
      };
    } catch {
      // fall through
    }
  }

  // Parse query-style key=value pairs (e.g., "general=in" or "general=out")
  const params = {};
  for (const part of trimmed.split(/[&;]/)) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) {
      params[k.trim()] = v.trim();
    }
  }

  return {
    general: params.general || (trimmed === 'in' || trimmed === 'out' ? trimmed : null),
    params,
    raw: trimmed
  };
}

function detectCmpCookieType(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith('optanon')) return 'OneTrust';
  if (lower.includes('euconsent')) return 'IAB TCF 2.0';
  if (lower === 'usprivacy') return 'IAB CCPA (USPrivacy)';
  if (lower === 'cookieconsent') return 'Cookiebot';
  if (lower.includes('cmapi')) return 'TrustArc';
  return 'CMP';
}

function decodeCmpCookieValue(name, value) {
  const lower = name.toLowerCase();
  if (lower === 'optanonconsent') {
    const params = {};
    value.split('&').forEach((part) => {
      const idx = part.indexOf('=');
      if (idx > -1) {
        params[part.slice(0, idx)] = part.slice(idx + 1);
      }
    });
    return {
      groups: params.groups || null,
      datestamp: params.datestamp || null,
      version: params.version || null
    };
  }
  if (lower === 'usprivacy' && value.length === 4) {
    return {
      version: value[0],
      explicitNotice: value[1],
      optOutSale: value[2],
      lspaCovered: value[3]
    };
  }
  return { preview: value.slice(0, 120) };
}

/**
 * Analyze an XDM `consents` object according to the Adobe Experience Platform
 * "Consents and Preferences" field group and data type specification.
 */
export function analyzeXdmConsents(inputPayload) {
  if (!inputPayload || typeof inputPayload !== 'object') {
    return {
      valid: false,
      found: false,
      error: 'No valid JSON object provided.'
    };
  }

  // Extract the `consents` object from various wrapper shapes:
  // 1. Direct `{ consents: { ... } }` or `{ collect: { val: "y" }, ... }`
  // 2. Alloy setConsent `{ consent: [{ standard: "Adobe", version: "2.0", value: { ... } }] }`
  // 3. Edge network payload `{ events: [{ xdm: { consents: { ... } } }], consent: [...] }`
  const extracted = extractConsentStructures(inputPayload);

  const findings = [];
  const fieldBreakdown = [];
  let overallCollectionStatus = 'unknown';

  const { adobeStandardEntries, iabEntries, xdmConsents } = extracted;

  // Check Adobe 1.0 / 2.0 `general` property
  for (const entry of adobeStandardEntries) {
    const generalVal =
      typeof entry.value?.general === 'string'
        ? entry.value.general
        : entry.value?.general?.val;

    if (generalVal) {
      const normalized = generalVal.toLowerCase();
      overallCollectionStatus = normalized === 'in' ? 'opted-in' : normalized === 'out' ? 'opted-out' : 'pending';
      fieldBreakdown.push({
        path: 'consent[].value.general',
        category: `Adobe ${entry.version || '1.0/2.0'} General`,
        rawVal: generalVal,
        label: normalized === 'in' ? 'In (Opted In)' : 'Out (Opted Out)',
        status: overallCollectionStatus,
        enforcedByWebSdk: true,
        notes: 'Controls client-side Web SDK general data collection and sets kndctr_<orgId>_AdobeOrg_consent cookie.'
      });

      if (String(entry.version) === '1.0') {
        findings.push({
          severity: 'info',
          title: `Adobe Consent Standard 1.0 Detected (general: "${generalVal}")`,
          detail:
            'This payload uses Adobe Standard 1.0 (`value: { general: "in" | "out" }`), which is the default format emitted by the Adobe Tags (Launch) Web SDK `Set consent` action (as used on further.ai). It enforces client-side collection and sets `kndctr_<orgId>_AdobeOrg_consent`, but does not populate granular XDM `consents` attributes in Real-Time Customer Profile unless upgraded to Adobe 2.0.',
          docUrl: AEP_DOCS_LINKS.sdk
        });
      }
    }
  }

  if (xdmConsents) {
    // 1. consents.collect.val
    if (xdmConsents.collect) {
      const val = xdmConsents.collect.val;
      const def = XDM_CONSENT_VAL_DEFINITIONS[val] || {
        code: val,
        label: `Custom/Unrecognized (${val})`,
        status: 'unknown',
        category: 'Unknown',
        description: 'Not a standard XDM Consents & Preferences enum value.'
      };
      if (def.status !== 'unknown') {
        overallCollectionStatus = def.status;
      }
      fieldBreakdown.push({
        path: 'consents.collect.val',
        category: 'Data Collection (Core)',
        rawVal: val,
        label: def.label,
        status: def.status,
        enforcedByWebSdk: true,
        notes: `${def.description} Automatically enforced by the AEP Web SDK on subsequent hits.`
      });

      if (!XDM_CONSENT_VAL_DEFINITIONS[val]) {
        findings.push({
          severity: 'warning',
          title: 'Non-standard consents.collect.val value',
          detail: `Value "${val}" is not in the standard XDM enum (y, n, p, u, dy, dn, VI, VO, LI, LO, CT, CP).`,
          docUrl: AEP_DOCS_LINKS.xdmDataType
        });
      }
    } else if (overallCollectionStatus === 'unknown' && iabEntries.length === 0) {
      findings.push({
        severity: 'info',
        title: 'No consents.collect.val specified',
        detail: 'Without `consents.collect.val` (or `general`), Web SDK automatic data-collection enforcement will rely on existing cookie state or `defaultConsent`.',
        docUrl: AEP_DOCS_LINKS.overview
      });
    }

    // 2. consents.share.val
    if (xdmConsents.share) {
      const val = xdmConsents.share.val;
      const def = XDM_CONSENT_VAL_DEFINITIONS[val] || {
        label: String(val),
        status: 'unknown',
        description: 'Custom value'
      };
      fieldBreakdown.push({
        path: 'consents.share.val',
        category: 'Data Sharing',
        rawVal: val,
        label: def.label,
        status: def.status,
        enforcedByWebSdk: false,
        notes: 'Captures consent for sharing/selling customer data with 2nd or 3rd parties. Enforced downstream via AEP Data Governance & Destinations.'
      });
    }

    // 3. consents.personalize.content.val
    if (xdmConsents.personalize?.content) {
      const val = xdmConsents.personalize.content.val;
      const def = XDM_CONSENT_VAL_DEFINITIONS[val] || {
        label: String(val),
        status: 'unknown',
        description: 'Custom value'
      };
      fieldBreakdown.push({
        path: 'consents.personalize.content.val',
        category: 'Personalization Preference',
        rawVal: val,
        label: def.label,
        status: def.status,
        enforcedByWebSdk: false,
        notes: 'Governs whether profile behaviors/attributes can tailor personalized content.'
      });
    }

    // 4. consents.marketing
    if (xdmConsents.marketing) {
      const mkt = xdmConsents.marketing;
      if (mkt.preferred) {
        fieldBreakdown.push({
          path: 'consents.marketing.preferred',
          category: 'Marketing Preference',
          rawVal: mkt.preferred,
          label: `Preferred: ${mkt.preferred}`,
          status: 'info',
          enforcedByWebSdk: false,
          notes: 'Customer’s preferred communication channel (email, push, sms, call, directMail).'
        });
      }

      for (const ch of MARKETING_CHANNELS) {
        if (mkt[ch.key]) {
          const chObj = mkt[ch.key];
          const val = chObj.val;
          const def = XDM_CONSENT_VAL_DEFINITIONS[val] || {
            label: String(val || 'unset'),
            status: 'unknown'
          };
          const subCount = chObj.subscriptions ? Object.keys(chObj.subscriptions).length : 0;
          const extra = [
            chObj.reason ? `Reason: "${chObj.reason}"` : null,
            chObj.time ? `Time: ${chObj.time}` : null,
            subCount > 0 ? `${subCount} subscription list(s)` : null
          ]
            .filter(Boolean)
            .join(' • ');

          fieldBreakdown.push({
            path: `consents.marketing.${ch.key}.val`,
            category: `Marketing (${ch.label})`,
            rawVal: val,
            label: def.label,
            status: def.status,
            enforcedByWebSdk: false,
            notes: extra ? `${ch.description} (${extra})` : ch.description
          });
        }
      }
    }

    // 5. consents.adID (Important schema distinction from docs!)
    if (xdmConsents.adID) {
      const val = xdmConsents.adID.val;
      const idType = xdmConsents.adID.idType || 'Unspecified';
      const def = XDM_CONSENT_VAL_DEFINITIONS[val] || { label: String(val), status: 'unknown' };
      fieldBreakdown.push({
        path: 'consents.adID',
        category: `Advertiser ID (${idType})`,
        rawVal: val,
        label: `${def.label} (${idType})`,
        status: def.status,
        enforcedByWebSdk: false,
        notes: 'Tracks consent for mobile/device Advertiser IDs (e.g., Apple IDFA, Google GAID).'
      });

      findings.push({
        severity: 'warning',
        title: 'Schema Compatibility Notice: consents.adID',
        detail:
          'Per AEP documentation, the standard "Consents and Preferences" field group for XDM Individual Profile removes `adID` (and adds `idSpecific`). If ingesting `adID` into Profile, ensure you use a custom field group with the Consents data type.',
        docUrl: AEP_DOCS_LINKS.xdmFieldGroup
      });
    }

    // 6. consents.idSpecific
    if (xdmConsents.idSpecific && typeof xdmConsents.idSpecific === 'object') {
      const namespaces = Object.keys(xdmConsents.idSpecific);
      for (const ns of namespaces) {
        const identities = Object.keys(xdmConsents.idSpecific[ns] || {});
        fieldBreakdown.push({
          path: `consents.idSpecific.${ns}`,
          category: 'Identity-Specific Consent',
          rawVal: `${identities.length} ID(s)`,
          label: `Namespace: ${ns} (${identities.join(', ')})`,
          status: 'info',
          enforcedByWebSdk: false,
          notes: 'Granular channel/preference overrides tied to a specific identity (e.g., a single email address or ECID).'
        });
      }
    }

    // 7. consents.metadata.time (Critical for Merge Policies!)
    if (xdmConsents.metadata?.time) {
      const timeStr = xdmConsents.metadata.time;
      const parsedDate = Date.parse(timeStr);
      const isValidIso = !Number.isNaN(parsedDate);
      fieldBreakdown.push({
        path: 'consents.metadata.time',
        category: 'Audit & Merge Policy Timestamp',
        rawVal: timeStr,
        label: isValidIso ? new Date(parsedDate).toUTCString() : 'Invalid Timestamp',
        status: isValidIso ? 'opted-in' : 'opted-out',
        enforcedByWebSdk: false,
        notes: 'Required by Real-Time Customer Profile Timestamp-Ordered Merge Policies to ensure the latest consent wins.'
      });

      if (!isValidIso) {
        findings.push({
          severity: 'error',
          title: 'Invalid consents.metadata.time format',
          detail: `Value "${timeStr}" is not a valid ISO 8601 timestamp. Profile merge policies may fail to order consent updates accurately.`,
          docUrl: AEP_DOCS_LINKS.overview
        });
      }
    } else {
      findings.push({
        severity: 'warning',
        title: 'Missing consents.metadata.time timestamp',
        detail:
          'AEP recommends including `metadata.time` (ISO 8601) in every consent payload so Real-Time Customer Profile Merge Policies (Timestamp Precedence) always prioritize the customer’s most recent consent choice.',
        docUrl: AEP_DOCS_LINKS.overview
      });
    }
  }

  // Check IAB TCF 2.0 entries
  for (const iab of iabEntries) {
    const tcString = iab.value;
    const decodedTcf = decodeTcfStringSummary(tcString);
    const hasVendor565 = decodedTcf.vendor565Consent;
    if (overallCollectionStatus === 'unknown') {
      overallCollectionStatus =
        hasVendor565 === true ? 'opted-in' : hasVendor565 === false ? 'opted-out' : 'info';
    }
    fieldBreakdown.push({
      path: 'consent[IAB TCF 2.0]',
      category: 'IAB TCF 2.0',
      rawVal: tcString ? `${tcString.slice(0, 18)}...` : 'empty',
      label: `gdprApplies: ${Boolean(iab.gdprApplies)} • personalData: ${Boolean(iab.gdprContainsPersonalData)}`,
      status: overallCollectionStatus,
      enforcedByWebSdk: true,
      notes: `Adobe Experience Platform IAB TCF 2.0 Vendor ID is 565. ${decodedTcf.summary}`
    });
  }

  if (fieldBreakdown.length === 0) {
    return {
      valid: true,
      found: false,
      overallCollectionStatus: 'unknown',
      fieldBreakdown: [],
      findings: [
        {
          severity: 'info',
          title: 'No AEP Consent fields detected in payload',
          detail:
            'Expected an `alloy("setConsent", ...)` payload (`consent` array with `standard: "Adobe"`, `version: "2.0"`) or an XDM `consents` object.',
          docUrl: AEP_DOCS_LINKS.overview
        }
      ],
      extracted
    };
  }

  // Positive confirmation finding if Adobe 2.0 + collect.val + metadata.time are all valid
  if (xdmConsents?.collect?.val && xdmConsents?.metadata?.time) {
    findings.unshift({
      severity: 'success',
      title: 'Compliant Adobe 2.0 XDM Consent Payload',
      detail:
        'Payload includes both `collect.val` (for automatic Web SDK enforcement) and `metadata.time` (for Real-Time Customer Profile Merge Policy timestamp precedence).',
      docUrl: AEP_DOCS_LINKS.overview
    });
  }

  return {
    valid: true,
    found: true,
    overallCollectionStatus,
    fieldBreakdown,
    findings,
    extracted
  };
}

function extractConsentStructures(payload) {
  const adobeStandardEntries = [];
  const iabEntries = [];
  let xdmConsents = null;

  // Unwrap array if needed
  const root = Array.isArray(payload) ? { consent: payload } : payload;

  // Check `consent` array (from `alloy("setConsent", { consent: [...] })` or Edge `/v1/privacy/set-consent`)
  const consentArr = Array.isArray(root.consent)
    ? root.consent
    : root.consent && typeof root.consent === 'object'
    ? [root.consent]
    : [];

  for (const item of consentArr) {
    if (!item || typeof item !== 'object') continue;
    const std = (item.standard || '').toLowerCase();
    if (std === 'adobe') {
      adobeStandardEntries.push(item);
      if (item.value && typeof item.value === 'object') {
        if (item.value.consents) {
          xdmConsents = item.value.consents;
        } else if (
          item.value.collect ||
          item.value.share ||
          item.value.personalize ||
          item.value.marketing ||
          item.value.metadata ||
          item.value.idSpecific ||
          item.value.adID
        ) {
          xdmConsents = item.value;
        }
      }
    } else if (std.includes('iab') || std.includes('tcf')) {
      iabEntries.push(item);
    }
  }

  // Check `xdm.consents` or `events[0].xdm.consents`
  if (!xdmConsents) {
    if (root.consents && typeof root.consents === 'object') {
      xdmConsents = root.consents;
    } else if (root.xdm?.consents && typeof root.xdm.consents === 'object') {
      xdmConsents = root.xdm.consents;
    } else if (Array.isArray(root.events)) {
      for (const ev of root.events) {
        if (ev?.xdm?.consents) {
          xdmConsents = ev.xdm.consents;
          break;
        }
      }
    } else if (
      root.collect ||
      root.share ||
      root.personalize ||
      root.marketing ||
      root.idSpecific ||
      root.adID
    ) {
      xdmConsents = root;
    }
  }

  return {
    adobeStandardEntries,
    iabEntries,
    xdmConsents
  };
}

/**
 * Lightweight IAB TCF v2 Core String Bitfield Decoder
 * Extracts Version, Created/Updated timestamps, CMP ID, CMP Version, Policy Version,
 * Purpose Consents (1-10), and checks Vendor 565 (Adobe Experience Platform).
 */
export function decodeTcfStringSummary(tcString) {
  if (!tcString || typeof tcString !== 'string') {
    return { valid: false, summary: 'Empty or missing TCF string.' };
  }

  const coreSegment = tcString.trim().split('.')[0];
  try {
    const bits = base64UrlToBits(coreSegment);
    if (bits.length < 213) {
      return {
        valid: false,
        summary: `Short/partial TCF string (${coreSegment.length} chars). Verify with CMP __tcfapi.`
      };
    }

    const version = readInt(bits, 0, 6);
    if (version !== 2) {
      return {
        valid: false,
        version,
        summary: `TCF version ${version} detected. Note: AEP only supports IAB TCF 2.0 or greater.`
      };
    }

    const createdDeciSeconds = readInt(bits, 6, 36);
    const lastUpdatedDeciSeconds = readInt(bits, 42, 36);
    const cmpId = readInt(bits, 78, 12);
    const cmpVersion = readInt(bits, 90, 12);
    const consentScreen = readInt(bits, 102, 6);
    const countryCode =
      String.fromCharCode(65 + readInt(bits, 108, 6)) +
      String.fromCharCode(65 + readInt(bits, 114, 6));
    const policyVersion = readInt(bits, 120, 6);
    const isServiceSpecific = bits[126] === '1';
    const purposeOneTreatment = bits[129] === '1';

    // Purposes Consents: 24 bits starting at offset 152
    const purposesConsented = [];
    for (let p = 1; p <= 10; p++) {
      if (bits[152 + (p - 1)] === '1') {
        purposesConsented.push(p);
      }
    }

    // Check Vendor Consents section (starts at offset 200: MaxVendorId (16 bits), IsRangeEncoding (1 bit))
    let vendor565Consent = null;
    if (bits.length >= 217) {
      const maxVendorId = readInt(bits, 200, 16);
      const isRange = bits[216] === '1';
      if (maxVendorId < 565) {
        vendor565Consent = false;
      } else if (!isRange && bits.length >= 217 + 565) {
        vendor565Consent = bits[217 + (565 - 1)] === '1';
      } else if (isRange) {
        vendor565Consent = decodeVendorRangeForTarget(bits, 217, 565);
      }
    }

    return {
      valid: true,
      version,
      created: new Date(createdDeciSeconds * 100).toISOString(),
      lastUpdated: new Date(lastUpdatedDeciSeconds * 100).toISOString(),
      cmpId,
      cmpVersion,
      consentScreen,
      countryCode,
      policyVersion,
      isServiceSpecific,
      purposeOneTreatment,
      purposesConsented,
      vendor565Consent,
      summary: `TCF v${version} • CMP ID #${cmpId} (v${cmpVersion}) • Country: ${countryCode} • Purposes Granted: [${
        purposesConsented.join(', ') || 'None'
      }] • Adobe Vendor #565: ${
        vendor565Consent === true
          ? 'GRANTED'
          : vendor565Consent === false
          ? 'DENIED'
          : 'Check __tcfapi'
      }`
    };
  } catch (err) {
    return {
      valid: false,
      summary: `Could not parse TCF bitfield: ${err.message}`
    };
  }
}

function base64UrlToBits(b64Url) {
  const base64 = b64Url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binStr = atob(padded);
  let bits = '';
  for (let i = 0; i < binStr.length; i++) {
    bits += binStr.charCodeAt(i).toString(2).padStart(8, '0');
  }
  return bits;
}

function readInt(bits, start, length) {
  const slice = bits.slice(start, start + length);
  return parseInt(slice, 2) || 0;
}

function decodeVendorRangeForTarget(bits, offset, targetVendorId) {
  let pos = offset;
  if (pos + 12 > bits.length) return null;
  const numEntries = readInt(bits, pos, 12);
  pos += 12;
  for (let i = 0; i < numEntries; i++) {
    if (pos >= bits.length) break;
    const isRange = bits[pos] === '1';
    pos += 1;
    if (isRange) {
      if (pos + 32 > bits.length) break;
      const startId = readInt(bits, pos, 16);
      const endId = readInt(bits, pos + 16, 16);
      pos += 32;
      if (targetVendorId >= startId && targetVendorId <= endId) return true;
    } else {
      if (pos + 16 > bits.length) break;
      const singleId = readInt(bits, pos, 16);
      pos += 16;
      if (singleId === targetVendorId) return true;
    }
  }
  return false;
}

/**
 * Resolve a configuration field that may use Adobe Tags / Launch `%something here%` Data Element syntax
 * into both its `%...%` token representation and its live `_satellite.getVar('something here')` value.
 */
export function resolveFieldWithDataElement(
  rawVal,
  binding = null,
  resolvedMap = {},
  fallbackRuntimeVal = null
) {
  const candidateRaw = binding?.raw || rawVal || fallbackRuntimeVal || null;
  if (!candidateRaw || typeof candidateRaw !== 'string') {
    return {
      raw: candidateRaw,
      resolved: candidateRaw,
      effective: candidateRaw,
      isDataElement: false,
      tokens: []
    };
  }

  const tokenRegex = /%([^%]+)%/g;
  const tokens = [];
  let match;
  while ((match = tokenRegex.exec(candidateRaw)) !== null) {
    const token = match[0];
    const name = match[1];
    const fromBinding = binding?.tokens?.find((t) => t.name === name)?.value;
    const hasInMap =
      resolvedMap &&
      (Object.prototype.hasOwnProperty.call(resolvedMap, name) ||
        Object.prototype.hasOwnProperty.call(resolvedMap, name.trim()));
    const fromMap = hasInMap
      ? resolvedMap[name] !== undefined
        ? resolvedMap[name]
        : resolvedMap[name.trim()]
      : undefined;

    const val = fromBinding !== undefined ? fromBinding : fromMap;
    tokens.push({
      token,
      name,
      value: val
    });
  }

  if (tokens.length === 0) {
    return {
      raw: candidateRaw,
      resolved: candidateRaw,
      effective: candidateRaw,
      isDataElement: false,
      tokens: []
    };
  }

  let hasAnyResolvedToken = false;
  let resolvedStr = candidateRaw.replace(/%([^%]+)%/g, (full, name) => {
    const t = tokens.find((item) => item.name === name);
    if (t && t.value !== undefined && t.value !== null) {
      hasAnyResolvedToken = true;
      return typeof t.value === 'object' ? JSON.stringify(t.value) : String(t.value);
    }
    return full;
  });

  if (!hasAnyResolvedToken) {
    if (binding?.resolved && binding.resolved !== candidateRaw) {
      resolvedStr = binding.resolved;
      hasAnyResolvedToken = true;
    } else if (
      fallbackRuntimeVal &&
      typeof fallbackRuntimeVal === 'string' &&
      fallbackRuntimeVal !== candidateRaw &&
      !/%[^%]+%/.test(fallbackRuntimeVal)
    ) {
      resolvedStr = fallbackRuntimeVal;
      hasAnyResolvedToken = true;
    }
  }

  return {
    raw: candidateRaw,
    resolved: hasAnyResolvedToken ? resolvedStr : null,
    effective: hasAnyResolvedToken ? resolvedStr : candidateRaw,
    isDataElement: true,
    tokens
  };
}

/**
 * Compute unified Visitor Consent Diagnostics from:
 * - Cookie analysis
 * - Detected Alloy / Web SDK instances (`defaultConsent`, `orgId`, `datastreamId`, queued events)
 * - Intercepted Edge Network requests (`set-consent`, `interact`, `collect`)
 * - CMP / TCF state
 */
export function evaluateVisitorConsentState({
  cookieAnalysis,
  sdkInfo = {},
  edgeEvents = [],
  tcfState = null
}) {
  const diagnostics = [];
  const consentCookie = cookieAnalysis?.aepConsentCookies?.[0] || null;
  const identityCookie = cookieAnalysis?.aepIdentityCookies?.[0] || null;
  const checkCookie = cookieAnalysis?.aepConsentCheckCookies?.[0] || null;

  const latestSetConsentEvent = [...edgeEvents]
    .reverse()
    .find((e) => e.type === 'set-consent' || e.command === 'setConsent');
  const anyEdgeDatastreamId = [...edgeEvents].reverse().find((e) => e.datastreamId)?.datastreamId || null;

  const bindings = sdkInfo?.launchConfigBindings || {};
  const resolvedMap = sdkInfo?.resolvedDataElements || {};

  const orgIdField = resolveFieldWithDataElement(
    sdkInfo?.orgId,
    bindings.orgId,
    resolvedMap,
    consentCookie?.orgId || identityCookie?.orgId || latestSetConsentEvent?.orgId || null
  );

  const datastreamIdField = resolveFieldWithDataElement(
    sdkInfo?.datastreamId,
    bindings.datastreamId,
    resolvedMap,
    latestSetConsentEvent?.datastreamId || anyEdgeDatastreamId || null
  );

  const defaultConsentField = resolveFieldWithDataElement(
    sdkInfo?.defaultConsent,
    bindings.defaultConsent,
    resolvedMap,
    null
  );

  const edgeDomainField = resolveFieldWithDataElement(
    sdkInfo?.edgeDomain,
    bindings.edgeDomain,
    resolvedMap,
    null
  );

  const defaultConsent = defaultConsentField.effective || null;

  const aepDetected = Boolean(
    sdkInfo?.alloyDetected ||
      orgIdField.effective ||
      datastreamIdField.effective ||
      defaultConsentField.effective ||
      consentCookie ||
      identityCookie ||
      checkCookie ||
      edgeEvents.length > 0
  );

  // Determine effective consent state
  let effectiveState = aepDetected ? 'unknown' : 'not-detected';
  let stateSource = aepDetected
    ? 'AEP detected, awaiting consent signal'
    : 'Experience Platform not detected on this page';

  if (consentCookie?.generalStatus === 'in') {
    effectiveState = 'opted-in';
    stateSource = `Cookie ${consentCookie.name} (general=in)`;
  } else if (consentCookie?.generalStatus === 'out') {
    effectiveState = 'opted-out';
    stateSource = `Cookie ${consentCookie.name} (general=out)`;
  } else if (
    latestSetConsentEvent?.consentAnalysis?.overallCollectionStatus &&
    latestSetConsentEvent.consentAnalysis.overallCollectionStatus !== 'unknown'
  ) {
    effectiveState = latestSetConsentEvent.consentAnalysis.overallCollectionStatus;
    stateSource = `Latest setConsent command (${effectiveState})`;
  } else if (defaultConsent === 'pending') {
    effectiveState = 'pending';
    stateSource = defaultConsentField.isDataElement
      ? `Web SDK defaultConsent = "pending" (via ${defaultConsentField.raw})`
      : 'Web SDK defaultConsent = "pending" (awaiting setConsent)';
  } else if (defaultConsent === 'in') {
    effectiveState = 'opted-in';
    stateSource = defaultConsentField.isDataElement
      ? `Web SDK defaultConsent = "in" (via ${defaultConsentField.raw})`
      : 'Web SDK defaultConsent = "in" (Implied Opt-In)';
  } else if (defaultConsent === 'out') {
    effectiveState = 'opted-out';
    stateSource = defaultConsentField.isDataElement
      ? `Web SDK defaultConsent = "out" (via ${defaultConsentField.raw})`
      : 'Web SDK defaultConsent = "out"';
  }

  // Diagnostic Rule 1: Strict Opt-in vs Implied Opt-in check
  if (defaultConsent === 'in' && !consentCookie) {
    diagnostics.push({
      severity: 'warning',
      title: 'Implied Opt-In Active Prior to Explicit Consent',
      detail:
        'Web SDK is configured with `defaultConsent: "in"` and no `kndctr_*_consent` cookie was previously set. Data collection and ECID generation occur immediately on page load. For strict GDPR/opt-in regions, configure `defaultConsent: "pending"` instead.',
      docUrl: AEP_DOCS_LINKS.webSdkConsent
    });
  }

  // Diagnostic Rule 2: Pending state with queued events
  if (effectiveState === 'pending') {
    const queuedCount = sdkInfo?.queuedEventCount || 0;
    diagnostics.push({
      severity: 'info',
      title: `Consent Pending (${queuedCount} event(s) held in Web SDK queue)`,
      detail:
        'Because `defaultConsent` is `"pending"` and no consent cookie is present, the AEP Web SDK is holding events in memory and has not generated an ECID cookie yet. Call `alloy("setConsent", ...)` once the visitor interacts with your CMP.',
      docUrl: AEP_DOCS_LINKS.sdk
    });
  }

  // Diagnostic Rule 3: Identity cookie exists while opted out
  if (effectiveState === 'opted-out' && identityCookie) {
    diagnostics.push({
      severity: 'warning',
      title: 'Identity Cookie Present While Visitor is Opted Out',
      detail: `Found ${identityCookie.name} alongside an opted-out consent state. This typically happens when a visitor initially had \`defaultConsent: "in"\` (or opted in) before opting out. Web SDK will now block outgoing Edge Network hits while \`general=out\`.`,
      docUrl: AEP_DOCS_LINKS.webSdkConsent
    });
  }

  // Diagnostic Rule 4: Interact hits sent before setConsent
  const firstSetConsentIdx = edgeEvents.findIndex(
    (e) => e.type === 'set-consent' || e.command === 'setConsent'
  );
  const firstInteractIdx = edgeEvents.findIndex(
    (e) => e.type === 'interact' || e.command === 'sendEvent'
  );
  if (
    firstInteractIdx !== -1 &&
    (firstSetConsentIdx === -1 || firstInteractIdx < firstSetConsentIdx) &&
    !consentCookie
  ) {
    diagnostics.push({
      severity: 'warning',
      title: 'ExperienceEvent Sent Before Consent Was Initialized',
      detail:
        'An `interact` / `sendEvent` call fired before `setConsent` was called and without a cached `kndctr_*_consent` cookie. Remember that consent fields sent inside ExperienceEvents are NOT honored in downstream AEP enforcement workflows—use `setConsent` pointing to a Profile-enabled dataset.',
      docUrl: AEP_DOCS_LINKS.sdk
    });
  }

  // Diagnostic Rule 5: IAB TCF 2.0 Vendor 565 Mismatch
  if (tcfState?.gdprApplies && tcfState?.vendor565Consent === false && effectiveState === 'opted-in') {
    diagnostics.push({
      severity: 'error',
      title: 'TCF 2.0 Conflict: Adobe Vendor ID 565 Denied, but Web SDK is Opted In',
      detail:
        'IAB TCF 2.0 indicates GDPR applies and Adobe Experience Platform (Vendor ID 565) does NOT have consent, yet the AEP Web SDK is currently opted in (`general=in`). Verify your CMP-to-Alloy mapping script.',
      docUrl: AEP_DOCS_LINKS.iabOverview
    });
  }

  // Diagnostic Rule 6: Healthy Opt-In State
  if (effectiveState === 'opted-in' && consentCookie && identityCookie && diagnostics.length === 0) {
    diagnostics.push({
      severity: 'success',
      title: 'Healthy AEP Opt-In State',
      detail: `Visitor consent is persisted in ${consentCookie.name} (general=in) and ECID identity is active in ${identityCookie.name}.`,
      docUrl: AEP_DOCS_LINKS.overview
    });
  }

  // Diagnostic Rule 7: Healthy Opt-Out State
  if (effectiveState === 'opted-out' && consentCookie && !identityCookie) {
    diagnostics.push({
      severity: 'success',
      title: 'Strict Opt-Out Enforced',
      detail: `Visitor choice is persisted in ${consentCookie.name} (general=out). Web SDK is blocking Edge Network data collection.`,
      docUrl: AEP_DOCS_LINKS.overview
    });
  }

  // Diagnostic Rule 8: Adobe Tags (Launch) Data Elements & Consent Integration
  if (sdkInfo?.launchInfo) {
    const li = sdkInfo.launchInfo;
    const deEntries = Object.entries(resolvedMap).filter(([, v]) => v !== undefined);
    const hasOneTrustMapping =
      li.aepConsentDataElement !== null && li.aepConsentDataElement !== undefined;

    if (hasOneTrustMapping) {
      const dlEvents = sdkInfo.dataLayerConsentEvents || [];
      const lastDlEvent = dlEvents[dlEvents.length - 1];
      const groups =
        li.onetrustActiveGroupsDataElement || lastDlEvent?.OnetrustActiveGroups || 'not yet pushed';
      const aepConsentDe =
        li.aepConsentDataElement ||
        (typeof groups === 'string' && groups.includes('C0002') ? 'in' : 'out');

      diagnostics.push({
        severity: 'info',
        title: `Adobe Tags (Launch) Property "${li.propertyName || 'Detected'}" • OneTrust C0002 -> AEP Consent Mapping`,
        detail: `Launch evaluates Data Element "%AEP Consent%" -> _satellite.getVar("AEP Consent") = "${aepConsentDe}" (checks if OnetrustActiveGroups "${groups}" contains Performance category "C0002"). Rules "Consent Loaded | [Web SDK]" and "Consent Updated | [Web SDK]" fire alloy("setConsent") with Adobe 1.0 { general: "${aepConsentDe}" } to ${
          edgeDomainField.effective || 'Edge Network'
        }.`,
        docUrl: AEP_DOCS_LINKS.sdk
      });
    } else if (deEntries.length > 0) {
      const formattedList = deEntries
        .map(([name, val]) => `_satellite.getVar("${name}") => ${JSON.stringify(val)}`)
        .join(' • ');
      diagnostics.push({
        severity: 'info',
        title: `Adobe Tags (Launch) Property "${li.propertyName || 'Detected'}" • Data Elements Resolved`,
        detail: `Evaluated live Launch Data Elements via _satellite.getVar(...): ${formattedList}`,
        docUrl: AEP_DOCS_LINKS.sdk
      });
    }

    if (li.ecidDataElement === '' && defaultConsent === 'pending') {
      diagnostics.push({
        severity: 'warning',
        title: 'First-Pageview ECID Data Element Race Condition (`defaultConsent: "pending"`)',
        detail:
          'Launch Data Element "ECID" synchronously reads `kndctr_<orgId>_AdobeOrg_identity` when `Page Load Completed | [Web SDK]` runs. On a first-time visit while consent is still `"pending"`, the identity cookie is not yet set until `setConsent` completes, so `eVar19` (`%ECID%`) and `eVar20` (`%validationBucketV2%`) evaluate to empty string `""` on the initial queued pageview.',
        docUrl: AEP_DOCS_LINKS.webSdkConsent
      });
    }
  }

  return {
    aepDetected,
    effectiveState,
    stateSource,
    orgId:
      orgIdField.effective ||
      consentCookie?.orgId ||
      identityCookie?.orgId ||
      latestSetConsentEvent?.orgId ||
      null,
    datastreamId: datastreamIdField.effective || latestSetConsentEvent?.datastreamId || null,
    edgeDomain: edgeDomainField.effective || null,
    defaultConsent: defaultConsentField.effective || 'Not detected',
    fields: {
      orgId: orgIdField,
      datastreamId: datastreamIdField,
      defaultConsent: defaultConsentField,
      edgeDomain: edgeDomainField
    },
    resolvedDataElements: resolvedMap,
    hasConsentCookie: Boolean(consentCookie),
    hasConsentCheckCookie: Boolean(checkCookie),
    hasIdentityCookie: Boolean(identityCookie),
    consentCookieValue: consentCookie?.value || null,
    diagnostics
  };
}

/**
 * Generate ready-to-use `alloy("setConsent", ...)` code snippets for Adobe 2.0, Adobe 1.0, and IAB TCF 2.0
 */
export function generateSetConsentSnippet({
  standard = 'Adobe',
  version = '2.0',
  collectVal = 'y',
  shareVal = 'y',
  personalizeVal = 'y',
  preferredChannel = 'email',
  emailVal = 'y',
  pushVal = 'n',
  smsVal = 'n',
  includeIdSpecific = false,
  idNamespace = 'ECID',
  idValue = '37784337855396895622558625508046772577',
  timestamp = new Date().toISOString()
}) {
  if (standard === 'Adobe' && version === '1.0') {
    const general = collectVal === 'n' || collectVal === 'dn' || collectVal === 'LO' ? 'out' : 'in';
    const payload = {
      consent: [
        {
          standard: 'Adobe',
          version: '1.0',
          value: {
            general
          }
        }
      ]
    };
    return {
      payload,
      code: `alloy("setConsent", ${JSON.stringify(payload, null, 2)});`
    };
  }

  if (standard === 'IAB TCF') {
    const sampleTcString = 'COtybn4PA_zT4KjACBENAPCIAEBAAECAAIAAAAAAAAAA';
    const payload = {
      consent: [
        {
          standard: 'IAB TCF',
          version: '2.0',
          value: sampleTcString,
          gdprApplies: true,
          gdprContainsPersonalData: false
        }
      ]
    };
    return {
      payload,
      code: `// Retrieve TC string from your IAB TCF 2.0 CMP and pass to Alloy:\n__tcfapi("addEventListener", 2, function(tcData, success) {\n  if (success && (tcData.eventStatus === "useractioncomplete" || tcData.eventStatus === "tcloaded")) {\n    alloy("setConsent", {\n      consent: [{\n        standard: "IAB TCF",\n        version: "2.0",\n        value: tcData.tcString,\n        gdprApplies: tcData.gdprApplies,\n        gdprContainsPersonalData: false\n      }]\n    });\n  }\n});`
    };
  }

  // Default: Adobe 2.0 Standard (XDM Consents and Preferences Field Group)
  const valueObj = {
    collect: { val: collectVal },
    share: { val: shareVal },
    personalize: {
      content: { val: personalizeVal }
    },
    marketing: {
      preferred: preferredChannel,
      any: { val: emailVal === 'y' || pushVal === 'y' || smsVal === 'y' ? 'y' : 'n' },
      email: { val: emailVal },
      push: { val: pushVal },
      sms: { val: smsVal }
    },
    metadata: {
      time: timestamp
    }
  };

  if (includeIdSpecific && idNamespace && idValue) {
    valueObj.idSpecific = {
      [idNamespace]: {
        [idValue]: {
          marketing: {
            email: {
              val: emailVal,
              time: timestamp
            }
          }
        }
      }
    };
  }

  const payload = {
    consent: [
      {
        standard: 'Adobe',
        version: '2.0',
        value: valueObj
      }
    ]
  };

  return {
    payload,
    code: `alloy("setConsent", ${JSON.stringify(payload, null, 2)});`
  };
}
