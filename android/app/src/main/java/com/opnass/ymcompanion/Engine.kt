package com.opnass.ymcompanion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.MediaPlayer
import android.media.session.MediaController
import android.media.session.MediaSession
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock

/**
 * Сердце компаньона.
 *
 *  1. Через медиасессию Яндекс Музыки (доступна благодаря доступу к уведомлениям) видим,
 *     какой трек играет, и получаем событие смены трека сразу, без опроса.
 *  2. Если для трека есть файл в библиотеке — забираем аудиофокус (Яндекс сам встаёт на паузу)
 *     и для надёжности ставим паузу командой.
 *  3. Играем свою версию в своём плеере, со своей медиасессией и уведомлением —
 *     поэтому кнопки на экране блокировки, в наушниках и в машине управляют ею.
 *  4. Своя версия доиграла — даём Яндексу команду «следующий трек», волна идёт дальше.
 *
 * Приложение Яндекс Музыки при этом не меняется: только стандартные команды плеера,
 * как у часов, скробблеров и автомобильных экранов.
 */
object Engine {
    const val YANDEX_PREFIX = "ru.yandex.music"
    const val ACTION_TOGGLE = "com.opnass.ymcompanion.TOGGLE"
    const val ACTION_NEXT = "com.opnass.ymcompanion.NEXT"
    const val ACTION_STOP = "com.opnass.ymcompanion.STOP"
    private const val CHANNEL = "playback"
    private const val NOTIF_ID = 1

    private lateinit var app: Context
    private val main = Handler(Looper.getMainLooper())

    private var sessions: MediaSessionManager? = null
    private var listener: ComponentName? = null
    private var yandex: MediaController? = null

    @Volatile var yandexTitle = ""
        private set
    @Volatile var yandexArtist = ""
        private set
    @Volatile var yandexState = "не найдена"
        private set
    private var lastSeenKey = ""

    private var player: MediaPlayer? = null
    @Volatile var playing: Track? = null
        private set
    private var ownSession: MediaSession? = null
    private var focus: AudioFocusRequest? = null
    private var pausedByFocus = false
    private var measureLeak = false

    private val attrs: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
        .build()

    val connected: Boolean get() = sessions != null
    val yandexFound: Boolean get() = yandex != null

    /** Контекст для экрана приложения, даже если сервис ещё не подключился. */
    fun ensure(ctx: Context) {
        if (!::app.isInitialized) {
            app = ctx.applicationContext
            Library.load(app)
        }
    }

    fun enabled(ctx: Context): Boolean = ctx.getSharedPreferences("engine", 0).getBoolean("enabled", true)

    fun setEnabled(ctx: Context, on: Boolean) {
        ctx.getSharedPreferences("engine", 0).edit().putBoolean("enabled", on).apply()
        Journal.add(if (on) "подмена включена" else "подмена выключена")
        if (!on && playing != null) stopLocal(resumeYandex = true, reason = "подмена выключена")
    }

    /* ---------- слежение за Яндекс Музыкой ---------- */

    fun start(ctx: Context, component: ComponentName) {
        ensure(ctx)
        val msm = app.getSystemService(MediaSessionManager::class.java) ?: return
        try {
            msm.addOnActiveSessionsChangedListener(sessionsListener, component, main)
            sessions = msm
            listener = component
            Journal.add("доступ к медиасессиям есть")
            pick(msm.getActiveSessions(component))
        } catch (e: SecurityException) {
            sessions = null
            Journal.add("нет доступа к уведомлениям — включи его в приложении")
        }
    }

    fun stop() {
        runCatching { sessions?.removeOnActiveSessionsChangedListener(sessionsListener) }
        sessions = null
        attach(null)
        Journal.add("доступ к медиасессиям отключён")
    }

    private val sessionsListener = MediaSessionManager.OnActiveSessionsChangedListener { list ->
        pick(list ?: emptyList())
    }

    private fun pick(list: List<MediaController>) {
        val y = list.firstOrNull { it.packageName.startsWith(YANDEX_PREFIX) }
        if (y != null && yandex != null && y.sessionToken == yandex!!.sessionToken) return
        if (y == null && yandex == null) return
        attach(y)
    }

    private fun attach(c: MediaController?) {
        yandex?.let { runCatching { it.unregisterCallback(callback) } }
        yandex = c
        if (c == null) {
            yandexState = "не найдена"
            return
        }
        c.registerCallback(callback, main)
        Journal.add("вижу Яндекс Музыку (${c.packageName})")
        onState(c.playbackState)
        onMetadata(c.metadata)
    }

