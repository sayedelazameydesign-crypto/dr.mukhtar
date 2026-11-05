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
  // Regression: every chip used to resolve to the same "next open day".
  const chipDays = $$('#dayChips .day-chip').map((chip) => chip.dataset.day);
  check('each quick day chip is a different day', new Set(chipDays).size === 5);
  check('quick day chips skip closed days', chipDays.every((iso) => {
    const weekday = new Date(`${iso}T12:00:00`).getDay();
    return weekday >= 0 && weekday <= 4;
  }));
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
  check('unverified licence is labelled as such', /لم تُسجَّل/.test($('[data-license-state]').textContent) && $('.doctor-card').dataset.licenseVerified === 'false');
  check('opening hours are derived, not hardcoded', /الأحد – الخميس/.test($('[data-config="hours"]').textContent) && /٩:٠٠ ص/.test($('[data-config="hours"]').textContent), $('[data-config="hours"]').textContent);
  check('structured data carries no hardcoded schedule', !/openingHoursSpecification/.test($('script[type="application/ld+json"]').textContent));
  check('phone stays a placeholder until the clinic fills it', /إعداد العيادة/.test($('[data-config="phone"]').textContent));

  // ---- the page says out loud that it still runs on examples ----
  check('onboarding banner exists in the dashboard', $('#onboardingBanner') !== null);
  // It must be visible without logging in: an example name on a public page is not a
  // placeholder, it is a claim, so the page has to say so on the public view.
  check('onboarding banner is visible on the public page', $('#onboardingBanner').hidden === false);
  check('onboarding banner lists the missing facts', /اسم الطبيب/.test($('#onboardingMissing').textContent), $('#onboardingMissing').textContent);
  check('address note is not an invented city', !/الجيزة/.test($('[data-address-note]').textContent));
  check('doctor name is a neutral placeholder, not an example name', /لم تُسجَّل/.test($('[data-config="doctorName"]').textContent));
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
  // Regression: a frozen VISIT_MINUTES table used to shadow the edited durations, so a
  // changed duration only showed in the label while the slot maths kept the old value.
  const chipAfterEdit = $$('#dayChips .day-chip')[0];
  chipAfterEdit.click();
  await wait(220);
  // Slots that are already in the past are filtered out, so assert on the gaps rather
  // than on absolute times: for a 45-minute visit every kept slot is ≥45 minutes after
  // the previous one, and a stale 30-minute duration would leave a 30-minute gap.
  const toMinutes = (time) => Number(time.split(':')[0]) * 60 + Number(time.split(':')[1]);
  const slotTimes = $$('#slotsGrid .slot-button').map((node) => node.dataset.time).map(toMinutes);
  // Unavailable starts are filtered out, so gaps can be multiples of 30; what must never
  // happen is a start that a 45-minute visit cannot use (a 30-minute step through the
  // grid) or a final start that ends after closing time (14:00 here).
  check('no start is left that a 45-minute visit cannot occupy', !slotTimes.includes(toMinutes('13:30')), slotTimes.join(','));
  check('every offered start ends within opening hours', slotTimes.every((minute) => minute + 45 <= toMinutes('14:00')), slotTimes.join(','));
  check('slots still step by the configured 30 minutes', slotTimes.slice(1).every((value, index) => (value - slotTimes[index]) % 30 === 0), slotTimes.join(','));

  // ---- change the staff PIN from the UI (no Script Properties, no code) ----
  $$('#settingsGroups .settings-group').find((chip) => chip.dataset.group === 'security').click();
  await wait(120);
  check('the current PIN is required to change it', $('#setting-CURRENT_PIN') !== null);
  check('the stored PIN is never displayed', $('#setting-STAFF_PIN').value === '');
  $('#setting-STAFF_PIN').value = 'ui-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  $('#setting-CURRENT_PIN').value = 'wrong-' + Math.random().toString(36).slice(2);
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
