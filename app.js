// --- STATO APPLICAZIONE ---
let backlog = [];
let storesMap = {};
let currentTab = "wishlist";
let currentSha = null;

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

// --- ORDINAMENTO E SELEZIONE OFFERTE ---
function getSortedDeals(deals) {
  if (!Array.isArray(deals)) return [];
  return [...deals].sort((a, b) => {
    const priceA = parseFloat(a.price);
    const priceB = parseFloat(b.price);
    if (Math.abs(priceA - priceB) > 0.001) {
      return priceA - priceB;
    }
    const nameA = storesMap[a.storeID] || `Store #${a.storeID}`;
    const nameB = storesMap[b.storeID] || `Store #${b.storeID}`;
    return nameA.localeCompare(nameB);
  });
}

function applyDealToGame(game, deal) {
  if (!deal) return;
  game.selectedStoreId = deal.storeID.toString();
  game.salePrice = parseFloat(deal.price);
  game.retailPrice = parseFloat(deal.retailPrice);
  game.discount = Math.round(parseFloat(deal.savings));
  game.bestStore = storesMap[deal.storeID] || `Store #${deal.storeID}`;
  game.releaseNote = "";
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
      // Fallback in sola lettura dal file locale
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
    const res = await fetch(`https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(query)}&limit=8`);
    const results = await res.json();

    if (!results.length) {
      container.innerHTML = "<p class='hint'>Nessun risultato trovato. Usa '+ Manuale / TBA' per giochi non ancora annunciati.</p>";
      return;
    }

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
    const sortedDeals = getSortedDeals(data.deals || []);
    const bestDeal = sortedDeals.length ? sortedDeals[0] : null;

    const newGame = {
      id: Date.now().toString(),
      title: data.info.title,
      category: targetCategory,
      hype: false,
      cheapsharkId: cheapsharkId.toString(),
      selectedStoreId: bestDeal ? bestDeal.storeID.toString() : null,
      releaseNote: "",
      salePrice: bestDeal ? parseFloat(bestDeal.price) : null,
      retailPrice: bestDeal ? parseFloat(bestDeal.retailPrice) : null,
      discount: bestDeal ? Math.round(parseFloat(bestDeal.savings)) : 0,
      bestStore: bestDeal ? (storesMap[bestDeal.storeID] || "Store") : "",
      deals: sortedDeals,
      free: false,
      status: "Not Played"
    };

    backlog.push(newGame);
    await saveBacklog(`Add ${newGame.title}`);
  } catch (err) {
    alert("Errore nel recupero dettagli del gioco.");
  }
}

