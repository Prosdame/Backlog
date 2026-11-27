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

  // Importazione CSV da Google Sheets
  document.getElementById("btnImportCsv").addEventListener("click", () => {
    document.getElementById("csvFileInput").click();
  });
  document.getElementById("csvFileInput").addEventListener("change", handleCsvImport);

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

// --- IMPORTAZIONE CSV GOOGLE SHEETS ---
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\r" && next === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        i++;
      } else if (ch === "\n" || ch === "\r") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += ch;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseEuroOrNumber(str) {
  if (!str) return null;
  const cleaned = str.replace(/[€$\s]/g, "").replace(",", ".");
  const val = parseFloat(cleaned);
  return Number.isFinite(val) ? val : null;
}

async function handleCsvImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const rows = parseCSV(text);
    const imported = [];
    const validStatuses = ["Not Played", "Playing", "Hold", "Dropped", "Completed"];
    let uidCounter = Date.now();

    rows.forEach((cols) => {
      const colA = (cols[0] || "").trim();
      const colH = (cols[7] || "").trim();

      // Salta intestazioni
      if (colA.toUpperCase() === "GAME" || colH.toUpperCase() === "GAME") return;
      if (colA.toUpperCase() === "TO BE OWNED" || colH.toUpperCase() === "OWNED") return;

      // Tabella sinistra: To be Owned (colonne A..F -> indici 0..5)
      if (colA) {
        const hype = (cols[2] || "").trim().toUpperCase() === "TRUE";
        const stateRaw = (cols[3] || "").trim();
        const priceRaw = (cols[4] || "").trim();
        const discountRaw = (cols[5] || "").trim();

        const salePrice = parseEuroOrNumber(stateRaw);
        const retailPrice = parseEuroOrNumber(priceRaw);
        const parsedDiscount = parseInt(discountRaw.replace("%", "").trim(), 10);

        let releaseNote = "";
        if (salePrice === null && stateRaw && stateRaw.toUpperCase() !== "ID NON VALIDO" && stateRaw.toUpperCase() !== "N/D") {
          releaseNote = stateRaw;
        }

        imported.push({
          id: (uidCounter++).toString(),
          title: colA,
          category: "wishlist",
          hype,
          cheapsharkId: null,
          releaseNote,
          salePrice,
          retailPrice,
          discount: Number.isFinite(parsedDiscount) ? parsedDiscount : 0,
          bestStore: salePrice !== null ? "Importato" : "",
          deals: [],
          free: false,
          status: "Not Played"
        });
      }

      // Tabella destra: Owned (colonne H..K -> indici 7..10)
      if (colH) {
        const hype = (cols[8] || "").trim().toUpperCase() === "TRUE";
        const freeRaw = (cols[9] || "").trim().toLowerCase();
        const statusRaw = (cols[10] || "").trim();
        const matchedStatus = validStatuses.find((s) => s.toLowerCase() === statusRaw.toLowerCase()) || "Not Played";

        imported.push({
          id: (uidCounter++).toString(),
          title: colH,
          category: "owned",
          hype,
          cheapsharkId: null,
          releaseNote: "",
          salePrice: null,
          retailPrice: null,
          discount: 0,
          bestStore: "",
          deals: [],
          free: freeRaw === "yes" || freeRaw === "true" || freeRaw === "si" || freeRaw === "sì",
          status: matchedStatus
        });
      }
    });

    if (!imported.length) {
      alert("Nessun gioco valido trovato nel CSV. Assicurati di aver esportato il foglio principale da Google Sheets.");
      return;
    }

    const wCount = imported.filter((g) => g.category === "wishlist").length;
    const oCount = imported.filter((g) => g.category === "owned").length;

    const replaceAll = confirm(
      `Trovati ${wCount} giochi in "To be Owned" e ${oCount} giochi in "Owned".\n\n` +
      `Premi OK per SOSTITUIRE completamente la lista attuale.\n` +
      `Premi Annulla per UNIRE solo i titoli non ancora presenti.`
    );

    if (replaceAll) {
      backlog = imported;
    } else {
      const existingTitles = new Set(backlog.map((g) => g.title.toLowerCase()));
      imported.forEach((g) => {
        if (!existingTitles.has(g.title.toLowerCase())) {
          backlog.push(g);
        }
      });
    }

    await saveBacklog(`Import CSV (${wCount} wishlist, ${oCount} owned)`);
    alert("Importazione completata! Esegui la GitHub Action 'Update Prices' per collegare automaticamente i giochi agli store.");
  } catch (err) {
    console.error(err);
    alert("Errore durante la lettura del file CSV.");
  } finally {
    e.target.value = "";
  }
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
    const bestDeal = data.deals && data.deals.length ? data.deals[0] : null;

    const newGame = {
      id: Date.now().toString(),
      title: data.info.title,
      category: targetCategory,
      hype: false,
      cheapsharkId: cheapsharkId.toString(),
      releaseNote: "",
      salePrice: bestDeal ? parseFloat(bestDeal.price) : null,
      retailPrice: bestDeal ? parseFloat(bestDeal.retailPrice) : null,
      discount: bestDeal ? Math.round(parseFloat(bestDeal.savings)) : 0,
      bestStore: bestDeal ? (storesMap[bestDeal.storeID] || "Store") : "",
      deals: data.deals || [],
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
    const bestDeal = data.deals && data.deals.length ? data.deals[0] : null;
    if (bestDeal) {
      game.salePrice = parseFloat(bestDeal.price);
      game.retailPrice = parseFloat(bestDeal.retailPrice);
      game.discount = Math.round(parseFloat(bestDeal.savings));
      game.bestStore = storesMap[bestDeal.storeID] || "Store";
      game.deals = data.deals;
      game.releaseNote = "";
    }
    if (!skipSave) await saveBacklog(`Refresh ${game.title}`);
  } catch (err) {
    console.warn(`Errore aggiornamento ${game.title}:`, err);
  }
}

