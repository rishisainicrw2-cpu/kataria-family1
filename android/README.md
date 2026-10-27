# Hindu Esports – Android app

The Android app is a very small launcher (one Java file, no libraries). It opens
`https://hindu-esports.onrender.com` in Chrome as a **Trusted Web Activity**: full screen, no address bar,
with the same login, chat, camera/microphone and phone alerts as the website. When the website is updated, the
app is updated too – the APK itself almost never needs to be rebuilt.

* Package name: `com.hinduesports.clan`
* Download link used on the invitation screen: `/hindu-esports.apk` (the file is `public/hindu-esports.apk`)
* The website proves that it trusts the app through `/.well-known/assetlinks.json`, which the server builds from
  two settings on the host (Render → Environment):
  * `ANDROID_PACKAGE` = `com.hinduesports.clan`
  * `ANDROID_SHA256`  = SHA-256 fingerprint of the key the APK is signed with (several keys can be separated by commas)

  Without these two settings the app still opens the site, but with a small browser bar on top.

## The signing key (keep it private!)

The APK is signed with a private key (`hinduesports.p12`) that is **not** stored in this repository. Keep that file and
its password safe: only an APK signed with the same key can update an installed app. If the key is lost, make a new
one, add its fingerprint to `ANDROID_SHA256` (comma separated), and ask members to reinstall.

## Rebuilding (only needed to change the app name, icon, address or launcher code)

`./build.sh` does everything in one go and writes `build/hindu-esports.apk` (signed, checked). It needs a JDK, an
Android SDK platform (`android.jar`, API 34), `aapt2`, a dex compiler (the old `dx` here, `d8` works too), the
[apksig](https://android.googlesource.com/platform/tools/apksig/) library (`tools/SignApk.java` is a small command line
wrapper around it) and the private key. Where those live is set with environment variables at the top of `build.sh`
(`AAPT2`, `ANDROID_JAR`, `DX_CP`, `SIGN_CP`, `KEYSTORE`, `KEY_ALIAS`, `KEY_PASS` or `KEY_PASS_FILE`).

```sh
VERSION_CODE=3 VERSION_NAME=1.2 ./build.sh     # raise VERSION_CODE every time a new APK must replace an installed one
cp build/hindu-esports.apk ../public/hindu-esports.apk
```

Steps inside the script: icons from the website logo (`tools/make_icons.py`) -> `javac` -> `dx` -> `aapt2 compile/link` ->
`tools/assemble.py` (adds `classes.dex`, 4-byte alignment) -> `SignApk sign` (v1+v2+v3) -> `SignApk verify` and
`tools/checkzip.py`.

Change the address in `LauncherActivity.java` (`START_URL`, `SITE_HOST`) **and** in `AndroidManifest.xml`
(the `android:host` of the second intent filter) if the website ever moves to another domain.

## Do not "tidy" the TX_* numbers in LauncherActivity.java

The launcher talks to Chrome's Custom Tabs service by hand. A call is sent as `IBinder.FIRST_CALL_TRANSACTION` (1) plus
the number written next to the method in Google's `ICustomTabsService.aidl` / `ICustomTabsCallback.aidl`
(`warmup = 1`, `newSession = 2`, `extraCallbackWithResult = 6`), i.e. 2, 3 and 7 on the wire. Version 1.0 sent 1, 2 and 6 and
asked Chrome for different calls than intended, so it could not set up the full-screen session properly (at best the site
opened with a browser bar). Fixed in 1.1.

## Versions

| versionName | versionCode | change |
|---|---|---|
| 1.0 | 1 | first release (could not start the full-screen session, see above) |
| 1.1 | 2 | correct Chrome call numbers; waits up to 10 s for Chrome to wake up before using the fallback |
