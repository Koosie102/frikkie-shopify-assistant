import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import nodemailer from "nodemailer";
import bodyParser from "body-parser";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(cors({ origin: "*", credentials: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Accept"] }));

const client = new Anthropic();

// ============================================================
// DATABASE
// ============================================================
const DATABASE_PATH = process.env.DATABASE_PATH || "./frikkie.db";
const db = new Database(DATABASE_PATH);
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    order_number TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tokens_used INTEGER,
    cost REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
  );

  CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    reason TEXT,
    email_sent BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

try { db.prepare("SELECT name FROM conversations LIMIT 1").get(); }
catch { try { db.exec("ALTER TABLE conversations ADD COLUMN name TEXT"); } catch {} }

const DEFAULT_AVATAR = "https://cdn.shopify.com/s/files/1/0539/2878/8145/files/frikkie.png?v=1779277557";
function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
if (getSetting("avatar_url") === null) setSetting("avatar_url", DEFAULT_AVATAR);
if (getSetting("greeting") === null) setSetting("greeting", "Howzit! I'm Frikkie. Need help finding something or have questions about 4x4 lighting? Fire away!");

// ============================================================
// SHOPIFY CATALOG (Client Credentials Grant)
// ============================================================
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || "";
const SHOP_DOMAIN = SHOPIFY_STORE.includes(".myshopify.com") ? SHOPIFY_STORE : `${SHOPIFY_STORE}.myshopify.com`;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || "";
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || "";
const STORE_URL = process.env.STORE_URL || `https://${SHOP_DOMAIN}`;
const API_VERSION = "2024-10";

let SHOPIFY_TOKEN_CACHE = null;
let SHOPIFY_TOKEN_EXPIRES_AT = 0;

async function getShopifyToken() {
  if (SHOPIFY_TOKEN_CACHE && Date.now() < SHOPIFY_TOKEN_EXPIRES_AT - 60000) return SHOPIFY_TOKEN_CACHE;
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !SHOP_DOMAIN) {
    throw new Error("Missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET / SHOPIFY_STORE");
  }
  const resp = await fetch(`https://${SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!resp.ok) throw new Error(`Token request failed: ${resp.status} ${await resp.text()}`);
  const { access_token, expires_in } = await resp.json();
  SHOPIFY_TOKEN_CACHE = access_token;
  SHOPIFY_TOKEN_EXPIRES_AT = Date.now() + (expires_in || 86399) * 1000;
  console.log("Got fresh Shopify token (expires in", expires_in, "s)");
  return SHOPIFY_TOKEN_CACHE;
}

let PRODUCT_CATALOG = [];
let BRANDS = [];
let PRODUCT_TYPES = [];
let CATALOG_LOADED_AT = null;

function stripHtml(s) {
  return (s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchAllProducts() {
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !SHOPIFY_STORE) {
    console.log("Shopify not configured - set SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE.");
    return;
  }
  let token;
  try { token = await getShopifyToken(); }
  catch (e) { console.error("Could not get Shopify token:", e.message); return; }

  const products = [];
  let url = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/products.json?limit=250&status=active`;
  try {
    while (url) {
      const resp = await fetch(url, {
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      });
      if (!resp.ok) { console.error("Shopify fetch failed:", resp.status, await resp.text()); break; }
      const data = await resp.json();
      for (const p of data.products || []) {
        const prices = (p.variants || []).map((v) => parseFloat(v.price)).filter((n) => !isNaN(n));
        const minPrice = prices.length ? Math.min(...prices) : null;
        products.push({
          title: p.title,
          vendor: p.vendor || "",
          type: p.product_type || "",
          tags: p.tags || "",
          handle: p.handle,
          url: `${STORE_URL}/products/${p.handle}`,
          price: minPrice,
          description: stripHtml(p.body_html).slice(0, 300),
        });
      }
      const link = resp.headers.get("link") || resp.headers.get("Link");
      const next = link && link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    PRODUCT_CATALOG = products;
    BRANDS = [...new Set(products.map((p) => p.vendor).filter(Boolean))].sort();
    PRODUCT_TYPES = [...new Set(products.map((p) => p.type).filter(Boolean))].sort();
    CATALOG_LOADED_AT = new Date().toISOString();
    console.log(`Loaded ${products.length} products | ${BRANDS.length} brands: ${BRANDS.join(", ")}`);
  } catch (err) {
    console.error("Catalog load error:", err.message);
  }
}

function findRelevantProducts(message, limit = 25) {
  if (!PRODUCT_CATALOG.length) return [];
  const words = (message || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3);
  if (!words.length) return PRODUCT_CATALOG.slice(0, limit);
  const scored = PRODUCT_CATALOG.map((p) => {
    const hay = `${p.title} ${p.vendor} ${p.type} ${p.tags} ${p.description}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (hay.includes(w)) score += 1;
      if (p.title.toLowerCase().includes(w)) score += 2;
      if (p.vendor.toLowerCase().includes(w)) score += 3;
    }
    return { p, score };
  });
  const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  return (hits.length ? hits : scored).slice(0, limit).map((s) => s.p);
}

function buildCatalogContext(message) {
  if (!PRODUCT_CATALOG.length) {
    return "\n\n(Product catalog is not loaded right now - answer generally and suggest the customer browse the store.)";
  }
  const relevant = findRelevantProducts(message);
  const lines = relevant.map((p) => {
    const price = p.price != null ? `R${p.price.toLocaleString("en-ZA")}` : "see store";
    return `- ${p.title} [${p.vendor || "n/a"}] - ${price} - ${p.url}`;
  });
  return `

=== STORE KNOWLEDGE (use ONLY this for product facts) ===
Brands we stock: ${BRANDS.join(", ")}
Product categories: ${PRODUCT_TYPES.join(", ")}

Products relevant to this question:
${lines.join("\n")}

Rules:
- Only claim we sell something if it appears above or matches a brand/category listed.
- When you recommend a product, include its link.
- If you're not sure we stock it, say so honestly and offer to check or escalate.
=== END STORE KNOWLEDGE ===`;
}

// ============================================================
// EMAIL
// ============================================================
const emailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASSWORD },
});

const COST_PER_1K_INPUT = 0.003;
const COST_PER_1K_OUTPUT = 0.015;
function calculateCost(i, o) { return (i / 1000) * COST_PER_1K_INPUT + (o / 1000) * COST_PER_1K_OUTPUT; }

const FRIKKIE_SYSTEM = `You are Frikkie, a friendly South African 4x4 lighting expert for 4x4 Factory SA.

**Keep it SHORT - 2-3 sentences max!**
- Be direct and helpful, use South African expressions naturally.
- Use the STORE KNOWLEDGE section below for all product facts - it's your single source of truth about what the store sells.
- When you mention a product, include its store link so the customer can click through.
- Never invent products, prices, or brands. If something isn't in the store knowledge, say you're not certain and offer to check.
- Early on, in a natural friendly way, ask the customer's first name so you can chat properly.
- If they want a quote, a stock check, or someone to follow up with them, ask for their email address so the team can get back to them.`;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const NAME_RES = [
  /\bmy name is ([a-z][a-z'\-]+)/i,
  /\bi am ([a-z][a-z'\-]+)/i,
  /\bi'm ([a-z][a-z'\-]+)/i,
  /\bit'?s ([a-z][a-z'\-]+)\b/i,
  /\bthis is ([a-z][a-z'\-]+)/i,
];
function extractLead(text) {
  const out = {};
  const em = (text || "").match(EMAIL_RE);
  if (em) out.email = em[0];
  for (const re of NAME_RES) {
    const m = (text || "").match(re);
    if (m) { out.name = m[1][0].toUpperCase() + m[1].slice(1); break; }
  }
  return out;
}

// ============================================================
// PUBLIC ENDPOINTS
// ============================================================
app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    version: "3.0.0",
    catalog: PRODUCT_CATALOG.length,
    brands: BRANDS,
    productTypes: PRODUCT_TYPES,
    loadedAt: CATALOG_LOADED_AT,
    shopifyConfigured: !!(SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET && SHOPIFY_STORE),
    hasToken: !!SHOPIFY_TOKEN_CACHE,
    uptimeSeconds: Math.floor(process.uptime()),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", catalog: PRODUCT_CATALOG.length, brands: BRANDS, hasToken: !!SHOPIFY_TOKEN_CACHE });
});

app.get("/api/widget-config", (req, res) => {
  res.json({ avatarUrl: getSetting("avatar_url", DEFAULT_AVATAR), greeting: getSetting("greeting", "") });
});

// ============================================================
// CHAT
// ============================================================
app.post("/api/chat", async (req, res) => {
  try {
    const { message, conversationId, email, orderNumber } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });

    let convoId = conversationId;
    const ts0 = new Date().toISOString();
    let exists = false;
    if (convoId) exists = !!db.prepare("SELECT id FROM conversations WHERE id = ?").get(convoId);
    if (!convoId || !exists) {
      if (!convoId) convoId = uuidv4();
      db.prepare(
        "INSERT OR IGNORE INTO conversations (id, email, order_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run(convoId, email || "guest@example.com", orderNumber || "", ts0, ts0);
    }

    const lead = extractLead(message);
    if (lead.email) db.prepare("UPDATE conversations SET email = ? WHERE id = ?").run(lead.email, convoId);
    if (lead.name) db.prepare("UPDATE conversations SET name = ? WHERE id = ?").run(lead.name, convoId);

    const history = db.prepare(
      "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 10"
    ).all(convoId).reverse().map((m) => ({ role: m.role, content: m.content }));
    const messages = [...history, { role: "user", content: message }];

    const systemPrompt = FRIKKIE_SYSTEM + buildCatalogContext(message);

    const response = await client.messages.create({
      model: "claude-opus-4-1",
      max_tokens: 500,
      system: systemPrompt,
      messages,
    });

    const assistantMessage = response.content[0].type === "text" ? response.content[0].text : "";
    const cost = calculateCost(response.usage.input_tokens, response.usage.output_tokens);
    const ts = new Date().toISOString();

    db.prepare("INSERT INTO messages (id, conversation_id, role, content, tokens_used, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(uuidv4(), convoId, "user", message, response.usage.input_tokens, cost, ts);
    db.prepare("INSERT INTO messages (id, conversation_id, role, content, tokens_used, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(uuidv4(), convoId, "assistant", assistantMessage, response.usage.output_tokens, cost, ts);
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(ts, convoId);

    res.json({ conversationId: convoId, message: assistantMessage, cost });
  } catch (error) {
    console.error("Chat error:", error.message);
    res.status(500).json({ error: error.message || "Server error" });
  }
});

// ============================================================
// ADMIN API
// ============================================================
app.get("/api/admin/stats", (req, res) => {
  try {
    const c = db.prepare("SELECT COUNT(*) as count FROM conversations").get();
    const m = db.prepare("SELECT COUNT(*) as count FROM messages").get();
    const um = db.prepare("SELECT COUNT(*) as count FROM messages WHERE role='user'").get();
    const t = db.prepare("SELECT SUM(cost) as total FROM messages").get();
    const leads = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE email IS NOT NULL AND email != '' AND email != 'guest@example.com'").get();
    const esc = db.prepare("SELECT COUNT(*) as count FROM escalations").get();
    const today = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE date(created_at) = date('now')").get();
    res.json({
      conversations: c.count || 0,
      messages: m.count || 0,
      questionsAnswered: um.count || 0,
      totalCost: Number((t.total || 0).toFixed(4)),
      leads: leads.count || 0,
      escalations: esc.count || 0,
      conversationsToday: today.count || 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/conversations", (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    let rows;
    if (q) {
      const like = `%${q}%`;
      rows = db.prepare(`
        SELECT c.id, c.name, c.email, c.order_number, c.created_at, c.updated_at, COUNT(m.id) as messages
        FROM conversations c LEFT JOIN messages m ON c.id = m.conversation_id
        WHERE c.name LIKE ? OR c.email LIKE ? OR c.id IN (SELECT conversation_id FROM messages WHERE content LIKE ?)
        GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 100
      `).all(like, like, like);
    } else {
      rows = db.prepare(`
        SELECT c.id, c.name, c.email, c.order_number, c.created_at, c.updated_at, COUNT(m.id) as messages
        FROM conversations c LEFT JOIN messages m ON c.id = m.conversation_id
        GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 100
      `).all();
    }
    res.json({ conversations: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/conversation/:id", (req, res) => {
  try {
    const convo = db.prepare("SELECT * FROM conversations WHERE id = ?").get(req.params.id);
    if (!convo) return res.status(404).json({ error: "Not found" });
    const messages = db.prepare("SELECT role, content, created_at, cost FROM messages WHERE conversation_id = ? ORDER BY created_at").all(req.params.id);
    res.json({ conversation: convo, messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/customers", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.id, c.name, c.email, c.created_at, c.updated_at, COUNT(m.id) as messages
      FROM conversations c LEFT JOIN messages m ON c.id = m.conversation_id
      WHERE c.email IS NOT NULL AND c.email != '' AND c.email != 'guest@example.com'
      GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 200
    `).all();
    res.json({ customers: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/customers.csv", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.name, c.email, c.created_at, c.updated_at, COUNT(m.id) as messages
      FROM conversations c LEFT JOIN messages m ON c.id = m.conversation_id
      WHERE c.email IS NOT NULL AND c.email != '' AND c.email != 'guest@example.com'
      GROUP BY c.id ORDER BY c.updated_at DESC
    `).all();
    const esc = (s) => `"${(s == null ? "" : String(s)).replace(/"/g, '""')}"`;
    const header = "Name,Email,First seen,Last seen,Messages\n";
    const body = rows.map((r) => [esc(r.name), esc(r.email), esc(r.created_at), esc(r.updated_at), r.messages].join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="frikkie-customers.csv"');
    res.send(header + body);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/escalations", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT e.id, e.reason, e.created_at, c.name, c.email
      FROM escalations e LEFT JOIN conversations c ON e.conversation_id = c.id
      ORDER BY e.created_at DESC LIMIT 100
    `).all();
    res.json({ escalations: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/settings", (req, res) => {
  res.json({ avatarUrl: getSetting("avatar_url", DEFAULT_AVATAR), greeting: getSetting("greeting", "") });
});
app.post("/api/admin/settings", (req, res) => {
  try {
    const { avatarUrl, greeting } = req.body;
    if (typeof avatarUrl === "string" && avatarUrl.trim()) setSetting("avatar_url", avatarUrl.trim());
    if (typeof greeting === "string" && greeting.trim()) setSetting("greeting", greeting.trim());
    res.json({ ok: true, avatarUrl: getSetting("avatar_url"), greeting: getSetting("greeting") });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/refresh-catalog", async (req, res) => {
  await fetchAllProducts();
  res.json({ products: PRODUCT_CATALOG.length, brands: BRANDS, loadedAt: CATALOG_LOADED_AT });
});

app.post("/api/admin/restart", (req, res) => {
  res.json({ ok: true, message: "Restarting..." });
  setTimeout(() => process.exit(0), 300);
});

// ============================================================
// ESCALATION
// ============================================================
app.post("/api/escalate", async (req, res) => {
  try {
    const { conversationId, reason, email } = req.body;
    const messages = db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at").all(conversationId);
    const chatHistory = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
    const escId = uuidv4();
    db.prepare("INSERT INTO escalations (id, conversation_id, reason) VALUES (?, ?, ?)").run(escId, conversationId, reason);
    await emailTransporter.sendMail({
      from: process.env.GMAIL_USER, to: process.env.SUPPORT_EMAIL,
      subject: `Frikkie Escalation - ${reason}`,
      text: `Customer: ${email}\n\nReason: ${reason}\n\nChat:\n\n${chatHistory}`,
    });
    if (email) {
      await emailTransporter.sendMail({
        from: process.env.GMAIL_USER, to: email,
        subject: "We've received your request",
        text: `Hi,\n\nWe've received your request and our team will be in touch shortly.\n\nBest,\nFrikkie`,
      });
    }
    res.json({ success: true, escalationId: escId });
  } catch (error) {
    console.error("Escalation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// DASHBOARD (served at root)
// ============================================================
app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "admin-dashboard.html"));
});

// ============================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`Frikkie is running on port ${PORT}`);
  console.log(`https://frikkie-shopify-assistant-production.up.railway.app`);
  await fetchAllProducts();
  setInterval(fetchAllProducts, 1000 * 60 * 30);
});
