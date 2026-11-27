package com.showremote.demo;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Toast;

import java.io.File;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONException;

final class UpdateController {
    private static final int INSTALL_PERMISSION = 4810;
    private static final String PENDING_PERMISSION = "lifeShow.pendingUpdatePermission";
    private static final String CHECKED = "lifeShow.updateChecked";

    private final Activity activity;
    private final AndroidUpdate updater = new AndroidUpdate();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private long installedCode;
    private boolean foreground;
    private boolean closed;
    private AndroidUpdate.Manifest offer;
    private AndroidUpdate.Manifest pendingPermission;
    private File verified;
    private String failure;
    private AlertDialog dialog;

    UpdateController(Activity activity) {
        this.activity = activity;
    }

    void start(Bundle saved) {
        try {
            installedCode = AndroidUpdate.versionCode(
                activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0));
        } catch (android.content.pm.PackageManager.NameNotFoundException error) {
            return;
        }
        try {
            if (saved != null && saved.containsKey(PENDING_PERMISSION)) {
                pendingPermission = AndroidUpdate.Manifest.parse(saved.getString(PENDING_PERMISSION), installedCode);
            }
        } catch (JSONException ignored) {
            pendingPermission = null;
        }
        if (saved != null && saved.getBoolean(CHECKED)) return;
        worker.execute(() -> {
            AndroidUpdate.cleanInstalled(activity, installedCode);
            try {
                AndroidUpdate.Manifest available = updater.check(installedCode);
                activity.runOnUiThread(() -> {
                    if (closed) return;
                    offer = available;
                    present();
                });
            } catch (IOException | JSONException ignored) {
                // The startup check is optional and never blocks the app.
            }
        });
    }

    void save(Bundle state) {
        if (pendingPermission != null) state.putString(PENDING_PERMISSION, pendingPermission.serialize());
        state.putBoolean(CHECKED, true);
    }

    void resume() {
        foreground = true;
        present();
    }

    void pause() {
        foreground = false;
    }

    private void present() {
        if (closed || !foreground || activity.isFinishing() || dialog != null) return;
        if (verified != null) {
            File apk = verified;
            verified = null;
            openInstaller(apk);
        } else if (failure != null) {
            String message = failure;
            failure = null;
            show(new AlertDialog.Builder(activity).setTitle("LifeSHOW update")
                .setMessage(message).setPositiveButton("OK", null));
        } else if (offer != null) {
            AndroidUpdate.Manifest update = offer;
            offer = null;
            show(new AlertDialog.Builder(activity)
                .setTitle("LifeSHOW " + update.versionName + " is available")
                .setMessage("Download and install this update now?")
                .setPositiveButton("Update now", (window, button) -> requestInstallPermission(update))
                .setNegativeButton("Later", null));
        }
    }

    private void show(AlertDialog.Builder builder) {
        dialog = builder.create();
        dialog.setOnDismissListener(window -> {
            dialog = null;
            present();
        });
        dialog.show();
    }

    private void requestInstallPermission(AndroidUpdate.Manifest update) {
        if (activity.getPackageManager().canRequestPackageInstalls()) {
            download(update);
            return;
        }
        pendingPermission = update;
        Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.fromParts("package", activity.getPackageName(), null));
        try {
            activity.startActivityForResult(settings, INSTALL_PERMISSION);
        } catch (ActivityNotFoundException | SecurityException error) {
            pendingPermission = null;
            failure = "Android could not open the install permission screen.";
            present();
        }
    }

    void activityResult(int request) {
        if (request != INSTALL_PERMISSION || pendingPermission == null) return;
        AndroidUpdate.Manifest update = pendingPermission;
        pendingPermission = null;
        if (activity.getPackageManager().canRequestPackageInstalls()) download(update);
        else {
            failure = "Install permission was not granted. LifeSHOW can continue on this version.";
            present();
        }
    }

    private void download(AndroidUpdate.Manifest update) {
        Toast.makeText(activity, "Downloading and verifying LifeSHOW…", Toast.LENGTH_LONG).show();
        worker.execute(() -> {
            try {
                File apk = updater.downloadAndVerify(activity, update);
                activity.runOnUiThread(() -> {
                    if (closed) return;
                    verified = apk;
                    present();
                });
            } catch (Exception error) {
                activity.runOnUiThread(() -> {
                    if (closed) return;
                    failure = "The update could not be downloaded or verified. Try again when you next open LifeSHOW.";
                    present();
                });
            }
        });
    }

    private void openInstaller(File apk) {
        if (!apk.isFile() || !activity.getPackageManager().canRequestPackageInstalls()) {
            failure = "The verified update or install permission is no longer available.";
            present();
            return;
        }
        Uri uri = UpdateFileProvider.uri(activity, apk);
        Intent install = new Intent(Intent.ACTION_INSTALL_PACKAGE)
            .setDataAndType(uri, AndroidUpdate.APK_MIME)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        install.setClipData(ClipData.newRawUri("LifeSHOW update", uri));
        try {
            activity.startActivity(install);
        } catch (ActivityNotFoundException | SecurityException error) {
            failure = "Android could not open its install confirmation.";
            present();
        }
    }

    void close() {
        closed = true;
        if (dialog != null) dialog.dismiss();
        updater.cancel();
        worker.shutdownNow();
    }
}
