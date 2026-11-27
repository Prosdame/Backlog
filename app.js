// --- STATO APPLICAZIONE ---
let backlog = [];
let csStoresMap = {};
let currentTab = "wishlist";
let currentSha = null;
let currentModalGameId = null;
let searchDebounceTimer = null;
let latestSearchSeq = 0;

const FALLBACK_GAME_THUMB =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="45" viewBox="0 0 120 45">
      <rect width="120" height="45" rx="6" fill="#1e293b"/>
      <rect x="1" y="1" width="118" height="43" rx="5" fill="none" stroke="#334155" stroke-width="1.5"/>
      <path d="M49 27l3-9c.6-1.8 2.3-3 4.2-3h7.6c1.9 0 3.6 1.2 4.2 3l3 9c.7 2.1-.9 4.2-3.1 4.2-1.2 0-2.3-.6-2.9-1.6l-1.4-2.1h-7.2l-1.4 2.1c-.6 1-1.7 1.6-2.9 1.6-2.2 0-3.8-2.1-3.1-4.2z" fill="none" stroke="#64748b" stroke-width="1.8" stroke-linejoin="round"/>
      <circle cx="64.5" cy="20.5" r="1.2" fill="#38bdf8"/>
      <circle cx="67" cy="23" r="1.2" fill="#38bdf8"/>
      <path d="M54.5 20.5v4M52.5 22.5h4" stroke="#94a3b8" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`
  );

// Configurazione GitHub + IsThereAnyDeal salvata localmente nel dispositivo
let appConfig = {
  owner: localStorage.getItem("gh_owner") || detectRepoFromUrl().owner,
  repo: localStorage.getItem("gh_repo") || detectRepoFromUrl().repo,
  token: localStorage.getItem("gh_token") || "",
  itadKey: localStorage.getItem("itad_api_key") || ""
};

function detectRepoFromUrl() {
  const host = window.location.hostname;
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  if (host.endsWith(".github.io")) {
    return { owner: host.split(".")[0], repo: pathParts[0] || "" };
  }
  return { owner: "", repo: "" };
}

// Utility Base64 compatibili con caratteri UTF-8
function encodeBase64UTF8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCodePoint(b)));
  return btoa(bin);
}

function decodeBase64UTF8(base64) {
  const bin = atob(base64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (m) => m.codePointAt(0));
  return new TextDecoder().decode(bytes);
}

function normalizeTitleForMatch(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/[:\-–—_.,!?'"()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- PRIORITÀ STORE PREFERITI (STEAM, EPIC, GOG) ---
function getPreferredStoreRank(storeName) {
  const name = (storeName || "").trim().toLowerCase();
  if (name === "steam") return 0;
  if (name.includes("epic")) return 1;
  if (name === "gog" || name.startsWith("gog.")) return 2;
  return 3;
}

function sortDealsForDropdown(deals) {
  return [...deals].sort((a, b) => {
    const rankA = getPreferredStoreRank(a.storeName);
    const rankB = getPreferredStoreRank(b.storeName);
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    if (Math.abs(a.price - b.price) > 0.001) {
      return a.price - b.price;
    }
    return a.storeName.localeCompare(b.storeName);
  });
}

// --- FORMATTAZIONE VALUTA & DATE ---
function formatMoney(amount, currency = "EUR") {
  if (amount === null || amount === undefined || isNaN(amount)) return "N/D";
  const sym = currency === "USD" ? "$" : "€";
  return `${sym}${Number(amount).toFixed(2)}`;
}

function parseReleaseStatusFromISO(isoDate) {
  if (!isoDate) {
    return { released: false, releaseDate: "TBA", releaseDateISO: null };
  }
  const parsed = new Date(`${isoDate}T23:59:59`);
  if (isNaN(parsed.getTime())) {
    return { released: false, releaseDate: isoDate, releaseDateISO: null };
  }
  const now = new Date();
  const isRel = parsed <= now;
  const formatted = new Date(`${isoDate}T12:00:00`).toLocaleDateString("it-IT", {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
  return {
    released: isRel,
    releaseDate: formatted,
    releaseDateISO: isoDate
  };
}

function isGameReleased(game) {
  if (!game.manualReleaseOverride && game.releaseDateISO) {
    const parsed = new Date(`${game.releaseDateISO}T23:59:59`);
    if (!isNaN(parsed.getTime())) {
      return parsed <= new Date();
    }
  }
  if (typeof game.released === "boolean") {
    return game.released;
  }
  if (game.releaseNote && game.releaseNote.trim() !== "") {
    return false;
  }
  return game.salePrice !== null && game.salePrice !== undefined;
}

function getReleaseDateText(game) {
  if (typeof game.releaseDate === "string" && game.releaseDate.trim() !== "") {
    return game.releaseDate.trim();
  }
  if (typeof game.releaseNote === "string" && game.releaseNote.trim() !== "") {
    return game.releaseNote.replace(/^Rilascio:\s*/i, "").trim();
  }
  return "";
}

function getReleaseBadgeInfo(game) {
  const released = isGameReleased(game);
  const dateText = getReleaseDateText(game);
  if (released) {
    return {
      text: dateText && dateText !== "TBA" ? `Rilasciato (${dateText})` : "Rilasciato",
      badgeClass: "badge-blue"
    };
  }
  return {
    text: dateText ? `Non Rilasciato · ${dateText}` : "Non Rilasciato · TBA",
    badgeClass: "badge-warn"
  };
}

// --- UNIFICAZIONE E ORDINAMENTO OFFERTE (ITAD EUR + LEGACY + KEYSHOP) ---
function getAllDeals(game) {
  const defaultCurrency = game.currency || (game.itadId ? "EUR" : "USD");

  const officialDeals = (Array.isArray(game.deals) ? game.deals : []).map((d) => {
    if (d.shopName !== undefined && d.price !== undefined) {
      return {
        uid: d.uid || `itad_${d.shopId || d.shopName}`,
        isCustom: false,
        storeName: d.shopName,
        price: parseFloat(d.price),
        retailPrice: parseFloat(d.retailPrice),
        savings: Math.round(parseFloat(d.savings || 0)),
        currency: d.currency || defaultCurrency,
        url: d.url || ""
      };
    }
    return {
      uid: `cs_${d.storeID}`,
      isCustom: false,
      storeName: csStoresMap[d.storeID] || `Store #${d.storeID}`,
      price: parseFloat(d.price),
      retailPrice: parseFloat(d.retailPrice),
      savings: Math.round(parseFloat(d.savings || 0)),
      currency: "USD",
      url: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`
    };
  });

  const fallbackRetail = officialDeals.length > 0
    ? officialDeals[0].retailPrice
    : (game.retailPrice !== null && game.retailPrice > 0 ? parseFloat(game.retailPrice) : null);

  const customDeals = (Array.isArray(game.customDeals) ? game.customDeals : []).map((c) => {
    const price = parseFloat(c.price);
    const retail = c.retailPrice && parseFloat(c.retailPrice) > 0
      ? parseFloat(c.retailPrice)
      : (fallbackRetail !== null ? fallbackRetail : price);
    const savings = retail > price && retail > 0
      ? Math.round(((retail - price) / retail) * 100)
      : 0;

    return {
      uid: c.id,
      isCustom: true,
      storeName: c.storeName,
      price,
      retailPrice: retail,
      savings,
      currency: c.currency || "EUR",
      url: c.url || ""
    };
  });

  return [...officialDeals, ...customDeals].sort((a, b) => {
    if (Math.abs(a.price - b.price) > 0.001) {
      return a.price - b.price;
    }
    return a.storeName.localeCompare(b.storeName);
  });
}

function findSelectedDeal(game, allDeals) {
  if (!allDeals.length) return null;
  if (game.selectedStoreId) {
    const sel = game.selectedStoreId.toString();
    const match = allDeals.find((d) => d.uid === sel || d.uid === `cs_${sel}` || d.uid === `itad_${sel}`);
    if (match) return match;
  }
  return allDeals[0];
}

function applyDealToGame(game, deal) {
  if (!deal) return;
  game.selectedStoreId = deal.uid;
  game.salePrice = deal.price;
  game.retailPrice = deal.retailPrice;
  game.discount = deal.savings;
  game.bestStore = deal.storeName;
  game.currency = deal.currency || "EUR";
}

function getKeyshopSearchLinks(title) {
  const q = encodeURIComponent(title);
  return [
    { name: "Instant Gaming", url: `https://www.instant-gaming.com/it/ricerca/?q=${q}`, highlight: true },
    { name: "CDKeys", url: `https://www.cdkeys.com/?q=${q}`, highlight: false },
    { name: "Eneba", url: `https://www.eneba.com/store/all?text=${q}`, highlight: false },
    { name: "Kinguin", url: `https://www.kinguin.net/listing?phrase=${q}`, highlight: false },
    { name: "G2A", url: `https://www.g2a.com/search?query=${q}`, highlight: false },
    { name: "GG.deals", url: `https://gg.deals/games/?title=${q}`, highlight: false },
    { name: "Steam Store", url: `https://store.steampowered.com/search/?term=${q}`, highlight: false }
  ];
}

