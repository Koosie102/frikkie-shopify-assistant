import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import nodemailer from "nodemailer";
import { Database } from "better-sqlite3";
import Database3 from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: process.env.STORE_URL || "*",
    credentials: true,
  })
);

const client = new Anthropic();

// Initialize SQLite database for chat history
const db = new Database3(process.env.DATABASE_PATH || "frikkie.db");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    customer_email TEXT,
    customer_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved INTEGER DEFAULT 0,
    escalated INTEGER DEFAULT 0,
    escalation_email TEXT,
    total_cost REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    sender TEXT,
    content TEXT,
    tokens_used INTEGER,
    cost REAL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );

  CREATE TABLE IF NOT EXISTS web_searches (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    query TEXT,
    results TEXT,
    cost REAL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );

  CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    customer_email TEXT,
    issue TEXT,
    chat_history TEXT,
    resolved_by TEXT,
    resolved_at DATETIME,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
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

// Supplier URLs (configurable)
const SUPPLIER_URLS = (process.env.SUPPLIER_URLS || "")
  .split(",")
  .filter((url) => url.trim());

// Enhanced system prompt with web search capability
const FRIKKIE_SYSTEM_PROMPT = `You are Frikkie, a friendly and knowledgeable customer service AI assistant for a Shopify store specializing in 4x4 auxiliary lighting and outdoor gear.

**Your Personality:**
- You're helpful, warm, and genuinely interested in solving customer problems
- You have a South African personality - use natural, friendly language
- You're an expert on the products you sell - know specs, compatibility, installation tips
- You're honest - if you don't know something, say so rather than guessing
- You can make friendly jokes and use conversational tone
- You always put the customer's needs first

**Your Capabilities:**
- Answer detailed product questions with specs and compatibility info
- Look up customer orders and provide tracking information
- Check inventory and stock status
- Make product recommendations based on customer needs
- Troubleshoot common issues
- Provide installation or usage tips
- Handle returns, exchanges, and complaints professionally

**Web Search & External Resources:**
- You have access to your product catalog first (use this whenever possible)
- If you don't have enough info in your catalog, you can suggest searching external resources
- NEVER search unprompted - always ask the customer first with the message:
  "I can't find enough info on our website and database to help with this question, but I can search other resources if you would like. Should I do that?"
- Wait for customer approval before searching
- For product-related questions, check supplier websites first (like STEDI for lighting specs)
- Only use general web search as a last resort
- Always cite where info came from

**Escalation Handling:**
- If a query is complex, emotional, involves complaints, or needs human judgment, offer to escalate
- Say something like: "This sounds important - let me make sure our team handles this properly. Can I escalate this to our support team?"
- Be professional and empathetic when escalating
- Summarize the key issue clearly so your team understands

**Important Guidelines:**
1. Always be honest about what you know and don't know
2. Keep responses concise but helpful
3. If something requires human intervention, offer to escalate
4. Be professional but never robotic
5. Never make up product specs or pricing - use actual data only
`;

// Helper: Make Shopify GraphQL query
async function shopifyQuery(query, variables = {}) {
  try {
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

    if (response.data.errors) {
      console.error("Shopify GraphQL Error:", response.data.errors);
      return null;
    }

    return response.data.data;
  } catch (error) {
    console.error("Shopify API Error:", error.message);
    return null;
  }
}

// Web search function
async function webSearch(query) {
  const searchResults = [];
  let totalCost = 0;

  try {
    // Try supplier websites first
    for (const url of SUPPLIER_URLS) {
      try {
        const response = await axios.get(url, { timeout: 5000 });
        if (response.data.includes(query)) {
          searchResults.push({
            source: url,
            type: "supplier",
            snippet: `Found on ${url}`,
          });
        }
      } catch (e) {
        // Skip if supplier site doesn't respond
      }
    }

    // If no supplier results, use general search (via a simple approach)
    // Note: For production, you'd use a proper search API like SerpAPI or Google Custom Search
    if (searchResults.length === 0) {
      // Placeholder for actual web search - would use an API in production
      searchResults.push({
        source: "Web Search",
        type: "general",
        snippet: `Search results for: ${query}`,
      });
      totalCost = 0.05; // Approximate cost for web search
    }

    return { results: searchResults, cost: totalCost };
  } catch (error) {
    console.error("Web search error:", error);
    return { results: [], cost: 0 };
  }
}

