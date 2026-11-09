package com.opnass.ymcompanion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Кнопки уведомления «своя версия»: пауза, дальше, закрыть. */
class ControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Engine.ensure(context)
        Engine.control(intent.action ?: return)
    }
}
