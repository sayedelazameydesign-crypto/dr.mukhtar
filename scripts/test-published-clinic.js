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
  console.log('SKIPPED: jsdom is not installed. Run `npm i --no-save --prefix /tmp jsdom` to enable this test.');
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

  // 3 — missing and broken files are silent, not catastrophic.
  for (const mode of ['MISSING', 'BROKEN']) {
    const window = await boot(mode);
    check(`${mode.toLowerCase()} file: the page still renders`, /طلب موعد/.test(window.document.body.textContent));
    check(`${mode.toLowerCase()} file: no invented phone`, window.document.querySelector('[data-config="phone"] a') === null);
    check(`${mode.toLowerCase()} file: the booking form still works`,
      window.document.querySelectorAll('#dayChips .day-chip').length === 5);
  }

  console.log(`Published-clinic suite passed: ${passed} checks (filled, empty, missing and broken clinic.json).`);
  // Exit explicitly: a jsdom window keeps timers alive, and without this the process hangs
  // after printing success — which is exactly what made CI cancel the job.
  windows.forEach((window) => window.close());
  process.exit(0);
})().catch((error) => {
  console.error(`Published-clinic suite FAILED: ${error.message}`);
  windows.forEach((window) => window.close());
  process.exit(1);
});
