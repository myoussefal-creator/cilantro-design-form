// Cilantro Store Requirements Form - storage API (Vercel serverless function).
//
// Storage: Upstash Redis REST (added from Vercel -> Storage -> Upstash for Redis).
// Works with either set of environment variable names:
//   KV_REST_API_URL / KV_REST_API_TOKEN        (Vercel KV naming)
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//
// Endpoints (all on /api/form):
//   GET  ?ping=1                                  -> {ok:true, storage:"redis"|"none"}
//   GET  ?list=1              (header x-pin: PM)  -> every branch + progress
//   POST {action:"create", name, values}  (x-pin) -> new branch {id, key}
//   GET  ?b=<id>&k=<key>                          -> branch + all answers (departments)
//   POST {action:"save", b, k, d, values, by, submit}
//   POST {action:"branch", b, k, values}  (x-pin)  -> update branch details
//   POST {action:"delete", b}             (x-pin)

const crypto = require("crypto");

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const PIN = process.env.ADMIN_PIN || "2468";
const SECRET = process.env.FORM_SECRET || TOKEN || "cilantro-form-secret";
const DEPTS = ["branch", "leasing", "eng", "mkt", "ops", "qa", "fm", "it", "legal"];

async function redis(cmd) {
  if (!URL_ || !TOKEN) throw new Error("Storage is not connected yet (no Upstash/KV environment variables).");
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `Storage error ${r.status}`);
  return j.result;
}

const getJSON = async (key) => { const v = await redis(["GET", key]); try { return v ? JSON.parse(v) : null; } catch { return null; } };
const setJSON = (key, val) => redis(["SET", key, JSON.stringify(val)]);

function keyFor(id) {
  return crypto.createHmac("sha256", SECRET).update(String(id)).digest("hex").slice(0, 12);
}
function okKey(id, k) {
  const want = keyFor(id);
  return typeof k === "string" && k.length === want.length &&
    crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want));
}
function isPm(req) {
  const p = req.headers["x-pin"] || (req.query && req.query.pin) || "";
  return String(p) === PIN;
}
function clean(values) {
  const out = {};
  for (const [k, v] of Object.entries(values && typeof values === "object" ? values : {})) {
    if (!/^[A-Za-z0-9_]{1,60}$/.test(k)) continue;
    if (typeof v === "boolean") out[k] = v;
    else if (v == null) out[k] = "";
    else out[k] = String(v).slice(0, 4000);
  }
  return out;
}
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}
async function answersFor(id) {
  const out = {};
  await Promise.all(DEPTS.map(async (d) => { out[d] = await getJSON(`ans:${id}:${d}`); }));
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  const send = (code, body) => res.status(code).json(body);

  try {
    if (req.method === "GET" && q.ping) {
      return send(200, { ok: true, storage: URL_ && TOKEN ? "redis" : "none" });
    }

    if (req.method === "GET" && q.list) {
      if (!isPm(req)) return send(401, { error: "Wrong PIN" });
      const ids = (await redis(["SMEMBERS", "branches"])) || [];
      const branches = [];
      for (const id of ids) {
        const br = await getJSON(`branch:${id}`);
        if (!br) continue;
        const ans = await answersFor(id);
        const progress = {};
        for (const d of DEPTS) if (ans[d]) progress[d] = { submittedAt: ans[d].submittedAt || null, updatedAt: ans[d].updatedAt || null, by: ans[d].by || "" };
        branches.push({ ...br, key: keyFor(id), progress });
      }
      branches.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return send(200, { branches });
    }

    if (req.method === "GET" && q.b) {
      const br = await getJSON(`branch:${q.b}`);
      if (!br) return send(404, { error: "This branch was not found. Ask the PM for a new link." });
      if (!isPm(req) && !okKey(q.b, q.k)) return send(403, { error: "This link is not valid. Ask the PM for the correct link." });
      return send(200, { branch: br, answers: await answersFor(q.b) });
    }

    if (req.method === "POST") {
      const p = await readBody(req);

      if (p.action === "create") {
        if (!isPm(req)) return send(401, { error: "Wrong PIN" });
        const name = String(p.name || "").trim().slice(0, 120);
        if (!name) return send(400, { error: "Branch name is required" });
        const id = crypto.randomUUID().slice(0, 8);
        const values = clean(p.values); values.br_name = name;
        const branch = { id, name, values, createdAt: Date.now() };
        await setJSON(`branch:${id}`, branch);
        await redis(["SADD", "branches", id]);
        return send(201, { branch: { ...branch, key: keyFor(id), progress: {} } });
      }

      if (p.action === "branch") {
        if (!isPm(req)) return send(401, { error: "Wrong PIN" });
        const br = await getJSON(`branch:${p.b}`);
        if (!br) return send(404, { error: "Branch not found" });
        br.values = { ...(br.values || {}), ...clean(p.values) };
        if (br.values.br_name) br.name = String(br.values.br_name).slice(0, 120);
        br.updatedAt = Date.now();
        await setJSON(`branch:${p.b}`, br);
        return send(200, { branch: { ...br, key: keyFor(p.b) } });
      }

      if (p.action === "save") {
        if (!DEPTS.includes(p.d) || p.d === "branch") return send(400, { error: "Unknown department" });
        const br = await getJSON(`branch:${p.b}`);
        if (!br) return send(404, { error: "Branch not found" });
        if (!isPm(req) && !okKey(p.b, p.k)) return send(403, { error: "This link is not valid." });
        const prev = (await getJSON(`ans:${p.b}:${p.d}`)) || { branchId: p.b, dept: p.d, values: {}, submittedAt: null, by: "" };
        const now = Date.now();
        const next = { ...prev, branchId: p.b, dept: p.d, values: { ...(prev.values || {}), ...clean(p.values) }, updatedAt: now };
        if (typeof p.by === "string") next.by = p.by.slice(0, 120);
        if (p.submit) next.submittedAt = now;
        await setJSON(`ans:${p.b}:${p.d}`, next);
        return send(200, { ok: true, updatedAt: now, submittedAt: next.submittedAt });
      }

      if (p.action === "delete") {
        if (!isPm(req)) return send(401, { error: "Wrong PIN" });
        await redis(["DEL", `branch:${p.b}`]);
        await redis(["SREM", "branches", String(p.b)]);
        for (const d of DEPTS) await redis(["DEL", `ans:${p.b}:${d}`]);
        return send(200, { ok: true });
      }

      return send(400, { error: "Unknown action" });
    }

    return send(405, { error: "Method not allowed" });
  } catch (err) {
    return send(500, { error: err.message || "Server error" });
  }
};
