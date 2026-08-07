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
import fs from "fs";
import PDFDocument from "pdfkit";

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

  CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY,
    rule TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    source TEXT DEFAULT 'manual',
    conversation_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    number TEXT,
    conversation_id TEXT,
    name TEXT,
    email TEXT,
    subtotal REAL,
    shipping REAL,
    total REAL,
    items_json TEXT,
    pdf_file TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
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

function buildKnowledgeContext() {
  const rules = db.prepare("SELECT rule FROM knowledge WHERE active = 1 ORDER BY created_at").all().map((r) => r.rule);
  if (!rules.length) return "";
  const lines = rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
  return `

=== SHOP CORRECTIONS & HOUSE RULES (authoritative — always follow, overrides your assumptions) ===
${lines}

When one of these rules applies, follow it AND briefly clarify the distinction to the customer in a natural, friendly way (e.g. mention the beam pattern) rather than silently swapping terms.
=== END SHOP CORRECTIONS ===`;
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
// Prefer real domain SMTP (cPanel mailbox) so mail authenticates and lands.
// Falls back to Gmail only if SMTP_HOST isn't set.
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "465", 10);
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER || process.env.GMAIL_USER || "frikkie@4x4factory.co.za";

const emailTransporter = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465, // 465 = SSL, 587 = STARTTLS
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASSWORD },
    });

emailTransporter.verify((err) => {
  if (err) console.error("Mail transport not ready:", err.message);
  else console.log(`Mail ready via ${SMTP_HOST ? "SMTP " + SMTP_HOST + ":" + SMTP_PORT : "Gmail"} as ${MAIL_FROM}`);
});

const COST_PER_1K_INPUT = 0.002;
const COST_PER_1K_OUTPUT = 0.010;
function calculateCost(i, o) { return (i / 1000) * COST_PER_1K_INPUT + (o / 1000) * COST_PER_1K_OUTPUT; }

// ============================================================
// QUOTE ENGINE
// ============================================================
// Live shipping tiers pulled from Shopify (South Africa, TOTAL_PRICE based)
const SHIPPING_TIERS = [
  { min: 0, max: 5000, price: 115 },
  { min: 5000, max: 15000, price: 180 },
  { min: 15000, max: 23000, price: 220 },
  { min: 23000, max: 50000, price: 300 },
  { min: 50000, max: 100000, price: 550 },
  { min: 100000, max: 300000, price: 1000 },
  { min: 300000, max: Infinity, price: 1500 },
];
function shippingForSubtotal(subtotal) {
  const t = SHIPPING_TIERS.find((t) => subtotal >= t.min && subtotal < t.max) || SHIPPING_TIERS[SHIPPING_TIERS.length - 1];
  return t.price;
}
const QUOTES_DIR = join(dirname(DATABASE_PATH.startsWith("/") ? DATABASE_PATH : join(__dirname, DATABASE_PATH)), "quotes");
try { fs.mkdirSync(QUOTES_DIR, { recursive: true }); } catch {}

// Company logo for the quote PDF — downloaded from QUOTE_LOGO_URL, re-fetched whenever that URL changes
const QUOTE_LOGO_URL = process.env.QUOTE_LOGO_URL || "https://cdn.shopify.com/s/files/1/0539/2878/8145/collections/400PngdpiLogoCroppedBW.png";
const LOGO_PATH = join(QUOTES_DIR, "logo.png");
const LOGO_URL_MARKER = join(QUOTES_DIR, "logo.url");
async function ensureLogo() {
  if (!QUOTE_LOGO_URL) return null;
  try {
    // If we already cached this exact URL, keep it; otherwise (new/changed URL) re-download.
    const cachedUrl = fs.existsSync(LOGO_URL_MARKER) ? fs.readFileSync(LOGO_URL_MARKER, "utf8").trim() : "";
    if (fs.existsSync(LOGO_PATH) && cachedUrl === QUOTE_LOGO_URL) return LOGO_PATH;
    const r = await fetch(QUOTE_LOGO_URL);
    if (!r.ok) { console.error("Logo fetch failed:", r.status); return fs.existsSync(LOGO_PATH) ? LOGO_PATH : null; }
    fs.writeFileSync(LOGO_PATH, Buffer.from(await r.arrayBuffer()));
    fs.writeFileSync(LOGO_URL_MARKER, QUOTE_LOGO_URL);
    console.log("Quote logo cached/updated from", QUOTE_LOGO_URL);
    return LOGO_PATH;
  } catch (e) { console.error("Logo fetch error:", e.message); return fs.existsSync(LOGO_PATH) ? LOGO_PATH : null; }
}

