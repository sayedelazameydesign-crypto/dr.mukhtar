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
  // A skipped browser test used to exit 0, so CI looked green while the UI was not
  // exercised at all. Fail by default; a deliberate skip must be asked for explicitly.
  if (!process.env.CELIA_ALLOW_SKIP_UI) {
    console.error('SKIPPED-WITH-FAILURE: jsdom is not installed, so this test did not run.');
    console.error('Install it (npm i --no-save --prefix /tmp jsdom) or set CELIA_ALLOW_SKIP_UI=1 to accept the gap explicitly.');
    process.exit(1);
  }
  console.log('SKIPPED (explicit): jsdom is not installed and CELIA_ALLOW_SKIP_UI=1 was set.');
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
// How the page itself decides: skip closed days (Sunday..Thursday are open by default).
const nextOpenAfter = (iso) => {
  const date = new Date(`${iso}T12:00:00Z`);
  for (let step = 0; step < 7; step += 1) {
    const weekday = date.getUTCDay();
    if (weekday >= 0 && weekday <= 4) return date.toISOString().slice(0, 10);
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return iso;
};
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
    const weekday = new Date(`${iso}T12:00:00Z`).getUTCDay();
    return weekday >= 0 && weekday <= 4;
  }));
  // The clinic is in Cairo: the first chip must be the clinic's tomorrow, whatever the
  // visitor's device thinks today is.
  const cairoToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const cairoTomorrow = (() => {
    const d = new Date(`${cairoToday}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  check('the first chip is the clinic tomorrow, not the device tomorrow',
    chipDays[0] === cairoTomorrow || chipDays[0] === nextOpenAfter(cairoTomorrow), `${chipDays[0]} vs ${cairoTomorrow}`);
  check('the date input cannot offer a past day', $('#visitDate').min === cairoToday, `${$('#visitDate').min} vs ${cairoToday}`);
  // Regression: chip labels were positional, so the first chip said «غدًا» even when the
  // clinic was shut the next day and it was really three days away. The label must be the
  // distance from the clinic's today, never the chip's index.
  const gapTo = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${cairoToday}T00:00:00Z`)) / 86400000);
  const chipLabels = $$('#dayChips .day-chip').map((chip) => chip.textContent.trim());
  const expectedLabel = (gap) => {
    if (gap <= 0) return 'اليوم';
    if (gap === 1) return 'غدًا';
    if (gap === 2) return 'بعد غد';
    return `بعد ${String(gap).replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)])} أيام`;
  };
  const mislabelled = chipDays
    .map((iso, index) => ({ iso, gap: gapTo(iso), label: chipLabels[index] }))
    .filter((item) => !item.label.startsWith(expectedLabel(item.gap)));
  check('chip labels are the real distance from the clinic today', mislabelled.length === 0,
    mislabelled.map((item) => `${item.iso} (+${item.gap}) said "${item.label}"`).join(' | '));
  check('no chip calls a later day "tomorrow"', chipDays.every((iso, index) => gapTo(iso) !== 1 || chipLabels[index].startsWith('غدًا')));
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
  // No configured number means no tel: link at all — never a tap target to nowhere,
  // and never an invented number.
  check('no call link before a number is configured', $('a[href^="tel:"]') === null);
  // The page promises WhatsApp but shipped no way to reach it.
  check('no WhatsApp button before a number is configured', $('a[href^="https://wa.me/"]') === null);

  // ---- the page says out loud that it still runs on examples ----
  check('onboarding banner exists in the dashboard', $('#onboardingBanner') !== null);
  // Two different jobs: the *public* page must not present an example as a fact
  // (asserted above via the neutral placeholders), and the *owner* must be told what to
  // fill in. The banner therefore lives in the dashboard, not on the visitor's view.
  check('onboarding banner belongs to the staff dashboard', $('#staffDashboard').contains($('#onboardingBanner')));
  check('onboarding banner lists the missing facts before login', /اسم الطبيب/.test($('#onboardingMissing').textContent), $('#onboardingMissing').textContent);
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
  // A price is shown only when the clinic announced one; an unset price must never
  // become "0 EGP", which would read as a free visit.
  const cards = $$('.choice-card').map((card) => card.textContent);
  check('no price is invented for services that have none',
    cards.every((text) => !/ج\.م/.test(text)), cards.join(' | '));
  $('#setting-VISIT_SERVICES').value = 'كشف أول = 45 = 250\nمتابعة = 20';
  submit('#settingsForm');
  await wait(360);
  const pricedCards = $$('.choice-card').map((card) => card.textContent);
  check('an announced price reaches the visit card', /٢٥٠\s*ج\.م/.test(pricedCards[0] || ''), pricedCards[0]);
  check('the priced service keeps its price in the summary',
    /٢٥٠\s*ج\.م/.test($('[data-summary="duration"]').textContent), $('[data-summary="duration"]').textContent);
  check('a service with no price stays unpriced', !/ج\.م/.test(pricedCards[1] || ''), pricedCards[1]);
  check('the price is echoed back for editing', /250/.test($('#setting-VISIT_SERVICES').value), $('#setting-VISIT_SERVICES').value);
  // A negative price must be refused, not silently read as a 5-minute visit.
  $('#setting-VISIT_SERVICES').value = 'كشف أول = 45 = -5';
  submit('#settingsForm');
  await wait(300);
  check('a negative price is refused', !$('#settingsError').hidden, 'no error shown');
  $('#setting-VISIT_SERVICES').value = 'كشف أول = 45 = 250\nمتابعة = 20';
  submit('#settingsForm');
  await wait(300);
  // A parent on a phone taps the clinic's number instead of copying it.
  const phoneLink = $('[data-config="phone"] a');
  check('a configured phone becomes a tap-to-call link', phoneLink !== null && /^tel:\+?[0-9]{6,}$/.test(phoneLink.getAttribute('href')), phoneLink && phoneLink.getAttribute('href'));
  check('the dialable number keeps no spaces or dashes', phoneLink !== null && !/[\s-]/.test(phoneLink.getAttribute('href')), phoneLink && phoneLink.getAttribute('href'));
  const wa = $('a[href^="https://wa.me/"]');
  check('a configured number turns on the WhatsApp button', wa !== null, 'no wa.me link');
  check('the WhatsApp opener carries no personal or medical details', wa !== null
    && /wa\.me\/01001234567\?text=/.test(wa.getAttribute('href'))
    && !/اسم|هاتف|عمر|سنة|أعراض|ألم|حرارة/.test(decodeURIComponent(wa.getAttribute('href').split('text=')[1] || '')),
    wa && decodeURIComponent(wa.getAttribute('href')));
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

  // ---- an unverified slot must be visible in the dashboard, not just stored ----
  await window.eval(`(async () => {
    const store = JSON.parse(localStorage.getItem('celia-kids-demo-v1'));
    store.bookings.unshift({
      reference: 'CK-UNVERIFIED-1', createdAt: new Date().toISOString(), status: 'REQUESTED',
      visitType: 'كشف جديد', guardianName: 'ولي أمر بلا تحقق', phone: '01009998877',
      day: store.bookings[0].day, time: '09:00', eventId: '', consent: true, slotVerified: false
    });
    localStorage.setItem('celia-kids-demo-v1', JSON.stringify(store));
  })()`);
  document.dispatchEvent(new window.Event('visibilitychange'));
  await wait(700);
  const pendingHtml = $('#pendingList').innerHTML;
  check('a slot the calendar could not verify is flagged in the dashboard', /لم يُتحقق من التقويم/.test(pendingHtml), pendingHtml.slice(0, 120));
  check('the flagged request is visually marked', $$('#pendingList .request-item.is-unverified').length > 0);

  // ---- admin question ----
  $('#faqQuestion').value = 'كيف أغيّر الموعد؟';
  submit('#faqForm');
  await wait(200);
  check('assistant answers', $('#faqAnswer').textContent.trim().length > 10);

  // ---- back to booking, wrong pin ----
  $$('.nav-button').find((button) => button.dataset.view === 'booking').click();
  await wait(60);
  check('booking view restored', !$('#bookingView').hidden && $('#staffView').hidden);

  // ---- the freeze guard: a server call that never answers must not end the screen ----
  // In Apps Script mode a queued or hung call used to leave the submit button disabled and
  // the spinner running forever: a "sudden stop" with no message and no way back. The
  // wrapper (withDeadline in app.js) is the only thing between the browser and a dead UI,
  // so this block reproduces a hang and observes the recovery instead of trusting a regex.
  {
    // One DOM instance only: `google.script.run` must exist before the page script runs,
    // otherwise a demo instance would answer first and the GAS path would never be seen.
    const bridge = new JSDOM(document_, {
      url: 'https://celia.test/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) {
        window.scrollTo = () => {};
        window.HTMLElement.prototype.scrollIntoView = () => {};
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        // The real knob (app.js also clamps it to a 1 s floor); the shipped value is 45 s.
        window.CELIA_CALL_TIMEOUT_MS = 1000;
        const calls = [];
        const hang = { calls };
        ['withSuccessHandler', 'withFailureHandler'].forEach((name) => { hang[name] = () => hang; });
        ['createRequest', 'getDashboard', 'getAvailableSlots', 'getClinicProfile', 'lookupBooking'].forEach((name) => {
          hang[name] = (...args) => { calls.push(name); };
        });
        window.google = { script: { run: hang } };
        window.addEventListener('error', (event) => problems.push(`bridge script error: ${event.message}`));
      }
    });
    const win = bridge.window;
    const doc = win.document;
    const calls = win.google.script.run.calls;
    // Past the deadine: the initial slot read must have given up by now.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // A read that hangs must land on the documented fallback, not on a spinner.
    check('a hung slot read falls back instead of spinning',
      doc.querySelector('#availabilityNote').hidden === false,
      'the availability note did not appear after the deadline');

    doc.querySelector('#guardianName').value = 'ولي أمر تجريبي';
    doc.querySelector('#phone').value = '01000000000';
    doc.querySelector('#consent').checked = true;
    const slot = doc.querySelector('#slotsGrid .slot-button');
    if (slot) slot.click();
    const submitButton = doc.querySelector('#submitBooking');
    const submitLabel = submitButton.querySelector('span');
    doc.querySelector('#bookingForm').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    check('the page really called the Apps Script runner', calls.length > 0,
      'no server method was invoked, so the freeze behaviour was never exercised');
    check('the submit button waits while the call is in flight', submitButton.disabled === true,
      'the button was never disabled, so the recovery below would prove nothing');
    // ... and after the deadline it must come back, with an honest message.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    check('a hung submission releases its button', submitButton.disabled === false,
      'the submit button stayed disabled after the deadline — the freeze is back');
    check('the submit label is restored', submitLabel.textContent.includes('إرسال'),
      `the label stayed on: ${submitLabel.textContent}`);
    check('the guardian is told what happened', /لم يصل ردّ الخادم/.test(doc.querySelector('#toast').textContent),
      `toast said: ${doc.querySelector('#toast').textContent}`);
    check('the wait is not silent: a slot read that timed out is announced', /لم يصل ردّ الخادم/.test(doc.querySelector('#availabilityNote').textContent + doc.querySelector('#toast').textContent),
      'no message mentions the missed server response');
    check('staff actions reconcile after a timeout instead of trusting a stale screen',
      /error\.code === 'TIMEOUT'\) await refreshDashboard\(\)/.test(js),
      'staffAction no longer re-reads the dashboard after a timeout');
    win.close();
  }

  check('no runtime errors', problems.length === 0, problems.join(' | '));
  check('reveal enhancement only hides when the script opted in',
    document.documentElement.classList.contains('js-reveal-ready')
      ? $$('.card, .side-card, .tool-card, .steps-strip').every((node) => node.classList.contains('is-revealed') || node.getBoundingClientRect().top >= window.innerHeight)
      : $$('.card').every((node) => !node.style.opacity || node.style.opacity === '1'));

  if (failures.length) {
    console.error(`UI smoke test FAILED (${failures.length}):`);
    failures.forEach((item) => console.error(' - ' + item));
    process.exit(1);
  }
  console.log('UI smoke test passed: rendering, booking, reference tracking, staff approval, and the admin assistant all work in demo mode.');
  process.exit(0);
})();
