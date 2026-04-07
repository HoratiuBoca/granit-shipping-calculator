/**
 * Granit Online — Modul Calcul Cost Livrare Raben v4
 * Suport greutăți variabile per produs (30, 60, 80 kg/m²)
 * Paleți calculați separat per grup de greutate
 *
 * LOGICA:
 * 1. Produsele se grupează per greutate (kg/m²)
 * 2. Pentru fiecare grup: m² × kg/m² = kg → paleți (la 1200 kg/palet)
 * 3. Se adună toți paleții → se calculează greutatea medie per palet
 * 4. Se caută prețul în tabelul Raben
 * 5. Peste 5.000 kg total → se împarte în livrări separate de max 5t
 */

// ============================================================
// PARAMETRI EDITABILI
// ===========================================================
const CONFIG = {
      DAF_PERCENT: 0.40,
  ADV_COST: 10,
      TVA_PERCENT: 0.21,
  SQM_PER_PALLET: 40,        // doar ca fallback
  KG_PER_SQM: 30,            // doar ca fallback (default)
  MAX_KG_PER_PALLET: 1200,   // limită greutate per palet
  MAX_KG_PER_DELIVERY: 5000,
};

// ============================================================
// MAPARE COD POȘTAL → ZONĂ
// ============================================================
const POSTAL_TO_ZONE = {
  "41": 1, "40": 2,
  "30": 3, "31": 3,
  "45": 4, "42": 4, "54": 4, "55": 4,
  "43": 5,
  "32": 6, "44": 6, "51": 6,
  "33": 7, "50": 7, "52": 7, "53": 7,
  "01": 8, "02": 8, "03": 8, "04": 8, "05": 8, "06": 8, "07": 8, "08": 8, "20": 8, "24": 8,
  "92": 9, "91": 9, "80": 9, "81": 9, "10": 9,
  "14": 10, "21": 10, "61": 10, "12": 10, "23": 10,
  "11": 11, "22": 11, "60": 11, "62": 11,
  "70": 12, "82": 12, "90": 12,
  "73": 13, "71": 14, "72": 15,
};

