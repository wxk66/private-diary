package com.wxk.riji;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * 每日自查提醒的接收端。
 *
 * 同时挂在两个广播上：
 *   - 自己排的定时闹钟 -> 弹通知
 *   - 开机完成        -> 重新排定时（系统重启会清掉 AlarmManager 里的所有定时）
 *
 * 文案刻意写成「自查」而不是「该记录了」：这个应用的目的不是催用户多做，
 * 而是提醒回顾一下状态。
 */
public class ReminderReceiver extends BroadcastReceiver {

    private static final String CHANNEL_ID = "riji_daily";
    private static final int NOTIFY_ID = 1001;

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();

        if (Intent.ACTION_BOOT_COMPLETED.equals(action)) {
            ReminderScheduler.rescheduleIfNeeded(context);
            return;
        }
        post(context);
    }

    private void post(Context context) {
        NotificationManager nm =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        // 文案优先用网页传过来的（跟着应用内语言走），没有就退回中文默认。
        // 应用内的语言是用户自己选的，跟系统语言不一定一致，原生没法猜。
        String title = ReminderScheduler.title(context);
        String body = ReminderScheduler.body(context);
        if (title == null || title.isEmpty()) title = "私密日志 · 每日自查";
        if (body == null || body.isEmpty()) body = "今天过得怎么样？有没有影响到睡眠、工作和情绪？";

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // 同一个 id 再建一次会更新渠道名，所以语言切了渠道名也跟着变
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, title, NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription(body);
            nm.createNotificationChannel(ch);
        }

        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pi = PendingIntent.getActivity(context, NOTIFY_ID + 1, open, flags);

        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(context, CHANNEL_ID)
                : new Notification.Builder(context);
        b.setSmallIcon(R.drawable.ic_stat_riji)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .setContentIntent(pi);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            b.setStyle(new Notification.BigTextStyle().bigText(body));
        }

        try {
            nm.notify(NOTIFY_ID, b.build());
        } catch (SecurityException e) {
            // 用户没给通知权限，静默失败即可，不要因为一个提醒把应用搞崩
        }
    }
}
