#!/usr/bin/env node
/**
 * Web Developer tool test suite (offline, no network, no secrets).
 *
 *   node scripts/test-web-developer.js
 *
 * Proves three things: (1) the pure helpers behave, (2) the registry really contains
 * every requested to-do item, (3) every toggle/action works against a jsdom document
 * and restores it when disabled. jsdom is a hard requirement: a suite that silently
 * skips the DOM half is not a suite.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const W = require(path.join(ROOT, 'web-developer', 'engine', 'features.js'));

let passed = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) { passed += 1; return true; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  return false;
}
function equal(label, actual, expected) {
  return check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function includes(label, haystack, needle) {
  return check(label, String(haystack).includes(needle), `missing ${JSON.stringify(needle)}`);
}

/* ------------------------------------------------------------ 1. helpers */
equal('contrast: black on white is 21:1', W.contrastRatio('#000000', '#ffffff'), 21);
equal('contrast: white on white is 1:1', W.contrastRatio('#fff', '#fff'), 1);
check('contrast: mid-grey is between 1 and 21', W.contrastRatio('#777', '#fff') > 3 && W.contrastRatio('#777', '#fff') < 6);
check('contrast: alpha foreground is composited', W.contrastRatio('rgba(0,0,0,0.5)', '#ffffff') > 1);
check('contrast: unparseable colour returns null', W.contrastRatio('not-a-colour', '#fff') === null);

const hues = W.sortColors([
  { value: '#0000ff' }, { value: '#cccccc' }, { value: '#ff0000' }, { value: '#00ff00' }
], 'color');
equal('sort by color: greys first', hues[0].value, '#cccccc');
equal('sort by color: red before green/blue', hues[1].value, '#ff0000');
equal('sort alphabetically: blue first', W.sortColors([{ value: '#ff0000' }, { value: '#0000ff' }], 'alphabetical')[0].value, '#0000ff');

const gradients = W.extractGradients('a{background:linear-gradient(90deg, rgb(124,58,237), #ec4899 60%, rgba(245,158,11,.5));}' +
  'b{background:repeating-radial-gradient(circle, red, blue)}');
equal('gradients: two declarations found', gradients.length, 2);
includes('gradients: nested rgb() parenthesis survives', gradients[0].value, 'rgba(245,158,11,.5)');
equal('gradients: first type', gradients[0].type, 'linear-gradient');
includes('gradients: repeating type', gradients[1].type, 'repeating-radial-gradient');
equal('gradients: colour stops collected', gradients[0].colors.length, 3);

const pretty = W.beautifyCss('a{color:red;b{margin:0}}');
equal('beautify: braces balanced', (pretty.match(/{/g) || []).length, (pretty.match(/}/g) || []).length);
includes('beautify: declaration kept valid', pretty, 'margin:0;');
includes('beautify: indented nested rule', pretty, '  b {');

equal('tool URL: %s expands to encoded page URL',
  W.expandToolUrl('https://v.example/?doc=%s', 'https://site.example/p?q=1', 'site.example'),
  'https://v.example/?doc=https%3A%2F%2Fsite.example%2Fp%3Fq%3D1');
equal('tool URL: %d expands to domain', W.expandToolUrl('https://w.example/%d', 'https://site.example/p', 'site.example'),
  'https://w.example/site.example');
includes('tool URL: raw %S stays unescaped', W.expandToolUrl('%S', 'https://a.example/x', 'a.example'), 'https://a.example/x');

const csv = W.cookiesToCsv([{ name: 'a"b', value: 'x,y', sameSite: 'Strict', secure: true, httpOnly: false }]);
includes('cookie CSV: header has sameSite', csv.split('\r\n')[0], 'sameSite');
includes('cookie CSV: quote escaping', csv, '"a""b"');
includes('cookie CSV: comma quoted', csv, '"x,y"');
includes('cookie CSV: booleans', csv, '"true"');
includes('cookie CSV: SameSite value', csv, '"Strict"');

const split = W.splitLinks([
  { href: '#section' }, { href: '/local' }, { href: 'https://site.example/page' },
  { href: 'https://other.example/x' }, { href: 'mailto:a@example.com' }
], 'https://site.example/home');
equal('links: internal count', split.internal.length, 4);
equal('links: external count', split.external.length, 1);
includes('tidy HTML: indents children', W.tidyHtml('<div><p>hi</p><p>there</p></div>'), '  <p>hi</p>');
check('status: quirks mode detected', W.statusOf({ location: { href: 'https://a.example/' }, innerWidth: 800, innerHeight: 600 }, { compatMode: 'BackCompat', title: 'x' }).quirks === true);

