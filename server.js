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
    read INTEGER DEFAULT 0,
    responded INTEGER DEFAULT 0,
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
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// Safe migrations for older DBs
for (const [col, def] of [["name", "TEXT"], ["read", "INTEGER DEFAULT 0"], ["responded", "INTEGER DEFAULT 0"]]) {
  try { db.prepare(`SELECT ${col} FROM conversations LIMIT 1`).get(); }
  catch { try { db.exec(`ALTER TABLE conversations ADD COLUMN ${col} ${def}`); } catch {} }
}

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

const GUEST_EMAILS = ["guest@example.com", "customer@4x4factory.co.za", ""];
const NOT_GUEST_SQL = "c.email IS NOT NULL AND c.email NOT IN ('guest@example.com','customer@4x4factory.co.za','')";

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
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !SHOP_DOMAIN) throw new Error("Missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET / SHOPIFY_STORE");
  const resp = await fetch(`https://${SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET }),
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
function stripHtml(s) { return (s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }

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
      const resp = await fetch(url, { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } });
      if (!resp.ok) { console.error("Shopify fetch failed:", resp.status, await resp.text()); break; }
      const data = await resp.json();
      for (const p of data.products || []) {
        const prices = (p.variants || []).map((v) => parseFloat(v.price)).filter((n) => !isNaN(n));
        const minPrice = prices.length ? Math.min(...prices) : null;
        const image = (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || null;
        products.push({
          title: p.title,
          vendor: p.vendor || "",
          type: p.product_type || "",
          tags: p.tags || "",
          handle: p.handle,
          url: `${STORE_URL}/products/${p.handle}`,
          price: minPrice,
          image,
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
  if (!PRODUCT_CATALOG.length) return "\n\n(Product catalog is not loaded right now - answer generally and suggest the customer browse the store.)";
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
- When you recommend a specific product, include its full store link (the URL shown above) so the customer can click through.
- If you're not sure we stock it, say so honestly and offer to check or escalate.
=== END STORE KNOWLEDGE ===`;
}

// Which catalog products did Frikkie actually reference? -> return rich cards
function productsFromReply(replyText) {
  if (!PRODUCT_CATALOG.length || !replyText) return [];
  const found = new Map();
  const re = /\/products\/([a-z0-9\-_%]+)/gi;
  let m;
  while ((m = re.exec(replyText))) {
    const handle = decodeURIComponent(m[1]).toLowerCase();
    const p = PRODUCT_CATALOG.find((x) => x.handle.toLowerCase() === handle);
    if (p) found.set(p.handle, p);
  }
  const low = replyText.toLowerCase();
  for (const p of PRODUCT_CATALOG) {
    if (found.size >= 3) break;
    if (p.title && p.title.length >= 6 && low.includes(p.title.toLowerCase())) found.set(p.handle, p);
  }
  return [...found.values()].slice(0, 3).map((p) => ({
    title: p.title, price: p.price, url: p.url, image: p.image || null, vendor: p.vendor || "",
  }));
}

// ============================================================
// EMAIL
// ============================================================
const emailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASSWORD },
});

const COST_PER_1K_INPUT = 0.002;
const COST_PER_1K_OUTPUT = 0.010;
function calculateCost(i, o) { return (i / 1000) * COST_PER_1K_INPUT + (o / 1000) * COST_PER_1K_OUTPUT; }

