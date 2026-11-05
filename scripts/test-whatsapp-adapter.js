#!/usr/bin/env node
'use strict';

/**
 * WhatsApp adapter — offline suite (no network, no account, no credentials).
 *
 * The adapter exists so that booking can notify a guardian one day without booking ever
 * depending on WhatsApp. Two properties are therefore load-bearing and tested here:
 *
 *   1. `off` (the default) and `dry-run` must perform **zero** network calls.
 *   2. A notification failure must never escape as an exception into the booking path.
 *
 * Everything else — URL shape, auth header, idempotency, phone normalisation, redaction —
 * is asserted against a stub so a mistake surfaces here instead of at a real clinic.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'WhatsApp.gs');

let passed = 0;
const check = (label, condition, detail = '') => {
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
};

/** A Script Properties stub with the four methods the adapter actually uses. */
function propertiesStub(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getProperty: (key) => (map.has(key) ? map.get(key) : null),
    setProperty: (key, value) => { map.set(key, String(value)); },
    deleteProperty: (key) => { map.delete(key); },
    getKeys: () => Array.from(map.keys()),
    getProperties: () => Object.fromEntries(map),
    _map: map
  };
}

/**
 * Load WhatsApp.gs in a fresh VM context, exactly like Apps Script concatenates the bundle.
 * @param {Object} options props, fetch behaviour, clinic name
 */
function load(options = {}) {
  const calls = [];
  const logs = [];
  const props = propertiesStub(options.props);
  const fetchImpl = options.fetch || (() => ({ getResponseCode: () => 200, getContentText: () => '{"messages":[{"id":"wamid.TEST"}]}' }));
  const sandbox = {
    PropertiesService: { getScriptProperties: () => props },
    UrlFetchApp: {
      fetch: (url, params) => {
        calls.push({ url, params });
        return fetchImpl(url, params);
      }
    },
    logEvent_: (level, event, fields) => { logs.push({ level, event, fields: fields || {} }); },
    Date,
    JSON,
    String,
    Number,
    Object,
    Array,
    isFinite,
    console
  };
  vm.runInNewContext(fs.readFileSync(SOURCE, 'utf8'), sandbox, { filename: SOURCE });
  return { api: sandbox, props, calls, logs };
}

const RECORD = {
  reference: 'CK-2K6Q-8M2',
  phone: '01012345678',
  day: '2026-11-10',
  time: '10:30',
  visitType: 'كشف جديد'
};

// 1 — the default is off, and off means off: no plan, no network.
{
  const { api, calls } = load();
  const status = api.whatsappStatus();
  check('default mode is off', status.mode === 'off', status.mode);
  check('off is not configured and cannot send live', status.configured === false && status.canSendLive === false);
  const result = api.whatsappSend_('confirmation', RECORD);
  check('off returns disabled', result.sent === false && result.reason === 'disabled', JSON.stringify(result));
  check('off performs no network call', calls.length === 0);
}

// 2 — an unknown mode is treated as off and reported, never guessed into live.
{
  const { api } = load({ props: { WHATSAPP_MODE: 'Live' } });
  const status = api.whatsappStatus();
  check('unknown mode falls back to off', status.mode === 'off', status.mode);
  check('unknown mode is reported as a problem', /WHATSAPP_MODE/.test(status.problems.join(' ')), status.problems.join(' '));
}

// 3 — dry-run builds the exact request and still sends nothing.
{
  const { api, calls } = load({ props: { WHATSAPP_MODE: 'dry-run', WHATSAPP_PHONE_NUMBER_ID: '1234', CLINIC_NAME: 'عيادة تجريبية' } });
  const result = api.whatsappSend_('confirmation', RECORD);
  check('dry-run reports itself', result.dryRun === true && result.sent === false && result.reason === 'dry-run');
  check('dry-run performs no network call', calls.length === 0);
  check('dry-run exposes the URL that live would use', /graph\.facebook\.com\/v21\.0\/1234\/messages/.test(result.url), result.url);
  check('dry-run body targets the normalised local form', result.body.to === '01012345678', result.body.to);
  check('message carries the reference and the slot, not the diagnosis or free text',
    result.body.text.body.includes('CK-2K6Q-8M2') && result.body.text.body.includes('10:30') && !result.body.text.body.includes('كشف جديد'),
    result.body.text.body.replace(/\n/g, ' | '));
  check('clinic name comes from configuration', result.body.text.body.includes('عيادة تجريبية'));
  check('the phone is redacted in the result payload', !JSON.stringify({ ...result, body: null }).includes('01012345678'),
    JSON.stringify(result.target));
}

// 4 — live without credentials fails loudly and types the error; nothing is fetched.
{
  const { api, calls } = load({ props: { WHATSAPP_MODE: 'live' } });
  let error = null;
  try { api.whatsappSend_('confirmation', RECORD); } catch (thrown) { error = thrown; }
  check('live without a token throws a typed error', !!error && error.code === 'WHATSAPP_NOT_CONFIGURED', error && error.code);
  check('live without a token performs no network call', calls.length === 0);
  check('status explains what live needs', /WHATSAPP_TOKEN/.test(api.whatsappStatus().problems.join(' ')));
}