/* ------------------------------------------------------------ 2. registry */
const REQUESTED = [
  'auto-reload', 'check-spelling', 'clean-submit', 'disable-css3-styles', 'disable-html5-form-validation',
  'disable-individual-stylesheet', 'display-aria-attributes', 'display-aria-states-properties',
  'display-baseline-grid', 'display-canonical-url', 'display-event-information', 'display-margin-padding',
  'display-page-magnifier', 'display-screen-size-overlay', 'display-style-information', 'edit-html',
  'enable-paste', 'flip-images', 'make-content-editable', 'make-element-resizable', 'outline-all-links',
  'outline-custom-elements', 'outline-image-maps', 'outline-no-follow-links', 'outline-no-index-elements',
  'remove-inline-styles', 'replace-images-with-title-attributes', 'validate-local-accessibility',
  'validate-tidied-html', 'view-color-contrast-information', 'view-computed-style', 'view-font-information',
  'view-formatting', 'display-element-information-color', 'display-line-guides-save', 'edit-css-color-picker',
  'edit-css-mime-warning', 'outline-images-adjusted-dimensions', 'populate-form-fields-configurable',
  'validators-configurable', 'view-cookie-information-csv', 'view-image-information-grid',
  'view-link-information-details', 'view-link-information-split', 'dashboard-close-warning', 'beautify-css',
  'keyboard-shortcuts', 'dark-mode', 'display-element-information-position', 'view-color-information-gradients',
  'options-import-export', 'pinning-features', 'reposition-dashboard', 'sort-color-information', 'sync-options',
  'wrap-text-output', 'feature-templates', 'customizable-menus', 'split-id-class-details',
  'tool-url-placeholders', 'javascript-status-icon', 'quirks-mode-status-icon', 'same-site-cookies'
];
equal('registry: requested item count in the test', REQUESTED.length, 63);
const ids = {};
W.FEATURES.forEach((feature) => {
  check(`registry: unique id ${feature.id}`, !ids[feature.id]);
  ids[feature.id] = feature;
  check(`registry: ${feature.id} has a label/description/mode`, !!(feature.label && feature.description && feature.mode));
  check(`registry: ${feature.id} has a valid mode`, ['toggle', 'action', 'ui'].includes(feature.mode));
  if (feature.mode === 'toggle') check(`registry: ${feature.id} has an apply()`, typeof feature.apply === 'function');
  if (feature.mode === 'action') check(`registry: ${feature.id} has an execute()`, typeof feature.execute === 'function');
});
REQUESTED.forEach((id) => {
  check(`requested item ${id} is implemented`, !!ids[id]);
  if (ids[id]) check(`requested item ${id} keeps its upstream anchor`, /^https:\/\/chrispederick\.com\/work\/web-developer\/to-do\/#to-do-[0-9a-f]+$/.test(ids[id].url), ids[id].url);
});
['javascript-status-icon', 'quirks-mode-status-icon', 'same-site-cookies'].forEach((id) => {
  equal(`${id} is tagged Chrome`, ids[id] && ids[id].category, 'Chrome');
});
equal('registry: total feature count', W.FEATURES.length, 76);
check('catalog matches the registry', (() => {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'web-developer', 'scripts', 'build-catalog.js'), '--check'], { stdio: 'pipe' });
    return true;
  } catch (error) { return false; }
})());

/* ------------------------------------------------------------ 3. DOM/runtime */
let JSDOM;
try { JSDOM = require('jsdom').JSDOM; }
catch (error) {
  console.error('✗ jsdom is required: run npm ci first (see package.json)');
  process.exit(1);
}

