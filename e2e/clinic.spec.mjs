import { test, expect } from '@playwright/test';

/**
 * Celia Kids — browser journeys in Demo mode.
 *
 * Ground rules inherited from the repository:
 *  - fake data only (`01000000000`-class numbers), never a real booking;
 *  - the demo never claims a confirmed appointment — the clinic confirms by hand;
 *  - the phone number must never reappear in any rendered result;
 *  - staff access is the documented demo PIN (2468), valid in this browser only.
 *
 * The demo seeds two sample bookings (one pending, one confirmed) on first load,
 * so staff and tracking journeys do not depend on the booking test's order.
 */

const GUARDIAN = { name: 'سارة تجريبية', phone: '01000000000' };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto('/');
});

/** Pick the first quick day that actually offers slots (a clinic-closed day renders none). */
async function selectFirstAvailableDay(page) {
  const chips = page.locator('#dayChips .day-chip');
  const count = await chips.count();
  for (let index = 0; index < count; index += 1) {
    await chips.nth(index).click();
    try {
      await page.waitForSelector('#slotsGrid .slot-button', { state: 'visible', timeout: 3_000 });
      return;
    } catch {
      // Day has no slots (closed or fully booked) — try the next chip.
    }
  }
  throw new Error('no quick day rendered any slot buttons');
}

async function bookAppointment(page) {
  await selectFirstAvailableDay(page);
  await page.locator('#slotsGrid .slot-button').first().click();
  await page.fill('#guardianName', GUARDIAN.name);
  await page.fill('#phone', GUARDIAN.phone);
  // The checkbox itself is visually hidden by design; the label is the tap target.
  await page.locator('.consent-row').click();
  await page.click('#submitBooking');
  const result = page.locator('#bookingResult');
  await expect(result).toBeVisible();
  return result;
}

test('a guardian books and the result never leaks the phone nor claims confirmation', async ({ page, request }) => {
  // The badge follows clinic.json, not the build: app.js hides [data-demo-badge] when the
  // published profile says demoMode === false. Asserting "visible" unconditionally turned a
  // data change into a red build on main, so read the profile and assert the state it declares.
  const profileResponse = await request.get('/clinic.json');
  const profile = profileResponse.ok() ? await profileResponse.json() : {};
  const badge = page.locator('[data-demo-badge]');
  if (profile.demoMode === true) {
    await expect(badge).toBeVisible();
  } else {
    await expect(badge).toBeHidden();
    // A real profile must show its own identity — never the shipped placeholder.
    const clinicName = String(profile.clinicName || '').trim();
    if (clinicName) {
      await expect(page.locator('[data-config="clinicName"]').first()).toHaveText(clinicName);
    }
    const doctorName = String(profile.doctorName || '').trim();
    if (doctorName) {
      await expect(page.locator('[data-config="doctorName"]').first()).toContainText(doctorName);
    }
  }

  const result = await bookAppointment(page);
  const reference = (await result.locator('.reference-chip').innerText()).trim();
  expect(reference).toMatch(/^CK-[A-Z0-9]{6,}$/);
  // «وصل طلبكم … لم يتأكد الموعد بعد.» — the clinic confirms, never the site.
  await expect(result).toContainText('لم يتأكد');
  expect(await result.innerText()).not.toContain(GUARDIAN.phone);
});

test('tracking refuses a reference without the phone, and never renders the phone', async ({ page }) => {
  // A reference alone is not a credential (the seeded demo booking exists on every fresh browser).
  await page.fill('#trackReference', 'CK-DEMO-8K2P');
  await page.locator('#trackForm button[type="submit"]').click();
  await expect(page.locator('#trackResult')).toContainText('رقم الهاتف');

  await page.fill('#trackPhone', '0000000000');
  await page.locator('#trackForm button[type="submit"]').click();
  const tracked = page.locator('#trackResult');
  await expect(tracked).toContainText('بانتظار');
  expect(await tracked.innerText()).not.toContain('0000000000');
});

test('staff opens the board with the demo PIN, and approves the pending request', async ({ page }) => {
  await page.locator('.nav-button[data-view="staff"]').click();
  await page.fill('#staffPin', '2468');
  await page.locator('#staffLoginForm button[type="submit"]').click();

  await expect(page.locator('#staffDashboard')).toBeVisible();
  const pendingItems = page.locator('#pendingList .request-item');
  await expect(pendingItems.first()).toBeVisible();

  await page.locator('#pendingList [data-action="approve"]').first().click();
  await expect(page.locator('#weekList .request-item').first()).toBeVisible();
});

test('the page is Arabic RTL, keyboard-skippable, and names no model provider', async ({ page }) => {
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', 'ar');
  await expect(html).toHaveAttribute('dir', 'rtl');
  // The skip link is the first focusable element and points at the booking form.
  await expect(page.locator('.skip-link')).toHaveAttribute('href', '#bookingView');
  // Emergency routing sits above the fold and outside any FAB ambiguity.
  await expect(page.locator('.emergency-rail')).toContainText('طوارئ');
  // Guardian labels are programmatic (wrapped labels), so a screen reader announces them.
  await expect(page.getByLabel('اسم ولي الأمر')).toBeVisible();
  await expect(page.getByLabel('رقم الهاتف', { exact: true })).toBeVisible();
  // No model provider *named in visible copy* (the internal id="geminiStatus" is code,
  // not prose). Mirrors scripts/test-ui-smoke.js.
  expect(await page.locator('body').innerText()).not.toMatch(/Gemini/i);
  // No *invented* phone targets: with an empty clinic.json there must be no tel: link;
  // with the published profile, every tel: link must carry exactly the published digits
  // (never a made-up number, never a prefix-truncated one).
  const profile = await page.request.get('/clinic.json').then((res) => res.json()).catch(() => ({}));
  const digits = String(profile?.phone ?? '').replace(/\D/g, '');
  const telLinks = page.locator('a[href^="tel:"]');
  if (digits.length >= 6) {
    expect(await telLinks.count()).toBeGreaterThan(0);
    const hrefs = await telLinks.evaluateAll((els) => els.map((el) => el.getAttribute('href') || ''));
    for (const href of hrefs) expect(href.replace(/^tel:/, '').replace(/\D/g, '')).toBe(digits);
  } else {
    expect(await telLinks.count()).toBe(0);
  }
});

test('the demo PIN is never visible outside the staff view', async ({ page }) => {
  await expect(page.locator('#staffView')).toBeHidden();
  await expect(page.locator('#demoPinHint')).toBeHidden();
  await page.locator('.nav-button[data-view="staff"]').click();
  await expect(page.locator('#demoPinHint')).toBeVisible();
});
