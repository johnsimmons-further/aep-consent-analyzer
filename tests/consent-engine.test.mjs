import assert from 'node:assert/strict';
import {
  analyzeCookies,
  analyzeXdmConsents,
  decodeTcfStringSummary,
  evaluateVisitorConsentState,
  generateSetConsentSnippet
} from '../src/core/consent-engine.js';

console.log('Running AEP Consent Analyzer Engine Tests...');

// 1. Test kndctr_<orgId>_AdobeOrg_consent cookie parsing
{
  const rawCookies =
    'kndctr_97D1F3F459CE0AD80A495CBE_AdobeOrg_consent=general%3Din; kndctr_97D1F3F459CE0AD80A495CBE_AdobeOrg_identity=CiY12345==; kndctr_97D1F3F459CE0AD80A495CBE_AdobeOrg_consent_check=1; OptanonConsent=groups=C0001%3A1%2CC0002%3A1';
  const result = analyzeCookies(rawCookies);

  assert.equal(result.aepConsentCookies.length, 1);
  assert.equal(result.aepConsentCookies[0].orgId, '97D1F3F459CE0AD80A495CBE@AdobeOrg');
  assert.equal(result.aepConsentCookies[0].generalStatus, 'in');
  assert.equal(result.aepIdentityCookies.length, 1);
  assert.equal(result.aepConsentCheckCookies.length, 1);
  assert.equal(result.cmpCookies.length, 1);
  assert.equal(result.cmpCookies[0].cmpType, 'OneTrust');
  console.log('✓ Cookie parser accurately extracts kndctr_*_consent, identity, check, and CMP cookies');
}

// 2. Test XDM Consents and Preferences schema validation (Adobe 2.0 Standard)
{
  const adobe20Payload = {
    consent: [
      {
        standard: 'Adobe',
        version: '2.0',
        value: {
          collect: { val: 'VI' },
          share: { val: 'y' },
          personalize: { content: { val: 'y' } },
          marketing: {
            preferred: 'email',
            any: { val: 'y' },
            email: { val: 'y' },
            push: { val: 'n', reason: 'Too Frequent', time: '2026-10-13T15:00:00Z' }
          },
          idSpecific: {
            ECID: {
              '37784337855396895622558625508046772577': {
                marketing: { email: { val: 'y' } }
              }
            }
          },
          metadata: {
            time: '2026-10-13T15:00:00Z'
          }
        }
      }
    ]
  };

  const xdmRes = analyzeXdmConsents(adobe20Payload);
  assert.equal(xdmRes.valid, true);
  assert.equal(xdmRes.found, true);
  assert.equal(xdmRes.overallCollectionStatus, 'opted-in');
  assert.ok(xdmRes.fieldBreakdown.some((f) => f.path === 'consents.collect.val' && f.rawVal === 'VI'));
  assert.ok(xdmRes.fieldBreakdown.some((f) => f.path === 'consents.idSpecific.ECID'));
  assert.ok(xdmRes.findings.some((f) => f.severity === 'success'));
  console.log('✓ XDM Consents & Preferences validator verifies Adobe 2.0 payloads and legal bases (VI, LI, y, n)');
}

// 3. Test missing metadata.time & adID schema compatibility warnings
{
  const incompletePayload = {
    consents: {
      collect: { val: 'y' },
      adID: { idType: 'IDFA', val: 'n' }
    }
  };
  const xdmRes = analyzeXdmConsents(incompletePayload);
  assert.ok(
    xdmRes.findings.some((f) => f.title.includes('Missing consents.metadata.time')),
    'Should warn when metadata.time is missing for Merge Policies'
  );
  assert.ok(
    xdmRes.findings.some((f) => f.title.includes('consents.adID')),
    'Should warn about adID compatibility on XDM Individual Profile field group'
  );
  console.log('✓ XDM validator flags missing metadata.time (Merge Policy requirement) and adID schema rules');
}