    private val callback = object : MediaController.Callback() {
        override fun onMetadataChanged(metadata: MediaMetadata?) {
            onMetadata(metadata)
        }

        override fun onPlaybackStateChanged(state: PlaybackState?) {
            onState(state)
        }

        override fun onSessionDestroyed() {
            Journal.add("Яндекс Музыка закрыта")
            attach(null)
        }
    }

    private fun stateName(s: Int): String = when (s) {
        PlaybackState.STATE_PLAYING -> "играет"
        PlaybackState.STATE_PAUSED -> "пауза"
        PlaybackState.STATE_BUFFERING -> "загрузка"
        PlaybackState.STATE_STOPPED -> "остановлена"
        PlaybackState.STATE_SKIPPING_TO_NEXT, PlaybackState.STATE_SKIPPING_TO_PREVIOUS -> "переключает трек"
        else -> "—"
    }

    private fun onState(state: PlaybackState?) {
        state ?: return
        yandexState = stateName(state.state)
        if (state.state == PlaybackState.STATE_PAUSED && measureLeak) {
            measureLeak = false
            Journal.add("Яндекс встал на паузу на ${state.position} мс трека")
        }
        // своя версия играет, а Яндекс снова заиграл (не уважает аудиофокус) — ещё раз пауза
        if (playing != null && state.state == PlaybackState.STATE_PLAYING) {
            yandex?.transportControls?.pause()
        }
    }

    private fun onMetadata(md: MediaMetadata?) {
        md ?: return
        val title = md.getString(MediaMetadata.METADATA_KEY_TITLE) ?: ""
        val artist = md.getString(MediaMetadata.METADATA_KEY_ARTIST)
            ?: md.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST) ?: ""
        val duration = md.getLong(MediaMetadata.METADATA_KEY_DURATION)
        if (title.isBlank()) return
        val key = Matcher.key(title, artist)
        if (key == lastSeenKey) return            // Яндекс шлёт метаданные повторно (подгрузилась обложка)
        lastSeenKey = key
        yandexTitle = title
        yandexArtist = artist

        if (playing != null) stopLocal(resumeYandex = false, reason = "в Яндексе сменился трек")
        if (!::app.isInitialized || !enabled(app)) return