// ============================================================
// TABELE PREȚURI RABEN (RON, fără TVA, fără DAF)
// PRICES[interval_greutate][nr_paleti] = [zona1...zona15]
// ============================================================
const PRICES = {
  "0-200": {
    1: [79.54,115.84,119.68,130.89,138.95,158.20,165.45,169.54,173.63,186.61,190.90,195.20,199.49,203.78,208.08],
    2: [158.58,230.71,238.92,262.25,285.46,319.35,329.82,333.91,338.00,359.20,363.49,367.79,372.08,376.38,380.67],
    3: [221.40,328.30,340.86,374.43,412.73,459.35,472.63,476.72,480.81,509.14,513.44,517.73,522.03,526.32,530.62],
    4: [274.99,415.85,432.79,475.66,528.94,587.18,603.02,607.11,611.20,646.05,650.34,654.64,658.93,663.23,667.52],
    5: [319.51,493.54,514.90,566.16,634.32,703.10,721.26,725.35,729.44,770.20,774.50,778.79,783.08,787.38,791.67],
    6: [355.21,561.61,587.41,646.18,729.14,807.40,827.63,831.72,835.81,881.90,886.19,890.49,894.78,899.04,903.37],
    7: [403.46,642.18,672.20,739.59,836.86,925.90,948.50,952.59,956.68,1008.81,1013.11,1017.40,1021.70,1025.99,1030.29],
    8: [448.98,719.45,753.63,829.31,940.74,1040.16,1065.05,1069.14,1073.23,1131.19,1135.48,1139.78,1144.07,1148.37,1152.66],
  },
  "201-400": {
    1: [104.49,138.70,138.70,154.12,171.64,171.64,198.59,198.59,238.33,245.91,262.72,262.72,270.61,270.61,270.61],
    2: [180.48,253.73,253.73,280.57,315.63,315.63,367.65,367.65,445.41,461.22,488.40,488.40,503.05,503.05,503.05],
    3: [238.31,367.16,367.16,405.76,458.16,458.16,534.82,534.82,649.74,673.71,711.81,711.81,733.17,733.17,733.17],
    4: [292.23,473.33,473.33,522.62,592.26,592.26,692.80,692.80,843.72,876.07,923.29,923.29,950.99,950.99,950.99],
    5: [342.39,572.41,572.41,631.35,718.11,718.11,841.77,841.77,1027.65,1068.52,1123.14,1123.14,1156.83,1156.83,1156.83],
    6: [392.34,664.60,664.60,732.16,835.92,835.92,982.00,982.00,1201.75,1251.31,1311.65,1311.65,1351.00,1351.00,1351.00],
    7: [447.75,764.00,764.00,841.48,961.71,961.71,1130.45,1130.45,1384.39,1442.02,1510.52,1510.52,1555.83,1555.83,1555.83],
    8: [500.77,860.55,860.55,947.56,1084.08,1084.08,1275.01,1275.01,1562.50,1628.15,1704.31,1704.31,1755.44,1755.44,1755.44],
  },
  "401-600": {
    1: [115.16,164.80,189.62,212.85,214.19,221.12,247.43,242.11,261.36,261.36,267.42,267.42,275.44,275.44,275.44],
    2: [210.64,294.23,338.10,377.04,391.04,394.43,437.16,444.32,478.70,478.70,486.86,486.86,501.47,501.47,501.47],
    3: [304.62,400.66,459.09,507.76,543.10,534.30,585.43,619.23,665.54,665.54,672.52,672.52,692.70,692.70,692.70],
    4: [392.62,501.39,573.50,631.11,688.26,666.72,725.39,786.45,844.04,844.04,849.58,849.58,875.07,875.07,875.07],
    5: [474.79,596.63,681.59,747.35,826.75,792.00,857.32,946.27,1014.50,1014.50,1018.35,1018.35,1048.90,1048.90,1048.90],
    6: [551.28,690.66,788.78,863.82,963.14,917.69,991.59,1103.93,1182.99,1182.99,1186.05,1186.05,1221.63,1221.63,1221.63],
    7: [633.70,790.56,902.89,988.50,1104.44,1050.88,1135.04,1266.46,1357.05,1357.05,1360.14,1360.14,1400.94,1400.94,1400.94],
    8: [713.76,886.75,1012.72,1108.41,1241.00,1179.19,1273.06,1423.66,1525.32,1525.32,1528.34,1528.34,1574.19,1574.19,1574.19],
  },
  "501-800": {
    1: [134.43,190.59,214.19,240.89,240.89,245.68,253.05,253.05,283.84,283.84,290.88,290.88,299.61,299.61,299.61],
    2: [208.97,311.51,351.48,396.17,396.17,387.29,398.90,398.90,477.41,477.41,499.66,499.66,514.65,514.65,514.65],
    3: [273.30,420.14,475.15,536.79,536.79,540.39,556.60,556.60,655.68,655.68,693.50,693.50,714.31,714.31,714.31],
    4: [336.48,527.18,596.97,674.65,674.65,663.71,683.62,683.62,830.09,830.09,884.57,884.57,911.11,911.11,911.11],
    5: [394.58,628.04,711.88,804.34,804.34,810.03,834.34,834.34,995.17,995.17,1067.62,1067.62,1099.64,1099.64,1099.64],
    6: [469.74,748.18,848.30,959.76,959.76,963.59,992.50,992.50,1188.88,1188.88,1273.30,1273.30,1311.50,1311.50,1311.50],
  },
  "801-1000": {
    1: [153.86,214.60,241.00,258.65,258.65,263.67,263.67,271.58,283.60,283.60,283.60,318.74,328.30,328.30,328.30],
    2: [228.29,336.84,379.91,408.52,408.52,416.45,416.45,428.94,430.21,430.21,430.21,483.52,498.02,498.02,498.02],
    3: [311.82,469.12,530.09,571.89,571.89,583.00,583.00,600.49,595.12,595.12,595.12,668.87,688.93,688.93,688.93],
    4: [372.97,575.31,651.07,701.93,701.93,715.56,715.56,737.02,712.82,712.82,712.82,801.14,825.18,825.18,825.18],
    5: [451.98,701.70,794.61,857.64,857.64,874.29,874.29,900.52,867.77,867.77,867.77,975.29,1004.55,1004.55,1004.55],
  },
  "1001-1200": {
    1: [169.25,225.33,253.05,253.05,271.58,271.58,285.16,285.16,315.56,315.56,315.56,337.77,347.91,347.91,347.91],
    2: [251.11,353.68,398.90,398.90,428.94,428.94,450.39,450.39,498.85,498.85,498.85,533.97,549.99,549.99,549.99],
    3: [343.00,492.58,556.60,556.60,600.49,600.49,630.51,630.51,701.70,701.70,701.70,751.09,773.62,773.62,773.62],
    4: [410.27,604.08,683.62,683.62,737.02,737.02,773.88,773.88,863.73,863.73,863.73,924.53,952.26,952.26,952.26],
    5: [497.17,736.78,834.34,834.34,900.52,900.52,945.54,945.54,1056.99,1056.99,1056.99,1131.38,1165.33,1165.33,1165.33],
  },
};