const demoHtml = fs.readFileSync(path.join(ROOT, 'web-developer', 'demo.html'), 'utf8');
const dom = new JSDOM(demoHtml, {
  url: 'https://site.example/web-developer/demo.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const win = dom.window;
const doc = win.document;
win.document.cookie = 'wd_test=one; path=/';
win.document.cookie = 'wd_second=two; path=/';

const reports = [];
const downloads = [];
const persisted = {};
const session = W.createSession(win, doc, {
  options: Object.assign({}, W.DEFAULT_OPTIONS, { autoReloadSeconds: 3600, warnOnClose: true }),
  saved: {},
  report: (report) => reports.push(report),
  persist: (key, value) => { persisted[key] = value; },
  download: (file) => downloads.push(file)
});
const lastReport = () => reports[reports.length - 1] || { title: '', html: '', text: '' };
const reportHtml = () => String(lastReport().html || '') + String(lastReport().text || '');

function toggleOn(id) { check(`enable ${id}`, session.enable(id) === true); }
function toggleOff(id) { check(`disable ${id}`, session.disable(id) === true); }

/* Outlines and CSS toggles */
toggleOn('outline-all-links');
includes('outline-all-links injects CSS', doc.getElementById('wd-style-outline-all-links').textContent, 'a[href]');
toggleOff('outline-all-links');
check('outline-all-links removes CSS', !doc.getElementById('wd-style-outline-all-links'));

toggleOn('disable-html5-form-validation');
check('form has novalidate', doc.querySelector('form').hasAttribute('novalidate'));
toggleOff('disable-html5-form-validation');
check('novalidate restored (absent)', !doc.querySelector('form').hasAttribute('novalidate'));

toggleOn('disable-css3-styles');
includes('CSS3 override includes shadows', doc.getElementById('wd-style-disable-css3-styles').textContent, 'box-shadow:none');
toggleOff('disable-css3-styles');

toggleOn('flip-images');
includes('flip-images defaults to horizontal', doc.getElementById('wd-style-flip-images').textContent, 'scaleX(-1)');
toggleOff('flip-images');
session.setOptions({ flipDirection: 'vertical' });
toggleOn('flip-images');
includes('flip-images honours options', doc.getElementById('wd-style-flip-images').textContent, 'scaleY(-1)');
toggleOff('flip-images');

const styled = doc.getElementById('hero');
const originalStyle = styled.getAttribute('style');
toggleOn('remove-inline-styles');
check('inline style removed', !styled.hasAttribute('style'));
toggleOff('remove-inline-styles');
equal('inline style restored', styled.getAttribute('style'), originalStyle);

/* DOM mutations */
toggleOn('clean-submit');
check('clean-submit stripped onsubmit', !doc.querySelector('form').hasAttribute('onsubmit'));
toggleOff('clean-submit');
check('clean-submit restored onsubmit', doc.querySelector('form').hasAttribute('onsubmit'));

toggleOn('enable-paste');
check('enable-paste stripped onpaste', !doc.getElementById('fullname').hasAttribute('onpaste'));
toggleOff('enable-paste');
check('enable-paste restored onpaste', doc.getElementById('fullname').hasAttribute('onpaste'));

toggleOn('check-spelling');
check('check-spelling highlights a typo', doc.querySelectorAll('.wd-typo').length > 0);
equal('check-spelling enables spellcheck', doc.getElementById('fullname').getAttribute('spellcheck'), 'true');
toggleOff('check-spelling');
check('check-spelling restores text', doc.querySelectorAll('.wd-typo').length === 0);

const imageCountBefore = doc.querySelectorAll('img').length;
toggleOn('replace-images-with-title-attributes');
check('images replaced by title text', doc.querySelectorAll('[data-wd-replaced-image]').length > 0);
toggleOff('replace-images-with-title-attributes');
equal('images restored', doc.querySelectorAll('img').length, imageCountBefore);

toggleOn('make-content-editable');
equal('body is editable', doc.body.getAttribute('contenteditable'), 'true');
toggleOff('make-content-editable');
check('body editability restored', !doc.body.hasAttribute('contenteditable'));

/* Badges, marks, overlays, inspectors */
['display-aria-attributes', 'display-aria-states-properties', 'display-id-details', 'display-class-details',
  'view-formatting', 'display-canonical-url', 'display-screen-size-overlay', 'display-baseline-grid',
  'outline-image-maps', 'outline-no-follow-links'].forEach((id) => {
  toggleOn(id);
  toggleOff(id);
});
toggleOn('display-aria-attributes');
check('ARIA badges rendered', doc.querySelectorAll('[data-wd-badge="display-aria-attributes"]').length > 0);
toggleOff('display-aria-attributes');
equal('ARIA badges cleaned up', doc.querySelectorAll('[data-wd-badge="display-aria-attributes"]').length, 0);

toggleOn('outline-custom-elements');
check('custom element is marked', doc.querySelector('clinic-card').hasAttribute('data-wd-custom'));
toggleOff('outline-custom-elements');
check('custom element mark removed', !doc.querySelector('clinic-card').hasAttribute('data-wd-custom'));

toggleOn('outline-no-index-elements');
check('noindex element is marked', doc.querySelector('[data-noindex]').hasAttribute('data-wd-noindex'));
toggleOff('outline-no-index-elements');

toggleOn('display-canonical-url');
includes('canonical URL shown', doc.getElementById('wd-overlay-canonical-url').innerHTML, 'example.com/web-developer/demo.html');
toggleOff('display-canonical-url');

['display-element-information', 'display-style-information', 'display-margin-padding',
  'display-event-information', 'view-computed-style'].forEach((id) => {
  toggleOn(id);
  check(`${id} creates the shared inspector`, !!doc.getElementById('wd-overlay-inspector'));
  toggleOff(id);
});

toggleOn('display-page-magnifier');
check('magnifier lens has a snapshot iframe', !!doc.querySelector('#wd-overlay-magnifier iframe'));
toggleOff('display-page-magnifier');

toggleOn('make-element-resizable');
const clickEvent = new win.MouseEvent('click', { bubbles: true, altKey: true });
doc.getElementById('hero').dispatchEvent(clickEvent);
check('Alt-click makes an element resizable', doc.getElementById('hero').getAttribute('data-wd-resizable') === 'true');
toggleOff('make-element-resizable');
check('resizable marker removed', !doc.getElementById('hero').hasAttribute('data-wd-resizable'));

toggleOn('display-line-guides');
includes('line guides report has save actions', reportHtml(), 'Save positions');
session.run('display-line-guides', { add: 'v' });
check('line guide positions persist', Array.isArray(persisted.lineGuides) && persisted.lineGuides.length === 1);
session.run('display-line-guides', { clear: true });
equal('line guides cleared', (persisted.lineGuides || []).length, 0);
toggleOff('display-line-guides');

/* Adjusted-dimension images with a stubbed natural size / rect */
const firstImage = doc.querySelector('img');
Object.defineProperty(firstImage, 'naturalWidth', { value: 160, configurable: true });
Object.defineProperty(firstImage, 'naturalHeight', { value: 160, configurable: true });
firstImage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 90, height: 90 });
toggleOn('outline-images-with-adjusted-dimensions');
check('adjusted image is outlined', firstImage.hasAttribute('data-wd-adjusted'));
includes('adjusted image badge shows dimensions', doc.body.innerHTML, '160×160 → 90×90');
toggleOff('outline-images-with-adjusted-dimensions');
check('adjusted image outline removed', !firstImage.hasAttribute('data-wd-adjusted'));

