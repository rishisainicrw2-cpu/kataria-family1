#!/usr/bin/env bash
# Builds and signs the HINDU ESPORTS Android app (a Trusted Web Activity launcher) without Gradle or the Android SDK.
#
#   javac (JDK)  ->  old "dx" (class files -> dex)  ->  aapt2 (resources + manifest)  ->  tools/assemble.py (add dex,
#   4-byte align)  ->  apksig (sign with v1 + v2 + v3)  ->  checks.      Output: build/hindu-esports.apk
#
# Needed (all can be overridden with environment variables, see below):
#   AAPT2        aapt2 binary                                  ANDROID_JAR  android.jar of API 34
#   DX_CP        folder with the compiled old "dx" classes      SIGN_CP      folder with compiled apksig + tools/SignApk.java
#   KEYSTORE     the private signing key (PKCS12), NEVER in git KEY_ALIAS     alias inside the key file
#   KEY_PASS     its password (or KEY_PASS_FILE = a file that contains it)
#   VERSION_CODE / VERSION_NAME   raise VERSION_CODE every time a new APK must replace an installed one
set -euo pipefail
cd "$(dirname "$0")"

TOOLS=${TOOLS:-/tmp/work}
AAPT2=${AAPT2:-$TOOLS/apktool/brut.apktool/apktool-lib/src/main/resources/prebuilt/linux/aapt2}
ANDROID_JAR=${ANDROID_JAR:-$TOOLS/platforms/android-34/android.jar}
DX_CP=${DX_CP:-$TOOLS/dxout}
SIGN_CP=${SIGN_CP:-$TOOLS/apksigout}
KEYSTORE=${KEYSTORE:-$TOOLS/keys-h/hinduesports.p12}
KEY_ALIAS=${KEY_ALIAS:-hinduesports}
KEY_PASS_FILE=${KEY_PASS_FILE:-$TOOLS/keys-h/password.txt}
KEY_PASS=${KEY_PASS:-$(cat "$KEY_PASS_FILE")}
VERSION_CODE=${VERSION_CODE:-3}
VERSION_NAME=${VERSION_NAME:-1.2}
QUIET='^Picked up'

rm -rf build && mkdir -p build/classes build/flat

echo "== 1. icons from the website logo + resources copy"
cp -r res build/res
python3 -I tools/make_icons.py ../public/assets build/res

echo "== 2. check the 'wait for the sleeping server to wake up' logic on plain Java first (no phone needed)"
mkdir -p build/wake-test
javac -nowarn -d build/wake-test \
  src/com/hinduesports/clan/ServerWake.java test/com/hinduesports/clan/WakeTest.java 2>&1 | { grep -v "$QUIET" || true; }
java -cp build/wake-test com.hinduesports.clan.WakeTest

echo "== 3. compile Java (for the phone)"
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$ANDROID_JAR" -d build/classes \
  src/com/hinduesports/clan/LauncherActivity.java src/com/hinduesports/clan/ServerWake.java 2>&1 | { grep -v "$QUIET" || true; }

echo "== 4. class files -> classes.dex (the old dx tool only reads class-file version <= 50)"
python3 -I - <<'EOF'
import os, struct
for root, _, files in os.walk('build/classes'):
    for f in files:
        if f.endswith('.class'):
            p = os.path.join(root, f)
            b = bytearray(open(p, 'rb').read())
            b[6:8] = struct.pack('>H', 50)
            open(p, 'wb').write(b)
EOF
java -cp "$DX_CP" com.android.dx.command.Main --dex --output=build/classes.dex build/classes 2>&1 | { grep -v "$QUIET" || true; }
test -s build/classes.dex

echo "== 5. resources + manifest (aapt2)"
"$AAPT2" compile --dir build/res -o build/flat
"$AAPT2" link -o build/resources.apk -I "$ANDROID_JAR" --manifest AndroidManifest.xml \
  --min-sdk-version 24 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  --compile-sdk-version-code 34 --compile-sdk-version-name 14 build/flat/*.flat

echo "== 6. add classes.dex + 4-byte alignment"
python3 -I tools/assemble.py build/resources.apk build/classes.dex build/app-unsigned.apk

echo "== 7. sign (v1 + v2 + v3) and verify"
java -cp "$SIGN_CP" SignApk sign build/app-unsigned.apk build/hindu-esports.apk "$KEYSTORE" "$KEY_ALIAS" "$KEY_PASS" 24 2>&1 | { grep -v "$QUIET" || true; }
java -cp "$SIGN_CP" SignApk verify build/hindu-esports.apk 2>&1 | { grep -v "$QUIET" || true; }
"$AAPT2" dump badging build/hindu-esports.apk | head -3
python3 -I tools/checkzip.py build/hindu-esports.apk | tail -1
ls -la build/hindu-esports.apk
