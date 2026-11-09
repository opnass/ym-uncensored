package com.opnass.ymcompanion

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast

/**
 * Экран прототипа: три шага настройки, состояние и журнал событий.
 * Сделан на стандартных виджетах Android, без библиотек — чтобы сборка была простой.
 */
class MainActivity : Activity() {
    private val ui = Handler(Looper.getMainLooper())
    private lateinit var status: TextView
    private lateinit var log: TextView
    private lateinit var btnAccess: Button
    private lateinit var btnBattery: Button
    private lateinit var btnFolder: Button
    private lateinit var switch: Switch

    private val cDark = Color.rgb(20, 21, 26)
    private val cText = Color.rgb(230, 231, 234)
    private val cMuted = Color.rgb(139, 143, 156)
    private val cYellow = Color.rgb(255, 204, 0)

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Engine.ensure(this)

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(22), dp(18), dp(28))
            setBackgroundColor(cDark)
        }
        fun label(s: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
            this.text = s
            textSize = size
            setTextColor(color)
            if (bold) setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(4), 0, dp(4))
        }
        fun button(s: String, onClick: () -> Unit) = Button(this).apply {
            this.text = s
            isAllCaps = false
            setOnClickListener { onClick() }
        }

        col.addView(label("YM Companion", 24f, cYellow, bold = true))
        col.addView(label("Своя explicit-версия вместо цензурной в приложении Яндекс Музыки. Само приложение не меняется.", 14f, cMuted))

        status = label("", 15f, cText)
        col.addView(status)

        btnAccess = button("1. Дать доступ к уведомлениям") {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        col.addView(btnAccess)
        col.addView(label(
            "Если переключатель серый и «ограничен»: Настройки → Приложения → YM Companion → ⋮ → " +
                "«Разрешить ограниченные настройки», потом снова этот шаг.", 12f, cMuted))

        btnFolder = button("2. Выбрать папку с музыкой") {
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQ_FOLDER)
        }
        col.addView(btnFolder)
        col.addView(button("Пересканировать папку") { rescan() })

        btnBattery = button("3. Разрешить работу в фоне") { askBattery() }
        col.addView(btnBattery)
        col.addView(label(
            "Samsung: ещё Настройки → Приложения → YM Companion → Батарея → «Без ограничений».", 12f, cMuted))

        switch = Switch(this).apply {
            this.text = "Подменять треки"
            setTextColor(cText)
            textSize = 16f
            isChecked = Engine.enabled(this@MainActivity)
            setOnCheckedChangeListener { _, on -> Engine.setEnabled(this@MainActivity, on) }
            setPadding(0, dp(12), 0, dp(12))
        }
        col.addView(switch)

        col.addView(label("Журнал", 16f, cYellow, bold = true))
        log = label("", 12f, cText).apply { typeface = Typeface.MONOSPACE; setTextIsSelectable(true) }
        col.addView(log)

        setContentView(ScrollView(this).apply { setBackgroundColor(cDark); addView(col) })

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
        }
        if (Library.folderUri(this) != null) rescan(quiet = true)
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    override fun onPause() {
        super.onPause()
        ui.removeCallbacksAndMessages(null)
    }

    private fun hasListenerAccess(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        return flat.contains(packageName)
    }

    private fun batteryFree(): Boolean =
        getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(packageName) == true

    private fun askBattery() {
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun refresh() {
        val access = hasListenerAccess()
        val folder = Library.folderName(this)
        val sb = StringBuilder()
        sb.append(if (access) "✓ доступ к уведомлениям\n" else "✗ нет доступа к уведомлениям — шаг 1\n")
        sb.append(if (Engine.connected) "✓ компаньон подключён\n" else "… компаньон ждёт доступа\n")
        sb.append(if (folder != null) "✓ папка: $folder, файлов: ${Library.tracks.size}\n" else "✗ папка не выбрана — шаг 2\n")
        sb.append(if (batteryFree()) "✓ работа в фоне разрешена\n" else "! фон ограничен — шаг 3\n")
        sb.append("\nЯндекс Музыка: ${Engine.yandexState}\n")
        if (Engine.yandexTitle.isNotBlank()) sb.append("В Яндексе: ${Engine.yandexArtist} — ${Engine.yandexTitle}\n")
        Engine.playing?.let { sb.append("Играет своя версия: ${it.name}\n") }
        status.text = sb.toString()
        btnAccess.visibility = if (access) View.GONE else View.VISIBLE
        btnBattery.visibility = if (batteryFree()) View.GONE else View.VISIBLE
        btnFolder.text = if (folder != null) "Сменить папку с музыкой" else "2. Выбрать папку с музыкой"
        log.text = Journal.text()
        ui.postDelayed({ refresh() }, 1000)
    }

    private fun rescan(quiet: Boolean = false) {
        if (Library.folderUri(this) == null) {
            Toast.makeText(this, "Сначала выбери папку", Toast.LENGTH_SHORT).show()
            return
        }
        if (!quiet) Toast.makeText(this, "Сканирую папку…", Toast.LENGTH_SHORT).show()
        val ctx = applicationContext
        Thread {
            val n = Library.scan(ctx)
            Journal.add("библиотека: файлов $n")
            runOnUiThread { if (!quiet) Toast.makeText(this, "Файлов в библиотеке: $n", Toast.LENGTH_SHORT).show() }
        }.start()
    }

    @Deprecated("Activity API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FOLDER && resultCode == RESULT_OK) {
            val uri = data?.data ?: return
            try {
                contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (e: SecurityException) {
                Journal.add("не удалось сохранить доступ к папке: ${e.message}")
            }
            Library.setFolder(this, uri)
            rescan()
        }
    }

    companion object {
        private const val REQ_FOLDER = 10
        private const val REQ_NOTIF = 11
    }
}
