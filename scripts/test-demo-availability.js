#!/usr/bin/env node
'use strict';

/**
 * Regression test for demo-mode availability: a 60-minute confirmed visit must
 * block BOTH of its 30-minute start slots (overlap, not just exact equality).
 * Requires jsdom: npm i --no-save jsdom@25
 */
const fs = require('node:fs');
const path = require('node:path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (error) {
  // Same rule as the other browser tests: a test that did not run is not a pass.
  if (!process.env.CELIA_ALLOW_SKIP_UI) {
    console.error('SKIPPED-WITH-FAILURE: jsdom is not installed, so this test did not run.');
    console.error('Install it (npm i --no-save jsdom@25) or set CELIA_ALLOW_SKIP_UI=1 to accept the gap explicitly.');
    process.exit(1);
  }
  console.log('SKIPPED (explicit): jsdom is not installed and CELIA_ALLOW_SKIP_UI=1 was set.');
  process.exit(0);
}
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const doc = html.replace('<link rel="stylesheet" href="./app.css?v=2026">', () => '<style>' + css + '</style>')
                 .replace('<script src="./app.js?v=2026" defer></script>', () => '<script>' + js + '</script>');
const dom = new JSDOM(doc, {
  url: 'https://t/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    // pick a date two workdays ahead so the booking lands on a working day
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + 1);
    while ([5, 6].includes(d.getDay())) d.setDate(d.getDate() + 1);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const min = { start: 9 * 60, end: 14 * 60 };
    const busy = { start: 10 * 60, end: 11 * 60 }; // 60-minute new visit at 10:00
    const expected = [];
    for (let m = min.start; m + 60 <= min.end; m += 30) {
      if (!(m < busy.end && busy.start < m + 60)) expected.push(m);
    }
    w.__probe = {
      iso,
      expected: expected.map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`),
      now: new Date().toISOString(),
      seed: JSON.stringify({
        bookings: [{ reference: 'CK-PROBE-1', createdAt: new Date().toISOString(), status: 'CONFIRMED', visitType: 'كشف جديد', guardianName: 'اختبار', phone: '0000000000', day: iso, time: '10:00', eventId: '', consent: true }],
        closures: []
      })
    };
    w.localStorage.setItem('celia-kids-demo-v1', w.__probe.seed);
  }
});
const { window } = dom;
setTimeout(() => {
  const d = window.document;
  const probe = window.__probe;
  // switch the date picker to the probe day and re-query
  const input = d.querySelector('#visitDate');
  input.value = probe.iso;
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  setTimeout(() => {
    const actual = [...d.querySelectorAll('#slotsGrid .slot-button')].map((b) => b.dataset.time);
    console.log('day:', probe.iso);
    console.log('expected:', probe.expected.join(', '));
    console.log('actual:  ', actual.join(', '));
    const overlapBlocked = !actual.includes('10:00') && !actual.includes('10:30');
    const preserved = actual.includes('11:00');
    const matches = JSON.stringify(actual) === JSON.stringify(probe.expected);
    console.log('10:00 & 10:30 blocked (60-min overlap):', overlapBlocked);
    console.log('11:00 still offered:', preserved);
    console.log('exact match with model:', matches);
    if (overlapBlocked && preserved && matches) {
      console.log('PASS: demo availability respects visit duration and work hours.');
      process.exit(0);
    }
    console.error('FAIL: demo availability does not match the expected model.');
    process.exit(1);
  }, 250);
}, 300);
