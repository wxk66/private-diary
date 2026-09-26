package com.wxk.riji;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.OutputStream;

/**
 * 私密日志 · 安卓外壳
 *
 * 把 assets 里的单页应用用 WebView 全屏跑起来。业务逻辑与数据都在网页里，原生层只补
 * 网页做不到的三件事：
 *
 *   1. 导出备份 —— WebView 不会自己处理 blob: 下载链接，网页点「导出」在这里会毫无反应。
 *      改成网页把 JSON 交给原生，走 SAF（ACTION_CREATE_DOCUMENT）让用户选保存位置。
 *   2. 导入备份 —— <input type="file"> 需要宿主实现 onShowFileChooser，否则同样点了没反应。
 *   3. 每日提醒 —— 网页没有后台能力，用 AlarmManager 定时 + 通知栏提醒，关掉应用也会响。
 *
 * 权限：只申请 POST_NOTIFICATIONS（且只在用户真的开启每日提醒时才弹窗请求）
 * 和 RECEIVE_BOOT_COMPLETED（开机后恢复定时）。依旧不联网、不读写外部存储
 * —— SAF 由用户自己选位置，不需要存储权限。
 */
public class MainActivity extends Activity {

    private static final String START_URL = "file:///android_asset/index.html";
    private static final int FALLBACK_BG = 0xFFF3F4F8;

    private static final int REQ_CREATE_DOC = 1001;
    private static final int REQ_PICK_FILE = 1002;
    private static final int REQ_NOTIF_PERM = 1003;

    private WebView web;
    private ValueCallback<Uri[]> filePathCallback;

    /* 导出是「先发起 Intent，用户选完位置再回来写」，所以内容要先存着 */
    private String pendingExportContent;

