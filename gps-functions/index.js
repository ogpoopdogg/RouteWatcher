/**
 * E&C Dispatch — GPS integrations (FleetHunt + PAJ)
 *
 * pollNow            HTTPS endpoint the dispatch page calls while it is open and awake.
 *                    Polls PAJ (and FleetHunt, less often) and writes the positions to
 *                    RTDB. Nothing runs on a timer, so an idle or closed page costs nothing.
 *                    A shared cooldown means several open pages still make one upstream call.
 *                    Requires a signed-in, allowed dispatcher (Firebase ID token).
 *
 * fleetHuntHistory   HTTPS endpoint used by the dispatch page for Show Track.
 *                    Proxies /v1/locations (CORS-blocked in the browser) and
 *                    returns points in the same shape the PAJ code already
 *                    expects: { success: [ { lat, lng, dateunix, ... } ] }
 *                    Requires a signed-in, allowed dispatcher (Firebase ID token).
 *
 * pajApi             HTTPS endpoint for the dispatch page.
 *                    ?action=history&deviceId=..&dateStart=..&dateEnd=..  (any allowed dispatcher)
 *                    ?action=devices                                     (admin only)
 *                    PAJ email/password/token never leave the server.
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

const FLEETHUNT_KEY = defineSecret('FLEETHUNT_KEY');
const PAJ_EMAIL = defineSecret('PAJ_EMAIL');
const PAJ_PASSWORD = defineSecret('PAJ_PASSWORD');

const FH_BASE = 'https://services.fleethunt.ca/v1';
const PAJ_BASE = 'https://connect.paj-gps.de/api/v1';
const DRIVERS_PATH = 'developer/dispatch_dashboard/drivers';
const ALLOWED_USERS_PATH = 'developer/dispatch_dashboard/allowed_users';
const ALLOWED_ORIGIN = 'https://app.eandccourier.ca';

// Shortest gap between real upstream polls, no matter how many dispatch pages ask.
const PAJ_MIN_GAP_MS = 4 * 1000;             // PAJ trackers report every few seconds
const FLEETHUNT_MIN_GAP_MS = 4.5 * 60 * 1000; // the FleetHunt device only reports every 5 minutes
const POLL_STATE_PATH = 'developer/dispatch_dashboard/poll_state';

// Must match the dispatch page (index.html: EC_ADMIN_EMAIL / EC_DEFAULT_ALLOWED_USERS)
const ADMIN_EMAIL = 'justin@ec.com';
const DEFAULT_ALLOWED_USERS = {
  gil: 'gil@ec.com',
  desirae: 'desirae@ec.com',
  justin: 'justin@ec.com'
};

/**
 * FleetHunt returns UTC strings with no timezone marker:
 *   "2026-09-15 19:16:10"
 * Date.parse() treats that as LOCAL time in some engines, which would shift
 * every reading by the UTC offset. Convert explicitly.
 * Returns epoch milliseconds, or null if unparseable.
 */
function fhTimeToMs(str) {
  if (!str || typeof str !== 'string') return null;
  const ms = Date.parse(str.trim().replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? null : ms;
}

/** Epoch seconds -> "YYYY-MM-DD HH:MM:SS" in UTC, the format FleetHunt wants. */
function msToFhTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

async function fhGet(path, params, key) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${FH_BASE}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = null;
  }
  return { ok: res.ok, status: res.status, body, text };
}

// ---------------------------------------------------------------------------
// Shared: CORS + "is this a signed-in, allowed dispatcher?"
// ---------------------------------------------------------------------------

function setCors(res) {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Vary', 'Origin');
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Verifies the Firebase ID token in "Authorization: Bearer <token>" and checks
 * the email against the same rules as the dispatch page's login gate.
 * Resolves { email, isAdmin } or throws HttpError(401/403).
 */
async function requireDispatcher(req) {
  const header = req.get('Authorization') || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) throw new HttpError(401, 'Sign-in required');

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1]);
  } catch (e) {
    throw new HttpError(401, 'Sign-in expired or invalid');
  }

  const email = String(decoded.email || '').trim().toLowerCase();
  if (!email.endsWith('@ec.com')) throw new HttpError(403, 'Not allowed');
  if (email === ADMIN_EMAIL) return { email, isAdmin: true };

  const snap = await admin.database().ref(ALLOWED_USERS_PATH).once('value');
  const list = snap.val() || DEFAULT_ALLOWED_USERS;
  const allowed = Object.values(list).some(
    (v) => String(v || '').trim().toLowerCase() === email
  );
  if (!allowed) throw new HttpError(403, 'Not allowed');
  return { email, isAdmin: false };
}

