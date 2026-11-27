package com.showremote.demo;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.ConnectionPool;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

public final class MainActivity extends Activity {
    private static final String APP_URL = "file:///android_asset/index.html";
    private final ExecutorService network = Executors.newFixedThreadPool(3);
    private final OkHttpClient http = new OkHttpClient.Builder()
        .retryOnConnectionFailure(false)
        .followRedirects(false)
        .followSslRedirects(false)
        .addNetworkInterceptor(chain -> {
            Response result = chain.proceed(chain.request());
            // OkHttp can follow a 503 with Retry-After: 0 even when connection retries are off.
            return result.code() == 503 ? result.newBuilder().removeHeader("Retry-After").build() : result;
        })
        .connectionPool(new ConnectionPool(0, 1, TimeUnit.SECONDS))
        .callTimeout(3, TimeUnit.SECONDS)
        .build();
    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView webView;
    private LogoCommand logoCommand;
    private boolean foreground;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout content = new FrameLayout(this);
        content.setBackgroundColor(0xff15110f);
        content.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        webView = new WebView(this);
        webView.setBackgroundColor(0xff15110f);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowContentAccess(false);
        webView.getSettings().setAllowFileAccess(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !APP_URL.equals(request.getUrl().toString());
            }
        });
        webView.addJavascriptInterface(new NetworkBridge(), "LifeShowNative");
        content.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(content);
        webView.loadUrl(APP_URL);
    }

    @Override
    protected void onResume() {
        super.onResume();
        foreground = true;
    }

    @Override
    protected void onPause() {
        foreground = false;
        if (logoCommand != null) logoCommand.cancel();
        webView.evaluateJavascript("window.pauseLifeShow && window.pauseLifeShow()", null);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        http.dispatcher().cancelAll();
        network.shutdownNow();
        webView.removeJavascriptInterface("LifeShowNative");
        webView.destroy();
        super.onDestroy();
    }

    private void respond(int requestId, int code, String body) {
        if (!isDestroyed()) {
            webView.evaluateJavascript("window.receiveLifeShow(" + requestId + "," + code + ","
                + JSONObject.quote(body) + ")", null);
        }
    }

    private final class LogoCommand extends WebSocketListener {
        private final int requestId;
        private final Runnable timeout = () -> failed("PP7 Remote timed out.");
        private WebSocket socket;
        private boolean sent;

        private LogoCommand(int requestId) {
            this.requestId = requestId;
        }

        void start(HttpUrl address, String password) throws JSONException {
            String authentication = new JSONObject()
                .put("action", "authenticate")
                .put("protocol", "701")
                .put("password", password)
                .toString();
            socket = http.newWebSocket(new Request.Builder().url(address).build(), this);
            // Authentication is sent only from onOpen, after the upgrade succeeds.
            authMessage = authentication;
            main.postDelayed(timeout, 3500);
        }

        private String authMessage;

        @Override
        public void onOpen(WebSocket ws, Response response) {
            main.post(() -> {
                if (logoCommand != this) return;
                if (!ws.send(authMessage)) failed("PP7 Remote could not send authentication.");
                authMessage = null;
            });
        }

        @Override
        public void onMessage(WebSocket ws, String text) {
            main.post(() -> {
                if (logoCommand != this || sent) return;
                try {
                    JSONObject reply = new JSONObject(text);
                    if (!"authenticate".equals(reply.optString("action"))) return;
                    if (!"1".equals(reply.optString("authenticated"))
                            || !"1".equals(reply.optString("controller"))) {
                        failed("PP7 Remote rejected controller authentication.");
                        return;
                    }
                    if (!foreground || !ws.send("{\"action\":\"clearToLogo\"}")) {
                        failed("PP7 Remote could not send Clear to Logo.");
                        return;
                    }
                    sent = true;
                    ws.close(1000, null);
                } catch (JSONException error) {
                    failed("PP7 Remote returned an unexpected response.");
                }
            });
        }

        @Override
        public void onClosing(WebSocket ws, int code, String reason) {
            ws.close(1000, null);
        }

        @Override
        public void onClosed(WebSocket ws, int code, String reason) {
            main.post(() -> {
                if (sent && code == 1000) finish(202, "");
                else failed("PP7 Remote closed the connection.");
            });
        }

        @Override
        public void onFailure(WebSocket ws, Throwable error, Response response) {
            main.post(() -> failed("Could not complete the PP7 Remote connection. Check its port and Controller settings."));
        }

        void cancel() {
            failed("Clear to Logo cancelled.");
        }

        void failed(String message) {
            finish(sent ? 0 : 422, message);
        }

        private void finish(int code, String message) {
            if (logoCommand != this) return;
            logoCommand = null;
            authMessage = null;
            main.removeCallbacks(timeout);
            if (code != 202 && socket != null) socket.cancel();
            respond(requestId, code, message);
        }
    }

    private final class NetworkBridge {
        @JavascriptInterface
        public void clearToLogo(int requestId, String address, int port, String password) {
            main.post(() -> {
                HttpUrl server = HttpUrl.parse(address);
                if (!foreground || logoCommand != null || server == null
                        || !server.username().isEmpty() || !server.password().isEmpty()
                        || port < 1 || port > 65535 || password == null || password.isEmpty()) {
                    respond(requestId, 422, "Check the PP7 Remote port and Controller password.");
                    return;
                }
                LogoCommand command = new LogoCommand(requestId);
                logoCommand = command;
                try {
                    command.start(server.newBuilder().port(port).encodedPath("/remote").build(), password);
                } catch (JSONException | RuntimeException error) {
                    command.failed("Could not start the PP7 Remote connection.");
                }
            });
        }

        @JavascriptInterface
        public void cancelLogo() {
            main.post(() -> {
                if (logoCommand != null) logoCommand.cancel();
            });
        }

        @JavascriptInterface
        public void get(int requestId, String address, String path) {
            network.execute(() -> {
                int code = 0;
                String body;
                try {
                    HttpUrl server = HttpUrl.parse(address);
                    if (server == null || !server.username().isEmpty() || !server.password().isEmpty()
                            || !server.encodedPath().equals("/") || server.query() != null
                            || server.fragment() != null || !path.matches("/(?:version|v1/[a-zA-Z0-9_/%.-]+)")
                            || path.contains("..")) {
                        throw new IOException("Enter a ProPresenter HTTP address and port.");
                    }
                    HttpUrl url = server.newBuilder().encodedPath(path).build();
                    Request request = new Request.Builder().url(url)
                        .header("Accept", "application/json")
                        .header("Connection", "close")
                        .header("Cache-Control", "no-store")
                        .get().build();
                    try (Response response = http.newCall(request).execute()) {
                        code = response.code();
                        body = response.body() == null ? "" : response.body().string();
                    }
                } catch (IOException | RuntimeException error) {
                    body = error.getMessage() == null ? "Connection failed" : error.getMessage();
                }
                final int responseCode = code;
                final String responseBody = body;
                runOnUiThread(() -> respond(requestId, responseCode, responseBody));
            });
        }
    }
}