    /* 通知权限是异步的，授权回来后再真正排定时 */
    private boolean pendingNotifEnable;
    private String pendingNotifTime = "21:00";
    private String pendingNotifTitle;
    private String pendingNotifBody;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);        // localStorage：记录就存在这里
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);          // 读 file:///android_asset
        s.setAllowContentAccess(true);
        // 允许双指缩放：网页那边已经去掉了 user-scalable=no，
        // 原生这层也不能把它关死，否则视力不好的用户没法放大看
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);     // 不要那两个丑的悬浮缩放按钮
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMediaPlaybackRequiresUserGesture(true);

        web.setBackgroundColor(FALLBACK_BG);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript(THEME_SYNC_JS, null);
            }
        });
        // window.confirm() 必须由宿主弹窗实现；不设 WebChromeClient 时 WebView 直接返回 false，
        // 页面里所有「删除/关锁/导入/清空」的确认分支就永远进不去
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setCancelable(true)
                        .setPositiveButton("确定", new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                result.confirm();
                            }
                        })
                        .setNegativeButton("取消", new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                result.cancel();
                            }
                        })
                        .setOnCancelListener(new DialogInterface.OnCancelListener() {
                            @Override
                            public void onCancel(DialogInterface dialog) {
                                result.cancel();
                            }
                        })
                        .show();
                return true;
            }

            /** <input type="file"> 的宿主实现，缺了它「从备份恢复」就是死按钮 */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "选择备份文件"), REQ_PICK_FILE);
                } catch (ActivityNotFoundException e) {
                    filePathCallback = null;
                    uiToast("toast.noPicker", null);
                    return false;
                }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "RijiNative");

        FrameLayout root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        applyBars(FALLBACK_BG);
        web.loadUrl(START_URL);

        // 开机或应用被系统回收后再进来，定时可能已经丢了，这里补一次
        ReminderScheduler.rescheduleIfNeeded(this);
    }

    /** 网页加载完注入一小段只读脚本：主题一变就把背景色同步给状态栏/导航栏 */
    private static final String THEME_SYNC_JS =
            "(function(){try{"
            + "function push(){"
            + "var cs=getComputedStyle(document.documentElement);"
            + "var bg=(cs.getPropertyValue('--bg')||'').trim();"
            + "if(!bg&&cs.backgroundColor)bg=cs.backgroundColor;"
            + "if(bg&&window.RijiNative&&RijiNative.setSystemBarColor)RijiNative.setSystemBarColor(bg);"
            + "}"
            + "push();"
            + "new MutationObserver(push).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','style']});"
            + "}catch(e){}})();";

    /* ================= 网页调用原生的桥 =================
       @JavascriptInterface 的方法跑在 JavaBridge 线程上，
       凡是碰 UI（Intent / Toast / 权限请求）都必须先 runOnUiThread。 */
    private class Bridge {

        @JavascriptInterface
        public void setSystemBarColor(final String cssColor) {
            final int c = parseColor(cssColor);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    applyBars(c);
                }
            });
        }

        /** 导出备份：把 JSON 交给原生，走系统「保存到…」界面 */
        @JavascriptInterface
        public void exportBackup(final String filename, final String content) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (content == null || content.isEmpty()) {
                        uiToast("toast.exportEmpty", null);
                        return;
                    }
                    pendingExportContent = content;
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("application/json");
                    i.putExtra(Intent.EXTRA_TITLE,
                            (filename == null || filename.isEmpty()) ? "backup.json" : filename);
                    try {
                        startActivityForResult(i, REQ_CREATE_DOC);
                    } catch (ActivityNotFoundException e) {
                        pendingExportContent = null;
                        uiToast("toast.noSaver", null);
                    }
                }
            });
        }

        /**
         * 每日自查提醒：交给 AlarmManager，应用没开着也会响。
         * title / body 由网页传进来 —— 应用内的语言是用户自己选的，原生猜不到。
         */
        @JavascriptInterface
        public void setDailyReminder(final boolean on, final String hhmm,
                                     final String title, final String body) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    applyDailyReminder(on, hhmm, title, body);
                }
            });
        }
    }

    private void applyDailyReminder(boolean on, String hhmm, String title, String body) {
        pendingNotifEnable = on;
        if (hhmm != null && hhmm.length() >= 4) pendingNotifTime = hhmm;
        if (title != null && !title.isEmpty()) pendingNotifTitle = title;
        if (body != null && !body.isEmpty()) pendingNotifBody = body;
        if (!on) {
            ReminderScheduler.cancel(this);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                   != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF_PERM);
            return;
        }
        ReminderScheduler.schedule(this, pendingNotifTime, pendingNotifTitle, pendingNotifBody);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_NOTIF_PERM) {
            boolean granted = grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted && pendingNotifEnable) {
                ReminderScheduler.schedule(this, pendingNotifTime, pendingNotifTitle, pendingNotifBody);
            }
            // 提示语交回网页去显示 —— 应用内的语言是用户自己选的，原生写死的文案会跟界面语言对不上
            callJs("window.__dyf&&window.__dyf.onNotifPerm&&window.__dyf.onNotifPerm("
                   + (granted ? "true" : "false") + ")");
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    private void callJs(final String js) {
        if (web == null) return;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web != null) web.evaluateJavascript(js, null);
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_CREATE_DOC) {
            String content = pendingExportContent;
            pendingExportContent = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && content != null) {
                writeTo(data.getData(), content);
            }
            return;
        }
        if (requestCode == REQ_PICK_FILE) {
            if (filePathCallback != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null) {
                    result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                }
                filePathCallback.onReceiveValue(result);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private void writeTo(Uri uri, String content) {
        OutputStream os = null;
        try {
            os = getContentResolver().openOutputStream(uri);
            if (os == null) throw new IllegalStateException("cannot open output stream");
            os.write(content.getBytes("UTF-8"));
            os.flush();
            uiToast("toast.exported", null);
        } catch (Exception e) {
            uiToast("toast.exportFailGeneric", null);
        } finally {
            try {
                if (os != null) os.close();
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * 提示语统一交回网页去显示。
     * 应用内的语言是用户自己选的，原生这边写死中文会跟界面语言对不上；
     * 网页没就绪时退化成原生 Toast，至少不会完全没反馈。
     */
    private void uiToast(String key, String param) {
        if (web != null) {
            callJs("window.__dyf&&window.__dyf.toastKey&&window.__dyf.toastKey('"
                   + key + "'," + (param == null ? "null" : "'" + param.replace("'", "") + "'") + ")");
            return;
        }
        Toast.makeText(this, "Private Journal", Toast.LENGTH_SHORT).show();
    }

    private static int parseColor(String css) {
        try {
            String v = css == null ? "" : css.trim();
            if (v.startsWith("#")) {
                if (v.length() == 4) {   // #abc -> #aabbcc
                    StringBuilder sb = new StringBuilder("#");
                    for (int i = 1; i < 4; i++) sb.append(v.charAt(i)).append(v.charAt(i));
                    v = sb.toString();
                }
                return Color.parseColor(v.length() >= 7 ? v.substring(0, 7) : v);
            }
            if (v.startsWith("rgb")) return Color.parseColor(v);
        } catch (Exception ignored) {
        }
        return FALLBACK_BG;
    }

    /** 状态栏与导航栏跟网页背景同色，并按明暗自动切换图标颜色 */
    @SuppressWarnings("deprecation")
    private void applyBars(int color) {
        if (getWindow() == null) return;
        getWindow().setStatusBarColor(color);
        getWindow().setNavigationBarColor(color);

        double lum = 0.299 * Color.red(color) + 0.587 * Color.green(color) + 0.114 * Color.blue(color);
        boolean lightBg = lum > 160;   // 浅底 -> 需要深色图标
        View decor = getWindow().getDecorView();
        int flags = decor.getSystemUiVisibility();
        if (lightBg) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
        } else {
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        decor.setSystemUiVisibility(flags);
    }

    /**
     * 返回键：先关掉打开着的记录弹层；隐私锁界面下不退出（避免绕过锁）；
     * 其余情况才真正退出应用。
     */
    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript(
                "(function(){try{"
                + "var s=document.getElementById('sheet');"
                + "if(s&&!s.hidden){var m=document.getElementById('sheetMask');"
                + "if(m){m.click();return 1;}}"
                + "var l=document.getElementById('lockScreen');"
                + "if(l&&!l.hidden){return 2;}"
                + "return 0;}catch(e){return 0;}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        String v = value == null ? "" : value.replace("\"", "").trim();
                        if ("1".equals(v) || "2".equals(v)) return;   // 已处理
                        finish();
                    }
                });
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("RijiNative");
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
