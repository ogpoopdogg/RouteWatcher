# E&C Dispatch Android app

A separate Android app (APK) for E&C Dispatch. It opens the live site (https://app.eandccourier.ca) inside
it, so it always has the newest version of the dispatch page without a new APK. On top of that it can get
**driver alerts** as phone notifications, even when the app is closed.

The website, the installed web apps (PWAs) and computers are not affected: the alerts code in `index.html`
only runs inside this app (it checks for Capacitor first and stops otherwise).

## Driver alerts

In the app, the bell beside the yellow saved points pin opens **Driver alerts**:

1. Press **New alert**.
2. Pick the van and a saved point (make points with the yellow pin first).
3. Pick **Km away** (straight line) or **Minutes driving** (Google drive time, no traffic), and the amount.
4. Press **Turn alert on**.

When the van is inside it, the phone shows e.g. "Sheldon is 48 km from Shop" and the alert switches itself
off. Turn it back on with its switch. Tapping the notification opens that van's window.

How it works:

- The alert is saved at `developer/dispatch_dashboard/proximity_alerts/{id}` (staff can already write there,
  so no database rules change).
- Each phone saves its notification address at `developer/dispatch_dashboard/push_tokens/{uid}/{key}`.
- The `driverAlerts` cloud function (`gps-functions/index.js`, rules in `gps-functions/alerts.js`) runs every
  minute. With no alert switched on it only reads the alerts list and stops. With one on, it fetches fresh
  PAJ positions (sharing `pollNow`'s cooldown, so open dispatch pages don't cause extra PAJ calls), checks
  each alert and sends the notification with Firebase Cloud Messaging.
- Drive time asks Google's Routes API (Compute Routes, no traffic) at most every 5 minutes per alert, and only
  once the van is close enough that it could be inside the time (straight-line km at 120 km/h).
- Alerts go to the person who made them, on every phone they're signed in to this app with.

## Building the APK

GitHub builds it: `.github/workflows/android-apk.yml` runs when anything in this folder changes, or by hand
(GitHub > Actions > Android APK > Run workflow). On `main` it puts the APK on the release
`android-latest`:

https://github.com/ogpoopdogg/RouteWatcher/releases/download/android-latest/ec-dispatch.apk

It needs two repository secrets (GitHub > Settings > Secrets and variables > Actions):

| Secret | What it is |
|---|---|
| `GOOGLE_SERVICES_JSON` | The whole `google-services.json` file from the Firebase console (Project settings > Your apps > the Android app `ca.eandccourier.dispatch`). Without it the APK can't get notifications and isn't published. |
| `ANDROID_KEYSTORE_B64` | The app's signing key (base64). Every APK must be signed with the same key to install over the last one. Without it GitHub makes a test (debug) APK that won't update an installed app. Keep a copy of the key somewhere safe: an APK signed with a different key can't update the app. |

To build on a computer instead: `npm ci`, `npx cap sync android`, put `google-services.json` in
`android/app/`, then `cd android && ./gradlew assembleDebug` (needs Android Studio / the Android SDK and
JDK 21).

## Installing

Open the APK link above on the Android phone, open the downloaded file, and allow installs from that
source when Android asks. Sign in like on the website. The first time an alert is made, Android asks to
allow notifications.

Google's developer verification for apps installed outside the Play Store starts on 2026-09-30 in Brazil,
Indonesia, Singapore and Thailand, and is to be expanded to all countries in 2027
(https://developer.android.com/developer-verification). Before it reaches Canada, this app will need a
(free, up to 20 devices) "limited distribution" developer account, or a full one.

## Known limits

- The voice mic may not work inside the app: Android's in-app browser (WebView) doesn't support listening
  the way Chrome does. Voice still works in Chrome and the installed web app. (Not yet tried on a phone.)
- Alerts can be up to about a minute late (the check runs once a minute; drive time every 5 minutes).
- Km alerts are straight-line distance, not road distance.

## Files

- `capacitor.config.json`: app id `ca.eandccourier.dispatch`, the site it opens.
- `www/index.html`: only shown if the site can't be reached.
- `android/`: the Android project (made by Capacitor 8; icons, dark launch screen, notification icon and
  permission added by hand).
