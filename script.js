const searchButton = document.getElementById("search-button");
const searchBar = document.getElementById("search-bar");
const resultsGrid = document.getElementById("results-grid");
const loader = document.getElementById("loader");

const ANILIST_API = "https://graphql.anilist.co";

// Event Listener for Search Button
searchButton.addEventListener("click", () => {
    const query = searchBar.value.trim();
    if (query) {
        searchAnime(query);
    }
});

// Fetch Multiple Anime from AniList API
async function searchAnime(query) {
    loader.classList.remove("hidden");
    resultsGrid.innerHTML = ""; // Clear previous results

    try {
        const response = await fetch(ANILIST_API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: `
                    query ($search: String) {
                        Page(perPage: 10) {
                            media(search: $search, type: ANIME) {
                                id
                                title {
                                    romaji
                                }
                                description
                                coverImage {
                                    large
                                }
                                genres
                                episodes
                                status
                                popularity
                                externalLinks {
                                    site
                                    url
                                }
                            }
                        }
                    }
                `,
                variables: { search: query },
            }),
        });

        const data = await response.json();
        loader.classList.add("hidden");

        if (data.data.Page.media.length > 0) {
            displayResults(data.data.Page.media);
        } else {
            resultsGrid.innerHTML = "<p>No results found. Try a different search!</p>";
        }
    } catch (error) {
        loader.classList.add("hidden");
        resultsGrid.innerHTML = "<p>Something went wrong. Please try again later.</p>";
        console.error(error);
    }
}

// Display Results
function displayResults(animeList) {
    animeList.forEach((anime) => {
        const card = document.createElement("div");
        card.classList.add("card");

        const externalLinks = anime.externalLinks
            .map((link) => `<a href="${link.url}" target="_blank">${link.site}</a>`)
            .join(", ");

        card.innerHTML = `
            <img src="${anime.coverImage.large}" alt="${anime.title.romaji}">
            <h2>${anime.title.romaji}</h2>
            <p>${anime.description ? anime.description.slice(0, 100) + "..." : "No description available."}</p>
            <p><strong>Genres:</strong> ${anime.genres.join(", ")}</p>
            <p><strong>Episodes:</strong> ${anime.episodes || "N/A"}</p>
            <p><strong>Status:</strong> ${anime.status}</p>
            <p><strong>Popularity:</strong> ${anime.popularity}</p>
            <p><strong>Available on:</strong> ${externalLinks}</p>
            <a href="https://anilist.co/anime/${anime.id}" target="_blank">Read More</a>
        `;

        resultsGrid.appendChild(card);
    });
}