// --- INIZIALIZZAZIONE ---
document.addEventListener("DOMContentLoaded", async () => {
  updateEngineBadge();
  bindEvents();
  await Promise.all([loadCheapSharkStoresMap(), loadBacklog()]);
});

function updateEngineBadge() {
  const el = document.getElementById("apiEngineBadge");
  if (appConfig.itadKey) {
    el.textContent = "Store: ITAD (EUR €)";
    el.className = "badge badge-blue";
  } else {
    el.textContent = "Store: ITAD Auto-Sync (EUR €)";
    el.className = "badge badge-blue";
  }
}

function bindEvents() {
  // Tabs
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      currentTab = btn.dataset.tab;
      document.getElementById("sectionWishlist").classList.toggle("hidden", currentTab !== "wishlist");
      document.getElementById("sectionOwned").classList.toggle("hidden", currentTab !== "owned");
      document.getElementById("filterWishlistState").classList.toggle("hidden", currentTab !== "wishlist");
      document.getElementById("sortWishlist").classList.toggle("hidden", currentTab !== "wishlist");
      document.getElementById("filterStatus").classList.toggle("hidden", currentTab !== "owned");
      render();
    });
  });

  // Filtri e ordinamento live
  document.getElementById("filterText").addEventListener("input", render);
  document.getElementById("filterHype").addEventListener("change", render);
  document.getElementById("filterWishlistState").addEventListener("change", render);
  document.getElementById("sortWishlist").addEventListener("change", render);
  document.getElementById("filterStatus").addEventListener("change", render);

  // Ricerca giochi live (suggerimenti mentre si digita) + invio immediato
  const searchInputEl = document.getElementById("searchInput");
  const searchResultsEl = document.getElementById("searchResults");

  searchInputEl.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    const q = searchInputEl.value.trim();
    if (q.length < 2) {
      latestSearchSeq++;
      searchResultsEl.classList.add("hidden");
      searchResultsEl.innerHTML = "";
      return;
    }
    searchDebounceTimer = setTimeout(() => {
      searchGames(true);
    }, 300);
  });

  searchInputEl.addEventListener("focus", () => {
    if (searchInputEl.value.trim().length >= 2 && searchResultsEl.innerHTML.trim() !== "") {
      searchResultsEl.classList.remove("hidden");
    }
  });

  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(searchDebounceTimer);
      searchGames(false);
    } else if (e.key === "Escape") {
      searchResultsEl.classList.add("hidden");
    }
  });

  document.getElementById("btnSearch").addEventListener("click", () => {
    clearTimeout(searchDebounceTimer);
    searchGames(false);
  });

  // Chiude i suggerimenti cliccando fuori dal pannello di ricerca
  document.addEventListener("click", (e) => {
    const addPanel = document.querySelector(".add-panel");
    if (addPanel && !addPanel.contains(e.target)) {
      searchResultsEl.classList.add("hidden");
    }
  });

  // Form manuale
  document.getElementById("btnToggleManual").addEventListener("click", () => {
    document.getElementById("manualForm").classList.toggle("hidden");
  });
  document.getElementById("manualForm").addEventListener("submit", addManualGame);

  // Salvataggio stato/data rilascio nel modal
  document.getElementById("releaseEditorForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const game = backlog.find((g) => g.id === currentModalGameId);
    if (!game) return;

    const stateVal = document.getElementById("modalReleaseState").value;
    const dateVal = document.getElementById("modalReleaseDate").value.trim();

    game.released = stateVal === "released";
    game.releaseDate = dateVal;
    game.releaseNote = game.released ? "" : (dateVal || "TBA");
    game.manualReleaseOverride = true;

    await saveBacklog(`Update release info for ${game.title}`);
  });

  // Form aggiunta Keyshop / Store custom nel modal
  document.getElementById("customDealForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const game = backlog.find((g) => g.id === currentModalGameId);
    if (!game) return;

    const storeName = document.getElementById("customStoreName").value.trim();
    const salePrice = parseFloat(document.getElementById("customSalePrice").value);
    const retailRaw = document.getElementById("customRetailPrice").value.trim();
    const url = document.getElementById("customDealUrl").value.trim();

    if (!storeName || isNaN(salePrice)) return;

    if (!Array.isArray(game.customDeals)) {
      game.customDeals = [];
    }

    const newCustomId = `custom_${Date.now()}`;
    game.customDeals.push({
      id: newCustomId,
      storeName,
      price: salePrice,
      retailPrice: retailRaw ? parseFloat(retailRaw) : null,
      currency: "EUR",
      url
    });

    const allDeals = getAllDeals(game);
    const addedDeal = allDeals.find((d) => d.uid === newCustomId);
    if (addedDeal) {
      applyDealToGame(game, addedDeal);
    }

    document.getElementById("customDealForm").reset();
    renderDealsModalContent(game);
    await saveBacklog(`Add ${storeName} price for ${game.title}`);
  });

  // Ricarica e aggiornamento massivo
  document.getElementById("btnReloadBacklog").addEventListener("click", loadBacklog);
  document.getElementById("btnRefreshAll").addEventListener("click", refreshAllPrices);

  // Modals
  document.getElementById("btnOpenConfig").addEventListener("click", () => {
    document.getElementById("cfgOwner").value = appConfig.owner;
    document.getElementById("cfgRepo").value = appConfig.repo;
    document.getElementById("cfgToken").value = appConfig.token;
    document.getElementById("cfgItadKey").value = appConfig.itadKey;
    document.getElementById("configModal").classList.remove("hidden");
  });

  document.querySelectorAll(".btn-close").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById(btn.dataset.close).classList.add("hidden");
      if (btn.dataset.close === "dealsModal") {
        currentModalGameId = null;
      }
    });
  });

  document.getElementById("configForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    appConfig.owner = document.getElementById("cfgOwner").value.trim();
    appConfig.repo = document.getElementById("cfgRepo").value.trim();
    appConfig.token = document.getElementById("cfgToken").value.trim();
    appConfig.itadKey = document.getElementById("cfgItadKey").value.trim();

    localStorage.setItem("gh_owner", appConfig.owner);
    localStorage.setItem("gh_repo", appConfig.repo);
    localStorage.setItem("gh_token", appConfig.token);
    localStorage.setItem("itad_api_key", appConfig.itadKey);

    updateEngineBadge();
    document.getElementById("configModal").classList.add("hidden");
    await loadBacklog();
  });
}

