package eu.kanade.tachiyomi.extension.en.localexhentai

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.net.Uri
import eu.kanade.tachiyomi.source.model.Page
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.io.ByteArrayOutputStream

object MenuActions {
    const val INTENT_PREFIX = "http://127.0.0.1/tachiyomi-menu/"
    const val ACTION_DOWNLOAD = "download"
    const val ACTION_BROWSE = "browse"
    const val ACTION_STATUS = "status"
    const val ACTION_FAVORITE = "favorite"
    const val ACTION_UNFAVORITE = "unfavorite"

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

    // -----------------------------------------------------------------------
    // Page generation — called from fetchPageList when user opens a menu chapter
    // -----------------------------------------------------------------------

    /**
     * Generate bitmap-based pages for actions that render status overlays.
     * Returns Pages whose image requests the interceptor handles via [buildImageResponse].
     */
    fun generateMenuPages(chapterUrl: String): List<Page> {
        val action = parseAction(chapterUrl) ?: return emptyList()
        val gid = getQueryParam(chapterUrl, "gid") ?: ""
        val galleryPath = getQueryParam(chapterUrl, "url") ?: ""

        val pages = when (action) {
            ACTION_DOWNLOAD -> createDownloadScenario(gid, galleryPath)
            ACTION_STATUS -> createStatusScenario(gid)
            ACTION_FAVORITE -> createFavoriteScenario()
            ACTION_UNFAVORITE -> createUnfavoriteScenario()
            else -> return emptyList()
        }

        if (pages.isEmpty()) return emptyList()

        val scenarioId = "$action-${System.currentTimeMillis()}-${pages.hashCode()}"
        scenarios[scenarioId] = Scenario(pages)

        if (scenarios.size > 20) {
            val toRemove = scenarios.keys.take(scenarios.size - 20)
            toRemove.forEach { scenarios.remove(it) }
        }

        return pages.mapIndexed { index, pageInfo ->
            val url = "$INTENT_PREFIX$scenarioId/$index"
            Page(index, url).apply { imageUrl = url }
        }
    }

    // -----------------------------------------------------------------------
    // Interceptor — handles bitmap generation for menu page image requests
    // -----------------------------------------------------------------------

    fun buildImageResponse(requestUrl: String, chain: Interceptor.Chain): Response? {
        if (!requestUrl.startsWith(INTENT_PREFIX)) return null
        val path = requestUrl.removePrefix(INTENT_PREFIX).trimEnd('/')
        val parts = path.split("/")
        if (parts.size < 2) return null
        val scenarioId = parts[0]
        val pageIndex = parts.getOrNull(1)?.toIntOrNull() ?: return null
        val scenario = scenarios[scenarioId] ?: return null
        val pageInfo = scenario.pages.getOrNull(pageIndex) ?: return null
        return generateBitmap(pageInfo).toResponse(chain)
    }

    /**
     * Execute an API call to the cache server using the interceptor's chain.
     * Used by actions that need real data (download, status).
     */
    fun executeApiCall(chain: Interceptor.Chain, cacheUrl: String, apiPath: String): String? = try {
        val baseUrl = cacheUrl.trimEnd('/').removeSuffix("/proxy")
        val request = Request.Builder()
            .url("$baseUrl/$apiPath")
            .build()
        chain.proceed(request).body?.string()
    } catch (_: Exception) {
        null
    }

    fun executeApiPost(chain: Interceptor.Chain, cacheUrl: String, apiPath: String, jsonBody: String): String? = try {
        val baseUrl = cacheUrl.trimEnd('/').removeSuffix("/proxy")
        val request = Request.Builder()
            .url("$baseUrl/$apiPath")
            .addHeader("Content-Type", "application/json")
            .post(jsonBody.toRequestBody("application/json".toMediaType()))
            .build()
        chain.proceed(request).body?.string()
    } catch (_: Exception) {
        null
    }

    // -----------------------------------------------------------------------
    // Scenario definitions
    // -----------------------------------------------------------------------

    private data class PageInfo(
        val title: String,
        val subtitle: String,
        val isSuccess: Boolean,
        val progress: Float? = null,
    )

    private data class Scenario(val pages: List<PageInfo>)
    private val scenarios = mutableMapOf<String, Scenario>()

    private fun createDownloadScenario(gid: String, galleryPath: String): List<PageInfo> = listOf(
        PageInfo("正在连接...", "正在发送下载请求", true, 0f),
        PageInfo("请求已提交", "GID: $gid", true, 1f),
    )

