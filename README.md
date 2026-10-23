# KATARIA FAMILY ✦ — Together as One

A private family app: group chat, private chats, planning, events and calendar, shopping lists, expenses,
photos and memories, invitations and roles. It is a real Node.js + SQLite backend with WebSocket real-time
chat, and an installable PWA frontend. **No computer is needed** — everything below works from an Android phone.

- **Zero npm dependencies.** Needs only Node 22.13+. Nothing to install or build.
- **Free to run.** Free hosting + your own Google Drive for files. No paid APIs.
- **Private.** Passwords are hashed (scrypt). Every request is permission-checked on the server.
  No end-to-end encryption is claimed — the server can read messages, so host it yourself and keep the family invite-only.

---

## What was tested (and what was not)

| Area | Status |
|---|---|
| Registration, login, logout, password change/reset, account + family deletion | ✅ automated tests (126 checks) |
| Roles/permissions, cross-family and private-chat isolation, persistence across restart | ✅ automated tests |
| Chat send/receive/persist, all 20 screens render on a phone-sized browser, no JS errors | ✅ tested in headless Chromium |
| Google Drive upload/download/folders/disconnect/errors | ✅ tested against a **mock** of Google's API (64 checks) |
| Encrypted database backup to Drive + automatic restore | ✅ tested against the same mock (42 checks) |
| **Real Google Drive** with your account and folder | ⚠️ **Not tested** — needs your credentials (Part 3) |
| **Push notifications on a real phone** | ⚠️ **Not tested** — implemented, but no real push service was reachable |
| **Voice messages, camera/photo picker on a real Android phone** | ⚠️ **Not tested** on a real device |
| **Android APK** | ❌ **Not built.** This is an installable PWA (Part 4) |

Please treat the three ⚠️ items as "should work, verify on your phone".

---

## Part 1 — Put the code on GitHub (from your phone)

1. In Chrome on your phone, open **github.com** and sign up / sign in (free).
2. Tap **+ → New repository**. Name it `kataria-family`, choose **Private**, tap **Create repository**.
3. Easiest way to get the code in without a computer: use **GitHub Codespaces** (free monthly hours):
   open your repo → **Code → Codespaces → Create codespace**. It opens VS Code in the browser.
   - Open the file explorer, tap **⋯ → Upload…**, and upload the `kataria-family.zip` you were given.
   - In the terminal at the bottom type: `unzip kataria-family.zip && cp -r kataria-family/. . && rm -rf kataria-family kataria-family.zip`
   - Run the tests if you like: `npm test`
   - Commit: `git add -A && git commit -m "KATARIA FAMILY" && git push`
   - Tip: in Chrome tap ⋮ → **Desktop site** so the editor is usable.

## Part 2 — Host it free on Render

1. Open **render.com** → sign up with GitHub (free).
2. **New + → Web Service** → pick your `kataria-family` repo.
3. Settings: Runtime **Node**, Build command *(leave empty)*, Start command `npm start`, Instance type **Free**.
4. **Environment variables** (Advanced → Add):

| Name | Value |
|---|---|
| `NODE_VERSION` | `22` |
| `SECRET_KEY` | a long random string (e.g. 40+ random characters). **Write it down** — it protects your Drive login and backups. |
| `BASE_URL` | your Render address, e.g. `https://kataria-family.onrender.com` (set after first deploy, then redeploy) |
| `GOOGLE_CLIENT_ID` | from Part 3 |
| `GOOGLE_CLIENT_SECRET` | from Part 3 |

5. Deploy. Open the address — you should see the KATARIA FAMILY welcome screen.

> **Important — free hosts forget their disk.** Render's free plan wipes local files when the app sleeps/restarts.
> KATARIA FAMILY handles this by automatically backing up the database (encrypted) into your Drive folder and
> restoring it on start. This only works **after you connect Google Drive** and have set `SECRET_KEY`. Until then, data can be lost.
> After connecting, open **Profile → Google Drive** and copy the **restore key** into a `DRIVE_RESTORE_KEY` environment variable
> so a fresh server can recover everything. Free instances also sleep after ~15 minutes idle, so the first load can take ~30 s.

## Part 3 — Connect your Google Drive folder

Your folder ID `19c1XVBgxeafcZpllGh2GA3ap2wk6BHUO` is already built in.

1. On your phone open **console.cloud.google.com** (use Chrome ⋮ → *Desktop site*). Create a project, e.g. `kataria-family`.
2. **APIs & Services → Library →** search **Google Drive API → Enable**.
3. **OAuth consent screen** (or *Google Auth Platform*): User type **External**, app name `KATARIA FAMILY`, your email.
   Under **Audience / Test users**, add your own Google email (the one that owns the folder). Leaving it in *Testing* is fine.
   *(In Testing mode Google expires the login every 7 days — if Drive stops working, just tap Reconnect. Publishing the app removes this.)*
4. **Credentials → Create credentials → OAuth client ID** → type **Web application**.
   **Authorized redirect URI:** `https://YOUR-APP.onrender.com/api/drive/callback` (exactly, with your real address).
5. Copy the **Client ID** and **Client secret** into Render's `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, then redeploy.
6. In the app: **Profile → Google Drive → Connect**, sign in with the account that owns the folder, allow access.
   The app verifies the folder, creates the 7 sub-folders if missing, and starts storing uploads. If it can't open your folder, it says so — it never silently uses another location.

Files are never made public. Family members download through the app, which checks their permissions first.

## Part 4 — Install on your Android phone

1. Open your Render address in **Chrome**.
2. Tap **⋮ → Install app** (or **Add to Home screen**). The KATARIA FAMILY icon appears on your home screen and opens full-screen.
3. Sign up → **Create a family** → **Profile → Invitations** to create a code/link and send it to relatives via WhatsApp/SMS.
4. Turn on notifications in **Profile → App Settings** if you want them.

*Limits:* this is a PWA, not an APK. The Android icon/name come from the web manifest. A real APK would require a build tool
(e.g. PWABuilder, which can package a PWA from a phone browser — untested here) and is optional.

---

## Running locally / tests

```
npm start      # http://localhost:3000
npm test       # 232 automated checks (API, Drive mock, backups)
```

Data lives in `./data` (override with `DATA_DIR`). Other optional settings: `PORT`, `MAX_UPLOAD_MB` (50), `BACKUP_TO_DRIVE=off`, `BACKUP_KEEP` (8).

## Project layout

```
server/   http.js, ws.js (hand-written WebSocket), db.js (node:sqlite), routes_*.js, drive.js, backup.js, restore.js, push.js
public/   index.html, styles.css, sw.js, manifest.webmanifest, js/ (views, chat, features), assets/ (logo, icons, splash)
android/  launcher icon + splash PNGs (for a future native wrapper)
scripts/  make_icons.py (regenerates all icons from the K artwork)
test/     run.js, drive.js, backup.js, mock_google.js
```
