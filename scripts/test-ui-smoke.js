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
  check('staff PIN is not exposed in the public view', $('#staffView').hidden && $('#demoPinHint').closest('#staffView') !== null);
  check('demo mode label', $('#modeLabel').textContent.includes('تجريبي'));
  check('date defaults to a workday', /^\d{4}-\d{2}-\d{2}$/.test($('#visitDate').value));
  check('quick day chips rendered', $$('#dayChips .day-chip').length === 5);
  check('clinic clock filled', $('#heroClock') === null || $('#heroClock').textContent.trim() !== '—');
  check('slots offered', $$('#slotsGrid .slot-button').length > 0);

  // ---- identity: this must read as a pediatric clinic, not a chatbot ----
  const pageText = document.body.textContent;
  check('specialty stated on the page', /طب الأطفال/.test(pageText));
  check('doctor profile block present', $$('.doctor-card [data-config]').length >= 4);
  check('licence row is never invented', /ترخيص/.test(pageText), 'licence label missing');
  check('emergency routing above the fold', $('.emergency-rail') !== null && /طوارئ/.test($('.emergency-rail').textContent));
  check('no decorative avatar remains', $('.doctor-avatar') === null && $('.sun-shape') === null && $('.sparkle') === null);
  check('no dev version shown to patients', !/إصدار 2026/.test(pageText));
  check('no model provider named on the page', !/Gemini/i.test(pageText));
  check('medical disclaimer present', /لا يشخّص/.test(pageText));
  // ---- never invent a physician's credentials ----
  check('licence stays unpublished until the clinic fills it', ['غير منشور', '—', ''].includes($('[data-config="license"]').textContent.trim()), $('[data-config="license"]').textContent.trim());
  check('unverified licence is labelled as such', /لم يُتحقق/.test($('[data-license-state]').textContent) && $('.doctor-card').dataset.licenseVerified === 'false');
  check('opening hours are derived, not hardcoded', /الأحد – الخميس/.test($('[data-config="hours"]').textContent) && /٩:٠٠ ص/.test($('[data-config="hours"]').textContent), $('[data-config="hours"]').textContent);
  check('structured data carries no hardcoded schedule', !/openingHoursSpecification/.test($('script[type="application/ld+json"]').textContent));
  check('phone stays a placeholder until the clinic fills it', /إعداد العيادة/.test($('[data-config="phone"]').textContent));
  check('no fabricated syndicate/licence number', !/\d{4,}/.test($('.doctor-facts').textContent.replace(/[٠-٩]/g, '')), 'a long number appeared in the doctor card');

  const jsonLd = JSON.parse($('script[type="application/ld+json"]').textContent);
  const types = (jsonLd['@graph'] || []).map((node) => node['@type']);
  check('structured data declares clinic + physician', types.includes('MedicalClinic') && types.includes('Physician'), types.join(','));
  check('visit types come from settings, each with its own duration', $$('.choice-card').length === 2 && /٦٠ دقيقة/.test($('.choice-grid').textContent) && /٣٠ دقيقة/.test($('.choice-grid').textContent));

  // ---- progress is real, not a static badge ----
  check('progress starts on step 2 (type is pre-selected)', $('.booking-progress li[data-step="2"]').dataset.state === 'current');
  check('summary waits for a time', /لم يُحدد/.test($('[data-summary="time"]').textContent));

  // ---- booking ----
  $$('#slotsGrid .slot-button')[1].click();
  check('slot selection stored', $('#visitTime').value.length === 5);
  check('summary shows the chosen time', !/لم يُحدد/.test($('[data-summary="time"]').textContent));
  check('progress advances to guardian step', $('.booking-progress li[data-step="3"]').dataset.state === 'current');
  check('duration matches the chosen visit', /٦٠/.test($('[data-summary="duration"]').textContent));
  $('#guardianName').value = 'سارة تجريبية';
  $('#phone').value = '01000000000';
  $('#consent').checked = true;
  submit('#bookingForm');
  await wait(220);

  check('result card shown', !$('#bookingResult').hidden);
  check('progress returns to the time step after submit', $('.booking-progress li[data-step="2"]').dataset.state === 'current');
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
  await wait(400);
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

  // ---- dashboard settings (owner-editable, no code) ----
  $$('[data-staff-tab]').find((button) => button.dataset.staffTab === 'settings').click();
  await wait(260);
  check('settings tab opens', !$('#staffSettings').hidden && $('#staffBoard').hidden);
  check('temporary PIN is flagged in the dashboard', !$('#pinBanner').hidden);
  check('settings groups come from the catalog', $$('#settingsGroups .settings-group').length >= 4);
  check('settings fields render for the first group', $$('#settingsFields .settings-field').length >= 3);
  check('secret fields are never shown', $$('#settingsFields #setting-GEMINI_API_KEY').length === 0 && $$('#settingsFields #setting-ADMIN_PIN').length === 0);
  $$('#settingsGroups .settings-group').find((chip) => chip.dataset.group === 'doctor').click();
  await wait(120);
  check('licence is editable by the doctor', $('#setting-DOCTOR_LICENSE') !== null);
  $$('#settingsGroups .settings-group').find((chip) => chip.dataset.group === 'clinic').click();
  await wait(120);

  $('#setting-CLINIC_NAME').value = 'عيادة النور';
  $('#setting-CLINIC_PHONE').value = '0100 123 4567';
  submit('#settingsForm');
  await wait(320);
  check('settings save reports success', !$('#settingsSaved').hidden, $('#settingsError').textContent);
  check('saved phone is normalised', $('#setting-CLINIC_PHONE').value === '01001234567', $('#setting-CLINIC_PHONE').value);
  check('the public page follows the saved name', /عيادة النور/.test($('.brand-text').textContent), $('.brand-text').textContent);
  check('the public page follows the saved phone', /01001234567/.test($('[data-config="phone"]').textContent));

  $$('#settingsGroups .settings-group').find((chip) => chip.dataset.group === 'hours').click();
  await wait(120);
  $('#setting-WORK_START').value = '18:00';
  $('#setting-WORK_END').value = '09:00';
  submit('#settingsForm');
  await wait(260);
  check('invalid hours are refused', !$('#settingsError').hidden && /تسبق/.test($('#settingsError').textContent), $('#settingsError').textContent);

  $$('#settingsGroups .settings-group').find((chip) => chip.dataset.group === 'services').click();
  await wait(120);
  check('services field is a plain text area', $('#setting-VISIT_SERVICES').tagName === 'TEXTAREA');
  $('#setting-VISIT_SERVICES').value = 'كشف أول = 45\nمتابعة = 20';
  submit('#settingsForm');
  await wait(360);
  check('a new service becomes bookable', $$('.choice-card').length === 2 && /كشف أول/.test($('.choice-grid').textContent), $('.choice-grid').textContent);
  check('the new duration is used in the summary', /٤٥/.test($('[data-summary="duration"]').textContent), $('[data-summary="duration"]').textContent);

  // ---- change the staff PIN from the UI (no Script Properties, no code) ----
  $$('#settingsGroups .settings-group').find((chip) => chip.dataset.group === 'security').click();
  await wait(120);
  check('the current PIN is required to change it', $('#setting-CURRENT_PIN') !== null);
  check('the stored PIN is never displayed', $('#setting-STAFF_PIN').value === '');
  $('#setting-STAFF_PIN').value = 'a-new-long-staff-passphrase';
  $('#setting-CURRENT_PIN').value = 'wrong-current-pin';
  submit('#settingsForm');
  await wait(260);
  check('a wrong current PIN is refused', !$('#settingsError').hidden, $('#settingsError').textContent);
  $('#setting-CURRENT_PIN').value = '2468';
  submit('#settingsForm');
  await wait(320);
  check('the PIN can be rotated from the UI', $('#settingsError').hidden, $('#settingsError').textContent);
  check('the temporary-PIN banner disappears after the change', $('#pinBanner').hidden);
  check('the new PIN is stored as a hash only', /^[a-f0-9]{64}$/.test(window.localStorage.getItem('celia-kids-staff-pin-v1') || ''));
  check('the change is recorded so the banner stays off', window.localStorage.getItem('celia-kids-pin-changed-v1') === '1');

  $$('[data-staff-tab]').find((button) => button.dataset.staffTab === 'board').click();
  await wait(120);
  check('board tab returns', !$('#staffBoard').hidden && $('#staffSettings').hidden);

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
