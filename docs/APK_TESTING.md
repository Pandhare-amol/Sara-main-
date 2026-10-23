# Install the APK and test Sara on your phone

The debug APK is built by GitHub Actions on every push
(`.github/workflows/android-apk.yml` → artifact **sara-debug-apk**). It is signed
with the debug key, so Android will warn about an unknown source — that is
expected for a test build.

The app is a **client**: it talks to Sara running on your PC. Both devices must
be on the same Wi-Fi (or you expose the PC through an HTTPS tunnel).

---

## 1. On the PC — start Sara for the phone

```bash
npm install          # once
npm run phone        # starts Sara in phone mode
```

`npm run phone` prints something like:

```
  Sara — phone access
  ───────────────────
  Token:  <long random token>

  In the Android app → Connection, enter one of:
    http://192.168.1.20:3000    (Wi-Fi/Ethernet)
```

What it does: creates `.sara-phone.json` (git-ignored, 0600) holding the access
token, binds the server to `0.0.0.0`, and runs the normal server with
`SARA_REMOTE_ACCESS=1`. Leave the window open while you use the phone.

- If Windows Firewall asks, **allow Node.js on private networks**.
- Desktop control (opening apps, moving the mouse) from the phone stays off
  unless you run `npm run phone -- --allow-desktop`.
- Stop it with `Ctrl+C`. Sara on the PC keeps working locally as before.

## 2. Install the APK

Download the APK **on your phone** from the rolling release:

**https://github.com/Pandhare-amol/Sara-main-/releases/tag/apk-latest**
(file `sara-debug-<commit>.apk`)

The same file is also attached to every CI run as the **sara-debug-apk**
artifact (Actions → Android APK → latest run). Then:

1. Copy it to the phone (USB, Drive, or `adb install -r sara-debug.apk`).
2. Tap it → *Install anyway* / allow the source you opened it from.
3. Open **Sara**.

The debug build is versioned `<version>-debug` and installs side by side with
your normal Sara (same package `ai.sara.companion`, so it replaces the older one —
uninstall that first if the signature differs).

## 3. Connect the app to the PC

1. The Connect screen asks for **Sara server address** and **access token**.
2. Address: exactly what `npm run phone` printed, including `http://`.
3. Token: the value printed under "Token:".
4. **Test connection** → it must say *Connected in … ms · Sara 1.5.x*.
5. **Save & connect**.

If the PC has no Gemini key yet, Sara's normal key screen appears next: paste
your own key (it is validated with a live call and stored on the PC only).

## 4. What to check (5 minutes)

| Check | Expected |
| --- | --- |
| Stage | the character (if a model is imported on the PC) or the emblem; the phone never downloads the model licence-free |
| **Companion look** | upload a video → it becomes the stage, muted, looping; kill the app and reopen → still there |
| Text | ask a question → streamed answer, same conversation as the PC |
| Voice | tap the mic → allow microphone → speak → she answers aloud |
| **Today** | real reminders, tasks, approvals from the PC |
| **Missions** | start a task from the phone → watch it run on the PC (approval prompts appear here) |
| **PC screen** | capture → the PC's screen appears once, with the focused window name |
| **Settings** | every section opens, changes persist, the PC UI shows the same values |
| **Self-check** | capability list with what is available / needs permission / unsupported |
| **Stop everything** | arms, then stops tasks, browser, calls and input |

## 5. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| *"The phone could not reach the PC"* | different network, wrong IP, or Windows Firewall blocking Node. Re-run `npm run phone`; the IP changes when you switch Wi-Fi. |
| *"Sara's server refused the access token" (401)* | token mismatch — copy the token from the console again; the token stays the same between runs while `.sara-phone.json` exists. |
| *"Remote access is off on this server"* | the server was started with `npm run dev` instead of `npm run phone`. |
| Connect works but every screen says offline | the server restarted without remote access; use `npm run phone`. |
| *"That feature is only available on the computer"* | remote desktop tools are off — start with `npm run phone -- --allow-desktop`. |
| Video upload says the browser cannot keep it | the phone's WebView storage is blocked (private mode / policy); use the installed app, not a private tab. |
| App installs but shows a blank stage | no 3D model imported on the PC (licence: models are never bundled). Import one on the PC, or use **Companion look** with a video. |

## Security notes for this test build

- The **debug** APK allows plain `http://` on your local network so it can reach
  `npm run phone`. Release builds stay HTTPS-only
  (`android/app/src/main/res/xml/network_security_config.xml`).
- The token travels with every request; keep the test on a network you trust, and
  delete `.sara-phone.json` (or run without `npm run phone`) when you are done.
- Your video and the device preferences stay on the phone. Your Gemini key never
  reaches the phone.
