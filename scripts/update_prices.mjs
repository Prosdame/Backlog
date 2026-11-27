import fs from "node:fs";

const ITAD_KEY = process.env.ITAD_API_KEY;
const BACKLOG_PATH = "backlog.json";

if (!ITAD_KEY) {
  console.error("Errore: variabile d'ambiente ITAD_API_KEY mancante.");
  process.exit(1);
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

async function main() {
  const raw = fs.readFileSync(BACKLOG_PATH, "utf8");
  const backlog = JSON.parse(raw);
  const wishlist = backlog.filter((g) => g.category === "wishlist");

  for (const game of wishlist) {
    if (!game.itadId) {
      const matches = await itadSearch(game.title);
      const exact = matches.find((m) => m.title.toLowerCase() === game.title.toLowerCase()) || matches[0];
      if (exact) {
        game.itadId = exact.id;
        console.log(`Associato ITAD ID per "${game.title}": ${exact.id}`);
      }
    }
  }

  for (const game of wishlist) {
    if (!game.itadId) continue;
    const info = await itadGetInfo(game.itadId);
    if (info) {
      if (info.assets) {
        const assetThumb = info.assets.banner300 || info.assets.banner145 || info.assets.boxart;
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

  const itadGames = wishlist.filter((g) => g.itadId);
  if (itadGames.length > 0) {
    const priceEntries = await itadGetPrices(itadGames.map((g) => g.itadId));
    const priceMap = new Map(
      priceEntries.map((entry) => [entry.id, entry.deals || entry.offers || []])
    );

    for (const game of itadGames) {
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
    console.log("backlog.json aggiornato con prezzi in EUR, copertine e date di rilascio.");
  } else {
    console.log("Nessuna variazione rilevata.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
