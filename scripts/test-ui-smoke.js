#!/usr/bin/env node
'use strict';

/**
 * DOM smoke test for the standalone site (demo mode only).
 * Requires jsdom:  npm i --no-save jsdom   (or: npm i -g jsdom)
 * Exits 0 when the whole journey works, 1 on any regression.
 */

const fs = require('node:fs');
const path = require('node:path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (error) {
  console.log('SKIPPED: jsdom is not installed. Run `npm i --no-save jsdom` to enable the UI smoke test.');
  process.exit(0);
}

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

const failures = [];
const problems = [];
const check = (label, condition, detail = '') => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

const document_ = html
  .replace('<link rel="stylesheet" href="./app.css?v=2026">', () => `<style>${css}</style>`)
  .replace('<script src="./app.js?v=2026" defer></script>', () => `<script>${js}</script>`);

const dom = new JSDOM(document_, {
  url: 'https://celia.test/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.scrollTo = () => {};
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.addEventListener('error', (event) => problems.push(`script error: ${event.message}`));
    window.addEventListener('unhandledrejection', (event) => problems.push(`rejection: ${event.reason}`));
  }
});

const { window } = dom;
const document = window.document;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const submit = (selector) => $(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  await wait(260);

  check('demo banner is visible', !$('#environmentBanner').hidden);
  check('demo mode label', $('#modeLabel').textContent.includes('تجريبي'));
  check('date defaults to a workday', /^\d{4}-\d{2}-\d{2}$/.test($('#visitDate').value));
  check('quick day chips rendered', $$('#dayChips .day-chip').length === 5);
  check('hero calendar rendered', $$('#heroCalendar .vday').length > 20);
  check('hero clock filled', $('#heroClock').textContent.trim() !== '—');
  check('slots offered', $$('#slotsGrid .slot-button').length > 0);

  // ---- booking ----
  $$('#slotsGrid .slot-button')[1].click();
  check('slot selection stored', $('#visitTime').value.length === 5);
  $('#guardianName').value = 'سارة تجريبية';
  $('#phone').value = '01000000000';
  $('#consent').checked = true;
  submit('#bookingForm');
  await wait(220);

  check('result card shown', !$('#bookingResult').hidden);
  const reference = ($('.reference-chip') || {}).textContent;
  check('reference returned', /^CK-[A-Z0-9]{6,}$/.test(reference || ''), reference);
  check('result never claims confirmation', /لم يتأكد/.test($('#bookingResult').textContent));
  check('phone never rendered in result', !$('#bookingResult').textContent.includes('01000000000'));

  // ---- tracking ----
  $('#trackReference').value = reference || '';
  submit('#trackForm');
  await wait(200);
  check('tracking finds the request', /بانتظار/.test($('#trackResult').textContent), $('#trackResult').textContent);

  // ---- staff dashboard ----
  $$('.nav-button').find((button) => button.dataset.view === 'staff').click();
  $('#staffPin').value = '2468';
  submit('#staffLoginForm');
  await wait(240);
  check('dashboard unlocked', !$('#staffDashboard').hidden);
  check('stats rendered', $$('#dashboardStats .stat-card').length === 3);
  check('pending list populated', $$('#pendingList .request-item').length >= 1);

  const approve = $('#pendingList [data-action="approve"]');
  if (approve) {
    approve.click();
    await wait(260);
    check('approval refreshes the board', $$('#weekList .request-item').length >= 1);
  } else {
    failures.push('no pending request to approve');
  }

  // ---- admin question ----
  $('#faqQuestion').value = 'كيف أغيّر الموعد؟';
  submit('#faqForm');
  await wait(200);
  check('assistant answers', $('#faqAnswer').textContent.trim().length > 10);

  // ---- back to booking, wrong pin ----
  $$('.nav-button').find((button) => button.dataset.view === 'booking').click();
  await wait(60);
  check('booking view restored', !$('#bookingView').hidden && $('#staffView').hidden);

  check('no runtime errors', problems.length === 0, problems.join(' | '));

  if (failures.length) {
    console.error(`UI smoke test FAILED (${failures.length}):`);
    failures.forEach((item) => console.error(' - ' + item));
    process.exit(1);
  }
  console.log('UI smoke test passed: rendering, booking, reference tracking, staff approval, and the admin assistant all work in demo mode.');
  process.exit(0);
})();
