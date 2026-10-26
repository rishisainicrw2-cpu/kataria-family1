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

## Rebuilding (only needed to change the app name, icon or address)

Needs a JDK, an Android SDK platform (`android.jar`, API 34), `aapt2`, a dex compiler (`d8` or `dx`) and the
[apksig](https://android.googlesource.com/platform/tools/apksig/) library (`tools/SignApk.java` is a small command line
wrapper around it).

```sh
python3 tools/make_icons.py ../public/assets res                 # icons from the website logo
javac -source 8 -target 8 -bootclasspath android.jar -d build/classes src/com/hinduesports/clan/LauncherActivity.java
d8 --release --min-api 24 --lib android.jar --output build build/classes/com/hinduesports/clan/*.class   # -> build/classes.dex
aapt2 compile --dir res -o build/compiled
aapt2 link -o build/resources.apk -I android.jar --manifest AndroidManifest.xml \
     --min-sdk-version 24 --target-sdk-version 34 --version-code 1 --version-name 1.0 build/compiled/*.flat
python3 tools/assemble.py build/resources.apk build/classes.dex build/app-unsigned.apk   # adds classes.dex, 4-byte alignment
java -cp <apksig+SignApk> SignApk sign build/app-unsigned.apk build/app-signed.apk hinduesports.p12 hinduesports <password> 24
java -cp <apksig+SignApk> SignApk verify build/app-signed.apk
python3 tools/checkzip.py build/app-signed.apk
cp build/app-signed.apk ../public/hindu-esports.apk
```

Raise `--version-code` every time a new APK should replace an installed one.
Change the address in `LauncherActivity.java` (`START_URL`, `SITE_HOST`) **and** in `AndroidManifest.xml`
(the `android:host` of the second intent filter) if the website ever moves to another domain.
