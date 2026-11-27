import fs from "node:fs";

const ITAD_KEY = process.env.ITAD_API_KEY;
const BACKLOG_PATH = "backlog.json";
const CURRENT_SCHEMA_VERSION = 2;

if (!ITAD_KEY) {
  console.error("Errore: variabile d'ambiente ITAD_API_KEY mancante.");
  process.exit(1);
}

function normalizeGameSchema(raw, index = 0) {
  const item = raw && typeof raw === "object" ? { ...raw } : {};
  const normalizedStatus = item.status === "Playing" ? "Ongoing" : (item.status || "Not Played");
  const normalizedCategory = item.category === "owned" ? "owned" : "wishlist";

  let released = typeof item.released === "boolean"
    ? item.released
    : (item.releaseNote && item.releaseNote.trim() !== "" ? false : (item.salePrice !== null && item.salePrice !== undefined));

  if (!item.manualReleaseOverride && item.releaseDateISO) {
    const parsed = new Date(`${item.releaseDateISO}T23:59:59Z`);
    if (!Number.isNaN(parsed.getTime())) {
      released = parsed <= new Date();
    }
  }

  return {
    id: item.id ? String(item.id) : `${Date.now()}_${index}`,
    title: (item.title || "Senza Titolo").trim(),
    thumb: item.thumb || null,
    category: normalizedCategory,
    hype: Boolean(item.hype),
    steamAppId: item.steamAppId ? String(item.steamAppId) : null,
    itadId: item.itadId || null,
    cheapsharkId: item.cheapsharkId ? String(item.cheapsharkId) : null,
    selectedStoreId: item.selectedStoreId || null,
    released,
    releaseDate: typeof item.releaseDate === "string"
      ? item.releaseDate
      : (typeof item.releaseNote === "string" ? item.releaseNote.replace(/^Rilascio:\s*/i, "").trim() : ""),
    releaseDateISO: item.releaseDateISO || null,
    releaseNote: typeof item.releaseNote === "string" ? item.releaseNote : "",
    manualReleaseOverride: Boolean(item.manualReleaseOverride),
    currency: item.currency || (item.itadId ? "EUR" : "USD"),
    salePrice: item.salePrice !== null && item.salePrice !== undefined && !Number.isNaN(Number(item.salePrice))
      ? Number(item.salePrice)
      : null,
    retailPrice: item.retailPrice !== null && item.retailPrice !== undefined && !Number.isNaN(Number(item.retailPrice))
      ? Number(item.retailPrice)
      : null,
    discount: Number(item.discount || 0),
    bestStore: item.bestStore || "",
    deals: Array.isArray(item.deals) ? item.deals : [],
    customDeals: Array.isArray(item.customDeals) ? item.customDeals : [],
    free: Boolean(item.free),
    status: normalizedStatus,
    schemaVersion: CURRENT_SCHEMA_VERSION
  };
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

function extractItadPriceEntries(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.list)) return data.list;
  return [];
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

function getAllCombinedDeals(game) {
  const official = Array.isArray(game.deals) ? game.deals : [];
  const fallbackRetail = official.length > 0
    ? official[0].retailPrice
    : (game.retailPrice !== null && game.retailPrice > 0 ? Number(game.retailPrice) : null);

  const custom = (Array.isArray(game.customDeals) ? game.customDeals : []).map((c) => {
    const price = Number(c.price);
    const retail = c.retailPrice && Number(c.retailPrice) > 0
      ? Number(c.retailPrice)
      : (fallbackRetail !== null ? fallbackRetail : price);
    const savings = retail > price && retail > 0
      ? Math.round(((retail - price) / retail) * 100)
      : 0;
    return {
      uid: c.id,
      shopName: c.storeName,
      price,
      retailPrice: retail,
      savings,
      currency: c.currency || "EUR",
      url: c.url || ""
    };
  });

  return [...official, ...custom].sort((a, b) => a.price - b.price);
}

async function itadLookupSteam(steamAppId) {
  const url = `https://api.isthereanydeal.com/games/lookup/v1?key=${encodeURIComponent(ITAD_KEY)}&appid=${encodeURIComponent(steamAppId)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data && data.found && data.game ? data.game : null;
}

async function itadSearch(title) {
  const url = `https://api.isthereanydeal.com/games/search/v1?key=${encodeURIComponent(ITAD_KEY)}&title=${encodeURIComponent(title)}&results=5`;
  const res = await fetch(url);
  if (!res.ok) return [];
  return await res.json();
}

