// ---------- HERO VISIBILITY (cloud-persisted per user) ----------

// Hides/shows the left explainer panel. Stored in UserProperties so the
// choice follows the user across devices (cloud), with localStorage as an
// instant-paint fallback in the frontend.
var HERO_HIDDEN_KEY = 'HERO_HIDDEN';

function getHeroHidden(sessionToken) {
  requireSession_(sessionToken);
  try {
    var v = PropertiesService.getUserProperties().getProperty(HERO_HIDDEN_KEY);
    return v === '1';
  } catch (e) {
    return false;
  }
}

function setHeroHidden(hidden, sessionToken) {
  requireSession_(sessionToken);
  var isHidden = !!hidden;
  try {
    PropertiesService.getUserProperties().setProperty(HERO_HIDDEN_KEY, isHidden ? '1' : '0');
  } catch (e) {
    // Storage failure should not break logging; frontend keeps local copy.
  }
  return isHidden;
}

// ---------- PIN LOGIN + SESSIONS (server-side only) ----------

// The raw PIN is never returned to the client and never compared on the
// client. A correct PIN is exchanged (via login/setupPin) for a random
// session token valid for the globally configured duration. Sensitive calls
// present ONLY the session token, verified here on Google's backend. Tokens
// are stored hashed, so a Script Properties dump yields no usable session.
var PIN_HASH_KEY = 'PIN_HASH';
var PIN_SALT_KEY = 'PIN_SALT';
var SESSIONS_KEY = 'SESSIONS_JSON';
var SESSIONS_META_KEY = 'SESSIONS_META_JSON';
var PIN_FAIL_KEY = 'PIN_FAIL_JSON';
// Global session policy (shared by every web-app user). Duration choices are
// whole hours from 1 to 168; activity renewal defaults ON.
var SESSION_CONFIG_KEY = 'SESSION_CONFIG_JSON';
var SESSION_TTL_DEFAULT_HOURS = 3;
var SESSION_TTL_MIN_HOURS = 1;
var SESSION_TTL_MAX_HOURS = 168;
var LOGIN_MAX_FAILS = 5;
var LOGIN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function isValidPinFormat_(pin) {
  return /^\d{6}$/.test(String(pin || ''));
}

function sha256Hex_(str) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(str), Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function hashPin_(pin, salt) {
  return sha256Hex_(salt + ':' + String(pin));
}

function isPinSetup() {
  try {
    return !!PropertiesService.getScriptProperties().getProperty(PIN_HASH_KEY);
  } catch (e) {
    return false;
  }
}

// ---- Brute-force guard: 5 bad attempts per 10-minute window locks logins. ----
function getFailState_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(PIN_FAIL_KEY);
    if (raw) {
      var o = JSON.parse(raw);
      if (o && typeof o.count === 'number') return o;
    }
  } catch (e) {}
  return { count: 0, windowStart: 0 };
}

function checkLoginLock_() {
  var st = getFailState_();
  var now = Date.now();
  if (st.count >= LOGIN_MAX_FAILS && (now - Number(st.windowStart || 0)) < LOGIN_WINDOW_MS) {
    throw new Error('Too many PIN attempts - try again later.');
  }
  // Window aged out: start fresh.
  if (st.count > 0 && (now - Number(st.windowStart || 0)) >= LOGIN_WINDOW_MS) {
    resetLoginFails_();
  }
}

function recordLoginFail_() {
  var st = getFailState_();
  var now = Date.now();
  if (!st.count || (now - Number(st.windowStart || 0)) >= LOGIN_WINDOW_MS) {
    st = { count: 1, windowStart: now };
  } else {
    st.count++;
  }
  try {
    PropertiesService.getScriptProperties().setProperty(PIN_FAIL_KEY, JSON.stringify(st));
  } catch (e) {}
}

function resetLoginFails_() {
  try {
    PropertiesService.getScriptProperties().deleteProperty(PIN_FAIL_KEY);
  } catch (e) {}
}

// ---- Sessions: stored as { sha256(token): expiryMs }. ----

function loadSessions_() {  var map = {};
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(SESSIONS_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') map = parsed;
    }
  } catch (e) {
    map = {};
  }
  // Delete expired sessions on sight and persist the cleanup.
  var now = Date.now();
  var changed = false;
  for (var k in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
    if (typeof map[k] !== 'number' || map[k] <= now) {
      delete map[k];
      changed = true;
    }
  }
  if (changed) saveSessions_(map);
  return map;
}

function saveSessions_(map) {
  try {
    PropertiesService.getScriptProperties().setProperty(SESSIONS_KEY, JSON.stringify(map || {}));
  } catch (e) {}
}

