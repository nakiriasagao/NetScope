package com.netscope.app;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.SharedPreferences;
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
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * NetScope Android 客户端主界面
 *
 * 设计取舍：本项目是把一整套网络探测能力跑在电脑/服务器上的工具，
 * Android 端不做重复实现，而是一个**专用的 WebView 客户端**：
 *   · 首次启动让用户填写 NetScope 服务地址（例如 http://192.168.1.5:8787）；
 *   · 之后记住地址，直接加载；遇到连不上时给出可操作的提示；
 *   · 顶部提供返回 / 刷新 / 设置三个动作。
 *
 * 这样 APK 体积小、无需在手机上重复实现 ICMP / 局域网扫描等能力，
 * 又能完整使用桌面端的所有功能（含高德底图、局域网拓扑等）。
 */
public class MainActivity extends android.app.Activity {

    static final String PREFS = "netscope";
    static final String KEY_SERVER = "server_url";
    /** 电脑本机的 NetScope 默认端口；Android 模拟器用 10.0.2.2 访问宿主机 */
    static final String DEFAULT_SERVER = "http://10.0.2.2:8787";

    private WebView webView;
    private ProgressBar progressBar;
    private TextView errorView;
    private Button retryButton;
    private LinearLayout errorPanel;
    private FrameLayout rootLayout;
    private String currentUrl;
    private boolean pageFailed = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(Color.parseColor("#0b1220"));

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

        rootLayout.addView(webView);
        rootLayout.addView(progressBar);
        rootLayout.addView(errorPanel);
        setContentView(rootLayout);

        showWelcomeIfNeeded();
        loadServer();
    }

    /** 顶部工具栏（用代码构建，避免引入 AppCompat 依赖） */
    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, R_STRING_RELOAD);
        menu.add(0, 2, 1, R_STRING_SETTINGS);
        menu.add(0, 3, 2, R_STRING_HOME);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        switch (item.getItemId()) {
            case 1:
                pageFailed = false;
                hideError();
                webView.reload();
                return true;
            case 2:
                startActivity(new Intent(this, SettingsActivity.class));
                return true;
            case 3:
                loadServer();
                return true;
            default:
                return super.onOptionsItemSelected(item);
        }
    }

    /** 首次启动时给一句说明，避免用户不知道要填什么 */
    private void showWelcomeIfNeeded() {
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (sp.contains(KEY_SERVER)) return;
        Toast.makeText(this,
                "首次使用：请点右上角菜单 → 设置，填写电脑上 NetScope 的地址（如 http://192.168.1.5:8787）",
                Toast.LENGTH_LONG).show();
    }

    private void loadServer() {
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        String url = sp.getString(KEY_SERVER, DEFAULT_SERVER);
        currentUrl = url;
        pageFailed = false;
        hideError();
        webView.loadUrl(url);
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
        // NetScope 服务通常是 http://内网IP，允许混合内容以便加载高德底图
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
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
                // 站内链接在 WebView 内打开，外部链接交给系统浏览器
                if (url != null && currentUrl != null && url.startsWith(origin(currentUrl))) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) {
                    /* 没有可用浏览器就忽略 */
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                progressBar.setVisibility(View.GONE);
                if (!pageFailed) hideError();
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && request.isForMainFrame()) {
                    pageFailed = true;
                    showError(String.valueOf(error.getDescription()));
                }
            }

            @Override
            public void onReceivedError(WebView v, int errorCode, String description, String failingUrl) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                    pageFailed = true;
                    showError(description);
                }
            }
        });
    }

    private static String origin(String url) {
        try {
            Uri u = Uri.parse(url);
            return u.getScheme() + "://" + u.getAuthority();
        } catch (Exception e) {
            return url;
        }
    }

    /** 连不上时的提示面板：说明原因 + 一键重试 + 一键改地址 */
    private LinearLayout buildErrorPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setBackgroundColor(Color.parseColor("#0b1220"));
        panel.setPadding(48, 48, 48, 48);
        panel.setVisibility(View.GONE);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        panel.setLayoutParams(params);

        errorView = new TextView(this);
        errorView.setTextColor(Color.parseColor("#dbe9ff"));
        errorView.setTextSize(15f);
        errorView.setGravity(Gravity.CENTER);
        panel.addView(errorView);

        retryButton = new Button(this);
        retryButton.setText("重试");
        retryButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                loadServer();
            }
        });
        LinearLayout.LayoutParams btnParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        btnParams.topMargin = 32;
        retryButton.setLayoutParams(btnParams);
        panel.addView(retryButton);

        Button settingsButton = new Button(this);
        settingsButton.setText("修改服务器地址");
        settingsButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(MainActivity.this, SettingsActivity.class));
            }
        });
        panel.addView(settingsButton);

        return panel;
    }

    private void showError(String detail) {
        errorPanel.setVisibility(View.VISIBLE);
        errorView.setText("无法连接到 NetScope 服务\n\n"
                + "当前地址：" + currentUrl + "\n"
                + (detail == null ? "" : "错误信息：" + detail + "\n")
                + "\n请确认：\n"
                + "1. 电脑上 NetScope 已启动；\n"
                + "2. 手机与电脑在同一局域网；\n"
                + "3. 电脑上启动时使用了 --host 0.0.0.0（允许局域网访问）；\n"
                + "4. 地址端口与电脑上显示的一致。");
    }

    private void hideError() {
        errorPanel.setVisibility(View.GONE);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 从设置页返回时，如果地址变了就重新加载
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        String url = sp.getString(KEY_SERVER, DEFAULT_SERVER);
        if (currentUrl != null && !currentUrl.equals(url)) {
            loadServer();
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // 用字符串常量避免额外的 strings 引用（菜单项标题）
    private static final String R_STRING_RELOAD = "刷新";
    private static final String R_STRING_SETTINGS = "设置";
    private static final String R_STRING_HOME = "回到首页";
}
