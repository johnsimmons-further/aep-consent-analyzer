# Adobe Experience Platform (AEP) Consent Status Analyzer (Chrome Extension)

A **Manifest V3 Chrome Extension** for inspecting, validating, and debugging visitor consent status in **Adobe Experience Platform (AEP)** — including tailored support for **Adobe Tags (Launch)**, **OneTrust (`C0002` / `appEventData`)**, and first-party Edge Network domains (such as `https://further.ai/` / `dcp.further.ai`).

Built according to the official Adobe Experience League Consent Processing specification:
- [Consent Processing in Adobe Experience Platform (Adobe 2.0 Standard)](https://experienceleague.adobe.com/en/docs/experience-platform/landing/governance-privacy-security/consent/adobe/overview)
- [Configure a Dataset to Capture Consent and Preference Data](https://experienceleague.adobe.com/en/docs/experience-platform/landing/governance-privacy-security/consent/adobe/dataset)
- [Process Customer Consent Data Using the AEP Web SDK (`alloy`)](https://experienceleague.adobe.com/en/docs/experience-platform/landing/governance-privacy-security/consent/sdk)
- [XDM Consents and Preferences Field Group](https://experienceleague.adobe.com/en/docs/experience-platform/xdm/field-groups/profile/consents) & [Data Type](https://experienceleague.adobe.com/en/docs/experience-platform/xdm/data-types/consents)
- [IAB TCF 2.0 Support in Experience Platform (Vendor ID 565)](https://experienceleague.adobe.com/en/docs/experience-platform/landing/governance-privacy-security/consent/iab/overview)

---

## Key Capabilities

1. **Live Web SDK (`alloy`), Adobe Launch (`_satellite`), & `kndctr_*` Cookie Inspection**
   - Automatically detects and decodes first-party AEP cookies:
     - `kndctr_<orgId>_AdobeOrg_consent` (`general=in` or `general=out`, 180-day TTL)
     - `kndctr_<orgId>_AdobeOrg_identity` (Experience Cloud ID / ECID state)
     - `kndctr_<orgId>_AdobeOrg_cluster` & `kndctr_<orgId>_AdobeOrg_consent_check`
   - Extracts `window.alloy` and Adobe Tags (`_satellite._container`) configuration (`orgId`, `datastreamId`, `edgeDomain`, `defaultConsent`: `"pending"`, `"in"`, or `"out"`).
   - Monitors the Web SDK in-memory queue when `defaultConsent: "pending"`, showing which `sendEvent` hits are held awaiting consent vs. flushed or dropped once `setConsent` is called.
   - Inspects OneTrust (`OptanonConsent`, `OnetrustActiveGroups`), Event-Driven Data Layers (`window.appEventData` `Consent Loaded` / `Consent Updated`), and Launch Data Elements (`%AEP Consent%`).

2. **XDM `Consents and Preferences` Schema Validator & Edge Network Inspector**
   - Intercepts `/ee/v1/privacy/set-consent`, `/ee/v2/privacy/set-consent`, and `/ee/.../interact` requests across standard (`edge.adobedc.net`) and custom CNAME domains (`dcp.further.ai`).
   - Validates both **Adobe 1.0** (`value: { general: "in" | "out" }`) and **Adobe 2.0** XDM `Consents and Preferences` (`collect.val`, `share.val`, `personalize.content.val`, `marketing.*`, `idSpecific`, `adID`, and `metadata.time`).

3. **IAB TCF 2.0 Bitfield & Adobe Vendor ID #565 Decoder**
   - Decodes IAB TCF 2.0 `tcString` values and checks whether **Adobe Experience Platform (Vendor ID 565)** has consent.

4. **Interactive `setConsent` Simulator & Code Generator**
   - Execute `alloy("setConsent", ...)` calls directly on the active tab or generate production-ready snippets for Adobe 2.0, Adobe 1.0, and IAB TCF 2.0.

---

## Build & Load the Chrome Extension

1. Build the unpacked extension into `dist/`:
   ```bash
   npm run build
   ```
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the generated `dist/` folder:
   `/Users/johnsimmons/Desktop/code/aep-consent-analyzer/dist`
5. Visit `https://further.ai/` (or any site running Adobe Experience Platform Web SDK) and click the **AEP Consent Analyzer** extension icon in your toolbar.

