import fs from "node:fs";

const ITAD_KEY = process.env.ITAD_API_KEY;
const BACKLOG_PATH = "backlog.json";
const UNMATCHED_PATH = "unmatched.csv";
const CURRENT_SCHEMA_VERSION = 2;

if (!ITAD_KEY) {
  console.error("Errore: variabile d'ambiente ITAD_API_KEY mancante.");
  process.exit(1);
}

// Trova automaticamente il CSV nella radice o in data/
function findCsvFilePath() {
  const candidates = [
    process.env.CSV_PATH,
    "Backlog - Backlog Prosdi.csv",
    "backlog.csv",
    "data/Backlog - Backlog Prosdi.csv",
    "data/backlog.csv"
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  const rootCsv = fs.readdirSync(".").find((f) => f.toLowerCase().endsWith(".csv") && f !== UNMATCHED_PATH);
  if (rootCsv) return rootCsv;

  throw new Error("Nessun file .csv trovato nel repository.");
}

// Parser CSV RFC-4180 (gestisce campi tra virgolette con virgole interne es. "€ 7,13")
function parseCsvRows(text) {
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
    } else if (ch === '"') {
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

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizeTitleForMatch(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/[:\-–—_.,!?'"()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseBool(val) {
  const v = (val || "").trim().toLowerCase();
  return v === "true" || v === "yes" || v === "1" || v === "si" || v === "sì";
}

function parseEuroString(val) {
  if (!val) return null;
  const cleaned = val.replace(/[€$\s]/g, "").replace(",", ".").trim();
  if (!cleaned || cleaned.toLowerCase() === "n/d") return null;
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? null : num;
}

function parseReleaseStatusFromISO(isoDate) {
  if (!isoDate) {
    return { released: false, releaseDate: "TBA", releaseDateISO: null };
  }
  const parsed = new Date(`${isoDate}T23:59:59Z`);
  if (Number.isNaN(parsed.getTime())) {
    return { released: false, releaseDate: isoDate, releaseDateISO: null };
  }
  const isRel = parsed <= new Date();
  const formatted = new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("it-IT", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/Rome"
  });
  return {
    released: isRel,
    releaseDate: formatted,
    releaseDateISO: isoDate
  };
}

function normalizeItadDeals(rawDeals) {
  if (!Array.isArray(rawDeals)) return [];
  return rawDeals
    .filter((d) => d && d.shop && d.price && d.price.amount !== undefined)
    .map((d) => ({
      uid: `itad_${d.shop.id}`,
      shopId: d.shop.id,
      shopName: d.shop.name,
      price: d.price.amount,
      retailPrice: d.regular && d.regular.amount !== undefined ? d.regular.amount : d.price.amount,
      savings: Math.round(d.cut || 0),
      currency: d.price.currency || "EUR",
      url: d.url || ""
    }))
    .sort((a, b) => a.price - b.price);
}

async function itadLookupBySteamAppId(steamAppId) {
  const url = `https://api.isthereanydeal.com/games/lookup/v1?key=${encodeURIComponent(ITAD_KEY)}&appid=${encodeURIComponent(steamAppId)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data && data.found && data.game ? data.game : null;
}

async function itadSearchExactTitle(title) {
  const url = `https://api.isthereanydeal.com/games/search/v1?key=${encodeURIComponent(ITAD_KEY)}&title=${encodeURIComponent(title)}&results=6`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) return null;

  const targetNorm = normalizeTitleForMatch(title);
  return list.find((m) => normalizeTitleForMatch(m.title) === targetNorm) || null;
}

async function itadGetInfo(id) {
  const url = `https://api.isthereanydeal.com/games/info/v2?key=${encodeURIComponent(ITAD_KEY)}&id=${encodeURIComponent(id)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return await res.json();
}

async function itadGetPrices(ids) {
  if (!ids.length) return [];
  const url = `https://api.isthereanydeal.com/games/prices/v3?key=${encodeURIComponent(ITAD_KEY)}&country=IT`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ids)
  });
  if (!res.ok) return [];
  const raw = await res.json();
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.list)) return raw.list;
  return [];
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function findExisting(list, { itadId, steamAppId, title }) {
  const norm = normalizeTitleForMatch(title);
  return (
    list.find((g) => {
      if (itadId && g.itadId === itadId) return true;
      if (steamAppId && g.steamAppId && String(g.steamAppId) === String(steamAppId)) return true;
      if (norm && normalizeTitleForMatch(g.title) === norm) return true;
      return false;
    }) || null
  );
}