    private fun createStatusScenario(gid: String): List<PageInfo> = listOf(
        PageInfo("状态查询", "GID: $gid", true, 0f),
    )

    private fun createFavoriteScenario(): List<PageInfo> = listOf(
        PageInfo("收藏功能", "通过扩展或网页收藏", true),
    )

    private fun createUnfavoriteScenario(): List<PageInfo> = listOf(
        PageInfo("取消收藏", "通过扩展或网页操作", true),
    )

    // -----------------------------------------------------------------------
    // Browse — create Pages with real image URLs from cache server
    // -----------------------------------------------------------------------

    fun createBrowsePages(jsonBody: String, cacheUrl: String): List<Page> {
        return try {
            val obj = org.json.JSONObject(jsonBody)
            if (obj.optString("status") != "ready") {
                val msg = obj.optString("message", "Gallery not ready")
                return listOf(
                    Page(0, "$INTENT_PREFIX-browse-status").apply {
                        imageUrl = "$INTENT_PREFIX-browse-status"
                        // Store status message as a pseudo-url that fetchPageList handles
                    },
                )
            }

            val images = obj.optJSONArray("images") ?: return emptyList()
            val base = cacheUrl.trimEnd('/')
            val pages = mutableListOf<Page>()
            for (i in 0 until images.length()) {
                val imgUrl = images.getString(i)
                val fullUrl = if (imgUrl.startsWith("http")) imgUrl else "$base$imgUrl"
                pages.add(Page(i, fullUrl).apply { imageUrl = fullUrl })
            }
            pages
        } catch (_: Exception) {
            emptyList()
        }
    }

    // -----------------------------------------------------------------------
    // Bitmap generation
    // -----------------------------------------------------------------------

    private fun generateBitmap(info: PageInfo): Bitmap {
        val width = 1080
        val height = 1920
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)

        val bgColor = when {
            info.progress != null && info.progress < 1f -> 0xFF1565C0.toInt()
            info.isSuccess -> 0xFF2E7D32.toInt()
            else -> 0xFFC62828.toInt()
        }
        canvas.drawColor(bgColor)

        val titlePaint = Paint().apply {
            color = 0xFFFFFFFF.toInt()
            textSize = 80f
            textAlign = Paint.Align.CENTER
            isAntiAlias = true
            typeface = Typeface.DEFAULT_BOLD
        }
        canvas.drawText(info.title, width / 2f, height / 2f - 120f, titlePaint)

        val subPaint = Paint().apply {
            color = 0xCCFFFFFF.toInt()
            textSize = 44f
            textAlign = Paint.Align.CENTER
            isAntiAlias = true
            typeface = Typeface.DEFAULT
        }
        canvas.drawText(info.subtitle, width / 2f, height / 2f - 40f, subPaint)

        info.progress?.let { progress ->
            val barW = 720f
            val barH = 48f
            val barL = (width - barW) / 2f
            val barT = height / 2f + 60f
            val barR = barL + barW
            val barB = barT + barH

            val bgPaint = Paint().apply {
                color = 0x33FFFFFF
                style = Paint.Style.FILL
            }
            canvas.drawRoundRect(RectF(barL, barT, barR, barB), 24f, 24f, bgPaint)

            val fillPaint = Paint().apply {
                color = if (progress >= 1f) 0xFF66BB6A.toInt() else 0xFF42A5F5.toInt()
                style = Paint.Style.FILL
            }
            val fillR = barL + barW * progress.coerceIn(0f, 1f)
            if (fillR > barL) {
                canvas.drawRoundRect(RectF(barL, barT, fillR, barB), 24f, 24f, fillPaint)
            }

            val pctPaint = Paint().apply {
                color = 0xFFFFFFFF.toInt()
                textSize = 48f
                textAlign = Paint.Align.CENTER
                isAntiAlias = true
                typeface = Typeface.DEFAULT_BOLD
            }
            canvas.drawText("${(progress * 100).toInt()}%", width / 2f, barB + 60f, pctPaint)
        }

        return bitmap
    }

    private fun Bitmap.toResponse(chain: Interceptor.Chain): Response {
        val bos = ByteArrayOutputStream()
        compress(Bitmap.CompressFormat.PNG, 100, bos)
        return Response.Builder()
            .code(200)
            .message("OK")
            .body(bos.toByteArray().toResponseBody("image/png".toMediaType()))
            .request(chain.request())
            .protocol(Protocol.HTTP_1_1)
            .build()
    }
}
