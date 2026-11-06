/**
 * Staff identity, roles and sessions — the authorization layer.
 *
 * Why this file exists: the module used to hold ONE shared PIN. Whoever typed it could
 * approve a child, rotate the PIN, change the clinic settings and read the health report.
 * `docs/prd/roles-permissions.md` names that as the top current-state risk ("رمز PIN واحد
 * يفتح كل شيء"), and `docs/architecture/adr/0007-roles-and-sessions.md` records the fix.
 *
 * Three rules this file must never break:
 *   1. The decision is made on the SERVER. Hiding a button is not a permission.
 *   2. No secret is ever returned, logged or written in clear text: only SHA-256 digests.
 *   3. Fail closed. An unknown token, an expired session or a missing role denies the call;
 *      it never degrades to "any staff member".
 */

const CK_STAFF = 'Staff';
const CK_STAFF_HEADERS = ['id', 'name', 'role', 'pinHash', 'active', 'createdAt'];
const CK_STAFF_ROLES = ['CLINIC_ADMIN', 'DOCTOR', 'RECEPTION'];
const CK_SESSION_PREFIX = 'CK_SESSION_';
const CK_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one clinic shift; re-login after it

/**
 * Role → permission keys. Only keys that the code actually enforces today appear here;
 * adding a key without a server-side check would be a promise the code cannot keep.
 *
 * Matrix reference (docs/prd/roles-permissions.md): RECEPTION has no `booking:approve`
 * (§5 is 🟡 "بإعداد" — not enabled, so it is absent), DOCTOR has no `settings:write` /
 * `staff:manage` / operational health, CLINIC_ADMIN has the clinic-wide set.
 */
const CK_ROLE_PERMISSIONS = {
  CLINIC_ADMIN: [
    'booking:read:clinic', 'booking:approve', 'booking:reschedule',
    'booking:no_show', 'settings:write', 'staff:manage', 'audit:read', 'analytics:clinic'
  ],
  DOCTOR: [
    'booking:read:clinic', 'booking:approve', 'booking:reschedule',
    'booking:no_show', 'analytics:clinic'
  ],
  RECEPTION: [
    'booking:read:clinic', 'booking:reschedule', 'booking:no_show'
  ]
};

/** The session used by the call currently executing. Apps Script runs one request at a time. */
let CK_ACTIVE_SESSION = null;

function permissionsForRole_(role) {
  return (CK_ROLE_PERMISSIONS[String(role || '')] || []).slice();
}

function roleCan_(role, permission) {
  return permissionsForRole_(role).indexOf(String(permission || '')) !== -1;
}

/** The staff row behind the call in flight (null when it was not authenticated). */
function activeStaff_() {
  return CK_ACTIVE_SESSION;
}

function resetActiveStaff_() {
  CK_ACTIVE_SESSION = null;
}

function staffSheet_() {
  return ensureSheet_(getSpreadsheet_(), CK_STAFF, CK_STAFF_HEADERS);
}

/**
 * Rows as objects. A malformed row is skipped, not trusted: a sheet someone typed into
 * by hand must not become a way to gain a role.
 */
function readStaffRows_() {
  const values = staffSheet_().getDataRange().getValues();
  const rows = [];
  for (let index = 1; index < values.length; index += 1) {
    const row = values[index];
    const role = String(row[2] || '').trim().toUpperCase();
    if (!row[0] || CK_STAFF_ROLES.indexOf(role) === -1) continue;
    rows.push({
      id: String(row[0]),
      name: String(row[1] || '').slice(0, 80),
      role,
      pinHash: String(row[3] || '').toLowerCase(),
      active: row[4] !== false && String(row[4]).toLowerCase() !== 'false',
      createdAt: String(row[5] || '')
    });
  }
  return rows;
}

/**
 * The single-PIN deployment is upgraded, not abandoned: the existing ADMIN_PIN_HASH becomes
 * the owner's row on first use, so a clinic that already deployed keeps working without a
 * migration step. Nothing is derived from a name or guessed from a doc.
 */