// --- GITHUB STORAGE API ---
async function loadBacklog() {
  const statusEl = document.getElementById("syncStatus");
  try {
    if (appConfig.owner && appConfig.repo && appConfig.token) {
      const url = `https://api.github.com/repos/${appConfig.owner}/${appConfig.repo}/contents/backlog.json?t=${Date.now()}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${appConfig.token}`,
          Accept: "application/vnd.github+json"
        }
      });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const data = await res.json();
      currentSha = data.sha;
      backlog = JSON.parse(decodeBase64UTF8(data.content));
      statusEl.textContent = "Sincronizzato";
      statusEl.className = "badge badge-green";
    } else {
      const res = await fetch(`./backlog.json?t=${Date.now()}`);
      backlog = await res.json();
      statusEl.textContent = "Solo Lettura (Configura Token)";
      statusEl.className = "badge badge-warn";
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Errore Sync";
    statusEl.className = "badge badge-red";
  }
  render();
}

async function saveBacklog(commitMessage = "Update backlog") {
  render();
  if (!appConfig.owner || !appConfig.repo || !appConfig.token) {
    alert("Modifica salvata solo in memoria temporanea. Configura il Token GitHub per salvare in modo permanente.");
    return;
  }

  const statusEl = document.getElementById("syncStatus");
  statusEl.textContent = "Salvataggio...";
  statusEl.className = "badge badge-blue";

  try {
    const url = `https://api.github.com/repos/${appConfig.owner}/${appConfig.repo}/contents/backlog.json`;
    const body = {
      message: commitMessage,
      content: encodeBase64UTF8(JSON.stringify(backlog, null, 2)),
      sha: currentSha
    };

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${appConfig.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      if (res.status === 409) {
        await loadBacklog();
        return;
      }
      throw new Error(`Errore salvataggio: ${res.status}`);
    }

    const data = await res.json();
    currentSha = data.content.sha;
    statusEl.textContent = "Sincronizzato";
    statusEl.className = "badge badge-green";
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Errore Salvataggio";
    statusEl.className = "badge badge-red";
    alert("Impossibile salvare su GitHub. Controlla che il Token abbia permessi 'Contents: Read & Write'.");
  }
}

