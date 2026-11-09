package com.opnass.ymcompanion

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.DocumentsContract
import org.json.JSONArray
import org.json.JSONObject

/** Файл библиотеки. id — content:// адрес файла в выбранной папке. */
data class Track(
    val uri: String,
    val name: String,
    val title: String,
    val artists: String,
    val durationMs: Long,
) {
    fun candidate() = Matcher.Candidate(uri, title, artists, durationMs)
}

/**
 * Библиотека — аудиофайлы из папки, которую выбрал пользователь (Storage Access Framework).
 * Исполнитель и название берутся из тегов файла, иначе из имени. Список кэшируется в настройках,
 * чтобы сопоставление работало мгновенно, без чтения диска на каждой смене трека.
 */
object Library {
    private const val PREFS = "library"
    private const val MAX_DEPTH = 3

    @Volatile var tracks: List<Track> = emptyList()
        private set

    fun folderUri(ctx: Context): Uri? =
        ctx.getSharedPreferences(PREFS, 0).getString("folder", null)?.let(Uri::parse)

    fun folderName(ctx: Context): String? = folderUri(ctx)?.let { uri ->
        runCatching { DocumentsContract.getTreeDocumentId(uri).substringAfterLast(':').ifEmpty { "корень" } }.getOrNull()
    }

    fun setFolder(ctx: Context, uri: Uri) {
        ctx.getSharedPreferences(PREFS, 0).edit().putString("folder", uri.toString()).apply()
    }

    fun load(ctx: Context) {
        val raw = ctx.getSharedPreferences(PREFS, 0).getString("tracks", null) ?: return
        tracks = runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                Track(o.getString("uri"), o.getString("name"), o.getString("title"), o.getString("artists"), o.optLong("durationMs"))
            }
        }.getOrDefault(emptyList())
    }

    private fun save(ctx: Context, list: List<Track>) {
        val arr = JSONArray()
        list.forEach {
            arr.put(JSONObject().put("uri", it.uri).put("name", it.name).put("title", it.title)
                .put("artists", it.artists).put("durationMs", it.durationMs))
        }
        ctx.getSharedPreferences(PREFS, 0).edit().putString("tracks", arr.toString()).apply()
    }

    /** Пересканировать папку. Долго на больших папках — вызывать не из главного потока. */
    fun scan(ctx: Context): Int {
        val tree = folderUri(ctx) ?: return 0
        val known = tracks.associateBy { it.uri }
        val out = mutableListOf<Track>()
        fun walk(docId: String, depth: Int) {
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
            val cols = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
            )
            ctx.contentResolver.query(children, cols, null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getString(0) ?: continue
                    val name = c.getString(1) ?: ""
                    val mime = c.getString(2) ?: ""
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                        if (depth > 0) walk(id, depth - 1)
                    } else if (Matcher.isAudio(name, mime)) {
                        val uri = DocumentsContract.buildDocumentUriUsingTree(tree, id).toString()
                        // уже прочитанный файл заново не открываем
                        out += known[uri] ?: readTrack(ctx, Uri.parse(uri), name)
                    }
                }
            }
        }
        runCatching { walk(DocumentsContract.getTreeDocumentId(tree), MAX_DEPTH) }
            .onFailure { Journal.add("не удалось прочитать папку: ${it.message}") }
        tracks = out
        save(ctx, out)
        return out.size
    }

    private fun readTrack(ctx: Context, uri: Uri, name: String): Track {
        val (nameArtist, nameTitle) = Matcher.parseName(name)
        var title = nameTitle
        var artist = nameArtist
        var duration = 0L
        val mmr = MediaMetadataRetriever()
        try {
            mmr.setDataSource(ctx, uri)
            Matcher.cleanTag(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)).takeIf { it.isNotEmpty() }?.let { title = it }
            Matcher.cleanTag(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST)).takeIf { it.isNotEmpty() }?.let { artist = it }
            duration = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        } catch (e: Exception) {
            // битый файл или без тегов — остаются данные из имени
        } finally {
            runCatching { mmr.release() }
        }
        return Track(uri.toString(), name, title, artist, duration)
    }

    fun match(title: String, artists: String, durationMs: Long): Pair<Track?, String> {
        val res = Matcher.findMatch(tracks.map { it.candidate() }, Matcher.Target(title, artists, durationMs))
        val track = res.candidate?.let { c -> tracks.firstOrNull { it.uri == c.id } }
        return track to res.reason
    }
}