function loadSessionMeta_() {
  var map = {};
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(SESSIONS_META_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') map = parsed;
    }
  } catch (e) { map = {}; }
  return map;
}

function saveSessionMeta_(map) {
  try {
    PropertiesService.getScriptProperties().setProperty(SESSIONS_META_KEY, JSON.stringify(map || {}));
  } catch (e) {}
}

function touchSessionMeta_(hash, patch) {
  try {
    var meta = loadSessionMeta_();
    var cur = meta[hash] || {};
    patch = patch || {};
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) cur[k] = patch[k];
    meta[hash] = cur;
    saveSessionMeta_(meta);
  } catch (e) {}
}

function clearAllSessions_() {
  try {
    var props = PropertiesService.getScriptProperties();
    props.deleteProperty(SESSIONS_KEY);
    props.deleteProperty(SESSIONS_META_KEY);
  } catch (e) {}
}

// ---- Global session policy: validated TTL + activity-renewal toggle,
// shared by every web-app user. Invalid or absent stored values fall back
// to the defaults; individual fields degrade independently.
function readSessionConfig_() {
  var cfg = { ttlHours: SESSION_TTL_DEFAULT_HOURS, refreshOnActivity: true };
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(SESSION_CONFIG_KEY);
    if (raw) {
      var o = JSON.parse(raw);
      if (o && typeof o === 'object') {
        var h = Number(o.ttlHours);
        if (isFinite(h) && Math.floor(h) === h && h >= SESSION_TTL_MIN_HOURS && h <= SESSION_TTL_MAX_HOURS) cfg.ttlHours = h;
        if (typeof o.refreshOnActivity === 'boolean') cfg.refreshOnActivity = o.refreshOnActivity;
      }
    }
  } catch (e) {}
  return cfg;
}

function sessionTtlMs_() {
  return readSessionConfig_().ttlHours * 60 * 60 * 1000;
}

// Serializes session-map writes so overlapping logins, renewals, and
// logouts cannot silently drop each other's entries.
function withSessionWriteLock_(fn) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); }
  catch (e) { throw new Error('Session storage is busy - try again in a few seconds.'); }
  try { return fn(); }
  finally { try { lock.releaseLock(); } catch (e) {} }
}

// Session-gated: change the global session policy. Affects only sessions
// minted afterwards; existing sessions keep their recorded expiry.
function setSessionConfig(sessionToken, ttlHours, refreshOnActivity) {
  requireSession_(sessionToken);
  var n = Number(ttlHours);
  if (!isFinite(n) || Math.floor(n) !== n || n < SESSION_TTL_MIN_HOURS || n > SESSION_TTL_MAX_HOURS) {
    throw new Error('Session duration must be a whole number of hours from 1 to 168.');
  }
  if (typeof refreshOnActivity !== 'boolean') {
    throw new Error('Activity-renewal preference must be true or false.');
  }
  var cfg = { ttlHours: n, refreshOnActivity: refreshOnActivity };
  withSessionWriteLock_(function () {
    PropertiesService.getScriptProperties().setProperty(SESSION_CONFIG_KEY, JSON.stringify(cfg));
  });
  return cfg;
}

// Session-gated activity renewal. Extends only the caller's own session to a
// fresh TTL when renewal is enabled; otherwise returns the fixed expiry
// untouched. Never resurrects expired or unknown sessions.
function touchSession(sessionToken) {
  requireSession_(sessionToken);
  var tok = String(sessionToken || '');
  var cfg = readSessionConfig_();
  if (!cfg.refreshOnActivity) {
    var map = loadSessions_();
    return { valid: true, expiresAt: map[sha256Hex_(tok)] };
  }
  return withSessionWriteLock_(function () {
    var live = loadSessions_();
    if (typeof live[sha256Hex_(tok)] !== 'number' || live[sha256Hex_(tok)] <= Date.now()) {
      throw new Error('Session expired - please log in again.');
    }
    var expiresAt = Date.now() + cfg.ttlHours * 60 * 60 * 1000;
    live[sha256Hex_(tok)] = expiresAt;
    saveSessions_(live);
    touchSessionMeta_(sha256Hex_(tok), { lastSeen: Date.now() });
    return { valid: true, expiresAt: expiresAt };
  });
}

// Pure PIN comparison, no side effects (callers own rate limiting).
function checkPinSilent_(pin) {
  if (!isPinSetup()) return false;
  if (!isValidPinFormat_(pin)) return false;
  var props = PropertiesService.getScriptProperties();
  var salt = props.getProperty(PIN_SALT_KEY) || '';
  var expected = props.getProperty(PIN_HASH_KEY) || '';
  if (!expected) return false;
  return hashPin_(pin, salt) === expected;
}