// 4. Test Visitor Consent Diagnostics (GDPR Pending Queue & Implied Opt-In Leak)
{
  const emptyCookies = analyzeCookies('');
  const pendingEval = evaluateVisitorConsentState({
    cookieAnalysis: emptyCookies,
    sdkInfo: {
      defaultConsent: 'pending',
      orgId: 'TESTORG@AdobeOrg',
      datastreamId: 'ds-123',
      queuedEventCount: 2
    },
    edgeEvents: []
  });
  assert.equal(pendingEval.effectiveState, 'pending');
  assert.ok(pendingEval.diagnostics.some((d) => d.title.includes('Consent Pending (2 event(s) held')));

  const leakEval = evaluateVisitorConsentState({
    cookieAnalysis: emptyCookies,
    sdkInfo: {
      defaultConsent: 'in',
      orgId: 'TESTORG@AdobeOrg'
    },
    edgeEvents: [],
    tcfState: { gdprApplies: true, vendor565Consent: false }
  });
  assert.equal(leakEval.effectiveState, 'opted-in');
  assert.ok(leakEval.diagnostics.some((d) => d.severity === 'error' && d.title.includes('Vendor ID 565 Denied')));
  console.log('✓ Visitor Consent State Engine detects pending queues, implied opt-in, and IAB TCF Vendor 565 conflicts');
}

// 5. Test IAB TCF 2.0 Decoder & Snippet Generator
{
  const tcf = decodeTcfStringSummary('COtybn4PA_zT4KjACBENAPCIAEBAAECAAIAAAAAAAAAA');
  assert.equal(tcf.valid, true);
  assert.equal(tcf.version, 2);

  const snippet = generateSetConsentSnippet({
    standard: 'Adobe',
    version: '2.0',
    collectVal: 'y'
  });
  assert.ok(snippet.code.includes('alloy("setConsent"'));
  console.log('✓ IAB TCF 2.0 bitfield decoder and setConsent code generator passed');
}

// 6. Test further.ai Live AEP + OneTrust C0002 + Adobe Launch (dcp.further.ai) configuration
{
  const furtherCookies = analyzeCookies(
    'kndctr_3B3D659E533B28590A490D4D_AdobeOrg_consent=general=in; kndctr_3B3D659E533B28590A490D4D_AdobeOrg_identity=CiY0123456789==; kndctr_3B3D659E533B28590A490D4D_AdobeOrg_cluster=irl1; OptanonConsent=isGpcEnabled=0&groups=C0001:1,C0002:1,C0003:1,C0004:1'
  );
  assert.equal(furtherCookies.aepConsentCookies[0].orgId, '3B3D659E533B28590A490D4D@AdobeOrg');
  assert.equal(furtherCookies.aepConsentCookies[0].generalStatus, 'in');
  assert.equal(furtherCookies.aepConsentCheckCookies[0].helperType, 'cluster');
  assert.equal(furtherCookies.aepConsentCheckCookies[0].value, 'irl1');

  const furtherSetConsentPayload = {
    consent: [
      {
        standard: 'Adobe',
        version: '1.0',
        value: {
          general: 'in'
        }
      }
    ]
  };
  const xdmRes = analyzeXdmConsents(furtherSetConsentPayload);
  assert.equal(xdmRes.overallCollectionStatus, 'opted-in');
  assert.ok(xdmRes.findings.some((f) => f.title.includes('Adobe Consent Standard 1.0 Detected')));

  const evalRes = evaluateVisitorConsentState({
    cookieAnalysis: furtherCookies,
    sdkInfo: {
      alloyDetected: true,
      orgId: '3B3D659E533B28590A490D4D@AdobeOrg',
      datastreamId: '95424b78-8ba9-40b5-af27-15357996da6e',
      edgeDomain: 'dcp.further.ai',
      defaultConsent: 'pending',
      launchInfo: {
        propertyName: 'further.ai',
        aepConsentDataElement: 'in',
        onetrustActiveGroupsDataElement: ',C0001,C0002,C0003,C0004,',
        ecidDataElement: ''
      }
    },
    edgeEvents: [
      {
        type: 'set-consent',
        command: 'setConsent',
        payload: furtherSetConsentPayload,
        consentAnalysis: xdmRes
      }
    ]
  });
  assert.equal(evalRes.effectiveState, 'opted-in');
  assert.equal(evalRes.orgId, '3B3D659E533B28590A490D4D@AdobeOrg');
  assert.equal(evalRes.datastreamId, '95424b78-8ba9-40b5-af27-15357996da6e');
  assert.ok(evalRes.diagnostics.some((d) => d.title.includes('OneTrust C0002 -> AEP Consent Mapping')));
  assert.ok(evalRes.diagnostics.some((d) => d.title.includes('First-Pageview ECID Data Element Race Condition')));
  console.log('✓ Further.ai live configuration (dcp.further.ai, OneTrust C0002 -> AEP Consent, Adobe 1.0 setConsent) verified');
}

