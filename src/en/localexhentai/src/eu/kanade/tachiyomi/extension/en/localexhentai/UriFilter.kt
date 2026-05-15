package eu.kanade.tachiyomi.extension.en.localexhentai

import android.net.Uri

/**
 * Uri filter
 */
interface UriFilter {
    fun addToUri(builder: Uri.Builder)
}