async function itadGetInfo(id) {
  const url = `https://api.isthereanydeal.com/games/info/v2?key=${encodeURIComponent(ITAD_KEY)}&id=${encodeURIComponent(id)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return await res.json();
}

async function itadGetPrices(ids) {
  if (!ids.length) return [];
  const keyParam = encodeURIComponent(ITAD_KEY);
  const endpoints = [
    `https://api.isthereanydeal.com/games/prices/v3?key=${keyParam}&country=IT`,
    `https://api.isthereanydeal.com/games/prices/v2?key=${keyParam}&country=IT&nondeals=true`
  ];

  let lastErr = null;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ids)
      });
      if (!res.ok) {
        const errBody = await res.text();
        lastErr = new Error(`ITAD ${url.split("?")[0]} HTTP ${res.status}: ${errBody}`);
        console.warn(lastErr.message);
        continue;
      }
      const raw = await res.json();
      const entries = extractItadPriceEntries(raw);
      console.log(`Endpoint ${url.split("?")[0]} ha restituito ${entries.length} voci.`);
      return entries;
    } catch (err) {
      lastErr = err;
      console.warn(err.message);
    }
  }
  throw lastErr || new Error("Nessun endpoint prezzi ITAD disponibile");
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function main() {
  const raw = fs.readFileSync(BACKLOG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const backlog = parsed.map((item, idx) => normalizeGameSchema(item, idx));

  // 1. Associa ITAD ID mancanti (prima tramite steamAppId, poi per titolo esatto)
  for (const game of backlog) {
    if (!game.itadId && game.steamAppId) {
      const found = await itadLookupSteam(game.steamAppId);
      if (found && found.id) {
        game.itadId = found.id;
        console.log(`Associato ITAD ID via SteamID (${game.steamAppId}) per "${game.title}": ${found.id}`);
      }
    }
    if (!game.itadId && game.category === "wishlist") {
      const matches = await itadSearch(game.title);
      const exact = matches.find((m) => m.title.toLowerCase() === game.title.toLowerCase()) || matches[0];
      if (exact) {
        game.itadId = exact.id;
        console.log(`Associato ITAD ID via titolo per "${game.title}": ${exact.id}`);
      }
    }
  }

  // 2. Aggiorna info, copertine e date rilascio su tutti i giochi collegati a ITAD
  for (const game of backlog) {
    if (!game.itadId) continue;
    if (game.category === "owned" && game.thumb && game.releaseDateISO) continue;

    const info = await itadGetInfo(game.itadId);
    if (info) {
      if (info.assets) {
        const assetThumb =
          info.assets.banner400 ||
          info.assets.banner300 ||
          info.assets.banner145 ||
          info.assets.boxart;
        if (assetThumb) {
          game.thumb = assetThumb;
        }
      }
      if (!game.manualReleaseOverride) {
        if (info.title && (!game.title || game.title === game.title.toUpperCase())) {
          game.title = info.title;
        }
        const rel = parseReleaseStatusFromISO(info.releaseDate);
        game.released = rel.released;
        game.releaseDate = rel.releaseDate;
        game.releaseDateISO = rel.releaseDateISO;
        game.releaseNote = rel.released ? "" : rel.releaseDate;
      }
    }
  }

  // 3. Scarica prezzi in EUR per la Wishlist (in batch da 50)
  const itadWishlist = backlog.filter((g) => g.category === "wishlist" && g.itadId);
  if (itadWishlist.length > 0) {
    const priceMap = new Map();
    const batches = chunkArray(itadWishlist.map((g) => g.itadId), 50);

    for (const batchIds of batches) {
      const priceEntries = await itadGetPrices(batchIds);
      priceEntries.forEach((entry) => {
        priceMap.set(entry.id, entry.deals || entry.offers || []);
      });
    }

    for (const game of itadWishlist) {
      const rawDeals = priceMap.get(game.itadId) || [];
      const deals = normalizeItadDeals(rawDeals);
      console.log(`[${game.title}] -> ${deals.length} offerte ufficiali trovate`);
      game.deals = deals;
      game.currency = "EUR";

      const allCombined = getAllCombinedDeals(game);
      if (allCombined.length > 0) {
        let chosen = allCombined[0];
        if (game.selectedStoreId) {
          const prev = allCombined.find(
            (d) => d.uid === game.selectedStoreId || d.uid === `itad_${game.selectedStoreId}`
          );
          if (prev) chosen = prev;
        }
        game.selectedStoreId = chosen.uid;
        game.salePrice = chosen.price;
        game.retailPrice = chosen.retailPrice;
        game.discount = chosen.savings;
        game.bestStore = chosen.shopName;
      } else {
        game.selectedStoreId = null;
        game.salePrice = null;
        game.retailPrice = null;
        game.discount = 0;
        game.bestStore = "";
      }
    }
  }

  const updated = `${JSON.stringify(backlog, null, 2)}\n`;
  if (updated !== raw) {
    fs.writeFileSync(BACKLOG_PATH, updated, "utf8");
    console.log("backlog.json aggiornato con schema migrato, prezzi in EUR, copertine e date di rilascio.");
  } else {
    console.log("Nessuna variazione rilevata.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