// ---------------------------------------------------------------------------
// PAJ helpers (token cached in this instance's memory only)
// ---------------------------------------------------------------------------

let pajTokenCache = null;

async function pajLogin() {
  const res = await fetch(`${PAJ_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: PAJ_EMAIL.value(),
      password: PAJ_PASSWORD.value()
    })
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = null;
  }
  // Same token locations the browser code used: data.success.token || data.token
  const token = body && ((body.success && body.success.token) || body.token);
  if (!token) throw new Error(`PAJ login failed (HTTP ${res.status})`); // never log credentials
  pajTokenCache = token;
  return token;
}

/** Calls PAJ with the cached token; on 401/403 logs in again once and retries. */
async function pajRequest(path, options = {}, retried = false) {
  const token = pajTokenCache || (await pajLogin());
  const res = await fetch(`${PAJ_BASE}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
  });
  if ((res.status === 401 || res.status === 403) && !retried) {
    pajTokenCache = null;
    return pajRequest(path, options, true);
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = null;
  }
  return { ok: res.ok, status: res.status, body, text };
}

const same = (a, b) => (a === undefined ? null : a) === (b === undefined ? null : b);

// ---------------------------------------------------------------------------
// 1. FleetHunt poll (called by pollNow)
// ---------------------------------------------------------------------------

/** One FleetHunt poll: writes each configured asset's newest position to RTDB. */
async function pollFleetHuntOnce() {
    const key = FLEETHUNT_KEY.value();
    const db = admin.database();
    const snap = await db.ref(DRIVERS_PATH).once('value');
    const drivers = snap.val() || {};

    const targets = Object.entries(drivers).filter(
      ([, d]) =>
        d &&
        d.provider === 'fleethunt' &&
        d.deviceId &&
        String(d.deviceId).trim() !== ''
    );

    if (targets.length === 0) {
      logger.info('pollFleetHunt: no fleethunt drivers configured');
      return;
    }

    for (const [driverKey, drv] of targets) {
      const assetId = String(drv.deviceId).trim();
      try {
        const r = await fhGet('/assets/location', { asset_id: assetId }, key);

        if (r.status === 429) {
          logger.warn(`pollFleetHunt: rate limited on asset ${assetId}`);
          continue;
        }
        if (!r.ok || !r.body || !r.body.location) {
          logger.warn(
            `pollFleetHunt: asset ${assetId} HTTP ${r.status} ` +
              `body=${r.text.slice(0, 200)}`
          );
          continue;
        }

        const loc = r.body.location;
        const lat = parseFloat(loc.latitude);
        const lng = parseFloat(loc.longitude);
        const ts = fhTimeToMs(loc.device_time);

        if (!Number.isFinite(lat) || !Number.isFinite(lng) || ts === null) {
          logger.warn(
            `pollFleetHunt: asset ${assetId} unusable payload ` +
              JSON.stringify(loc)
          );
          continue;
        }

        // Skip the write when the device hasn't reported anything new.
        const prev = drv.lastLocation && drv.lastLocation.updatedAt;
        if (prev && prev === ts) continue;

        const update = {
          lastLocation: { lat, lng, updatedAt: ts },
          heading: Number(loc.heading) || 0,
          ignition: Number(loc.ignition) === 1 ? 1 : 0,
          odometer: Number(loc.odometer) || 0
        };

        await db.ref(`${DRIVERS_PATH}/${driverKey}`).update(update);
        logger.info(
          `pollFleetHunt: ${driverKey} (asset ${assetId}) -> ` +
            `${lat},${lng} @ ${loc.device_time}`
        );
      } catch (err) {
        logger.error(`pollFleetHunt: asset ${assetId} failed`, err);
      }
    }
}