function ensureStaffSeeded_() {
  const rows = readStaffRows_();
  if (rows.length) return rows;
  const props = PropertiesService.getScriptProperties();
  const hash = String(props.getProperty('ADMIN_PIN_HASH') || '').toLowerCase();
  if (!isPinHash_(hash)) return rows;
  staffSheet_().appendRow(['owner', 'المالك', 'CLINIC_ADMIN', hash, true, new Date().toISOString()]);
  logEvent_('info', 'staff_seeded_from_legacy_pin', { role: 'CLINIC_ADMIN' });
  return readStaffRows_();
}

function newStaffToken_() {
  try {
    const uuid = String(Utilities.getUuid() || '').replace(/-/g, '');
    if (uuid.length >= 24) return uuid + pinHash_(String(Date.now()) + Math.random()).slice(0, 16);
  } catch (error) { /* fall through to the digest form */ }
  return pinHash_(String(Date.now()) + ':' + Math.random() + ':' + Math.random());
}

function sessionStore_(token) {
  return PropertiesService.getScriptProperties().getProperty(CK_SESSION_PREFIX + String(token || ''));
}

/**
 * Find the staff row matching a candidate credential.
 *
 * Accepts what the browser actually sends: the SHA-256 digest. A plain value is accepted
 * too, because the offline tests and a bootstrap deployment type the PIN itself. Both paths
 * use constant-time comparison, and both share the existing attempt limiter.
 */
function matchStaffPin_(candidate) {
  const value = String(candidate || '');
  if (!value) return { ok: false, message: 'رمز الدخول مطلوب.' };
  if (typeof staffPinLocked_ === 'function' && staffPinLocked_()) {
    logEvent_('warn', 'staff_pin_locked', { window_s: typeof CK_PIN_LOCK_SECONDS === 'undefined' ? 0 : CK_PIN_LOCK_SECONDS });
    return { ok: false, message: 'محاولات كثيرة. انتظروا قليلًا ثم أعيدوا المحاولة.' };
  }
  const digest = isPinHash_(value) ? value.toLowerCase() : pinHash_(value);
  let matched = null;
  try {
    const rows = ensureStaffSeeded_();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row.active || !row.pinHash) continue;
      // Evaluate every row so timing does not reveal which row matched.
      if (constantTimeEquals_(digest, row.pinHash)) matched = row;
    }
  } catch (error) {
    logEvent_('error', 'staff_lookup_failed', { message: String(error && error.message || error).slice(0, 120) });
    return { ok: false, message: 'تعذّر التحقق من الرمز الآن. حاولوا مجددًا.' };
  }
  if (!matched) {
    // Transitional path: a deployment whose credential still lives in Script Properties
    // (ADMIN_PIN_HASH / a legacy plain ADMIN_PIN) authenticates as the owner. It carries
    // NO staff id, so the audit keeps the platform label instead of inventing a row.
    let legacy = false;
    try {
      legacy = typeof verifyStaffPin_ === 'function' && verifyStaffPin_(value);
    } catch (error) { legacy = false; }
    if (legacy) return { ok: true, staff: { id: '', name: 'المالك', role: 'CLINIC_ADMIN', legacy: true } };
    if (typeof staffPinFailure_ === 'function') staffPinFailure_();
    return { ok: false, message: 'رمز الدخول غير صحيح.' };
  }
  if (typeof staffPinSuccess_ === 'function') staffPinSuccess_();
  return { ok: true, staff: matched };
}

function sessionFromToken_(token) {
  const value = String(token || '');
  if (value.length < 24) return null;
  const raw = sessionStore_(value);
  if (!raw) return null;
  let session = null;
  try { session = JSON.parse(raw); } catch (error) { return null; }
  if (!session || !session.id || CK_STAFF_ROLES.indexOf(String(session.role)) === -1) return null;
  if (!(Number(session.exp) > Date.now())) {
    try { PropertiesService.getScriptProperties().deleteProperty(CK_SESSION_PREFIX + value); } catch (error) { /* expired is enough */ }
    return null;
  }
  return {
    id: String(session.id),
    name: String(session.name || ''),
    role: String(session.role),
    legacy: !!session.legacy,
    token: value
  };
}