function createSession_() {
  var ttlMs = sessionTtlMs_();
  return withSessionWriteLock_(function () {
    var map = loadSessions_(); // prunes expired first
    var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    var expiresAt = Date.now() + ttlMs;
    var h = sha256Hex_(token);
    map[h] = expiresAt;
    saveSessions_(map);
    touchSessionMeta_(h, { createdAt: Date.now(), lastSeen: Date.now(),
      label: 'Browser ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') });
    return { token: token, expiresAt: expiresAt };
  });
}

// First run: create the 6-digit PIN and immediately receive a session.
function setupPin(pin) {
  if (isPinSetup()) {
    throw new Error('PIN is already set up. Use Change PIN instead.');
  }
  if (!isValidPinFormat_(pin)) {
    throw new Error('PIN must be exactly 6 digits.');
  }
  var salt = Utilities.getUuid();
  var props = PropertiesService.getScriptProperties();
  props.setProperty(PIN_SALT_KEY, salt);
  props.setProperty(PIN_HASH_KEY, hashPin_(pin, salt));
  resetLoginFails_();
  return createSession_();
}

// Exchange a correct PIN for a session valid for the configured duration.
// Wrong attempts are rate-limited.
function login(pin) {
  if (!isPinSetup()) {
    throw new Error('PIN is not set up yet.');
  }
  checkLoginLock_();
  if (!checkPinSilent_(pin)) {
    recordLoginFail_();
    throw new Error('Incorrect PIN.');
  }
  resetLoginFails_();
  return createSession_();
}

// Validate a session token. Expired entries are deleted server-side on sight.
// Valid responses also carry the global session policy so the client can
// paint countdowns and renewal UI without an extra call.
function validateSession(token) {
  var tok = String(token || '');
  if (!tok) return { valid: false };
  var map = loadSessions_(); // prunes expired, deleting them
  var h = sha256Hex_(tok);
  var exp = map[h];
  if (typeof exp === 'number' && exp > Date.now()) {
    var meta = loadSessionMeta_();
    var last = (meta[h] && meta[h].lastSeen) || 0;
    if (Date.now() - last > 5 * 60 * 1000) touchSessionMeta_(h, { lastSeen: Date.now() });
    var cfg = readSessionConfig_();
    return { valid: true, expiresAt: exp, ttlHours: cfg.ttlHours, refreshOnActivity: cfg.refreshOnActivity };
  }
  return { valid: false };
}

function logout(token) {
  var tok = String(token || '');
  if (!tok) return true;
  withSessionWriteLock_(function () {
    var map = loadSessions_();
    var h = sha256Hex_(tok);
    if (map[h] !== undefined) {
      delete map[h];
      saveSessions_(map);
    }
    var meta = loadSessionMeta_();
    if (meta[h] !== undefined) {
      delete meta[h];
      saveSessionMeta_(meta);
    }
  });
  return true;
}

// Legacy boolean oracle (rate-limited). Prefer login(), which mints a session.
function verifyPin(pin) {
  if (!isPinSetup()) {
    throw new Error('PIN is not set up yet.');
  }
  checkLoginLock_();
  var ok = checkPinSilent_(pin);
  if (ok) {
    resetLoginFails_();
  } else {
    recordLoginFail_();
  }
  return ok;
}

// Requires a valid session AND the correct current PIN, then revokes EVERY
// session (including the caller's and any stolen ones) and mints one fresh
// session for the changer. The raw PIN alone is never sufficient.
function changePin(oldPin, newPin, token) {
  requireSession_(token);
  if (!checkPinSilent_(oldPin)) {
    recordLoginFail_();
    throw new Error('Current PIN is incorrect.');
  }
  if (!isValidPinFormat_(newPin)) {
    throw new Error('New PIN must be exactly 6 digits.');
  }
  if (String(oldPin) === String(newPin)) {
    throw new Error('New PIN must be different from the current PIN.');
  }
  var salt = Utilities.getUuid();
  var props = PropertiesService.getScriptProperties();
  props.setProperty(PIN_SALT_KEY, salt);
  props.setProperty(PIN_HASH_KEY, hashPin_(newPin, salt));
  resetLoginFails_();
  clearAllSessions_();
  return createSession_();
}

// Gate for ALL sensitive calls. Open only before any PIN exists (first run);
// afterwards ONLY a valid, unexpired server-side session is accepted - the
// raw PIN is never accepted here, so a leaked PIN alone cannot call APIs
// without passing login (which is rate-limited).
function requireSession_(token) {
  if (!isPinSetup()) return;
  var tok = String(token || '');
  if (!tok) {
    throw new Error('Session expired - please log in again.');
  }
  var map = loadSessions_(); // prunes expired, deleting them server-side
  var exp = map[sha256Hex_(tok)];
  if (typeof exp !== 'number' || exp <= Date.now()) {
    throw new Error('Session expired - please log in again.');
  }
}