/* Actions / reports */
function action(id, payload, label, needle) {
  session.run(id, payload || {});
  includes(label, reportHtml(), needle);
}
action('view-link-information', null, 'link report separates internal/external', 'External links');
includes('link report has title and target', reportHtml(), 'Target');
action('view-image-information', { view: 'grid' }, 'image report uses a grid', 'wd-image-grid');
action('view-image-information', { view: 'list' }, 'image report has a list view', 'wd-table');
action('view-color-information', { sort: 'color' }, 'colour report sorts by color', 'Sort: color');
includes('colour report includes gradients', reportHtml(), 'Gradients');
action('view-cookie-information', null, 'cookie report has CSV export', 'Export as CSV');
includes('cookie report has SameSite column', reportHtml(), 'SameSite');
session.run('view-cookie-information', { csv: true });
equal('cookie CSV downloaded', downloads.length, 1);
includes('downloaded CSV is CSV', downloads[0].text, '"name","value"');
action('validate-local-accessibility', null, 'local a11y report', 'form label');
action('validate-tidied-html', null, 'tidied HTML report', 'tidied source');
action('validate-local-html', null, 'HTML validator is configurable', 'local checks only');
action('validate-local-css', null, 'CSS validator is configurable', 'local checks only');
action('view-color-contrast-information', null, 'contrast report', 'WCAG');
action('view-font-information', null, 'font report', 'Family');
action('populate-form-fields', null, 'form filler report', 'Filled');
equal('form filler changed the email field', doc.getElementById('email').value, W.DEFAULT_OPTIONS.formValues.email);

