#!/usr/bin/env node
/**
 * Publish-contract test.
 *
 * The site is assembled by an allow-list in `.github/workflows/pages.yml`. This suite proves
 * three things, because each of them failed at least once:
 *
 *   1. Every file the site needs is named in the assembly step (an allow-list silently drops
 *      new files — the 404 page existed but was never published).
 *   2. No internal file is named there (a deny-list previously published backend sources and
 *      two 43 KB terminal transcripts to the public site).
 *   3. The files that must never ship are actually gone from the repository, not merely
 *      excluded — so a future workflow edit cannot resurrect them.
 *
 * No network, no dependencies, no account.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// CELIA_REPO_ROOT lets the silent-gate suite run this against a throwaway copy.
const ROOT = process.env.CELIA_REPO_ROOT ? path.resolve(process.env.CELIA_REPO_ROOT) : path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'pages.yml');

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

/* ---------------------------------------------------------------- 1. inputs */
check('pages.yml exists', fs.existsSync(WORKFLOW));
if (failures.length) {
  failures.forEach((failure) => console.log(` ✗ ${failure}`));
  console.log(`Publish contract FAILED (${failures.length}).`);
  process.exit(1);
}

const workflow = fs.readFileSync(WORKFLOW, 'utf8');
const step = /Assemble static site[\s\S]*?find _site[^\n]*/.exec(workflow);
check('an "Assemble static site" step exists', !!step);
// Comments explain the rule and legitimately name internal files, so only the executed
// lines are checked.
const assembly = (step ? step[0] : '')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

/* --------------------------------------------------- 2. everything must ship */
// Paths the running site requests. `clinic.json` is stage-A configuration and public by design.
const SHIPPED = [
  'index.html', 'privacy.html', 'app.css', 'app.js', 'brand.svg', 'manifest.webmanifest',
  'robots.txt', 'sitemap.xml', '404.html', 'clinic.json', 'assets', 'evidence'
];

SHIPPED.forEach((file) => {
  check(`${file} exists in the repository`, fs.existsSync(path.join(ROOT, file)));
  check(`${file} is named in the assembly step`, assembly.includes(file));
});

/* --------------------------------------------- 3. internal files must not ship */
// Backend sources, build scripts, host leftovers, the env template and terminal logs.
const INTERNAL = [
  'Code.gs', 'Staff.gs', 'Llm.gs', 'Settings.gs', 'appsscript.json',
  'build-gas-package.py', 'app.config.ts', 'manus-routes.json',
  '.env.example', 'config/clinic.example.json', 'docs', 'scripts', 'gas', 'config'
];
INTERNAL.forEach((file) => {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(`(^|[\\s/])${escaped}([\\s\\\\]|$)`, 'm').test(assembly);
  check(`${file} is NOT named in the assemble step`, !named);
});

/* ----------------------------------- 4. the leak sources are gone from the repo */
// Not just excluded: deleted, so editing the workflow cannot publish them by accident.
const REMOVED = [
  '2026-11-04_09-24-14_779047_1152.txt',
  '2026-11-04_09-37-39_753588_1152.txt',
  'pasted_file_uBZldm_image.png',
  'build-gas-package.py',
  'app.config.ts',
  'manus-routes.json',
  '.env.example'
];
REMOVED.forEach((file) => {
  check(`${file} is removed from the repository`, !fs.existsSync(path.join(ROOT, file)));
});

/* ------------------------------------------ 5. .env.example moved, not lost */
// The template is still needed for local runs; it lives under config/ so a root-level
// "copy everything" mistake cannot include it.
const envTemplate = path.join(ROOT, 'config', '.env.example');
check('config/.env.example exists (template kept)', fs.existsSync(envTemplate));
if (fs.existsSync(envTemplate)) {
  const lines = fs.readFileSync(envTemplate, 'utf8').split('\n');
  const secrets = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'CELIA_ADMIN_PIN', 'PAGES_TOKEN'];
  secrets.forEach((name) => {
    const line = lines.find((item) => item.trim().startsWith(`${name}=`));
    check(`${name} is present and empty in the template`,
      !!line && line.trim() === `${name}=`);
  });
  check('the template marks GROQ_API_KEY as unused',
    /reserved name only/i.test(fs.readFileSync(envTemplate, 'utf8')));
}

/* ------------------------------------------------- 6. no wildcard repository copy */
check('the assembly does not copy the repository root itself',
  !/rsync\s+-a[\s\S]{0,400}?\.\/\s+_site\//.test(assembly) && !/cp\s+-r\s+\.\s/.test(assembly));

/* ------------------------------------------------------------------ verdict */
if (failures.length) {
  failures.forEach((failure) => console.log(` ✗ ${failure}`));
  console.log(`Publish contract FAILED (${failures.length} of ${passed + failures.length} checks).`);
  process.exit(1);
}
console.log(`Publish contract passed: ${passed} checks (${SHIPPED.length} shipped, ${INTERNAL.length} kept internal, ${REMOVED.length} removed).`);
process.exit(0);
