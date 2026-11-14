# 🌸 Anime Hub Dictionary 🌸

**Discover the anime world, one search at a time!**

Anime Hub Dictionary is a fast, no-build web app for exploring anime, manga and characters. It has a neon black, yellow and sakura-pink look, a live WebGL background, and it runs entirely in the browser on public APIs. There is no server and no API key.

**Live demo:** [theanomality.github.io/AnimeWiki](https://theanomality.github.io/AnimeWiki/)

## Features

- 🔍 **Search anime, manga and characters** with a one-tap mode switch. Results update as you type, and the Enter key works too.
- 🎛️ **Filters and sorting**: genre, year, season, format, status, plus sort by popularity, score, trending, newest, favourites or title.
- 🔥 **Discover page**: trending now, airing soon (with live countdowns), popular this season, coming next season, all-time top rated, trending manga and a genre cloud.
- 📖 **Detail pages** for every anime and manga: synopsis, score, rankings, studios, trailer, where to watch, characters and Japanese voice actors, staff, related titles, recommendations, tags (spoilers hidden) and a score histogram.
- 🧑‍🎤 **Character pages**: biography with click-to-reveal spoilers, birthday, blood type and every title they appear in.
- 📷 **Scene search**: drop in a screenshot and find the anime, the episode and the timestamp.
- 💛 **My List**: save favourites in your browser. No account needed.
- 🎲 **Surprise me**: jump to a random popular anime.
- 🔗 **Shareable links**: every search, filter set and detail page has its own URL, and Back/Forward work as expected.
- 📱 **Responsive** from phones to wide desktops, and usable with keyboard and screen readers.

## 3D and animation

- **WebGL background** (three.js): sakura petals falling through 3D space, a star field and a rotating neon gem behind the title. It follows your pointer, drifts as you scroll and speeds up while data loads.
- **Trending ring**: a CSS 3D carousel you can drag, swipe or step through with the arrows.
- **Tilting cards**: cards lean toward the pointer with a moving highlight and layered depth.
- **3D entrances** for cards and dialogs, and extruded 3D lettering on the title.

The ✨ **3D** button turns all of it off (and back on). If your system asks for reduced motion, effects start switched off and three.js is not even downloaded. On slow devices the scene sheds detail automatically.

## Public APIs

| API | Used for |
| --- | --- |
| [AniList GraphQL](https://docs.anilist.co) | All anime, manga and character data |
| [Jikan](https://jikan.moe) (MyAnimeList) | MyAnimeList score and opening/ending theme songs on detail pages |
| [trace.moe](https://soruly.github.io/trace.moe-api/) | Scene search from a screenshot |

How the AniList API is used well:

- **One request for the whole Discover page.** Six lists and the genre collection are fetched together with GraphQL aliases.
- **Polite to the rate limit.** Responses are cached (memory + `sessionStorage`), identical in-flight requests are shared, and a client-side budget keeps the app under the per-minute limit. On a `429` the app waits for the time the server asks for, tells you, and retries by itself.
- **Errors handled properly.** AniList can return errors with HTTP 200, so the `errors` array is always checked. Network failures, timeouts, "not found" and API outages each get their own message and a retry button.
- **Pagination by `hasNextPage` only**, as the AniList docs recommend.
- **All-ages only**: every query sends `isAdult: false`.

Jikan and trace.moe are optional extras. If either is down, the rest of the site works normally.

## Privacy

- Favourites and settings stay in your browser (`localStorage`).
- Scene search sends the image you choose to trace.moe so it can be matched. It is resized in your browser first. Nothing else is uploaded anywhere.

## Tech stack

- **HTML, CSS and JavaScript** with no framework and no build step
- **[three.js](https://threejs.org)** loaded on demand from jsDelivr for the background
- **GitHub Pages** for hosting

| File | What it does |
| --- | --- |
| `index.html` | Page structure, dialogs and the Content Security Policy |
| `style.css` | Theme, layout, CSS 3D ring, card tilt, responsive rules |
| `script.js` | The app: routing, search, filters, rendering, favourites, scene search |
| `api.js` | AniList, Jikan and trace.moe clients: caching, rate limiting, errors |
| `scene.js` | The WebGL background |
| `utils.js` | HTML escaping and sanitizing, formatting and small helpers |

Everything that comes from an API is escaped before it reaches the page, descriptions go through a whitelist sanitizer, and a Content Security Policy limits what the page may load.

## Run it locally

```bash
git clone https://github.com/TheAnomality/AnimeWiki.git
cd AnimeWiki
```

Then open `index.html` in your browser. That is all. If you prefer a local server:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Keyboard

| Key | Action |
| --- | --- |
| `/` | Jump to the search box |
| `Enter` | Search |
| `←` `→` | Turn the trending ring (when it has focus) |
| `Esc` | Close a dialog |

## Contributing

Contributions are welcome! Fork the repository and open a pull request with your improvement or new feature.

## Credits

Data from [AniList](https://anilist.co), [MyAnimeList](https://myanimelist.net) via [Jikan](https://jikan.moe), and [trace.moe](https://trace.moe). This is a fan project and is not affiliated with any of them.
