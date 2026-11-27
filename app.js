// --- STATO APPLICAZIONE ---
let backlog = [];
let storesMap = {};
let currentTab = "wishlist";
let currentSha = null;
let currentModalGameId = null;

// Configurazione GitHub salvata localmente nel dispositivo
let ghConfig = {
  owner: localStorage.getItem("gh_owner") || detectRepoFromUrl().owner,
  repo: localStorage.getItem("gh_repo") || detectRepoFromUrl().repo,
  token: localStorage.getItem("gh_token") || ""
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

// --- HELPER STATO RILASCIO ---
function isGameReleased(game) {
  if (typeof game.released === "boolean") {
    return game.released;
  }
  if (game.releaseNote && game.releaseNote.trim() !== "") {
    return false;
  }
  return game.salePrice !== null && game.salePrice !== undefined;
}

function getReleaseDateText(game) {
  if (typeof game.releaseDate === "string") {
    return game.releaseDate.trim();
  }
  if (typeof game.releaseNote === "string") {
    return game.releaseNote.replace(/^Rilascio:\s*/i, "").trim();
  }
  return "";
}

function getReleaseBadgeInfo(game) {
  const released = isGameReleased(game);
  const dateText = getReleaseDateText(game);
  if (released) {
    return {
      text: dateText ? `Rilasciato (${dateText})` : "Rilasciato",
      badgeClass: "badge-blue"
    };
  }
  return {
    text: dateText ? `Non Rilasciato · ${dateText}` : "Non Rilasciato · TBA",
    badgeClass: "badge-warn"
  };
}

// --- UNIFICAZIONE E ORDINAMENTO OFFERTE (UFFICIALI + KEYSHOP) ---
function getAllDeals(game) {
  const officialDeals = (Array.isArray(game.deals) ? game.deals : []).map((d) => ({
    uid: `cs_${d.storeID}`,
    isCustom: false,
    storeID: d.storeID.toString(),
    storeName: storesMap[d.storeID] || `Store #${d.storeID}`,
    price: parseFloat(d.price),
    retailPrice: parseFloat(d.retailPrice),
    savings: Math.round(parseFloat(d.savings)),
    url: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`
  }));

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
      storeID: c.id,
      storeName: c.storeName,
      price,
      retailPrice: retail,
      savings,
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
    const match = allDeals.find((d) => d.uid === sel || (!d.isCustom && d.storeID === sel));
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
  bindEvents();
  await loadStoresMap();
  await loadBacklog();
});

function bindEvents() {
  // Tabs
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      currentTab = btn.dataset.tab;
      document.getElementById("sectionWishlist").classList.toggle("hidden", currentTab !== "wishlist");
      document.getElementById("sectionOwned").classList.toggle("hidden", currentTab !== "owned");
      document.getElementById("filterStatus").classList.toggle("hidden", currentTab !== "owned");
      render();
    });
  });

  // Filtri live
  document.getElementById("filterText").addEventListener("input", render);
  document.getElementById("filterHype").addEventListener("change", render);
  document.getElementById("filterStatus").addEventListener("change", render);

  // Ricerca giochi
  document.getElementById("btnSearch").addEventListener("click", searchGames);
  document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchGames();
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

  // Aggiornamento massivo
  document.getElementById("btnRefreshAll").addEventListener("click", refreshAllPrices);

  // Modals
  document.getElementById("btnOpenConfig").addEventListener("click", () => {
    document.getElementById("cfgOwner").value = ghConfig.owner;
    document.getElementById("cfgRepo").value = ghConfig.repo;
    document.getElementById("cfgToken").value = ghConfig.token;
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
    ghConfig.owner = document.getElementById("cfgOwner").value.trim();
    ghConfig.repo = document.getElementById("cfgRepo").value.trim();
    ghConfig.token = document.getElementById("cfgToken").value.trim();

    localStorage.setItem("gh_owner", ghConfig.owner);
    localStorage.setItem("gh_repo", ghConfig.repo);
    localStorage.setItem("gh_token", ghConfig.token);

    document.getElementById("configModal").classList.add("hidden");
    await loadBacklog();
  });
}

// --- GITHUB STORAGE API ---
async function loadBacklog() {
  const statusEl = document.getElementById("syncStatus");
  try {
    if (ghConfig.owner && ghConfig.repo && ghConfig.token) {
      const url = `https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/contents/backlog.json?t=${Date.now()}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${ghConfig.token}`,
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
  if (!ghConfig.owner || !ghConfig.repo || !ghConfig.token) {
    alert("Modifica salvata solo in memoria temporanea. Configura il Token GitHub per salvare in modo permanente.");
    return;
  }

  const statusEl = document.getElementById("syncStatus");
  statusEl.textContent = "Salvataggio...";
  statusEl.className = "badge badge-blue";

  try {
    const url = `https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/contents/backlog.json`;
    const body = {
      message: commitMessage,
      content: encodeBase64UTF8(JSON.stringify(backlog, null, 2)),
      sha: currentSha
    };

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ghConfig.token}`,
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

// --- STORE API (CHEAPSHARK MULTI-STORE) ---
async function loadStoresMap() {
  try {
    const res = await fetch("https://www.cheapshark.com/api/1.0/stores");
    const stores = await res.json();
    stores.forEach((s) => {
      storesMap[s.storeID] = s.storeName;
    });
  } catch (e) {
    console.warn("Impossibile caricare lista store:", e);
  }
}

async function searchGames() {
  const query = document.getElementById("searchInput").value.trim();
  if (!query) return;

  const container = document.getElementById("searchResults");
  container.classList.remove("hidden");
  container.innerHTML = "<p class='hint'>Ricerca su Steam, Epic, GOG e altri store...</p>";

  try {
    const res = await fetch(`https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(query)}&limit=7`);
    const results = await res.json();

    container.innerHTML = "";
    results.forEach((item) => {
      const card = document.createElement("div");
      card.className = "search-card";
      card.innerHTML = `
        <img src="${item.thumb}" alt="">
        <div class="search-card-info">
          <div class="search-card-title" title="${item.external}">${item.external}</div>
          <div class="search-card-price">Miglior prezzo: $${item.cheapest}</div>
        </div>
      `;
      card.addEventListener("click", () => addGameFromApi(item.gameID));
      container.appendChild(card);
    });

    // Card rapida per titoli non ancora prezzati sugli store (es. Persona 6 / TBA)
    const tbaCard = document.createElement("div");
    tbaCard.className = "search-card search-card-tba";
    tbaCard.innerHTML = `
      <div class="search-card-info">
        <div class="search-card-title">+ Aggiungi "${query}" (Non Rilasciato / TBA)</div>
        <div class="search-card-price" style="color: var(--amber-text);">Salva subito senza prezzo store</div>
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
        cheapsharkId: null,
        selectedStoreId: null,
        released: false,
        releaseDate: "TBA",
        releaseNote: "TBA",
        salePrice: null,
        retailPrice: null,
        discount: 0,
        bestStore: "",
        deals: [],
        customDeals: [],
        free: false,
        status: "Not Played"
      });
      await saveBacklog(`Add TBA ${query}`);
    });
    container.appendChild(tbaCard);
  } catch (err) {
    container.innerHTML = "<p class='hint'>Errore durante la ricerca API.</p>";
  }
}

async function addGameFromApi(cheapsharkId) {
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
      cheapsharkId: cheapsharkId.toString(),
      selectedStoreId: null,
      released: true,
      releaseDate: "",
      releaseNote: "",
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
    cheapsharkId: null,
    selectedStoreId: null,
    released: isRel,
    releaseDate: releaseDate || (isRel ? "" : "TBA"),
    releaseNote: isRel ? "" : (releaseDate || "TBA"),
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

async function refreshSingleGame(game, skipSave = false) {
  if (!game.cheapsharkId) return;
  try {
    const res = await fetch(`https://www.cheapshark.com/api/1.0/games?id=${game.cheapsharkId}`);
    const data = await res.json();
    game.deals = data.deals || [];

    const allDeals = getAllDeals(game);
    const chosenDeal = findSelectedDeal(game, allDeals);
    if (chosenDeal) {
      applyDealToGame(game, chosenDeal);
    }
    if (!skipSave) await saveBacklog(`Refresh ${game.title}`);
  } catch (err) {
    console.warn(`Errore aggiornamento ${game.title}:`, err);
  }
}

async function refreshAllPrices() {
  const targets = backlog.filter((g) => g.category === "wishlist" && g.cheapsharkId);
  if (!targets.length) {
    alert("Nessun gioco collegato agli store nella Wishlist.");
    return;
  }

  const btn = document.getElementById("btnRefreshAll");
  btn.disabled = true;

  for (let i = 0; i < targets.length; i++) {
    btn.textContent = `Aggiorno ${i + 1}/${targets.length}...`;
    await refreshSingleGame(targets[i], true);
    await new Promise((r) => setTimeout(r, 300));
  }

  btn.textContent = "Aggiorna Prezzi";
  btn.disabled = false;
  await saveBacklog("Batch update wishlist prices");
}

function renderDealsModalContent(game) {
  const bodyEl = document.getElementById("dealsModalBody");
  const allDeals = getAllDeals(game);
  const activeDeal = findSelectedDeal(game, allDeals);

  if (!allDeals.length) {
    bodyEl.innerHTML = "<p class='hint'>Nessuna offerta salvata. Usa i pulsanti sopra per cercare su Instant Gaming o altri keyshop e salva qui il prezzo.</p>";
    return;
  }

  bodyEl.innerHTML = "";
  allDeals.forEach((d) => {
    const isActive = activeDeal && activeDeal.uid === d.uid;
    const row = document.createElement("div");
    row.className = `deal-row ${isActive ? "deal-row-active" : ""}`;

    const typeBadge = d.isCustom
      ? `<span class="badge badge-purple">Keyshop / Custom</span>`
      : `<span class="badge badge-blue">Ufficiale</span>`;

    row.innerHTML = `
      <div>
        <div class="deal-store-title">
          <strong>${d.storeName}</strong>
          ${typeBadge}
        </div>
        <div class="hint">Base: $${d.retailPrice.toFixed(2)}</div>
      </div>
      <div style="display:flex; align-items:center; gap:0.45rem; flex-wrap:wrap; justify-content:flex-end;">
        <span class="badge ${d.savings > 0 ? "badge-green" : "badge-blue"}">$${d.price.toFixed(2)} (-${d.savings}%)</span>
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
  const bodyEl = document.getElementById("dealsModalBody");

  titleEl.textContent = `Dettagli & Store: ${game.title}`;
  document.getElementById("customDealForm").reset();

  // Popola editor stato/data di rilascio
  document.getElementById("modalReleaseState").value = isGameReleased(game) ? "released" : "unreleased";
  document.getElementById("modalReleaseDate").value = getReleaseDateText(game);

  // Popola link rapidi di ricerca Keyshop & Steam
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

  if (focusRelease) {
    document.getElementById("modalReleaseDate").focus();
  }

  if (game.cheapsharkId) {
    bodyEl.innerHTML = "<p class='hint'>Aggiornamento prezzi ufficiali in corso...</p>";
    await refreshSingleGame(game, true);
    render();
  }

  renderDealsModalContent(game);
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
  const statusFilter = document.getElementById("filterStatus").value;

  const sorted = [...backlog].sort((a, b) => a.title.localeCompare(b.title));

  const wishlistItems = sorted.filter((g) => g.category === "wishlist");
  const ownedItems = sorted.filter((g) => g.category === "owned");

  document.getElementById("countWishlist").textContent = wishlistItems.length;
  document.getElementById("countOwned").textContent = ownedItems.length;

  // Render Wishlist
  const tbodyW = document.getElementById("tbodyWishlist");
  tbodyW.innerHTML = "";
  wishlistItems
    .filter((g) => g.title.toLowerCase().includes(textFilter))
    .filter((g) => (!onlyHype ? true : g.hype))
    .forEach((g) => {
      const tr = document.createElement("tr");
      const allDeals = getAllDeals(g);
      const activeDeal = findSelectedDeal(g, allDeals);

      const released = isGameReleased(g);
      const releaseInfo = getReleaseBadgeInfo(g);

      const retailVal = activeDeal ? activeDeal.retailPrice : g.retailPrice;
      const saleVal = activeDeal ? activeDeal.price : g.salePrice;
      const discountVal = activeDeal ? activeDeal.savings : g.discount;

      // BASE PRICE: sempre solo prezzo base o N/D (mai sovrascritto dallo stato rilascio)
      const basePriceHtml = retailVal !== null && retailVal !== undefined
        ? `<span class="badge badge-blue">$${retailVal.toFixed(2)}</span>`
        : `<span class="badge badge-red">N/D</span>`;

      // PRICE: Verde se scontato, Ambra se non rilasciato (preorder), Azzurro se rilasciato a prezzo pieno, Rosso se N/D
      let priceHtml = "";
      if (saleVal !== null && saleVal !== undefined) {
        let priceBadgeClass = "badge-blue";
        if (discountVal > 0) {
          priceBadgeClass = "badge-green";
        } else if (!released) {
          priceBadgeClass = "badge-warn";
        }
        priceHtml = `<span class="badge ${priceBadgeClass}">$${saleVal.toFixed(2)}</span>`;
      } else {
        priceHtml = `<span class="badge badge-red">N/D</span>`;
      }

      // % DISCOUNT: Verde se > 0%, Azzurro se 0%, Rosso se N/D
      const discountHtml = retailVal !== null && retailVal !== undefined
        ? `<span class="badge ${discountVal > 0 ? "badge-green" : "badge-blue"}">${discountVal}%</span>`
        : `<span class="badge badge-red">N/D</span>`;

      let storeHtml = g.bestStore || "-";
      if (allDeals.length > 0) {
        const optionsHtml = allDeals.map((d) => {
          const isSelected = activeDeal && d.uid === activeDeal.uid;
          return `<option value="${d.uid}" ${isSelected ? "selected" : ""}>${d.storeName} ($${d.price.toFixed(2)})</option>`;
        }).join("");
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
            ${g.cheapsharkId ? `<button class="btn btn-sm btn-secondary" data-action="refresh" title="Aggiorna prezzo">&#8635;</button>` : ""}
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

      if (g.cheapsharkId) {
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
  ownedItems
    .filter((g) => g.title.toLowerCase().includes(textFilter))
    .filter((g) => (!onlyHype ? true : g.hype))
    .filter((g) => (statusFilter === "ALL" ? true : g.status === statusFilter))
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
