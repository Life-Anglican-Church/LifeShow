package com.showremote.demo;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

public final class UpdateFileProvider extends ContentProvider {
    static Uri uri(Context context, File verified) {
        return new Uri.Builder().scheme("content").authority(context.getPackageName() + ".updates")
            .appendPath(verified.getName()).build();
    }

    @Override public boolean onCreate() { return true; }

    private File locate(Uri requested) {
        Context context = getContext();
        String name = requested.getLastPathSegment();
        if (name == null || !name.matches(AndroidUpdate.VERIFIED_NAME)) {
            throw new IllegalArgumentException("Unknown update file.");
        }
        File verified = new File(AndroidUpdate.stagingDirectory(context), name);
        if (!uri(context, verified).equals(requested)) throw new IllegalArgumentException("Unknown update file.");
        return verified;
    }

    @Override public ParcelFileDescriptor openFile(Uri requested, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Update file is read-only.");
        return ParcelFileDescriptor.open(locate(requested), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public Cursor query(Uri requested, String[] projection, String selection, String[] args, String order) {
        File file = locate(requested);
        String[] columns = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        if (file.isFile()) {
            MatrixCursor.RowBuilder row = cursor.newRow();
            for (String column : columns) {
                if (OpenableColumns.DISPLAY_NAME.equals(column)) row.add(file.getName());
                else if (OpenableColumns.SIZE.equals(column)) row.add(file.length());
                else row.add(null);
            }
        }
        return cursor;
    }

    @Override public String getType(Uri requested) { locate(requested); return AndroidUpdate.APK_MIME; }
    @Override public Uri insert(Uri requested, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri requested, ContentValues values, String where, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri requested, String where, String[] args) { throw new UnsupportedOperationException(); }
}