/**
 * Resolve the caller: a live session token first, then a credential (hashed or plain).
 * The credential path exists for the first login and for a stale client; it always
 * produces a real role, never a wildcard.
 */
function staffRowIsActive_(id) {
  const wanted = String(id || '');
  if (!wanted) return false;
  try {
    return readStaffRows_().some((row) => row.id === wanted && row.active);
  } catch (error) {
    // A sheet outage must not turn into a permission: fail closed.
    return false;
  }
}

function resolveStaff_(tokenOrCredential) {
  const session = sessionFromToken_(tokenOrCredential);
  if (session) {
    // The row can be disabled after the token was issued; the token is not the authority.
    if (!session.legacy && !staffRowIsActive_(session.id)) {
      return { ok: false, message: 'انتهت صلاحية الجلسة. سجّلوا الدخول من جديد.' };
    }
    return { ok: true, session };
  }
  const matched = matchStaffPin_(tokenOrCredential);
  if (!matched.ok) return { ok: false, message: matched.message };
  return {
    ok: true,
    session: {
      id: matched.staff.id || 'owner',
      name: matched.staff.name,
      role: matched.staff.role,
      legacy: !!matched.staff.legacy,
      token: ''
    }
  };
}

/** Public entry point: one credential in, one session out. Never returns the credential. */
function login(credential) {
  const matched = matchStaffPin_(credential);
  if (!matched.ok) return { ok: false, code: 'UNAUTHORIZED', message: matched.message };
  const token = newStaffToken_();
  const session = {
    id: matched.staff.id || 'owner',
    name: matched.staff.name,
    role: matched.staff.role,
    legacy: !!matched.staff.legacy,
    exp: Date.now() + CK_SESSION_TTL_MS
  };
  try {
    PropertiesService.getScriptProperties().setProperty(CK_SESSION_PREFIX + token, JSON.stringify(session));
  } catch (error) {
    logEvent_('error', 'session_store_failed', { message: String(error && error.message || error).slice(0, 120) });
    return { ok: false, code: 'SESSION_UNAVAILABLE', message: 'تعذّر بدء الجلسة. حاولوا مجددًا.' };
  }
  CK_ACTIVE_SESSION = { id: session.id, name: session.name, role: session.role, legacy: !!session.legacy, token };
  logEvent_('info', 'staff_login', { staff_id: session.id, role: session.role });
  return {
    ok: true,
    token,
    staff: { id: session.id, name: session.name, role: session.role },
    permissions: permissionsForRole_(session.role),
    expiresAt: new Date(session.exp).toISOString()
  };
}

function logout(token) {
  const session = sessionFromToken_(token);
  if (session) {
    try { PropertiesService.getScriptProperties().deleteProperty(CK_SESSION_PREFIX + session.token); } catch (error) { /* already gone */ }
    logEvent_('info', 'staff_logout', { staff_id: session.id, role: session.role });
  }
  resetActiveStaff_();
  return { ok: true };
}

/**
 * The guard every staff-only function calls instead of `isStaff_(pin)`.
 * Returns the session on success; on failure returns `{ ok:false, message }` so the caller
 * can return the same shape it always did.
 */
function requirePermission_(tokenOrCredential, permission) {
  resetActiveStaff_();
  const resolved = resolveStaff_(tokenOrCredential);
  if (!resolved.ok) return { ok: false, message: resolved.message || 'رمز الموظف غير صحيح.' };
  const session = resolved.session;
  if (!roleCan_(session.role, permission)) {
    logEvent_('warn', 'permission_denied', { staff_id: session.id, role: session.role, permission: String(permission) });
    return { ok: false, message: 'صلاحية غير كافية لهذا الإجراء.' };
  }
  CK_ACTIVE_SESSION = session;
  return { ok: true, id: session.id, name: session.name, role: session.role, token: session.token };
}

