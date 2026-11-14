/*
 * Anime Hub Dictionary - shared helpers.
 * Everything here is pure / DOM-light so the rest of the app can stay readable.
 */
(function () {
  "use strict";

  const AW = (window.AnimeWiki = window.AnimeWiki || {});

  /* ------------------------------------------------------------------ */
  /* Safe HTML                                                           */
  /* ------------------------------------------------------------------ */

  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"'`]/g, (ch) => ESCAPES[ch]);
  }

  /** Marks a string as already-safe markup so `html` does not escape it again. */
  class SafeHtml {
    constructor(value) {
      this.value = value;
    }
    toString() {
      return this.value;
    }
  }

  const raw = (value) => new SafeHtml(String(value == null ? "" : value));

  function toMarkup(value) {
    if (value == null || value === false || value === true) return "";
    if (value instanceof SafeHtml) return value.value;
    if (Array.isArray(value)) return value.map(toMarkup).join("");
    return escapeHtml(value);
  }

  /**
   * Tagged template that escapes every interpolated value by default.
   * API data can never become markup unless it is explicitly wrapped in raw().
   */
  function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) out += toMarkup(values[i]) + strings[i + 1];
    return new SafeHtml(out);
  }

  /** Only http(s) URLs are allowed into href/src attributes. */
  function safeUrl(url) {
    if (typeof url !== "string" || !url) return "";
    try {
      const parsed = new URL(url, "https://anilist.co/");
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
    } catch (err) {
      return "";
    }
  }

  function safeColor(color) {
    return typeof color === "string" && /^#[0-9a-f]{3,8}$/i.test(color) ? color : "";
  }

  const ALLOWED_TAGS = new Set([
    "B", "STRONG", "I", "EM", "U", "S", "DEL", "BR", "P", "UL", "OL", "LI",
    "BLOCKQUOTE", "CODE", "PRE", "HR", "SPAN", "A", "H1", "H2", "H3", "H4", "H5", "H6", "DIV", "CENTER"
  ]);
  const DROPPED_TAGS = new Set([
    "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "IMG", "VIDEO", "AUDIO", "SVG", "MATH", "LINK",
    "META", "TEMPLATE", "FORM", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "NOSCRIPT", "BASE", "HEAD", "TITLE"
  ]);
  const RENAMED_TAGS = { H1: "h4", H2: "h4", H3: "h4", H4: "h4", H5: "h4", H6: "h4", CENTER: "div" };

  function cleanNode(node, doc, out) {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        out.appendChild(doc.createTextNode(child.nodeValue));
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const tag = child.tagName.toUpperCase();
      if (DROPPED_TAGS.has(tag)) return;
      if (!ALLOWED_TAGS.has(tag)) {
        cleanNode(child, doc, out); // unwrap unknown tags, keep their text
        return;
      }

      let el;
      if (tag === "A") {
        const href = safeUrl(child.getAttribute("href"));
        if (!href) {
          cleanNode(child, doc, out);
          return;
        }
        el = doc.createElement("a");
        el.setAttribute("href", href);
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer nofollow");
      } else if (tag === "SPAN" && /\bmarkdown_spoiler\b/.test(child.getAttribute("class") || "")) {
        el = doc.createElement("span");
        el.className = "spoiler";
        el.setAttribute("role", "button");
        el.setAttribute("tabindex", "0");
        el.setAttribute("aria-label", "Spoiler, activate to reveal");
      } else {
        el = doc.createElement(RENAMED_TAGS[tag] || tag.toLowerCase());
      }
      cleanNode(child, doc, el);
      out.appendChild(el);
    });
  }

  /**
   * Whitelist sanitizer for AniList descriptions (which are user-edited HTML).
   * Returns a DocumentFragment; nothing from the input is ever parsed as live markup.
   */
  function sanitizeHtml(dirty) {
    const fragment = document.createDocumentFragment();
    if (!dirty) return fragment;
    const parsed = new DOMParser().parseFromString(String(dirty), "text/html");
    cleanNode(parsed.body, document, fragment);
    return fragment;
  }

  /** Plain-text version of a description, for excerpts. */
  function stripHtml(dirty) {
    if (!dirty) return "";
    const parsed = new DOMParser().parseFromString(String(dirty).replace(/<br\s*\/?>/gi, " "), "text/html");
    parsed.body.querySelectorAll("script,style,.markdown_spoiler").forEach((el) => el.remove());
    return (parsed.body.textContent || "")
      .replace(/~!([\s\S]*?)!~/g, "") // AniList markdown spoilers
      .replace(/\s+/g, " ")
      .trim();
  }

  function truncate(text, max) {
    if (!text || text.length <= max) return text || "";
    const cut = text.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!-]+$/, "") + "…";
  }

  /* ------------------------------------------------------------------ */
  /* Formatting                                                          */
  /* ------------------------------------------------------------------ */

  const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  const fullNumber = new Intl.NumberFormat("en");

  function formatCompact(n) {
    return typeof n === "number" && isFinite(n) ? compactNumber.format(n) : "–";
  }

  function formatNumber(n) {
    return typeof n === "number" && isFinite(n) ? fullNumber.format(n) : "–";
  }

  const FORMAT_LABELS = {
    TV: "TV", TV_SHORT: "TV Short", MOVIE: "Movie", SPECIAL: "Special", OVA: "OVA", ONA: "ONA",
    MUSIC: "Music", MANGA: "Manga", NOVEL: "Light Novel", ONE_SHOT: "One-shot"
  };

  const STATUS_LABELS = {
    ANIME: { FINISHED: "Finished", RELEASING: "Airing", NOT_YET_RELEASED: "Upcoming", CANCELLED: "Cancelled", HIATUS: "On hiatus" },
    MANGA: { FINISHED: "Finished", RELEASING: "Publishing", NOT_YET_RELEASED: "Upcoming", CANCELLED: "Cancelled", HIATUS: "On hiatus" }
  };

  /** "NOT_YET_RELEASED" -> "Not yet released" */
  function humanize(value) {
    if (!value) return "";
    const text = String(value).replace(/_/g, " ").toLowerCase();
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function formatLabel(format) {
    return FORMAT_LABELS[format] || humanize(format);
  }

  function statusLabel(status, type) {
    const table = STATUS_LABELS[type === "MANGA" ? "MANGA" : "ANIME"];
    return table[status] || humanize(status);
  }

  /** Preferred display title with graceful fallbacks (any of them can be null). */
  function titleOf(media) {
    const t = (media && media.title) || {};
    return t.english || t.romaji || t.native || "Untitled";
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /** AniList FuzzyDate ({year, month, day}, each nullable) -> readable text or "". */
  function fuzzyDate(date) {
    if (!date) return "";
    const { year, month, day } = date;
    const m = month ? MONTHS[month - 1] : "";
    if (m && day && year) return `${m} ${day}, ${year}`;
    if (m && year) return `${m} ${year}`;
    if (m && day) return `${m} ${day}`;
    if (year) return String(year);
    return "";
  }

  /** Seconds-since-epoch airing time -> "2d 4h" / "3h 12m" / "12m" / "now". */
  function countdown(airingAt, now) {
    const seconds = Math.floor(airingAt - (now || Date.now()) / 1000);
    if (!isFinite(seconds)) return "";
    if (seconds <= 60) return "now";
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function formatTimestamp(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }

  const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];

  /** The broadcast season a date falls in (Jan-Mar winter, Apr-Jun spring, ...). */
  function seasonOf(date) {
    const d = date || new Date();
    return { season: SEASONS[Math.floor(d.getMonth() / 3)], year: d.getFullYear() };
  }

  function nextSeasonOf(current) {
    const index = SEASONS.indexOf(current.season);
    return index === 3 ? { season: SEASONS[0], year: current.year + 1 } : { season: SEASONS[index + 1], year: current.year };
  }

  /* ------------------------------------------------------------------ */
  /* Small utilities                                                     */
  /* ------------------------------------------------------------------ */

  function debounce(fn, wait) {
    let timer = 0;
    const debounced = function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
    debounced.cancel = () => clearTimeout(timer);
    return debounced;
  }

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** localStorage that never throws (private mode, disabled storage, quota). */
  const store = {
    get(key, fallback) {
      try {
        const value = window.localStorage.getItem(key);
        return value == null ? fallback : JSON.parse(value);
      } catch (err) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (err) {
        return false;
      }
    }
  };

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /** Build "#/path?a=1&b=2", skipping empty values. */
  function buildHash(path, params) {
    const query = new URLSearchParams();
    Object.keys(params || {}).forEach((key) => {
      const value = params[key];
      if (value !== undefined && value !== null && value !== "") query.set(key, value);
    });
    const qs = query.toString();
    return "#/" + path + (qs ? "?" + qs : "");
  }

  AW.utils = {
    escapeHtml, html, raw, SafeHtml, safeUrl, safeColor, sanitizeHtml, stripHtml, truncate,
    formatCompact, formatNumber, humanize, formatLabel, statusLabel, titleOf, fuzzyDate, countdown,
    formatTimestamp, seasonOf, nextSeasonOf, debounce, clamp, sleep, store, prefersReducedMotion, buildHash
  };
})();
