/*
 * Anime Hub Dictionary - data layer.
 *
 *  - AniList GraphQL API (https://docs.anilist.co)   -> everything about anime, manga and characters
 *  - Jikan REST API      (https://jikan.moe)         -> MyAnimeList score and opening/ending themes
 *  - trace.moe API       (https://soruly.github.io/trace.moe-api/) -> "which anime is this screenshot from?"
 *
 * AniList allows only a small number of requests per minute, can answer 200 with an `errors`
 * array, and only guarantees `pageInfo.hasNextPage`. This file handles all of that so the UI
 * does not have to: response caching, de-duplication of identical in-flight requests, a client
 * side request budget, automatic wait-and-retry on 429, timeouts and typed errors.
 */
(function () {
  "use strict";

  const AW = (window.AnimeWiki = window.AnimeWiki || {});
  const { sleep, clamp, safeUrl, seasonOf, nextSeasonOf } = AW.utils;

  const ANILIST_URL = "https://graphql.anilist.co";
  const JIKAN_URL = "https://api.jikan.moe/v4";
  const TRACE_URL = "https://api.trace.moe";

  const REQUEST_TIMEOUT = 20000;
  const MINUTE = 60000;
  const PAGE_SIZE = 24;

  class ApiError extends Error {
    /** kind: network | timeout | rate-limit | not-found | unavailable | graphql | server | http | invalid | trace */
    constructor(message, kind, status) {
      super(message);
      this.name = "ApiError";
      this.kind = kind;
      this.status = status || 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Tiny event emitter (used to tell the UI about rate-limit waits)     */
  /* ------------------------------------------------------------------ */

  const listeners = {};

  function on(event, callback) {
    (listeners[event] = listeners[event] || []).push(callback);
  }

  function emit(event, detail) {
    (listeners[event] || []).forEach((callback) => {
      try {
        callback(detail);
      } catch (err) {
        console.error(err);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Cache: memory first, sessionStorage so a reload costs no requests   */
  /* ------------------------------------------------------------------ */

  const CACHE_PREFIX = "aw:cache:v2:";
  const memory = new Map();
  const inflight = new Map();

  function cacheGet(key, ttl) {
    const now = Date.now();
    let entry = memory.get(key);
    if (!entry) {
      try {
        const stored = window.sessionStorage.getItem(CACHE_PREFIX + key);
        if (stored) {
          entry = JSON.parse(stored);
          if (entry && typeof entry.t === "number") memory.set(key, entry);
        }
      } catch (err) {
        entry = null;
      }
    }
    if (!entry || typeof entry.t !== "number" || now - entry.t > ttl) return undefined;
    return entry.d;
  }

  function clearStoredCache() {
    try {
      const doomed = [];
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i);
        if (key && key.indexOf("aw:cache:") === 0) doomed.push(key);
      }
      doomed.forEach((key) => window.sessionStorage.removeItem(key));
    } catch (err) {
      /* storage unavailable - nothing to clear */
    }
  }

  function cacheSet(key, data) {
    const entry = { t: Date.now(), d: data };
    memory.set(key, entry);
    if (memory.size > 200) memory.delete(memory.keys().next().value);
    let serialized;
    try {
      serialized = JSON.stringify(entry);
      window.sessionStorage.setItem(CACHE_PREFIX + key, serialized);
    } catch (err) {
      // Most likely the quota: drop our old entries and try once more.
      clearStoredCache();
      try {
        if (serialized) window.sessionStorage.setItem(CACHE_PREFIX + key, serialized);
      } catch (err2) {
        /* memory cache still works */
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* AniList request budget                                              */
  /* ------------------------------------------------------------------ */

  const rate = { limit: 30, stamps: [], blockedUntil: 0 };

  /** Resolves when sending one more request stays inside the per-minute budget. */
  async function waitForSlot() {
    for (;;) {
      const now = Date.now();
      rate.stamps = rate.stamps.filter((t) => now - t < MINUTE);
      const budget = Math.max(5, rate.limit - 3);
      let wait = 0;
      if (rate.blockedUntil > now) wait = rate.blockedUntil - now;
      else if (rate.stamps.length >= budget) wait = rate.stamps[0] + MINUTE - now;
      if (wait <= 0) {
        rate.stamps.push(now);
        return;
      }
      emit("ratelimit", { waitMs: wait });
      await sleep(wait + 250);
    }
  }

  function readRateHeaders(response) {
    const limit = parseInt(response.headers.get("X-RateLimit-Limit"), 10);
    const remaining = parseInt(response.headers.get("X-RateLimit-Remaining"), 10);
    if (limit > 0) rate.limit = limit;
    if (limit > 0 && remaining >= 0) {
      // Other tabs share the same allowance - trust the server's count over our own.
      const now = Date.now();
      while (rate.stamps.length < limit - remaining) rate.stamps.push(now);
    }
  }

  function cleanVariables(variables) {
    const out = {};
    Object.keys(variables || {}).forEach((key) => {
      const value = variables[key];
      if (value === undefined || value === null || value === "") return;
      if (Array.isArray(value) && value.length === 0) return;
      out[key] = value;
    });
    return out;
  }

  async function sendAniList(query, variables, attempt) {
    await waitForSlot();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    let response;
    let json = null;
    try {
      response = await fetch(ANILIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      });
      json = await response.json().catch(() => null);
    } catch (err) {
      if (controller.signal.aborted) throw new ApiError("AniList took too long to respond.", "timeout");
      if (attempt < 1 && navigator.onLine !== false) {
        await sleep(900);
        return sendAniList(query, variables, attempt + 1);
      }
      throw new ApiError(
        navigator.onLine === false ? "You appear to be offline." : "Could not reach AniList. Check your connection.",
        "network"
      );
    } finally {
      clearTimeout(timer);
    }

    readRateHeaders(response);
    const gqlError = json && Array.isArray(json.errors) && json.errors.length ? json.errors[0] : null;
    const status = (gqlError && gqlError.status) || response.status;

    if (status === 429) {
      const retryAfter = parseInt(response.headers.get("Retry-After"), 10);
      const reset = parseInt(response.headers.get("X-RateLimit-Reset"), 10);
      let wait = MINUTE;
      if (retryAfter > 0) wait = retryAfter * 1000;
      else if (reset > 0) wait = reset * 1000 - Date.now();
      // The server has told us exactly when to come back, so our own tally is obsolete.
      rate.blockedUntil = Date.now() + clamp(wait, 1000, 70000);
      rate.stamps = [];
      if (attempt < 1) return sendAniList(query, variables, attempt + 1);
      throw new ApiError("AniList is rate limiting requests. Please wait a minute and try again.", "rate-limit", 429);
    }
    // Errors can arrive with HTTP 200, so the `errors` array is always checked.
    if (gqlError) {
      if (status === 404) throw new ApiError("That entry does not exist on AniList.", "not-found", 404);
      if (status === 403) {
        throw new ApiError(gqlError.message || "The AniList API is temporarily unavailable.", "unavailable", 403);
      }
      throw new ApiError(gqlError.message || "AniList returned an error.", "graphql", status);
    }
    if (response.status >= 500) {
      if (attempt < 1) {
        await sleep(1200);
        return sendAniList(query, variables, attempt + 1);
      }
      throw new ApiError("AniList is having server trouble (HTTP " + response.status + ").", "server", response.status);
    }
    if (!response.ok) throw new ApiError("AniList responded with HTTP " + response.status + ".", "http", response.status);
    if (!json || !json.data) throw new ApiError("AniList sent an unexpected response.", "invalid", response.status);
    return json.data;
  }

  /**
   * Run a named AniList query. Identical requests are answered from cache or share one
   * network call, which matters with a budget of a few dozen requests per minute.
   */
  async function anilist(name, query, variables, ttl) {
    const vars = cleanVariables(variables);
    const key = name + ":" + JSON.stringify(vars);
    if (ttl > 0) {
      const hit = cacheGet(key, ttl);
      if (hit !== undefined) return hit;
    }
    if (inflight.has(key)) return inflight.get(key);

    const promise = sendAniList(query, vars, 0).then((data) => {
      if (ttl > 0) cacheSet(key, data);
      return data;
    });
    inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(key);
    }
  }

  /* ------------------------------------------------------------------ */
  /* GraphQL documents                                                   */
  /* ------------------------------------------------------------------ */

  const CARD_FRAGMENT = `
    fragment card on Media {
      id type format status
      title { romaji english native }
      coverImage { extraLarge large color }
      averageScore popularity episodes chapters season seasonYear
      startDate { year }
      genres
      nextAiringEpisode { episode airingAt }
    }`;

  // Six lists and the genre collection in ONE request, using aliases.
  // (Each Page may contain only one data field, so every list gets its own Page.)
  const HOME_QUERY = `
    query Home($season: MediaSeason, $seasonYear: Int, $nextSeason: MediaSeason, $nextYear: Int) {
      trending: Page(perPage: 12) {
        media(type: ANIME, sort: TRENDING_DESC, isAdult: false) { ...card bannerImage description(asHtml: false) }
      }
      season: Page(perPage: 18) {
        media(type: ANIME, season: $season, seasonYear: $seasonYear, sort: POPULARITY_DESC, isAdult: false) { ...card }
      }
      upcoming: Page(perPage: 18) {
        media(type: ANIME, season: $nextSeason, seasonYear: $nextYear, sort: POPULARITY_DESC, isAdult: false) { ...card }
      }
      top: Page(perPage: 18) {
        media(type: ANIME, sort: SCORE_DESC, isAdult: false) { ...card }
      }
      airing: Page(perPage: 30) {
        media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC, isAdult: false) { ...card }
      }
      manga: Page(perPage: 18) {
        media(type: MANGA, sort: TRENDING_DESC, isAdult: false) { ...card }
      }
      genres: GenreCollection
    }
    ${CARD_FRAGMENT}`;

  const SEARCH_MEDIA_QUERY = `
    query SearchMedia(
      $page: Int, $perPage: Int, $search: String, $type: MediaType, $genre: [String],
      $seasonYear: Int, $year: String, $season: MediaSeason, $format: MediaFormat,
      $status: MediaStatus, $sort: [MediaSort]
    ) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage currentPage }
        media(
          search: $search, type: $type, genre_in: $genre, seasonYear: $seasonYear, startDate_like: $year,
          season: $season, format: $format, status: $status, sort: $sort, isAdult: false
        ) { ...card }
      }
    }
    ${CARD_FRAGMENT}`;

  const SEARCH_CHARACTERS_QUERY = `
    query SearchCharacters($page: Int, $perPage: Int, $search: String, $sort: [CharacterSort]) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage currentPage }
        characters(search: $search, sort: $sort) {
          id name { full native } image { large } favourites gender age
          media(perPage: 1, sort: POPULARITY_DESC) { nodes { id type isAdult title { romaji english native } } }
        }
      }
    }`;

  const MEDIA_QUERY = `
    query MediaDetail($id: Int) {
      Media(id: $id) {
        id idMal type format status
        title { romaji english native }
        description(asHtml: true)
        coverImage { extraLarge large color }
        bannerImage
        season seasonYear
        startDate { year month day } endDate { year month day }
        episodes duration chapters volumes source countryOfOrigin
        averageScore meanScore popularity favourites
        genres synonyms siteUrl isAdult
        tags { name rank isMediaSpoiler isGeneralSpoiler }
        studios { edges { isMain node { id name } } }
        nextAiringEpisode { episode airingAt }
        trailer { id site thumbnail }
        externalLinks { url site type language color }
        rankings { rank type format year season allTime context }
        stats { scoreDistribution { score amount } }
        characters(sort: [ROLE, RELEVANCE, ID], perPage: 12) {
          edges {
            role
            node { id name { full } image { medium } }
            voiceActors(language: JAPANESE, sort: [RELEVANCE, ID]) { id name { full } image { medium } }
          }
        }
        staff(sort: [RELEVANCE, ID], perPage: 6) { edges { role node { id name { full } image { medium } } } }
        relations {
          edges {
            relationType(version: 2)
            node { id type format status isAdult title { romaji english native } coverImage { large color } }
          }
        }
        recommendations(sort: RATING_DESC, perPage: 10) {
          nodes {
            mediaRecommendation {
              id type format isAdult title { romaji english native } coverImage { large color } averageScore
            }
          }
        }
      }
    }`;

  const CHARACTER_QUERY = `
    query CharacterDetail($id: Int) {
      Character(id: $id) {
        id name { full native alternative } image { large }
        description(asHtml: true)
        gender age bloodType dateOfBirth { year month day } favourites siteUrl
        media(sort: POPULARITY_DESC, perPage: 12) {
          edges {
            characterRole
            node { id type format isAdult title { romaji english native } coverImage { large color } averageScore }
            voiceActors(language: JAPANESE, sort: [RELEVANCE, ID]) { id name { full } image { medium } }
          }
        }
      }
    }`;

  const RANDOM_QUERY = `
    query RandomAnime($page: Int) {
      Page(page: $page, perPage: 1) {
        media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) { id }
      }
    }`;

  /* ------------------------------------------------------------------ */
  /* AniList - public functions                                          */
  /* ------------------------------------------------------------------ */

  const list = (page) => ((page && page.media) || []).filter(Boolean);

  async function home() {
    const current = seasonOf(new Date());
    const next = nextSeasonOf(current);
    const data = await anilist(
      "home",
      HOME_QUERY,
      { season: current.season, seasonYear: current.year, nextSeason: next.season, nextYear: next.year },
      10 * MINUTE
    );
    const now = Date.now() / 1000;
    return {
      current,
      next,
      trending: list(data.trending),
      season: list(data.season),
      upcoming: list(data.upcoming),
      top: list(data.top),
      manga: list(data.manga),
      airing: list(data.airing)
        .filter((m) => m.nextAiringEpisode && m.nextAiringEpisode.airingAt > now)
        .sort((a, b) => a.nextAiringEpisode.airingAt - b.nextAiringEpisode.airingAt)
        .slice(0, 18),
      genres: (data.genres || []).filter((genre) => genre && genre !== "Hentai")
    };
  }

  const MEDIA_SORTS = {
    popularity: "POPULARITY_DESC",
    score: "SCORE_DESC",
    trending: "TRENDING_DESC",
    newest: "START_DATE_DESC",
    favourites: "FAVOURITES_DESC",
    title: "TITLE_ROMAJI"
  };

  /** filters: { type: ANIME|MANGA, q, genre, year, season, format, status, sort } */
  async function searchMedia(filters, page) {
    const f = filters || {};
    const isAnime = f.type !== "MANGA";
    const year = /^\d{4}$/.test(String(f.year || "")) ? String(f.year) : "";
    const season = isAnime ? f.season : "";
    const variables = {
      page: page || 1,
      perPage: PAGE_SIZE,
      type: isAnime ? "ANIME" : "MANGA",
      search: (f.q || "").trim(),
      genre: f.genre ? [f.genre] : null,
      season: season,
      // A season needs seasonYear; a bare year works for anime and manga via the start date.
      seasonYear: season && year ? Number(year) : null,
      year: !season && year ? year + "%" : null,
      format: f.format,
      status: f.status,
      sort: [MEDIA_SORTS[f.sort] || (f.q ? "SEARCH_MATCH" : "POPULARITY_DESC")]
    };
    const data = await anilist("searchMedia", SEARCH_MEDIA_QUERY, variables, 10 * MINUTE);
    const pageData = data.Page || {};
    return {
      items: list(pageData),
      hasNext: !!(pageData.pageInfo && pageData.pageInfo.hasNextPage),
      page: variables.page
    };
  }

  /** filters: { q, sort } */
  async function searchCharacters(filters, page) {
    const f = filters || {};
    const search = (f.q || "").trim();
    const variables = {
      page: page || 1,
      perPage: PAGE_SIZE,
      search,
      sort: [f.sort === "favourites" || !search ? "FAVOURITES_DESC" : "SEARCH_MATCH"]
    };
    const data = await anilist("searchCharacters", SEARCH_CHARACTERS_QUERY, variables, 10 * MINUTE);
    const pageData = data.Page || {};
    return {
      items: (pageData.characters || []).filter(Boolean),
      hasNext: !!(pageData.pageInfo && pageData.pageInfo.hasNextPage),
      page: variables.page
    };
  }

  async function media(id) {
    const data = await anilist("media", MEDIA_QUERY, { id: Number(id) }, 30 * MINUTE);
    if (!data.Media) throw new ApiError("That entry does not exist on AniList.", "not-found", 404);
    return data.Media;
  }

  async function character(id) {
    const data = await anilist("character", CHARACTER_QUERY, { id: Number(id) }, 30 * MINUTE);
    if (!data.Character) throw new ApiError("That character does not exist on AniList.", "not-found", 404);
    return data.Character;
  }

  /** A random pick from the ~2,500 most popular anime (pageInfo.total is not reliable). */
  async function randomAnime() {
    const page = 1 + Math.floor(Math.random() * 2500);
    const data = await anilist("random", RANDOM_QUERY, { page }, 0);
    const pick = list(data.Page)[0];
    if (!pick) throw new ApiError("No luck this time - try again.", "invalid");
    return pick.id;
  }

  /* ------------------------------------------------------------------ */
  /* Generic JSON fetch for the two REST APIs                            */
  /* ------------------------------------------------------------------ */

  async function fetchJson(url, options, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, Object.assign({ signal: controller.signal }, options));
      const json = await response.json().catch(() => null);
      return { response, json };
    } catch (err) {
      throw new ApiError(
        controller.signal.aborted ? "The request took too long." : "Network error.",
        controller.signal.aborted ? "timeout" : "network"
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Jikan (MyAnimeList) - optional extras, looked up through idMal      */
  /* ------------------------------------------------------------------ */

  const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.trim()) : []);
  const number = (value) => (typeof value === "number" && isFinite(value) ? value : null);

  /** Resolves to null whenever Jikan has nothing useful - it must never break a page. */
  async function malExtras(type, idMal) {
    const id = Number(idMal);
    if (!id) return null;
    const kind = type === "MANGA" ? "manga" : "anime";
    const key = "mal:" + kind + ":" + id;
    const hit = cacheGet(key, 60 * MINUTE);
    if (hit !== undefined) return hit;
    try {
      const { response, json } = await fetchJson(JIKAN_URL + "/" + kind + "/" + id + "/full", {}, 12000);
      const d = response.ok && json && json.data;
      if (!d) return null;
      const extras = {
        url: safeUrl(d.url),
        score: number(d.score),
        scoredBy: number(d.scored_by),
        rank: number(d.rank),
        rating: typeof d.rating === "string" ? d.rating : "",
        broadcast: d.broadcast && typeof d.broadcast.string === "string" ? d.broadcast.string : "",
        openings: strings(d.theme && d.theme.openings),
        endings: strings(d.theme && d.theme.endings)
      };
      cacheSet(key, extras);
      return extras;
    } catch (err) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* trace.moe - find an anime from a screenshot                         */
  /* ------------------------------------------------------------------ */

  /** Downscale a picture before upload; trace.moe only needs ~640px and it saves bandwidth. */
  async function prepareImage(file) {
    const MAX = 720;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
      return blob || file;
    } catch (err) {
      return file; // unknown format for this browser - let the server try
    }
  }

  /** input: a File/Blob, or an http(s) image URL. Resolves to a list of matches. */
  async function traceSearch(input) {
    const endpoint = TRACE_URL + "/search?anilistInfo&cutBorders";
    let result;
    if (typeof input === "string") {
      const imageUrl = safeUrl(input);
      if (!imageUrl) throw new ApiError("That does not look like an image link.", "trace", 400);
      result = await fetchJson(endpoint + "&url=" + encodeURIComponent(imageUrl), {}, 45000);
    } else {
      const form = new FormData();
      form.append("image", await prepareImage(input), "frame.jpg");
      result = await fetchJson(endpoint, { method: "POST", body: form }, 45000);
    }

    const { response, json } = result;
    if (response.status === 402 || response.status === 429) {
      throw new ApiError("Scene search is busy or out of free quota right now. Please try again later.", "rate-limit", response.status);
    }
    if (!response.ok || !json || json.error) {
      const detail = json && typeof json.error === "string" && json.error ? json.error : "HTTP " + response.status;
      throw new ApiError("Scene search could not read that image (" + detail + ").", "trace", response.status);
    }

    return (json.result || [])
      .map((match) => {
        const info = match && match.anilist;
        const isObject = info && typeof info === "object";
        const id = isObject ? info.id : Number(info);
        if (!id || (isObject && info.isAdult)) return null;
        return {
          id,
          title: isObject ? info.title : null,
          episode: match.episode,
          from: number(match.from),
          to: number(match.to),
          similarity: number(match.similarity) || 0,
          video: safeUrl(match.video),
          image: safeUrl(match.image)
        };
      })
      .filter(Boolean);
  }

  AW.api = {
    ApiError, on, PAGE_SIZE,
    home, searchMedia, searchCharacters, media, character, randomAnime,
    malExtras, traceSearch
  };
})();