// ---------------------------------------------------------------------------
// 2. FleetHunt history proxy (now requires a signed-in dispatcher)
// ---------------------------------------------------------------------------

// /v1/locations is rate limited (~60s cooldown observed). Cache per asset+range
// so repeated Show Track opens don't trip a 429.
const historyCache = new Map();
const CACHE_TTL_MS = 90 * 1000;

exports.fleetHuntHistory = onRequest(
  {
    timeoutSeconds: 60,
    memory: '256MiB',
    secrets: [FLEETHUNT_KEY],
    cors: false
  },
  async (req, res) => {
    setCors(res);

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    try {
      await requireDispatcher(req);
    } catch (err) {
      res.status(err.status || 401).json({ error: err.message || 'Sign-in required' });
      return;
    }

    const assetId = String(req.query.asset_id || '').trim();
    const startSec = parseInt(req.query.dateStart, 10);
    const endSec = parseInt(req.query.dateEnd, 10);

    if (!assetId || !Number.isFinite(startSec) || !Number.isFinite(endSec)) {
      res
        .status(400)
        .json({ error: 'asset_id, dateStart and dateEnd are required' });
      return;
    }
    if (endSec <= startSec) {
      res.status(400).json({ error: 'dateEnd must be after dateStart' });
      return;
    }

    const cacheKey = `${assetId}:${startSec}:${endSec}`;
    const cached = historyCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      res.status(200).json({ success: cached.points, cached: true });
      return;
    }

    try {
      const r = await fhGet(
        '/locations',
        {
          asset_id: assetId,
          from_time: msToFhTime(startSec * 1000),
          to_time: msToFhTime(endSec * 1000)
        },
        FLEETHUNT_KEY.value()
      );

      if (r.status === 429) {
        // Serve stale rather than nothing.
        if (cached) {
          res.status(200).json({ success: cached.points, stale: true });
          return;
        }
        res
          .status(429)
          .json({ error: 'FleetHunt rate limit — try again shortly' });
        return;
      }

      if (!r.ok || !r.body || !Array.isArray(r.body.locations)) {
        logger.warn(
          `fleetHuntHistory: asset ${assetId} HTTP ${r.status} ` +
            `body=${r.text.slice(0, 200)}`
        );
        res.status(502).json({ error: 'FleetHunt request failed' });
        return;
      }

      const points = [];
      for (const p of r.body.locations) {
        const lat = parseFloat(p.latitude);
        const lng = parseFloat(p.longitude);
        const ms = fhTimeToMs(p.device_time);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || ms === null) {
          continue;
        }
        points.push({
          lat,
          lng,
          dateunix: Math.floor(ms / 1000),
          heading: Number(p.heading) || 0,
          speed: Number(p.speed) || 0
        });
      }

      points.sort((a, b) => a.dateunix - b.dateunix);
      historyCache.set(cacheKey, { at: Date.now(), points });

      // Keep the in-memory cache from growing without bound.
      if (historyCache.size > 50) {
        const oldest = [...historyCache.entries()].sort(
          (a, b) => a[1].at - b[1].at
        )[0];
        if (oldest) historyCache.delete(oldest[0]);
      }

      logger.info(
        `fleetHuntHistory: asset ${assetId} returned ${points.length} points`
      );
      res.status(200).json({ success: points });
    } catch (err) {
      logger.error(`fleetHuntHistory: asset ${assetId} failed`, err);
      res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ---------------------------------------------------------------------------
// 3. PAJ poll (called by pollNow)
// ---------------------------------------------------------------------------

/** One PAJ poll: same parsing the dispatch page used in fetchAllDevicePositions. */
async function pollPajOnce() {
  const db = admin.database();
  const snap = await db.ref(DRIVERS_PATH).once('value');
  const drivers = snap.val() || {};

  const targets = Object.entries(drivers).filter(
    ([, d]) =>
      d &&
      d.provider !== 'fleethunt' &&
      d.deviceId &&
      /^\d+$/.test(String(d.deviceId).trim())
  );
  if (targets.length === 0) return;

  const deviceIds = targets.map(([, d]) => parseInt(String(d.deviceId).trim(), 10));
  const r = await pajRequest('/getAllDeviceStatus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ devicesId: deviceIds })
  });

  if (!r.ok || !r.body || !r.body.success || typeof r.body.success !== 'object') {
    logger.warn(`pollPaj: HTTP ${r.status} body=${String(r.text || '').slice(0, 200)}`);
    return;
  }

  const now = Date.now();
  const batch = {};
  for (const [deviceIdStr, deviceData] of Object.entries(r.body.success)) {
    const devId = parseInt(deviceIdStr, 10);
    if (!devId || !deviceData) continue;

    // First driver with this device ID (same rule as the page used)
    const target = targets.find(([, d]) => String(d.deviceId).trim() === String(devId));
    if (!target) continue;
    const [driverKey, drv] = target;

    const deviceStatus = deviceData.deviceStatus || {};
    const lastPoint = deviceData.lastPoint || null;

    const next = {};
    if (deviceStatus.connection_status !== undefined) {
      next.connectionStatus = Number(deviceStatus.connection_status);
    }
    next.hasAlarm = !!(
      deviceStatus.movementAlarm ||
      deviceStatus.tiltAlarm ||
      deviceStatus.removeAlarm ||
      deviceStatus.sosAlarm
    );
    next.odometer = deviceStatus.totalDistance || deviceStatus.odometer || 0;

    if (lastPoint && lastPoint.lat !== undefined && lastPoint.lng !== undefined) {
      const lat = Number(lastPoint.lat);
      const lng = Number(lastPoint.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const tsSec = Number(lastPoint.dateunix);
        const updatedAt = Number.isFinite(tsSec) && tsSec > 0 ? tsSec * 1000 : now;
        next.lastLocation = { lat, lng, updatedAt };
        const battery = lastPoint.battery ?? lastPoint.battery_level ?? null;
        next.battery = battery === null ? null : Number(battery);
        next.heading = lastPoint.direction ?? null;
      }
    }

    // Only write fields that changed (every write re-sends the drivers node to every open page)
    const prevLoc = drv.lastLocation || {};
    for (const [field, value] of Object.entries(next)) {
      let changed;
      if (field === 'lastLocation') {
        changed = !(same(prevLoc.lat, value.lat) && same(prevLoc.lng, value.lng) && same(prevLoc.updatedAt, value.updatedAt));
      } else {
        changed = !same(drv[field], value);
      }
      if (changed) batch[`${driverKey}/${field}`] = value;
    }
  }

  if (Object.keys(batch).length > 0) {
    await db.ref(DRIVERS_PATH).update(batch);
  }
}

