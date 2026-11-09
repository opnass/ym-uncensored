package com.opnass.ymcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Те же случаи, что в тестах расширения: сопоставление должно вести себя одинаково. */
class MatcherTest {

    @Test fun keyIgnoresVersionMarkers() {
        assertEquals("мукка|таблетка", Matcher.key("Таблетка (Explicit Version)", "МУККА"))
        assertEquals(Matcher.key("Таблетка", "МУККА"), Matcher.key("Таблетка [Clean]", "мукка"))
    }

    @Test fun keepsMeaningfulBrackets() {
        assertTrue(Matcher.norm("Song (prod. by X)").contains("prod"))
    }

    @Test fun yoAndPunctuation() {
        assertEquals("еще раз", Matcher.norm("Ещё раз!!!"))
    }

    @Test fun featIsDropped() {
        assertEquals("дом периньон", Matcher.norm("Дом Периньон feat. Элджей"))
    }

    @Test fun parseNameWithSeparator() {
        assertEquals("МУККА" to "Таблетка", Matcher.parseName("МУККА - Таблетка.mp3"))
    }

    @Test fun parseNameStripsSiteMark() {
        assertEquals("Face" to "Мой Калашников", Matcher.parseName("Face - Мой Калашников (hitmo.net).mp3"))
    }

    @Test fun parseNameWithoutSeparator() {
        assertEquals("" to "Мукка Таблетка", Matcher.parseName("Мукка Таблетка.mp3"))
    }

    private fun lib() = listOf(
        Matcher.Candidate("m1", "Мукка Таблетка", ""),
        Matcher.Candidate("m2", "Мукка Девочка С Каре", ""),
        Matcher.Candidate("m3", "Пошлая Молли Ханнамонтана", ""),
    )

    @Test fun nameWithoutSeparatorMatchesAtNormalThreshold() {
        val r = Matcher.findMatch(lib(), Matcher.Target("Таблетка", "МУККА"))
        assertEquals("m1", r.candidate?.id)
    }

    @Test fun picksTheRightTrackOfSameArtist() {
        val r = Matcher.findMatch(lib(), Matcher.Target("Девочка с каре", "МУККА"))
        assertEquals("m2", r.candidate?.id)
    }

    @Test fun foreignTrackIsNotBound() {
        val r = Matcher.findMatch(lib(), Matcher.Target("Город горит", "Кто-то"))
        assertNull(r.candidate)
    }

    @Test fun exactKeyPrefersClosestDuration() {
        val files = listOf(
            Matcher.Candidate("a", "Таблетка", "МУККА", 120_000),
            Matcher.Candidate("b", "Таблетка", "МУККА", 175_000),
        )
        assertEquals("b", Matcher.findMatch(files, Matcher.Target("Таблетка", "МУККА", 176_000)).candidate?.id)
    }

    @Test fun titleOnlyNeedsClearGap() {
        val files = listOf(
            Matcher.Candidate("a", "Таблетка", "МУККА"),
            Matcher.Candidate("b", "Таблетка", "Другой исполнитель"),
        )
        // артист не определён, а у двух файлов одинаковое название — лучше не угадывать
        assertNull(Matcher.findMatch(files, Matcher.Target("Таблетка", "")).candidate)
    }

    @Test fun emptyLibrary() {
        assertEquals("библиотека пуста", Matcher.findMatch(emptyList(), Matcher.Target("x", "y")).reason)
    }

    @Test fun audioDetection() {
        assertTrue(Matcher.isAudio("a.FLAC", null))
        assertTrue(Matcher.isAudio("download", "audio/mpeg"))
        assertTrue(!Matcher.isAudio("setup.exe", "application/octet-stream"))
    }
}
