package com.opnass.ymcompanion

import android.content.ComponentName
import android.service.notification.NotificationListenerService

/**
 * Нужен только ради доступа к медиасессиям других приложений: Android даёт его
 * приложениям с включённым «Доступом к уведомлениям». Сами уведомления не читаются.
 */
class YmListenerService : NotificationListenerService() {
    override fun onListenerConnected() {
        Engine.start(this, ComponentName(this, YmListenerService::class.java))
    }

    override fun onListenerDisconnected() {
        Engine.stop()
    }
}