// ---------------------------------------------------------------------------
// 3b. On-demand poll, called by the dispatch page while it is open and awake
// ---------------------------------------------------------------------------

/**
 * Claims the right to poll one provider. Only the caller that wins the slot makes
 * the upstream call, so several open dispatch pages share a single poll.
 * Returns true if this caller should poll.
 */
async function claimPollSlot(provider, minGapMs) {
  const now = Date.now();
  const res = await admin
    .database()
    .ref(`${POLL_STATE_PATH}/${provider}`)
    .transaction((last) => {
      if (typeof last === 'number' && now - last < minGapMs) return undefined; // someone just polled
      return now;
    });
  return !!(res && res.committed);
}

exports.pollNow = onRequest(
  {
    timeoutSeconds: 60,
    memory: '256MiB',
    cpu: 'gcf_gen1', // fractional CPU (about 0.167 vCPU at 256 MB) instead of the default 1 vCPU
    maxInstances: 3, // a ceiling on cost if anything ever calls this in a loop
    secrets: [FLEETHUNT_KEY, PAJ_EMAIL, PAJ_PASSWORD],
    cors: false
  },
  async (req, res) => {
    setCors(res);

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    try {
      await requireDispatcher(req);
    } catch (err) {
      res.status(err.status || 401).json({ error: err.message || 'Sign-in required' });
      return;
    }

    // 'polled' = this call fetched, 'recent' = another page just did, 'failed' = see logs
    const out = { paj: 'recent', fleethunt: 'recent' };

    await Promise.all([
      (async () => {
        if (!(await claimPollSlot('paj', PAJ_MIN_GAP_MS))) return;
        await pollPajOnce();
        out.paj = 'polled';
      })().catch((err) => {
        out.paj = 'failed';
        logger.error('pollNow: PAJ poll failed', err);
      }),
      (async () => {
        if (!(await claimPollSlot('fleethunt', FLEETHUNT_MIN_GAP_MS))) return;
        await pollFleetHuntOnce();
        out.fleethunt = 'polled';
      })().catch((err) => {
        out.fleethunt = 'failed';
        logger.error('pollNow: FleetHunt poll failed', err);
      })
    ]);

    res.status(200).json(out);
  }
);