async function refreshAllPrices() {
  const targets = backlog.filter((g) => g.category === "wishlist" && g.cheapsharkId);
  if (!targets.length) {
    alert("Nessun gioco collegato agli store nella Wishlist. Usa la GitHub Action o clicca sul titolo di un gioco per collegarlo.");
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

async function openDealsModal(game) {
  const modal = document.getElementById("dealsModal");
  const titleEl = document.getElementById("dealsModalTitle");
  const bodyEl = document.getElementById("dealsModalBody");

  titleEl.textContent = `Confronto Store: ${game.title}`;
  modal.classList.remove("hidden");
  bodyEl.innerHTML = "";

  if (game.cheapsharkId) {
    const loadingP = document.createElement("p");
    loadingP.className = "hint";
    loadingP.textContent = "Caricamento prezzi da tutti gli storefront...";
    bodyEl.appendChild(loadingP);

    await refreshSingleGame(game, true);
    render();
    bodyEl.innerHTML = "";

    if (game.deals && game.deals.length) {
      game.deals.forEach((d) => {
        const storeName = storesMap[d.storeID] || `Store #${d.storeID}`;
        const savings = Math.round(parseFloat(d.savings));
        const row = document.createElement("div");
        row.className = "deal-row";
        row.innerHTML = `
          <div>
            <strong>${storeName}</strong>
            <div class="hint">Base: $${d.retailPrice}</div>
          </div>
          <div style="display:flex; align-items:center; gap:0.6rem;">
            <span class="badge ${savings > 0 ? "badge-green" : "badge-blue"}">$${d.price} (-${savings}%)</span>
            <a href="https://www.cheapshark.com/redirect?dealID=${d.dealID}" target="_blank" rel="noopener" class="btn btn-sm btn-primary">Apri</a>
          </div>
        `;
        bodyEl.appendChild(row);
      });
    } else {
      bodyEl.innerHTML = "<p class='hint'>Nessuna offerta attiva trovata sugli store.</p>";
    }
  } else {
    bodyEl.innerHTML = `<p class="hint">Gioco non ancora collegato a uno store (${game.releaseNote || "Importato / Manuale"}).</p>`;
  }

  // Sezione per collegare o cambiare manualmente la corrispondenza store
  const linkSection = document.createElement("div");
  linkSection.style.marginTop = "1rem";
  linkSection.style.paddingTop = "1rem";
  linkSection.style.borderTop = "1px solid var(--border)";
  linkSection.innerHTML = `
    <p class="hint" style="margin-bottom:0.5rem;">Associa o cambia corrispondenza sugli store:</p>
    <div class="search-row">
      <input type="text" id="relinkInput" value="${game.title}">
      <button type="button" id="btnRelinkSearch" class="btn btn-sm btn-secondary">Cerca</button>
    </div>
    <div id="relinkResults" class="search-results hidden"></div>
  `;
  bodyEl.appendChild(linkSection);

  document.getElementById("btnRelinkSearch").addEventListener("click", async () => {
    const q = document.getElementById("relinkInput").value.trim();
    if (!q) return;
    const resBox = document.getElementById("relinkResults");
    resBox.classList.remove("hidden");
    resBox.innerHTML = "<p class='hint'>Ricerca...</p>";

    try {
      const res = await fetch(`https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(q)}&limit=6`);
      const items = await res.json();
      if (!items.length) {
        resBox.innerHTML = "<p class='hint'>Nessun risultato trovato.</p>";
        return;
      }
      resBox.innerHTML = "";
      items.forEach((item) => {
        const card = document.createElement("div");
        card.className = "search-card";
        card.innerHTML = `
          <img src="${item.thumb}" alt="">
          <div class="search-card-info">
            <div class="search-card-title">${item.external}</div>
            <div class="search-card-price">$${item.cheapest}</div>
          </div>
        `;
        card.addEventListener("click", async () => {
          game.cheapsharkId = item.gameID.toString();
          await refreshSingleGame(game, false);
          openDealsModal(game);
        });
        resBox.appendChild(card);
      });
    } catch {
      resBox.innerHTML = "<p class='hint'>Errore API.</p>";
    }
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

      let stateHtml = "";
      if (g.salePrice !== null) {
        const badgeClass = g.discount > 0 ? "badge-green" : "badge-blue";
        stateHtml = `<span class="badge ${badgeClass}">$${g.salePrice.toFixed(2)}</span>`;
      } else {
        stateHtml = `<span class="badge badge-warn">${g.releaseNote || "N/D"}</span>`;
      }

      const basePriceText = g.retailPrice !== null ? `$${g.retailPrice.toFixed(2)}` : "N/D";
      const discountHtml = g.retailPrice !== null
        ? `<span class="badge ${g.discount > 0 ? "badge-green" : "badge-blue"}">${g.discount}%</span>`
        : "N/D";

      tr.innerHTML = `
        <td><a class="game-link" data-action="deals">${g.title}</a></td>
        <td class="center"><input type="checkbox" ${g.hype ? "checked" : ""} data-action="hype"></td>
        <td>${stateHtml}</td>
        <td>${basePriceText}</td>
        <td>${discountHtml}</td>
        <td>${g.bestStore || "-"}</td>
        <td class="actions-cell">
          ${g.cheapsharkId ? `<button class="btn btn-sm btn-secondary" data-action="refresh" title="Aggiorna prezzo">&#8635;</button>` : ""}
          <button class="btn btn-sm btn-success" data-action="own">Acquistato</button>
          <button class="btn btn-sm btn-danger" data-action="delete">&times;</button>
        </td>
      `;

      tr.querySelector('[data-action="deals"]').addEventListener("click", () => openDealsModal(g));
      tr.querySelector('[data-action="hype"]').addEventListener("change", (e) => {
        g.hype = e.target.checked;
        saveBacklog(`Toggle hype ${g.title}`);
      });
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
          <button class="btn btn-sm btn-danger" data-action="delete">&times;</button>
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