// --- IS THERE ANY DEAL (ITAD) API ---
async function itadSearchGames(query) {
  const url = `https://api.isthereanydeal.com/games/search/v1?key=${encodeURIComponent(appConfig.itadKey)}&title=${encodeURIComponent(query)}&results=8`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ITAD search HTTP ${res.status}`);
  return await res.json();
}

async function itadGetGameInfo(itadId) {
  const url = `https://api.isthereanydeal.com/games/info/v2?key=${encodeURIComponent(appConfig.itadKey)}&id=${encodeURIComponent(itadId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ITAD info HTTP ${res.status}`);
  return await res.json();
}

async function itadFetchBulkPrices(itadIds) {
  if (!itadIds.length) return [];
  const url = `https://api.isthereanydeal.com/games/prices/v3?key=${encodeURIComponent(appConfig.itadKey)}&country=IT`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(itadIds)
  });
  if (!res.ok) throw new Error(`ITAD prices HTTP ${res.status}`);
  return await res.json();
}

function normalizeItadDeals(rawDeals) {
  if (!Array.isArray(rawDeals)) return [];
  return rawDeals
    .filter((d) => d && d.shop && d.price)
    .map((d) => ({
      uid: `itad_${d.shop.id}`,
      shopId: d.shop.id,
      shopName: d.shop.name,
      price: d.price.amount,
      retailPrice: d.regular ? d.regular.amount : d.price.amount,
      savings: Math.round(d.cut || 0),
      currency: d.price.currency || "EUR",
      url: d.url || ""
    }));
}

// --- FALLBACK LEGACY (CHEAPSHARK) & COPERTINE ---
async function loadCheapSharkStoresMap() {
  try {
    const res = await fetch("https://www.cheapshark.com/api/1.0/stores");
    const stores = await res.json();
    stores.forEach((s) => {
      csStoresMap[s.storeID] = s.storeName;
    });
  } catch (e) {
    console.warn("Impossibile caricare lista store:", e);
  }
}

async function fetchCheapSharkSearch(query, limit = 15) {
  const res = await fetch(`https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(query)}&limit=${limit}`);
  if (!res.ok) return [];
  return await res.json();
}

function buildThumbnailLookup(csResults) {
  const map = new Map();
  if (!Array.isArray(csResults)) return map;
  csResults.forEach((item) => {
    if (item && item.external && item.thumb) {
      const norm = normalizeTitleForMatch(item.external);
      if (norm && !map.has(norm)) {
        map.set(norm, item.thumb);
      }
    }
  });
  return map;
}

function resolveSearchThumb(item, thumbMap) {
  if (item.assets) {
    const direct = item.assets.banner145 || item.assets.banner300 || item.assets.boxart;
    if (direct) return direct;
  }
  const norm = normalizeTitleForMatch(item.title);
  if (thumbMap.has(norm)) {
    return thumbMap.get(norm);
  }
  for (const [key, thumb] of thumbMap.entries()) {
    if (key.startsWith(norm) || norm.startsWith(key)) {
      return thumb;
    }
  }
  return FALLBACK_GAME_THUMB;
}

// --- RICERCA LIVE E AGGIUNTA GIOCHI ---
async function searchGames(isLive = false) {
  const query = document.getElementById("searchInput").value.trim();
  const container = document.getElementById("searchResults");

  if (!query) {
    container.classList.add("hidden");
    return;
  }

  const seq = ++latestSearchSeq;
  container.classList.remove("hidden");
  if (!isLive || container.innerHTML.trim() === "") {
    container.innerHTML = "<p class='hint'>Ricerca in corso...</p>";
  }

  let renderedPrimary = false;

  if (appConfig.itadKey) {
    const [itadRes, csRes] = await Promise.allSettled([
      itadSearchGames(query),
      fetchCheapSharkSearch(query, 15)
    ]);

    if (seq !== latestSearchSeq) return;

    if (itadRes.status === "fulfilled" && Array.isArray(itadRes.value)) {
      const thumbMap = csRes.status === "fulfilled" ? buildThumbnailLookup(csRes.value) : new Map();
      container.innerHTML = "";
      renderedPrimary = true;

      itadRes.value.forEach((item) => {
        const card = document.createElement("div");
        card.className = "search-card";
        const typeLabel = item.type && item.type !== "game" ? ` (${item.type.toUpperCase()})` : "";
        const thumbUrl = resolveSearchThumb(item, thumbMap);

        card.innerHTML = `
          <img src="${thumbUrl}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${FALLBACK_GAME_THUMB}'">
          <div class="search-card-info">
            <div class="search-card-title" title="${item.title}">${item.title}${typeLabel}</div>
            <div class="search-card-price" style="color: var(--blue-text);">Aggiungi (ITAD EUR € + data rilascio)</div>
          </div>
        `;
        card.addEventListener("click", () => addGameFromItad(item.id, item.title));
        container.appendChild(card);
      });
    }
  }

  if (!renderedPrimary) {
    try {
      const results = await fetchCheapSharkSearch(query, 8);
      if (seq !== latestSearchSeq) return;
      container.innerHTML = "";

      results.forEach((item) => {
        const card = document.createElement("div");
        card.className = "search-card";
        const thumbUrl = item.thumb || FALLBACK_GAME_THUMB;
        card.innerHTML = `
          <img src="${thumbUrl}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${FALLBACK_GAME_THUMB}'">
          <div class="search-card-info">
            <div class="search-card-title" title="${item.external}">${item.external}</div>
            <div class="search-card-price">Aggiungi (verrà convertito in EUR € via GitHub Action)</div>
          </div>
        `;
        card.addEventListener("click", () => addGameFromCheapShark(item.gameID));
        container.appendChild(card);
      });
    } catch (err) {
      if (seq !== latestSearchSeq) return;
      container.innerHTML = "";
    }
  }

  if (seq !== latestSearchSeq) return;

  // Opzione diretta per giochi non ancora rilasciati / TBA
  const tbaCard = document.createElement("div");
  tbaCard.className = "search-card search-card-tba";
  tbaCard.innerHTML = `
    <img src="${FALLBACK_GAME_THUMB}" alt="">
    <div class="search-card-info">
      <div class="search-card-title">+ Aggiungi "${query}" (Non Rilasciato / TBA)</div>
      <div class="search-card-price" style="color: var(--amber-text);">Salva subito e aggiorna via ITAD</div>
    </div>
  `;
  tbaCard.addEventListener("click", async () => {
    const targetCategory = document.getElementById("addTargetCategory").value;
    document.getElementById("searchResults").classList.add("hidden");
    document.getElementById("searchInput").value = "";
    backlog.push({
      id: Date.now().toString(),
      title: query,
      category: targetCategory,
      hype: false,
      itadId: null,
      cheapsharkId: null,
      selectedStoreId: null,
      released: false,
      releaseDate: "TBA",
      releaseDateISO: null,
      releaseNote: "TBA",
      currency: "EUR",
      salePrice: null,
      retailPrice: null,
      discount: 0,
      bestStore: "",
      deals: [],
      customDeals: [],
      free: false,
      status: "Not Played"
    });
    await saveBacklog(`Add ${query}`);
  });
  container.appendChild(tbaCard);
}