// ---------------------------------------------------------------------------
// 4. PAJ proxy for the dispatch page
// ---------------------------------------------------------------------------

const PAJ_MAX_RANGE_SEC = 31 * 24 * 60 * 60; // one request covers at most 31 days

exports.pajApi = onRequest(
  {
    timeoutSeconds: 60,
    memory: '256MiB',
    secrets: [PAJ_EMAIL, PAJ_PASSWORD],
    cors: false
  },
  async (req, res) => {
    setCors(res);

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'GET only' });
      return;
    }

    let who;
    try {
      who = await requireDispatcher(req);
    } catch (err) {
      res.status(err.status || 401).json({ error: err.message || 'Sign-in required' });
      return;
    }

    const action = String(req.query.action || '');

    try {
      if (action === 'history') {
        const deviceId = String(req.query.deviceId || '').trim();
        const startSec = parseInt(req.query.dateStart, 10);
        const endSec = parseInt(req.query.dateEnd, 10);
        if (!/^\d+$/.test(deviceId) || !Number.isFinite(startSec) || !Number.isFinite(endSec)) {
          res.status(400).json({ error: 'deviceId (digits), dateStart and dateEnd are required' });
          return;
        }
        if (endSec <= startSec) {
          res.status(400).json({ error: 'dateEnd must be after dateStart' });
          return;
        }
        if (endSec - startSec > PAJ_MAX_RANGE_SEC) {
          res.status(400).json({ error: 'Date range too long (max 31 days)' });
          return;
        }

        const r = await pajRequest(
          `/trackerdata/${deviceId}/date_range?dateStart=${startSec}&dateEnd=${endSec}&wifi=1&gps=1`,
          { method: 'GET' }
        );
        if (!r.ok || !r.body) {
          logger.warn(`pajApi history: device ${deviceId} HTTP ${r.status} body=${String(r.text || '').slice(0, 200)}`);
          res.status(502).json({ error: `PAJ request failed (HTTP ${r.status})` });
          return;
        }
        // Same shape the page already reads: { success: [ { lat, lng, dateunix, direction, ... } ] }
        const points = Array.isArray(r.body.success) ? r.body.success : [];
        res.status(200).json({ success: points });
        return;
      }

      if (action === 'devices') {
        if (!who.isAdmin) {
          res.status(403).json({ error: 'Only the admin account can list PAJ devices' });
          return;
        }
        const r = await pajRequest('/device', { method: 'GET' });
        if (!r.ok || !r.body) {
          res.status(502).json({ error: `PAJ request failed (HTTP ${r.status})` });
          return;
        }
        // Same fallbacks the page used: success || data || body
        const raw = r.body.success || r.body.data || r.body;
        const list = Array.isArray(raw) ? raw : [];
        const devices = list.map((d, i) => ({
          id: d.id || d.deviceId || d.imei || null,
          name: d.name || d.deviceName || `Device ${i + 1}`
        }));
        res.status(200).json({ success: devices });
        return;
      }

      res.status(400).json({ error: 'Unknown action' });
    } catch (err) {
      logger.error(`pajApi: ${action} failed`, err);
      res.status(500).json({ error: 'Internal error' });
    }
  }
);