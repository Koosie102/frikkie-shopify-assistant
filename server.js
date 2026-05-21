import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import nodemailer from "nodemailer";
import bodyParser from "body-parser";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(express.json());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(cors({ origin: "*", credentials: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Accept"] }));

const client = new Anthropic();

// Database setup
const DATABASE_PATH = process.env.DATABASE_PATH || "./frikkie.db";
const db = new Database(DATABASE_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
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
`);

// Email config
const emailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASSWORD,
  },
});

const COST_PER_1K_INPUT = 0.003;
const COST_PER_1K_OUTPUT = 0.015;

function calculateCost(inputTokens, outputTokens) {
  return (inputTokens / 1000) * COST_PER_1K_INPUT + (outputTokens / 1000) * COST_PER_1K_OUTPUT;
}

const FRIKKIE_SYSTEM = `You are Frikkie, a friendly South African 4x4 lighting expert for 4x4 Factory SA.

**Keep it SHORT - 2-3 sentences max!**
- Be direct and helpful
- Use South African expressions naturally
- Mention product names (ALTIQ, ULTRA, STEDI) so the widget can add helpful links
- Help with recommendations and store navigation`;

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Home page
app.get("/", (req, res) => {
  res.json({ status: "Frikkie is running!", version: "1.0.0" });
});

// Main chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { message, conversationId, email, orderNumber } = req.body;

    if (!message) return res.status(400).json({ error: "Message required" });

    let convoId = conversationId;
    if (!convoId) {
      convoId = uuidv4();
      db.prepare("INSERT INTO conversations (id, email, order_number) VALUES (?, ?, ?)").run(
        convoId, email || "guest@example.com", orderNumber || ""
      );
    }

    // Get last 10 messages for context
    const history = db.prepare(
      "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 10"
    ).all(convoId).reverse().map((m) => ({ role: m.role, content: m.content }));

    const messages = [...history, { role: "user", content: message }];

    const response = await client.messages.create({
      model: "claude-opus-4-1",
      max_tokens: 500,
      system: FRIKKIE_SYSTEM,
      messages: messages,
    });

    const assistantMessage = response.content[0].type === "text" ? response.content[0].text : "";
    const cost = calculateCost(response.usage.input_tokens, response.usage.output_tokens);

    // Save messages
    db.prepare("INSERT INTO messages (id, conversation_id, role, content, tokens_used, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      uuidv4(), convoId, "user", message, response.usage.input_tokens, cost, new Date().toISOString()
    );
    db.prepare("INSERT INTO messages (id, conversation_id, role, content, tokens_used, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      uuidv4(), convoId, "assistant", assistantMessage, response.usage.output_tokens, cost, new Date().toISOString()
    );

    res.json({ conversationId: convoId, message: assistantMessage, cost: cost });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: error.message || "Server error" });
  }
});

// Admin stats
app.get("/api/admin/stats", (req, res) => {
  try {
    const convCount = db.prepare("SELECT COUNT(*) as count FROM conversations").get();
    const msgCount = db.prepare("SELECT COUNT(*) as count FROM messages").get();
    const totalCost = db.prepare("SELECT SUM(cost) as total FROM messages").get();

    res.json({
      conversations: convCount.count || 0,
      messages: msgCount.count || 0,
      totalCost: totalCost.total || 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin conversations
app.get("/api/admin/conversations", (req, res) => {
  try {
    const conversations = db.prepare(`
      SELECT c.id, c.email, c.order_number, c.created_at, COUNT(m.id) as messages
      FROM conversations c
      LEFT JOIN messages m ON c.id = m.conversation_id
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT 50
    `).all();
    res.json({ conversations });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Escalation endpoint
app.post("/api/escalate", async (req, res) => {
  try {
    const { conversationId, reason, email } = req.body;

    const messages = db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at").all(conversationId);
    const chatHistory = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");

    const escId = uuidv4();
    db.prepare("INSERT INTO escalations (id, conversation_id, reason) VALUES (?, ?, ?)").run(escId, conversationId, reason);

    await emailTransporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.SUPPORT_EMAIL,
      subject: `Frikkie Escalation - ${reason}`,
      text: `Customer: ${email}\n\nReason: ${reason}\n\nChat:\n\n${chatHistory}`,
    });

    await emailTransporter.sendMail({
      from: process.env.GMAIL_USER,
      to: email,
      subject: "We've received your request",
      text: `Hi,\n\nWe've received your escalation and our team will be in touch shortly.\n\nBest,\nFrikkie`,
    });

    res.json({ success: true, escalationId: escId });
  } catch (error) {
    console.error("Escalation error:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🎩 Frikkie is running on port ${PORT}`);
  console.log(`https://frikkie-shopify-assistant-production.up.railway.app`);
});