// 5 — live with credentials: one fetch, header auth, correct endpoint, local phone form.
{
  const { api, calls } = load({
    props: { WHATSAPP_MODE: 'live', WHATSAPP_TOKEN: 'test-token-value', WHATSAPP_PHONE_NUMBER_ID: '9876' }
  });
  const result = api.whatsappSend_('confirmation', RECORD);
  check('one network call per notification', calls.length === 1, String(calls.length));
  check('endpoint is the phone-id messages endpoint', calls[0].url.endsWith('/v21.0/9876/messages'), calls[0].url);
  check('token travels in the Authorization header, never the URL',
    calls[0].params.headers.Authorization === 'Bearer test-token-value' && !calls[0].url.includes('test-token-value'));
  check('the sent body is JSON with the local number',
    JSON.parse(calls[0].params.payload).to === '01012345678');
  check('the result reports a send', result.sent === true && result.status === 200);
  check('no full phone number leaks into the result', !JSON.stringify(result).includes('01012345678'), JSON.stringify(result));
}

// 6 — idempotency: the same reference and kind never sends twice inside the TTL.
{
  const { api, calls } = load({
    props: { WHATSAPP_MODE: 'live', WHATSAPP_TOKEN: 'test-token-value', WHATSAPP_PHONE_NUMBER_ID: '9876' }
  });
  api.whatsappSend_('confirmation', RECORD);
  const second = api.whatsappSend_('confirmation', RECORD);
  check('a duplicate is reported, not re-sent', second.sent === false && second.reason === 'duplicate', JSON.stringify(second));
  check('exactly one network call after two attempts', calls.length === 1, String(calls.length));
  const other = api.whatsappSend_('cancellation', RECORD);
  check('a different kind is a different notification', other.sent === true && calls.length === 2);
}

// 7 — a provider rejection is a typed failure and is not remembered as sent.
{
  const { api, props } = load({
    props: { WHATSAPP_MODE: 'live', WHATSAPP_TOKEN: 'test-token-value', WHATSAPP_PHONE_NUMBER_ID: '9876' },
    fetch: () => ({ getResponseCode: () => 400, getContentText: () => '{"error":{"message":"bad"}}' })
  });
  let error = null;
  try { api.whatsappSend_('confirmation', RECORD); } catch (thrown) { error = thrown; }
  check('provider rejection is typed with the status', !!error && error.code === 'WHATSAPP_SEND_FAILED' && error.status === 400);
  check('a failed send is not cached as sent', props.getKeys().filter((key) => key.startsWith('WHATSAPP_SENT_')).length === 0);
}

// 8 — the domain entry point never throws, and never downgrades a booking.
{
  const { api, logs } = load({ props: { WHATSAPP_MODE: 'dry-run' } });
  const broken = { reference: '', phone: '' };
  const result = api.whatsappNotify_('confirmation', broken);
  check('notify swallows adapter errors', result.ok === false && result.reason === 'error', JSON.stringify(result));
  check('notify types the failure', result.code === 'WHATSAPP_MISSING_PHONE', result.code);
  check('failure is logged without a phone number', logs.some((entry) => entry.event === 'whatsapp_notify_failed')
    && !JSON.stringify(logs).match(/01[0-9]{9}/));
}

// 9 — off-mode notify is silent and logs the mode, so staff can see why nothing was sent.
{
  const { api, logs, calls } = load();
  const result = api.whatsappNotify_('confirmation', RECORD);
  check('off-mode notify reports disabled', result.ok === true && result.sent === false && result.reason === 'disabled');
  check('off-mode notify logs the mode', logs.some((entry) => entry.event === 'whatsapp_notify' && entry.fields.mode === 'off'));
  check('off-mode notify performs no network call', calls.length === 0);
}

// 10 — Egyptian numbers in every accepted written form land on the local form.
{
  const { api } = load();
  const forms = ['01012345678', '+201012345678', '00201012345678', '201012345678', '+20 10 1234 5678'];
  const normalised = forms.map((value) => api.whatsappNormalizePhone_(value));
  check('all accepted phone forms normalise to one local value',
    normalised.every((value) => value === '01012345678'), JSON.stringify(normalised));
  check('a missing phone stays empty', api.whatsappNormalizePhone_('') === '');
  check('redaction keeps only the last three digits',
    api.whatsappRedact_('01012345678') === '•••••678', api.whatsappRedact_('01012345678'));
}

// 11 — the operator sample works without a network call and explains itself.
{
  const { api, calls } = load({ props: { WHATSAPP_MODE: 'dry-run' } });
  const sample = api.whatsappDryRunSample('reminder');
  check('sample never sends', calls.length === 0);
  check('sample names the mode it ran under', sample.mode === 'dry-run', JSON.stringify(sample).slice(0, 120));
  check('sample redacts the number it would use', sample.wouldSendTo === '•••••000', sample.wouldSendTo);
}

console.log(`WhatsApp adapter suite passed: ${passed} checks (off/dry-run send nothing, live is typed, failures never reach booking).`);