/* ------------------------------------------------------------ staff management ---- */

function listStaff(token) {
  const guard = requirePermission_(token, 'staff:manage');
  if (!guard.ok) return guard;
  return {
    ok: true,
    staff: readStaffRows_().map((row) => ({ id: row.id, name: row.name, role: row.role, active: row.active, createdAt: row.createdAt })),
    roles: CK_STAFF_ROLES.slice(),
    permissions: JSON.parse(JSON.stringify(CK_ROLE_PERMISSIONS))
  };
}

/**
 * Add a staff member. Only an owner (CLINIC_ADMIN) can do this, and the new row gets a
 * digest — the PIN the caller typed is never stored or echoed.
 */
function addStaff(name, role, pin, token) {
  const guard = requirePermission_(token, 'staff:manage');
  if (!guard.ok) return guard;
  const label = String(name || '').trim().slice(0, 80);
  const normalizedRole = String(role || '').trim().toUpperCase();
  const value = String(pin || '');
  if (!label) return { ok: false, message: 'اسم الموظف مطلوب.' };
  if (CK_STAFF_ROLES.indexOf(normalizedRole) === -1) return { ok: false, message: 'الدور غير معروف.' };
  if (value.length < 16) return { ok: false, message: 'الرمز يجب أن يكون ١٦ حرفًا على الأقل.' };
  const digest = isPinHash_(value) ? value.toLowerCase() : pinHash_(value);
  const rows = ensureStaffSeeded_();
  if (rows.some((row) => row.pinHash === digest)) return { ok: false, message: 'هذا الرمز مستخدم بالفعل.' };
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
  staffSheet_().appendRow([String(nextId), label, normalizedRole, digest, true, new Date().toISOString()]);
  auditBestEffort_('', staffActor_(), 'STAFF_ADDED', '', '', label + ' ' + normalizedRole);
  return { ok: true, staff: { id: String(nextId), name: label, role: normalizedRole, active: true } };
}

/** Disable a staff member. The last active owner cannot be disabled: that would lock the clinic out. */
function deactivateStaff(id, token) {
  const guard = requirePermission_(token, 'staff:manage');
  if (!guard.ok) return guard;
  const wanted = String(id || '').trim();
  const rows = ensureStaffSeeded_();
  const index = rows.findIndex((row) => row.id === wanted);
  if (index === -1) return { ok: false, message: 'الموظف غير موجود.' };
  const target = rows[index];
  const activeOwners = rows.filter((row) => row.active && row.role === 'CLINIC_ADMIN');
  if (target.active && target.role === 'CLINIC_ADMIN' && activeOwners.length <= 1) {
    return { ok: false, message: 'لا يمكن تعطيل آخر مدير عيادة نشط.' };
  }
  const sheet = staffSheet_();
  const values = sheet.getDataRange().getValues();
  for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    if (String(values[rowIndex][0]) !== wanted) continue;
    sheet.getRange(rowIndex + 1, 5).setValue(false);
    auditBestEffort_('', staffActor_(), 'STAFF_DEACTIVATED', '', '', target.name + ' ' + target.role);
    return { ok: true, id: wanted, active: false };
  }
  return { ok: false, message: 'الموظف غير موجود.' };
}

/**
 * Keep the credential the login path reads in step with the legacy property.
 *
 * Only the row that held the previous digest is updated: a second owner must not be
 * silently locked out, and no row is created here if none matched (seeding does that).
 */
function syncStaffPinHash_(previousHash, nextHash) {
  const from = String(previousHash || '').toLowerCase();
  if (!isPinHash_(from)) return false;
  try {
    const sheet = staffSheet_();
    const values = sheet.getDataRange().getValues();
    for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
      if (String(values[rowIndex][3] || '').toLowerCase() !== from) continue;
      sheet.getRange(rowIndex + 1, 4).setValue(String(nextHash).toLowerCase());
      return true;
    }
  } catch (error) {
    logEvent_('error', 'staff_pin_sync_failed', { message: String(error && error.message || error).slice(0, 120) });
  }
  return false;
}
