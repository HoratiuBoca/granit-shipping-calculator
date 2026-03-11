/**
 * Granit Online — Shopify Carrier Service API v3
 * Greutate medie per palet + splitting la 5 tone
 */
const express = require("express");
const crypto = require("crypto");
const { calculateShipping, CONFIG } = require("./shipping-calculator");

const app = express();
app.use(express.json());

// Override din environment
if (process.env.DAF_PERCENT) CONFIG.DAF_PERCENT = parseFloat(process.env.DAF_PERCENT);
if (process.env.ADV_COST) CONFIG.ADV_COST = parseFloat(process.env.ADV_COST);
if (process.env.SQM_PER_PALLET) CONFIG.SQM_PER_PALLET = parseFloat(process.env.SQM_PER_PALLET);
if (process.env.KG_PER_SQM) CONFIG.KG_PER_SQM = parseFloat(process.env.KG_PER_SQM);

const SHOPIFY_SECRET = process.env.SHOPIFY_SECRET || "";

// HMAC verification
function verifyShopifyHmac(req, res, next) {
  if (!SHOPIFY_SECRET) return next();
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  if (!hmac) return res.status(401).json({ error: "Missing HMAC" });
  const hash = crypto.createHmac("sha256", SHOPIFY_SECRET).update(JSON.stringify(req.body), "utf8").digest("base64");
  if (hash !== hmac) return res.status(401).json({ error: "Invalid HMAC" });
  next();
}

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ============================================================
// POST /api/shipping-rates — Shopify Carrier Service API
// ============================================================
app.post("/api/shipping-rates", verifyShopifyHmac, (req, res) => {
  try {
    const { rate } = req.body;
    if (!rate) return res.status(400).json({ rates: [] });
    const postalCode = rate.destination?.postal_code || "";
    const items = rate.items || [];
    let totalSqm = 0;
    for (const item of items) {
      totalSqm += item.quantity;
    }
    if (totalSqm <= 0) return res.json({ rates: [] });
    const result = calculateShipping(totalSqm, postalCode);
    if (!result.success) {
      return res.json({ rates: [{ service_name: "Livrare Raben — Contactati-ne", description: result.message, service_code: "RABEN_ERROR", currency: "RON", total_price: 0 }] });
    }
    const priceInBani = Math.round(result.totalPrice * 100);
    const totalPallets = result.deliveries.reduce((s, d) => s + d.pallets, 0);
    const minDays = result.zone <= 3 ? 2 : 3;
    const maxDays = result.zone <= 3 ? 4 : 6;
    let desc = totalPallets + " palet" + (totalPallets > 1 ? "i" : "") + ", " + result.totalSqm + " m2, Zona " + result.zone;
    if (result.numDeliveries > 1) desc += " (" + result.numDeliveries + " livrari)";
    return res.json({
      rates: [{
        service_name: "Livrare Raben Logistics",
        description: desc,
        service_code: "RABEN_STANDARD",
        currency: "RON",
        total_price: priceInBani,
        min_delivery_date: addBusinessDays(new Date(), minDays).toISOString().split("T")[0],
        max_delivery_date: addBusinessDays(new Date(), maxDays).toISOString().split("T")[0],
      }]
    });
  } catch (err) {
    console.error("Eroare:", err);
    return res.status(500).json({ rates: [] });
  }
});

// ============================================================
// GET /api/calculate — Calculator standalone (testare)
// ============================================================
app.get("/api/calculate", (req, res) => {
  const sqm = parseFloat(req.query.sqm);
  const postal = req.query.postal || "";
  if (!sqm || !postal) return res.status(400).json({ error: "Utilizare: /api/calculate?sqm=65&postal=010045" });
  return res.json(calculateShipping(sqm, postal));
});

// ============================================================
// POST /api/admin/update-config — Actualizare DAF/ADV
// ============================================================
app.post("/api/admin/update-config", (req, res) => {
  const adminKey = process.env.ADMIN_API_KEY || "change-me-in-production";
  if (req.body.api_key !== adminKey) return res.status(401).json({ error: "Unauthorized" });
  if (req.body.daf_percent !== undefined) CONFIG.DAF_PERCENT = parseFloat(req.body.daf_percent);
  if (req.body.adv_cost !== undefined) CONFIG.ADV_COST = parseFloat(req.body.adv_cost);
  return res.json({ success: true, config: { DAF_PERCENT: CONFIG.DAF_PERCENT, ADV_COST: CONFIG.ADV_COST } });
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "OK", service: "Granit Online Shipping v3", config: { DAF: (CONFIG.DAF_PERCENT * 100) + "%", ADV: CONFIG.ADV_COST + " RON", MAX_KG: CONFIG.MAX_KG_PER_DELIVERY } });
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
  console.log("  DAF: " + (CONFIG.DAF_PERCENT * 100) + "% | ADV: " + CONFIG.ADV_COST + " RON | Max/livrare: " + CONFIG.MAX_KG_PER_DELIVERY + " kg");
  console.log("  Test: http://localhost:" + PORT + "/api/calculate?sqm=60&postal=010045");
});

module.exports = app;