async function addGameFromItad(itadId, fallbackTitle) {
  const targetCategory = document.getElementById("addTargetCategory").value;
  document.getElementById("searchResults").classList.add("hidden");
  document.getElementById("searchInput").value = "";

  // Tenta il recupero diretto nel browser, ma NON blocca mai l'aggiunta in caso di CORS
  const [infoRes, priceRes] = await Promise.allSettled([
    itadGetGameInfo(itadId),
    itadFetchBulkPrices([itadId])
  ]);

  const info = infoRes.status === "fulfilled" ? infoRes.value : { title: fallbackTitle, releaseDate: null };
  const priceEntries = priceRes.status === "fulfilled" ? priceRes.value : [];

  const releaseInfo = infoRes.status === "fulfilled"
    ? parseReleaseStatusFromISO(info.releaseDate)
    : { released: false, releaseDate: "Sync EUR...", releaseDateISO: null };

  const priceEntry = Array.isArray(priceEntries) ? priceEntries.find((p) => p.id === itadId) : null;
  const normalizedDeals = priceEntry ? normalizeItadDeals(priceEntry.deals) : [];

  const newGame = {
    id: Date.now().toString(),
    title: info.title || fallbackTitle,
    category: targetCategory,
    hype: false,
    itadId,
    cheapsharkId: null,
    selectedStoreId: null,
    released: releaseInfo.released,
    releaseDate: releaseInfo.releaseDate,
    releaseDateISO: releaseInfo.releaseDateISO,
    releaseNote: releaseInfo.released ? "" : releaseInfo.releaseDate,
    currency: "EUR",
    salePrice: null,
    retailPrice: null,
    discount: 0,
    bestStore: "",
    deals: normalizedDeals,
    customDeals: [],
    free: false,
    status: "Not Played"
  };

  const allDeals = getAllDeals(newGame);
  if (allDeals.length > 0) {
    applyDealToGame(newGame, allDeals[0]);
  }

  backlog.push(newGame);
  await saveBacklog(`Add ${newGame.title}`);

  // Se il browser ha bloccato prezzi/info via CORS, GitHub Action aggiorna backlog.json in ~15s: ricarichiamo automaticamente
  if (infoRes.status === "rejected" || priceRes.status === "rejected") {
    setTimeout(() => loadBacklog(), 18000);
  }
}

async function addGameFromCheapShark(cheapsharkId) {
  const targetCategory = document.getElementById("addTargetCategory").value;
  document.getElementById("searchResults").classList.add("hidden");
  document.getElementById("searchInput").value = "";

  try {
    const res = await fetch(`https://www.cheapshark.com/api/1.0/games?id=${cheapsharkId}`);
    const data = await res.json();

    const newGame = {
      id: Date.now().toString(),
      title: data.info.title,
      category: targetCategory,
      hype: false,
      itadId: null,
      cheapsharkId: cheapsharkId.toString(),
      selectedStoreId: null,
      released: true,
      releaseDate: "",
      releaseDateISO: null,
      releaseNote: "",
      currency: "USD",
      salePrice: null,
      retailPrice: null,
      discount: 0,
      bestStore: "",
      deals: data.deals || [],
      customDeals: [],
      free: false,
      status: "Not Played"
    };

    const allDeals = getAllDeals(newGame);
    if (allDeals.length > 0) {
      applyDealToGame(newGame, allDeals[0]);
    }

    backlog.push(newGame);
    await saveBacklog(`Add ${newGame.title}`);
    setTimeout(() => loadBacklog(), 18000);
  } catch (err) {
    alert("Errore nel recupero dettagli del gioco.");
  }
}

async function addManualGame(e) {
  e.preventDefault();
  const title = document.getElementById("manualTitle").value.trim();
  const releaseState = document.getElementById("manualReleaseState").value;
  const releaseDate = document.getElementById("manualNote").value.trim();
  const category = document.getElementById("manualCategory").value;
  const hype = document.getElementById("manualHype").checked;

  if (!title) return;

  const isRel = releaseState === "released";
  backlog.push({
    id: Date.now().toString(),
    title,
    category,
    hype,
    itadId: null,
    cheapsharkId: null,
    selectedStoreId: null,
    released: isRel,
    releaseDate: releaseDate || (isRel ? "" : "TBA"),
    releaseDateISO: null,
    releaseNote: isRel ? "" : (releaseDate || "TBA"),
    manualReleaseOverride: true,
    currency: "EUR",
    salePrice: null,
    retailPrice: null,
    discount: 0,
    bestStore: "",
    deals: [],
    customDeals: [],
    free: false,
    status: "Not Played"
  });

  document.getElementById("manualForm").reset();
  document.getElementById("manualForm").classList.add("hidden");
  await saveBacklog(`Add manual ${title}`);
}