function fuzzyMatchProduct(title) {
  if (!PRODUCT_CATALOG.length || !title) return null;
  const t = title.toLowerCase().trim();
  let p = PRODUCT_CATALOG.find((x) => x.title.toLowerCase() === t);
  if (p) return p;
  p = PRODUCT_CATALOG.find((x) => x.title.toLowerCase().includes(t) || t.includes(x.title.toLowerCase()));
  if (p) return p;
  const words = t.split(/\s+/).filter((w) => w.length >= 3);
  let best = null, bestScore = 0;
  for (const x of PRODUCT_CATALOG) {
    const hay = x.title.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score++;
    if (score > bestScore) { bestScore = score; best = x; }
  }
  return bestScore >= 2 ? best : null;
}

// Ask Claude to pull the quote line items out of the conversation
async function extractQuoteItems(convoId) {
  const msgs = db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at").all(convoId);
  if (!msgs.length) return [];
  const transcript = msgs.map((m) => `${m.role === "user" ? "Customer" : "Frikkie"}: ${m.content}`).join("\n");
  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 500,
      system: "Extract the products the customer wants quoted from this chat. Return ONLY a JSON array, no prose, of objects: {\"title\": string, \"qty\": number}. Use the product name as mentioned. If quantity isn't stated, use 1. If no products are being quoted, return [].",
      messages: [{ role: "user", content: transcript }],
    });
    const text = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    const jsonStart = text.indexOf("[");
    const jsonEnd = text.lastIndexOf("]");
    if (jsonStart === -1 || jsonEnd === -1) return [];
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("extractQuoteItems failed:", e.message);
    return [];
  }
}

