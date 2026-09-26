package com.wxk.riji;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import java.util.Calendar;

/**
 * 每日自查提醒的定时管理。
 *
 * 用 setInexactRepeating 而不是 setExactAndAllowWhileIdle：
 *   - 不需要 SCHEDULE_EXACT_ALARM 权限（那是个敏感权限，还得让用户去系统设置里开）
 *   - 每天一次的提醒，差几分钟完全无所谓，换来的是免权限、省电、各版本都稳
 */
final class ReminderScheduler {

    private static final String PREF = "riji_reminder";
    private static final String K_ON = "on";
    private static final String K_H = "hour";
    private static final String K_M = "minute";
    private static final String K_TITLE = "title";
    private static final String K_BODY = "body";
    private static final int REQUEST_CODE = 1001;
    private static final int DEFAULT_H = 21;

    private ReminderScheduler() {
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    static boolean isOn(Context c) {
        return prefs(c).getBoolean(K_ON, false);
    }

    static int hour(Context c) {
        return prefs(c).getInt(K_H, DEFAULT_H);
    }

    static int minute(Context c) {
        return prefs(c).getInt(K_M, 0);
    }

    /**
     * 通知文案由网页传过来：应用内的语言是用户自己选的，
     * 跟系统语言不一定一致，原生这边没法猜。
     * 存进 SharedPreferences 是因为闹钟触发时应用可能根本没在运行。
     */
    static String title(Context c) {
        return prefs(c).getString(K_TITLE, null);
    }

    static String body(Context c) {
        return prefs(c).getString(K_BODY, null);
    }

    /** hhmm 形如 "21:00"；解析失败就退回 21:00 */
    static void schedule(Context c, String hhmm, String title, String body) {
        int h = DEFAULT_H, m = 0;
        try {
            String[] p = hhmm.split(":");
            h = Math.max(0, Math.min(23, Integer.parseInt(p[0].trim())));
            m = Math.max(0, Math.min(59, Integer.parseInt(p[1].trim())));
        } catch (Exception ignored) {
        }
        SharedPreferences.Editor ed = prefs(c).edit();
        if (title != null && !title.isEmpty()) ed.putString(K_TITLE, title);
        if (body != null && !body.isEmpty()) ed.putString(K_BODY, body);
        ed.apply();
        schedule(c, h, m);
    }

    static void schedule(Context c, int h, int m) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        prefs(c).edit().putBoolean(K_ON, true).putInt(K_H, h).putInt(K_M, m).apply();

        PendingIntent pi = pending(c);
        if (pi == null) return;
        am.cancel(pi);

        Calendar next = Calendar.getInstance();
        next.set(Calendar.HOUR_OF_DAY, h);
        next.set(Calendar.MINUTE, m);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        if (next.getTimeInMillis() <= System.currentTimeMillis()) {
            next.add(Calendar.DAY_OF_YEAR, 1);   // 今天这个点已经过了，从明天开始
        }

        am.setInexactRepeating(AlarmManager.RTC_WAKEUP,
                next.getTimeInMillis(), AlarmManager.INTERVAL_DAY, pi);
    }

    static void cancel(Context c) {
        prefs(c).edit().putBoolean(K_ON, false).apply();
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = pending(c);
        if (am != null && pi != null) am.cancel(pi);
    }

    /** 开机 / 应用重进时补排一次，防止系统清掉定时 */
    static void rescheduleIfNeeded(Context c) {
        if (isOn(c)) schedule(c, hour(c), minute(c));
    }

    private static PendingIntent pending(Context c) {
        Intent i = new Intent(c, ReminderReceiver.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(c, REQUEST_CODE, i, flags);
    }
}
