function createCard({ title, description, coverImage }) {
    return `
      <div class="card">
        <img src="${coverImage.large}" alt="${title.romaji}">
        <h2>${title.romaji || title.english}</h2>
        <p>${description ? description.slice(0, 100) + "..." : "No description available."}</p>
      </div>
    `;
  }
  