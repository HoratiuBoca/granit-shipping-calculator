/**
 * Granit Online — Shopify Carrier Service API v3
 * Greutate medie per palet + splitting la 5 tone
 * Cu OAuth callback + auto-registrare Carrier Service
 */
const express = require("express");
const crypto = require("crypto");
const https = require("https");
const { calculateShipping, CONFIG } = require("./shipping-calculator");

const app = express();
app.use(express.json());

// Override din environment
if (process.env.DAF_PERCENT) CONFIG.DAF_PERCENT = parseFloat(process.env.DAF_PERCENT);
if (process.env.ADV_COST) CONFIG.ADV_COST = parseFloat(process.env.ADV_COST);
if (process.env.SQM_PER_PALLET) CONFIG.SQM_PER_PALLET = parseFloat(process.env.SQM_PER_PALLET);
if (process.env.KG_PER_SQM) CONFIG.KG_PER_SQM = parseFloat(process.env.KG_PER_SQM);

const SHOPIFY_SECRET = process.env.SHOPIFY_SECRET || "";
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "";
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "";
const APP_URL = process.env.APP_URL || "";

let shopTokens = {};

function verifyShopifyHmac(req, res, next) {
  if (!SHOPIFY_SECRET) return next();
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  if (!hmac) return next();
  const hash = crypto.createHmac("sha256", SHOPIFY_SECRET).update(JSON.stringify(req.body), "utf8").digest("base64");
  if (hash !== hmac) return res.status(401).json({ error: "Invalid HMAC" });
  next();
}

function verifyOAuthHmac(query) {
  if (!SHOPIFY_API_SECRET) return true;
  const hmac = query.hmac;
  if (!hmac) return false;
  const params = { ...query };
  delete params.hmac;
  const sortedParams = Object.keys(params).sort().map(k => k + "=" + params[k]).join("&");
  const hash = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(sortedParams).digest("hex");
  return hash === hmac;
}

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

async function registerCarrierService(shop, accessToken) {
  const callbackUrl = APP_URL ? APP_URL + "/api/shipping-rates" : "https://" + (process.env.RAILWAY_PUBLIC_DOMAIN || "granit-shipping-calculator-production.up.railway.app") + "/api/shipping-rates";
  const postData = JSON.stringify({
    carrier_service: {
      name: "Raben Logistics - Granit Online",
      callback_url: callbackUrl,
      service_discovery: true,
      format: "json"
    }
  });
  console.log("Registering Carrier Service on " + shop + " callback: " + callbackUrl);
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
  console.log("Carrier Service response (" + result.status + "):", JSON.stringify(result.data));
  return result;
}

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { code, shop, hmac, timestamp } = req.query;
    console.log("OAuth callback from " + shop);
    if (!code || !shop) return res.status(400).send("Missing code or shop parameter");
    if (!verifyOAuthHmac(req.query)) console.log("HMAC verification failed, continuing...");
    const postData = JSON.stringify({ client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code: code });
    const tokenResult = await httpsRequest({
      hostname: shop, path: "/admin/oauth/access_token", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) }
    }, postData);
    console.log("Token exchange status: " + tokenResult.status);
    if (tokenResult.status !== 200 || !tokenResult.data.access_token) {
      console.error("Token exchange failed:", tokenResult.data);
      return res.status(500).send("Token exchange failed: " + JSON.stringify(tokenResult.data));
    }
    const accessToken = tokenResult.data.access_token;
    shopTokens[shop] = accessToken;
    console.log("Got access token for " + shop);
    const csResult = await registerCarrierService(shop, accessToken);
    let msg = "";
    if (csResult.status === 201) {
      msg = "<h2>App instalata cu succes!</h2><p>Carrier Service Raben Logistics a fost inregistrat.</p><p>ID: " + (csResult.data.carrier_service ? csResult.data.carrier_service.id : "N/A") + "</p><p>Callback: " + (csResult.data.carrier_service ? csResult.data.carrier_service.callback_url : "N/A") + "</p>";
    } else if (csResult.status === 422) {
      msg = "<h2>Carrier Service exista deja</h2><p>App-ul a fost reinstalat.</p>";
    } else {
      msg = "<h2>App instalata, dar Carrier Service nu s-a putut inregistra</h2><p>Status: " + csResult.status + "</p><p>Raspuns: " + JSON.stringify(csResult.data) + "</p><p>Token salvat, poti reincerca la /api/admin/register-carrier</p>";
    }
    res.send("<!DOCTYPE html><html><head><meta charset=utf-8><title>Granit Shipping</title><style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px}</style></head><body>" + msg + "</body></html>");
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send("OAuth error: " + err.message);
  }
});

