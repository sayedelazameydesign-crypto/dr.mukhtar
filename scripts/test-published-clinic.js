#!/usr/bin/env node
'use strict';

/**
 * Stage A of going live means the published site carries the clinic's real phone and name
 * without an Apps Script deployment behind it. That is exactly the place where a page
 * starts inventing things, so every case below is about what must NOT happen:
 *
 *   - an empty clinic.json changes nothing (no invented number, no invented name);
 *   - a missing or broken file changes nothing;
 *   - a phone in the file never turns the demo into "live";
 *   - hours and visit types are never taken from the file (a static file must not be able
 *     to invent a bookable slot).
 *
 * Requires jsdom: npm i --no-save --prefix /tmp jsdom && NODE_PATH=/tmp/node_modules node …
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  // A skipped browser test used to exit 0, so CI looked green while the UI was not
  // exercised at all. Fail by default; a deliberate skip must be asked for explicitly.
  if (!process.env.CELIA_ALLOW_SKIP_UI) {
    console.error('SKIPPED-WITH-FAILURE: jsdom is not installed, so this test did not run.');
    console.error('Install it with `npm ci` at the repository root, or set CELIA_ALLOW_SKIP_UI=1 to accept the gap explicitly.');
    process.exit(1);
  }
  console.log('SKIPPED (explicit): jsdom is not installed and CELIA_ALLOW_SKIP_UI=1 was set.');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

const document_ = html
  .replace('<link rel="stylesheet" href="./app.css?v=2026">', () => `<style>${css}</style>`)
  .replace('<script src="./app.js?v=2026" defer></script>', () => `<script>${js}</script>`);

const wait = (ms = 140) => new Promise((resolve) => setTimeout(resolve, ms));

/** Boot the page with a stubbed clinic.json response. */
const windows = [];
async function boot(clinicJson) {
  const dom = new JSDOM(document_, {
    url: 'https://celia.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.fetch = async (url) => {
        if (String(url).indexOf('clinic.json') === -1) return { ok: false, status: 404, text: async () => '' };
        if (clinicJson === 'BROKEN') return { ok: true, status: 200, json: async () => { throw new Error('bad json'); } };
        if (clinicJson === 'MISSING') return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => clinicJson };
      };
    }
  });
  await wait(320);
  windows.push(dom.window);
  return dom.window;
}

const text = (window, selector) => {
  const node = window.document.querySelector(selector);
  return node ? node.textContent.trim() : '';
};

let passed = 0;
const check = (label, condition, detail = '') => {
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
};