// --- AGGIORNAMENTO PREZZI E DATE ---
async function refreshSingleGame(game, skipSave = false) {
  try {
    if (appConfig.itadKey && game.itadId) {
      const [infoRes, priceRes] = await Promise.allSettled([
        itadGetGameInfo(game.itadId),
        itadFetchBulkPrices([game.itadId])
      ]);

      if (infoRes.status === "fulfilled" && !game.manualReleaseOverride) {
        const rel = parseReleaseStatusFromISO(infoRes.value.releaseDate);
        game.released = rel.released;
        game.releaseDate = rel.releaseDate;
        game.releaseDateISO = rel.releaseDateISO;
        game.releaseNote = rel.released ? "" : rel.releaseDate;
      }

      if (priceRes.status === "fulfilled") {
        const priceEntry = Array.isArray(priceRes.value)
          ? priceRes.value.find((p) => p.id === game.itadId)
          : null;
        game.deals = priceEntry ? normalizeItadDeals(priceEntry.deals) : [];
        game.currency = "EUR";

        const allDeals = getAllDeals(game);
        const chosenDeal = findSelectedDeal(game, allDeals);
        if (chosenDeal) {
          applyDealToGame(game, chosenDeal);
        }
        if (!skipSave) await saveBacklog(`Refresh ${game.title}`);
        return;
      }
    }

    if (game.cheapsharkId) {
      const res = await fetch(`https://www.cheapshark.com/api/1.0/games?id=${game.cheapsharkId}`);
      const data = await res.json();
      game.deals = data.deals || [];
      game.currency = "USD";

      const allDeals = getAllDeals(game);
      const chosenDeal = findSelectedDeal(game, allDeals);
      if (chosenDeal) {
        applyDealToGame(game, chosenDeal);
      }
      if (!skipSave) await saveBacklog(`Refresh ${game.title}`);
    }
  } catch (err) {
    console.warn(`Errore aggiornamento ${game.title}:`, err);
  }
}

async function refreshAllPrices() {
  const wishlistGames = backlog.filter((g) => g.category === "wishlist");
  if (!wishlistGames.length) return;

  const btn = document.getElementById("btnRefreshAll");
  btn.disabled = true;

  try {
    for (let i = 0; i < wishlistGames.length; i++) {
      btn.textContent = `Aggiorno ${i + 1}/${wishlistGames.length}...`;
      await refreshSingleGame(wishlistGames[i], true);
      await new Promise((r) => setTimeout(r, 250));
    }
    await saveBacklog("Refresh wishlist prices");
    setTimeout(() => loadBacklog(), 18000);
  } catch (err) {
    console.error(err);
  } finally {
    btn.textContent = "Aggiorna Prezzi";
    btn.disabled = false;
  }
}

// --- MODAL DETTAGLI E CONFRONTO ---
function renderDealsModalContent(game) {
  const bodyEl = document.getElementById("dealsModalBody");
  const allDeals = getAllDeals(game);
  const activeDeal = findSelectedDeal(game, allDeals);

  if (!allDeals.length) {
    bodyEl.innerHTML = "<p class='hint'>Nessun prezzo ufficiale ancora disponibile (gioco TBA o sincronizzazione ITAD in corso). Puoi usare i pulsanti sopra per cercare sui keyshop o inserirne uno manualmente.</p>";
    return;
  }

  const orderedDeals = sortDealsForDropdown(allDeals);
  bodyEl.innerHTML = "";

  orderedDeals.forEach((d) => {
    const isActive = activeDeal && activeDeal.uid === d.uid;
    const isPreferred = getPreferredStoreRank(d.storeName) < 3;
    const row = document.createElement("div");
    row.className = `deal-row ${isActive ? "deal-row-active" : ""}`;

    const typeBadge = d.isCustom
      ? `<span class="badge badge-purple">Keyshop / Custom</span>`
      : isPreferred
        ? `<span class="badge badge-green">Preferito</span>`
        : `<span class="badge badge-blue">Ufficiale</span>`;

    row.innerHTML = `
      <div>
        <div class="deal-store-title">
          <strong>${d.storeName}</strong>
          ${typeBadge}
        </div>
        <div class="hint">Base: ${formatMoney(d.retailPrice, d.currency)}</div>
      </div>
      <div style="display:flex; align-items:center; gap:0.45rem; flex-wrap:wrap; justify-content:flex-end;">
        <span class="badge ${d.savings > 0 ? "badge-green" : "badge-blue"}">${formatMoney(d.price, d.currency)} (-${d.savings}%)</span>
        <button class="btn btn-sm ${isActive ? "btn-success" : "btn-secondary"}" data-action="select">
          ${isActive ? "Attivo" : "Seleziona"}
        </button>
        ${d.url ? `<a href="${d.url}" target="_blank" rel="noopener" class="btn btn-sm btn-primary">Apri</a>` : ""}
        ${d.isCustom ? `<button class="btn btn-sm btn-danger" data-action="remove" title="Rimuovi">&times;</button>` : ""}
      </div>
    `;

    row.querySelector('[data-action="select"]').addEventListener("click", async () => {
      applyDealToGame(game, d);
      renderDealsModalContent(game);
      await saveBacklog(`Select ${d.storeName} for ${game.title}`);
    });

    if (d.isCustom) {
      row.querySelector('[data-action="remove"]').addEventListener("click", async () => {
        game.customDeals = (game.customDeals || []).filter((c) => c.id !== d.uid);
        const remaining = getAllDeals(game);
        if (remaining.length > 0) {
          applyDealToGame(game, remaining[0]);
        } else {
          game.selectedStoreId = null;
          game.salePrice = null;
          game.retailPrice = null;
          game.discount = 0;
          game.bestStore = "";
        }
        renderDealsModalContent(game);
        await saveBacklog(`Remove ${d.storeName} from ${game.title}`);
      });
    }

    bodyEl.appendChild(row);
  });
}

