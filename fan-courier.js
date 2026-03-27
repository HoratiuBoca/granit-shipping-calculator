/**
 * FAN Courier â Modul calcul cost livrare pentru produse de Ã®ntreÈinere
 *
 * DouÄ moduri de funcÈionare:
 * 1. API FAN Courier (dacÄ sunt setate credenÈialele) â tarife exacte din contract
 * 2. GrilÄ de preÈuri staticÄ (fallback) â tarife configurabile manual
 *
 * API: https://api.fancourier.ro
 * Auth: Bearer Token (valid 24h)
 * Endpoint tarif: GET /reports/awb/internal-tariff
 */

const https = require("https");

// ============================================================
// CONFIGURARE
// ============================================================
const FAN_CONFIG = {
  API_BASE: "api.fancourier.ro",
  CLIENT_ID: process.env.FAN_CLIENT_ID || "",
  USERNAME: process.env.FAN_USERNAME || "",
  PASSWORD: process.env.FAN_PASSWORD || "",
  SERVICE: process.env.FAN_SERVICE || "Standard",       // Standard, RedCode, etc.
  PAYMENT: process.env.FAN_PAYMENT || "sender",         // sender = noi plÄtim
  DEFAULT_LENGTH: 40,  // cm â dimensiuni default pachet
  DEFAULT_WIDTH: 30,
  DEFAULT_HEIGHT: 30,

  // GrilÄ staticÄ fallback (RON cu TVA) â editabilÄ din env
  // Format: "maxKg:pret,maxKg:pret,..."
  // ex: "1:22,5:30,10:42,20:58,31:75"
  FALLBACK_GRID: process.env.FAN_PRICE_GRID || "1:22,3:28,5:33,10:42,15:52,20:62,25:72,31:82",
};

// Token cache
let cachedToken = null;
let tokenExpiresAt = null;

// ============================================================
// HELPERS
// ============================================================

function httpsRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * ParseazÄ grila de preÈuri din string
 * @returns {Array<{maxKg: number, price: number}>} sortat crescÄtor
 */
function parseFallbackGrid(gridStr) {
  return gridStr.split(",").map(entry => {
    const [maxKg, price] = entry.split(":").map(Number);
    return { maxKg, price };
  }).sort((a, b) => a.maxKg - b.maxKg);
}

/**
 * CautÄ preÈul Ã®n grila staticÄ pe baza greutÄÈii
 */
function lookupFallbackPrice(weightKg) {
  const grid = parseFallbackGrid(FAN_CONFIG.FALLBACK_GRID);
  for (const tier of grid) {
    if (weightKg <= tier.maxKg) {
      return tier.price;
    }
  }
  // Peste grila maximÄ â extrapolare liniarÄ din ultimele 2 trepte
  if (grid.length >= 2) {
    const last = grid[grid.length - 1];
    const prev = grid[grid.length - 2];
    const pricePerKg = (last.price - prev.price) / (last.maxKg - prev.maxKg);
    return round2(last.price + pricePerKg * (weightKg - last.maxKg));
  }
  return grid[grid.length - 1]?.price || 0;
}

// ============================================================
// FAN COURIER API
// ============================================================

/**
 * ObÈine Bearer Token (cachat 24h)
 */
async function getToken() {
  // Return cached dacÄ valid
  if (cachedToken && tokenExpiresAt && new Date() < tokenExpiresAt) {
    return cachedToken;
  }

  if (!FAN_CONFIG.USERNAME || !FAN_CONFIG.PASSWORD) {
    return null;
  }

  console.log("ð FAN Courier: ObÈin token nou...");

  const result = await httpsRequest({
    hostname: FAN_CONFIG.API_BASE,
    path: `/login?username=${encodeURIComponent(FAN_CONFIG.USERNAME)}&password=${encodeURIComponent(FAN_CONFIG.PASSWORD)}`,
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });

  if (result.status === 200 && result.data?.status === "success" && result.data?.data?.token) {
    cachedToken = result.data.data.token;
    // Token valid 24h, dar reÃ®mprospÄtÄm la 23h ca sÄ fim siguri
    tokenExpiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000);
    console.log("â FAN Courier: Token obÈinut, expirÄ:", result.data.data.expiresAt);
    return cachedToken;
  }

  console.error("â FAN Courier: Eroare la autentificare:", result.data);
  return null;
}

/**
 * CalculeazÄ tariful via API FAN Courier
 *
 * @param {number} weightKg - greutate totalÄ Ã®n kg
 * @param {number} parcels - nr colete
 * @param {string} county - judeÈ destinatar (din Shopify: province)
 * @param {string} locality - localitate destinatar (din Shopify: city)
 * @param {object} dimensions - {length, width, height} Ã®n cm
 * @returns {object} - {success, total, details} sau {success: false, error}
 */
