// Daman API: Vercel serverless function + Upstash Redis (REST, no dependencies)
// finds the Upstash vars whatever their prefix (KV_, STORAGE_KV_, UPSTASH_REDIS_ ...)
function pick(re) { const k = Object.keys(process.env).find((n) => re.test(n) && process.env[n]); return k ? process.env[k] : undefined; }
const URL_ = pick(/REST_API_URL$|REST_URL$/);
const TOKEN = pick(/REST_API_TOKEN$|REST_TOKEN$/);
const H = "daman:deals", S = "daman:pay";

async function redis(cmd) {
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const str = (v, n) => String(v == null ? "" : v).slice(0, n);

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") {
    let ping = "skipped";
    if (URL_ && TOKEN) { try { ping = await redis(["PING"]); } catch (e) { ping = "ERROR: " + e.message; } }
    return res.json({ ok: true, url: !!URL_, token: !!TOKEN, admin: !!process.env.ADMIN_PASSWORD, ping });
  }
  if (req.method !== "POST") return res.status(405).json({ code: "method" });
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const pw = process.env.ADMIN_PASSWORD;
  const admin = !!pw && req.headers["x-admin"] === pw;
  const fail = (code, status) => res.status(status || 400).json({ code });
  if (!URL_ || !TOKEN) return fail("config", 500);
  try {
    switch (b.op) {
      case "auth":
        return admin ? res.json({ ok: true }) : fail("forbidden", 403);

      case "get": {
        const v = await redis(["HGET", H, str(b.code, 12)]);
        return res.json({ data: v ? JSON.parse(v) : null });
      }

      case "list": {
        if (!b.field && !admin) return fail("forbidden", 403);
        const a = await redis(["HGETALL", H]);
        let l = [];
        for (let i = 1; i < a.length; i += 2) l.push(JSON.parse(a[i]));
        if (b.field) {
          if (!["createdBy", "counterparty"].includes(b.field) || !b.uid) return res.json({ deals: [] });
          l = l.filter((d) => d[b.field] === b.uid);
        }
        l.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
        return res.json({ deals: l.slice(0, 300) });
      }

      case "create": {
        const d = b.data || {}, code = str(b.code, 12);
        const price = Number(d.price);
        if (!/^DM-\d{5}$/.test(code) || !d.item || !(price > 0) || price > 1000000) return fail("invalid_argument");
        const clean = {
          code, role: d.role === "buyer" ? "buyer" : "seller", item: str(d.item, 200), price,
          fee: ["buyer", "seller", "split"].includes(d.fee) ? d.fee : "buyer", contact: str(d.contact, 200),
          stage: 1, state: "open", createdBy: str(d.createdBy, 60), createdAt: Date.now(), updatedAt: Date.now(),
          log: [{ t: "تنشأات الصفقة", at: Date.now() }],
        };
        const n = await redis(["HSETNX", H, code, JSON.stringify(clean)]);
        return n ? res.json({ ok: true }) : fail("exists", 409);
      }

      case "patch": {
        const code = str(b.code, 12), p = b.patch || {};
        if (JSON.stringify(p).length > 6000) return fail("invalid_argument");
        const v = await redis(["HGET", H, code]);
        if (!v) return fail("not_found", 404);
        const d = JSON.parse(v);
        // only the owner (admin) may confirm payment, release money, refund or rule
        const priv = p.ruling || p.payRejected || p.stage === 2 || p.stage === 5 || p.state === "refunded";
        if (priv && !admin) return fail("forbidden", 403);
        const ok = ["stage", "state", "payClaim", "payRejected", "payout", "disputes", "delivery", "ruling", "log", "counterparty"];
        for (const k of Object.keys(p)) {
          if (!ok.includes(k)) continue;
          if (k === "disputes") d.disputes = Object.assign({}, d.disputes, p.disputes);
          else if (k === "counterparty") { if (!d.counterparty && p.counterparty !== d.createdBy) d.counterparty = str(p.counterparty, 60); }
          else d[k] = p[k];
        }
        d.updatedAt = Date.now();
        await redis(["HSET", H, code, JSON.stringify(d)]);
        return res.json({ ok: true });
      }

      case "getSettings": {
        const v = await redis(["GET", S]);
        return res.json({ data: v ? JSON.parse(v) : null });
      }

      case "setSettings": {
        if (!admin) return fail("forbidden", 403);
        const d = b.data || {};
        const methods = (Array.isArray(d.methods) ? d.methods : []).slice(0, 10)
          .map((m) => ({ bank: str(m.bank, 60), holder: str(m.holder, 80), number: str(m.number, 60) }));
        await redis(["SET", S, JSON.stringify({ methods, support: str(d.support, 20).replace(/\D/g, "") })]);
        return res.json({ ok: true });
      }
    }
    return fail("invalid_argument");
  } catch (e) {
    console.error(e);
    return fail("redis", 500);
  }
};
