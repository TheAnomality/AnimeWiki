/*
 * Anime Hub Dictionary - application.
 *
 * Routes (hash based, so the site works on GitHub Pages and straight from the file system):
 *   #/                      discover (trending ring + rails)
 *   #/browse?type=&q=&...   search / browse with filters
 *   #/list                  favourites saved in this browser
 *   #/anime/ID  #/manga/ID  details dialog
 *   #/character/ID          character dialog
 */
(function () {
  "use strict";

  const AW = window.AnimeWiki;
  const U = AW.utils;
  const api = AW.api;
  const scene = AW.scene;
  const { html, raw } = U;

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));
  const setHtml = (el, markup) => {
    el.innerHTML = String(markup);
  };

  const SITE_TITLE = "Anime Hub Dictionary";
  const FAV_KEY = "aw:favourites:v1";
  const FX_KEY = "aw:fx";

  const DEFAULT_GENRES = [
    "Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music",
    "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"
  ];
  const TYPES = ["ANIME", "MANGA", "CHARACTER"];
  const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];
  const FORMATS = { ANIME: ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"], MANGA: ["MANGA", "NOVEL", "ONE_SHOT"] };
  const STATUSES = ["RELEASING", "FINISHED", "NOT_YET_RELEASED", "CANCELLED", "HIATUS"];
  const MEDIA_SORTS = [
    ["", "Best match"], ["popularity", "Most popular"], ["score", "Highest rated"], ["trending", "Trending"],
    ["newest", "Newest"], ["favourites", "Most favourited"], ["title", "Title A-Z"]
  ];
  const CHARACTER_SORTS = [["", "Best match"], ["favourites", "Most favourited"]];
  const MODE_TEXT = {
    ANIME: { noun: "anime", button: "Find Anime", placeholder: "Search for an anime..." },
    MANGA: { noun: "manga", button: "Find Manga", placeholder: "Search for a manga..." },
    CHARACTER: { noun: "characters", button: "Find Characters", placeholder: "Search for a character..." }
  };
  const RELATION_ORDER = [
    "PREQUEL", "SEQUEL", "PARENT", "SOURCE", "ADAPTATION", "SIDE_STORY", "SPIN_OFF", "ALTERNATIVE",
    "SUMMARY", "COMPILATION", "CONTAINS", "CHARACTER", "OTHER"
  ];
  const MIN_YEAR = 1940;
  const MAX_YEAR = new Date().getFullYear() + 1;
  const DEFAULT_FILTERS = { type: "ANIME", q: "", genre: "", year: "", season: "", format: "", status: "", sort: "" };

  const state = {
    viewName: "",
    viewKey: "",
    viewHash: "#/",
    filters: Object.assign({}, DEFAULT_FILTERS),
    genres: DEFAULT_GENRES.slice(),
    homeLoaded: false,
    homeLoading: false,
    results: { token: 0, page: 0, hasNext: false, count: 0, seen: new Set() },
    modal: { open: false, key: "", token: 0, baseIndex: null },
    historyIndex: 0,
    busy: 0,
    fx: true,
    typedHash: "",
    routedHash: null,
    viewTitle: SITE_TITLE
  };

  /** Everything rendered as a card is remembered here so it can be saved to My List. */
  const entities = new Map();
  let favourites = loadFavourites();

  const dom = {};

  /* ================================================================== */
  /* Small UI helpers                                                    */
  /* ================================================================== */

  function toast(message, type, duration) {
    const el = document.createElement("div");
    el.className = "toast" + (type ? " toast-" + type : "");
    el.textContent = message;
    dom.toasts.appendChild(el);
    setTimeout(() => {
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 320);
    }, duration || 4200);
    return el;
  }

  /** Counts overlapping loads; drives the progress bar and makes the petals rush. */
  function busy(delta) {
    state.busy = Math.max(0, state.busy + delta);
    const active = state.busy > 0;
    dom.progress.classList.toggle("active", active);
    scene.setBusy(active);
  }

  /** The title of the page under any dialog; restored when the dialog closes. */
  function setViewTitle(title) {
    state.viewTitle = title;
    if (!state.modal.open) document.title = title;
  }

  /*
   * Navigation the app starts itself is routed immediately instead of waiting for the
   * (asynchronous) hashchange event, so the form and the URL can never drift apart while
   * someone is typing. The later hashchange for the same hash is ignored.
   */
  function go(hash) {
    if (location.hash !== hash) location.hash = hash;
    onRoute(false);
  }

  function replaceHash(hash) {
    if (location.hash !== hash) location.replace(hash);
    onRoute(false);
  }

  const mod = (n, m) => ((n % m) + m) % m;

  function errorState(err, retry) {
    const kind = err && err.kind;
    let title = "Something went wrong";
    if (kind === "network") title = "Connection problem";
    else if (kind === "timeout") title = "That took too long";
    else if (kind === "rate-limit") title = "Slow down a moment";
    else if (kind === "not-found") title = "Not found";
    else if (kind === "unavailable") title = "AniList is unavailable";
    const message = (err && err.message) || "Please try again later.";
    return html`
      <div class="state state-error" role="alert">
        <div class="state-emoji" aria-hidden="true">${kind === "not-found" ? "🔍" : "😵"}</div>
        <h3>${title}</h3>
        <p>${message}</p>
        ${retry && kind !== "not-found" ? html`<button type="button" class="btn" data-retry="${retry}">Try again</button>` : ""}
      </div>`;
  }

  function skeletonCards(count) {
    const cards = [];
    for (let i = 0; i < count; i++) {
      cards.push(html`<div class="card skeleton" aria-hidden="true"><div class="card-media"></div><div class="card-body"><span></span><span></span></div></div>`);
    }
    return cards;
  }

  /* ================================================================== */
  /* Favourites                                                          */
  /* ================================================================== */

  function loadFavourites() {
    const map = new Map();
    const stored = U.store.get(FAV_KEY, []);
    if (Array.isArray(stored)) {
      stored.forEach((item) => {
        if (item && typeof item.key === "string" && item.id) map.set(item.key, item);
      });
    }
    return map;
  }

  function mediaSnapshot(m) {
    const cover = m.coverImage || {};
    return {
      key: "media:" + m.id,
      kind: "media",
      id: m.id,
      type: m.type === "MANGA" ? "MANGA" : "ANIME",
      title: U.titleOf(m),
      image: cover.large || cover.extraLarge || "",
      color: cover.color || "",
      format: m.format || "",
      year: m.seasonYear || (m.startDate && m.startDate.year) || null,
      score: m.averageScore || null
    };
  }

  function characterSnapshot(c) {
    return {
      key: "character:" + c.id,
      kind: "character",
      id: c.id,
      type: "CHARACTER",
      title: (c.name && (c.name.full || c.name.native)) || "Unknown",
      image: (c.image && c.image.large) || "",
      color: "",
      format: "",
      year: null,
      score: null
    };
  }

  /**
   * Keep the best data seen for an entry. A "weak" snapshot (from a small related-card with
   * few fields) only fills gaps, so it never downgrades what a full card already provided.
   */
  function remember(snapshot, weak) {
    const existing = entities.get(snapshot.key);
    if (!existing) {
      entities.set(snapshot.key, snapshot);
      return snapshot;
    }
    const base = weak ? snapshot : existing;
    const top = weak ? existing : snapshot;
    const merged = Object.assign({}, base);
    Object.keys(top).forEach((field) => {
      if (top[field] !== null && top[field] !== undefined && top[field] !== "") merged[field] = top[field];
    });
    entities.set(snapshot.key, merged);
    return snapshot;
  }

  function favLabel(on, title) {
    return (on ? "Remove from My List: " : "Add to My List: ") + title;
  }

  function favButton(key, title, withText) {
    const on = favourites.has(key);
    return html`
      <button type="button" class="fav-btn${withText ? " fav-btn-wide" : ""}" data-fav="${key}" data-title="${title}"
              aria-pressed="${on ? "true" : "false"}" aria-label="${favLabel(on, title)}" title="${on ? "Remove from My List" : "Add to My List"}">
        <span class="fav-heart" aria-hidden="true">♥</span>${withText ? html`<span class="fav-text">${on ? "In My List" : "Add to My List"}</span>` : ""}
      </button>`;
  }

  function refreshFavButtons() {
    $$("[data-fav]").forEach((button) => {
      const on = favourites.has(button.dataset.fav);
      button.setAttribute("aria-pressed", on ? "true" : "false");
      button.setAttribute("aria-label", favLabel(on, button.dataset.title || ""));
      button.title = on ? "Remove from My List" : "Add to My List";
      const text = $(".fav-text", button);
      if (text) text.textContent = on ? "In My List" : "Add to My List";
    });
    dom.favCount.textContent = String(favourites.size);
    dom.favCount.classList.toggle("has-items", favourites.size > 0);
  }

  function toggleFavourite(key) {
    if (favourites.has(key)) {
      favourites.delete(key);
    } else {
      const snapshot = entities.get(key);
      if (!snapshot) return;
      favourites.set(key, Object.assign({}, snapshot, { added: Date.now() }));
      scene.pulse(1.5);
    }
    if (!U.store.set(FAV_KEY, Array.from(favourites.values()))) {
      toast("Your browser blocked saving - My List will not survive a reload.", "warn");
    }
    refreshFavButtons();
    if (state.viewName === "list") renderList();
  }

  /*
   * Backup and restore. My List lives in localStorage, so a plain JSON file is the whole
   * "database": download it, keep it, load it into any browser.
   */
  function exportFavourites() {
    if (!favourites.size) {
      toast("Your list is empty, so there is nothing to back up yet.", "warn");
      return;
    }
    const payload = { app: "anime-hub-dictionary", version: 1, exported: new Date().toISOString(), items: Array.from(favourites.values()) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "anime-hub-my-list.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast("Backup saved: " + favourites.size + (favourites.size === 1 ? " entry" : " entries"));
  }

  /** A backup file is untrusted input: every field is checked before it is kept. */
  function cleanImportedItem(item) {
    if (!item || typeof item !== "object") return null;
    const match = /^(media|character):(\d{1,9})$/.exec(String(item.key || ""));
    const id = Number(item.id);
    if (!match || !id || Number(match[2]) !== id) return null;
    const kind = match[1];
    const title = String(item.title || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!title) return null;
    const numberOrNull = (value, min, max) => (typeof value === "number" && value >= min && value <= max ? value : null);
    return {
      key: kind + ":" + id,
      kind,
      id,
      type: kind === "character" ? "CHARACTER" : item.type === "MANGA" ? "MANGA" : "ANIME",
      title,
      image: U.safeUrl(item.image),
      color: U.safeColor(item.color),
      format: /^[A-Z_]{1,20}$/.test(String(item.format || "")) ? item.format : "",
      year: numberOrNull(item.year, 1900, 2200),
      score: numberOrNull(item.score, 0, 100),
      added: numberOrNull(item.added, 0, 1e14) || Date.now()
    };
  }

  async function importFavourites(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast("That file is too large to be a list backup.", "warn");
      return;
    }
    let items;
    try {
      const parsed = JSON.parse(await file.text());
      items = Array.isArray(parsed) ? parsed : parsed && parsed.items;
      if (!Array.isArray(items)) throw new Error("no items");
    } catch (err) {
      toast("That does not look like an Anime Hub backup file.", "error");
      return;
    }
    let added = 0;
    items.slice(0, 5000).forEach((item) => {
      const clean = cleanImportedItem(item);
      if (clean && !favourites.has(clean.key)) {
        favourites.set(clean.key, clean);
        added += 1;
      }
    });
    if (added && !U.store.set(FAV_KEY, Array.from(favourites.values()))) {
      toast("Your browser blocked saving - the restored list will not survive a reload.", "warn");
    }
    refreshFavButtons();
    if (state.viewName === "list") renderList();
    toast(added ? "Restored " + added + (added === 1 ? " entry" : " entries") : "Nothing new in that backup - everything is already in your list.");
  }

  /* ================================================================== */
  /* Cards                                                               */
  /* ================================================================== */

  function mediaHref(m) {
    return "#/" + (m.type === "MANGA" ? "manga" : "anime") + "/" + Number(m.id);
  }

  function cardStyle(index, color) {
    const safe = U.safeColor(color);
    return raw("--i:" + Math.min(index || 0, 14) + (safe ? ";--cover:" + safe : ""));
  }

  function coverImage(url, width, height) {
    const src = U.safeUrl(url);
    return src
      ? html`<img src="${src}" alt="" loading="lazy" decoding="async" width="${width}" height="${height}" draggable="false">`
      : html`<div class="no-image" aria-hidden="true">🌸</div>`;
  }

  function mediaCard(m, index) {
    const snapshot = remember(mediaSnapshot(m));
    const isManga = m.type === "MANGA";
    const length = isManga ? (m.chapters ? m.chapters + " ch" : "") : m.episodes ? m.episodes + (m.episodes === 1 ? " ep" : " eps") : "";
    const meta = [U.formatLabel(m.format), snapshot.year, length].filter(Boolean).join(" · ");
    const airing = m.nextAiringEpisode;
    return html`
      <article class="card tilt" style="${cardStyle(index, snapshot.color)}">
        <a class="card-link" href="${mediaHref(m)}">
          <div class="card-media">
            ${coverImage(snapshot.image, 230, 325)}
            ${m.averageScore ? html`<span class="badge badge-score">★ ${m.averageScore}%</span>` : ""}
            ${airing && airing.airingAt
              ? html`<span class="badge badge-airing">Ep ${airing.episode} · <span data-airing-at="${airing.airingAt}">${U.countdown(airing.airingAt)}</span></span>`
              : ""}
          </div>
          <div class="card-body">
            <h3 class="card-title">${snapshot.title}</h3>
            <p class="card-meta">${meta || U.statusLabel(m.status, m.type)}</p>
            <p class="card-genres">${(m.genres || []).slice(0, 3).join(" · ")}</p>
          </div>
        </a>
        ${favButton(snapshot.key, snapshot.title)}
      </article>`;
  }

  function characterCard(c, index) {
    const snapshot = remember(characterSnapshot(c));
    const from = ((c.media && c.media.nodes) || []).find((node) => node && !node.isAdult);
    return html`
      <article class="card tilt card-character" style="${cardStyle(index)}">
        <a class="card-link" href="#/character/${Number(c.id)}">
          <div class="card-media">
            ${coverImage(snapshot.image, 230, 325)}
            ${c.favourites ? html`<span class="badge badge-score">♥ ${U.formatCompact(c.favourites)}</span>` : ""}
          </div>
          <div class="card-body">
            <h3 class="card-title">${snapshot.title}</h3>
            <p class="card-meta">${(c.name && c.name.native) || ""}</p>
            <p class="card-genres">${from ? U.titleOf(from) : ""}</p>
          </div>
        </a>
        ${favButton(snapshot.key, snapshot.title)}
      </article>`;
  }

  /** A card built from a saved favourite - needs no API call at all. */
  function savedCard(item, index) {
    remember(item);
    const href = item.kind === "character" ? "#/character/" + Number(item.id) : mediaHref(item);
    const meta = item.kind === "character" ? "Character" : [U.formatLabel(item.format), item.year].filter(Boolean).join(" · ");
    return html`
      <article class="card tilt${item.kind === "character" ? " card-character" : ""}" style="${cardStyle(index, item.color)}">
        <a class="card-link" href="${href}">
          <div class="card-media">
            ${coverImage(item.image, 230, 325)}
            ${item.score ? html`<span class="badge badge-score">★ ${item.score}%</span>` : ""}
          </div>
          <div class="card-body">
            <h3 class="card-title">${item.title}</h3>
            <p class="card-meta">${meta}</p>
          </div>
        </a>
        ${favButton(item.key, item.title)}
      </article>`;
  }

  function miniCard(node, kicker) {
    remember(mediaSnapshot(node), true);
    return html`
      <a class="mini" href="${mediaHref(node)}">
        <span class="mini-cover" style="${cardStyle(0, node.coverImage && node.coverImage.color)}">${coverImage(node.coverImage && node.coverImage.large, 120, 170)}</span>
        <span class="mini-kicker">${kicker}</span>
        <span class="mini-title">${U.titleOf(node)}</span>
      </a>`;
  }

  /* ================================================================== */
  /* Discover: rails                                                     */
  /* ================================================================== */

  function rail(id, title, subtitle, items, moreHash) {
    if (!items || !items.length) return "";
    return html`
      <section class="rail" aria-labelledby="rail-${id}">
        <div class="section-head">
          <div><h2 id="rail-${id}">${title}</h2>${subtitle ? html`<p>${subtitle}</p>` : ""}</div>
          ${moreHash ? html`<a class="more-link" href="${moreHash}">See all <span aria-hidden="true">→</span></a>` : ""}
        </div>
        <div class="rail-wrap">
          <button type="button" class="rail-arrow rail-prev" data-rail="-1" aria-label="Scroll ${title} left">‹</button>
          <div class="rail-track">${items.map((m, i) => mediaCard(m, i))}</div>
          <button type="button" class="rail-arrow rail-next" data-rail="1" aria-label="Scroll ${title} right">›</button>
        </div>
      </section>`;
  }

  function genreCloud(genres) {
    return html`
      <section class="rail" aria-labelledby="rail-genres">
        <div class="section-head"><div><h2 id="rail-genres">Browse by genre</h2><p>Jump straight into what you are in the mood for</p></div></div>
        <div class="chips chips-large">
          ${genres.map((genre) => html`<a class="chip" href="${U.buildHash("browse", { genre })}">${genre}</a>`)}
        </div>
      </section>`;
  }

  function seasonName(info) {
    return U.humanize(info.season) + " " + info.year;
  }

  function renderHome(data) {
    renderSpotlight(data.trending);
    const now = data.current;
    const next = data.next;
    setHtml(
      dom.rails,
      html`
        ${rail("airing", "Airing soon", "The next episodes of what everyone is watching", data.airing, U.buildHash("browse", { status: "RELEASING" }))}
        ${rail("season", "Popular this season", seasonName(now), data.season, U.buildHash("browse", { season: now.season, year: now.year }))}
        ${rail("upcoming", "Coming next season", seasonName(next), data.upcoming, U.buildHash("browse", { season: next.season, year: next.year }))}
        ${rail("top", "All-time top rated", "The highest scores on AniList", data.top, U.buildHash("browse", { sort: "score" }))}
        ${rail("manga", "Trending manga", "What readers are picking up right now", data.manga, U.buildHash("browse", { type: "manga", sort: "trending" }))}
        ${genreCloud(state.genres)}`
    );
  }

  async function loadHome() {
    if (state.homeLoaded || state.homeLoading) return;
    state.homeLoading = true;
    setHtml(dom.spotlight, html`<div class="spotlight-skeleton skeleton" aria-hidden="true"></div>`);
    setHtml(
      dom.rails,
      html`${[0, 1].map(() => html`<section class="rail" aria-hidden="true"><div class="section-head"><div><h2 class="skeleton-text">&nbsp;</h2></div></div><div class="rail-track">${skeletonCards(8)}</div></section>`)}`
    );
    dom.rails.setAttribute("aria-busy", "true");
    busy(1);
    try {
      const data = await api.home();
      if (data.genres.length) {
        state.genres = data.genres;
        fillGenres();
      }
      renderHome(data);
      state.homeLoaded = true;
      scene.pulse();
    } catch (err) {
      console.error(err);
      setHtml(dom.spotlight, "");
      setHtml(dom.rails, errorState(err, "home"));
    } finally {
      state.homeLoading = false;
      dom.rails.removeAttribute("aria-busy");
      busy(-1);
    }
  }

  /* ================================================================== */
  /* Discover: the 3D trending ring                                      */
  /* ================================================================== */

  const ring = {
    items: [], index: 0, angle: 0, step: 30, degPerPx: 0.2, drag: null, hover: false, visible: true,
    suppressClick: false, resumeAt: 0, timer: 0, el: null, stage: null, text: null
  };

  function renderSpotlight(items) {
    ring.items = (items || []).slice(0, 12);
    clearInterval(ring.timer);
    if (ring.items.length < 5) {
      setHtml(dom.spotlight, "");
      ring.el = null;
      return;
    }
    setHtml(
      dom.spotlight,
      html`
        <section class="spotlight-inner" aria-roledescription="carousel" aria-labelledby="spotlight-title">
          <div class="section-head">
            <div><h2 id="spotlight-title">Trending now</h2><p>Drag the ring, or use the arrows</p></div>
            <a class="more-link" href="${U.buildHash("browse", { sort: "trending" })}">See all <span aria-hidden="true">→</span></a>
          </div>
          <div class="ring-stage" id="ring-stage">
            <div class="ring" id="ring">
              ${ring.items.map((m, i) => {
                const cover = m.coverImage || {};
                return html`
                  <button type="button" class="ring-item" tabindex="-1" aria-hidden="true" data-index="${i}" style="${cardStyle(i, cover.color)}">
                    ${coverImage(cover.extraLarge || cover.large, 230, 325)}
                    <span class="ring-rank">#${i + 1}</span>
                  </button>`;
              })}
            </div>
          </div>
          <div class="ring-info">
            <button type="button" class="ring-arrow" data-ring="-1" aria-label="Previous trending anime">‹</button>
            <div class="ring-text" id="ring-text"></div>
            <button type="button" class="ring-arrow" data-ring="1" aria-label="Next trending anime">›</button>
          </div>
        </section>`
    );

    ring.el = $("#ring");
    ring.stage = $("#ring-stage");
    ring.text = $("#ring-text");
    ring.index = 0;
    ring.items.forEach((m) => remember(mediaSnapshot(m)));

    const section = $(".spotlight-inner", dom.spotlight);
    section.addEventListener("pointerenter", () => (ring.hover = true));
    section.addEventListener("pointerleave", () => (ring.hover = false));
    section.addEventListener("focusin", () => (ring.hover = true));
    section.addEventListener("focusout", () => (ring.hover = false));
    section.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        ringStep(event.key === "ArrowLeft" ? -1 : 1);
      }
    });
    ring.stage.addEventListener("pointerdown", onRingPointerDown);
    ring.stage.addEventListener("click", onRingClick);

    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => (ring.visible = entries[0].isIntersecting), { threshold: 0.25 }).observe(ring.stage);
    }

    measureRing();
    ringGo(0);
    ring.timer = setInterval(() => {
      const idle = state.fx && ring.visible && !ring.hover && !ring.drag && !document.hidden && !state.modal.open;
      if (idle && state.viewName === "home" && Date.now() > ring.resumeAt) ringGo(ring.index + 1);
    }, 4200);
  }

  /** Size the ring so the covers sit edge to edge on a circle. */
  function measureRing() {
    if (!ring.el) return;
    const n = ring.items.length;
    const width = ring.el.offsetWidth || 180;
    ring.step = 360 / n;
    const radius = Math.round(width / 2 / Math.tan(Math.PI / n) + width * 0.12);
    ring.degPerPx = ring.step / (width * 1.15);
    ring.el.style.setProperty("--radius", radius + "px");
    ring.el.style.setProperty("--step", ring.step + "deg");
  }

  function applyRing() {
    const n = ring.items.length;
    const nearest = Math.round(-ring.angle / ring.step);
    ring.el.style.setProperty("--angle", ring.angle + "deg");
    $$(".ring-item", ring.el).forEach((item, i) => {
      let off = mod(i - nearest, n);
      if (off > n / 2) off -= n;
      item.dataset.off = String(Math.min(3, Math.abs(off)));
    });
    return mod(nearest, n);
  }

  function renderRingText(front) {
    const m = ring.items[front];
    if (!m || ring.text.dataset.front === String(front)) return;
    ring.text.dataset.front = String(front);
    const snapshot = mediaSnapshot(m);
    const facts = [U.formatLabel(m.format), snapshot.year, m.averageScore ? "★ " + m.averageScore + "%" : ""].filter(Boolean).join(" · ");
    setHtml(
      ring.text,
      html`
        <p class="ring-kicker">#${front + 1} trending${facts ? " · " + facts : ""}</p>
        <h3 class="ring-title"><a href="${mediaHref(m)}">${snapshot.title}</a></h3>
        <p class="ring-desc">${U.truncate(U.stripHtml(m.description), 190) || (m.genres || []).join(" · ")}</p>
        <div class="ring-actions">
          <a class="btn btn-primary" href="${mediaHref(m)}">View details</a>
          ${favButton(snapshot.key, snapshot.title, true)}
        </div>`
    );
  }

  function ringGo(index) {
    if (!ring.el) return;
    ring.index = index;
    ring.angle = -index * ring.step;
    renderRingText(applyRing());
  }

  function ringStep(direction) {
    ring.resumeAt = Date.now() + 9000;
    ringGo(ring.index + direction);
  }

  function onRingPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    ring.drag = { id: event.pointerId, x: event.clientX, angle: ring.angle, moved: false };
    window.addEventListener("pointermove", onRingPointerMove);
    window.addEventListener("pointerup", onRingPointerUp);
    window.addEventListener("pointercancel", onRingPointerUp);
  }

  function onRingPointerMove(event) {
    const drag = ring.drag;
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 6) return;
    drag.moved = true;
    ring.el.classList.add("dragging");
    ring.angle = drag.angle + dx * ring.degPerPx;
    renderRingText(applyRing());
  }

  function onRingPointerUp(event) {
    const drag = ring.drag;
    if (!drag || event.pointerId !== drag.id) return;
    window.removeEventListener("pointermove", onRingPointerMove);
    window.removeEventListener("pointerup", onRingPointerUp);
    window.removeEventListener("pointercancel", onRingPointerUp);
    ring.drag = null;
    if (drag.moved) {
      ring.el.classList.remove("dragging");
      ring.suppressClick = true;
      setTimeout(() => (ring.suppressClick = false), 0);
      ring.resumeAt = Date.now() + 9000;
      ringGo(Math.round(-ring.angle / ring.step));
    }
  }

  function onRingClick(event) {
    if (ring.suppressClick) {
      ring.suppressClick = false;
      return;
    }
    const item = event.target.closest(".ring-item");
    if (!item) return;
    const n = ring.items.length;
    const index = Number(item.dataset.index);
    const front = mod(ring.index, n);
    if (index === front) {
      go(mediaHref(ring.items[index]));
      return;
    }
    let diff = index - front;
    if (diff > n / 2) diff -= n;
    if (diff < -n / 2) diff += n;
    ring.resumeAt = Date.now() + 9000;
    ringGo(ring.index + diff);
  }

  /* ================================================================== */
  /* Search form and filters                                             */
  /* ================================================================== */

  function option(value, label) {
    const el = document.createElement("option");
    el.value = value;
    el.textContent = label;
    return el;
  }

  function fillSelect(select, pairs, keepValue) {
    const previous = keepValue === undefined ? select.value : keepValue;
    select.textContent = "";
    pairs.forEach(([value, label]) => select.appendChild(option(value, label)));
    select.value = pairs.some(([value]) => value === previous) ? previous : "";
  }

  function fillGenres() {
    fillSelect(dom.genre, [["", "Any"]].concat(state.genres.map((genre) => [genre, genre])));
  }

  function fillYears() {
    const pairs = [["", "Any"]];
    for (let year = MAX_YEAR; year >= MIN_YEAR; year--) pairs.push([String(year), String(year)]);
    fillSelect(dom.year, pairs);
  }

  /** Format, status and sort options depend on what is being searched. */
  function fillTypeOptions(type, filters) {
    // With explicit filters, select exactly those; otherwise keep whatever is still valid.
    const keep = (name) => (filters ? filters[name] || "" : undefined);
    if (type === "CHARACTER") {
      fillSelect(dom.sort, CHARACTER_SORTS, keep("sort"));
    } else {
      fillSelect(dom.format, [["", "Any"]].concat(FORMATS[type].map((value) => [value, U.formatLabel(value)])), keep("format"));
      fillSelect(dom.status, [["", "Any"]].concat(STATUSES.map((value) => [value, U.statusLabel(value, type)])), keep("status"));
      fillSelect(dom.sort, MEDIA_SORTS, keep("sort"));
    }
    const hasQuery = !!dom.input.value.trim();
    dom.sort.options[0].textContent = hasQuery ? "Best match" : type === "CHARACTER" ? "Most favourited" : "Most popular";
    $$("[data-filter]", dom.filters).forEach((label) => {
      const name = label.dataset.filter;
      const hide = type === "CHARACTER" ? name !== "sort" : type === "MANGA" && name === "season";
      label.hidden = hide;
    });
    const text = MODE_TEXT[type];
    dom.input.placeholder = text.placeholder;
    dom.buttonLabel.textContent = text.button;
  }

  function currentMode() {
    const checked = $('input[name="mode"]:checked', dom.form);
    return checked && TYPES.indexOf(checked.value) !== -1 ? checked.value : "ANIME";
  }

  function readForm() {
    const type = currentMode();
    const isCharacter = type === "CHARACTER";
    return normalizeFilters({
      type,
      q: dom.input.value,
      genre: isCharacter ? "" : dom.genre.value,
      year: isCharacter ? "" : dom.year.value,
      season: type === "ANIME" ? dom.season.value : "",
      format: isCharacter ? "" : dom.format.value,
      status: isCharacter ? "" : dom.status.value,
      sort: dom.sort.value
    });
  }

  function syncForm(filters, keepInput) {
    const radio = $('input[name="mode"][value="' + filters.type + '"]', dom.form);
    if (radio) radio.checked = true;
    // keepInput: this route came from the user's own typing, which may already be a few
    // characters ahead of the URL - never overwrite it.
    if (!keepInput && dom.input.value.trim() !== filters.q) dom.input.value = filters.q;
    fillTypeOptions(filters.type, filters);
    dom.genre.value = state.genres.indexOf(filters.genre) !== -1 ? filters.genre : "";
    dom.year.value = filters.year;
    dom.season.value = filters.season;
    updateResetButton(filters);
    if (hasActiveFilters(filters)) setFiltersOpen(true);
  }

  function hasActiveFilters(f) {
    return !!(f.genre || f.year || f.season || f.format || f.status || f.sort);
  }

  function countActiveFilters(f) {
    return [f.genre, f.year, f.season, f.format, f.status, f.sort].filter(Boolean).length;
  }

  /** Reset link + the badge on the phone-only "Filters" button. */
  function updateResetButton(filters) {
    const active = countActiveFilters(filters || readForm());
    dom.reset.hidden = active === 0;
    dom.filtersActive.hidden = active === 0;
    dom.filtersActive.textContent = String(active);
    dom.filtersActive.classList.toggle("has-items", active > 0);
  }

  function setFiltersOpen(open) {
    dom.form.classList.toggle("filters-open", open);
    dom.filtersToggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  /** Anything coming from the URL is validated here, so a bad link can never produce a bad query. */
  function normalizeFilters(input) {
    const pick = (value, allowed) => (allowed.indexOf(value) !== -1 ? value : "");
    const type = pick(String(input.type || "").toUpperCase(), TYPES) || "ANIME";
    const filters = Object.assign({}, DEFAULT_FILTERS, { type });
    filters.q = String(input.q || "").replace(/\s+/g, " ").trim().slice(0, 100);
    if (type === "CHARACTER") {
      filters.sort = pick(String(input.sort || "").toLowerCase(), ["favourites"]);
      return filters;
    }
    const genre = String(input.genre || "").toLowerCase();
    filters.genre = state.genres.find((name) => name.toLowerCase() === genre) || "";
    const year = /^\d{4}$/.test(String(input.year || "")) ? Number(input.year) : 0;
    filters.year = year >= MIN_YEAR && year <= MAX_YEAR ? String(year) : "";
    filters.season = type === "ANIME" ? pick(String(input.season || "").toUpperCase(), SEASONS) : "";
    filters.format = pick(String(input.format || "").toUpperCase(), FORMATS[type]);
    filters.status = pick(String(input.status || "").toUpperCase(), STATUSES);
    filters.sort = pick(String(input.sort || "").toLowerCase(), MEDIA_SORTS.map((pair) => pair[0]));
    return filters;
  }

  function browseHash(f) {
    return U.buildHash("browse", {
      type: f.type === "ANIME" ? "" : f.type.toLowerCase(),
      q: f.q,
      genre: f.genre,
      year: f.year,
      season: f.season,
      format: f.format,
      status: f.status,
      sort: f.sort
    });
  }

  function filterSummary(f) {
    const parts = [];
    if (f.genre) parts.push(f.genre);
    if (f.season || f.year) parts.push([U.humanize(f.season), f.year].filter(Boolean).join(" "));
    if (f.format) parts.push(U.formatLabel(f.format));
    if (f.status) parts.push(U.statusLabel(f.status, f.type));
    const sort = (f.type === "CHARACTER" ? CHARACTER_SORTS : MEDIA_SORTS).find((pair) => pair[0] === f.sort);
    if (f.sort && sort) parts.push(sort[1]);
    return parts.join(" · ");
  }

  /* ================================================================== */
  /* Browse / search results                                             */
  /* ================================================================== */

  function showBrowse(filters) {
    state.filters = filters;
    syncForm(filters, state.typedHash === browseHash(filters));
    state.typedHash = "";
    const noun = MODE_TEXT[filters.type].noun;
    const summary = filterSummary(filters);
    dom.resultsTitle.textContent = filters.q ? "Results for “" + filters.q + "”" : "Browse " + noun;
    dom.resultsTitle.dataset.summary = summary;
    setViewTitle((filters.q ? "“" + filters.q + "” · " : "Browse " + noun + " · ") + SITE_TITLE);
    loadResults(false);
  }

  function emptyResults(filters) {
    return html`
      <div class="state">
        <div class="state-emoji" aria-hidden="true">🍃</div>
        <h3>No results found</h3>
        <p>${filters.q ? "Nothing matches “" + filters.q + "”. " : ""}Try a different search${hasActiveFilters(filters) ? " or loosen the filters" : ""}!</p>
        ${hasActiveFilters(filters) ? html`<button type="button" class="btn" data-clear-filters>Reset filters</button>` : ""}
      </div>`;
  }

  async function loadResults(append) {
    const results = state.results;
    const filters = state.filters;
    const token = ++results.token;
    const page = append ? results.page + 1 : 1;
    const isCharacter = filters.type === "CHARACTER";
    const summary = dom.resultsTitle.dataset.summary;

    if (append) {
      dom.loadMore.disabled = true;
      dom.loadMore.textContent = "Loading…";
    } else {
      results.seen = new Set();
      results.count = 0;
      dom.loadMore.hidden = true;
      dom.grid.setAttribute("aria-busy", "true");
      setHtml(dom.grid, html`${skeletonCards(12)}`);
      dom.resultsStatus.textContent = "Searching…";
    }

    busy(1);
    try {
      const data = isCharacter ? await api.searchCharacters(filters, page) : await api.searchMedia(filters, page);
      if (token !== results.token) return; // a newer search has started

      // AniList can repeat an entry across pages when sort values tie.
      const fresh = data.items.filter((item) => item && item.id && !results.seen.has(item.id));
      fresh.forEach((item) => results.seen.add(item.id));
      const cards = fresh.map((item, i) => (isCharacter ? characterCard(item, i) : mediaCard(item, i)));

      if (append) {
        const first = dom.grid.children.length;
        dom.grid.insertAdjacentHTML("beforeend", String(html`${cards}`));
        const firstNew = dom.grid.children[first];
        const link = firstNew && $("a", firstNew);
        if (link) link.focus({ preventScroll: true });
      } else {
        setHtml(dom.grid, cards.length ? html`${cards}` : emptyResults(filters));
      }

      results.page = page;
      results.hasNext = data.hasNext;
      results.count += fresh.length;
      dom.loadMore.hidden = !data.hasNext;
      const countText = results.count
        ? results.count + (data.hasNext ? "+" : "") + (results.count === 1 && !data.hasNext ? " result" : " results")
        : "No results";
      dom.resultsStatus.textContent = [countText, summary].filter(Boolean).join(" · ");
      if (!append) scene.pulse();
    } catch (err) {
      if (token !== results.token) return;
      console.error(err);
      if (append) {
        toast(err.message || "Could not load more.", "error");
      } else {
        setHtml(dom.grid, errorState(err, "browse"));
        dom.resultsStatus.textContent = "";
      }
    } finally {
      busy(-1);
      if (token === results.token) {
        dom.grid.removeAttribute("aria-busy");
        dom.loadMore.disabled = false;
        dom.loadMore.textContent = "Load more";
      }
    }
  }

  /* ================================================================== */
  /* My List                                                             */
  /* ================================================================== */

  function renderList() {
    const items = Array.from(favourites.values()).sort((a, b) => (b.added || 0) - (a.added || 0));
    if (!items.length) {
      setHtml(
        dom.listContent,
        html`
          <div class="state">
            <div class="state-emoji" aria-hidden="true">💛</div>
            <h3>Your list is empty</h3>
            <p>Tap the heart on any anime, manga or character to keep it here.</p>
            <a class="btn btn-primary" href="#/">Discover something</a>
          </div>`
      );
      return;
    }
    const groups = [
      ["Anime", items.filter((item) => item.kind === "media" && item.type !== "MANGA")],
      ["Manga", items.filter((item) => item.kind === "media" && item.type === "MANGA")],
      ["Characters", items.filter((item) => item.kind === "character")]
    ];
    setHtml(
      dom.listContent,
      html`${groups
        .filter((group) => group[1].length)
        .map(
          (group) => html`
            <section class="list-group">
              <h3 class="list-heading">${group[0]} <span class="count has-items">${group[1].length}</span></h3>
              <div class="results-grid">${group[1].map((item, i) => savedCard(item, i))}</div>
            </section>`
        )}`
    );
  }

  /* ================================================================== */
  /* Details dialog: anime / manga                                       */
  /* ================================================================== */

  function facts(pairs) {
    const rows = pairs.filter((pair) => pair[1] !== null && pair[1] !== undefined && pair[1] !== "");
    return html`<dl class="facts">${rows.map((pair) => html`<div><dt>${pair[0]}</dt><dd>${pair[1]}</dd></div>`)}</dl>`;
  }

  function detailActions(key, title, siteUrl) {
    const url = U.safeUrl(siteUrl);
    return html`
      <div class="detail-actions">
        ${favButton(key, title, true)}
        ${url ? html`<a class="btn" href="${url}" target="_blank" rel="noopener noreferrer">AniList <span aria-hidden="true">↗</span></a>` : ""}
        <button type="button" class="btn" data-share="${title}">Share</button>
      </div>`;
  }

  function rankingText(r) {
    const scope = r.allTime ? "" : [U.humanize(r.season), r.year].filter(Boolean).join(" ");
    return "#" + r.rank + " " + (r.context || "") + (scope ? " " + scope : "");
  }

  function scoreDistribution(stats) {
    const rows = ((stats && stats.scoreDistribution) || []).filter((row) => row && row.amount >= 0);
    const max = Math.max.apply(null, rows.map((row) => row.amount).concat(1));
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    if (!total) return "";
    const top = rows.reduce((best, row) => (row.amount > best.amount ? row : best), rows[0]);
    return html`
      <section>
        <h3>Score distribution</h3>
        <div class="dist" role="img" aria-label="${"Scores from " + U.formatCompact(total) + " users. The most common score is " + top.score + " out of 100."}">
          ${rows.map(
            (row) => html`
              <div class="dist-col" title="${row.score + ": " + U.formatNumber(row.amount) + " users"}">
                <span class="dist-bar" style="${raw("--h:" + Math.max(2, Math.round((row.amount / max) * 100)) + ";--hue:" + Math.round(row.score * 1.2))}"></span>
                <span class="dist-label">${row.score}</span>
              </div>`
          )}
        </div>
      </section>`;
  }

  function trailerBlock(trailer, title) {
    if (!trailer || !trailer.id) return "";
    const id = String(trailer.id);
    if (trailer.site === "youtube" && /^[\w-]{6,20}$/.test(id)) {
      const thumb = U.safeUrl(trailer.thumbnail) || "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg";
      return html`
        <section>
          <h3>Trailer</h3>
          <button type="button" class="trailer" data-trailer="${id}" data-title="${title}">
            <img src="${thumb}" alt="" loading="lazy" decoding="async">
            <span class="trailer-play" aria-hidden="true">▶</span>
            <span class="visually-hidden">Play the trailer for ${title}</span>
          </button>
        </section>`;
    }
    if (trailer.site === "dailymotion" && /^[\w-]{4,24}$/.test(id)) {
      return html`
        <section>
          <h3>Trailer</h3>
          <a class="btn" href="https://www.dailymotion.com/video/${id}" target="_blank" rel="noopener noreferrer">Watch on Dailymotion <span aria-hidden="true">↗</span></a>
        </section>`;
    }
    return "";
  }

  function linkBlocks(m) {
    const seen = new Set();
    const links = (m.externalLinks || []).filter((link) => {
      const url = link && U.safeUrl(link.url);
      const id = link && link.site + "|" + (link.language || "");
      if (!url || !link.site || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const streaming = links.filter((link) => link.type === "STREAMING");
    const other = links.filter((link) => link.type !== "STREAMING");
    const pill = (link) => html`
      <a class="stream" href="${U.safeUrl(link.url)}" target="_blank" rel="noopener noreferrer"
         style="${raw(U.safeColor(link.color) ? "--brand:" + U.safeColor(link.color) : "")}">
        <span class="stream-dot" aria-hidden="true"></span>${link.site}${link.language && link.language !== "English" && link.language !== "Japanese" ? html` <small>${link.language}</small>` : ""}
      </a>`;
    return {
      streaming: streaming.length
        ? html`<section><h3>${m.type === "MANGA" ? "Where to read" : "Where to watch"}</h3><div class="streams">${streaming.map(pill)}</div></section>`
        : "",
      other: other.length ? html`<section><h3>Links</h3><div class="streams streams-small">${other.slice(0, 10).map(pill)}</div></section>` : ""
    };
  }

  function castBlock(m) {
    const edges = ((m.characters && m.characters.edges) || []).filter((edge) => edge && edge.node);
    if (!edges.length) return "";
    return html`
      <section>
        <h3>Characters</h3>
        <div class="cast">
          ${edges.map((edge) => {
            const c = edge.node;
            const va = (edge.voiceActors || [])[0];
            remember(characterSnapshot(Object.assign({}, c, { image: { large: c.image && c.image.medium } })), true);
            return html`
              <a class="person" href="#/character/${Number(c.id)}">
                ${coverImage(c.image && c.image.medium, 56, 78)}
                <span class="person-text"><strong>${(c.name && c.name.full) || "Unknown"}</strong><small>${U.humanize(edge.role)}</small></span>
                ${va ? html`<span class="person-va"><small>${(va.name && va.name.full) || ""}</small><small class="muted">Japanese voice</small></span>` : ""}
              </a>`;
          })}
        </div>
      </section>`;
  }

  function staffBlock(m) {
    const edges = ((m.staff && m.staff.edges) || []).filter((edge) => edge && edge.node);
    if (!edges.length) return "";
    return html`
      <section>
        <h3>Staff</h3>
        <ul class="staff">
          ${edges.map((edge) => html`<li><strong>${(edge.node.name && edge.node.name.full) || "Unknown"}</strong><small>${edge.role || ""}</small></li>`)}
        </ul>
      </section>`;
  }

  function relationsBlock(m) {
    const edges = ((m.relations && m.relations.edges) || [])
      .filter((edge) => edge && edge.node && !edge.node.isAdult)
      .sort((a, b) => {
        const ia = RELATION_ORDER.indexOf(a.relationType);
        const ib = RELATION_ORDER.indexOf(b.relationType);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
    if (!edges.length) return "";
    return html`
      <section>
        <h3>Related</h3>
        <div class="mini-row">
          ${edges.map((edge) => miniCard(edge.node, [U.humanize(edge.relationType), U.formatLabel(edge.node.format)].filter(Boolean).join(" · ")))}
        </div>
      </section>`;
  }

  function recommendationsBlock(m) {
    const seen = new Set();
    const nodes = ((m.recommendations && m.recommendations.nodes) || [])
      .map((node) => node && node.mediaRecommendation)
      .filter((rec) => rec && !rec.isAdult && !seen.has(rec.id) && seen.add(rec.id));
    if (!nodes.length) return "";
    return html`
      <section>
        <h3>If you liked this</h3>
        <div class="mini-row">
          ${nodes.map((rec) => miniCard(rec, [U.formatLabel(rec.format), rec.averageScore ? "★ " + rec.averageScore + "%" : ""].filter(Boolean).join(" · ")))}
        </div>
      </section>`;
  }

  function tagsBlock(m) {
    const tags = (m.tags || []).filter((tag) => tag && tag.name).sort((a, b) => (b.rank || 0) - (a.rank || 0)).slice(0, 18);
    if (!tags.length) return "";
    const spoilers = tags.filter((tag) => tag.isMediaSpoiler || tag.isGeneralSpoiler).length;
    return html`
      <section class="tags">
        <h3>Tags</h3>
        <div class="chips">
          ${tags.map((tag) => {
            const spoiler = tag.isMediaSpoiler || tag.isGeneralSpoiler;
            return html`<span class="chip chip-static${spoiler ? " chip-spoiler" : ""}">${tag.name}${tag.rank ? html` <small>${tag.rank}%</small>` : ""}</span>`;
          })}
        </div>
        ${spoilers ? html`<button type="button" class="link-button" data-toggle-spoilers aria-pressed="false">Show ${spoilers} spoiler tag${spoilers === 1 ? "" : "s"}</button>` : ""}
      </section>`;
  }

  function renderMedia(m) {
    const snapshot = remember(mediaSnapshot(m));
    const title = snapshot.title;
    const isManga = m.type === "MANGA";
    const cover = m.coverImage || {};
    const banner = U.safeUrl(m.bannerImage);
    const names = m.title || {};
    const altTitles = [names.romaji, names.native].filter((name) => name && name !== title);
    const studios = ((m.studios && m.studios.edges) || []).filter((edge) => edge && edge.node);
    const mainStudios = studios.filter((edge) => edge.isMain).map((edge) => edge.node.name);
    const studioNames = (mainStudios.length ? mainStudios : studios.slice(0, 2).map((edge) => edge.node.name)).join(", ");
    const season = m.season ? U.humanize(m.season) + (m.seasonYear ? " " + m.seasonYear : "") : "";
    const rankings = (m.rankings || []).filter((r) => r && r.rank).sort((a, b) => Number(b.allTime) - Number(a.allTime) || a.rank - b.rank).slice(0, 2);
    const airing = m.nextAiringEpisode;
    const links = linkBlocks(m);
    const kicker = [U.formatLabel(m.format), season || (m.startDate && m.startDate.year), U.statusLabel(m.status, m.type)].filter(Boolean).join(" · ");

    setHtml(
      dom.detailBody,
      html`
        <article class="detail" style="${cardStyle(0, cover.color)}">
          <div class="detail-banner${banner ? "" : " detail-banner-empty"}">${banner ? html`<img src="${banner}" alt="" decoding="async">` : ""}</div>
          <header class="detail-head">
            <div class="detail-cover">${coverImage(cover.extraLarge || cover.large, 230, 325)}</div>
            <div class="detail-headline">
              <p class="detail-kicker">${kicker}</p>
              <h2 id="detail-title">${title}</h2>
              ${altTitles.length ? html`<p class="detail-alt">${altTitles.join(" · ")}</p>` : ""}
              <div class="detail-stats">
                ${m.averageScore
                  ? html`<div class="score-ring" style="${raw("--score:" + U.clamp(Number(m.averageScore) || 0, 0, 100))}" role="img" aria-label="${"Average score " + m.averageScore + " percent"}"><span>${m.averageScore}<small>%</small></span></div>`
                  : ""}
                <div class="stat"><strong>${U.formatCompact(m.popularity)}</strong><small>${isManga ? "readers" : "viewers"}</small></div>
                <div class="stat"><strong>${U.formatCompact(m.favourites)}</strong><small>favourites</small></div>
                ${rankings.map((r) => html`<div class="stat stat-rank"><strong>#${r.rank}</strong><small>${rankingText(r).replace(/^#\d+\s*/, "")}</small></div>`)}
              </div>
              ${airing && airing.airingAt
                ? html`<p class="detail-airing">Episode ${airing.episode} airs in <strong data-airing-at="${airing.airingAt}">${U.countdown(airing.airingAt)}</strong></p>`
                : ""}
              ${detailActions(snapshot.key, title, m.siteUrl)}
            </div>
          </header>

          <div class="detail-columns">
            <div class="detail-main">
              <section><h3>Synopsis</h3><div class="prose" data-slot="description"></div></section>
              ${trailerBlock(m.trailer, title)}
              ${links.streaming}
              ${castBlock(m)}
              ${relationsBlock(m)}
              ${recommendationsBlock(m)}
            </div>
            <aside class="detail-side">
              <section>
                <h3>Details</h3>
                ${facts([
                  ["Format", U.formatLabel(m.format)],
                  [isManga ? "Chapters" : "Episodes", isManga ? m.chapters : m.episodes],
                  [isManga ? "Volumes" : "Episode length", isManga ? m.volumes : m.duration ? m.duration + " min" : ""],
                  ["Status", U.statusLabel(m.status, m.type)],
                  [isManga ? "Published" : "Aired", [U.fuzzyDate(m.startDate), U.fuzzyDate(m.endDate)].filter(Boolean).join(" – ")],
                  ["Season", season],
                  ["Studio", studioNames],
                  ["Source", U.humanize(m.source)],
                  ["Mean score", m.meanScore ? m.meanScore + "%" : ""]
                ])}
              </section>
              ${(m.genres || []).length
                ? html`<section><h3>Genres</h3><div class="chips">${m.genres.map((genre) => html`<a class="chip" href="${U.buildHash("browse", { type: isManga ? "manga" : "", genre })}">${genre}</a>`)}</div></section>`
                : ""}
              ${tagsBlock(m)}
              ${scoreDistribution(m.stats)}
              <div data-slot="mal"></div>
              ${staffBlock(m)}
              ${links.other}
            </aside>
          </div>
        </article>`
    );

    const description = $('[data-slot="description"]', dom.detailBody);
    if (m.description) description.appendChild(U.sanitizeHtml(m.description));
    else description.textContent = "No description available.";
    document.title = title + " · " + SITE_TITLE;
  }

  /** MyAnimeList score + opening/ending songs, added when (and only if) Jikan answers. */
  async function loadMalExtras(m, token) {
    const extras = await api.malExtras(m.type, m.idMal);
    const slot = $('[data-slot="mal"]', dom.detailBody);
    if (!extras || !slot || token !== state.modal.token) return;
    const themes = (label, songs) =>
      songs.length
        ? html`<h4>${label}</h4><ol class="themes">${songs.slice(0, 6).map((song) => html`<li>${song.replace(/^\d+:\s*/, "")}</li>`)}</ol>${songs.length > 6 ? html`<p class="muted">+${songs.length - 6} more</p>` : ""}`
        : "";
    if (!extras.score && !extras.openings.length && !extras.endings.length) return;
    setHtml(
      slot,
      html`
        <section class="mal">
          <h3>MyAnimeList</h3>
          ${extras.score
            ? html`<p class="mal-score"><strong>★ ${extras.score.toFixed(2)}</strong> <small>/ 10${extras.scoredBy ? " · " + U.formatCompact(extras.scoredBy) + " ratings" : ""}${extras.rank ? " · rank #" + extras.rank : ""}</small></p>`
            : ""}
          ${extras.broadcast && extras.broadcast !== "Unknown" ? html`<p class="muted">Broadcast: ${extras.broadcast}</p>` : ""}
          ${themes("Opening themes", extras.openings)}
          ${themes("Ending themes", extras.endings)}
          ${extras.url ? html`<p><a href="${extras.url}" target="_blank" rel="noopener noreferrer">View on MyAnimeList <span aria-hidden="true">↗</span></a></p>` : ""}
        </section>`
    );
  }

  /* ================================================================== */
  /* Details dialog: character                                           */
  /* ================================================================== */

  function renderCharacter(c) {
    const snapshot = remember(characterSnapshot(c));
    const name = snapshot.title;
    const names = c.name || {};
    const alt = [names.native].concat(names.alternative || []).filter((value) => value && value !== name).slice(0, 5);
    const edges = ((c.media && c.media.edges) || []).filter((edge) => edge && edge.node && !edge.node.isAdult);

    setHtml(
      dom.detailBody,
      html`
        <article class="detail detail-character">
          <div class="detail-banner detail-banner-empty"></div>
          <header class="detail-head">
            <div class="detail-cover">${coverImage(c.image && c.image.large, 230, 325)}</div>
            <div class="detail-headline">
              <p class="detail-kicker">Character</p>
              <h2 id="detail-title">${name}</h2>
              ${alt.length ? html`<p class="detail-alt">${alt.join(" · ")}</p>` : ""}
              <div class="detail-stats">
                <div class="stat"><strong>♥ ${U.formatCompact(c.favourites)}</strong><small>favourites</small></div>
              </div>
              ${facts([
                ["Gender", c.gender],
                ["Age", c.age],
                ["Birthday", U.fuzzyDate(c.dateOfBirth)],
                ["Blood type", c.bloodType]
              ])}
              ${detailActions(snapshot.key, name, c.siteUrl)}
            </div>
          </header>
          <div class="detail-columns detail-columns-single">
            <div class="detail-main">
              <section><h3>About</h3><div class="prose" data-slot="description"></div></section>
              ${edges.length
                ? html`
                    <section>
                      <h3>Appears in</h3>
                      <div class="mini-row mini-row-wrap">
                        ${edges.map((edge) => {
                          const va = (edge.voiceActors || [])[0];
                          const kicker = [U.humanize(edge.characterRole), U.formatLabel(edge.node.format)].filter(Boolean).join(" · ");
                          return html`<div class="appearance">${miniCard(edge.node, kicker)}${va && va.name ? html`<small class="muted">CV: ${va.name.full}</small>` : ""}</div>`;
                        })}
                      </div>
                    </section>`
                : ""}
            </div>
          </div>
        </article>`
    );

    const description = $('[data-slot="description"]', dom.detailBody);
    if (c.description) description.appendChild(U.sanitizeHtml(c.description));
    else description.textContent = "No biography available.";
    document.title = name + " · " + SITE_TITLE;
  }

  /* ================================================================== */
  /* Details dialog: open / close                                        */
  /* ================================================================== */

  function detailSkeleton() {
    return html`
      <div class="detail detail-loading" aria-hidden="true">
        <div class="detail-banner detail-banner-empty skeleton"></div>
        <header class="detail-head">
          <div class="detail-cover skeleton"></div>
          <div class="detail-headline"><p class="skeleton-text short">&nbsp;</p><p class="skeleton-text tall">&nbsp;</p><p class="skeleton-text">&nbsp;</p><p class="skeleton-text short">&nbsp;</p></div>
        </header>
      </div>
      <h2 id="detail-title" class="visually-hidden">Loading details…</h2>`;
  }

  async function openDetail(route) {
    const key = route.name + ":" + route.id;
    const modal = state.modal;
    if (modal.open && modal.key === key) return;
    modal.open = true;
    modal.key = key;
    const token = ++modal.token;

    if (dom.sceneDialog.open) dom.sceneDialog.close();
    setHtml(dom.detailBody, detailSkeleton());
    if (!dom.detailDialog.open) dom.detailDialog.showModal();
    document.documentElement.classList.add("modal-open");
    dom.detailDialog.scrollTop = 0;
    $(".modal-panel", dom.detailDialog).scrollTop = 0;

    busy(1);
    try {
      if (route.name === "character") {
        const c = await api.character(route.id);
        if (token !== modal.token) return;
        renderCharacter(c);
      } else {
        const m = await api.media(route.id);
        if (token !== modal.token) return;
        if (m.isAdult) {
          setHtml(
            dom.detailBody,
            html`<div class="state"><div class="state-emoji" aria-hidden="true">🔞</div><h2 id="detail-title">Not shown here</h2><p>This entry is marked as adult content on AniList, and this site only lists all-ages entries.</p></div>`
          );
          return;
        }
        renderMedia(m);
        loadMalExtras(m, token).catch(() => {});
      }
      scene.pulse(1.5);
    } catch (err) {
      if (token !== modal.token) return;
      console.error(err);
      setHtml(dom.detailBody, html`<h2 id="detail-title" class="visually-hidden">Details</h2>${errorState(err, "detail")}`);
    } finally {
      busy(-1);
    }
  }

  /** Tear the dialog down without touching history (history already moved on). */
  function closeDetailUi() {
    const modal = state.modal;
    if (!modal.open && !dom.detailDialog.open) return;
    modal.open = false;
    modal.key = "";
    modal.token++;
    modal.baseIndex = null;
    if (dom.detailDialog.open) dom.detailDialog.close();
    document.documentElement.classList.remove("modal-open");
    setHtml(dom.detailBody, ""); // also stops a playing trailer
    document.title = state.viewTitle;
  }

  /** The user asked to close: go back to the page underneath, keeping history tidy. */
  function requestCloseDetail() {
    const base = state.modal.baseIndex;
    if (base !== null && state.historyIndex > base) history.go(base - state.historyIndex);
    else replaceHash(state.viewHash || "#/");
  }

  /* ================================================================== */
  /* Scene search (trace.moe)                                            */
  /* ================================================================== */

  let sceneToken = 0;
  let scenePreviewUrl = "";

  function episodeText(episode) {
    if (Array.isArray(episode)) return episode.length ? "Episodes " + episode.join(", ") : "";
    if (episode === null || episode === undefined || episode === "") return "";
    return "Episode " + episode;
  }

  function renderSceneMatches(matches) {
    const seen = new Set();
    const unique = matches.filter((match) => {
      const id = match.id + "|" + JSON.stringify(match.episode);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }).slice(0, 5);

    if (!unique.length) {
      return html`<div class="state"><div class="state-emoji" aria-hidden="true">🍃</div><h3>No match found</h3><p>Try a clearer, uncropped screenshot taken straight from the episode.</p></div>`;
    }
    const confident = unique[0].similarity >= 0.87;
    return html`
      ${confident ? "" : html`<p class="notice">No confident match. These are only the closest frames, and they are probably wrong.</p>`}
      <ol class="matches">
        ${unique.map((match) => {
          const title = U.titleOf({ title: match.title || {} });
          const percent = Math.round(match.similarity * 100);
          const time = match.from !== null ? U.formatTimestamp(match.from) + (match.to !== null && match.to - match.from >= 1 ? " – " + U.formatTimestamp(match.to) : "") : "";
          return html`
            <li class="match${match.similarity >= 0.87 ? "" : " match-weak"}">
              <div class="match-media">
                ${match.video
                  ? html`<video src="${match.video}" poster="${match.image}" muted loop playsinline preload="none" aria-label="${"Preview of the matching scene from " + title}"></video>`
                  : match.image ? html`<img src="${match.image}" alt="" loading="lazy">` : ""}
              </div>
              <div class="match-text">
                <h3>${title}</h3>
                <p class="muted">${[episodeText(match.episode), time].filter(Boolean).join(" · ") || "Time unknown"}</p>
                <div class="meter" role="img" aria-label="${percent + " percent similar"}"><span style="${raw("--w:" + U.clamp(percent, 0, 100) + "%")}"></span></div>
                <p class="match-percent">${percent}% similar</p>
                <a class="btn btn-primary" href="#/anime/${Number(match.id)}">Open details</a>
              </div>
            </li>`;
        })}
      </ol>
      <p class="fine-print">Hover or tap a preview to play it. Matches under 87% are usually wrong.</p>`;
  }

  async function runSceneSearch(input) {
    const token = ++sceneToken;
    if (scenePreviewUrl) URL.revokeObjectURL(scenePreviewUrl);
    scenePreviewUrl = typeof input === "string" ? "" : URL.createObjectURL(input);
    setHtml(
      dom.sceneResults,
      html`
        <div class="scene-pending">
          ${scenePreviewUrl ? html`<img src="${scenePreviewUrl}" alt="Your image">` : ""}
          <p role="status"><span class="spinner" aria-hidden="true"></span> Comparing against millions of anime frames…</p>
        </div>`
    );
    busy(1);
    try {
      const matches = await api.traceSearch(input);
      if (token !== sceneToken) return;
      setHtml(dom.sceneResults, renderSceneMatches(matches));
      scene.pulse();
    } catch (err) {
      if (token !== sceneToken) return;
      console.error(err);
      setHtml(dom.sceneResults, errorState(err, ""));
    } finally {
      busy(-1);
    }
  }

  function handleSceneFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type || "")) {
      toast("Please choose an image file.", "warn");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast("That image is over 20 MB. Please use a smaller one.", "warn");
      return;
    }
    runSceneSearch(file);
  }

  function openSceneSearch() {
    if (dom.sceneDialog.open) return;
    dom.sceneDialog.showModal();
    document.documentElement.classList.add("modal-open");
  }

  function initSceneSearch() {
    dom.sceneButton.addEventListener("click", openSceneSearch);
    dom.sceneDialog.addEventListener("close", () => {
      sceneToken++;
      if (!dom.detailDialog.open) document.documentElement.classList.remove("modal-open");
      $$("video", dom.sceneResults).forEach((video) => video.pause());
    });
    dom.sceneFile.addEventListener("change", () => {
      handleSceneFile(dom.sceneFile.files && dom.sceneFile.files[0]);
      dom.sceneFile.value = "";
    });
    ["dragenter", "dragover"].forEach((type) =>
      dom.dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dom.dropzone.classList.add("dragover");
      })
    );
    ["dragleave", "drop"].forEach((type) => dom.dropzone.addEventListener(type, () => dom.dropzone.classList.remove("dragover")));
    dom.dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      handleSceneFile(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]);
    });
    document.addEventListener("paste", (event) => {
      if (!dom.sceneDialog.open || !event.clipboardData) return;
      const file = Array.from(event.clipboardData.files || []).find((f) => /^image\//.test(f.type));
      if (file) {
        event.preventDefault();
        handleSceneFile(file);
      }
    });
    dom.sceneUrlForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const url = dom.sceneUrl.value.trim();
      if (!U.safeUrl(url) || !/^https?:\/\//i.test(url)) {
        toast("Paste a full image link starting with https://", "warn");
        return;
      }
      runSceneSearch(url);
    });
    // Previews play on hover, focus or tap.
    const play = (event) => {
      const video = event.target.closest && event.target.closest(".match-media video");
      if (video) video.play().catch(() => {});
    };
    const stop = (event) => {
      const video = event.target.closest && event.target.closest(".match-media video");
      if (video) video.pause();
    };
    dom.sceneResults.addEventListener("pointerover", play);
    dom.sceneResults.addEventListener("pointerout", stop);
    dom.sceneResults.addEventListener("click", (event) => {
      const video = event.target.closest(".match-media video");
      if (video) (video.paused ? video.play().catch(() => {}) : video.pause());
    });
  }

  /* ================================================================== */
  /* Router                                                              */
  /* ================================================================== */

  function parseRoute(hash) {
    const text = String(hash || "").replace(/^#\/?/, "");
    const split = text.indexOf("?");
    const path = split === -1 ? text : text.slice(0, split);
    const params = new URLSearchParams(split === -1 ? "" : text.slice(split + 1));
    const segments = path.split("/").filter(Boolean);
    const head = (segments[0] || "").toLowerCase();
    const id = /^\d{1,9}$/.test(segments[1] || "") ? Number(segments[1]) : 0;

    if ((head === "anime" || head === "manga") && id) return { name: "media", id };
    if (head === "character" && id) return { name: "character", id };
    if (head === "browse" || head === "search") {
      const input = {};
      params.forEach((value, key) => (input[key] = value));
      return { name: "browse", filters: normalizeFilters(input) };
    }
    if (head === "list") return { name: "list" };
    return { name: "home" };
  }

  /**
   * Number the history entries this app creates, so closing a dialog can step back to the
   * page underneath instead of piling up new entries.
   */
  function trackHistory(initial) {
    const current = history.state;
    let index;
    if (current && typeof current.awIndex === "number") {
      index = current.awIndex;
    } else {
      index = initial ? 0 : state.historyIndex + 1;
      try {
        history.replaceState({ awIndex: index }, "");
      } catch (err) {
        /* some sandboxes forbid replaceState - closing a dialog still works via the hash */
      }
    }
    state.historyIndex = index;
  }

  function showView(route) {
    const hash = route.name === "browse" ? browseHash(route.filters) : route.name === "list" ? "#/list" : "#/";
    const key = route.name + ":" + hash;
    state.viewHash = hash;
    if (key === state.viewKey) return;
    const typing = route.name === "browse" && state.typedHash === hash;
    state.viewKey = key;
    state.viewName = route.name;

    $$(".view").forEach((view) => (view.hidden = view.id !== "view-" + route.name));
    document.body.dataset.view = route.name;
    $$("[data-nav]").forEach((link) => {
      if (link.dataset.nav === route.name) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });

    if (route.name === "browse") {
      showBrowse(route.filters);
    } else {
      // Leaving search: clear the query but keep the chosen mode.
      state.filters = Object.assign({}, DEFAULT_FILTERS, { type: currentMode() });
      syncForm(state.filters);
      setViewTitle(route.name === "list" ? "My List · " + SITE_TITLE : SITE_TITLE);
      if (route.name === "list") renderList();
      else loadHome();
    }
    if (!typing) window.scrollTo(0, 0);
  }

  function onRoute(initial) {
    state.routedHash = location.hash;
    trackHistory(initial);
    const route = parseRoute(location.hash);
    if (route.name === "media" || route.name === "character") {
      if (!state.viewName) showView({ name: "home" });
      if (!state.modal.open) state.modal.baseIndex = state.historyIndex > 0 ? state.historyIndex - 1 : null;
      openDetail(route);
      return;
    }
    closeDetailUi();
    showView(route);
  }

  /* ================================================================== */
  /* 3D effects: card tilt + on/off switch                               */
  /* ================================================================== */

  function initTilt() {
    const finePointer = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (!finePointer) return;
    let current = null;
    let frame = 0;
    let lastEvent = null;

    const release = () => {
      if (!current) return;
      current.classList.remove("tilting");
      current.style.removeProperty("--rx");
      current.style.removeProperty("--ry");
      current = null;
    };

    const apply = () => {
      frame = 0;
      if (!current || !lastEvent) return;
      const rect = current.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const px = U.clamp((lastEvent.clientX - rect.left) / rect.width, 0, 1);
      const py = U.clamp((lastEvent.clientY - rect.top) / rect.height, 0, 1);
      current.style.setProperty("--ry", ((px - 0.5) * 16).toFixed(2) + "deg");
      current.style.setProperty("--rx", ((0.5 - py) * 14).toFixed(2) + "deg");
      current.style.setProperty("--gx", (px * 100).toFixed(1) + "%");
      current.style.setProperty("--gy", (py * 100).toFixed(1) + "%");
    };

    document.addEventListener(
      "pointermove",
      (event) => {
        if (!state.fx || event.pointerType === "touch") return;
        const card = event.target.closest ? event.target.closest(".tilt") : null;
        if (card !== current) {
          release();
          current = card;
          if (current) current.classList.add("tilting");
        }
        if (!current) return;
        lastEvent = event;
        if (!frame) frame = requestAnimationFrame(apply);
      },
      { passive: true }
    );
    document.documentElement.addEventListener("pointerleave", release);
    window.addEventListener("blur", release);
    window.addEventListener("scroll", release, { passive: true });
  }

  function applyFx(announce) {
    document.documentElement.classList.toggle("fx-off", !state.fx);
    document.documentElement.classList.toggle("fx-on", state.fx);
    dom.fxButton.setAttribute("aria-pressed", state.fx ? "true" : "false");
    dom.fxButton.title = state.fx ? "3D effects are on. Click to turn them off." : "3D effects are off. Click to turn them on.";
    scene.setEnabled(state.fx, dom.canvas).then((running) => {
      if (announce && state.fx && !running) toast("3D background could not start on this device.", "warn");
    });
    if (announce) toast(state.fx ? "3D effects on ✨" : "3D effects off. Calm mode.");
  }

  /* ================================================================== */
  /* Event wiring                                                        */
  /* ================================================================== */

  function onDocumentClick(event) {
    const target = event.target;
    if (!target.closest) return;

    const fav = target.closest("[data-fav]");
    if (fav) {
      event.preventDefault();
      toggleFavourite(fav.dataset.fav);
      return;
    }
    const close = target.closest("[data-close]");
    if (close) {
      const dialog = close.closest("dialog");
      if (dialog === dom.detailDialog) requestCloseDetail();
      else if (dialog) dialog.close();
      return;
    }
    const retry = target.closest("[data-retry]");
    if (retry) {
      const what = retry.dataset.retry;
      if (what === "home") loadHome();
      else if (what === "browse") loadResults(false);
      else if (what === "detail") {
        state.modal.key = "";
        openDetail(parseRoute(location.hash));
      }
      return;
    }
    const railButton = target.closest("[data-rail]");
    if (railButton) {
      const track = $(".rail-track", railButton.parentElement);
      if (track) track.scrollBy({ left: Number(railButton.dataset.rail) * track.clientWidth * 0.85, behavior: state.fx ? "smooth" : "auto" });
      return;
    }
    const ringButton = target.closest("[data-ring]");
    if (ringButton) {
      ringStep(Number(ringButton.dataset.ring));
      return;
    }
    const trailer = target.closest("[data-trailer]");
    if (trailer) {
      const frame = document.createElement("iframe");
      frame.className = "trailer-frame";
      frame.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(trailer.dataset.trailer) + "?autoplay=1&rel=0";
      frame.title = "Trailer: " + (trailer.dataset.title || "");
      frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      frame.allowFullscreen = true;
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      trailer.replaceWith(frame);
      return;
    }
    const spoiler = target.closest(".spoiler");
    if (spoiler && !spoiler.classList.contains("revealed")) {
      spoiler.classList.add("revealed");
      spoiler.removeAttribute("role");
      spoiler.removeAttribute("tabindex");
      spoiler.removeAttribute("aria-label");
      return;
    }
    const spoilerToggle = target.closest("[data-toggle-spoilers]");
    if (spoilerToggle) {
      const section = spoilerToggle.closest(".tags");
      const shown = section.classList.toggle("show-spoilers");
      spoilerToggle.setAttribute("aria-pressed", shown ? "true" : "false");
      spoilerToggle.textContent = spoilerToggle.textContent.replace(/^(Show|Hide)/, shown ? "Hide" : "Show");
      return;
    }
    const share = target.closest("[data-share]");
    if (share) {
      shareCurrent(share.dataset.share);
      return;
    }
    if (target.closest("[data-clear-filters]")) {
      resetFilters();
    }
  }

  async function shareCurrent(title) {
    const url = location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: title + " · " + SITE_TITLE, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast("Link copied to clipboard");
    } catch (err) {
      if (err && err.name === "AbortError") return; // share sheet dismissed
      toast("Could not copy automatically. The link is in your address bar.", "warn");
    }
  }

  function resetFilters() {
    [dom.genre, dom.year, dom.season, dom.format, dom.status, dom.sort].forEach((select) => (select.value = ""));
    updateResetButton();
    if (state.viewName === "browse") go(browseHash(readForm()));
  }

  function initForm() {
    fillGenres();
    fillYears();
    fillTypeOptions("ANIME");
    updateResetButton();

    dom.form.addEventListener("submit", (event) => {
      event.preventDefault();
      liveSearch.cancel();
      go(browseHash(readForm()));
    });

    // Search as you type - debounced, and replacing history so Back is not flooded.
    const liveSearch = U.debounce(() => {
      const filters = readForm();
      const hash = browseHash(filters);
      if (hash === location.hash) return;
      if (state.viewName === "browse") {
        state.typedHash = hash;
        replaceHash(hash);
      } else if (filters.q.length >= 2) {
        state.typedHash = hash;
        go(hash);
      }
    }, 450);
    dom.input.addEventListener("input", () => {
      dom.sort.options[0].textContent = dom.input.value.trim() ? "Best match" : currentMode() === "CHARACTER" ? "Most favourited" : "Most popular";
      liveSearch();
    });

    $$('input[name="mode"]', dom.form).forEach((radio) =>
      radio.addEventListener("change", () => {
        const type = currentMode();
        fillTypeOptions(type); // options that do not exist for the new mode fall back to "Any"
        updateResetButton();
        if (state.viewName === "browse" || dom.input.value.trim()) go(browseHash(readForm()));
      })
    );

    [dom.genre, dom.year, dom.season, dom.format, dom.status, dom.sort].forEach((select) =>
      select.addEventListener("change", () => {
        updateResetButton();
        go(browseHash(readForm()));
      })
    );
    dom.reset.addEventListener("click", resetFilters);
    dom.filtersToggle.addEventListener("click", () => setFiltersOpen(!dom.form.classList.contains("filters-open")));
    dom.loadMore.addEventListener("click", () => loadResults(true));
  }

  function initGlobal() {
    document.addEventListener("click", onDocumentClick);

    document.addEventListener("keydown", (event) => {
      const el = event.target;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        dom.input.focus();
        dom.input.select();
        return;
      }
      // Spoilers are spans with role=button, so they need keyboard activation.
      if ((event.key === "Enter" || event.key === " ") && el && el.classList && el.classList.contains("spoiler")) {
        event.preventDefault();
        el.click();
      }
    });

    // Esc: let the router close the details dialog so the URL stays in sync.
    dom.detailDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      requestCloseDetail();
    });
    dom.detailDialog.addEventListener("close", () => {
      if (state.modal.open) requestCloseDetail();
    });
    // Click on the dimmed backdrop closes either dialog.
    [dom.detailDialog, dom.sceneDialog].forEach((dialog) =>
      dialog.addEventListener("click", (event) => {
        if (event.target !== dialog) return;
        if (dialog === dom.detailDialog) requestCloseDetail();
        else dialog.close();
      })
    );

    dom.randomButton.addEventListener("click", async () => {
      if (dom.randomButton.disabled) return;
      dom.randomButton.disabled = true;
      busy(1);
      try {
        go("#/anime/" + (await api.randomAnime()));
      } catch (err) {
        toast(err.message || "Could not pick a random anime.", "error");
      } finally {
        busy(-1);
        dom.randomButton.disabled = false;
      }
    });

    dom.listExport.addEventListener("click", exportFavourites);
    dom.listImport.addEventListener("click", () => dom.listFile.click());
    dom.listFile.addEventListener("change", () => {
      importFavourites(dom.listFile.files && dom.listFile.files[0]);
      dom.listFile.value = "";
    });

    dom.fxButton.addEventListener("click", () => {
      state.fx = !state.fx;
      U.store.set(FX_KEY, state.fx);
      applyFx(true);
    });

    dom.toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: state.fx ? "smooth" : "auto" }));
    let scrollFrame = 0;
    window.addEventListener(
      "scroll",
      () => {
        if (scrollFrame) return;
        scrollFrame = requestAnimationFrame(() => {
          scrollFrame = 0;
          dom.toTop.hidden = window.scrollY < 700;
          document.body.classList.toggle("scrolled", window.scrollY > 8);
        });
      },
      { passive: true }
    );

    window.addEventListener("resize", U.debounce(() => {
      measureRing();
      if (ring.el) ringGo(ring.index);
    }, 150));

    // Keep "airs in 2h 5m" labels honest while the page stays open.
    setInterval(() => {
      if (document.hidden) return;
      const now = Date.now();
      $$("[data-airing-at]").forEach((el) => (el.textContent = U.countdown(Number(el.dataset.airingAt), now)));
    }, 30000);

    // Another tab changed My List.
    window.addEventListener("storage", (event) => {
      if (event.key !== FAV_KEY) return;
      favourites = loadFavourites();
      refreshFavButtons();
      if (state.viewName === "list") renderList();
    });

    window.addEventListener("offline", () => toast("You are offline. Saved pages still work.", "warn"));
    window.addEventListener("online", () => toast("Back online"));

    let rateToast = null;
    api.on("ratelimit", (info) => {
      if (rateToast && rateToast.isConnected) return;
      const seconds = Math.ceil(info.waitMs / 1000);
      rateToast = toast("AniList limits requests per minute. Continuing in " + seconds + "s…", "warn", Math.min(info.waitMs + 500, 12000));
    });

    window.addEventListener("hashchange", () => {
      if (location.hash !== state.routedHash) onRoute(false); // back/forward, links, edited URL
    });
  }

  function init() {
    Object.assign(dom, {
      canvas: $("#scene"), progress: $("#progress"), toasts: $("#toasts"), favCount: $("#fav-count"),
      form: $("#search-form"), input: $("#search-bar"), buttonLabel: $("#search-button-label"), filters: $("#filters"),
      genre: $("#filter-genre"), year: $("#filter-year"), season: $("#filter-season"), format: $("#filter-format"),
      status: $("#filter-status"), sort: $("#filter-sort"), reset: $("#filter-reset"),
      filtersToggle: $("#filters-toggle"), filtersActive: $("#filters-active"),
      spotlight: $("#spotlight"), rails: $("#rails"), grid: $("#results-grid"), loadMore: $("#load-more"),
      resultsTitle: $("#results-title"), resultsStatus: $("#results-status"), listContent: $("#list-content"),
      detailDialog: $("#detail-dialog"), detailBody: $("#detail-body"),
      sceneDialog: $("#scene-dialog"), sceneButton: $("#scene-search-button"), sceneFile: $("#scene-file"),
      dropzone: $("#dropzone"), sceneUrlForm: $("#scene-url-form"), sceneUrl: $("#scene-url"), sceneResults: $("#scene-results"),
      randomButton: $("#random-button"), fxButton: $("#fx-button"), toTop: $("#to-top"),
      listExport: $("#list-export"), listImport: $("#list-import"), listFile: $("#list-file")
    });

    const storedFx = U.store.get(FX_KEY, null);
    state.fx = typeof storedFx === "boolean" ? storedFx : !U.prefersReducedMotion();

    initForm();
    initGlobal();
    initSceneSearch();
    initTilt();
    refreshFavButtons();
    applyFx(false);
    onRoute(true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
