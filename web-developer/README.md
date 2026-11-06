# Web Developer — feature dashboard

An isolated developer tool implementing the requested items from the
[Web Developer to-do list](https://chrispederick.com/work/web-developer/to-do/):
**63 requested items + 13 base features = 76 features** in one registry
([`FEATURES.md`](FEATURES.md)).

> This directory is deliberately separate from the Celia Kids clinic site. It does not
> modify `index.html`, `app.js`, `Code.gs`, the Apps Script bundle, or the Pages
> allow-list. Nothing here is published by `.github/workflows/pages.yml`.

## Run it

**Standalone (live preview):**

```bash
python3 scripts/preview.py       # from the repository root
# open /web-developer/ — the dashboard inspects demo.html in the frame above
```

Every feature acts on `demo.html`, which contains ARIA attributes, a custom element,
an image map, a form with validation and clipboard blockers, nofollow links, CSS3
styles, gradients and deliberate accessibility issues. Toggle a feature on, hover the
frame, toggle it off: the engine restores the original DOM.

**Chrome extension (MV3):**

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**.
2. Select this `web-developer/` directory.
3. Click the toolbar action to open the dashboard; `options.html` is the full options page.
   The popup now drives the active tab through `extension/content.js`.
4. `Alt+Shift+W` opens the dashboard (the built-in command); custom per-feature shortcuts
   are configured in the Shortcuts tab and work both in the popup and on the page.

Permissions are for the job at hand: `activeTab`/`scripting` (injection), `storage`
(options + sync), `cookies` (SameSite metadata), `contentSettings` (JavaScript status),
`downloads` (CSV/JSON export), `tabs` (active-tab URL). No analytics, no remote
validator by default, no data leaves the browser.

## What is in the box

| Area | Where | Highlights |
| --- | --- | --- |
| Feature registry | `engine/features.js` | 76 definitions with upstream anchors, `toggle`/`action`/`ui` modes |
| Session runtime | `engine/core.js` | Injected styles, overlays, hover inspectors, badges, MutationObserver markers, cleanup/restore, pure report helpers |
| Dashboard | `index.html`, `dashboard.js`, `dashboard.css` | Search, menus, pins, dark mode, output panel, options, templates, shortcuts, custom tools, CSV/JSON export |
| Demo target | `demo.html`, `demo.css`, `demo-image.svg` | A page with something for every feature to inspect |
| Extension | `manifest.json`, `extension/content.js`, `extension/service-worker.js`, `options.html` | Real-tab bridge, status badge, cookie metadata, downloads |
| Catalog | `FEATURES.md`, `scripts/build-catalog.js` | Generated from the registry; `--check` fails on drift |
| Tests | `../../scripts/test-web-developer.js` | 580 checks: helpers, registry, jsdom session, dashboard rendering |

### Implemented groups

- **33 new Common features** — Auto Reload, Check Spelling, Clean Submit, Disable CSS3
  Styles, Disable HTML5 Form Validation, Disable Individual Stylesheet, ARIA attribute
  badges, ARIA states/properties, baseline grid, canonical URL, event information,
  margin/padding bands, page magnifier, screen-size overlay, style information, Edit HTML,
  Enable Paste, Flip Images, Make Content Editable, Make Element Resizable, five outline
  modes, Remove Inline Styles, Replace Images With Title Attributes, local accessibility
  validation, tidied-HTML validation, colour contrast, computed style, font information,
  formatting.
- **11 requested enhancements** — colour and position in Display Element Information,
  saved line guides, CSS colour picker + MIME warnings, image dimension badges,
  configurable form values and validators, cookie CSV export, image grid, link text/title/
  target and the internal/external split.
- **19 platform / Chrome items** — close warning, CSS beautifier, shortcuts, dark mode,
  gradients, options import/export, pinning, repositioning, colour sorting, option sync,
  text wrapping, templates, menu customization, split id/class details, `%s`/`%d` tool
  URLs, JavaScript and quirks-mode status icons, SameSite cookies.
- **13 base features** rebuilt so those enhancements are real: element information,
  line guides, Edit CSS, adjusted-dimension image outlines, form population, HTML/CSS
  validators, cookie/image/link/colour information, id details, class details.

## Design notes

- **One engine, two hosts.** `createSession(win, doc, config)` takes the window and
  document to inspect. Standalone mode passes the iframe; the extension passes the real
  page. All reports, persistence and downloads are callbacks supplied by the host.
- **Everything reversible.** Each toggle registers cleanups; badges/marks are tagged
  `data-wd-ui` and ignored by every selector. `destroy()` leaves no injected UI.
- **Local by default.** Spelling, accessibility, contrast, tidy/validate, colour and font
  reports run in-page. A remote validator is contacted only when you set
  `validatorHtmlUrl` / `validatorCssUrl`.
- **Syncing.** `chrome.storage.sync` in extension mode; `localStorage` +
  `BroadcastChannel` between standalone tabs. Options, pins, templates, shortcuts,
  tools, active toggles and saved line-guide/overlay positions are one JSON document.
- **Known boundaries.** `document.cookie` cannot see HttpOnly/SameSite flags (the
  extension's cookies API can); cross-origin `<iframe>`s are not inspectable from the
  standalone page; the magnifier uses a static DOM snapshot (scripts stripped) rather
  than a live render; remote validators and stylesheet MIME probes require network
  access and are skipped when `fetch` is unavailable.

## Verify

```bash
npm ci --no-audit --no-fund
node scripts/test-web-developer.js                         # 580 checks
node web-developer/scripts/build-catalog.js --check       # catalog drift
npm test                                                  # full local suite
```