action('disable-individual-stylesheet', null, 'stylesheet list', 'demo.css');
session.run('disable-individual-stylesheet', { index: 0, disabled: true });
equal('individual stylesheet disabled', doc.querySelector('link[rel="stylesheet"]').getAttribute('media'), 'not all');
session.run('disable-individual-stylesheet', { index: 0, disabled: false });
check('individual stylesheet re-enabled', doc.querySelector('link[rel="stylesheet"]').getAttribute('media') !== 'not all');

action('edit-css', null, 'CSS editor has a colour picker', 'wd-color-picker');
includes('CSS editor has a beautifier', reportHtml(), 'Beautify CSS');
session.run('edit-css', { color: '#ff0000' });
includes('colour picker inserts a colour', reportHtml(), '#ff0000');
session.run('edit-css', { apply: true, css: 'body{color:rebeccapurple}' });
includes('CSS editor applies CSS', doc.head.innerHTML, 'rebeccapurple');

action('edit-html', null, 'HTML editor', 'wd-edit-html');
session.run('edit-html', { html: '<p id="after-edit">replaced body</p>' });
check('HTML editor replaces the body', !!doc.getElementById('after-edit'));

/* Every toggle must enable/disable without throwing, then leave no UI behind. */
const toggles = W.FEATURES.filter((f) => f.mode === 'toggle').map((f) => f.id);
toggles.forEach((id) => session.enable(id));
equal('all toggles enabled together', session.enabled().length, toggles.length);
toggles.forEach((id) => session.disable(id));
equal('all toggles disabled', session.enabled().length, 0);
session.destroy();
equal('destroy leaves no injected UI', doc.querySelectorAll('[data-wd-ui]').length, 0);

/* ------------------------------------------------------------ 4. dashboard */
const dashboardHtml = fs.readFileSync(path.join(ROOT, 'web-developer', 'index.html'), 'utf8');
const catalog = fs.readFileSync(path.join(ROOT, 'web-developer', 'FEATURES.md'), 'utf8');
includes('catalog links every requested feature', catalog, 'https://chrispederick.com/work/web-developer/to-do/#to-do-1268fd0b55');
check('catalog is complete', (catalog.match(/chrispederick\.com\/work\/web-developer\/to-do/g) || []).length >= 63);

(async function dashboardAndVerdict() {
  const dashboard = new JSDOM(dashboardHtml, {
    url: 'https://site.example/web-developer/index.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const source = ['engine/core.js', 'engine/features.js', 'dashboard.js']
    .map((file) => fs.readFileSync(path.join(ROOT, 'web-developer', file), 'utf8')).join('\n');
  // Scripts are evaluated explicitly: jsdom's file loader is intentionally not given
  // network access, but the browser path is the same classic-script sequence.
  dashboard.window.eval(source);
  // readStorage() resolves in a microtask before renderAll() runs.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const dashDoc = dashboard.window.document;
  const cardCount = dashDoc.querySelectorAll('#wd-features .wd-card').length;
  check('dashboard renders feature cards', cardCount > 0, `cards=${cardCount}`);
  equal('dashboard renders all cards by default', cardCount, W.FEATURES.length);
  check('dashboard renders the menu', dashDoc.querySelectorAll('#wd-menu button').length >= 6);
  check('dashboard renders options fields', dashDoc.querySelectorAll('#wd-options-form [data-option]').length >= 20);
  check('dashboard renders tool placeholders', dashDoc.querySelectorAll('#wd-tool-list [data-tool]').length >= 3);
  const search = dashDoc.getElementById('wd-search');
  search.value = 'cookie';
  search.dispatchEvent(new dashboard.window.Event('input', { bubbles: true }));
  const filtered = dashDoc.querySelectorAll('#wd-features .wd-card').length;
  check('dashboard search filters cards', filtered > 0 && filtered < W.FEATURES.length, `filtered=${filtered}`);
  dashboard.window.close();

  if (failures.length) {
    failures.slice(0, 40).forEach((failure) => console.error(` ✗ ${failure}`));
    console.error(`\nWeb Developer suite FAILED (${failures.length} of ${passed + failures.length} checks).`);
    process.exit(1);
  }
  console.log(`Web Developer suite passed: ${passed} checks (helpers, registry, DOM session, dashboard).`);
})();