(async () => {
  // 1 — a filled file publishes contact facts, and nothing else changes.
  {
    const window = await boot({
      clinicName: 'عيادة النور للأطفال',
      phone: '0100 123 4567',
      address: 'الجيزة، شارع الهرم',
      note: 'الطلب يُراجع قبل التأكيد.'
    });
    check('the published clinic name reaches the page', /عيادة النور/.test(text(window, '[data-config="clinicName"]')),
      text(window, '[data-config="clinicName"]'));
    const phoneNode = window.document.querySelector('[data-config="phone"] a');
    check('the published phone becomes a tap-to-call link',
      phoneNode !== null && /^tel:\+?[0-9]{6,}$/.test(phoneNode.getAttribute('href')),
      phoneNode && phoneNode.getAttribute('href'));
    check('the dialable number keeps no spaces', phoneNode !== null && !/[\s-]/.test(phoneNode.getAttribute('href')));
    const wa = window.document.querySelector('a[href^="https://wa.me/"]');
    check('a published number enables the WhatsApp button', wa !== null, 'no wa.me link');
    check('the WhatsApp opener carries no personal or medical detail',
      wa !== null && !/اسم|عمر|سنة|أعراض|ألم/.test(decodeURIComponent(wa.getAttribute('href').split('text=')[1] || '')));
    check('the published address is shown', /الجيزة/.test(text(window, '[data-config="address"]')));
    // A static file must not be able to pretend the deployment is live.
    check('a published number does not claim live mode', /تجريبي/.test(text(window, '#modeLabel')), text(window, '#modeLabel'));
    check('the demo banner stays visible', !window.document.querySelector('#environmentBanner').hidden);
    // Hours and services keep coming from settings, not from the file.
    const hoursBefore = text(window, '[data-config="hours"]');
    const window2 = await boot({ clinicName: 'عيادة النور', phone: '01001234567', hours: 'كل يوم ٢٤ ساعة', services: [{ label: 'مجاني', minutes: 5 }] });
    check('a file cannot override the clinic hours', text(window2, '[data-config="hours"]') === hoursBefore,
      `${text(window2, '[data-config="hours"]')} vs ${hoursBefore}`);
    const cards = [...window2.document.querySelectorAll('.choice-card')].map((card) => card.textContent);
    check('a file cannot add or price a visit type', cards.every((card) => !/مجاني/.test(card)), cards.join(' | '));
  }

  // 1b — the number is written the way a parent dials it (01113593643), but wa.me only
  //      accepts the international form. `https://wa.me/01113593643` opens a chat with
  //      nobody; this assertion is why the conversion exists.
  {
    const window = await boot({ clinicName: 'عيادة دكتور مختار سيد كامل', phone: '01113593643' });
    const tel = window.document.querySelector('[data-config="phone"] a');
    check('the tel: link keeps the dialled local number',
      tel !== null && tel.getAttribute('href') === 'tel:01113593643', tel && tel.getAttribute('href'));
    const wa = window.document.querySelector('a[href^="https://wa.me/"]');
    const waNumber = wa ? decodeURIComponent(wa.getAttribute('href')).replace(/^https:\/\/wa\.me\//, '').split('?')[0] : '';
    check('wa.me receives the international number, never the leading 0',
      waNumber === '201113593643', waNumber);
    check('the WhatsApp link is a real chat target, not a dead one',
      /^20[0-9]{10}$/.test(waNumber), waNumber);
  }

  // 1c — the builder's support number is published next to the clinic's, and the two must
  //      never blur: a parent who taps the wrong one reaches someone who cannot help.
  {
    const window = await boot({
      clinicName: 'عيادة دكتور مختار سيد كامل',
      phone: '01113593643',
      doctorName: 'د. مختار سيد كامل',
      developer: 'سيد العزامي',
      developerPhone: '01126212452'
    });
    const doc = window.document;
    const clinicTel = doc.querySelector('[data-config="phone"] a');
    check('the clinic keeps its own number when a developer number exists',
      clinicTel !== null && clinicTel.getAttribute('href') === 'tel:01113593643',
      clinicTel && clinicTel.getAttribute('href'));
    const wa = doc.querySelector('a[href^="https://wa.me/"]');
    check('WhatsApp still points at the clinic, not at the developer',
      wa !== null && /wa\.me\/201113593643\?/.test(wa.getAttribute('href')), wa && wa.getAttribute('href'));
    const credit = doc.querySelector('[data-developer]');
    check('the credit block is visible', credit !== null && credit.hidden === false);
    const devTel = credit ? credit.querySelector('a[href^="tel:"]') : null;
    check('the support number is tappable and carries its own digits',
      devTel !== null && devTel.getAttribute('href') === 'tel:01126212452', devTel && devTel.getAttribute('href'));
    check('the credit names the builder', /سيد العزامي/.test(text(window, '[data-config="developer"]')));
    check('the credit says out loud that it is not the clinic',
      /ليس رقم العيادة|الدعم التقني/.test(credit ? credit.textContent : ''));
    // A support number alone must not fill the clinic's phone.
    const window2 = await boot({ clinicName: 'عيادة النور', developer: 'سيد العزامي', developerPhone: '01126212452' });
    check('a support number never becomes the clinic number',
      window2.document.querySelector('[data-config="phone"] a') === null);
    check('a support number never becomes the clinic WhatsApp target',
      window2.document.querySelector('a[href^="https://wa.me/"]') === null);
  }

  // 2 — an empty file must leave the page exactly as it was.
  {
    const window = await boot({ clinicName: '', phone: '', whatsapp: '', address: '' });
    check('an empty file invents no phone', window.document.querySelector('[data-config="phone"] a') === null);
    check('an empty file invents no WhatsApp link', window.document.querySelector('a[href^="https://wa.me/"]') === null);
    check('an empty file keeps the neutral clinic name', /Celia Kids/.test(text(window, '[data-config="clinicName"]')),
      text(window, '[data-config="clinicName"]'));
    check('an empty file leaves the address placeholder', /يُضاف|غير/.test(text(window, '[data-config="address"]')),
      text(window, '[data-config="address"]'));
  }

  // 2b — the doctor and the licence travel in the same file (stage A has no dashboard
  //      behind it, so a fact that is not here is not on the page at all).
  {
    const window = await boot({
      clinicName: 'عيادة النور للأطفال',
      phone: '01001234567',
      doctorName: 'د. سارة محمود',
      license: 'EG-12345'
    });
    check('the published doctor name reaches the page', /سارة محمود/.test(text(window, '[data-config="doctorName"]')),
      text(window, '[data-config="doctorName"]'));
    check('the published licence number reaches the page', /EG-12345/.test(text(window, '[data-config="license"]')),
      text(window, '[data-config="license"]'));
    check('a published licence counts as announced, not as unverified notice',
      /تسجيل|سجّلته|مسجل|رسمي/.test(text(window, '.doctor-card')) && !/لم تُسجَّل بعد/.test(text(window, '.doctor-card')),
      text(window, '.doctor-card').slice(0, 120));
  }

  // 2c — demoMode decides the badge, from the data, not from a build-time flag.
  {
    const demo = await boot({ demoMode: true, clinicName: 'عيادة النور' });
    check('demoMode true keeps the demo badge', !demo.document.querySelector('#environmentBanner').hidden);
    const live = await boot({ demoMode: false, clinicName: 'عيادة النور', phone: '01001234567', doctorName: 'د. سارة', license: 'EG-1' });
    check('demoMode false hides the demo badge', live.document.querySelector('#environmentBanner').hidden);
  }

  // 3 — missing and broken files are silent, not catastrophic.
  for (const mode of ['MISSING', 'BROKEN']) {
    const window = await boot(mode);
    check(`${mode.toLowerCase()} file: the page still renders`, /طلب موعد/.test(window.document.body.textContent));
    check(`${mode.toLowerCase()} file: no invented phone`, window.document.querySelector('[data-config="phone"] a') === null);
    check(`${mode.toLowerCase()} file: the booking form still works`,
      window.document.querySelectorAll('#dayChips .day-chip').length === 5);
  }

  console.log(`Published-clinic suite passed: ${passed} checks (filled, doctor+licence, demo badge, empty, missing, broken).`);
  // Exit explicitly: a jsdom window keeps timers alive, and without this the process hangs
  // after printing success — which is exactly what made CI cancel the job.
  windows.forEach((window) => window.close());
  process.exit(0);
})().catch((error) => {
  console.error(`Published-clinic suite FAILED: ${error.message}`);
  windows.forEach((window) => window.close());
  process.exit(1);
});