function csvEscape(val) {
  const s = String(val ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function main() {
  const csvPath = findCsvFilePath();
  console.log(`Lettura CSV da: ${csvPath}`);

  const csvText = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) {
    throw new Error("Il file CSV è vuoto.");
  }

  const existingBacklog = fs.existsSync(BACKLOG_PATH)
    ? JSON.parse(fs.readFileSync(BACKLOG_PATH, "utf8"))
    : [];

  const wishlistInputs = [];
  const ownedInputs = [];

  // Struttura affiancata Google Sheets:
  // Col 0..5 -> GAME, STEAM ID, HYPE, STATE, PRICE, DISCOUNT
  // Col 7..10 -> GAME, HYPE, FREE, STATUS
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const wTitle = (r[0] || "").trim();
    const wSteamRaw = (r[1] || "").trim();
    const wHype = parseBool(r[2]);
    const wState = (r[3] || "").trim();
    const wSale = parseEuroString(r[4]);

    if (wTitle) {
      wishlistInputs.push({
        rowNum: i + 1,
        title: wTitle,
        steamAppId: /^\d+$/.test(wSteamRaw) ? wSteamRaw : null,
        hype: wHype,
        csvState: wState,
        csvRetail: wSale
      });
    }

    const oTitle = (r[7] || "").trim();
    const oHype = parseBool(r[8]);
    const oFree = parseBool(r[9]);
    const oStatusRaw = (r[10] || "").trim();

    if (oTitle) {
      const validStatuses = ["Not Played", "Ongoing", "Hold", "Dropped", "Completed"];
      const status = validStatuses.includes(oStatusRaw) ? oStatusRaw : "Not Played";
      ownedInputs.push({
        rowNum: i + 1,
        title: oTitle,
        hype: oHype,
        free: oFree,
        status
      });
    }
  }

  console.log(`Trovati ${wishlistInputs.length} giochi Wishlist e ${ownedInputs.length} giochi Owned nel CSV.`);

  const unmatchedReport = [];
  let addedWishlist = 0;
  let addedOwned = 0;
  let skippedDuplicates = 0;

  // --- 1. IMPORTAZIONE WISHLIST ---
  for (let idx = 0; idx < wishlistInputs.length; idx++) {
    const item = wishlistInputs[idx];

    const dupBefore = findExisting(existingBacklog, {
      steamAppId: item.steamAppId,
      title: item.title
    });
    if (dupBefore) {
      if (!dupBefore.steamAppId && item.steamAppId) {
        dupBefore.steamAppId = item.steamAppId;
      }
      skippedDuplicates++;
      continue;
    }

    let itadMatch = null;
    let matchMethod = "NONE";

    if (item.steamAppId) {
      itadMatch = await itadLookupBySteamAppId(item.steamAppId);
      if (itadMatch) matchMethod = "STEAM_ID";
    }

    if (!itadMatch) {
      itadMatch = await itadSearchExactTitle(item.title);
      if (itadMatch) matchMethod = "EXACT_TITLE";
    }

    if (itadMatch) {
      const dupAfter = findExisting(existingBacklog, {
        itadId: itadMatch.id,
        steamAppId: item.steamAppId,
        title: itadMatch.title
      });
      if (dupAfter) {
        skippedDuplicates++;
        continue;
      }
    }

    const cleanNote = item.csvState
      .replace(/^Rilascio:\s*/i, "")
      .replace(/^ID non valido$/i, "TBA")
      .replace(/^To Be Announced$/i, "TBA")
      .trim();

    const newEntry = {
      id: `${Date.now()}_w_${idx}`,
      title: itadMatch ? itadMatch.title : item.title,
      thumb: null,
      category: "wishlist",
      hype: item.hype,
      steamAppId: item.steamAppId,
      itadId: itadMatch ? itadMatch.id : null,
      cheapsharkId: null,
      selectedStoreId: null,
      released: false,
      releaseDate: cleanNote || "TBA",
      releaseDateISO: null,
      releaseNote: cleanNote || "TBA",
      manualReleaseOverride: false,
      currency: "EUR",
      salePrice: null,
      retailPrice: null,
      discount: 0,
      bestStore: "",
      deals: [],
      customDeals: [],
      free: false,
      status: "Not Played",
      schemaVersion: CURRENT_SCHEMA_VERSION
    };

    existingBacklog.push(newEntry);
    addedWishlist++;

    if (!itadMatch) {
      unmatchedReport.push({
        category: "wishlist",
        csvTitle: item.title,
        steamId: item.steamAppId || "N/D",
        reason: item.steamAppId ? "SteamID non trovato su ITAD" : "Nessuno SteamID / Esclusiva o TBA"
      });
    } else {
      console.log(`[Wishlist +] ${newEntry.title} (${matchMethod})`);
    }
  }

  // --- 2. IMPORTAZIONE OWNED ---
  for (let idx = 0; idx < ownedInputs.length; idx++) {
    const item = ownedInputs[idx];

    const dupBefore = findExisting(existingBacklog, { title: item.title });
    if (dupBefore) {
      skippedDuplicates++;
      continue;
    }

    const itadMatch = await itadSearchExactTitle(item.title);
    if (itadMatch) {
      const dupAfter = findExisting(existingBacklog, { itadId: itadMatch.id, title: itadMatch.title });
      if (dupAfter) {
        skippedDuplicates++;
        continue;
      }
    }

    const newEntry = {
      id: `${Date.now()}_o_${idx}`,
      title: itadMatch ? itadMatch.title : item.title,
      thumb: null,
      category: "owned",
      hype: item.hype,
      steamAppId: null,
      itadId: itadMatch ? itadMatch.id : null,
      cheapsharkId: null,
      selectedStoreId: null,
      released: true,
      releaseDate: "",
      releaseDateISO: null,
      releaseNote: "",
      manualReleaseOverride: false,
      currency: "EUR",
      salePrice: null,
      retailPrice: null,
      discount: 0,
      bestStore: "",
      deals: [],
      customDeals: [],
      free: item.free,
      status: item.status,
      schemaVersion: CURRENT_SCHEMA_VERSION
    };

    existingBacklog.push(newEntry);
    addedOwned++;

    if (!itadMatch) {
      unmatchedReport.push({
        category: "owned",
        csvTitle: item.title,
        steamId: "N/D",
        reason: "Importato in Owned senza match esatto ITAD (possibile abbreviazione)"
      });
    } else {
      console.log(`[Owned +] ${newEntry.title} (EXACT_TITLE)`);
    }
  }

  // --- 3. ARRICCHIMENTO INFO, COPERTINE & PREZZI EUR SU TUTTI I NUOVI TITOLI ITAD ---
  const itadItems = existingBacklog.filter((g) => g.itadId);
  console.log(`Recupero copertine e date rilascio per ${itadItems.length} giochi ITAD...`);

  for (const game of itadItems) {
    if (game.thumb && game.releaseDateISO) continue;
    const info = await itadGetInfo(game.itadId);
    if (info) {
      if (info.assets) {
        game.thumb =
          info.assets.banner400 ||
          info.assets.banner300 ||
          info.assets.banner145 ||
          info.assets.boxart ||
          game.thumb;
      }
      if (!game.manualReleaseOverride) {
        const rel = parseReleaseStatusFromISO(info.releaseDate);
        game.released = rel.released;
        game.releaseDate = rel.releaseDate;
        game.releaseDateISO = rel.releaseDateISO;
        game.releaseNote = rel.released ? "" : rel.releaseDate;
      }
    }
  }

  const priceBatches = chunkArray(itadItems.map((g) => g.itadId), 50);
  const priceMap = new Map();
  for (const batch of priceBatches) {
    const entries = await itadGetPrices(batch);
    entries.forEach((e) => {
      priceMap.set(e.id, e.deals || e.offers || []);
    });
  }

  for (const game of itadItems) {
    const deals = normalizeItadDeals(priceMap.get(game.itadId) || []);
    if (game.category === "wishlist") {
      game.deals = deals;
      game.currency = "EUR";
      if (deals.length > 0) {
        const best = deals[0];
        game.selectedStoreId = best.uid;
        game.salePrice = best.price;
        game.retailPrice = best.retailPrice;
        game.discount = best.savings;
        game.bestStore = best.shopName;
      }
    } else if (deals.length > 0 && game.retailPrice === null) {
      // Per Owned salva il prezzo di listino EUR così le Statistiche calcolano il valore libreria
      game.retailPrice = deals[0].retailPrice;
      game.salePrice = deals[0].price;
      game.currency = "EUR";
    }
  }

  fs.writeFileSync(BACKLOG_PATH, `${JSON.stringify(existingBacklog, null, 2)}\n`, "utf8");

  const csvHeader = "CATEGORY,CSV_TITLE,STEAM_ID,NOTE\n";
  const csvLines = unmatchedReport.map(
    (u) => `${csvEscape(u.category)},${csvEscape(u.csvTitle)},${csvEscape(u.steamId)},${csvEscape(u.reason)}`
  );
  fs.writeFileSync(UNMATCHED_PATH, csvHeader + csvLines.join("\n") + (csvLines.length ? "\n" : ""), "utf8");

  console.log("--- RIEPILOGO IMPORTAZIONE ---");
  console.log(`Wishlist importati: ${addedWishlist}`);
  console.log(`Owned importati: ${addedOwned}`);
  console.log(`Duplicati ignorati: ${skippedDuplicates}`);
  console.log(`Voci senza match ITAD (salvate in ${UNMATCHED_PATH}): ${unmatchedReport.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