// 7. Test URL-encoded cookie unescaping (general%3Dout -> general=out) and Launch %...% Data Element resolution
{
  const redhatCookies = analyzeCookies([
    { name: 'kndctr_945D02BE532957400A490D4C_AdobeOrg_consent', value: 'general%3Dout' },
    { name: 'kndctr_945D02BE532957400A490D4C_AdobeOrg_identity', value: 'CiY9876543210==' }
  ]);

  assert.equal(redhatCookies.aepConsentCookies[0].value, 'general=out');
  assert.equal(redhatCookies.aepConsentCookies[0].generalStatus, 'out');

  const evalRes = evaluateVisitorConsentState({
    cookieAnalysis: redhatCookies,
    sdkInfo: {
      alloyDetected: true,
      orgId: '945D02BE532957400A490D4C@AdobeOrg',
      datastreamId: '%Adobe Prod | EdgeConfigId | [Global-X]%',
      defaultConsent: '%Consent Management | AEP Permissions | [Global-X]%',
      launchConfigBindings: {
        datastreamId: {
          raw: '%Adobe Prod | EdgeConfigId | [Global-X]%',
          resolved: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          isDataElement: true,
          tokens: [{ token: '%Adobe Prod | EdgeConfigId | [Global-X]%', name: 'Adobe Prod | EdgeConfigId | [Global-X]', value: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }]
        },
        defaultConsent: {
          raw: '%Consent Management | AEP Permissions | [Global-X]%',
          resolved: 'out',
          isDataElement: true,
          tokens: [{ token: '%Consent Management | AEP Permissions | [Global-X]%', name: 'Consent Management | AEP Permissions | [Global-X]', value: 'out' }]
        }
      },
      resolvedDataElements: {
        'Adobe Prod | EdgeConfigId | [Global-X]': 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        'Consent Management | AEP Permissions | [Global-X]': 'out'
      }
    },
    edgeEvents: []
  });

  // Cookie value should be unescaped to general=out
  assert.equal(evalRes.consentCookieValue, 'general=out');
  // Data Elements should preserve both raw %...% token and resolved _satellite.getVar(...) value
  assert.equal(evalRes.fields.datastreamId.isDataElement, true);
  assert.equal(evalRes.fields.datastreamId.raw, '%Adobe Prod | EdgeConfigId | [Global-X]%');
  assert.equal(evalRes.fields.datastreamId.resolved, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  assert.equal(evalRes.fields.defaultConsent.isDataElement, true);
  assert.equal(evalRes.fields.defaultConsent.raw, '%Consent Management | AEP Permissions | [Global-X]%');
  assert.equal(evalRes.fields.defaultConsent.resolved, 'out');
  assert.equal(evalRes.defaultConsent, 'out');
  console.log('✓ URL-encoded kndctr_*_consent cookie unescaping (general%3Dout -> general=out) and Launch %...% Data Element resolution verified');
}

console.log('\nAll AEP Consent Analyzer tests passed successfully!');

