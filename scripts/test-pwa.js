'use strict';

/**
 * Install contract: the page can be added to a phone's home screen and behaves.
 *
 * Why a gate: "it is a PWA" is a claim, and every part of it can silently rot — an icon
 * that is a 1x1 PNG, a manifest entry pointing at a file nobody ships, a service worker
 * that caches the clinic's phone number and then serves yesterday's number to a guardian.
 * Each assertion below fails on a specific, observable defect.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const failures = [];
let passed = 0;

function check(label, ok) {
  if (ok) { passed += 1; return; }
  failures.push(label);
  console.error(`  ✗ ${label}`);
}

function pngSize(file) {
  const buffer = fs.readFileSync(path.join(ROOT, file));
  const signature = buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (!signature) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/* ---------------------------------------------------------------- manifest ---- */
const manifest = JSON.parse(read('manifest.webmanifest'));
check('manifest is standalone with a start_url and an id',
  manifest.display === 'standalone' && !!manifest.start_url && !!manifest.id);

const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
[192, 512].forEach((size) => {
  const icon = icons.find((item) =>
    item.type === 'image/png' && item.sizes === `${size}x${size}` && /(^|\s)any(\s|$)/.test(item.purpose || 'any'));
  check(`manifest declares a ${size}px PNG icon`, !!icon);
  if (!icon) return;
  const file = icon.src.replace(/^\.\//, '');
  const exists = fs.existsSync(path.join(ROOT, file));
  check(`${file} exists`, exists);
  if (!exists) return;
  const real = pngSize(file);
  check(`${file} really is ${size}x${size} (not a renamed placeholder)`,
    !!real && real.width === size && real.height === size);
});
check('manifest declares a maskable icon', icons.some((item) => /maskable/.test(item.purpose || '')));
icons.forEach((icon) => {
  const file = String(icon.src || '').replace(/^\.\//, '');
  check(`icon ${file} is a file this repository can ship`, fs.existsSync(path.join(ROOT, file)));
});

/* ----------------------------------------------------------- service worker ---- */
const sw = read('sw.js');
const shellBlock = /const SHELL = \[([\s\S]*?)\];/.exec(sw);
check('sw.js declares a SHELL list', !!shellBlock);
const shell = shellBlock ? Array.from(shellBlock[1].matchAll(/'([^']+)'/g)).map((m) => m[1]) : [];

// The one thing that must never be cached: the clinic's live published facts.
check('SHELL does not include clinic.json', !shell.some((entry) => /clinic\.json/.test(entry)));
check('sw.js bypasses clinic.json at fetch time', /endsWith\('\/clinic\.json'\)\) return/.test(sw));
check('sw.js ignores other origins', /url\.origin !== self\.location\.origin\) return/.test(sw));
check('sw.js only handles GET', /request\.method !== 'GET'\) return/.test(sw));
check('navigations prefer the network (no stale page while online)',
  /request\.mode === 'navigate'[\s\S]{0,160}fetch\(request\)\.catch/.test(sw));

shell.filter((entry) => entry !== './').forEach((entry) => {
  const file = entry.split('?')[0].replace(/^\.\//, '');
  check(`SHELL entry exists: ${file}`, fs.existsSync(path.join(ROOT, file)));
});

/* ------------------------------------------------------------------ wiring ---- */
const html = read('index.html');
check('index.html links the manifest', /rel="manifest"/.test(html));
check('index.html has an apple-touch-icon', /rel="apple-touch-icon"/.test(html));
check('the install button is hidden until the browser offers installation',
  /data-install[^>]*hidden/.test(html));

const app = read('app.js');
check('registration is skipped inside the Apps Script deployment',
  /function setupInstall\(\) \{\s*if \(IS_GAS\) return;/.test(app));
check('registration requires https', /location\.protocol === 'https:'/.test(app));
check('a failed registration stays silent (the page must not depend on it)',
  /register\('\.\/sw\.js'\)\.catch/.test(app));

const pages = read(path.join('.github', 'workflows', 'pages.yml'));
check('sw.js is in the Pages allow-list (a worker nobody ships is a dead file)',
  /cp[^\n]*\bsw\.js\b/.test(pages));

const ci = read(path.join('.github', 'workflows', 'ci.yml'));
check('CI runs this contract', /node scripts\/test-pwa\.js/.test(ci));

/* ------------------------------------------------------------- icon source ---- */
check('the icons have a generator, so they are reproducible, not magic binaries',
  fs.existsSync(path.join(ROOT, 'scripts', 'build-icons.py')));

if (failures.length) {
  console.error(`PWA install contract FAILED (${failures.length}).`);
  process.exit(1);
}
console.log(`PWA install contract passed: ${passed} checks (manifest icons, service-worker scope, wiring).`);
