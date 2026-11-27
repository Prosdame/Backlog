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
  const url = `https://api.isthereanydeal.com/games/prices/v3?key=${encodeURIComponent(ITAD_KEY)}&country=IT`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ids)
  });
  if (!res.ok) {
    throw new Error(`ITAD prices HTTP ${res.status}: ${await res.text()}`);
  }
  return await res.json();
}

async function main() {
  const raw = fs.readFileSync(BACKLOG_PATH, "utf8");
  const backlog = JSON.parse(raw);
  const wishlist = backlog.filter((g) => g.category === "wishlist");

  // 1. Associa itadId ai giochi che ne sono ancora sprovvisti (es. vecchi giochi CheapShark)
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

  // 2. Aggiorna data e stato di rilascio
  for (const game of wishlist) {
    if (!game.itadId || game.manualReleaseOverride) continue;
    const info = await itadGetInfo(game.itadId);
    if (info) {
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

  // 3. Scarica tutti i prezzi in EUR per l'Italia in un'unica chiamata
  const itadGames = wishlist.filter((g) => g.itadId);
  if (itadGames.length > 0) {
    const priceEntries = await itadGetPrices(itadGames.map((g) => g.itadId));
    const priceMap = new Map(priceEntries.map((entry) => [entry.id, entry.deals || []]));

    for (const game of itadGames) {
      const deals = normalizeItadDeals(priceMap.get(game.itadId) || []);
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
    console.log("backlog.json aggiornato con prezzi in EUR e date di rilascio.");
  } else {
    console.log("Nessuna variazione rilevata.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