async function addManualGame(e) {
  e.preventDefault();
  const title = document.getElementById("manualTitle").value.trim();
  const releaseNote = document.getElementById("manualNote").value.trim();
  const category = document.getElementById("manualCategory").value;
  const hype = document.getElementById("manualHype").checked;

  if (!title) return;

  backlog.push({
    id: Date.now().toString(),
    title,
    category,
    hype,
    cheapsharkId: null,
    selectedStoreId: null,
    releaseNote: releaseNote || "To Be Announced",
    salePrice: null,
    retailPrice: null,
    discount: 0,
    bestStore: "",
    deals: [],
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
    const sortedDeals = getSortedDeals(data.deals || []);
    game.deals = sortedDeals;

    if (sortedDeals.length > 0) {
      const preferredDeal = game.selectedStoreId
        ? sortedDeals.find((d) => d.storeID.toString() === game.selectedStoreId.toString())
        : null;
      applyDealToGame(game, preferredDeal || sortedDeals[0]);
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
    // Pausa di 300ms per evitare rate-limit
    await new Promise((r) => setTimeout(r, 300));
  }

  btn.textContent = "Aggiorna Prezzi";
  btn.disabled = false;
  await saveBacklog("Batch update wishlist prices");
}

async function openDealsModal(game) {
  const modal = document.getElementById("dealsModal");
  const titleEl = document.getElementById("dealsModalTitle");
  const bodyEl = document.getElementById("dealsModalBody");

  titleEl.textContent = `Confronto Store: ${game.title}`;
  modal.classList.remove("hidden");

  if (!game.cheapsharkId) {
    bodyEl.innerHTML = `<p class="hint">Gioco inserito manualmente (${game.releaseNote || "Nessuno store collegato"}).</p>`;
    return;
  }

  bodyEl.innerHTML = "<p class='hint'>Caricamento prezzi da tutti gli storefront...</p>";
  await refreshSingleGame(game, true);
  render();

  const sortedDeals = getSortedDeals(game.deals);
  if (!sortedDeals.length) {
    bodyEl.innerHTML = "<p class='hint'>Nessuna offerta attiva trovata sugli store.</p>";
    return;
  }

  bodyEl.innerHTML = "";
  sortedDeals.forEach((d) => {
    const storeName = storesMap[d.storeID] || `Store #${d.storeID}`;
    const savings = Math.round(parseFloat(d.savings));
    const row = document.createElement("div");
    row.className = "deal-row";
    row.innerHTML = `
      <div>
        <strong>${storeName}</strong>
        <div class="hint">Base: $${parseFloat(d.retailPrice).toFixed(2)}</div>
      </div>
      <div style="display:flex; align-items:center; gap:0.6rem;">
        <span class="badge ${savings > 0 ? "badge-green" : "badge-blue"}">$${parseFloat(d.price).toFixed(2)} (-${savings}%)</span>
        <a href="https://www.cheapshark.com/redirect?dealID=${d.dealID}" target="_blank" rel="noopener" class="btn btn-sm btn-primary">Apri</a>
      </div>
    `;
    bodyEl.appendChild(row);
  });
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
      const sortedDeals = getSortedDeals(g.deals);

      // Se ci sono offerte salvate, usa lo store selezionato (o il più economico)
      let activeDeal = null;
      if (sortedDeals.length > 0) {
        activeDeal = g.selectedStoreId
          ? sortedDeals.find((d) => d.storeID.toString() === g.selectedStoreId.toString())
          : null;
        if (!activeDeal) activeDeal = sortedDeals[0];
      }

      const retailVal = activeDeal ? parseFloat(activeDeal.retailPrice) : g.retailPrice;
      const saleVal = activeDeal ? parseFloat(activeDeal.price) : g.salePrice;
      const discountVal = activeDeal ? Math.round(parseFloat(activeDeal.savings)) : g.discount;

      const basePriceText = retailVal !== null ? `$${retailVal.toFixed(2)}` : "N/D";

      let priceHtml = "";
      if (saleVal !== null) {
        const badgeClass = discountVal > 0 ? "badge-green" : "badge-blue";
        priceHtml = `<span class="badge ${badgeClass}">$${saleVal.toFixed(2)}</span>`;
      } else {
        priceHtml = `<span class="badge badge-warn">${g.releaseNote || "N/D"}</span>`;
      }

      const discountHtml = retailVal !== null
        ? `<span class="badge ${discountVal > 0 ? "badge-green" : "badge-blue"}">${discountVal}%</span>`
        : "N/D";

      let storeHtml = g.bestStore || "-";
      if (sortedDeals.length > 0) {
        const optionsHtml = sortedDeals.map((d) => {
          const sName = storesMap[d.storeID] || `Store #${d.storeID}`;
          const isSelected = d.storeID.toString() === activeDeal.storeID.toString();
          return `<option value="${d.storeID}" ${isSelected ? "selected" : ""}>${sName} ($${parseFloat(d.price).toFixed(2)})</option>`;
        }).join("");
        storeHtml = `<select class="store-select" data-action="store">${optionsHtml}</select>`;
      }

      tr.innerHTML = `
        <td><a class="game-link" data-action="deals">${g.title}</a></td>
        <td class="center"><input type="checkbox" ${g.hype ? "checked" : ""} data-action="hype"></td>
        <td>${basePriceText}</td>
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

      tr.querySelector('[data-action="deals"]').addEventListener("click", () => openDealsModal(g));
      tr.querySelector('[data-action="hype"]').addEventListener("change", (e) => {
        g.hype = e.target.checked;
        saveBacklog(`Toggle hype ${g.title}`);
      });

      const storeSelect = tr.querySelector('[data-action="store"]');
      if (storeSelect) {
        storeSelect.addEventListener("change", (e) => {
          const chosenId = e.target.value;
          const chosenDeal = sortedDeals.find((d) => d.storeID.toString() === chosenId);
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
      const statuses = ["Not Played", "Playing", "Hold", "Dropped", "Completed"];

      tr.innerHTML = `
        <td><strong>${g.title}</strong></td>
        <td class="center"><input type="checkbox" ${g.hype ? "checked" : ""} data-action="hype"></td>
        <td>
          <select data-action="free">
            <option value="false" ${!g.free ? "selected" : ""}>No</option>
            <option value="true" ${g.free ? "selected" : ""}>Yes</option>
          </select>
        </td>
        <td>
          <select data-action="status">
            ${statuses.map((s) => `<option value="${s}" ${g.status === s ? "selected" : ""}>${s}</option>`).join("")}
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
