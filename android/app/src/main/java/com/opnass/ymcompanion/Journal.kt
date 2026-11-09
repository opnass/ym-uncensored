package com.opnass.ymcompanion

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Журнал событий для экрана приложения: что увидели, что сделали, сколько успел сыграть Яндекс. */
object Journal {
    private const val LIMIT = 120
    private val lines = ArrayDeque<String>()
    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.US)

    @Synchronized
    fun add(text: String) {
        lines.addFirst("${fmt.format(Date())}  $text")
        while (lines.size > LIMIT) lines.removeLast()
        android.util.Log.i("YMCompanion", text)
    }

    @Synchronized
    fun text(): String = if (lines.isEmpty()) "Событий пока нет. Включи трек в Яндекс Музыке." else lines.joinToString("\n")
}
