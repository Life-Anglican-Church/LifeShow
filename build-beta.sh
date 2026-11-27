#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${ANDROID_BUILD_TOOLS:?Set ANDROID_BUILD_TOOLS to the Android build tools directory}"
: "${ANDROID_JAR:?Set ANDROID_JAR to the Android platform jar}"
: "${ECJ_JAR:?Set ECJ_JAR to the Eclipse Java compiler jar}"
: "${OKHTTP_JAR:?Set OKHTTP_JAR to the OkHttp 3.14.9 jar}"
: "${OKIO_JAR:?Set OKIO_JAR to the Okio 1.17.2 jar}"
: "${LIFESHOW_KEYSTORE:?Set LIFESHOW_KEYSTORE to the signing keystore}"
: "${LIFESHOW_STORE_PASSWORD:?Set LIFESHOW_STORE_PASSWORD to the signing keystore password}"
out=$(realpath -m "${1:?Pass the output APK path}")
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
bt=$ANDROID_BUILD_TOOLS
mkdir -p "$build/classes" "$build/dex" "$(dirname "$out")"
java -jar "$ECJ_JAR" -proc:none -source 8 -target 8 \
  -classpath "$ANDROID_JAR:$OKHTTP_JAR:$OKIO_JAR" -d "$build/classes" src/MainActivity.java
(cd "$build/classes" && zip -q -r "$build/classes.jar" .)
"$bt/d8" --lib "$ANDROID_JAR" --min-api 26 --output "$build/dex" \
  "$build/classes.jar" "$OKHTTP_JAR" "$OKIO_JAR"
"$bt/aapt2" compile --no-crunch --dir res -o "$build/resources.zip"
"$bt/aapt2" link -I "$ANDROID_JAR" --manifest AndroidManifest.xml -A assets \
  "$build/resources.zip" -o "$build/unsigned.apk"
(cd "$build/dex" && zip -q "$build/unsigned.apk" classes*.dex)
"$bt/zipalign" -f 4 "$build/unsigned.apk" "$build/aligned.apk"
"$bt/apksigner" sign --ks "$LIFESHOW_KEYSTORE" --ks-pass env:LIFESHOW_STORE_PASSWORD \
  --v4-signing-enabled false --out "$build/signed.apk" "$build/aligned.apk"
"$bt/apksigner" verify "$build/signed.apk"
install -m 644 "$build/signed.apk" "$out"