// Build a professional quote PDF, return the filename
function buildQuotePdf({ number, name, email, address, lines, subtotal, shipping, total }) {
  return new Promise((resolve, reject) => {
    const file = `${number}.pdf`;
    const path = join(QUOTES_DIR, file);
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = fs.createWriteStream(path);
    doc.pipe(stream);

    const khaki = "#574b33", amber = "#e0991f", grey = "#666666", line = "#dddddd";
    // Header — logo if we have it, else the wordmark
    const hasLogo = fs.existsSync(LOGO_PATH);
    if (hasLogo) {
      try { doc.image(LOGO_PATH, 50, 45, { height: 46 }); }
      catch { doc.fillColor(khaki).fontSize(22).font("Helvetica-Bold").text("4x4 FACTORY SA", 50, 50); }
    } else {
      doc.fillColor(khaki).fontSize(22).font("Helvetica-Bold").text("4x4 FACTORY SA", 50, 50);
    }
    doc.fillColor(grey).fontSize(9).font("Helvetica")
      .text("www.4x4factory.co.za  |  sales@4x4factory.co.za", 50, 96);
    doc.fillColor(khaki).fontSize(18).font("Helvetica-Bold").text("QUOTE", 400, 50, { align: "right" });
    doc.fillColor(grey).fontSize(10).font("Helvetica")
      .text(`No: ${number}`, 400, 76, { align: "right" })
      .text(`Date: ${new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}`, 400, 90, { align: "right" })
      .text("Valid: 14 days", 400, 104, { align: "right" });

    // Bill to
    doc.moveTo(50, 130).lineTo(545, 130).strokeColor(line).stroke();
    doc.fillColor(khaki).fontSize(10).font("Helvetica-Bold").text("PREPARED FOR", 50, 142);
    doc.fillColor("#222").font("Helvetica").fontSize(11).text(name || "Customer", 50, 158);
    let byY = 173;
    if (email) { doc.fillColor(grey).fontSize(10).text(email, 50, byY); byY += 14; }
    if (address) { doc.fillColor(grey).fontSize(10).text(address, 50, byY, { width: 280 }); }

    // Table header
    let y = 210;
    doc.fillColor(khaki).fontSize(9).font("Helvetica-Bold");
    doc.text("ITEM", 50, y).text("QTY", 350, y, { width: 40, align: "right" })
      .text("UNIT", 400, y, { width: 65, align: "right" }).text("TOTAL", 480, y, { width: 65, align: "right" });
    y += 8; doc.moveTo(50, y + 6).lineTo(545, y + 6).strokeColor(line).stroke(); y += 16;

    doc.font("Helvetica").fontSize(10).fillColor("#222");
    for (const l of lines) {
      const unit = l.price != null ? `R${Number(l.price).toLocaleString("en-ZA")}` : "POA";
      const lineTotal = l.price != null ? `R${(l.price * l.qty).toLocaleString("en-ZA")}` : "POA";
      const titleHeight = doc.heightOfString(l.title, { width: 290 });
      doc.fillColor("#222").text(l.title, 50, y, { width: 290 });
      doc.text(String(l.qty), 350, y, { width: 40, align: "right" });
      doc.text(unit, 400, y, { width: 65, align: "right" });
      doc.text(lineTotal, 480, y, { width: 65, align: "right" });
      y += Math.max(titleHeight, 14) + 8;
      if (y > 700) { doc.addPage(); y = 60; }
    }

    // Totals
    doc.moveTo(350, y).lineTo(545, y).strokeColor(line).stroke(); y += 12;
    const rightRow = (label, val, bold) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 12 : 10).fillColor(bold ? khaki : "#222");
      doc.text(label, 350, y, { width: 110, align: "right" });
      doc.text(val, 470, y, { width: 75, align: "right" });
      y += bold ? 20 : 16;
    };
    rightRow("Subtotal", `R${subtotal.toLocaleString("en-ZA")}`);
    rightRow("Shipping", `R${shipping.toLocaleString("en-ZA")}`);
    rightRow("TOTAL", `R${total.toLocaleString("en-ZA")}`, true);

    // Footer notes
    y += 14;
    doc.font("Helvetica").fontSize(8.5).fillColor(grey)
      .text("Prices include VAT and are in ZAR. Shipping estimated from order value; final rate confirmed at checkout. Typical lead time 0–3 weeks, stock dependent. Items marked POA to be confirmed by our team.", 50, y, { width: 495 });
    y += 40;
    doc.font("Helvetica-Oblique").fontSize(8.5).fillColor("#8a7f66")
      .text("This quote was generated by AI and should be used as an estimate only. For a full official quote, please email sales@4x4factory.co.za with the items you require.", 50, y, { width: 495 });
    doc.moveTo(50, y + 34).lineTo(545, y + 34).strokeColor(line).stroke();
    doc.fillColor(amber).fontSize(10).font("Helvetica-Bold").text("Thanks for shopping with 4x4 Factory SA!", 50, y + 44);

    doc.end();
    stream.on("finish", () => resolve(file));
    stream.on("error", reject);
  });
}

