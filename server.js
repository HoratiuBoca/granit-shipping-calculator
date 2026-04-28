/**
 * Granit Online — Shopify Carrier Service API v4
 * Suport produse piatră (Raben) + produse întreținere (FAN Courier)
 *
 * LOGICA COȘ:
 * 1. Doar piatră (fără INT-) → Raben Logistics (existent)
 * 2. Doar întreținere (toate INT-) → FAN Courier
 * 3. Mix (piatră + INT-) → Raben Logistics (întreținerea merge gratis cu paletul)
 *
 * Detecție: SKU prefix "INT-" = produs de întreținere
 */

const express = require("express");
const crypto = require("crypto");
const https = require("https");
const { calculateShipping, CONFIG } = require("./shipping-calculator");
const { calculateMaintenanceShipping, FAN_CONFIG } = require("./fan-courier");

const app = express();
app.use(express.json());

// Override din environment
if (process.env.DAF_PERCENT)    CONFIG.DAF_PERCENT = parseFloat(process.env.DAF_PERCENT);
if (process.env.ADV_COST)       CONFIG.ADV_COST = parseFloat(process.env.ADV_COST);
if (process.env.SQM_PER_PALLET) CONFIG.SQM_PER_PALLET = parseFloat(process.env.SQM_PER_PALLET);
if (process.env.KG_PER_SQM)     CONFIG.KG_PER_SQM = parseFloat(process.env.KG_PER_SQM);

const SHOPIFY_SECRET     = process.env.SHOPIFY_SECRET || "";
const SHOPIFY_API_KEY    = process.env.SHOPIFY_API_KEY || "";
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "";
const APP_URL            = process.env.APP_URL || "";

// Prefix SKU pentru produse de întreținere
const MAINTENANCE_SKU_PREFIX = process.env.MAINTENANCE_SKU_PREFIX || "INT-";

// In-memory token store (persists until redeploy)
let shopTokens = {};

// HMAC verification for Shopify webhooks
function verifyShopifyHmac(req, res, next) {
  if (!SHOPIFY_SECRET) return next();
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  if (!hmac) return next();  // Allow requests without HMAC for testing
  const hash = crypto.createHmac("sha256", SHOPIFY_SECRET).update(JSON.stringify(req.body), "utf8").digest("base64");
  if (hash !== hmac) return res.status(401).json({ error: "Invalid HMAC" });
  next();
}

// Verify OAuth HMAC from query params
function verifyOAuthHmac(query) {
  if (!SHOPIFY_API_SECRET) return true;
  const hmac = query.hmac;
  if (!hmac) return false;
  const params = { ...query };
  delete params.hmac;
  const sortedParams = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
  const hash = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(sortedParams).digest("hex");
  return hash === hmac;
}

// Helper: make HTTPS request
function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, data: data }); }
      });
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// Register Carrier Service on a shop
async function registerCarrierService(shop, accessToken) {
  const callbackUrl = APP_URL
    ? `${APP_URL}/api/shipping-rates`
    : `https://${process.env.RAILWAY_PUBLIC_DOMAIN || "granit-shipping-calculator-production.up.railway.app"}/api/shipping-rates`;

  const postData = JSON.stringify({
    carrier_service: {
      name: "Granit Online — Livrare Calculată",
      callback_url: callbackUrl,
      service_discovery: true,
      format: "json"
    }
  });

  console.log(`📦 Registering Carrier Service on ${shop}...`);
  console.log(`  Callback URL: ${callbackUrl}`);

  const result = await httpsRequest({
    hostname: shop,
    path: "/admin/api/2024-01/carrier_services.json",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
      "Content-Length": Buffer.byteLength(postData)
    }
  }, postData);

  console.log(`  Response (${result.status}):`, JSON.stringify(result.data));
  return result;
}

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ============================================================
// HELPER: Clasifică itemii din coș
// ============================================================
function classifyCartItems(items) {
  const stoneItems = [];
  const maintenanceItems = [];

  for (const item of items) {
    const sku = (item.sku || "").toUpperCase().trim();
    if (sku.startsWith(MAINTENANCE_SKU_PREFIX.toUpperCase())) {
      maintenanceItems.push(item);
    } else {
      stoneItems.push(item);
    }
  }

  let cartType;
  if (stoneItems.length > 0 && maintenanceItems.length > 0) {
    cartType = "mixed";
  } else if (maintenanceItems.length > 0) {
    cartType = "maintenance_only";
  } else {
    cartType = "stone_only";
  }

  return { stoneItems, maintenanceItems, cartType };
}

