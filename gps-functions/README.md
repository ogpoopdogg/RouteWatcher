# GPS functions (pollNow, pajApi)

The Cloud Functions RouteWatcher calls for live van positions and Show Track. Until
2026-11-05 their code was in no repository; this is the code Google had saved for the
deployed `pollNow` (downloaded from Cloud Shell on 2026-11-05, unchanged).

| Function | What RouteWatcher uses it for |
|---|---|
| `pollNow` | While a dispatch page is open and awake: polls PAJ (and FleetHunt, every 4.5 minutes) and writes positions to `developer/dispatch_dashboard/drivers`. A shared cooldown in `developer/dispatch_dashboard/poll_state` means several open pages make one upstream call. At most 3 instances. |
| `pajApi` | `?action=history` for Show Track (31 days at most per call); `?action=devices` (justin@ec.com only). |
| `fleetHuntHistory` | Show Track for FleetHunt vans. **Deleted on 2026-11-05** (no van uses FleetHunt any more); the code is still here. |

**Who may call them.** Every call needs a Firebase sign-in token (`Authorization: Bearer`).
The email must end in @ec.com and be justin@ec.com or on RouteWatcher's allowed list
(`developer/dispatch_dashboard/allowed_users`). Anyone else gets 401 or 403. Browsers
are only allowed from https://app.eandccourier.ca.

**Passwords and keys** are not in this code. They are Secret Manager secrets the
functions read at run time: `PAJ_EMAIL`, `PAJ_PASSWORD`, `FLEETHUNT_KEY`.

**Deployed versions differ.** The live `pajApi` was deployed from an older copy of this
file (same `pajApi` code, but that copy also defined the scheduled pollers `pollPaj` and
`pollFleetHunt`, which were removed on 2026-10-04 when `pollNow` replaced them).
Redeploying from this folder would make them match.

They run as the project's default compute service account, like the other functions.
