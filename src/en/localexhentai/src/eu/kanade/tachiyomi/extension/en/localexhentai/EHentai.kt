package eu.kanade.tachiyomi.extension.en.localexhentai

import android.annotation.SuppressLint
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.net.Uri
import android.util.Log
import android.webkit.CookieManager
import androidx.preference.CheckBoxPreference
import androidx.preference.EditTextPreference
import androidx.preference.PreferenceScreen
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.asObservableSuccess
import eu.kanade.tachiyomi.source.ConfigurableSource
import eu.kanade.tachiyomi.source.model.Filter
import eu.kanade.tachiyomi.source.model.Filter.CheckBox
import eu.kanade.tachiyomi.source.model.Filter.Select
import eu.kanade.tachiyomi.source.model.Filter.Text
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.model.UpdateStrategy
import eu.kanade.tachiyomi.source.online.HttpSource
import eu.kanade.tachiyomi.util.asJsoup
import keiyoushi.utils.getPreferencesLazy
import keiyoushi.utils.parseAs
import okhttp3.CacheControl
import okhttp3.CookieJar
import okhttp3.Dispatcher
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.jsoup.nodes.Element
import rx.Observable
import java.io.ByteArrayOutputStream
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap

abstract class EHentai(
    override val lang: String,
    private val ehLang: String,
) : HttpSource(),
    ConfigurableSource {

    override val name = "local-exhentai"

    private val preferences: SharedPreferences by getPreferencesLazy()

    private val webViewCookieManager: CookieManager by lazy { CookieManager.getInstance() }
    private val memberId: String by lazy { getMemberIdPref() }
    private val passHash: String by lazy { getPassHashPref() }
    private val igneous: String by lazy { getIgneousPref() }
    private val forceEh: Boolean by lazy { getForceEhPref() }

    override val baseUrl: String
        get() = when {
            System.getenv("CI") == "true" -> "https://e-hentai.org"
            !forceEh && memberId.isNotEmpty() && passHash.isNotEmpty() -> "https://exhentai.org"
            else -> "https://e-hentai.org"
        }

    override val supportsLatest = true

    private var lastMangaId = ""

    // Action tags — store gallery path so tag search can reconstruct full URL
    private val gidToGalleryPath = ConcurrentHashMap<String, String>()

    // true if lang is a "natural human language"
    private fun isLangNatural(): Boolean = lang !in listOf("none", "other")

    private fun genericMangaParse(response: Response): MangasPage {
        val doc = response.asJsoup()
        val mangaElements = doc.select("table.itg td.glname")
            .let { elements ->
                if (isLangNatural() && getEnforceLanguagePref()) {
                    elements.filter { element ->
                        // only accept elements with a language tag matching ehLang or without a language tag
                        // could make this stricter and not accept elements without a language tag, possibly add a sharedpreference for it
                        element.select("div[title^=language]").firstOrNull()?.let { it.text() == ehLang } ?: true
                    }
                } else {
                    elements
                }
            }
        val parsedMangas: MutableList<SManga> = mutableListOf()
        for (i in mangaElements.indices) {
            val manga = mangaElements[i].let {
                SManga.create().apply {
                    // Get title
                    it.selectFirst("a")?.apply {
                        title = this.select(".glink").text()
                        url = ExGalleryMetadata.normalizeUrl(attr("href"))
                        if (i == mangaElements.lastIndex) {
                            lastMangaId = ExGalleryMetadata.galleryId(attr("href"))
                        }
                    }
                    // Get image
                    it.parent()?.select(".glthumb img")?.first().apply {
                        thumbnail_url = this?.attr("data-src")?.nullIfBlank()
                            ?: this?.attr("src")
                    }
                }
            }
            parsedMangas.add(manga)
        }

        // Add to page if required
        val hasNextPage = doc.select("a#unext[href]").hasText()

        return MangasPage(parsedMangas, hasNextPage)
    }

    override fun fetchChapterList(manga: SManga): Observable<List<SChapter>> {
        val realChapters = listOf(
            SChapter.create().apply {
                url = manga.url
                name = "Chapter"
                chapter_number = 1f
            },
        )
        val chapters = if (getCacheServerUrlPref().isNotBlank()) {
            val gid = manga.url.split("/").getOrNull(2) ?: ""
            val browseChapter = SChapter.create().apply {
                name = "📖 浏览"
                url = MenuActions.menuUrl(MenuActions.ACTION_BROWSE, gid, manga.url)
                chapter_number = -4f
            }
            listOf(browseChapter) + realChapters
        } else {
            realChapters
        }
        return Observable.just(chapters)
    }

    override fun fetchPageList(chapter: SChapter): Observable<List<Page>> {
        if (chapter.url.startsWith(MenuActions.INTENT_PREFIX)) {
            if (MenuActions.parseAction(chapter.url) == MenuActions.ACTION_BROWSE) {
                return Observable.fromCallable {
                    browseFromCache(chapter.url)
                }
            }
            return Observable.just(MenuActions.generateMenuPages(chapter.url))
        }
        return fetchChapterPage(chapter, "$baseUrl/${chapter.url}").map {
            it.mapIndexed { i, s ->
                Page(i, s)
            }
        }!!
    }

    private fun browseFromCache(chapterUrl: String): List<Page> {
        val cacheUrl = getCacheServerUrlPref()
        if (cacheUrl.isBlank()) return emptyList()
        val gid = MenuActions.getQueryParam(chapterUrl, "gid") ?: return emptyList()

        // Strip /proxy suffix for API URLs and gallery file serving
        val apiBase = cacheUrl.trimEnd('/').removeSuffix("/proxy")

        try {
            val request = GET("$apiBase/api/browse?gid=$gid")
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: return emptyList()
            val json = org.json.JSONObject(body)

            if (json.optString("status") != "ready") {
                val msg = json.optString("message", "Gallery not ready")
                return listOf(
                    Page(0, MenuActions.INTENT_PREFIX).apply {
                        imageUrl = "$MenuActions.INTENT_PREFIX-browse-msg/$msg"
                    },
                )
            }

            val images = json.optJSONArray("images") ?: return emptyList()
            val pages = mutableListOf<Page>()
            for (i in 0 until images.length()) {
                val imgUrl = images.getString(i)
                val fullUrl = if (imgUrl.startsWith("http")) imgUrl else "$apiBase$imgUrl"
                pages.add(Page(i, fullUrl).apply { imageUrl = fullUrl })
            }
            return pages
        } catch (e: Exception) {
            return listOf(
                Page(0, MenuActions.INTENT_PREFIX).apply {
                    imageUrl = "$MenuActions.INTENT_PREFIX-browse-err/${e.message}"
                },
            )
        }
    }

    private fun buildActionResponse(chain: Interceptor.Chain, title: String, subtitle: String, isSuccess: Boolean, progress: Float? = null): Response {
        val width = 1080
        val height = 1920
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)

        val bgColor = when {
            progress != null && progress < 1f -> 0xFF1565C0.toInt()
            isSuccess -> 0xFF2E7D32.toInt()
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
        canvas.drawText(title, width / 2f, height / 2f - 120f, titlePaint)

        val subPaint = Paint().apply {
            color = 0xCCFFFFFF.toInt()
            textSize = 44f
            textAlign = Paint.Align.CENTER
            isAntiAlias = true
        }
        canvas.drawText(subtitle, width / 2f, height / 2f - 40f, subPaint)

        progress?.let { p ->
            if (p < 1f) {
                val barW = 720f
                val barH = 48f
                val barL = (width - barW) / 2f
                val barT = height / 2f + 60f
                val bgPaint = Paint().apply {
                    color = 0x33FFFFFF
                    style = Paint.Style.FILL
                }
                canvas.drawRoundRect(RectF(barL, barT, barL + barW, barT + barH), 24f, 24f, bgPaint)
                val fillPaint = Paint().apply {
                    color = 0xFF42A5F5.toInt()
                    style = Paint.Style.FILL
                }
                val fillR = barL + barW * p.coerceIn(0f, 1f)
                if (fillR > barL) canvas.drawRoundRect(RectF(barL, barT, fillR, barT + barH), 24f, 24f, fillPaint)
                val pctPaint = Paint().apply {
                    color = 0xFFFFFFFF.toInt()
                    textSize = 48f
                    textAlign = Paint.Align.CENTER
                    isAntiAlias = true
                    typeface = Typeface.DEFAULT_BOLD
                }
                canvas.drawText("${(p * 100).toInt()}%", width / 2f, barT + barH + 60f, pctPaint)
            }
        }

        val bos = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, bos)
        return Response.Builder()
            .code(200).message("OK")
            .body(bos.toByteArray().toResponseBody("image/png".toMediaType()))
            .request(chain.request())
            .protocol(Protocol.HTTP_1_1)
            .build()
    }

    override fun fetchImageUrl(page: Page): Observable<String> {
        val imageUrl = page.imageUrl
        if (imageUrl?.startsWith(MenuActions.INTENT_PREFIX) == true) {
            return Observable.just(imageUrl)
        }
        return super.fetchImageUrl(page)
    }

    override fun imageRequest(page: Page): Request {
        val imageUrl = page.imageUrl
        if (imageUrl?.startsWith(MenuActions.INTENT_PREFIX) == true) {
            return GET(imageUrl)
        }
        return super.imageRequest(page)
    }

    /**
     * Recursively fetch chapter pages
     */
    private fun fetchChapterPage(
        chapter: SChapter,
        np: String,
        pastUrls: List<String> = emptyList(),
    ): Observable<List<String>> {
        val urls = ArrayList(pastUrls)
        return chapterPageCall(np).flatMap {
            val jsoup = it.asJsoup()
            urls += parseChapterPage(jsoup)
            nextPageUrl(jsoup)?.let { string ->
                fetchChapterPage(chapter, string, urls)
            } ?: Observable.just(urls)
        }
    }

    private fun parseChapterPage(response: Element) = with(response) {
        select("#gdt a").map {
            it.attr("href")
        }
    }

    private fun chapterPageCall(np: String) = client.newCall(chapterPageRequest(np)).asObservableSuccess()
    private fun chapterPageRequest(np: String) = exGet(np, null, headers)

    private fun nextPageUrl(element: Element) = element.select("a[onclick=return false]").last()?.let {
        if (it.text() == ">") it.attr("href") else null
    }

    private fun languageTag(enforceLanguageFilter: Boolean = false): String = if (enforceLanguageFilter || getEnforceLanguagePref()) "language:$ehLang" else ""

    override fun popularMangaRequest(page: Int) = if (isLangNatural()) {
        exGet("$baseUrl/?f_search=${languageTag()}&f_srdd=5&f_sr=on", page)
    } else {
        latestUpdatesRequest(page)
    }

    override fun searchMangaRequest(page: Int, query: String, filters: FilterList): Request {
        val enforceLanguageFilter = filters.find { it is EnforceLanguageFilter }?.state == true
        val uri = Uri.parse("$baseUrl$QUERY_PREFIX").buildUpon()
        var modifiedQuery = when {
            !isLangNatural() -> query
            query.isBlank() -> languageTag(enforceLanguageFilter)
            else -> languageTag(enforceLanguageFilter).let { if (it.isNotEmpty()) "$query,$it" else query }
        }
        filters.filterIsInstance<TextFilter>().forEach { filter ->
            if (filter.state.isNotEmpty()) {
                val splitted = filter.state.split(",").filter(String::isNotBlank)
                if (splitted.size < 2 && filter.type != "tags") {
                    modifiedQuery += " ${filter.type}:\"${filter.state.replace(" ", "+")}\""
                } else {
                    splitted.forEach { tag ->
                        val trimmed = tag.trim().lowercase()
                        modifiedQuery += if (trimmed.startsWith('-')) {
                            " -${filter.type}:\"${trimmed.removePrefix("-").replace(" ", "+")}\""
                        } else {
                            " ${filter.type}:\"${trimmed.replace(" ", "+")}\""
                        }
                    }
                }
            }
        }
        uri.appendQueryParameter("f_search", modifiedQuery)
        // when attempting to search with no genres selected, will auto select all genres
        filters.filterIsInstance<GenreGroup>().firstOrNull()?.state?.let {
            // variable to to check is any genres are selected
            val check = it.any { option -> option.state } // or it.any(GenreOption::state)
            // if no genres are selected by the user set all genres to on
            if (!check) {
                for (i in it) {
                    i.state = true
                }
            }
        }

        filters.forEach {
            if (it is UriFilter) it.addToUri(uri)
        }

        if (uri.toString().contains("f_spf") || uri.toString().contains("f_spt")) {
            if (page > 1) uri.appendQueryParameter("from", lastMangaId)
        }

        return exGet(uri.toString(), page)
    }

    override fun latestUpdatesRequest(page: Int) = exGet(baseUrl, page)

    override fun popularMangaParse(response: Response) = genericMangaParse(response)
    override fun searchMangaParse(response: Response) = genericMangaParse(response)
    override fun latestUpdatesParse(response: Response) = genericMangaParse(response)

    private fun exGet(url: String, page: Int? = null, additionalHeaders: Headers? = null, cache: Boolean = true): Request {
        // pages no longer exist, if app attempts to go to the first page after a request, do not include the page append
        val pageIndex = if (page == 1) null else page
        return GET(
            pageIndex?.let {
                addParam(url, "next", lastMangaId)
            } ?: url,
            additionalHeaders?.let { header ->
                val headers = headers.newBuilder()
                header.toMultimap().forEach { (t, u) ->
                    u.forEach {
                        headers.add(t, it)
                    }
                }
                headers.build()
            } ?: headers,

        ).let {
            if (!cache) {
                it.newBuilder().cacheControl(CacheControl.FORCE_NETWORK).build()
            } else {
                it
            }
        }
    }

    /**
     * Parse gallery page to metadata model
     */
    @SuppressLint("DefaultLocale")
    override fun mangaDetailsParse(response: Response) = with(response.asJsoup()) {
        with(ExGalleryMetadata()) {
            url = response.request.url.encodedPath.removePrefix("/proxy")
            title = select("#gn").text().nullIfBlank()?.trim()

            altTitle = select("#gj").text().nullIfBlank()?.trim()

            // Thumbnail is set as background of element in style attribute
            thumbnailUrl = select("#gd1 div").attr("style").nullIfBlank()?.let {
                it.substring(it.indexOf('(') + 1 until it.lastIndexOf(')'))
            }
            genre = select("#gdc div").text().nullIfBlank()?.trim()?.lowercase()

            uploader = select("#gdn").text().nullIfBlank()?.trim()

            // Parse the table
            select("#gdd tr").forEach {
                it.select(".gdt1")
                    .text()
                    .nullIfBlank()
                    ?.trim()
                    ?.let { left ->
                        it.select(".gdt2")
                            .text()
                            .nullIfBlank()
                            ?.trim()
                            ?.let { right ->
                                ignore {
                                    when (
                                        left.removeSuffix(":")
                                            .lowercase()
                                    ) {
                                        "posted" -> datePosted = EX_DATE_FORMAT.parse(right)?.time ?: 0
                                        "visible" -> visible = right.nullIfBlank()
                                        "language" -> {
                                            language = right.removeSuffix(TR_SUFFIX).trim().nullIfBlank()
                                            translated = right.endsWith(TR_SUFFIX, true)
                                        }
                                        "file size" -> size = parseHumanReadableByteCount(right)?.toLong()
                                        "length" -> length = right.removeSuffix("pages").trim().nullIfBlank()?.toInt()
                                        "favorited" -> favorites = right.removeSuffix("times").trim().nullIfBlank()?.toInt()
                                    }
                                }
                            }
                    }
            }

            // Parse ratings
            ignore {
                averageRating = select("#rating_label")
                    .text()
                    .removePrefix("Average:")
                    .trim()
                    .nullIfBlank()
                    ?.toDouble()
                ratingCount = select("#rating_count")
                    .text()
                    .trim()
                    .nullIfBlank()
                    ?.toInt()
            }

            // Parse tags
            tags.clear()
            select("#taglist tr").forEach {
                val namespace = it.select(".tc").text().removeSuffix(":")
                val currentTags = it.select("div").map { element ->
                    Tag(
                        element.text().trim(),
                        element.hasClass("gtl"),
                    )
                }
                tags[namespace] = currentTags
            }

            // Add action tags if cache server is configured
            val rawUrl = url ?: ""
            // Strip /proxy prefix when going through cache server
            val cleanUrl = rawUrl.removePrefix("/proxy")
            val gid = cleanUrl.split("/").getOrNull(2) ?: ""
            if (gid.isNotEmpty()) {
                gidToGalleryPath[gid] = cleanUrl
                if (gidToGalleryPath.size > 100) gidToGalleryPath.clear()
            }

            if (!getTranslateTagServerUrlPref().isBlank()) tagTranslate(tags)

            // Copy metadata to manga
            SManga.create().apply {
                copyTo(this)
                update_strategy = UpdateStrategy.ONLY_FETCH_ONCE
                // Append clickable action genres (only when cache server is configured)
                if (getCacheServerUrlPref().isNotBlank() && gid.isNotEmpty()) {
                    val extras = "⚡dl:$gid, ⚡st:$gid"
                    genre = if (genre.isNullOrBlank()) extras else "$genre, $extras"
                }
            }
        }
    }

    private fun searchMangaByIdRequest(id: String) = GET("$baseUrl/g/$id", headers)

    private fun searchMangaByIdParse(response: Response, id: String): MangasPage {
        val details = mangaDetailsParse(response)
        details.url = "/g/$id/"
        return MangasPage(listOf(details), false)
    }

    // -----------------------------------------------------------------------
    // Action tags — intercept tag search, execute action, return fake result
    // -----------------------------------------------------------------------

    private fun executeActionTag(query: String): MangasPage {
        // Format: ⚡dl:gid, ⚡br:gid, ⚡st:gid
        val tag = query.trim()
        val colonIdx = tag.indexOf(':')
        if (colonIdx < 0) return MangasPage(emptyList(), false)
        val action = tag.substring(0, colonIdx) // ⚡dl, ⚡br, ⚡st
        val gid = tag.substring(colonIdx + 1).trim()

        val cacheUrl = getCacheServerUrlPref()
        val apiBase = cacheUrl.trimEnd('/').removeSuffix("/proxy")

        var resultMessage = ""

        when {
            action == "⚡dl" -> {
                val galleryPath = gidToGalleryPath[gid] ?: ""
                val galleryUrl = if (galleryPath.isNotEmpty()) "$baseUrl$galleryPath" else ""
                val jsonBody = """{"gid":"$gid","galleryUrl":"$galleryUrl","dltype":"res"}"""
                try {
                    val request = Request.Builder()
                        .url("$apiBase/api/download")
                        .addHeader("Content-Type", "application/json")
                        .post(jsonBody.toRequestBody("application/json".toMediaType()))
                        .build()
                    val resp = client.newCall(request).execute()
                    val body = resp.body?.string() ?: "{}"
                    val json = org.json.JSONObject(body)
                    val status = json.optString("status", "error")
                    resultMessage = if (status == "queued" || status == "already_queued") "✅ 下载已提交" else "❌ 下载失败"
                } catch (e: Exception) {
                    resultMessage = "❌ 网络错误"
                }
            }
            action == "⚡st" -> {
                try {
                    val request = Request.Builder()
                        .url("$apiBase/api/status?gid=$gid")
                        .build()
                    val resp = client.newCall(request).execute()
                    val body = resp.body?.string() ?: "{}"
                    val json = org.json.JSONObject(body)
                    val status = json.optString("status", "unknown")
                    val progress = json.optInt("progress", 0)
                    val error = json.optString("error", "")
                    resultMessage = when (status) {
                        "completed" -> "✅ 下载完成"
                        "downloading" -> "⬇ 下载中 $progress%"
                        "archiver_access" -> "🔄 连接存档中"
                        "extracting" -> "📦 解压中"
                        "queued" -> "⏳ 排队中"
                        "error" -> "❌ $error"
                        else -> "❓ 未知状态"
                    }
                } catch (e: Exception) {
                    resultMessage = "❌ 网络错误"
                }
            }
            else -> {
                resultMessage = "❓ 未知操作"
            }
        }

        val fakeManga = SManga.create().apply {
            title = resultMessage
            url = "/g/$gid/"
            thumbnail_url = "${MenuActions.INTENT_PREFIX}$ACTION_RESULT/$gid"
        }
        return MangasPage(listOf(fakeManga), false)
    }

    override fun fetchSearchManga(page: Int, query: String, filters: FilterList): Observable<MangasPage> = when {
        query.startsWith(PREFIX_ID_SEARCH) -> {
            val id = query.removePrefix(PREFIX_ID_SEARCH)
            client.newCall(searchMangaByIdRequest(id))
                .asObservableSuccess()
                .map { response -> searchMangaByIdParse(response, id) }
        }
        query.startsWith(ACTION_TAG_PREFIX) -> {
            Observable.fromCallable { executeActionTag(query) }
        }
        else -> super.fetchSearchManga(page, query, filters)
    }

    private fun tagTranslate(tags: MutableMap<String, List<Tag>>) {
        val allTagKeys = buildString {
            tags.forEach { (ns, list) ->
                list.forEach { tag ->
                    if (isNotEmpty()) append(',')
                    append(ns).append(':').append(tag.name)
                }
            }
        }
        if (allTagKeys.isBlank()) return
        val translatedMap = runCatching {
            val url = Uri.parse(getTranslateTagServerUrlPref())
                .buildUpon()
                .appendQueryParameter("tags", allTagKeys)
                .build()
                .toString()
            val request = GET(url)
            client.newCall(request).execute().use { resp ->
                resp.takeIf { it.isSuccessful }?.body?.string()
                    ?.parseAs<Map<String, String>>()
                    .orEmpty()
            }
        }.getOrDefault(emptyMap())
        if (translatedMap.isEmpty()) return
        translatedMap.forEach { (key, value) ->
            val (ns, name) = key.split(':', limit = 2)
            tags[ns]?.let { list ->
                tags[ns] = list.map {
                    if (it.name == name) it.copy(name = value) else it
                }
            }
        }
    }

    override fun chapterListParse(response: Response) = throw UnsupportedOperationException()

    override fun pageListParse(response: Response) = throw UnsupportedOperationException()

    override fun imageUrlParse(response: Response): String = imageUrlParse(response, true)

    private fun imageUrlParse(response: Response, isGetBakImageUrl: Boolean): String {
        val doc = response.asJsoup()
        val imgUrl = doc.select("#img").attr("abs:src")
        // from https://github.com/Miuzarte/EHentai-go/blob/dd9a24adb13300c028c35f53b9eff31b51966def/query.go#L695
        val nlValue = Regex("nl\\('(.+?)'\\)").find(doc.selectFirst("#loadfail")?.attr("onclick").orEmpty())?.groupValues?.get(1)

        // from https://github.com/ccloli/E-Hentai-Downloader/blob/c51e1118def7541b5fbb224f7e512e170f4b9d5e/src/main.js#L2444
        if (getOriginalImagePref()) {
            val originalUrl = doc.selectFirst("a[href*=/fullimg/]")?.attr("abs:href")
            if (!originalUrl.isNullOrEmpty()) {
                return originalUrl.toHttpUrl()
                    .newBuilder()
                    .addQueryParameter("nl", nlValue)
                    .build()
                    .toString()
            }
        }

        if (!isGetBakImageUrl) {
            return imgUrl
        }

        if (nlValue.isNullOrEmpty()) return imgUrl
        val bakUrl = response.request.url.newBuilder()
            .addQueryParameter("nl", nlValue)
            .toString()
        return "$imgUrl#$bakUrl"
    }

    private val cookiesHeader by lazy {
        val cookies = mutableMapOf<String, String>()

        // Setup settings
        val settings = mutableListOf<String>()

        // Do not show popular right now pane as we can't parse it
        settings += "prn_n"

        // Exclude every other language except the one we have selected
        settings += "xl_" + languageMappings.filter { it.first != ehLang }
            .flatMap { it.second }
            .joinToString("x")

        cookies["uconfig"] = buildSettings(settings)

        // Bypass "Offensive For Everyone" content warning
        cookies["nw"] = "1"

        cookies["ipb_member_id"] = memberId

        cookies["ipb_pass_hash"] = passHash

        cookies["igneous"] = igneous

        buildCookies(cookies)
    }

    // Headers
    override fun headersBuilder() = super.headersBuilder().add("Cookie", cookiesHeader)

    private fun buildSettings(settings: List<String?>) = settings.filterNotNull().joinToString(separator = "-")

    private fun buildCookies(cookies: Map<String, String>) = cookies.entries.joinToString(separator = "; ", postfix = ";") {
        "${URLEncoder.encode(it.key, "UTF-8")}=${URLEncoder.encode(it.value, "UTF-8")}"
    }

    @Suppress("SameParameterValue")
    private fun addParam(url: String, param: String, value: String) = Uri.parse(url)
        .buildUpon()
        .appendQueryParameter(param, value)
        .toString()

    override val client = network.cloudflareClient.newBuilder()
        .cookieJar(CookieJar.NO_COOKIES)
        .dispatcher(
            Dispatcher().apply {
                maxRequests = 64
                maxRequestsPerHost = 64
            },
        )
        .addInterceptor { chain ->
            val url = chain.request().url.toString()
            val cacheUrl = getCacheServerUrlPref()

            // Handle menu action page image requests (bitmap rendering)
            if (url.startsWith(MenuActions.INTENT_PREFIX)) {
                val action = MenuActions.parseAction(url) ?: return@addInterceptor chain.proceed(chain.request())

                // Action-tag search result thumbnail
                if (action == ACTION_RESULT) {
                    val gid = url.removePrefix(MenuActions.INTENT_PREFIX)
                        .removePrefix("$ACTION_RESULT/").trimEnd('/').substringBefore("?")
                    val msg = "GID: $gid"
                    return@addInterceptor buildActionResponse(chain, "操作结果", msg, true, 1f)
                }

                // Try scenario-based response (existing menu pages)
                val scenarioResp = MenuActions.buildImageResponse(url, chain)
                if (scenarioResp != null) return@addInterceptor scenarioResp

                // Handle browse-msg / browse-err or other unknown intent URLs
                val errMsg = when {
                    action.startsWith("browse-msg/") -> action.removePrefix("browse-msg/")
                    action.startsWith("browse-err/") -> "Error: ${action.removePrefix("browse-err/")}"
                    else -> "Unknown action: $action"
                }
                return@addInterceptor buildActionResponse(chain, errMsg, "GID: ${MenuActions.getQueryParam(url, "gid")}", false)
            }
            chain.proceed(chain.request())
        }
        .addInterceptor { chain ->
            val cacheUrl = getCacheServerUrlPref()
            Log.d("EHCache", "cacheUrl from pref: '$cacheUrl'")
            if (cacheUrl.isNotBlank()) {
                val original = chain.request()
                val originalUrl = original.url
                val cacheHttpUrl = cacheUrl.trimEnd('/').toHttpUrl()

                // Skip rewrite if URL already points to the cache server (e.g. browse gallery images)
                if (originalUrl.host == cacheHttpUrl.host && originalUrl.port == cacheHttpUrl.port) {
                    return@addInterceptor chain.proceed(original)
                }

                val newUrl = originalUrl.newBuilder()
                    .scheme(cacheHttpUrl.scheme)
                    .host(cacheHttpUrl.host)
                    .port(cacheHttpUrl.port)
                    .encodedPath("/proxy${originalUrl.encodedPath}")
                    .build()
                Log.d("EHCache", "rewritten URL: $newUrl")
                val newRequest = original.newBuilder()
                    .url(newUrl)
                    .removeHeader("X-Original-Host")
                    .addHeader("X-Original-Host", originalUrl.host)
                    .build()
                return@addInterceptor chain.proceed(newRequest)
            }
            chain.proceed(chain.request())
        }
        .addInterceptor { chain ->
            val request = chain.request()
            val result = runCatching { chain.proceed(request) }
            val bakUrl = request.url.fragment
                ?: return@addInterceptor result.getOrThrow()

            if (result.isFailure || result.getOrNull()?.isSuccessful != true) {
                result.getOrNull()?.close()
                val newRequest = GET(bakUrl, headers)
                val newImageUrl = imageUrlParse(chain.proceed(newRequest), false)
                val newImageRequest = request.newBuilder()
                    .url(newImageUrl)
                    .build()

                // Rewrite backup image URL through cache server (Interceptor chain
                // doesn't loop back to Cache Rewrite, so we do it manually here)
                val cacheUrl = getCacheServerUrlPref()
                if (cacheUrl.isNotBlank()) {
                    try {
                        val cacheHttpUrl = cacheUrl.trimEnd('/').toHttpUrl()
                        val imageHttpUrl = newImageUrl.toHttpUrl()
                        val proxiedUrl = imageHttpUrl.newBuilder()
                            .scheme(cacheHttpUrl.scheme)
                            .host(cacheHttpUrl.host)
                            .port(cacheHttpUrl.port)
                            .encodedPath("/proxy${imageHttpUrl.encodedPath}")
                            .build()
                        val finalRequest = newImageRequest.newBuilder()
                            .url(proxiedUrl)
                            .removeHeader("X-Original-Host")
                            .addHeader("X-Original-Host", imageHttpUrl.host)
                            .build()
                        return@addInterceptor chain.proceed(finalRequest)
                    } catch (_: Exception) {}
                }
                chain.proceed(newImageRequest)
            } else {
                result.getOrThrow()
            }
        }
        .addInterceptor { chain ->
            val newReq = chain
                .request()
                .newBuilder()
                .removeHeader("Cookie")
                .addHeader("Cookie", cookiesHeader)
                .build()

            chain.proceed(newReq)
        }.build()

    // Filters
    override fun getFilterList() = FilterList(
        EnforceLanguageFilter(getEnforceLanguagePref()),
        Favorites(),
        Watched(),
        GenreGroup(),
        Filter.Header("Separate tags with commas (,)"),
        Filter.Header("Prepend with dash (-) to exclude"),
        Filter.Header("Use 'Female Tags' or 'Male Tags' for specific categories. 'Tags' searches all categories."),
        TextFilter("Tags", "tag"),
        TextFilter("Female Tags", "female"),
        TextFilter("Male Tags", "male"),
        AdvancedGroup(),
    )

    internal open class TextFilter(name: String, val type: String, val specific: String = "") : Filter.Text(name)

    class Watched :
        CheckBox("Watched List"),
        UriFilter {
        override fun addToUri(builder: Uri.Builder) {
            if (state) {
                builder.appendPath("watched")
            }
        }
    }

    class Favorites :
        CheckBox("Favorites"),
        UriFilter {
        override fun addToUri(builder: Uri.Builder) {
            if (state) {
                builder.appendPath("favorites.php")
            }
        }
    }

    class GenreOption(name: String, private val genreId: String) :
        CheckBox(name, false),
        UriFilter {
        override fun addToUri(builder: Uri.Builder) {
            builder.appendQueryParameter("f_$genreId", if (state) "1" else "0")
        }
    }

    class GenreGroup :
        UriGroup<GenreOption>(
            "Genres",
            listOf(
                GenreOption("Dōjinshi", "doujinshi"),
                GenreOption("Manga", "manga"),
                GenreOption("Artist CG", "artistcg"),
                GenreOption("Game CG", "gamecg"),
                GenreOption("Western", "western"),
                GenreOption("Non-H", "non-h"),
                GenreOption("Image Set", "imageset"),
                GenreOption("Cosplay", "cosplay"),
                GenreOption("Asian Porn", "asianporn"),
                GenreOption("Misc", "misc"),
            ),
        )

    class AdvancedOption(name: String, private val param: String, defValue: Boolean = false) :
        CheckBox(name, defValue),
        UriFilter {
        override fun addToUri(builder: Uri.Builder) {
            if (state) {
                builder.appendQueryParameter(param, "on")
            }
        }
    }

    open class PageOption(name: String, private val queryKey: String) :
        Text(name),
        UriFilter {
        override fun addToUri(builder: Uri.Builder) {
            if (state.isNotBlank()) {
                if (builder.build().getQueryParameters("f_sp").isEmpty()) {
                    builder.appendQueryParameter("f_sp", "on")
                }

                builder.appendQueryParameter(queryKey, state.trim())
            }
        }
    }

    class MinPagesOption : PageOption("Minimum Pages", "f_spf")
    class MaxPagesOption : PageOption("Maximum Pages", "f_spt")

    class RatingOption :
        Select<String>(
            "Minimum Rating",
            arrayOf(
                "Any",
                "2 stars",
                "3 stars",
                "4 stars",
                "5 stars",
            ),
        ),
        UriFilter {
        override fun addToUri(builder: Uri.Builder) {
            if (state > 0) {
                builder.appendQueryParameter("f_srdd", (state + 1).toString())
                builder.appendQueryParameter("f_sr", "on")
            }
        }
    }

    // Explicit type arg for listOf() to workaround this: KT-16570
    class AdvancedGroup :
        UriGroup<Filter<*>>(
            "Advanced Options",
            listOf(
                AdvancedOption("Search Gallery Name", "f_sname", true),
                AdvancedOption("Search Gallery Tags", "f_stags", true),
                AdvancedOption("Search Gallery Description", "f_sdesc"),
                AdvancedOption("Search Torrent Filenames", "f_storr"),
                AdvancedOption("Only Show Galleries With Torrents", "f_sto"),
                AdvancedOption("Search Low-Power Tags", "f_sdt1"),
                AdvancedOption("Search Downvoted Tags", "f_sdt2"),
                AdvancedOption("Show Expunged Galleries", "f_sh"),
                RatingOption(),
                MinPagesOption(),
                MaxPagesOption(),
            ),
        )

    private class EnforceLanguageFilter(default: Boolean) : CheckBox("Enforce language", default)

    // map languages to their internal ids
    private val languageMappings = listOf(
        Pair("japanese", listOf("0", "1024", "2048")),
        Pair("english", listOf("1", "1025", "2049")),
        Pair("chinese", listOf("10", "1034", "2058")),
        Pair("dutch", listOf("20", "1044", "2068")),
        Pair("french", listOf("30", "1054", "2078")),
        Pair("german", listOf("40", "1064", "2088")),
        Pair("hungarian", listOf("50", "1074", "2098")),
        Pair("italian", listOf("60", "1084", "2108")),
        Pair("korean", listOf("70", "1094", "2118")),
        Pair("polish", listOf("80", "1104", "2128")),
        Pair("portuguese", listOf("90", "1114", "2138")),
        Pair("russian", listOf("100", "1124", "2148")),
        Pair("spanish", listOf("110", "1134", "2158")),
        Pair("thai", listOf("120", "1144", "2168")),
        Pair("vietnamese", listOf("130", "1154", "2178")),
        Pair("n/a", listOf("254", "1278", "2302")),
        Pair("other", listOf("255", "1279", "2303")),
    )

    companion object {
        const val ACTION_TAG_PREFIX = "⚡"
        const val ACTION_RESULT = "action-result"
        const val QUERY_PREFIX = "?f_apply=Apply+Filter"
        const val PREFIX_ID_SEARCH = "id:"
        const val TR_SUFFIX = "TR"

        // Preferences vals
        private const val ENFORCE_LANGUAGE_PREF_KEY = "ENFORCE_LANGUAGE"
        private const val ENFORCE_LANGUAGE_PREF_TITLE = "Enforce Language"
        private const val ENFORCE_LANGUAGE_PREF_SUMMARY = "If checked, forces browsing of manga matching a language tag"
        private const val ENFORCE_LANGUAGE_PREF_DEFAULT_VALUE = false

        private const val ORIGINAL_IMAGE_PREF_KEY = "ORIGINAL_IMAGE"
        private const val ORIGINAL_IMAGE_PREF_TITLE = "Original Image"
        private const val ORIGINAL_IMAGE_PREF_SUMMARY = "If checked, if your account has permission, it will use the original image and the image enhancement process will be slower"
        private const val ORIGINAL_IMAGE_PREF_DEFAULT_VALUE = false

        private const val MEMBER_ID_PREF_KEY = "MEMBER_ID"
        private const val MEMBER_ID_PREF_TITLE = "ipb_member_id"
        private const val MEMBER_ID_PREF_SUMMARY = "ipb_member_id value"
        private const val MEMBER_ID_PREF_DEFAULT_VALUE = ""

        private const val PASS_HASH_PREF_KEY = "PASS_HASH"
        private const val PASS_HASH_PREF_TITLE = "ipb_pass_hash"
        private const val PASS_HASH_PREF_SUMMARY = "ipb_pass_hash value"
        private const val PASS_HASH_PREF_DEFAULT_VALUE = ""

        private const val IGNEOUS_PREF_KEY = "IGNEOUS"
        private const val IGNEOUS_PREF_TITLE = "igneous"
        private const val IGNEOUS_PREF_SUMMARY = "igneous value override"
        private const val IGNEOUS_PREF_DEFAULT_VALUE = ""

        private const val FORCE_EH = "FORCE_EH"
        private const val FORCE_EH_TITLE = "Force e-hentai"
        private const val FORCE_EH_SUMMARY = "Force e-hentai to avoid content on exhentai"
        private const val FORCE_EH_DEFAULT_VALUE = true

        private const val TRANSLATE_TAG_SERVER_URL_PREF_KEY = "TRANSLATE_TAG_SERVER_URL"
        private const val TRANSLATE_TAG_SERVER_URL_PREF_TITLE = "Tag translation server URL"
        private const val TRANSLATE_TAG_SERVER_URL_PREF_SUMMARY = "URL of the tag translation server"
        private const val TRANSLATE_TAG_SERVER_URL_PREF_DEFAULT_VALUE = ""

        private const val CACHE_SERVER_URL_PREF_KEY = "CACHE_SERVER_URL"
        private const val CACHE_SERVER_URL_PREF_TITLE = "Cache Server URL"
        private const val CACHE_SERVER_URL_PREF_SUMMARY = "Local cache server URL (e.g. http://192.168.1.100:8080). When set, all requests go through this server."
        private const val CACHE_SERVER_URL_PREF_DEFAULT_VALUE = ""
    }

    // Preferences

    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val forceEhPref = CheckBoxPreference(screen.context).apply {
            key = FORCE_EH
            title = FORCE_EH_TITLE
            summary = FORCE_EH_SUMMARY
            setDefaultValue(FORCE_EH_DEFAULT_VALUE)
        }

        val enforceLanguagePref = CheckBoxPreference(screen.context).apply {
            key = "${ENFORCE_LANGUAGE_PREF_KEY}_$lang"
            title = ENFORCE_LANGUAGE_PREF_TITLE
            summary = ENFORCE_LANGUAGE_PREF_SUMMARY
            setDefaultValue(ENFORCE_LANGUAGE_PREF_DEFAULT_VALUE)
        }

        val originalImagePref = CheckBoxPreference(screen.context).apply {
            key = "${ORIGINAL_IMAGE_PREF_KEY}_$lang"
            title = ORIGINAL_IMAGE_PREF_TITLE
            summary = ORIGINAL_IMAGE_PREF_SUMMARY
            setDefaultValue(ORIGINAL_IMAGE_PREF_DEFAULT_VALUE)
        }

        val memberIdPref = EditTextPreference(screen.context).apply {
            key = MEMBER_ID_PREF_KEY
            title = MEMBER_ID_PREF_TITLE
            summary = MEMBER_ID_PREF_SUMMARY

            setDefaultValue(MEMBER_ID_PREF_DEFAULT_VALUE)
        }

        val passHashPref = EditTextPreference(screen.context).apply {
            key = PASS_HASH_PREF_KEY
            title = PASS_HASH_PREF_TITLE
            summary = PASS_HASH_PREF_SUMMARY

            setDefaultValue(PASS_HASH_PREF_DEFAULT_VALUE)
        }

        val igneousPref = EditTextPreference(screen.context).apply {
            key = IGNEOUS_PREF_KEY
            title = IGNEOUS_PREF_TITLE
            summary = IGNEOUS_PREF_SUMMARY

            setDefaultValue(IGNEOUS_PREF_DEFAULT_VALUE)
        }

        val translateTagServerUrlPref = EditTextPreference(screen.context).apply {
            key = TRANSLATE_TAG_SERVER_URL_PREF_KEY
            title = TRANSLATE_TAG_SERVER_URL_PREF_TITLE
            summary = TRANSLATE_TAG_SERVER_URL_PREF_SUMMARY
            setDefaultValue(TRANSLATE_TAG_SERVER_URL_PREF_DEFAULT_VALUE)
        }

        val cacheServerUrlPref = EditTextPreference(screen.context).apply {
            key = CACHE_SERVER_URL_PREF_KEY
            title = CACHE_SERVER_URL_PREF_TITLE
            summary = CACHE_SERVER_URL_PREF_SUMMARY
            setDefaultValue(CACHE_SERVER_URL_PREF_DEFAULT_VALUE)
        }

        screen.addPreference(cacheServerUrlPref)
        screen.addPreference(forceEhPref)
        screen.addPreference(memberIdPref)
        screen.addPreference(passHashPref)
        screen.addPreference(igneousPref)
        screen.addPreference(translateTagServerUrlPref)
        screen.addPreference(originalImagePref)
        screen.addPreference(enforceLanguagePref)
    }

    private fun getEnforceLanguagePref(): Boolean = preferences.getBoolean("${ENFORCE_LANGUAGE_PREF_KEY}_$lang", ENFORCE_LANGUAGE_PREF_DEFAULT_VALUE)

    private fun getOriginalImagePref(): Boolean = preferences.getBoolean("${ORIGINAL_IMAGE_PREF_KEY}_$lang", ORIGINAL_IMAGE_PREF_DEFAULT_VALUE)

    private fun getTranslateTagServerUrlPref(): String = preferences.getString(TRANSLATE_TAG_SERVER_URL_PREF_KEY, TRANSLATE_TAG_SERVER_URL_PREF_DEFAULT_VALUE)
        ?: TRANSLATE_TAG_SERVER_URL_PREF_DEFAULT_VALUE

    private fun getCacheServerUrlPref(): String = preferences.getString(CACHE_SERVER_URL_PREF_KEY, CACHE_SERVER_URL_PREF_DEFAULT_VALUE)
        ?: CACHE_SERVER_URL_PREF_DEFAULT_VALUE

    private fun getCookieValue(cookieTitle: String, defaultValue: String, prefKey: String): String {
        val cookies = webViewCookieManager.getCookie("https://forums.e-hentai.org")
        var value: String? = null

        if (cookies != null) {
            val cookieArray = cookies.split("; ")
            for (cookie in cookieArray) {
                if (cookie.startsWith("$cookieTitle=")) {
                    value = cookie.split("=")[1]

                    break
                }
            }
        }

        if (value == null) {
            value = preferences.getString(prefKey, defaultValue) ?: defaultValue
        }

        return value
    }

    private fun getPassHashPref(): String = getCookieValue(PASS_HASH_PREF_TITLE, PASS_HASH_PREF_DEFAULT_VALUE, PASS_HASH_PREF_KEY)

    private fun getMemberIdPref(): String = getCookieValue(MEMBER_ID_PREF_TITLE, MEMBER_ID_PREF_DEFAULT_VALUE, MEMBER_ID_PREF_KEY)

    private fun getIgneousPref(): String = getCookieValue(IGNEOUS_PREF_TITLE, IGNEOUS_PREF_DEFAULT_VALUE, IGNEOUS_PREF_KEY)

    private fun getForceEhPref(): Boolean = preferences.getBoolean(FORCE_EH, FORCE_EH_DEFAULT_VALUE)
}