async function openDealsModal(game, focusRelease = false) {
  currentModalGameId = game.id;
  const modal = document.getElementById("dealsModal");
  const titleEl = document.getElementById("dealsModalTitle");
  const linksEl = document.getElementById("quickSearchLinks");

  titleEl.textContent = `Dettagli & Store: ${game.title}`;
  document.getElementById("customDealForm").reset();

  document.getElementById("modalReleaseState").value = isGameReleased(game) ? "released" : "unreleased";
  document.getElementById("modalReleaseDate").value = getReleaseDateText(game);

  linksEl.innerHTML = "";
  getKeyshopSearchLinks(game.title).forEach((site) => {
    const a = document.createElement("a");
    a.href = site.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.className = `btn btn-sm ${site.highlight ? "btn-primary" : "btn-secondary"}`;
    a.textContent = site.name;
    linksEl.appendChild(a);
  });

  modal.classList.remove("hidden");
  renderDealsModalContent(game);

  if (focusRelease) {
    document.getElementById("modalReleaseDate").focus();
  }
}

// --- HELPER COLOR CODING OWNED ---
function getOwnedStatusSelectClass(status) {
  switch (status) {
    case "Ongoing":
    case "Playing":
      return "select-blue";
    case "Hold":
      return "select-amber";
    case "Dropped":
      return "select-red";
    case "Completed":
      return "select-green";
    case "Not Played":
    default:
      return "select-grey";
  }
}