const FRIKKIE_SYSTEM = `You are Frikkie, a friendly South African 4x4 lighting expert for 4x4 Factory SA.

**Keep it SHORT - 2-3 sentences max!**
- Be direct and helpful, use South African expressions naturally.
- Use the STORE KNOWLEDGE section below for all product facts - it's your single source of truth about what the store sells.
- When you recommend a specific product, include its full store link so the customer can click through.
- Never invent products, prices, or brands. If something isn't in the store knowledge, say you're not certain and offer to check.
- Early on, in a natural friendly way, ask the customer's first name so you can chat properly.
- If they want a quote, a stock check, or someone to follow up with them, ask for their email address so the team can get back to them.`;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const NAME_RES = [/\bmy name is ([a-z][a-z'\-]+)/i, /\bi am ([a-z][a-z'\-]+)/i, /\bi'm ([a-z][a-z'\-]+)/i, /\bit'?s ([a-z][a-z'\-]+)\b/i, /\bthis is ([a-z][a-z'\-]+)/i];
function extractLead(text) {
  const out = {};
  const em = (text || "").match(EMAIL_RE);
  if (em) out.email = em[0];
  for (const re of NAME_RES) { const mm = (text || "").match(re); if (mm) { out.name = mm[1][0].toUpperCase() + mm[1].slice(1); break; } }
  return out;
}

// ============================================================
// PUBLIC ENDPOINTS
// ============================================================
app.get("/api/status", (req, res) => {
  res.json({
    status: "ok", version: "4.0.0", catalog: PRODUCT_CATALOG.length, brands: BRANDS, productTypes: PRODUCT_TYPES,
    loadedAt: CATALOG_LOADED_AT, shopifyConfigured: !!(SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET && SHOPIFY_STORE),
    hasToken: !!SHOPIFY_TOKEN_CACHE, uptimeSeconds: Math.floor(process.uptime()),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  });
});
app.get("/health", (req, res) => res.json({ status: "ok", catalog: PRODUCT_CATALOG.length, brands: BRANDS, hasToken: !!SHOPIFY_TOKEN_CACHE }));
app.get("/api/widget-config", (req, res) => res.json({ avatarUrl: getSetting("avatar_url", DEFAULT_AVATAR), greeting: getSetting("greeting", "") }));

// ============================================================
// CHAT
// ============================================================
app.post("/api/chat", async (req, res) => {
  try {
    const { message, conversationId, email } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });

    const cleanEmail = email && !GUEST_EMAILS.includes(email) ? email : "guest@example.com";
    let convoId = conversationId;
    const ts0 = new Date().toISOString();
    let exists = false;
    if (convoId) exists = !!db.prepare("SELECT id FROM conversations WHERE id = ?").get(convoId);
    if (!convoId || !exists) {
      if (!convoId) convoId = uuidv4();
      db.prepare("INSERT OR IGNORE INTO conversations (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(convoId, cleanEmail, ts0, ts0);
    }

    const lead = extractLead(message);
    if (lead.email) db.prepare("UPDATE conversations SET email = ? WHERE id = ?").run(lead.email, convoId);
    if (lead.name) db.prepare("UPDATE conversations SET name = ? WHERE id = ?").run(lead.name, convoId);

    const history = db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 10")
      .all(convoId).reverse().map((mm) => ({ role: mm.role, content: mm.content }));
    const messages = [...history, { role: "user", content: message }];
    const systemPrompt = FRIKKIE_SYSTEM + buildCatalogContext(message);

    const response = await client.messages.create({ model: "claude-sonnet-5", max_tokens: 1024, system: systemPrompt, messages });
    let assistantMessage = (response.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!assistantMessage) assistantMessage = "Ag sorry, boet — I didn't quite catch that one. Mind asking again?";
    const cost = calculateCost(response.usage.input_tokens, response.usage.output_tokens);
    const ts = new Date().toISOString();

    db.prepare("INSERT INTO messages (id, conversation_id, role, content, tokens_used, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(uuidv4(), convoId, "user", message, response.usage.input_tokens, cost, ts);
    db.prepare("INSERT INTO messages (id, conversation_id, role, content, tokens_used, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(uuidv4(), convoId, "assistant", assistantMessage, response.usage.output_tokens, cost, ts);
    // New customer activity: unread for owner + needs a response
    db.prepare("UPDATE conversations SET updated_at = ?, read = 0, responded = 0 WHERE id = ?").run(ts, convoId);

    const products = productsFromReply(assistantMessage);
    res.json({ conversationId: convoId, message: assistantMessage, cost, products });
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
    const leads = db.prepare(`SELECT COUNT(*) as count FROM conversations c WHERE ${NOT_GUEST_SQL}`).get();
    const esc = db.prepare("SELECT COUNT(*) as count FROM escalations").get();
    const today = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE date(created_at) = date('now')").get();
    const unread = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE read = 0").get();
    const needs = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE responded = 0").get();
    res.json({
      conversations: c.count || 0, messages: m.count || 0, questionsAnswered: um.count || 0,
      totalCost: Number((t.total || 0).toFixed(4)), leads: leads.count || 0, escalations: esc.count || 0,
      conversationsToday: today.count || 0, unread: unread.count || 0, needsResponse: needs.count || 0,
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get("/api/admin/conversations", (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    const filter = (req.query.filter || "").toString().trim(); // '', 'unread', 'needs'
    let where = "1=1";
    if (filter === "unread") where = "c.read = 0";
    else if (filter === "needs") where = "c.responded = 0";
    const params = [];
    let searchClause = "";
    if (q) {
      searchClause = " AND (c.name LIKE ? OR c.email LIKE ? OR c.id IN (SELECT conversation_id FROM messages WHERE content LIKE ?))";
      const like = `%${q}%`; params.push(like, like, like);
    }
    const rows = db.prepare(`
      SELECT c.id, c.name, c.email, c.read, c.responded, c.created_at, c.updated_at, COUNT(m.id) as messages
      FROM conversations c LEFT JOIN messages m ON c.id = m.conversation_id
      WHERE ${where}${searchClause}
      GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 100
    `).all(...params);
    res.json({ conversations: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get("/api/admin/conversation/:id", (req, res) => {
  try {
    const convo = db.prepare("SELECT * FROM conversations WHERE id = ?").get(req.params.id);
    if (!convo) return res.status(404).json({ error: "Not found" });
    const messages = db.prepare("SELECT role, content, created_at, cost FROM messages WHERE conversation_id = ? ORDER BY created_at").all(req.params.id);
    // Opening a conversation marks it read
    if (req.query.markRead !== "0") db.prepare("UPDATE conversations SET read = 1 WHERE id = ?").run(req.params.id);
    res.json({ conversation: { ...convo, read: 1 }, messages });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Toggle read / responded flags
app.post("/api/admin/conversation/:id/flags", (req, res) => {
  try {
    const { read, responded } = req.body;
    if (typeof read === "boolean") db.prepare("UPDATE conversations SET read = ? WHERE id = ?").run(read ? 1 : 0, req.params.id);
    if (typeof responded === "boolean") db.prepare("UPDATE conversations SET responded = ? WHERE id = ?").run(responded ? 1 : 0, req.params.id);
    const convo = db.prepare("SELECT id, read, responded FROM conversations WHERE id = ?").get(req.params.id);
    res.json({ ok: true, conversation: convo });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get("/api/admin/customers", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.id, c.name, c.email, c.read, c.responded, c.created_at, c.updated_at, COUNT(m.id) as messages
      FROM conversations c LEFT JOIN messages m ON c.id = m.conversation_id
      WHERE ${NOT_GUEST_SQL} GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 200
    `).all();
    res.json({ customers: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get("/api/admin/customers.csv", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.name, c.email, c.responded, c.created_at, c.updated_at, COUNT(m.id) as messages
      FROM conversations c LEFT JOIN messages m ON c.id = m.conversation_id
      WHERE ${NOT_GUEST_SQL} GROUP BY c.id ORDER BY c.updated_at DESC
    `).all();
    const esc = (s) => `"${(s == null ? "" : String(s)).replace(/"/g, '""')}"`;
    const header = "Name,Email,Responded,First seen,Last seen,Messages\n";
    const body = rows.map((r) => [esc(r.name), esc(r.email), r.responded ? "yes" : "no", esc(r.created_at), esc(r.updated_at), r.messages].join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="frikkie-customers.csv"');
    res.send(header + body);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get("/api/admin/escalations", (req, res) => {
  try {
    const rows = db.prepare(`SELECT e.id, e.reason, e.created_at, c.name, c.email FROM escalations e LEFT JOIN conversations c ON e.conversation_id = c.id ORDER BY e.created_at DESC LIMIT 100`).all();
    res.json({ escalations: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get("/api/admin/settings", (req, res) => res.json({ avatarUrl: getSetting("avatar_url", DEFAULT_AVATAR), greeting: getSetting("greeting", "") }));
app.post("/api/admin/settings", (req, res) => {
  try {
    const { avatarUrl, greeting } = req.body;
    if (typeof avatarUrl === "string" && avatarUrl.trim()) setSetting("avatar_url", avatarUrl.trim());
    if (typeof greeting === "string" && greeting.trim()) setSetting("greeting", greeting.trim());
    res.json({ ok: true, avatarUrl: getSetting("avatar_url"), greeting: getSetting("greeting") });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post("/api/refresh-catalog", async (req, res) => {
  await fetchAllProducts();
  res.json({ products: PRODUCT_CATALOG.length, brands: BRANDS, loadedAt: CATALOG_LOADED_AT });
});
app.post("/api/admin/restart", (req, res) => { res.json({ ok: true, message: "Restarting..." }); setTimeout(() => process.exit(0), 300); });

// Manual trigger for the daily summary (used by dashboard button + testing)
app.post("/api/admin/send-summary", async (req, res) => {
  try { const r = await buildAndSendSummary(); res.json({ ok: true, ...r }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ESCALATION
// ============================================================
app.post("/api/escalate", async (req, res) => {
  try {
    const { conversationId, reason, email } = req.body;
    const messages = db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at").all(conversationId);
    const chatHistory = messages.map((mm) => `${mm.role.toUpperCase()}: ${mm.content}`).join("\n\n");
    const escId = uuidv4();
    db.prepare("INSERT INTO escalations (id, conversation_id, reason) VALUES (?, ?, ?)").run(escId, conversationId, reason);
    await emailTransporter.sendMail({ from: process.env.GMAIL_USER, to: process.env.SUPPORT_EMAIL, subject: `Frikkie Escalation - ${reason}`, text: `Customer: ${email}\n\nReason: ${reason}\n\nChat:\n\n${chatHistory}` });
    if (email) await emailTransporter.sendMail({ from: process.env.GMAIL_USER, to: email, subject: "We've received your request", text: `Hi,\n\nWe've received your request and our team will be in touch shortly.\n\nBest,\nFrikkie` });
    res.json({ success: true, escalationId: escId });
  } catch (error) { console.error("Escalation error:", error); res.status(500).json({ error: error.message }); }
});

// ============================================================
// DAILY SUMMARY
// ============================================================
const DAILY_SUMMARY_HOUR = parseInt(process.env.DAILY_SUMMARY_HOUR || "17", 10); // hour in SAST (UTC+2)
const SUMMARY_EMAIL = process.env.DAILY_SUMMARY_EMAIL || process.env.SUPPORT_EMAIL || process.env.GMAIL_USER;
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://frikkie-shopify-assistant-production.up.railway.app/";

function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

async function buildAndSendSummary() {
  // Conversations with activity in the last 24h
  const convos = db.prepare(`
    SELECT c.id, c.name, c.email, c.read, c.responded, c.updated_at, COUNT(m.id) as messages
    FROM conversations c LEFT JOIN messages m ON c.id = m.conversation_id
    WHERE datetime(c.updated_at) >= datetime('now','-1 day')
    GROUP BY c.id ORDER BY c.updated_at DESC
  `).all();

  const needsResponse = convos.filter((c) => !c.responded);
  const newLeads = convos.filter((c) => c.email && !GUEST_EMAILS.includes(c.email));

  // Compact transcript for an AI summary (best-effort)
  let aiSummary = "";
  try {
    if (convos.length) {
      const parts = [];
      for (const c of convos.slice(0, 25)) {
        const msgs = db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at LIMIT 12").all(c.id);
        parts.push(`Conversation with ${c.name || "a guest"}${c.email && !GUEST_EMAILS.includes(c.email) ? " (" + c.email + ")" : ""}:\n` +
          msgs.map((mm) => `${mm.role === "user" ? "Customer" : "Frikkie"}: ${mm.content}`).join("\n"));
      }
      const resp = await client.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 400,
        system: "You are Frikkie summarising the day's customer chats for the shop owner. Write a short, friendly plain-text daily briefing (5-8 sentences max). Call out anything that needs the owner to follow up, any quote requests, and any products customers were keen on. Be specific but concise. No markdown.",
        messages: [{ role: "user", content: `Here are today's conversations:\n\n${parts.join("\n\n---\n\n")}` }],
      });
      aiSummary = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    }
  } catch (e) { console.error("AI summary failed:", e.message); }

  const dateStr = new Date().toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const rowHtml = (c) => {
    const who = esc(c.name || "Guest");
    const mail = c.email && !GUEST_EMAILS.includes(c.email) ? esc(c.email) : "—";
    const flags = [];
    if (!c.read) flags.push('<span style="background:#e0913b;color:#241c08;padding:1px 7px;border-radius:6px;font-size:11px">UNREAD</span>');
    if (!c.responded) flags.push('<span style="background:#d9614b;color:#fff;padding:1px 7px;border-radius:6px;font-size:11px">NEEDS REPLY</span>');
    return `<tr><td style="padding:8px 10px;border-bottom:1px solid #eee">${who}</td><td style="padding:8px 10px;border-bottom:1px solid #eee;color:#555">${mail}</td><td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center">${c.messages}</td><td style="padding:8px 10px;border-bottom:1px solid #eee">${flags.join(" ") || "—"}</td></tr>`;
  };

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">
    <div style="background:#574b33;color:#f0e9d8;padding:18px 22px;border-radius:10px 10px 0 0">
      <h2 style="margin:0;font-size:20px">Frikkie's Daily Briefing</h2>
      <div style="opacity:.85;font-size:13px;margin-top:4px">${dateStr}</div>
    </div>
    <div style="border:1px solid #eee;border-top:none;border-radius:0 0 10px 10px;padding:20px 22px">
      <p style="font-size:15px">Howzit boss 👋 Here's how the day looked:</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin:14px 0">
        <div style="background:#f6f3ec;border-radius:8px;padding:10px 16px"><b style="font-size:22px">${convos.length}</b><br><span style="font-size:12px;color:#666">conversations</span></div>
        <div style="background:#f6f3ec;border-radius:8px;padding:10px 16px"><b style="font-size:22px;color:#d9614b">${needsResponse.length}</b><br><span style="font-size:12px;color:#666">need a reply</span></div>
        <div style="background:#f6f3ec;border-radius:8px;padding:10px 16px"><b style="font-size:22px">${newLeads.length}</b><br><span style="font-size:12px;color:#666">with email</span></div>
      </div>
      ${aiSummary ? `<div style="background:#faf7f0;border-left:3px solid #e0991f;padding:12px 16px;border-radius:6px;font-size:14px;line-height:1.55;white-space:pre-wrap">${esc(aiSummary)}</div>` : ""}
      ${convos.length ? `<table style="width:100%;border-collapse:collapse;margin-top:18px;font-size:13px">
        <thead><tr><th style="text-align:left;padding:8px 10px;border-bottom:2px solid #ddd">Who</th><th style="text-align:left;padding:8px 10px;border-bottom:2px solid #ddd">Email</th><th style="padding:8px 10px;border-bottom:2px solid #ddd">Msgs</th><th style="text-align:left;padding:8px 10px;border-bottom:2px solid #ddd">Status</th></tr></thead>
        <tbody>${convos.map(rowHtml).join("")}</tbody></table>` : '<p style="color:#888">No conversations in the last 24 hours.</p>'}
      <a href="${DASHBOARD_URL}" style="display:inline-block;margin-top:20px;background:#e0991f;color:#241c08;text-decoration:none;font-weight:bold;padding:11px 20px;border-radius:8px">Open the dashboard →</a>
      <p style="color:#999;font-size:12px;margin-top:20px">Sent automatically by Frikkie · 4x4 Factory SA</p>
    </div>
  </div>`;

  await emailTransporter.sendMail({
    from: process.env.GMAIL_USER,
    to: SUMMARY_EMAIL,
    subject: `Frikkie Daily Briefing — ${dateStr} (${needsResponse.length} need a reply)`,
    html,
  });
  console.log(`Daily summary sent to ${SUMMARY_EMAIL} (${convos.length} convos, ${needsResponse.length} need reply)`);
  return { conversations: convos.length, needsResponse: needsResponse.length, sentTo: SUMMARY_EMAIL };
}

function msUntilHourSAST(hour) {
  const now = new Date();
  const nowSAST = new Date(now.getTime() + 2 * 3600 * 1000); // shift into SAST
  const target = new Date(nowSAST);
  target.setUTCHours(hour, 0, 0, 0);
  if (target <= nowSAST) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - nowSAST.getTime();
}
function scheduleDailySummary() {
  const ms = msUntilHourSAST(DAILY_SUMMARY_HOUR);
  console.log(`Next daily summary in ${(ms / 3600000).toFixed(1)}h (target ${DAILY_SUMMARY_HOUR}:00 SAST)`);
  setTimeout(async () => {
    try { await buildAndSendSummary(); } catch (e) { console.error("Daily summary error:", e.message); }
    scheduleDailySummary();
  }, ms);
}

// ============================================================
// DASHBOARD
// ============================================================
app.get("/", (req, res) => res.sendFile(join(__dirname, "admin-dashboard.html")));

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`Frikkie is running on port ${PORT}`);
  console.log(`https://frikkie-shopify-assistant-production.up.railway.app`);
  await fetchAllProducts();
  setInterval(fetchAllProducts, 1000 * 60 * 30);
  scheduleDailySummary();
});
