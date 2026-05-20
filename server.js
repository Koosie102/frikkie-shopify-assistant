import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import Database from "better-sqlite3";
import nodemailer from "nodemailer";
import bodyParser from "body-parser";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(express.json());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(
  cors({
    origin: "*",
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
  })
);

const client = new Anthropic();

// Database setup
const DATABASE_PATH = process.env.DATABASE_PATH || "./frikkie.db";
const db = new Database(DATABASE_PATH);

// Initialize database tables
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

  CREATE TABLE IF NOT EXISTS web_searches (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    query TEXT,
    results TEXT,
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

// Shopify API config
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = "2024-01";

// Email config
const emailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASSWORD,
  },
});

// Cost tracking constants
const COST_PER_1K_INPUT_TOKENS = 0.003;
const COST_PER_1K_OUTPUT_TOKENS = 0.015;

function calculateCost(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1000) * COST_PER_1K_INPUT_TOKENS;
  const outputCost = (outputTokens / 1000) * COST_PER_1K_OUTPUT_TOKENS;
  return inputCost + outputCost;
}

// Frikkie's system prompt - SHORTER, TO THE POINT
const FRIKKIE_SYSTEM_PROMPT = `You are Frikkie, a friendly South African 4x4 lighting expert for 4x4 Factory SA.

**Your Personality:**
- Friendly, knowledgeable, and helpful
- South African expressions: "Howzit", "Ja nee", "Lekker" - use naturally
- Direct and concise - get to the point quickly
- Expert on ALTIQ, ULTRA, STEDI lighting products
- Helpful with product recommendations and store navigation

**IMPORTANT - Keep it SHORT:**
- Keep responses to 2-3 sentences max
- Be direct and helpful, not chatty
- Suggest products/pages when relevant
- Mention product names (ALTIQ, ULTRA, STEDI) so the widget can add helpful links

**You can help with:**
- Product questions and specifications
- Recommendations based on customer needs
- Directing to correct store pages/collections
- Installation tips
- Stock/availability questions

**Current Store:** 4x4 Factory SA (4x4-factory-sa.myshopify.com)
**Collections:** ALTIQ, ULTRA, STEDI lights, NEO SUDS
**Keep it brief and helpful!**`;

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Chat endpoint - MAIN ENDPOINT
app.post("/api/chat", async (req, res) => {
  try {
    console.log("Chat request received:", req.body);
    
    const { message, conversationId, email, orderNumber } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    // Create or get conversation
    let convoId = conversationId;
    if (!convoId) {
      convoId = uuidv4();
      const stmt = db.prepare(
        "INSERT INTO conversations (id, email, order_number) VALUES (?, ?, ?)"
      );
      stmt.run(convoId, email || "guest@example.com", orderNumber || "");
    }

    // Get conversation history (last 10 messages to keep context shorter)
    const messageStmt = db.prepare(
      "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 10"
    );
    const rawHistory = messageStmt.all(convoId);
    const history = rawHistory.reverse().map((m) => ({ role: m.role, content: m.content }));

    // Prepare messages for Claude
    const messages = [
      ...history,
      { role: "user", content: message },
    ];

    console.log(`Calling Claude with ${messages.length} messages...`);

    // Call Claude API with shorter max tokens for quicker responses
    const response = await client.messages.create({
      model: "claude-opus-4-1",
      max_tokens: 500, // Reduced from 1024 to keep responses shorter
      system: FRIKKIE_SYSTEM_PROMPT,
      messages: messages,
    });

    const assistantMessage =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Calculate cost
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const cost = calculateCost(inputTokens, outputTokens);

    // Save messages
    const insertMsg = db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, tokens_used, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    insertMsg.run(
      uuidv4(),
      convoId,
      "user",
      message,
      inputTokens,
      cost,
      new Date().toISOString()
    );
    insertMsg.run(
      uuidv4(),
      convoId,
      "assistant",
      assistantMessage,
      outputTokens,
      cost,
      new Date().toISOString()
    );

    console.log(`Response sent for conversation ${convoId}`);

    return res.json({
      conversationId: convoId,
      message: assistantMessage,
      cost: cost,
    });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Serve favicon and static responses
app.get("/", (req, res) => {
  res.json({ status: "Frikkie Chat API is running!", version: "1.0.0" });
});

app.get("/admin", (req, res) => {
  res.json({ message: "Admin dashboard - use /api/admin/stats" });
});

// Admin dashboard data
app.get("/api/admin/stats", (req, res) => {
  try {
    const convCount = db
      .prepare("SELECT COUNT(*) as count FROM conversations")
      .get();
    const msgCount = db.prepare("SELECT COUNT(*) as count FROM messages").get();
    const totalCost = db.prepare("SELECT SUM(cost) as total FROM messages").get();

    res.json({
      conversations: convCount.count,
      messages: msgCount.count,
      totalCost: totalCost.total || 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/conversations", (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT c.id, c.email, c.order_number, c.created_at, COUNT(m.id) as messages
      FROM conversations c
      LEFT JOIN messages m ON c.id = m.conversation_id
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT 50
    `);
    const conversations = stmt.all();
    res.json({ conversations });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Escalation endpoint
app.post("/api/escalate", async (req, res) => {
  try {
    const { conversationId, reason, email } = req.body;

    // Get conversation messages
    const messageStmt = db.prepare(
      "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at"
    );
    const messages = messageStmt.all(conversationId);

    // Create escalation record
    const escId = uuidv4();
    const insertEsc = db.prepare(
      "INSERT INTO escalations (id, conversation_id, reason) VALUES (?, ?, ?)"
    );
    insertEsc.run(escId, conversationId, reason);

    // Send email to support
    const chatHistory = messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n");

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: process.env.SUPPORT_EMAIL,
      subject: `Frikkie Escalation - ${reason}`,
      text: `Customer escalation from: ${email}\n\nReason: ${reason}\n\nChat History:\n\n${chatHistory}`,
    };

    await emailTransporter.sendMail(mailOptions);

    // Send confirmation to customer
    const customerMail = {
      from: process.env.GMAIL_USER,
      to: email,
      subject: "We've received your request",
      text: `Hi,\n\nWe've received your escalation request and our support team will be in touch shortly.\n\nBest regards,\nFrikkie`,
    };

    await emailTransporter.sendMail(customerMail);

    res.json({ success: true, escalationId: escId });
  } catch (error) {
    console.error("Escalation error:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🎩 Frikkie is running on port ${PORT}`);
  console.log(`API: https://frikkie-shopify-assistant-production.up.railway.app`);
  console.log(`Health check: https://frikkie-shopify-assistant-production.up.railway.app/health`);
});