async function calculateFanTariff(weightKg, parcels, county, locality, dimensions = {}) {
  const token = await getToken();
  if (!token) return null; // No credentials â fallback

  const params = new URLSearchParams({
    clientId: FAN_CONFIG.CLIENT_ID,
    "info[service]": FAN_CONFIG.SERVICE,
    "info[payment]": FAN_CONFIG.PAYMENT,
    "info[weight]": Math.max(1, Math.ceil(weightKg)).toString(),
    "info[packages][parcel]": parcels.toString(),
    "info[packages][envelope]": "0",
    "info[dimensions][length]": (dimensions.length || FAN_CONFIG.DEFAULT_LENGTH).toString(),
    "info[dimensions][width]": (dimensions.width || FAN_CONFIG.DEFAULT_WIDTH).toString(),
    "info[dimensions][height]": (dimensions.height || FAN_CONFIG.DEFAULT_HEIGHT).toString(),
    "recipient[county]": county,
    "recipient[locality]": locality,
  });

  console.log(`ð¦ FAN Courier: Calculez tarif â ${weightKg}kg, ${parcels} colet(e), ${locality}, ${county}`);

  try {
    const result = await httpsRequest({
      hostname: FAN_CONFIG.API_BASE,
      path: `/reports/awb/internal-tariff?${params.toString()}`,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    if (result.status === 200 && result.data?.status === "success" && result.data?.data) {
      const d = result.data.data;
      console.log(`â FAN Courier: Tarif = ${d.total} RON (fÄrÄ TVA: ${d.costNoVAT})`);
      return {
        success: true,
        total: d.total,           // RON cu TVA
        costNoVAT: d.costNoVAT,
        vat: d.vat,
        weightCost: d.weightCost,
        fuelCost: d.fuelCost,
        extraKmCost: d.extraKmCost || 0,
        insuranceCost: d.insuranceCost || 0,
        source: "fan_api"
      };
    }

    // Token expirat? ResetÄm Èi reÃ®ncercÄm o datÄ
    if (result.status === 401) {
      console.log("â ï¸ FAN Courier: Token expirat, regenerez...");
      cachedToken = null;
      tokenExpiresAt = null;
      const retryToken = await getToken();
      if (retryToken) {
        // O singurÄ reÃ®ncercare
        const retry = await httpsRequest({
          hostname: FAN_CONFIG.API_BASE,
          path: `/reports/awb/internal-tariff?${params.toString()}`,
          method: "GET",
          headers: {
            "Authorization": `Bearer ${retryToken}`,
            "Content-Type": "application/json"
          }
        });
        if (retry.status === 200 && retry.data?.status === "success" && retry.data?.data) {
          const d = retry.data.data;
          return { success: true, total: d.total, costNoVAT: d.costNoVAT, vat: d.vat, source: "fan_api" };
        }
      }
    }

    console.error("â FAN Courier: Eroare la tarif:", result.status, result.data);
    return null; // fallback to static grid
  } catch (err) {
    console.error("â FAN Courier: Eroare reÈea:", err.message);
    return null;
  }
}

// ============================================================
// FUNCÈIA PRINCIPALÄ
// ============================================================

/**
 * CalculeazÄ costul de livrare FAN Courier pentru produse de Ã®ntreÈinere
 *
 * @param {Array} items - array de item-uri maintenance din coÈul Shopify
 *   Fiecare item: { name, sku, grams, quantity, price }
 * @param {object} destination - { province, city, postal_code, country }
 * @returns {object} - { success, totalPrice, description, source }
 */
async function calculateMaintenanceShipping(items, destination) {
  if (!items || items.length === 0) {
    return { success: false, error: "NO_ITEMS", message: "Niciun produs de Ã®ntreÈinere." };
  }

  // CalculÄm greutatea totalÄ (Shopify trimite grams per unitate)
  let totalGrams = 0;
  let totalItems = 0;
  for (const item of items) {
    const itemWeight = (item.grams || 500) * item.quantity; // default 500g dacÄ lipseÈte
    totalGrams += itemWeight;
    totalItems += item.quantity;
  }

  const totalKg = totalGrams / 1000;
  // EstimÄm nr de colete: 1 colet dacÄ sub 30kg, altfel Ã®mpÄrÈim
  const parcels = Math.max(1, Math.ceil(totalKg / 30));

  const county = destination.province || "";
  const city = destination.city || "";

  console.log(`ð¦ Maintenance shipping: ${totalItems} produse, ${totalKg}kg, ${parcels} colet(e) â ${city}, ${county}`);

  // ÃncercÄm API FAN Courier mai Ã®ntÃ¢i
  if (FAN_CONFIG.CLIENT_ID && FAN_CONFIG.USERNAME) {
    const apiResult = await calculateFanTariff(totalKg, parcels, county, city);
    if (apiResult && apiResult.success) {
      return {
        success: true,
        totalPrice: apiResult.total,
        totalKg: round2(totalKg),
        parcels,
        description: `${parcels} colet${parcels > 1 ? "e" : ""}, ${round2(totalKg)} kg`,
        source: "fan_api",
        details: apiResult
      };
    }
    console.log("â ï¸ FAN API indisponibil, folosesc grila staticÄ...");
  }

  // Fallback: grilÄ staticÄ
  const fallbackPrice = lookupFallbackPrice(totalKg);
  return {
    success: true,
    totalPrice: fallbackPrice,
    totalKg: round2(totalKg),
    parcels,
    description: `${parcels} colet${parcels > 1 ? "e" : ""}, ${round2(totalKg)} kg`,
    source: "fallback_grid",
    details: { priceFromGrid: fallbackPrice }
  };
}

function round2(num) {
  return Math.round(num * 100) / 100;
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  calculateMaintenanceShipping,
  calculateFanTariff,
  lookupFallbackPrice,
  parseFallbackGrid,
  getToken,
  FAN_CONFIG,
};
