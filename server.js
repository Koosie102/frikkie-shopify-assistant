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
    origin: process.env.STORE_URL || "*",
    credentials: true,
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

// Frikkie's system prompt
const FRIKKIE_SYSTEM_PROMPT = `You are Frikkie, a friendly South African customer service AI assistant for a Shopify store specializing in 4x4 auxiliary lighting and outdoor gear.

**Your Personality:**
- Helpful, warm, and genuine
- South African expressions: "Howzit!", "Ja nee!", "Lekker!", use them naturally
- Expert on products you sell
- Honest - say when you don't know something
- Friendly, conversational tone
- References: You have 40+ years experience with 4x4s

**Your Capabilities:**
- Answer detailed product questions with specs
- Look up customer orders and provide tracking info
- Check product availability
- Make recommendations
- Troubleshoot issues
- Provide installation tips
- Handle complaints professionally

**Important Guidelines:**
1. Always try to find customer orders and provide specific tracking status
2. Reference actual product specs from the catalog
3. Ask for order number if needed
4. Keep responses concise but helpful
5. Offer to escalate for complex issues (refunds, complaints)
6. Use web search when needed - ask customer first

**Current Store:**
- Store: ${process.env.STORE_URL}
- Specializes in: 4x4 auxiliary lighting and outdoor gear`;

// Shopify GraphQL Helper
async function shopifyGraphQL(query, variables = {}) {
  const response = await axios.post(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    { query, variables },
    {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
    }
  );
  return response.data;
}

// Get products from Shopify
async function getProducts() {
  const query = `{
    products(first: 50) {
      edges {
        node {
          id
          title
          description
          variants(first: 10) {
            edges {
              node {
                title
                price
              }
            }
          }
        }
      }
    }
  }`;
  const result = await shopifyGraphQL(query);
  return result.data?.products?.edges || [];
}

// Get order by email
async function getOrderByEmail(email) {
  const query = `{
    orders(first: 10, query: "email:${email}") {
      edges {
        node {
          id
          orderNumber
          email
          createdAt
          fulfillmentOrders(first: 5) {
            edges {
              node {
                status
                lineItems(first: 10) {
                  edges {
                    node {
                      lineItem {
                        title
                        quantity
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;
  const result = await shopifyGraphQL(query);
  return result.data?.orders?.edges || [];
}

// Chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { message, conversationId, email, orderNumber } = req.body;

    // Create or get conversation
    let convoId = conversationId;
    if (!convoId) {
      convoId = uuidv4();
      const stmt = db.prepare(
        "INSERT INTO conversations (id, email, order_number) VALUES (?, ?, ?)"
      );
      stmt.run(convoId, email, orderNumber);
    }

    // Get conversation history
    const messageStmt = db.prepare(
      "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at"
    );
    const history = messageStmt.all(convoId);

    // Prepare messages for Claude
    const messages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: message },
    ];

    // Call Claude API
    const response = await client.messages.create({
      model: "claude-opus-4-1",
      max_tokens: 1024,
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

    res.json({
      conversationId: convoId,
      message: assistantMessage,
      cost: cost,
    });
  } catch (error) {
    console.error("Chat error:", error);
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

// Serve frontend
app.get("/", (req, res) => {
  res.send("Frikkie Chat API is running!");
});

app.get("/api/products", async (req, res) => {
  try {
    const products = await getProducts();
    res.json({ products });
  } catch (error) {
    console.error("Products error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/order/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const orders = await getOrderByEmail(email);
    res.json({ orders });
  } catch (error) {
    console.error("Order lookup error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Admin dashboard data
app.get("/api/admin/stats", (req, res) => {
  try {
    const convCount = db.prepare("SELECT COUNT(*) as count FROM conversations");
    const msgCount = db.prepare("SELECT COUNT(*) as count FROM messages");
    const totalCost = db.prepare("SELECT SUM(cost) as total FROM messages");

    res.json({
      conversations: convCount.get().count,
      messages: msgCount.get().count,
      totalCost: totalCost.get().total || 0,
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🎩 Frikkie is running on port ${PORT}`);
});
