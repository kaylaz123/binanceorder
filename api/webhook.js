import crypto from "crypto";
const BASE = "https://fapi.binance.com";          // USD-M Futures
const { BINANCE_KEY, BINANCE_SECRET, TV_TOKEN } = process.env;

// util tanda-tangan
const sign = q => crypto.createHmac("sha256", BINANCE_SECRET).update(q).digest("hex");

// hit endpoint Binance (SIGNED jika perlu)
async function binance(path, params = {}, method = "GET") {
  const qs = new URLSearchParams({ ...params, timestamp: Date.now() });
  const signature = sign(qs.toString());
  qs.append("signature", signature);

  const r = await fetch(`${BASE}${path}?${qs}`, {
    method,
    headers: { "X-MBX-APIKEY": BINANCE_KEY, "Content-Type": "application/x-www-form-urlencoded" }
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${path} → ${JSON.stringify(data)}`);
  return data;
}

// util pembulatan ke stepSize
function roundStep(qty, step) {
  const precision = Math.max(0, (step.toString().split(".")[1] || "").length);
  return (Math.floor(qty / step) * step).toFixed(precision);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  try {
    // ─── 1. BASIC AUTH ──────────────────────────────────────────────────────────
    if (req.headers["x-tv-token"] !== TV_TOKEN) throw new Error("Unauthorized");

    const { symbol, signal } = req.body || {};
    if (!symbol || !signal) throw new Error("Payload incomplete");

    const side = signal.toUpperCase();           // BUY / SELL
    if (!["BUY", "SELL"].includes(side)) throw new Error("Signal must be BUY or SELL");

    // ─── 2. CLOSE EXISTING POSITION ────────────────────────────────────────────
    const pos = await binance("/fapi/v3/positionRisk", { symbol });  // :contentReference[oaicite:0]{index=0}
    const posAmt = parseFloat(pos[0]?.positionAmt || "0");          // >0 long, <0 short

    if (posAmt !== 0) {
      await binance("/fapi/v1/order",
        {
          symbol,
          side: posAmt > 0 ? "SELL" : "BUY",     // opposite to close
          type: "MARKET",
          quantity: Math.abs(posAmt),
          reduceOnly: "true"
        },
        "POST"
      );
    }

    // ─── 3. ENSURE LEVERAGE = 1× ───────────────────────────────────────────────
    await binance("/fapi/v1/leverage", { symbol, leverage: 1 }, "POST"); // idempotent :contentReference[oaicite:1]{index=1}

    // ─── 4. HIT SIZE 99 % SALDO USDT ───────────────────────────────────────────
    const acct = await binance("/fapi/v2/account", {});               // wallet + positions
    const bal  = parseFloat(acct.totalWalletBalance);                 // USDT

    // stepSize lookup (cache 30 min via KV idealnya)
    const info = await binance("/fapi/v1/exchangeInfo", { symbol });
    const step = parseFloat(info.symbols[0].filters.find(f => f.filterType === "LOT_SIZE").stepSize);

    const mark  = parseFloat(pos[0].markPrice);                       // gunakan markPrice terbaru
    const usdtSize = bal * 0.99;
    const qty   = roundStep(usdtSize / mark, step);

    // ─── 5. NEW MARKET ORDER ───────────────────────────────────────────────────
    const order = await binance("/fapi/v1/order",
      { symbol, side, type: "MARKET", quantity: qty },
      "POST"
    );

    // ─── 6. FORWARD PAYLOAD (LOGGING) ──────────────────────────────────────────
    await fetch("https://suiusdtbot.vercel.app/api/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-origin": "executor" }, // custom header
      body: JSON.stringify(req.body)
    }).catch(() => null); // non-blocking

    return res.json({ ok: true, order });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ ok: false, error: err.message });
  }
}
