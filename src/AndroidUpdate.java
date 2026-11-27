package com.showremote.demo;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Comparator;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

final class AndroidUpdate {
    private static final String ROOT =
        "https://raw.githubusercontent.com/Life-Anglican-Church/LifeShow/android-downloads/updates/";
    private static final long MAX_APK_BYTES = 32L * 1024 * 1024;
    private static final int MAX_MANIFEST_BYTES = 4096;
    static final String APK_MIME = "application/vnd.android.package-archive";
    static final String VERIFIED_NAME = "verified-[0-9]{1,10}\\.apk";

    static final class Manifest {
        final long versionCode;
        final String versionName;
        final String apk;
        final String sha256;

        private Manifest(long versionCode, String versionName, String apk, String sha256) {
            this.versionCode = versionCode;
            this.versionName = versionName;
            this.apk = apk;
            this.sha256 = sha256;
        }

        static Manifest parse(String raw, long installedCode) throws JSONException {
            JSONObject json = new JSONObject(raw);
            Object rawCode = json.get("versionCode");
            if (!(rawCode instanceof Integer || rawCode instanceof Long)) {
                throw new JSONException("Invalid version code");
            }
            long code = ((Number) rawCode).longValue();
            String version = json.getString("versionName");
            String file = json.getString("apk");
            String digest = json.getString("sha256");
            if (code <= installedCode || code > Integer.MAX_VALUE
                    || !version.matches("[0-9]{1,4}\\.[0-9]{1,4}(?:\\.[0-9]{1,4})?(?:-beta(?:[.-][0-9]{1,4})?)?")
                    || !file.equals("lifeshow-" + version + ".apk") || !digest.matches("[0-9a-f]{64}")) return null;
            return new Manifest(code, version, file, digest);
        }

        String serialize() {
            try {
                return new JSONObject().put("versionCode", versionCode).put("versionName", versionName)
                    .put("apk", apk).put("sha256", sha256).toString();
            } catch (JSONException error) {
                throw new IllegalStateException(error);
            }
        }
    }

    private final OkHttpClient http = new OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(4, TimeUnit.SECONDS).readTimeout(12, TimeUnit.SECONDS)
        .callTimeout(60, TimeUnit.SECONDS).build();
    private final OkHttpClient manifestHttp = http.newBuilder().callTimeout(5, TimeUnit.SECONDS).build();

    static File stagingDirectory(Context context) {
        return new File(context.getCacheDir(), "android-update");
    }

    static void cleanInstalled(Context context, long installed) {
        File[] files = stagingDirectory(context).listFiles();
        if (files == null) return;
        for (File file : files) {
            String name = file.getName();
            if (name.matches(VERIFIED_NAME) && Long.parseLong(name.substring(9, name.length() - 4)) <= installed) {
                file.delete();
            }
        }
    }

    static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    Manifest check(long installedCode) throws IOException, JSONException {
        Request request = request("latest-android.json");
        try (Response response = manifestHttp.newCall(request).execute()) {
            ResponseBody body = requireBody(response, MAX_MANIFEST_BYTES);
            try (InputStream input = body.byteStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[512];
                for (int count; (count = input.read(buffer)) != -1;) {
                    if (output.size() + count > MAX_MANIFEST_BYTES) throw new IOException("Update manifest too large.");
                    output.write(buffer, 0, count);
                }
                return Manifest.parse(new String(output.toByteArray(), StandardCharsets.UTF_8), installedCode);
            }
        }
    }

    File downloadAndVerify(Context context, Manifest update) throws Exception {
        File directory = stagingDirectory(context);
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Update storage is unavailable.");
        File candidate = File.createTempFile("download-", ".apk", directory);
        try {
            download(candidate, update);
            verifyPackage(context, candidate, update.versionCode);
            File staged = new File(directory, "verified-" + update.versionCode + ".apk");
            Files.move(candidate.toPath(), staged.toPath(), StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING);
            return staged;
        } finally {
            candidate.delete();
        }
    }

    void cancel() {
        http.dispatcher().cancelAll();
    }

    private static Request request(String name) {
        return new Request.Builder().url(ROOT + name).header("Cache-Control", "no-cache").build();
    }

    private static ResponseBody requireBody(Response response, long limit) throws IOException {
        ResponseBody body = response.body();
        if (!response.isSuccessful() || body == null) throw new IOException("Download unavailable.");
        if (body.contentLength() > limit) throw new IOException("Download is too large.");
        return body;
    }

    private void download(File candidate, Manifest update) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (Response response = http.newCall(request(update.apk)).execute()) {
            ResponseBody body = requireBody(response, MAX_APK_BYTES);
            try (InputStream input = body.byteStream(); FileOutputStream output = new FileOutputStream(candidate)) {
                byte[] buffer = new byte[16384];
                long total = 0;
                for (int count; (count = input.read(buffer)) != -1;) {
                    total += count;
                    if (total > MAX_APK_BYTES) throw new IOException("APK exceeds the update size limit.");
                    digest.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                }
            }
        }
        byte[] expected = new byte[32];
        for (int i = 0; i < expected.length; i++) {
            expected[i] = (byte) Integer.parseInt(update.sha256.substring(2 * i, 2 * i + 2), 16);
        }
        if (!MessageDigest.isEqual(expected, digest.digest())) throw new IOException("APK checksum did not match.");
    }

    private static Signature[] signers(PackageInfo info) {
        if (Build.VERSION.SDK_INT < 28) return info.signatures;
        return info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners();
    }

    private static void verifyPackage(Context context, File candidate, long expectedCode) throws Exception {
        PackageManager manager = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo installed = manager.getPackageInfo(context.getPackageName(), flags);
        PackageInfo archive = manager.getPackageArchiveInfo(candidate.getAbsolutePath(), flags);
        if (archive == null || !context.getPackageName().equals(archive.packageName)
                || versionCode(archive) != expectedCode || versionCode(installed) >= expectedCode) {
            throw new IOException("APK package or version did not match.");
        }
        Signature[] before = signers(installed);
        Signature[] after = signers(archive);
        if (before == null || before.length == 0 || after == null) {
            throw new IOException("APK signing certificate was unavailable.");
        }
        Comparator<Signature> order = Comparator.comparing(Signature::toCharsString);
        Arrays.sort(before, order);
        Arrays.sort(after, order);
        if (!Arrays.equals(before, after)) throw new IOException("APK signing certificate did not match.");
    }
}
