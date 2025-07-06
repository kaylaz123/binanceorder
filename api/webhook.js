/* eslint-disable no-console */
import crypto from "crypto";

const BASE = "https://fapi.binance.com";                  // USD-M Futures
const CACHED_INFO = new Map();                            // in-memory cache

const { BINANCE_KEY, BINANCE_SECRET, LOG_WEBHOOK_URL } = process.env;

// ─────────────────────────────── util Binance
const hmac = q => crypto.createHmac("sha256", BINANCE_SECRET).update(q).digest("hex");

async function binance(path, params = {}, method = "GET") {
  const qs = new URLSearchParams({ ...params, timestamp: Date.now() });
  qs.append("signature", hmac(qs.toString()));

  const res = await fetch(`${BASE}${path}?${qs}`, {
    method,
    headers: {
      "X-MBX-APIKEY": BINANCE_KEY,
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} → ${JSON.stringify(data)}`);
  return data;
}

function roundStep(qty, step) {
  const prec = (step.toString().split(".")[1] || "").length;
  return (Math.floor(qty / step) * step).toFixed(prec);
}

async function getExchangeInfo(symbol) {
  if (CACHED_INFO.has(symbol)) return CACHED_INFO.get(symbol);

  const info = await binance("/fapi/v1/exchangeInfo", { symbol });
  const filt = info.symbols[0].filters;
  const stepSize = parseFloat(filt.find(f => f.filterType === "LOT_SIZE").stepSize);
  const minQty   = parseFloat(filt.find(f => f.filterType === "LOT_SIZE").minQty);

  const obj = { stepSize, minQty };
  CACHED_INFO.set(symbol, obj);
  return obj;
}

async function recomputeQty(symbol) {
  const acct = await binance("/fapi/v2/account");
  const bal  = parseFloat(acct.totalWalletBalance);

  const pos  = await binance("/fapi/v3/positionRisk", { symbol });
  const mark = parseFloat(pos[0].markPrice);

  const { stepSize } = await getExchangeInfo(symbol);
  const qty = roundStep((bal * 0.998) / mark, stepSize);

  return { qtyNew: qty, mark };
}

// ─────────────────────────────── logging
async function logEvent(label, payload) {
  const entry = { ts: new Date().toISOString(), label, ...payload };
  console.log(JSON.stringify(entry));
  if (LOG_WEBHOOK_URL) {
    fetch(LOG_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry)
    }).catch(() => {});
  }
}

// ─────────────────────────────── safeOrder (retry 3×)
async function safeOrder(params, maxTry = 3) {
  for (let attempt = 1; attempt <= maxTry; attempt++) {
    try {
      await logEvent("request", { attempt, params });
      const res = await binance("/fapi/v1/order", params, "POST");
      await logEvent("response", { attempt, res });
      return res;                                 // sukses
    } catch (err) {
      const code = err.message.match(/"code":\s*(-?\d+)/)?.[1] ?? "unknown";
      await logEvent("error", { attempt, code, msg: err.message });

      // penanganan adaptif
      if (code === "-2019") {                     // saldo kurang
        const { qtyNew } = await recomputeQty(params.symbol);
        params.quantity = qtyNew;
      } else if (code === "-1013" || code === "-1111") { // precision
        const { stepSize } = await getExchangeInfo(params.symbol);
        params.quantity = roundStep(params.quantity, stepSize);
      } else if (code === "-2021") {              // LIMIT rejected
        Object.assign(params, { type: "MARKET" });
        delete params.price;
        delete params.timeInForce;
      } else if (code === "-429" || code === "-418") {   // rate limit
        await new Promise(r => setTimeout(r, 60_000));
      }

      if (attempt < maxTry) {
        await new Promise(r => setTimeout(r, 2 ** attempt * 100));
        continue;
      }
      throw err;                                 // gagal total
    }
  }
}

// ─────────────────────────────── handler utama
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const { symbol, signal } = req.body || {};
    if (!symbol || !signal) throw new Error("Payload incomplete");

    const side = signal.toUpperCase();
    if (!["BUY", "SELL"].includes(side)) throw new Error("Signal must be BUY or SELL");

    // 1️⃣ Close posisi aktif (jika ada)
    const pos = await binance("/fapi/v3/positionRisk", { symbol });
    const posAmt = parseFloat(pos[0]?.positionAmt || "0");
    if (posAmt !== 0) {
      await safeOrder({
        symbol,
        side: posAmt > 0 ? "SELL" : "BUY",
        type: "MARKET",
        quantity: Math.abs(posAmt),
        reduceOnly: "true"
      });
    }

    // 2️⃣ Set leverage 1×
    await binance("/fapi/v1/leverage", { symbol, leverage: 1 }, "POST");

    // 3️⃣ Hitung quantity 99 % saldo
    const { qtyNew } = await recomputeQty(symbol);

    // 4️⃣ Order baru dengan retry
    const order = await safeOrder({
      symbol,
      side,
      type: "MARKET",
      quantity: qtyNew
    });

    // 5️⃣ Forward payload ke bot logging (non-blocking)
    fetch("https://suiusdtbot.vercel.app/api/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-origin": "executor" },
      body: JSON.stringify(req.body)
    }).catch(() => {});

    return res.json({ ok: true, order });
  } catch (err) {
    await logEvent("fatal", { msg: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
}
