// node --test gps-functions/alerts.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('./alerts');

const BRANDON = { lat: 49.8485, lng: -99.95 };
const WINNIPEG = { lat: 49.8954, lng: -97.1385 }; // about 202 km east of Brandon in a straight line

test('straight-line distance Brandon to Winnipeg is about 202 km', () => {
  const km = A.haversineKm(BRANDON.lat, BRANDON.lng, WINNIPEG.lat, WINNIPEG.lng);
  assert.ok(km > 195 && km < 210, String(km));
});

test('validAlert keeps only switched-on, complete alerts', () => {
  const ok = { on: true, driverId: 'd1', uid: 'u1', mode: 'km', value: 50, lat: 49.8, lng: -99.9, pointName: 'Shop' };
  assert.ok(A.validAlert(ok));
  assert.strictEqual(A.validAlert({ ...ok, on: false }), null);
  assert.strictEqual(A.validAlert({ ...ok, mode: 'miles' }), null);
  assert.strictEqual(A.validAlert({ ...ok, value: 0 }), null);
  assert.strictEqual(A.validAlert({ ...ok, value: 99999 }), null);
  assert.strictEqual(A.validAlert({ ...ok, lat: 'x' }), null);
  assert.strictEqual(A.validAlert({ ...ok, uid: '' }), null);
  assert.strictEqual(A.validAlert({ ...ok, value: '30', mode: 'min' }).value, 30);
});

test('km alert fires once the van is inside the distance', () => {
  const alert = A.validAlert({ on: true, driverId: 'd', uid: 'u', mode: 'km', value: 50, lat: WINNIPEG.lat, lng: WINNIPEG.lng });
  assert.strictEqual(A.decide(alert, BRANDON, 0).fire, false);
  const near = { lat: 49.88, lng: -97.6 }; // about 33 km west of Winnipeg
  const d = A.decide(alert, near, 0);
  assert.strictEqual(d.fire, true);
  assert.ok(d.km < 50);
  assert.strictEqual(d.askRoute, false);
});

test('no location: nothing happens', () => {
  const alert = A.validAlert({ on: true, driverId: 'd', uid: 'u', mode: 'km', value: 50, lat: 1, lng: 1 });
  assert.deepStrictEqual(A.decide(alert, null, 0), { km: null, fire: false, askRoute: false });
  assert.deepStrictEqual(A.decide(alert, { lat: 'x' }, 0), { km: null, fire: false, askRoute: false });
});

test('drive-time alert only asks Google when the van could be that close, at most every 5 minutes', () => {
  const alert = A.validAlert({ on: true, driverId: 'd', uid: 'u', mode: 'min', value: 60, lat: WINNIPEG.lat, lng: WINNIPEG.lng });
  // 202 km away: a 60 min alert can't be inside yet (60 min at 120 km/h = 120 km), so no paid call
  assert.strictEqual(A.decide(alert, BRANDON, 1e9).askRoute, false);
  const near = { lat: 49.88, lng: -97.6 };
  assert.strictEqual(A.decide(alert, near, 1e9).askRoute, true);
  assert.strictEqual(A.decide({ ...alert, lastRouteAt: 1e9 - 60000 }, near, 1e9).askRoute, false);
  assert.strictEqual(A.decide({ ...alert, lastRouteAt: 1e9 - A.ROUTE_CHECK_EVERY_MS }, near, 1e9).askRoute, true);
  assert.strictEqual(A.decide(alert, near, 1e9).fire, false); // fire is decided after the drive time comes back
});

test('durationToMin reads Routes API durations', () => {
  assert.strictEqual(A.durationToMin('1800s'), 30);
  assert.strictEqual(A.durationToMin('90.5s'), 90.5 / 60);
  assert.strictEqual(A.durationToMin(undefined), null);
  assert.strictEqual(A.durationToMin('abc'), null);
});

test('Brandon time is UTC-5', () => {
  assert.strictEqual(A.brandonTime(Date.UTC(2026, 10, 20, 20, 42)), '3:42 PM');
  assert.strictEqual(A.brandonTime(Date.UTC(2026, 10, 20, 5, 5)), '12:05 AM');
  assert.strictEqual(A.brandonTime(Date.UTC(2026, 10, 20, 17, 0)), '12:00 PM');
});

test('notification text', () => {
  const now = Date.UTC(2026, 10, 20, 20, 42);
  const km = A.validAlert({ on: true, driverId: 'd', uid: 'u', mode: 'km', value: 50, lat: 1, lng: 1, pointName: 'Shop' });
  assert.deepStrictEqual(A.message(km, 'Sheldon', 48.4, null, now), {
    title: 'Sheldon is 48 km from Shop',
    body: 'Your alert: within 50 km · 3:42 PM'
  });
  assert.strictEqual(A.message(km, 'Sheldon', 4.36, null, now).title, 'Sheldon is 4.4 km from Shop');
  const min = { ...km, mode: 'min', value: 30 };
  assert.deepStrictEqual(A.message(min, 'Sheldon', 31.2, 27.4, now), {
    title: 'Sheldon is 27 min from Shop',
    body: 'Your alert: within 30 min drive · 31 km away · 3:42 PM'
  });
});

test('driver name: nickname first, then vehicle name', () => {
  assert.strictEqual(A.driverName(' Sheldon ', { name: 'Van 21' }), 'Sheldon');
  assert.strictEqual(A.driverName('', { name: 'Van 21' }), 'Van 21');
  assert.strictEqual(A.driverName(null, null), 'The van');
});

test('token keys have no characters the database refuses', () => {
  assert.strictEqual(A.tokenKey('ab.c$d#e[f]g/h:i'), 'ab_c_d_e_f_g_h:i');
});

test('only Justin can use alerts', () => {
  assert.strictEqual(A.alertsAllowedFor('justin@ec.com'), true);
  assert.strictEqual(A.alertsAllowedFor(' Justin@EC.com '), true);
  assert.strictEqual(A.alertsAllowedFor('gil@ec.com'), false);
  assert.strictEqual(A.alertsAllowedFor(''), false);
  assert.strictEqual(A.alertsAllowedFor(undefined), false);
});