app.get("/auth/install", (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send("Missing shop parameter. Use: /auth/install?shop=your-store.myshopify.com");
  const redirectUri = APP_URL ? APP_URL + "/auth/callback" : "https://" + (process.env.RAILWAY_PUBLIC_DOMAIN || "granit-shipping-calculator-production.up.railway.app") + "/auth/callback";
  const scopes = "read_shipping,write_shipping";
  const installUrl = "https://" + shop + "/admin/oauth/authorize?client_id=" + SHOPIFY_API_KEY + "&scope=" + scopes + "&redirect_uri=" + encodeURIComponent(redirectUri);
  console.log("Redirecting to Shopify OAuth: " + installUrl);
  res.redirect(installUrl);
});

app.get("/api/admin/register-carrier", async (req, res) => {
  const shop = req.query.shop;
  const token = req.query.token || shopTokens[shop];
  if (!shop || !token) return res.status(400).json({ error: "Missing shop or token", usage: "/api/admin/register-carrier?shop=xxx.myshopify.com&token=YOUR_TOKEN", storedShops: Object.keys(shopTokens) });
  try {
    const result = await registerCarrierService(shop, token);
    res.json({ status: result.status, data: result.data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/shipping-rates", verifyShopifyHmac, (req, res) => {
  try {
    const { rate } = req.body;
    if (!rate) return res.status(400).json({ rates: [] });
    const postalCode = rate.destination?.postal_code || "";
    const items = rate.items || [];
    let totalSqm = 0;
    for (const item of items) totalSqm += item.quantity;
    if (totalSqm <= 0) return res.json({ rates: [] });
    const result = calculateShipping(totalSqm, postalCode);
    if (!result.success) return res.json({ rates: [{ service_name: "Livrare Raben - Contactati-ne", description: result.message, service_code: "RABEN_ERROR", currency: "RON", total_price: 0 }] });
    const priceInBani = Math.round(result.totalPrice * 100);
    const totalPallets = result.deliveries.reduce((s, d) => s + d.pallets, 0);
    const minDays = result.zone <= 3 ? 2 : 3;
    const maxDays = result.zone <= 3 ? 4 : 6;
    let desc = totalPallets + " palet" + (totalPallets > 1 ? "i" : "") + ", " + result.totalSqm + " mp, Zona " + result.zone;
    if (result.numDeliveries > 1) desc += " (" + result.numDeliveries + " livrari)";
    return res.json({ rates: [{ service_name: "Livrare Raben Logistics", description: desc, service_code: "RABEN_STANDARD", currency: "RON", total_price: priceInBani, min_delivery_date: addBusinessDays(new Date(), minDays).toISOString().split("T")[0], max_delivery_date: addBusinessDays(new Date(), maxDays).toISOString().split("T")[0] }] });
  } catch (err) { console.error("Eroare:", err); return res.status(500).json({ rates: [] }); }
});

app.get("/api/calculate", (req, res) => {
  const sqm = parseFloat(req.query.sqm);
  const postal = req.query.postal || "";
  if (!sqm || !postal) return res.status(400).json({ error: "Utilizare: /api/calculate?sqm=65&postal=010045" });
  return res.json(calculateShipping(sqm, postal));
});

app.post("/api/admin/update-config", (req, res) => {
  const adminKey = process.env.ADMIN_API_KEY || "change-me-in-production";
  if (req.body.api_key !== adminKey) return res.status(401).json({ error: "Unauthorized" });
  if (req.body.daf_percent !== undefined) CONFIG.DAF_PERCENT = parseFloat(req.body.daf_percent);
  if (req.body.adv_cost !== undefined) CONFIG.ADV_COST = parseFloat(req.body.adv_cost);
  return res.json({ success: true, config: { DAF_PERCENT: CONFIG.DAF_PERCENT, ADV_COST: CONFIG.ADV_COST } });
});

app.get("/", (req, res) => {
  res.json({ status: "OK", service: "Granit Online Shipping v3", config: { DAF: CONFIG.DAF_PERCENT + "%", ADV: CONFIG.ADV_COST + " RON", MAX_KG: CONFIG.MAX_KG_PER_DELIVERY }, installedShops: Object.keys(shopTokens) });
});

function addBusinessDays(date, days) {
  const r = new Date(date);
  let added = 0;
  while (added < days) { r.setDate(r.getDate() + 1); if (r.getDay() !== 0 && r.getDay() !== 6) added++; }
  return r;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Granit Online Shipping v3 on port " + PORT);
  console.log("  DAF: " + CONFIG.DAF_PERCENT + "% | ADV: " + CONFIG.ADV_COST + " RON | Max/livrare: " + CONFIG.MAX_KG_PER_DELIVERY + " kg");
  console.log("  API Key: " + (SHOPIFY_API_KEY ? SHOPIFY_API_KEY.substring(0, 8) + "..." : "NOT SET"));
  console.log("  Test: http://localhost:" + PORT + "/api/calculate?sqm=60&postal=010045");
});

module.exports = app;