// Fetch all products
async function getProductCatalog() {
  const query = `
    query {
      products(first: 100) {
        edges {
          node {
            id
            title
            handle
            description
            priceRange {
              minVariantPrice {
                amount
              }
              maxVariantPrice {
                amount
              }
            }
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  price
                  sku
                  barcode
                  inventoryQuantity
                  selectedOptions {
                    name
                    value
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyQuery(query);
  if (!data) return null;

  return data.products.edges.map((edge) => ({
    id: edge.node.id,
    title: edge.node.title,
    handle: edge.node.handle,
    description: edge.node.description,
    priceRange: edge.node.priceRange,
    variants: edge.node.variants.edges.map((v) => ({
      id: v.node.id,
      title: v.node.title,
      price: v.node.price,
      sku: v.node.sku,
      stock: v.node.inventoryQuantity,
      options: v.node.selectedOptions,
    })),
  }));
}

// Fetch customer orders
async function getCustomerOrders(email, orderNumber = null) {
  if (orderNumber) {
    const query = `
      query {
        orders(first: 1, query: "name:${orderNumber}") {
          edges {
            node {
              id
              name
              orderNumber
              createdAt
              email
              phone
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              fulfillmentOrders(first: 5) {
                edges {
                  node {
                    id
                    status
                    fulfillments(first: 1) {
                      edges {
                        node {
                          id
                          status
                          trackingInfo {
                            number
                            company
                            url
                          }
                          createdAt
                        }
                      }
                    }
                    lineItems(first: 10) {
                      edges {
                        node {
                          id
                          quantity
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
      }
    `;

    return await shopifyQuery(query);
  }

  if (email) {
    const query = `
      query {
        orders(first: 10, query: "email:${email}") {
          edges {
            node {
              id
              name
              orderNumber
              createdAt
              email
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              fulfillmentOrders(first: 5) {
                edges {
                  node {
                    id
                    status
                    fulfillments(first: 1) {
                      edges {
                        node {
                          id
                          status
                          trackingInfo {
                            number
                            company
                            url
                          }
                          createdAt
                        }
                      }
                    }
                    lineItems(first: 10) {
                      edges {
                        node {
                          id
                          quantity
                          lineItem {
                            title
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
      }
    `;

    return await shopifyQuery(query);
  }

  return null;
}

// Send escalation email
async function sendEscalationEmail(
  customerEmail,
  customerName,
  issue,
  chatHistory
) {
  try {
    await emailTransporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.SUPPORT_EMAIL,
      subject: `[Frikkie Escalation] ${customerName} - ${issue.substring(0, 50)}`,
      html: `
        <h2>New Escalation from Frikkie</h2>
        <p><strong>Customer:</strong> ${customerName} (${customerEmail})</p>
        <p><strong>Issue:</strong> ${issue}</p>
        <hr>
        <h3>Chat History:</h3>
        <pre>${chatHistory}</pre>
        <hr>
        <p>Please reply to this customer at ${customerEmail}</p>
      `,
    });

    // Send customer confirmation
    await emailTransporter.sendMail({
      from: process.env.GMAIL_USER,
      to: customerEmail,
      subject: "We've received your support request",
      html: `
        <h2>Hi ${customerName},</h2>
        <p>Thanks for reaching out! Your question has been forwarded to our support team.</p>
        <p>We'll get back to you within 24 hours.</p>
        <p>Best regards,<br>Frikkie & The Team</p>
      `,
    });

    return true;
  } catch (error) {
    console.error("Email send error:", error);
    return false;
  }
}

// Calculate token cost
function calculateTokenCost(inputTokens, outputTokens) {
  const INPUT_COST_PER_1K = 0.003;
  const OUTPUT_COST_PER_1K = 0.015;
  return (inputTokens * INPUT_COST_PER_1K) / 1000 + (outputTokens * OUTPUT_COST_PER_1K) / 1000;
}

// Main chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { sessionId, message, customerEmail, orderNumber, approveSearch } =
      req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    // Create or get conversation
    let conversationData = db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(sessionId);

    if (!conversationData) {
      const conversationId = sessionId;
      db.prepare(
        "INSERT INTO conversations (id, customer_email) VALUES (?, ?)"
      ).run(conversationId, customerEmail || null);
      conversationData = { id: conversationId };
    }

    // Get conversation history
    const messages = db
      .prepare(
        "SELECT sender, content FROM messages WHERE conversation_id = ? ORDER BY timestamp"
      )
      .all(sessionId)
      .map((m) => ({ role: m.sender, content: m.content }));

    // Fetch context data
    let contextData = "\n**Available Context:**\n";

    // Get product catalog
    const products = await getProductCatalog();
    if (products) {
      contextData += `\n**Product Catalog (${products.length} products):**\n`;
      products.forEach((p) => {
        contextData += `- ${p.title}: $${p.priceRange.minVariantPrice.amount}-$${p.priceRange.maxVariantPrice.amount}\n`;
        contextData += `  ${p.description.substring(0, 80)}...\n`;
      });
    }

    // Get customer orders if email provided
    if (customerEmail || orderNumber) {
      const orderData = await getCustomerOrders(customerEmail, orderNumber);
      if (orderData && orderData.orders && orderData.orders.edges.length > 0) {
        contextData += `\n**Customer Orders:**\n`;
        orderData.orders.edges.forEach((edge) => {
          const order = edge.node;
          contextData += `- Order #${order.orderNumber}: $${order.totalPriceSet.shopMoney.amount}\n`;
          if (
            order.fulfillmentOrders.edges.length > 0 &&
            order.fulfillmentOrders.edges[0].node.fulfillments.edges.length > 0
          ) {
            const tracking = order.fulfillmentOrders.edges[0].node.fulfillments.edges[0].node.trackingInfo;
            if (tracking) {
              contextData += `  Tracking: ${tracking.company} #${tracking.number}\n`;
            }
          }
        });
      }
    }

    // Handle web search if approved
    let searchResults = "";
    if (
      approveSearch &&
      !message.toLowerCase().includes("search") &&
      !message.toLowerCase().includes("other resources")
    ) {
      const search = await webSearch(message);
      if (search.results.length > 0) {
        searchResults = "\n**Search Results:**\n";
        search.results.forEach((r) => {
          searchResults += `- ${r.source}: ${r.snippet}\n`;
        });

        // Log search
        db.prepare(
          "INSERT INTO web_searches (id, conversation_id, query, results, cost) VALUES (?, ?, ?, ?, ?)"
        ).run(
          uuidv4(),
          sessionId,
          message,
          JSON.stringify(search.results),
          search.cost
        );
      }
    }

    // Add user message to history
    messages.push({ role: "user", content: message });

    // Get response from Claude
    const response = await client.messages.create({
      model: "claude-opus-4-1",
      max_tokens: 1024,
      system: FRIKKIE_SYSTEM_PROMPT + contextData + searchResults,
      messages,
    });

    const assistantMessage = response.content[0].text;

    // Calculate cost
    const tokenCost = calculateTokenCost(
      response.usage.input_tokens,
      response.usage.output_tokens
    );

    // Store messages in database
    const msgId = uuidv4();
    db.prepare(
      "INSERT INTO messages (id, conversation_id, sender, content, tokens_used, cost) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      msgId,
      sessionId,
      "assistant",
      assistantMessage,
      response.usage.output_tokens,
      tokenCost
    );

    db.prepare(
      "INSERT INTO messages (id, conversation_id, sender, content, tokens_used, cost) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      uuidv4(),
      sessionId,
      "user",
      message,
      response.usage.input_tokens,
      calculateTokenCost(response.usage.input_tokens, 0)
    );

    // Check if escalation is needed
    const escalationKeywords = [
      "escalate",
      "complex",
      "complaint",
      "angry",
      "frustrated",
      "help",
      "need to speak",
    ];
    const needsEscalation = escalationKeywords.some((keyword) =>
      assistantMessage.toLowerCase().includes(keyword)
    );

    res.json({
      response: assistantMessage,
      sessionId,
      cost: tokenCost,
      needsSearch:
        assistantMessage.includes(
          "I can't find enough info on our website and database"
        ) && !approveSearch,
      escalationSuggested: needsEscalation,
    });
  } catch (error) {
    console.error("Chat Error:", error);
    res.status(500).json({
      error: "Frikkie hit a snag! Please try again.",
      details: error.message,
    });
  }
});

// Escalation endpoint
app.post("/api/escalate", async (req, res) => {
  try {
    const { sessionId, customerEmail, customerName, issue } = req.body;

    // Get chat history
    const messages = db
      .prepare(
        "SELECT sender, content, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp"
      )
      .all(sessionId);

    const chatHistory = messages
      .map((m) => `[${m.timestamp}] ${m.sender}: ${m.content}`)
      .join("\n");

    // Send escalation email
    const emailSent = await sendEscalationEmail(
      customerEmail,
      customerName,
      issue,
      chatHistory
    );

    if (emailSent) {
      // Record escalation in database
      db.prepare(
        "INSERT INTO escalations (id, conversation_id, customer_email, issue, chat_history) VALUES (?, ?, ?, ?, ?)"
      ).run(uuidv4(), sessionId, customerEmail, issue, chatHistory);

      // Update conversation
      db.prepare(
        "UPDATE conversations SET escalated = 1 WHERE id = ?"
      ).run(sessionId);

      res.json({
        success: true,
        message: `We've forwarded your question to our team. You'll hear back soon!`,
      });
    } else {
      res.status(500).json({ error: "Failed to send escalation email" });
    }
  } catch (error) {
    console.error("Escalation Error:", error);
    res.status(500).json({ error: "Escalation failed" });
  }
});

// Admin endpoints
app.get("/api/admin/stats", (req, res) => {
  try {
    const stats = {
      totalConversations: db
        .prepare("SELECT COUNT(*) as count FROM conversations")
        .get().count,
      totalMessages: db.prepare("SELECT COUNT(*) as count FROM messages").get()
        .count,
      totalCost: db
        .prepare("SELECT SUM(cost) as total FROM messages")
        .get().total || 0,
      escalations: db
        .prepare("SELECT COUNT(*) as count FROM escalations")
        .get().count,
      avgMessagesPerConversation: db
        .prepare(
          "SELECT AVG(message_count) as avg FROM (SELECT COUNT(*) as message_count FROM messages GROUP BY conversation_id)"
        )
        .get().avg || 0,
    };

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: "Failed to get stats" });
  }
});

app.get("/api/admin/conversations", (req, res) => {
  try {
    const conversations = db
      .prepare(
        `SELECT c.*, COUNT(m.id) as message_count, SUM(m.cost) as total_cost
       FROM conversations c
       LEFT JOIN messages m ON c.id = m.conversation_id
       GROUP BY c.id
       ORDER BY c.created_at DESC
       LIMIT 50`
      )
      .all();

    res.json(conversations);
  } catch (error) {
    res.status(500).json({ error: "Failed to get conversations" });
  }
});

app.get("/api/admin/conversation/:id", (req, res) => {
  try {
    const messages = db
      .prepare(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp"
      )
      .all(req.params.id);

    const conversation = db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(req.params.id);

    res.json({ conversation, messages });
  } catch (error) {
    res.status(500).json({ error: "Failed to get conversation" });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "Frikkie is ready to help! 🚙" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Frikkie's enhanced backend running on port ${PORT}`);
});