// --- RENDERING TABELLE ---
function render() {
  const textFilter = document.getElementById("filterText").value.toLowerCase();
  const onlyHype = document.getElementById("filterHype").checked;
  const wishlistStateFilter = document.getElementById("filterWishlistState").value;
  const wishlistSort = document.getElementById("sortWishlist").value;
  const statusFilter = document.getElementById("filterStatus").value;

  const allWishlist = backlog.filter((g) => g.category === "wishlist");
  const allOwned = backlog.filter((g) => g.category === "owned").sort((a, b) => a.title.localeCompare(b.title));

  document.getElementById("countWishlist").textContent = allWishlist.length;
  document.getElementById("countOwned").textContent = allOwned.length;

  // Filtra e ordina Wishlist
  const filteredWishlist = allWishlist
    .filter((g) => g.title.toLowerCase().includes(textFilter))
    .filter((g) => (!onlyHype ? true : g.hype))
    .filter((g) => {
      const released = isGameReleased(g);
      const allDeals = getAllDeals(g);
      const activeDeal = findSelectedDeal(g, allDeals);
      const discountVal = activeDeal ? activeDeal.savings : (g.discount || 0);

      if (wishlistStateFilter === "DISCOUNTED") return discountVal > 0;
      if (wishlistStateFilter === "RELEASED") return released;
      if (wishlistStateFilter === "UNRELEASED") return !released;
      return true;
    })
    .sort((a, b) => {
      if (wishlistSort === "HYPE_FIRST") {
        if (a.hype !== b.hype) return a.hype ? -1 : 1;
        return a.title.localeCompare(b.title);
      }
      if (wishlistSort === "PRICE_ASC") {
        const pA = a.salePrice !== null && a.salePrice !== undefined ? a.salePrice : Number.POSITIVE_INFINITY;
        const pB = b.salePrice !== null && b.salePrice !== undefined ? b.salePrice : Number.POSITIVE_INFINITY;
        if (Math.abs(pA - pB) > 0.001) return pA - pB;
        return a.title.localeCompare(b.title);
      }
      if (wishlistSort === "DISCOUNT_DESC") {
        const dA = a.discount || 0;
        const dB = b.discount || 0;
        if (dA !== dB) return dB - dA;
        return a.title.localeCompare(b.title);
      }
      return a.title.localeCompare(b.title);
    });

  const tbodyW = document.getElementById("tbodyWishlist");
  tbodyW.innerHTML = "";
  filteredWishlist.forEach((g) => {
    const tr = document.createElement("tr");
    const allDeals = getAllDeals(g);
    const activeDeal = findSelectedDeal(g, allDeals);
    const currency = activeDeal ? activeDeal.currency : (g.currency || (g.itadId ? "EUR" : "USD"));

    const released = isGameReleased(g);
    const releaseInfo = getReleaseBadgeInfo(g);

    const retailVal = activeDeal ? activeDeal.retailPrice : g.retailPrice;
    const saleVal = activeDeal ? activeDeal.price : g.salePrice;
    const discountVal = activeDeal ? activeDeal.savings : g.discount;

    const basePriceHtml = retailVal !== null && retailVal !== undefined
      ? `<span class="badge badge-blue">${formatMoney(retailVal, currency)}</span>`
      : `<span class="badge badge-red">N/D</span>`;

    let priceHtml = "";
    if (saleVal !== null && saleVal !== undefined) {
      let priceBadgeClass = "badge-blue";
      if (discountVal > 0) {
        priceBadgeClass = "badge-green";
      } else if (!released) {
        priceBadgeClass = "badge-warn";
      }
      priceHtml = `<span class="badge ${priceBadgeClass}">${formatMoney(saleVal, currency)}</span>`;
    } else {
      priceHtml = `<span class="badge badge-red">N/D</span>`;
    }

    const discountHtml = retailVal !== null && retailVal !== undefined
      ? `<span class="badge ${discountVal > 0 ? "badge-green" : "badge-blue"}">${discountVal}%</span>`
      : `<span class="badge badge-red">N/D</span>`;

    let storeHtml = g.bestStore || "-";
    if (allDeals.length > 0) {
      const dropdownDeals = sortDealsForDropdown(allDeals);
      const preferredDeals = dropdownDeals.filter((d) => getPreferredStoreRank(d.storeName) < 3);
      const otherDeals = dropdownDeals.filter((d) => getPreferredStoreRank(d.storeName) >= 3);

      const renderOption = (d) => {
        const isSelected = activeDeal && d.uid === activeDeal.uid;
        return `<option value="${d.uid}" ${isSelected ? "selected" : ""}>${d.storeName} (${formatMoney(d.price, d.currency)})</option>`;
      };

      let optionsHtml = preferredDeals.map(renderOption).join("");
      if (preferredDeals.length > 0 && otherDeals.length > 0) {
        optionsHtml += `<option disabled>──────────────</option>`;
      }
      optionsHtml += otherDeals.map(renderOption).join("");

      storeHtml = `<select class="store-select" data-action="store">${optionsHtml}</select>`;
    }

    tr.innerHTML = `
      <td><a class="game-link" data-action="deals">${g.title}</a></td>
      <td class="center"><input type="checkbox" ${g.hype ? "checked" : ""} data-action="hype"></td>
      <td><span class="badge badge-clickable ${releaseInfo.badgeClass}" data-action="release" title="Clicca per modificare stato/data di rilascio">${releaseInfo.text}</span></td>
      <td>${basePriceHtml}</td>
      <td>${priceHtml}</td>
      <td>${discountHtml}</td>
      <td>${storeHtml}</td>
      <td class="actions-cell">
        <div class="actions-group">
          ${(g.itadId || g.cheapsharkId) ? `<button class="btn btn-sm btn-secondary" data-action="refresh" title="Aggiorna prezzo">&#8635;</button>` : ""}
          <button class="btn btn-sm btn-success" data-action="own">Acquistato</button>
          <button class="btn btn-sm btn-danger" data-action="delete">&times;</button>
        </div>
      </td>
    `;

    tr.querySelector('[data-action="deals"]').addEventListener("click", () => openDealsModal(g, false));
    tr.querySelector('[data-action="release"]').addEventListener("click", () => openDealsModal(g, true));
    tr.querySelector('[data-action="hype"]').addEventListener("change", (e) => {
      g.hype = e.target.checked;
      saveBacklog(`Toggle hype ${g.title}`);
    });

    const storeSelect = tr.querySelector('[data-action="store"]');
    if (storeSelect) {
      storeSelect.addEventListener("change", (e) => {
        const chosenUid = e.target.value;
        const chosenDeal = allDeals.find((d) => d.uid === chosenUid);
        if (chosenDeal) {
          applyDealToGame(g, chosenDeal);
          saveBacklog(`Select ${g.bestStore} for ${g.title}`);
        }
      });
    }

    if (g.itadId || g.cheapsharkId) {
      tr.querySelector('[data-action="refresh"]').addEventListener("click", () => refreshSingleGame(g));
    }
    tr.querySelector('[data-action="own"]').addEventListener("click", () => {
      g.category = "owned";
      g.status = "Not Played";
      saveBacklog(`Move ${g.title} to Owned`);
    });
    tr.querySelector('[data-action="delete"]').addEventListener("click", () => {
      if (confirm(`Eliminare "${g.title}"?`)) {
        backlog = backlog.filter((item) => item.id !== g.id);
        saveBacklog(`Delete ${g.title}`);
      }
    });

    tbodyW.appendChild(tr);
  });

  // Render Owned
  const tbodyO = document.getElementById("tbodyOwned");
  tbodyO.innerHTML = "";
  allOwned
    .filter((g) => g.title.toLowerCase().includes(textFilter))
    .filter((g) => (!onlyHype ? true : g.hype))
    .filter((g) => {
      const normalizedStatus = g.status === "Playing" ? "Ongoing" : (g.status || "Not Played");
      return statusFilter === "ALL" ? true : normalizedStatus === statusFilter;
    })
    .forEach((g) => {
      const tr = document.createElement("tr");
      const currentStatus = g.status === "Playing" ? "Ongoing" : (g.status || "Not Played");
      const statuses = ["Not Played", "Ongoing", "Hold", "Dropped", "Completed"];
      const statusClass = getOwnedStatusSelectClass(currentStatus);
      const freeClass = g.free ? "select-green" : "select-red";

      tr.innerHTML = `
        <td><strong>${g.title}</strong></td>
        <td class="center"><input type="checkbox" ${g.hype ? "checked" : ""} data-action="hype"></td>
        <td>
          <select class="status-select ${freeClass}" data-action="free">
            <option value="false" ${!g.free ? "selected" : ""}>No</option>
            <option value="true" ${g.free ? "selected" : ""}>Yes</option>
          </select>
        </td>
        <td>
          <select class="status-select ${statusClass}" data-action="status">
            ${statuses.map((s) => `<option value="${s}" ${currentStatus === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </td>
        <td class="actions-cell">
          <div class="actions-group">
            <button class="btn btn-sm btn-danger" data-action="delete">&times;</button>
          </div>
        </td>
      `;

      tr.querySelector('[data-action="hype"]').addEventListener("change", (e) => {
        g.hype = e.target.checked;
        saveBacklog(`Toggle hype ${g.title}`);
      });
      tr.querySelector('[data-action="free"]').addEventListener("change", (e) => {
        g.free = e.target.value === "true";
        saveBacklog(`Update free status ${g.title}`);
      });
      tr.querySelector('[data-action="status"]').addEventListener("change", (e) => {
        g.status = e.target.value;
        saveBacklog(`Update status ${g.title} to ${g.status}`);
      });
      tr.querySelector('[data-action="delete"]').addEventListener("click", () => {
        if (confirm(`Eliminare "${g.title}"?`)) {
          backlog = backlog.filter((item) => item.id !== g.id);
          saveBacklog(`Delete ${g.title}`);
        }
      });

      tbodyO.appendChild(tr);
    });
}