// ---------- DEPLOYMENT ACCESS STATUS (read-only, honest) ----------
//
// Reports only what can actually be PROVEN about this deployment's access
// configuration from inside the running script, and nothing more.
//
// Apps Script cannot read a deployment's access setting from the script:
// ScriptApp exposes no access-mode getter, and appsscript.json describes the
// access value used for NEW deployments created from that manifest - it does
// not describe the access mode of an existing deployment. The Deployment REST
// API could read (and change) it, but only with an owner OAuth token carrying
// script.deployments; that credential must never be sent to this web app, a
// browser, or a log.
//
// What this endpoint treats as PROOF, deliberately narrow:
//
//   public  - only when Session positively identifies the caller as somebody
//             OTHER than the deploying owner. Under executeAs USER_DEPLOYING
//             the effective user IS the deployer, so comparing the active
//             user against the effective user is a real, server-side check
//             that the caller is a non-owner - and a non-owner who can run
//             this endpoint proves the deployment is not owner-only.
//
//   unknown - for every other case. A BLANK active-user email is NOT proof of
//             anything: identity can be unavailable for the owner too (the
//             app is served in a sandboxed iframe, so the Google session may
//             not propagate). Blank, an identity equal to the deployer, or an
//             unavailable/blank owner identity all stay unknown.
//
//   private - never returned here. Nothing inside a running script can verify
//             an owner-only deployment, and an unverified value must never be
//             presented as Private.
//
// Only a boolean (ownerSession) and the source string are returned; no email
// address, token, or owner credential ever leaves the server.
function getAccessStatus(sessionToken) {
  requireSession_(sessionToken);

  function emailOf(getter) {
    try {
      if (!Session || typeof Session[getter] !== 'function') return null; // data unavailable
      var u = Session[getter]();
      if (!u || typeof u.getEmail !== 'function') return null;
      var v = String(u.getEmail() || '').trim();
      return v.toLowerCase(); // '' means no identity available
    } catch (e) {
      return null; // Session API threw: identity data unavailable
    }
  }

  var owner = emailOf('getEffectiveUser');   // the deploying owner (executeAs USER_DEPLOYING)
  var active = emailOf('getActiveUser');    // who is calling right now
  var base = { ownerSession: false, verified: false, access: 'unknown' };

  if (owner === null || active === null) {
    base.source = 'identity-unavailable';
    base.detail = 'Identity information is unavailable for this request, so access ' +
      'visibility cannot be verified. Check Deploy > Manage deployments as the owner.';
    return base;
  }
  if (!owner) {
    base.source = 'owner-unverifiable';
    base.detail = 'The deploying owner could not be identified from the server, so ' +
      'this request cannot be classified as owner or non-owner.';
    return base;
  }
  if (!active) {
    base.source = 'identity-blank';
    base.detail = 'This request carries no verified identity. That can happen for the ' +
      'owner as well as for anyone else, so visibility is not shown as Private or Public.';
    return base;
  }
  if (active === owner) {
    base.ownerSession = true;
    base.source = 'owner-session';
    base.detail = 'Signed in as the deploying owner. A running script cannot read its own ' +
      "deployment's access setting, so visibility is not shown as Private.";
    return base;
  }
  // Positively identified non-owner executing this endpoint.
  base.ownerSession = false;
  base.verified = true;
  base.access = 'public';
  base.source = 'non-owner-identity';
  base.detail = 'This request was made by a verified account that is not the deploying ' +
    'owner, which proves the deployment is reachable by non-owners.';
  return base;
}

// ---------- GEMINI API KEY (session-gated, prompted after PIN) ----------

// True when a Gemini key is stored in Script Properties. Session-gated so the
// presence/absence of the key is only revealed to a logged-in client. Called
// right after PIN unlock — including when the PIN was already set — so a
// missing key always triggers the frontend prompt.
function hasGeminiKey(sessionToken) {
  requireSession_(sessionToken);
  try {
    return !!PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  } catch (e) {
    return false;
  }
}

// Stores the user's Gemini API key (from Google AI Studio). Session-gated.
function saveGeminiKey(apiKey, sessionToken) {
  requireSession_(sessionToken);
  var k = String(apiKey || '').trim();
  if (!k) {
    throw new Error('API key cannot be empty.');
  }
  if (k.length < 10) {
    throw new Error('That API key looks too short - please paste the full key from Google AI Studio.');
  }
  if (/\s/.test(k)) {
    throw new Error('API key should not contain spaces - please paste it exactly.');
  }
  try {
    PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', k);
  } catch (e) {
    throw new Error('Could not save API key - try again.');
  }
  return true;
}
