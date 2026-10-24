# Sara Android app — build, install, sign

The Android app is Capacitor 7 wrapping the **same** web build in `dist/`.
It contains no second Sara: no Node server, no Gemini key, no desktop agent.

- **Application id**: `ai.sara.companion` (stable — changing it makes a
  different app, with a separate install and permissions)
- **App name**: Sara
- **Web dir**: `dist` (bundled, never a dev-server URL)
- **minSdk**: 23 (Android 6) · **target/compileSdk**: 35 (Android 15)
- **Version**: taken from `package.json` (`1.5.2` → versionName `1.5.2`,
  versionCode `1005002`)

## Cloud build (no Android Studio)

`.github/workflows/android-apk.yml` builds the APK on GitHub's runners.

1. Push to `main`, open **Actions → Android APK → Run workflow**, or push a tag
   like `v1.5.2`.
2. The `web-checks` job runs types, unit tests, the production web build and the
   browser-bundle secret scan.
3. The `apk` job installs Node 22, JDK 21 and the Android SDK, runs
   `npm run build:web` → `npx cap sync android` → `./gradlew assembleDebug`,
   verifies the APK contents, and uploads **`sara-debug-apk`**.
4. Download the artifact from the run summary and copy it to the phone.

The workflow fails (and uploads nothing) if the APK is missing, tiny, unsigned
for release, or does not contain `assets/public/index.html`.

### Install on the phone

1. Download `app-debug.apk` from the Actions artifact.
2. Copy it to the device (USB, Drive, Telegram — anything).
3. Android will ask to allow installs from that app: allow it.
4. Open Sara → **Connect to Sara** → paste the HTTPS address of the Sara server
   and the `SARA_ACCESS_TOKEN` → **Test connection** → **Save & connect**.
5. The first microphone tap asks for the microphone permission. Denying it
   keeps text chat and Sara's voice working.

Debug APKs are installable and self-signed with a debug key. They cannot be
published to Play and are not upgrade-compatible with a release-signed build.

## Local build (optional)

Only needed if you want to compile without CI. Requires JDK 21 + Android SDK:

```bash
npm ci
npm run build:web
npx cap sync android
cd android && ./gradlew assembleDebug
# android/app/build/outputs/apk/debug/app-debug.apk
```

Open the project in Android Studio only if you need a debugger
(`npm run cap:open`). Routine builds do not need it.

## Configuration in the app

| Setting | Where |
| --- | --- |
| Theme | chosen by voice (`changeBackground`) or saved from the last session |
| Reduced motion / avatar off | Settings |
| Conversation log | Settings → Clear |
| Server / token | Connection panel (validated against `/api/health`) |
| Wake phrase | Settings (browser speech engine; optional) |

The app stores the server address and token in the WebView's `localStorage`.
The token is never compiled into the APK and never leaves the device except in
requests to the configured server.

## Permissions

| Permission | Why | When requested |
| --- | --- | --- |
| `INTERNET`, `ACCESS_NETWORK_STATE` | talk to the Sara server | install time |
| `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS` | voice conversation | first microphone tap |
| Camera feature (not required) | future camera vision; not implemented | never |

`android:usesCleartextTraffic="false"` plus `network_security_config.xml` block
plain HTTP: the app only talks to `https://` Sara servers, so the token and the
audio stream are always encrypted in transit.

## Icons and splash

Regenerate from `build/icon.png` (ImageMagick required):

```bash
bash scripts/android-assets.sh
```

This writes the adaptive/legacy launcher icons, round icons, portrait/landscape
splash screens and the web/PWA icons. Generated files are committed, so CI does
not need ImageMagick.

## Release signing

Release builds are a **separate job** that only runs when signing secrets exist
(or when a `v*` tag is pushed).

1. Create a keystore on your machine (one time, keep it safe — losing it means
   you can never update the app on Play):

   ```bash
   keytool -genkeypair -v -keystore sara-release.keystore \
     -alias sara -keyalg RSA -keysize 4096 -validity 10000
   base64 -w0 sara-release.keystore > keystore.b64
   ```

2. Add repository secrets (Settings → Secrets and variables → Actions):

   | Secret | Value |
   | --- | --- |
   | `SARA_KEYSTORE_FILE` | base64 contents of the keystore above |
   | `SARA_KEYSTORE_PASSWORD` | store password |
   | `SARA_KEY_ALIAS` | `sara` |
   | `SARA_KEY_PASSWORD` | key password |

3. Run **Android APK → Run workflow** with *release* selected, or push a tag.
   The job builds `assembleRelease`, verifies the signature with `apksigner`,
   prints only the certificate DN/fingerprint, and uploads
   **`sara-release-apk`**.

Keystores and passwords are never committed (`.gitignore` covers
`*.keystore`, `*.jks`, `keystore.properties`) and never printed in logs.

For a Play Store upload, add `bundleRelease` (`.aab`) to the same job and use the
same signing config.

Without those secrets the workflow still produces the debug APK and says in the
summary that signing was not configured — it never claims a signed release.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Connect to Sara" keeps failing | Address must be HTTPS and reachable from mobile data; check the tunnel is running |
| 401 after entering the token | Token changed on the server; paste the current `SARA_ACCESS_TOKEN` |
| App shows "Sara's server is off" | The PC slept or the tunnel closed; reopen Sara on the PC |
| No voice, text works | Microphone denied, or the device has no microphone permission for Android System WebView |
| Avatar missing | No model imported on the PC (the public build ships none), or the PC is unreachable; the help screen says which |
| APK installs but is a different app | `ai.sara.companion` differs from a previously signed build — uninstall the old one |
