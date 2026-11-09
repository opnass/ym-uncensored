package com.opnass.ymcompanion

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Сопоставление трека Яндекс Музыки с файлом библиотеки.
 * Порт normalize.js + findMatch из расширения YM Uncensored: те же ключи и пороги,
 * чтобы «Мукка Таблетка.mp3» находилась так же, как в браузере.
 * Без зависимостей от Android — проверяется юнит-тестами.
 */
object Matcher {

    private val VERSION_MARKERS = Regex(
        "(?:explicit|uncensored|uncesored|dirty|clean|censored|remaster(?:ed)?|deluxe|radio edit|" +
            "album version|версия|цензур|без мата|нецензурн)",
        RegexOption.IGNORE_CASE
    )
    private val APOSTROPHES = Regex("[’'`´]")
    private val PARENS = Regex("\\(([^)]*)\\)")
    private val BRACKETS = Regex("\\[([^\\]]*)\\]")
    private val FEAT = Regex("(?U)\\b(?:feat|ft|при\\s+уч)\\.?\\s+[^,;–—-]+", RegexOption.IGNORE_CASE)
    private val NON_WORD = Regex("[^\\p{L}\\p{N}]+")
    private val SITE_MARK = Regex(
        "[(\\[]\\s*(?:www\\.)?[\\w-]+\\.(?:net|com|ru|org|me|cc|io|to|su|fm|club|pro|xyz)\\s*[)\\]]",
        RegexOption.IGNORE_CASE
    )
    private val SPLIT_NAME = Regex("\\s+[-–—]\\s+")

    const val THRESHOLD = 0.82
    const val TITLE_ONLY_THRESHOLD = 0.90
    const val TITLE_ONLY_GAP = 0.12

    /** Нижний регистр, ё→е, без пунктуации, версионных скобок и feat. */
    fun norm(input: String?): String {
        if (input == null) return ""
        var t = input.lowercase().replace('ё', 'е')
        t = APOSTROPHES.replace(t, "")
        t = PARENS.replace(t) { m -> if (VERSION_MARKERS.containsMatchIn(m.groupValues[1])) " " else " ${m.groupValues[1]} " }
        t = BRACKETS.replace(t) { m -> if (VERSION_MARKERS.containsMatchIn(m.groupValues[1])) " " else " ${m.groupValues[1]} " }
        t = FEAT.replace(t, " ")
        t = NON_WORD.replace(t, " ").trim()
        return t
    }

    fun key(title: String?, artists: String?): String = norm(artists) + "|" + norm(title)

    private fun bigrams(s: String): Map<String, Int> {
        val clean = s.replace(Regex("\\s+"), "")
        val out = HashMap<String, Int>()
        for (i in 0 until clean.length - 1) {
            val g = clean.substring(i, i + 2)
            out[g] = (out[g] ?: 0) + 1
        }
        return out
    }

    /** Коэффициент Дайса по биграммам, 0..1. */
    fun dice(a: String, b: String): Double {
        if (a == b) return 1.0
        if (a.isEmpty() || b.isEmpty()) return 0.0
        val ga = bigrams(a)
        val gb = bigrams(b)
        var inter = 0
        var total = 0
        for ((g, n) in ga) {
            total += n
            gb[g]?.let { inter += min(n, it) }
        }
        for ((_, n) in gb) total += n
        return if (total > 0) 2.0 * inter / total else 0.0
    }

    data class Candidate(
        val id: String,
        val title: String,
        val artists: String,
        val durationMs: Long = 0,
    ) {
        val key: String get() = key(title, artists)
    }

    data class Target(val title: String, val artists: String, val durationMs: Long = 0)

    private fun durationBonus(c: Long, t: Long): Double {
        if (c <= 0 || t <= 0) return 0.0
        val diff = abs(c - t) / 1000.0
        // explicit-версия обычно длиннее цензурной, поэтому небольшая разница — норма
        return when {
            diff <= 3 -> 0.08
            diff <= 8 -> 0.03
            diff <= 20 -> 0.0
            diff <= 40 -> -0.10
            else -> -0.35
        }
    }