// ============================================================
// FUNCȚII DE CALCUL
// ============================================================

function getZone(postalCode) {
  if (!postalCode || postalCode.length < 2) return null;
  return POSTAL_TO_ZONE[postalCode.substring(0, 2)] || null;
}

function getWeightRange(weightKg) {
  if (weightKg <= 200) return "0-200";
  if (weightKg <= 400) return "201-400";
  if (weightKg <= 600) return "401-600";
  if (weightKg <= 800) return "501-800";
  if (weightKg <= 1000) return "801-1000";
  return "1001-1200";
}

function lookupPrice(weightRange, pallets, zone) {
  const price = PRICES[weightRange]?.[pallets]?.[zone - 1];
  return price !== undefined ? price : null;
}

/**
 * Calculează paleți pentru un grup de material cu o anumită greutate/m²
 * @param {number} sqm - m² totali pentru acest grup
 * @param {number} kgPerSqm - greutatea per m² a materialului
 * @returns {object} - { sqm, pallets, totalKg, kgPerSqm }
 */
function calculatePalletsForGroup(sqm, kgPerSqm) {
  const totalKg = sqm * kgPerSqm;
  const sqmPerPallet = Math.floor(CONFIG.MAX_KG_PER_PALLET / kgPerSqm);
  const pallets = Math.ceil(sqm / sqmPerPallet);
  return { sqm: round2(sqm), pallets, totalKg: round2(totalKg), kgPerSqm, sqmPerPallet };
}

/**
 * Calculează costul unei livrări date de un anumit nr de paleți + kg totali
 */
function calculateSingleDelivery(totalPallets, totalKg, zone) {
  if (totalPallets <= 0 || totalKg <= 0) return null;
  const avgKg = totalKg / totalPallets;
  const weightRange = getWeightRange(avgKg);

  // Limita din tabel este 8 paleți max
  const lookupPallets = Math.min(totalPallets, 8);
  const price = lookupPrice(weightRange, lookupPallets, zone);
  if (price === null) return null;

  // Dacă avem mai mult de 8 paleți, scalăm liniar (preț per palet × nr paleți)
  let finalPrice = price;
  if (totalPallets > 8) {
    const pricePerPallet = price / 8;
    finalPrice = pricePerPallet * totalPallets;
  }

  return {
    pallets: totalPallets,
    totalKg: round2(totalKg),
    avgKg: round2(avgKg),
    weightRange,
    basePrice: round2(finalPrice)
  };
}

/**
 * Calculare transport cu greutăți variabile per produs
 *
 * @param {Array} materialGroups - array de {sqm, kgPerSqm} grupate per greutate
 *   ex: [{sqm: 60, kgPerSqm: 30}, {sqm: 20, kgPerSqm: 60}]
 * @param {string} postalCode - codul poștal
 * @param {object} config - override config (opțional)
 *
 * Rămâne backward-compatible: dacă se apelează cu (totalSqm, postalCode)
 * funcționează ca înainte cu greutatea default din CONFIG
 */