// ============================================================
// GET /auth/callback — Shopify OAuth callback
// ============================================================
app.get("/auth/callback", async (req, res) => {
  try {
    const { code, shop, hmac, timestamp } = req.query;
    console.log(`🔑 OAuth callback from ${shop}`);

    if (!code || !shop) {
      return res.status(400).send("Missing code or shop parameter");
    }
    if (!verifyOAuthHmac(req.query)) {
      console.log("⚠ï¸ HMAC verification failed, but continuing...");
    }

    const postData = JSON.stringify({
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code: code
    });

    const tokenResult = await httpsRequest({
      hostname: shop,
      path: "/admin/oauth/access_token",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    }, postData);

    console.log(`  Token exchange status: ${tokenResult.status}`);

    if (tokenResult.status !== 200 || !tokenResult.data.access_token) {
      console.error("  Token exchange failed:", tokenResult.data);
      return res.status(500).send(`Token exchange failed: ${JSON.stringify(tokenResult.data)}`);
    }

    const accessToken = tokenResult.data.access_token;
    shopTokens[shop] = accessToken;
    console.log(`✅ Got access token for ${shop}: ${accessToken.substring(0, 8)}...`);

    const csResult = await registerCarrierService(shop, accessToken);

    let message = "";
    if (csResult.status === 201) {
      message = `<h2>✅ App instalată cu succes!</h2>
        <p>Carrier Service „Granit Online — Livrare Calculată" a fost înregistrat.</p>
        <p>ID: ${csResult.data.carrier_service?.id}</p>
        <p>Callback: ${csResult.data.carrier_service?.callback_url}</p>
        <p><a href="https://admin.shopify.com/store/${shop.replace('.myshopify.com', '')}/settings/shipping">→ Mergi la Settings &gt; Shipping</a></p>`;
    } else if (csResult.status === 422) {
      message = `<h2>⚠ï¸ Carrier Service există deja</h2>
        <p>App-ul a fost reinstalat. Carrier Service era deja înregistrat.</p>
        <p>Detalii: ${JSON.stringify(csResult.data)}</p>`;
    } else {
      message = `<h2>⚠ï¸ App instalată, dar Carrier Service nu s-a putut înregistra</h2>
        <p>Status: ${csResult.status}</p><p>Răspuns: ${JSON.stringify(csResult.data)}</p>
        <p>Token salvat — poți reîncerca la /api/admin/register-carrier</p>`;
    }

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Granit Shipping</title>
      <style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px}h2{color:#2e7d32}p{line-height:1.6}</style>
      </head><body>${message}</body></html>`);
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send(`OAuth error: ${err.message}`);
  }
});

// ============================================================
// GET /auth/install — Start OAuth flow
// ============================================================
app.get("/auth/install", (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send("Missing shop parameter. Use: /auth/install?shop=your-store.myshopify.com");

  const redirectUri = APP_URL
    ? `${APP_URL}/auth/callback`
    : `https://${process.env.RAILWAY_PUBLIC_DOMAIN || "granit-shipping-calculator-production.up.railway.app"}/auth/callback`;

  const scopes = "read_shipping,write_shipping";
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  console.log(`🔄 Redirecting to Shopify OAuth: ${installUrl}`);
  res.redirect(installUrl);
});

// ============================================================
// GET /api/admin/register-carrier — Manual carrier registration
// ============================================================
app.get("/api/admin/register-carrier", async (req, res) => {
  const shop = req.query.shop;
  const token = req.query.token || shopTokens[shop];

  if (!shop || !token) {
    return res.status(400).json({
      error: "Missing shop or token",
      usage: "/api/admin/register-carrier?shop=xxx.myshopify.com&token=YOUR_TOKEN",
      storedShops: Object.keys(shopTokens)
    });
  }

  try {
    const result = await registerCarrierService(shop, token);
    res.json({ status: result.status, data: result.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/shipping-rates — Shopify Carrier Service API
// ============================================================
app.post("/api/shipping-rates", verifyShopifyHmac, async (req, res) => {
  try {
    const { rate } = req.body;
    if (!rate) return res.status(400).json({ rates: [] });

    const postalCode = rate.destination?.postal_code || "";
    const destination = rate.destination || {};
    const items = rate.items || [];

    if (items.length === 0) return res.json({ rates: [] });

    // ── Clasificăm itemii ──
    const { stoneItems, maintenanceItems, cartType } = classifyCartItems(items);

    console.log(`🛒 Cart: ${cartType} | ${stoneItems.length} piatră, ${maintenanceItems.length} întreținere | postal: ${postalCode}`);

    // ── Dacă nu avem cod poștal și e piatră → mesaj informativ ──
    if (cartType !== "maintenance_only" && (!postalCode || postalCode.trim() === "")) {
      return res.json({ rates: [{
        service_name: "Completați adresa pentru a primi costul de livrare",
        description: "Introduceți codul poștal complet pentru a calcula transportul",
        service_code: "RABEN_NEED_POSTAL",
        currency: "RON",
        total_price: 0
      }] });
    }

    // ── SCENARIUL 1: Doar produse de întreținere → FAN Courier ──
    if (cartType === "maintenance_only") {
      const fanResult = await calculateMaintenanceShipping(maintenanceItems, destination);

      if (!fanResult.success) {
        return res.json({ rates: [{
          service_name: "Livrare FAN Courier — Contactați-ne",
          description: fanResult.message || "Eroare la calcul",
          service_code: "FAN_ERROR",
          currency: "RON",
          total_price: 0
        }] });
      }

      const priceInBani = Math.round(fanResult.totalPrice * 100);
      return res.json({ rates: [{
        service_name: "Livrare FAN Courier",
        description: fanResult.description,
        service_code: "FAN_STANDARD",
        currency: "RON",
        total_price: priceInBani,
        min_delivery_date: addBusinessDays(new Date(), 1).toISOString().split("T")[0],
        max_delivery_date: addBusinessDays(new Date(), 3).toISOString().split("T")[0],
      }] });
    }

    // ── SCENARIUL 2 & 3: Piatră (cu sau fără întreținere) → Raben ──
    // La coș mixt, întreținerea merge GRATIS cu paletul de piatră

    // Grupăm itemii de PIATRă per greutate (grams = greutatea per unitate în grame)
    // quantity = nr de m² comandate per item
    const weightGroups = {};
    for (const item of stoneItems) {
      const sqm = item.quantity;
      const kgPerSqm = (item.grams && item.grams > 0) ? item.grams / 1000 : CONFIG.KG_PER_SQM;
      const key = kgPerSqm.toString();
      if (!weightGroups[key]) {
        weightGroups[key] = { sqm: 0, kgPerSqm };
      }
      weightGroups[key].sqm += sqm;
    }

    const materialGroups = Object.values(weightGroups);
    const totalSqm = materialGroups.reduce((sum, g) => sum + g.sqm, 0);

    if (totalSqm <= 0) return res.json({ rates: [] });

    console.log(`📦 Raben: ${totalSqm} m², postal: ${postalCode}, groups:`, JSON.stringify(materialGroups));

    const result = calculateShipping(materialGroups, postalCode);

    if (!result.success) {
      return res.json({ rates: [{
        service_name: "Livrare Raben — Contactați-ne",
        description: result.message,
        service_code: "RABEN_ERROR",
        currency: "RON",
        total_price: 0
      }] });
    }

    const priceInBani = Math.round(result.totalPrice * 100);
    const totalPallets = result.totalPallets;
    const minDays = result.zone <= 3 ? 2 : 3;
    const maxDays = result.zone <= 3 ? 4 : 6;

    let desc = `${totalPallets} palet${totalPallets > 1 ? "i" : ""}, ${result.totalSqm} m², Zona ${result.zone}`;
    if (result.numDeliveries > 1) desc += ` (${result.numDeliveries} livrări)`;

    // La coș mixt, adăugăm notă că întreținerea e inclusă gratis
    if (cartType === "mixed") {
      desc += " + produse întreținere GRATUIT";
    }

    return res.json({ rates: [{
      service_name: "Livrare Raben Logistics",
      description: desc,
      service_code: "RABEN_STANDARD",
      currency: "RON",
      total_price: priceInBani,
      min_delivery_date: addBusinessDays(new Date(), minDays).toISOString().split("T")[0],
      max_delivery_date: addBusinessDays(new Date(), maxDays).toISOString().split("T")[0],
    }] });

  } catch (err) {
    console.error("Eroare:", err);
    return res.status(500).json({ rates: [] });
  }
});

// ============================================================
// GET /api/calculate — Calculator standalone (testare)
// ============================================================
app.get("/api/calculate", (req, res) => {
  const postal = req.query.postal || "";
  if (!postal) return res.status(400).json({
    error: "Utilizare: /api/calculate?sqm=65&postal=010045 sau /api/calculate?groups=60:30,20:60&postal=010045"
  });

  if (req.query.groups) {
    const materialGroups = req.query.groups.split(",").map(g => {
      const [sqm, kgPerSqm] = g.split(":").map(Number);
      return { sqm, kgPerSqm: kgPerSqm || CONFIG.KG_PER_SQM };
    });
    return res.json(calculateShipping(materialGroups, postal));
  }

  const sqm = parseFloat(req.query.sqm);
  const kgPerSqm = parseFloat(req.query.kg) || CONFIG.KG_PER_SQM;
  if (!sqm) return res.status(400).json({ error: "Utilizare: /api/calculate?sqm=65&postal=010045&kg=60" });
  return res.json(calculateShipping([{ sqm, kgPerSqm }], postal));
});

// ============================================================
// GET /api/calculate-fan — Calculator FAN Courier (testare)
// ============================================================
app.get("/api/calculate-fan", async (req, res) => {
  const weight = parseFloat(req.query.weight) || 1;
  const county = req.query.county || "Bucuresti";
  const city = req.query.city || "Bucuresti";
  const parcels = parseInt(req.query.parcels) || 1;

  // Simulăm items din Shopify
  const fakeItems = [{
    sku: "INT-TEST",
    grams: weight * 1000,
    quantity: 1,
    name: "Test Maintenance Product"
  }];

  const destination = { province: county, city: city };
  const result = await calculateMaintenanceShipping(fakeItems, destination);
  return res.json(result);
});

// ============================================================
// POST /api/admin/update-config — Actualizare DAF/ADV
// ============================================================
app.post("/api/admin/update-config", (req, res) => {
  const adminKey = process.env.ADMIN_API_KEY || "change-me-in-production";
  if (req.body.api_key !== adminKey) return res.status(401).json({ error: "Unauthorized" });

  if (req.body.daf_percent !== undefined) CONFIG.DAF_PERCENT = parseFloat(req.body.daf_percent);
  if (req.body.adv_cost !== undefined)    CONFIG.ADV_COST = parseFloat(req.body.adv_cost);

  return res.json({ success: true, config: { DAF_PERCENT: CONFIG.DAF_PERCENT, ADV_COST: CONFIG.ADV_COST } });
});

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "Granit Online Shipping v4",
    features: {
      stone: "Raben Logistics (palet/m²)",
      maintenance: "FAN Courier (colete individuale)",
      mixed: "Raben only (întreținere gratis cu paletul)",
      skuPrefix: MAINTENANCE_SKU_PREFIX,
    },
    config: {
      DAF: `${CONFIG.DAF_PERCENT * 100}%`,
      ADV: `${CONFIG.ADV_COST} RON`,
      MAX_KG: CONFIG.MAX_KG_PER_DELIVERY,
    },
    fanCourier: {
      apiEnabled: !!(FAN_CONFIG.CLIENT_ID && FAN_CONFIG.USERNAME),
      fallbackGrid: FAN_CONFIG.FALLBACK_GRID,
    },
    installedShops: Object.keys(shopTokens),
  });
});

function addBusinessDays(date, days) {
  const r = new Date(date);
  let added = 0;
  while (added < days) {
    r.setDate(r.getDate() + 1);
    if (r.getDay() !== 0 && r.getDay() !== 6) added++;
  }
  return r;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚛 Granit Online Shipping v4 on port ${PORT}`);
  console.log(`  Raben: DAF ${CONFIG.DAF_PERCENT * 100}% | ADV ${CONFIG.ADV_COST} RON | Max ${CONFIG.MAX_KG_PER_DELIVERY} kg`);
  console.log(`  FAN Courier: ${FAN_CONFIG.CLIENT_ID ? "API activ (ID: " + FAN_CONFIG.CLIENT_ID + ")" : "Fallback grilă statică"}`);
  console.log(`  SKU prefix întreținere: "${MAINTENANCE_SKU_PREFIX}"`);
  console.log(`  Test Raben: http://localhost:${PORT}/api/calculate?sqm=60&postal=010045`);
  console.log(`  Test FAN:   http://localhost:${PORT}/api/calculate-fan?weight=2&county=Bucuresti&city=Bucuresti`);
});

module.exports = app;
