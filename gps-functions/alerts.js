/**
 * Driver alerts: the rules, kept apart from Firebase so they can be tested (alerts.test.js).
 *
 * An alert (developer/dispatch_dashboard/proximity_alerts/{id}) is made in the Android app:
 *   { driverId, pointName, lat, lng, mode: 'km' | 'min', value, on: true, uid, createdAt }
 * driverAlerts (index.js) checks every switched-on alert once a minute. When the van is inside the
 * distance (km = straight line) or the drive time (min = Google Routes), the person who made the
 * alert gets a notification on their phone and the alert switches itself off.
 */
'use strict';

// Drive time is only asked of Google when the van could possibly be that close: no van averages more
// than this in a straight line, so a van further than (minutes x this) can't be inside the time yet.
const FASTEST_KMH = 120;
// How often drive time is asked for one alert, at most (each ask is one paid Routes call after the free ones).
const ROUTE_CHECK_EVERY_MS = 5 * 60 * 1000;
// Largest values the app allows (also stops a typo from making a useless alert)
const MAX_KM = 2000;
const MAX_MIN = 24 * 60;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** A switched-on alert with everything needed to check it, or null (left alone). */
function validAlert(a) {
  if (!a || a.on !== true) return null;
  const lat = Number(a.lat);
  const lng = Number(a.lng);
  const value = Number(a.value);
  const mode = a.mode === 'min' ? 'min' : a.mode === 'km' ? 'km' : null;
  if (!mode || !a.driverId || !a.uid) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (!Number.isFinite(value) || value <= 0 || value > (mode === 'km' ? MAX_KM : MAX_MIN)) return null;
  return { mode, value, lat, lng, driverId: String(a.driverId), uid: String(a.uid), pointName: String(a.pointName || 'the point').slice(0, 60) };
}

/**
 * What to do with one alert now.
 *   alert: validAlert() result + lastRouteAt (ms of the last drive-time ask, if any)
 *   loc:   the van's lastLocation { lat, lng } (or null when it has none)
 * Returns { km, fire, askRoute }:
 *   km       straight-line distance (null with no location)
 *   fire     true = send the notification now (km alerts only; drive time decides after the ask)
 *   askRoute true = ask Google for the drive time now
 */
function decide(alert, loc, nowMs) {
  const lat = loc ? Number(loc.lat) : NaN;
  const lng = loc ? Number(loc.lng) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { km: null, fire: false, askRoute: false };
  const km = haversineKm(lat, lng, alert.lat, alert.lng);
  if (alert.mode === 'km') return { km, fire: km <= alert.value, askRoute: false };
  const couldBeInside = km <= (alert.value / 60) * FASTEST_KMH;
  const last = Number(alert.lastRouteAt) || 0;
  return { km, fire: false, askRoute: couldBeInside && nowMs - last >= ROUTE_CHECK_EVERY_MS };
}

/** Routes API duration ("1234s") to minutes, or null. */
function durationToMin(d) {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d || ''));
  return m ? Number(m[1]) / 60 : null;
}

// Brandon, MB time (UTC-5 all year from 2026-11-01, like the dispatch page), e.g. "3:42 PM"
function brandonTime(ms) {
  const d = new Date(ms - 5 * 3600 * 1000);
  let h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

function roundKm(km) {
  return km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
}

/** The notification: "Sheldon is 48 km from Shop" / "Sheldon is 27 min from Shop" */
function message(alert, driverName, km, min, nowMs) {
  const name = String(driverName || 'The van').slice(0, 40);
  const title =
    alert.mode === 'min'
      ? `${name} is ${Math.max(1, Math.round(min))} min from ${alert.pointName}`
      : `${name} is ${roundKm(km)} km from ${alert.pointName}`;
  const limit = alert.mode === 'min' ? `${alert.value} min drive` : `${alert.value} km`;
  const extra = alert.mode === 'min' && km != null ? ` · ${roundKm(km)} km away` : '';
  return { title, body: `Your alert: within ${limit}${extra} · ${brandonTime(nowMs)}` };
}

/** Name shown in the notification: today's nickname (e.g. Sheldon), else the vehicle name. */
function driverName(nickname, drv) {
  if (typeof nickname === 'string' && nickname.trim()) return nickname.trim();
  return (drv && drv.name) || 'The van';
}

/** A database key for an FCM token (keys can't hold . $ # [ ] /). */
function tokenKey(token) {
  return String(token).replace(/[.$#[\]/]/g, '_').slice(0, 700);
}

module.exports = {
  FASTEST_KMH,
  ROUTE_CHECK_EVERY_MS,
  MAX_KM,
  MAX_MIN,
  haversineKm,
  validAlert,
  decide,
  durationToMin,
  brandonTime,
  message,
  driverName,
  tokenKey
};
