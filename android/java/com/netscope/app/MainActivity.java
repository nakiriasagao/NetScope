package com.netscope.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import com.netscope.app.core.NetApi;
import com.netscope.app.core.NetHttpd;

import java.util.Map;

/**
 * NetScope 手机端主界面
 *
 * **独立运行**：本应用在手机内部启动一个 HTTP 服务（NetHttpd + NetApi），
 * 探测逻辑完全在本机执行（见 core/Probe.java），WebView 加载
 * http://127.0.0.1:port/ ——因此**不需要电脑、不需要任何外部后端**。
 *
 * 前端页面与桌面版是同一套 public/ 资源（打包在 assets/web/），
 * 所以界面与功能入口完全一致；手机端不具备的能力（如中间路由器 IP、
 * TLS 证书链检查）会在界面上明确说明，而不是伪造数据。
 */
public class MainActivity extends Activity {

    /** 手机端内置服务固定使用这个端口；被占用时会自动顺延 */
    private static final int PREFERRED_PORT = 8787;

    private NetHttpd server;
    private NetApi api;
    private WebView webView;
    private ProgressBar progressBar;
    private LinearLayout errorPanel;
    private TextView errorText;
    private String baseUrl;
    private volatile boolean pageFailed = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0b1220"));

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        configureWebView(webView);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        FrameLayout.LayoutParams pbParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 6);
        pbParams.gravity = Gravity.TOP;
        progressBar.setLayoutParams(pbParams);

        errorPanel = buildErrorPanel();

        root.addView(webView);
        root.addView(progressBar);
        root.addView(errorPanel);
        setContentView(root);

        startLocalServer();
    }

    /** 启动手机内置后端并加载界面 */
    private void startLocalServer() {
        try {
            final NetHttpd[] holder = new NetHttpd[1];
            com.netscope.app.core.ServerInfo info = new com.netscope.app.core.ServerInfo() {
                @Override
                public int getPort() {
                    return holder[0] == null ? PREFERRED_PORT : holder[0].getPort();
                }

                @Override
                public long uptimeSec() {
                    return holder[0] == null ? 0 : holder[0].uptimeSec();
                }

                @Override
                public String startedAtIso() {
                    return holder[0] == null ? "" : holder[0].startedAtIso();
                }
            };
            api = new NetApi(info);
            server = new NetHttpd(new AssetsProvider(this), api);
            holder[0] = server;
            server.start(PREFERRED_PORT);
            baseUrl = "http://127.0.0.1:" + server.getPort();
            webView.loadUrl(baseUrl + "/");
        } catch (Throwable t) {
            showError("内置服务启动失败：" + t.getMessage()
                    + "\n\n请尝试重启应用；若问题依旧，请反馈该提示。");
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(WebView view) {
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            // 页面来自 http://127.0.0.1，加载高德 https 底图属混合内容
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        view.setBackgroundColor(Color.parseColor("#0b1220"));

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int newProgress) {
                progressBar.setProgress(newProgress);
                progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }
        });

        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                if (url == null) return false;
                if (baseUrl != null && url.startsWith(baseUrl)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) {
                    /* 无可用浏览器 */
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                progressBar.setVisibility(View.GONE);
                if (!pageFailed) errorPanel.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && request.isForMainFrame()) {
                    pageFailed = true;
                    showError("界面加载失败：" + error.getDescription());
                }
            }

            @Override
            public void onReceivedError(WebView v, int errorCode, String description, String failingUrl) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                    pageFailed = true;
                    showError("界面加载失败：" + description);
                }
            }
        });
    }

    private LinearLayout buildErrorPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setBackgroundColor(Color.parseColor("#0b1220"));
        panel.setPadding(48, 48, 48, 48);
        panel.setVisibility(View.GONE);
        panel.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        errorText = new TextView(this);
        errorText.setTextColor(Color.parseColor("#dbe9ff"));
        errorText.setTextSize(15f);
        errorText.setGravity(Gravity.CENTER);
        panel.addView(errorText);

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setAllCaps(false);
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                pageFailed = false;
                errorPanel.setVisibility(View.GONE);
                if (server != null && server.isRunning() && baseUrl != null) {
                    webView.loadUrl(baseUrl + "/");
                } else {
                    startLocalServer();
                }
            }
        });
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.topMargin = 32;
        retry.setLayoutParams(p);
        panel.addView(retry);
        return panel;
    }

    private void showError(String message) {
        errorPanel.setVisibility(View.VISIBLE);
        errorText.setText(message);
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, "刷新");
        menu.add(0, 2, 1, "自检");
        menu.add(0, 3, 2, "关于");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        switch (item.getItemId()) {
            case 1:
                if (baseUrl != null) webView.loadUrl(baseUrl + "/");
                return true;
            case 2:
                if (baseUrl != null) webView.loadUrl(baseUrl + "/?selftest=1");
                return true;
            case 3:
                showAbout();
                return true;
            default:
                return super.onOptionsItemSelected(item);
        }
    }

    /** 关于对话框：说明本机独立运行方式与能力边界 */
    private void showAbout() {
        StringBuilder sb = new StringBuilder();
        sb.append("NetScope 手机版 ").append(NetHttpd.VERSION).append("\n\n");
        sb.append("本应用在手机内自带后端服务，探测全部在本机完成，")
                .append("不需要电脑，也不需要联网到任何 NetScope 服务器。\n\n");
        if (server != null) {
            sb.append("内置服务：").append(baseUrl).append("\n");
            sb.append("运行时长：").append(server.uptimeSec()).append(" 秒\n\n");
        }
        sb.append("可用能力：可达性探测、路由追踪（目标与跳数距离）、")
                .append("端口扫描、DNS 解析、公网出口与地理定位、局域网设备发现。\n\n");
        sb.append("平台限制：Android 无 root 时无法读取 ICMP 超时报文的来源地址，")
                .append("因此无法显示中间路由器的 IP；TLS 证书链检查暂未实现。")
                .append("需要完整逐跳拓扑时请使用桌面版 NetScope。");
        new android.app.AlertDialog.Builder(this)
                .setTitle("关于 NetScope")
                .setMessage(sb.toString())
                .setPositiveButton("知道了", null)
                .show();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        // 退出应用时一并关闭内置服务，避免残留线程
        if (server != null) {
            server.stop();
            server = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /** 供设置页读取当前服务地址 */
    public static String serverBaseUrl() {
        return null;
    }

    /** 预留：把高德凭据注入前端（当前由前端自身保存） */
    Map<String, Object> amapCredentials() {
        return api == null ? null : api.amapCredentials();
    }
}
