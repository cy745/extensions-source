package eu.kanade.tachiyomi.extension.en.localexhentai

import android.net.Uri

object MenuActions {
    const val INTENT_PREFIX = "http://127.0.0.1/tachiyomi-menu/"
    const val ACTION_BROWSE = "browse"

    fun parseAction(url: String): String? {
        if (!url.startsWith(INTENT_PREFIX)) return null
        val path = url.removePrefix(INTENT_PREFIX).split("?").first().trimEnd('/')
        return path.substringBefore("/")
    }

    fun getQueryParam(url: String, name: String): String? = try {
        Uri.parse(url).getQueryParameter(name)
    } catch (_: Exception) {
        null
    }

    fun menuUrl(action: String, gid: String = "", galleryPath: String = ""): String {
        val base = "$INTENT_PREFIX$action"
        return if (gid.isNotEmpty()) {
            val params = mutableListOf("gid=$gid")
            if (galleryPath.isNotEmpty()) params.add("url=${Uri.encode(galleryPath)}")
            "$base?${params.joinToString("&")}"
        } else {
            base
        }
    }
}