function calculateShipping(materialGroupsOrSqm, postalCode, config = {}) {
  const cfg = { ...CONFIG, ...config };

  // Backward compatibility: dacă primul arg e număr, îl convertim
  let materialGroups;
  if (typeof materialGroupsOrSqm === 'number') {
    materialGroups = [{ sqm: materialGroupsOrSqm, kgPerSqm: cfg.KG_PER_SQM }];
  } else {
    materialGroups = materialGroupsOrSqm;
  }

  // Validare
  const totalSqm = materialGroups.reduce((sum, g) => sum + g.sqm, 0);
  if (!totalSqm || totalSqm <= 0) {
    return { success: false, error: "INVALID_QUANTITY", message: "Cantitatea trebuie sa fie mai mare decat 0." };
  }

  const zone = getZone(postalCode);
  if (!zone) {
    return { success: false, error: "UNKNOWN_ZONE", message: "Nu putem calcula automat costul de livrare pentru acest cod postal. Contactati-ne." };
  }

  // Calculează paleți per grup de material (separat!)
  let totalPallets = 0;
  let totalKg = 0;
  const groupDetails = [];

  for (const group of materialGroups) {
    const result = calculatePalletsForGroup(group.sqm, group.kgPerSqm);
    totalPallets += result.pallets;
    totalKg += result.totalKg;
    groupDetails.push(result);
  }

  // Splitting la 5 tone
  const numDeliveries = Math.ceil(totalKg / cfg.MAX_KG_PER_DELIVERY);
  const deliveries = [];

  if (numDeliveries === 1) {
    // O singură livrare
    const delivery = calculateSingleDelivery(totalPallets, totalKg, zone);
    if (!delivery) {
      return { success: false, error: "PRICE_NOT_FOUND", message: "Eroare la calcularea pretului. Contactati-ne." };
    }
    deliveries.push(delivery);
  } else {
    // Îímpărțim proporțional pe livrări
    const palletsPerDelivery = Math.ceil(totalPallets / numDeliveries);
    const kgPerDelivery = totalKg / numDeliveries;
    let remainingPallets = totalPallets;
    let remainingKg = totalKg;

    for (let i = 0; i < numDeliveries; i++) {
      const isLast = (i === numDeliveries - 1);
      const delPallets = isLast ? remainingPallets : Math.min(palletsPerDelivery, remainingPallets);
      const delKg = isLast ? remainingKg : Math.min(kgPerDelivery, remainingKg);

      const delivery = calculateSingleDelivery(delPallets, delKg, zone);
      if (!delivery) {
        return { success: false, error: "PRICE_NOT_FOUND", message: "Eroare la calcularea pretului. Contactati-ne." };
      }
      deliveries.push(delivery);
      remainingPallets -= delPallets;
      remainingKg -= delKg;
    }
  }

  const totalBasePrice = deliveries.reduce((sum, d) => sum + d.basePrice, 0);
  const dafAmount = totalBasePrice * cfg.DAF_PERCENT;
  const advAmount = cfg.ADV_COST * numDeliveries;
  const subtotal = totalBasePrice + dafAmount + advAmount;
  const tvaAmount = subtotal * cfg.TVA_PERCENT;
  const totalPrice = subtotal + tvaAmount;

  return {
    success: true, totalSqm: round2(totalSqm), postalCode, zone,
    totalKg: round2(totalKg), totalPallets,
    materialGroups: groupDetails,
    numDeliveries, deliveries, totalBasePrice: round2(totalBasePrice),
    dafPercent: cfg.DAF_PERCENT * 100, dafAmount: round2(dafAmount),
    advAmount: round2(advAmount), subtotal: round2(subtotal),
    tvaAmount: round2(tvaAmount), totalPrice: round2(totalPrice),
    displayPrice: round2(totalPrice) + " RON (cu TVA)", currency: "RON",
  };
}

function round2(num) { return Math.round(num * 100) / 100; }

module.exports = { calculateShipping, calculatePalletsForGroup, calculateSingleDelivery, getZone, getWeightRange, lookupPrice, CONFIG, POSTAL_TO_ZONE, PRICES };