        val (track, reason) = Library.match(title, artist, duration)
        if (track == null) {
            Journal.add("$artist — $title: своей версии нет ($reason)")
            return
        }
        val t0 = SystemClock.elapsedRealtime()
        pauseYandex()
        if (playLocal(track)) {
            Journal.add("$artist — $title → ${track.name} (за ${SystemClock.elapsedRealtime() - t0} мс)")
        }
    }

    /* ---------- аудиофокус и пауза Яндекса ---------- */

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS -> {
                // звук забрало другое приложение — например, в Яндексе нажали «играть»
                if (playing != null) stopLocal(resumeYandex = false, reason = "звук забрало другое приложение")
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                // звонок, навигатор, голосовое — пауза до возврата фокуса
                player?.let { if (it.isPlaying) { it.pause(); pausedByFocus = true; publishState() } }
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                if (pausedByFocus) { pausedByFocus = false; player?.start(); publishState() }
            }
        }
    }

    private fun requestFocus() {
        if (focus != null) return
        val am = app.getSystemService(AudioManager::class.java) ?: return
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(attrs)
            .setOnAudioFocusChangeListener(focusListener, main)
            .build()
        if (am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) focus = req
    }

    private fun abandonFocus() {
        val req = focus ?: return
        focus = null
        app.getSystemService(AudioManager::class.java)?.abandonAudioFocusRequest(req)
    }

    private fun pauseYandex() {
        measureLeak = true
        requestFocus()                              // нормальный плеер встаёт на паузу сам
        yandex?.transportControls?.pause()          // и для надёжности — командой
    }

    /* ---------- своя версия ---------- */

    private fun playLocal(t: Track): Boolean {
        releasePlayer()
        val mp = MediaPlayer()
        return try {
            mp.setAudioAttributes(attrs)
            mp.setWakeMode(app, PowerManager.PARTIAL_WAKE_LOCK)
            mp.setDataSource(app, Uri.parse(t.uri))
            mp.prepare()
            mp.setOnCompletionListener { finishLocal("доиграла") }
            mp.setOnErrorListener { _, what, extra ->
                Journal.add("ошибка воспроизведения ($what/$extra) — возвращаю Яндекс")
                stopLocal(resumeYandex = true, reason = "ошибка файла")
                true
            }
            mp.start()
            player = mp
            playing = t
            pausedByFocus = false
            publishState()
            true
        } catch (e: Exception) {
            Journal.add("не открыть ${t.name}: ${e.message} — возвращаю Яндекс")
            runCatching { mp.release() }
            abandonFocus()
            yandex?.transportControls?.play()
            false
        }
    }

    private fun releasePlayer() {
        player?.let { runCatching { it.stop() }; runCatching { it.release() } }
        player = null
    }

    /** Своя версия кончилась (или «следующий» на своём уведомлении) — волна идёт дальше. */
    private fun finishLocal(why: String) {
        val t = playing
        releasePlayer()
        playing = null
        hideNotification()
        abandonFocus()
        Journal.add("своя версия ${t?.name ?: ""}: $why → следующий трек в Яндексе")
        yandex?.transportControls?.skipToNext()
        // после паузы некоторые плееры переключают трек, но не запускают его
        main.postDelayed({
            if (playing == null && yandex?.playbackState?.state != PlaybackState.STATE_PLAYING) {
                yandex?.transportControls?.play()
            }
        }, 900)
    }

    private fun stopLocal(resumeYandex: Boolean, reason: String) {
        if (playing == null && player == null) return
        releasePlayer()
        playing = null
        hideNotification()
        abandonFocus()
        Journal.add("своя версия остановлена: $reason")
        if (resumeYandex) yandex?.transportControls?.play()
    }

    /** Кнопки уведомления. */
    fun control(action: String) {
        when (action) {
            ACTION_TOGGLE -> toggle()
            ACTION_NEXT -> if (playing != null) finishLocal("пропущена") else yandex?.transportControls?.skipToNext()
            ACTION_STOP -> stopLocal(resumeYandex = false, reason = "закрыта")
        }
    }

    private fun toggle() {
        val mp = player ?: return
        if (mp.isPlaying) {
            mp.pause()
        } else {
            requestFocus()
            mp.start()
        }
        publishState()
    }

    /* ---------- своя медиасессия и уведомление ---------- */

    private fun session(): MediaSession {
        ownSession?.let { return it }
        val s = MediaSession(app, "YMCompanion")
        s.setCallback(object : MediaSession.Callback() {
            override fun onPlay() { if (player?.isPlaying == false) toggle() }
            override fun onPause() { if (player?.isPlaying == true) toggle() }
            override fun onSkipToNext() { control(ACTION_NEXT) }
            override fun onStop() { control(ACTION_STOP) }
            override fun onSeekTo(pos: Long) {
                player?.seekTo(pos.toInt())
                publishState()
            }
        })
        ownSession = s
        return s
    }

    private fun publishState() {
        val t = playing ?: return
        val mp = player ?: return
        val s = session()
        val isPlaying = runCatching { mp.isPlaying }.getOrDefault(false)
        val title = t.title.ifBlank { t.name }
        s.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, t.artists)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "своя версия · YM Companion")
                .putLong(MediaMetadata.METADATA_KEY_DURATION, runCatching { mp.duration.toLong() }.getOrDefault(t.durationMs))
                .build()
        )
        s.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                        PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_STOP or PlaybackState.ACTION_SEEK_TO
                )
                .setState(
                    if (isPlaying) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                    runCatching { mp.currentPosition.toLong() }.getOrDefault(0L),
                    if (isPlaying) 1f else 0f
                )
                .build()
        )
        s.isActive = true
        showNotification(title, t.artists, isPlaying, s)
    }

    private fun pending(action: String, code: Int): PendingIntent =
        PendingIntent.getBroadcast(
            app, code, Intent(app, ControlReceiver::class.java).setAction(action),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

    private fun showNotification(title: String, artist: String, isPlaying: Boolean, s: MediaSession) {
        val nm = app.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Своя версия трека", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val toggleIcon = if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
        val n = Notification.Builder(app, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(title)
            .setContentText(if (artist.isBlank()) "своя версия" else "$artist · своя версия")
            .setOngoing(isPlaying)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(Notification.Action.Builder(Icon.createWithResource(app, toggleIcon),
                if (isPlaying) "Пауза" else "Играть", pending(ACTION_TOGGLE, 1)).build())
            .addAction(Notification.Action.Builder(Icon.createWithResource(app, android.R.drawable.ic_media_next),
                "Дальше", pending(ACTION_NEXT, 2)).build())
            .addAction(Notification.Action.Builder(Icon.createWithResource(app, android.R.drawable.ic_menu_close_clear_cancel),
                "Закрыть", pending(ACTION_STOP, 3)).build())
            .setStyle(Notification.MediaStyle().setMediaSession(s.sessionToken).setShowActionsInCompactView(0, 1))
            .build()
        runCatching { nm.notify(NOTIF_ID, n) }
    }

    private fun hideNotification() {
        runCatching { app.getSystemService(NotificationManager::class.java)?.cancel(NOTIF_ID) }
        ownSession?.let { it.isActive = false }
    }
}