const FRIKKIE_SYSTEM = `You are Frikkie, a friendly South African 4x4 lighting expert for 4x4 Factory SA.

**Keep it SHORT - 2-3 sentences max!**
- Be direct and helpful, use South African expressions naturally.
- Use the STORE KNOWLEDGE section below for all product facts - it's your single source of truth about what the store sells.
- When you recommend a specific product, include its full store link so the customer can click through.
- Never invent products, prices, or brands. If something isn't in the store knowledge, say you're not certain and offer to check.
- If a SHOP CORRECTIONS & HOUSE RULES section is present below, treat it as authoritative — it reflects how this shop actually talks about its products and overrides your general assumptions.
- When the customer seems to be building an order or asking about prices for specific items they want (a quote situation), offer to put together a formal quote for them. To do this, end your message with the exact marker [[OFFER_QUOTE]] on its own — the app turns it into a "Get a quote" button, so don't describe the button, just offer naturally and add the marker. Only add it when there are actual products on the table.
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
    const systemPrompt = FRIKKIE_SYSTEM + buildKnowledgeContext() + buildCatalogContext(message);

    const response = await client.messages.create({ model: "claude-sonnet-5", max_tokens: 1024, system: systemPrompt, messages });
    let assistantMessage = (response.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!assistantMessage) assistantMessage = "Ag sorry, boet — I didn't quite catch that one. Mind asking again?";
    const cost = calculateCost(response.usage.input_tokens, response.usage.output_tokens);
    const ts = new Date().toISOString();
    const offerQuote = /\[\[OFFER_QUOTE\]\]/.test(assistantMessage);
    assistantMessage = assistantMessage.replace(/\[\[OFFER_QUOTE\]\]/g, "").trim();

    db.prepare("INSERT INTO messages (id, conversation_id, role, content, tokens_used, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(uuidv4(), convoId, "user", message, response.usage.input_tokens, cost, ts);
    db.prepare("INSERT INTO messages (id, conversation_id, role, content, tokens_used, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(uuidv4(), convoId, "assistant", assistantMessage, response.usage.output_tokens, cost, ts);
    // New customer activity: unread for owner + needs a response
    db.prepare("UPDATE conversations SET updated_at = ?, read = 0, responded = 0 WHERE id = ?").run(ts, convoId);

    const products = productsFromReply(assistantMessage);
    res.json({ conversationId: convoId, message: assistantMessage, cost, products, offerQuote });
  } catch (error) {
    console.error("Chat error:", error.message);
    res.status(500).json({ error: error.message || "Server error" });
  }
});

// ============================================================
// QUOTES
// ============================================================
app.post("/api/quote", async (req, res) => {
  try {
    const { conversationId, name, email, address } = req.body;
    if (!conversationId) return res.status(400).json({ error: "conversationId required" });

    // Pull details from the conversation record if not supplied
    const convo = db.prepare("SELECT name, email FROM conversations WHERE id = ?").get(conversationId) || {};
    const custName = (name && name.trim()) || convo.name || "Customer";
    const custEmail = (email && email.trim()) || (convo.email && !GUEST_EMAILS.includes(convo.email) ? convo.email : "");
    const custAddress = (address && address.trim()) || "";

    // Extract items and price them from the live catalog
    const raw = await extractQuoteItems(conversationId);
    if (!raw.length) return res.json({ ok: false, reason: "no_items", message: "I couldn't spot specific products to quote yet — tell me which items and quantities you want." });

    const lines = raw.map((it) => {
      const qty = Math.max(1, parseInt(it.qty, 10) || 1);
      const match = fuzzyMatchProduct(it.title);
      return { title: match ? match.title : it.title, qty, price: match ? match.price : null };
    });
    const subtotal = lines.reduce((s, l) => s + (l.price != null ? l.price * l.qty : 0), 0);
    const shipping = shippingForSubtotal(subtotal);
    const total = subtotal + shipping;

    const number = "Q-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
    const file = await buildQuotePdf({ number, name: custName, email: custEmail, address: custAddress, lines, subtotal, shipping, total });

    // Record it
    db.prepare("INSERT INTO quotes (id, number, conversation_id, name, email, subtotal, shipping, total, items_json, pdf_file, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(uuidv4(), number, conversationId, custName, custEmail, subtotal, shipping, total, JSON.stringify(lines), file, new Date().toISOString());

    // Email the PDF: always to the team, and to the customer if we have their address
    const itemRows = lines.map((l) => `${l.qty} x ${l.title} — ${l.price != null ? "R" + l.price.toLocaleString("en-ZA") : "POA"}`).join("\n");
    const teamEmail = process.env.DAILY_SUMMARY_EMAIL || process.env.SUPPORT_EMAIL || MAIL_FROM;
    const attachment = { filename: `${number}.pdf`, path: join(QUOTES_DIR, file) };
    let emailedCustomer = false;
    try {
      await emailTransporter.sendMail({
        from: MAIL_FROM, to: teamEmail,
        subject: `New quote ${number} — ${custName} (R${total.toLocaleString("en-ZA")})`,
        text: `Frikkie generated a quote from a chat.\n\nCustomer: ${custName}${custEmail ? " <" + custEmail + ">" : ""}\n${custAddress ? "Address: " + custAddress + "\n" : ""}\n${itemRows}\n\nSubtotal: R${subtotal.toLocaleString("en-ZA")}\nShipping: R${shipping.toLocaleString("en-ZA")}\nTotal: R${total.toLocaleString("en-ZA")}\n\nPDF attached.`,
        attachments: [attachment],
      });
      if (custEmail) {
        await emailTransporter.sendMail({
          from: MAIL_FROM, to: custEmail,
          subject: `Your 4x4 Factory SA quote ${number}`,
          text: `Hi ${custName},\n\nThanks for chatting with Frikkie! Your quote (${number}) is attached as a PDF.\n\nTotal: R${total.toLocaleString("en-ZA")} (incl. estimated shipping)\n\nThis is an AI-generated estimate. For a full official quote, reply to this email or contact sales@4x4factory.co.za.\n\nKind regards,\n4x4 Factory SA`,
          attachments: [attachment],
        });
        emailedCustomer = true;
      }
    } catch (e) { console.error("Quote email failed:", e.message); }

    res.json({ ok: true, number, total, subtotal, shipping, pdfUrl: `/quotes/${file}`, itemsCount: lines.length, emailedCustomer });
  } catch (error) {
    console.error("Quote error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/quotes", (req, res) => {
  try {
    const rows = db.prepare("SELECT id, number, name, email, subtotal, shipping, total, pdf_file, created_at FROM quotes ORDER BY created_at DESC LIMIT 100").all();
    res.json({ quotes: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Serve generated quote PDFs
app.use("/quotes", express.static(QUOTES_DIR));

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

// Knowledge / corrections ("teach Frikkie")
app.get("/api/admin/knowledge", (req, res) => {
  try {
    const rows = db.prepare("SELECT id, rule, active, source, conversation_id, created_at FROM knowledge ORDER BY created_at DESC").all();
    res.json({ knowledge: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post("/api/admin/knowledge", (req, res) => {
  try {
    const { rule, source, conversationId } = req.body;
    if (!rule || !rule.trim()) return res.status(400).json({ error: "Rule text required" });
    const id = uuidv4();
    db.prepare("INSERT INTO knowledge (id, rule, active, source, conversation_id, created_at) VALUES (?, ?, 1, ?, ?, ?)")
      .run(id, rule.trim(), source === "chat" ? "chat" : "manual", conversationId || null, new Date().toISOString());
    res.json({ ok: true, id });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post("/api/admin/knowledge/:id", (req, res) => {
  try {
    const { rule, active } = req.body;
    if (typeof rule === "string" && rule.trim()) db.prepare("UPDATE knowledge SET rule = ? WHERE id = ?").run(rule.trim(), req.params.id);
    if (typeof active === "boolean") db.prepare("UPDATE knowledge SET active = ? WHERE id = ?").run(active ? 1 : 0, req.params.id);
    const row = db.prepare("SELECT id, rule, active, source, conversation_id, created_at FROM knowledge WHERE id = ?").get(req.params.id);
    res.json({ ok: true, rule: row });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.delete("/api/admin/knowledge/:id", (req, res) => {
  try { db.prepare("DELETE FROM knowledge WHERE id = ?").run(req.params.id); res.json({ ok: true }); }
  catch (error) { res.status(500).json({ error: error.message }); }
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
    await emailTransporter.sendMail({ from: MAIL_FROM, to: process.env.SUPPORT_EMAIL, subject: `Frikkie Escalation - ${reason}`, text: `Customer: ${email}\n\nReason: ${reason}\n\nChat:\n\n${chatHistory}` });
    if (email) await emailTransporter.sendMail({ from: MAIL_FROM, to: email, subject: "We've received your request", text: `Hi,\n\nWe've received your request and our team will be in touch shortly.\n\nBest,\nFrikkie` });
    res.json({ success: true, escalationId: escId });
  } catch (error) { console.error("Escalation error:", error); res.status(500).json({ error: error.message }); }
});

// ============================================================
// DAILY SUMMARY
// ============================================================
const DAILY_SUMMARY_HOUR = parseInt(process.env.DAILY_SUMMARY_HOUR || "17", 10); // hour in SAST (UTC+2)
const SUMMARY_EMAIL = process.env.DAILY_SUMMARY_EMAIL || process.env.SUPPORT_EMAIL || MAIL_FROM;
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
    from: MAIL_FROM,
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
  ensureLogo();
});
