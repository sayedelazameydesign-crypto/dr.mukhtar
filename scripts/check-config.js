#!/usr/bin/env node
'use strict';

/**
 * Validates a Script Properties file against config/clinic.example.json.
 *
 * Usage:
 *   node scripts/check-config.js                    # validates the template itself
 *   node scripts/check-config.js my-props.json      # validates a real export
 *
 * Real exports are plain { "KEY": "value" } objects. Never commit them.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const templatePath = path.join(ROOT, 'config', 'clinic.example.json');
const template = JSON.parse(fs.readFileSync(templatePath, 'utf8')).properties;

const target = process.argv[2] ? path.resolve(process.argv[2]) : null;
const raw = target
  ? JSON.parse(fs.readFileSync(target, 'utf8'))
  : Object.fromEntries(Object.entries(template).map(([key, spec]) => [key, spec.value]));

if (raw.properties) {
  console.error('Pass plain { "KEY": "value" } properties, not the template wrapper.');
  process.exit(2);
}

const errors = [];
const warnings = [];
const isSet = (value) => value !== undefined && value !== null && String(value).trim() !== '';
const minutes = (value) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
};

for (const [key, spec] of Object.entries(template)) {
  const value = raw[key];
  if (spec.required && !isSet(value)) {
    // The committed template cannot contain real secrets; a real export must.
    if (!target && spec.secret) warnings.push(`${key}: set a real secret before deploying (template stays empty)`);
    else errors.push(`${key}: required but empty`);
    continue;
  }
  if (!isSet(value)) continue;

  if (key === 'ADMIN_PIN') {
    const pin = String(value);
    if (pin.length < 16) errors.push('ADMIN_PIN: must be at least 16 characters');
    if (pin === '2468') errors.push('ADMIN_PIN: the demo pin 2468 must never be used');
    if (/^(.)\1*$/.test(pin)) errors.push('ADMIN_PIN: must not be a single repeated character');
    if (/^\d+$/.test(pin)) warnings.push('ADMIN_PIN: all-digits pins are easier to guess');
  }
  if (key === 'TIMEZONE' && !/^[A-Za-z]+\/[A-Za-z_+-]+$/.test(String(value))) {
    errors.push(`TIMEZONE: "${value}" is not an IANA timezone`);
  }
  if (key === 'WORK_START' || key === 'WORK_END') {
    if (Number.isNaN(minutes(value))) errors.push(`${key}: must be HH:MM, got "${value}"`);
  }
  if (key === 'WORK_DAYS' && !String(value).split(',').every((day) => /^[0-6]$/.test(day.trim()))) {
    errors.push(`WORK_DAYS: must be comma separated 0..6, got "${value}"`);
  }
  if (['SLOT_MINUTES', 'NEW_VISIT_MINUTES', 'FOLLOWUP_MINUTES'].includes(key) && !(Number(value) > 0)) {
    errors.push(`${key}: must be a positive number`);
  }
  if (key.startsWith('LLM_') || key === 'GEMINI_MODEL') {
    const numericRange = { LLM_TIMEOUT_MS: [2000, 60000], LLM_RETRIES: [0, 4], LLM_BACKOFF_BASE_MS: [100, 5000], LLM_BACKOFF_MAX_MS: [500, 30000], LLM_CIRCUIT_FAILS: [1, 50], LLM_COOLDOWN_S: [10, 3600], LLM_DAILY_LIMIT: [1, 500], LLM_HOURLY_LIMIT: [1, 500], LLM_MAX_OUTPUT_TOKENS: [64, 1024], LLM_MAX_INPUT_CHARS: [50, 2000], LLM_CACHE_TTL_SEC: [0, 21600] }[key];
    if (numericRange) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < numericRange[0] || number > numericRange[1]) {
        errors.push(`${key}: must be a number within ${numericRange[0]}..${numericRange[1]}, got "${value}"`);
      }
    }
  }
  if (spec.secret && target) {
    warnings.push(`${key}: secret value read from ${path.basename(target)} — do not commit that file`);
  }
}

if (isSet(raw.WORK_START) && isSet(raw.WORK_END) && !Number.isNaN(minutes(raw.WORK_START)) && !Number.isNaN(minutes(raw.WORK_END))) {
  if (minutes(raw.WORK_START) >= minutes(raw.WORK_END)) errors.push('WORK_START must be before WORK_END');
}

const secrets = Object.entries(template).filter(([, spec]) => spec.secret).map(([key]) => key);
warnings.slice(0, 20).forEach((warning) => console.log(`· ${warning}`));

if (errors.length) {
  console.error(`Config INVALID (${errors.length}):`);
  errors.forEach((error) => console.error(` ✗ ${error}`));
  process.exit(1);
}

console.log(`Config OK — ${Object.keys(template).length} keys validated${target ? ` from ${path.basename(target)}` : ' (template defaults)'}.`);
if (warnings.some((warning) => warning.endsWith('before deploying (template stays empty)'))) {
  console.log('ACTION REQUIRED: ADMIN_PIN (and any LLM key) must be filled in Script Properties, never in the repo.');
}
console.log(`Secret keys to set privately: ${secrets.join(', ')}.`);