    fun score(c: Candidate, t: Target): Double {
        val titleS = dice(norm(c.title), norm(t.title))
        val artistS = dice(norm(c.artists), norm(t.artists))
        val s = 0.62 * titleS + 0.38 * artistS + durationBonus(c.durationMs, t.durationMs)
        return s.coerceIn(0.0, 1.0)
    }

    /** Исполнитель не отделён от названия («Мукка Таблетка»): строка целиком, в любом порядке. */
    fun scoreLoose(c: Candidate, t: Target): Double {
        val cs = norm(listOf(c.artists, c.title).filter { it.isNotBlank() }.joinToString(" "))
        val a = norm(listOf(t.artists, t.title).filter { it.isNotBlank() }.joinToString(" "))
        val b = norm(listOf(t.title, t.artists).filter { it.isNotBlank() }.joinToString(" "))
        var s = max(dice(cs, a), dice(cs, b)) - 0.04
        if (c.durationMs > 0 && t.durationMs > 0) {
            val diff = abs(c.durationMs - t.durationMs) / 1000.0
            s += when {
                diff <= 3 -> 0.08
                diff <= 8 -> 0.03
                diff > 40 -> -0.35
                diff > 20 -> -0.10
                else -> 0.0
            }
        }
        return s.coerceIn(0.0, 1.0)
    }

    data class Result(val candidate: Candidate?, val score: Double, val reason: String)

    /** Точный ключ → ближайшая длительность; иначе нечёткий поиск с порогом. */
    fun findMatch(files: List<Candidate>, t: Target): Result {
        if (files.isEmpty()) return Result(null, 0.0, "библиотека пуста")
        val k = key(t.title, t.artists)
        val exact = files.filter { it.key == k }
        if (exact.isNotEmpty()) {
            val best = exact.minByOrNull { abs(it.durationMs - t.durationMs) }!!
            return Result(best, 1.0, "точный ключ")
        }

        val noArtist = t.artists.isBlank()
        val scored = files.map { f ->
            val s = if (noArtist) {
                var x = dice(norm(f.title), norm(t.title))
                if (f.durationMs > 0 && t.durationMs > 0) {
                    val diff = abs(f.durationMs - t.durationMs) / 1000.0
                    if (diff <= 5) x += 0.05 else if (diff > 45) x -= 0.30
                }
                x.coerceIn(0.0, 1.0)
            } else {
                val base = score(f, t)
                if (f.artists.isBlank()) max(base, scoreLoose(f, t)) else base
            }
            s to f
        }.sortedByDescending { it.first }

        val (bestScore, best) = scored.first()
        val threshold = if (noArtist) TITLE_ONLY_THRESHOLD else THRESHOLD
        if (noArtist && scored.size > 1 && bestScore - scored[1].first < TITLE_ONLY_GAP) {
            return Result(null, bestScore, "артист не определён, а два файла похожи")
        }
        return if (bestScore >= threshold) {
            Result(best, bestScore, "совпадение %.2f".format(bestScore))
        } else {
            Result(null, bestScore, "лучший %.2f < порога %.2f".format(bestScore, threshold))
        }
    }

    /** «Исполнитель - Название.mp3» → (исполнитель, название). Метки сайтов убираются. */
    fun parseName(fileName: String): Pair<String, String> {
        var base = fileName.replace(Regex("\\.[^.]+$"), "").replace('_', ' ')
        base = SITE_MARK.replace(base, " ").replace(Regex("\\s+"), " ").trim()
        val parts = base.split(SPLIT_NAME)
        return if (parts.size >= 2) parts[0].trim() to parts.drop(1).joinToString(" - ").trim() else "" to base
    }

    fun cleanTag(s: String?): String =
        SITE_MARK.replace(s ?: "", " ").replace(Regex("\\s+"), " ").trim()

    private val AUDIO_EXT = Regex("\\.(mp3|m4a|mp4|aac|flac|ogg|oga|opus|wav)$", RegexOption.IGNORE_CASE)
    fun isAudio(name: String, mime: String?): Boolean =
        AUDIO_EXT.containsMatchIn(name) || (mime ?: "").startsWith("audio/")
}
