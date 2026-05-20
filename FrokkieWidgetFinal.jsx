import React, { useState, useRef, useEffect } from "react";
import FrokkieAvatarCharacter from "./FrokkieAvatarCharacter";

const FrokkieWidgetFinal = ({ apiUrl = "http://localhost:3001" }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([
    {
      id: 1,
      sender: "frikkie",
      text: "Howzit boet! 👋 I'm Frikkie, your friendly 4x4 expert. Need help with products, orders, or anything else? Just ask!",
      timestamp: new Date(),
      showSearchPrompt: false,
    },
  ]);
  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId] = useState(() => `session_${Date.now()}_${Math.random()}`);
  const [customerEmail, setCustomerEmail] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [showInfo, setShowInfo] = useState(false);
  const [showEscalation, setShowEscalation] = useState(false);
  const [escalationReason, setEscalationReason] = useState("");
  const [totalCost, setTotalCost] = useState(0);
  const messagesEndRef = useRef(null);
  const [pendingSearch, setPendingSearch] = useState(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = async (e) => {
    e.preventDefault();

    if (!inputValue.trim()) return;

    // Add user message to chat
    const userMessage = {
      id: messages.length + 1,
      sender: "user",
      text: inputValue,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue("");
    setLoading(true);

    try {
      const response = await fetch(`${apiUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId,
          message: inputValue,
          customerEmail: customerEmail || null,
          orderNumber: orderNumber || null,
          approveSearch: pendingSearch?.approved || false,
        }),
      });

      const data = await response.json();

      if (data.response) {
        // Check if this is a search prompt
        const isSearchPrompt = data.response.includes(
          "I can't find enough info on our website and database"
        );

        const assistantMessage = {
          id: messages.length + 2,
          sender: "frikkie",
          text: data.response,
          timestamp: new Date(),
          showSearchPrompt: isSearchPrompt && !data.approveSearch,
          cost: data.cost,
        };

        setMessages((prev) => [...prev, assistantMessage]);
        setTotalCost((prev) => prev + (data.cost || 0));

        if (isSearchPrompt) {
          setPendingSearch({
            messageId: assistantMessage.id,
            approved: false,
          });
        }

        if (data.escalationSuggested) {
          // Add prompt to escalate
          setTimeout(() => {
            setShowEscalation(true);
          }, 2000);
        }
      }
    } catch (error) {
      console.error("Error sending message:", error);
      const errorMessage = {
        id: messages.length + 2,
        sender: "frikkie",
        text: "Ag, something went wrong there! Please try again, hey.",
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    }

    setLoading(false);
  };

  const handleApproveSearch = async () => {
    if (!inputValue.trim()) {
      setInputValue("Ja nee, search away!");
    }
    setPendingSearch(null);
    // Re-send with approval
    handleSendMessage({
      preventDefault: () => {},
    });
  };

  const handleEscalate = async () => {
    try {
      const response = await fetch(`${apiUrl}/api/escalate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId,
          customerEmail: customerEmail || "unknown@example.com",
          customerName: customerEmail?.split("@")[0] || "Boet",
          issue: escalationReason,
        }),
      });

      const data = await response.json();

      if (data.success) {
        const confirmMessage = {
          id: messages.length + 1,
          sender: "frikkie",
          text: data.message,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, confirmMessage]);
        setShowEscalation(false);
        setEscalationReason("");
      }
    } catch (error) {
      console.error("Escalation error:", error);
    }
  };

  return (
    <>
      {/* Chat Widget Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          position: "fixed",
          bottom: "20px",
          right: "20px",
          width: "70px",
          height: "70px",
          borderRadius: "50%",
          backgroundColor: "#D4B896",
          color: "#333",
          border: "3px solid #8B5A2B",
          cursor: "pointer",
          fontSize: "32px",
          boxShadow: "0 4px 20px rgba(139, 90, 43, 0.4)",
          zIndex: 999,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "all 0.3s ease",
          fontWeight: "bold",
        }}
        title="Chat with Frikkie"
        onMouseOver={(e) => {
          e.target.style.transform = "scale(1.1)";
          e.target.style.boxShadow = "0 6px 30px rgba(139, 90, 43, 0.6)";
        }}
        onMouseOut={(e) => {
          e.target.style.transform = "scale(1)";
          e.target.style.boxShadow = "0 4px 20px rgba(139, 90, 43, 0.4)";
        }}
      >
        {isOpen ? "✕" : "🚙"}
      </button>

      {/* Chat Window */}
      {isOpen && (
        <div
          style={{
            position: "fixed",
            bottom: "100px",
            right: "20px",
            width: "500px",
            maxHeight: "750px",
            backgroundColor: "white",
            borderRadius: "16px",
            boxShadow: "0 8px 50px rgba(0, 0, 0, 0.2)",
            display: "flex",
            flexDirection: "column",
            zIndex: 1000,
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            overflow: "hidden",
          }}
        >
          {/* Avatar Header with gradient */}
          <div
            style={{
              background: "linear-gradient(135deg, #D4B896 0%, #C9A876 100%)",
              padding: "16px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              borderRadius: "16px 16px 0 0",
              borderBottom: "3px solid #8B5A2B",
            }}
          >
            <div style={{ flex: 1 }}>
              <h3
                style={{
                  margin: "0 0 4px 0",
                  fontSize: "20px",
                  color: "#333",
                  fontWeight: "bold",
                }}
              >
                Frikkie 🚙
              </h3>
              <p
                style={{
                  margin: "0 0 4px 0",
                  fontSize: "12px",
                  color: "#666",
                  fontStyle: "italic",
                }}
              >
                "Jou vriendelijke AI assistant"
              </p>
              <p
                style={{
                  margin: "0",
                  fontSize: "11px",
                  color: "#777",
                }}
              >
                Your 4x4 legend • Garden Route
              </p>
              {totalCost > 0 && (
                <p
                  style={{
                    margin: "4px 0 0 0",
                    fontSize: "10px",
                    opacity: 0.7,
                    color: "#555",
                  }}
                >
                  Session: ${totalCost.toFixed(3)}
                </p>
              )}
            </div>
            <button
              onClick={() => setShowInfo(!showInfo)}
              style={{
                background: "none",
                border: "none",
                color: "#333",
                cursor: "pointer",
                fontSize: "20px",
                padding: "0",
              }}
              title="Info"
            >
              ℹ️
            </button>
          </div>

          {/* Avatar Display */}
          <div
            style={{
              backgroundColor: "#f9f5f0",
              padding: "12px",
              textAlign: "center",
              borderBottom: "1px solid #e0d5c7",
            }}
          >
            <FrokkieAvatarCharacter isLoading={loading} />
          </div>

          {/* Info Panel */}
          {showInfo && (
            <div
              style={{
                padding: "12px 16px",
                fontSize: "12px",
                backgroundColor: "#f9f9f9",
                borderBottom: "1px solid #eee",
                maxHeight: "120px",
                overflowY: "auto",
              }}
            >
              <p style={{ margin: "0 0 8px 0", fontWeight: "bold", color: "#333" }}>
                Order Tracking & Support
              </p>
              <input
                type="email"
                placeholder="Your email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px",
                  marginBottom: "8px",
                  border: "1px solid #ddd",
                  borderRadius: "4px",
                  fontSize: "12px",
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                }}
              />
              <input
                type="text"
                placeholder="Or order # (e.g., 1234)"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px",
                  border: "1px solid #ddd",
                  borderRadius: "4px",
                  fontSize: "12px",
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                }}
              />
            </div>
          )}

          {/* Messages */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              backgroundColor: "#fafafa",
            }}
          >
            {messages.map((msg) => (
              <div key={msg.id} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent:
                      msg.sender === "user" ? "flex-end" : "flex-start",
                    gap: "8px",
                  }}
                >
                  {msg.sender === "frikkie" && (
                    <div
                      style={{
                        width: "40px",
                        height: "40px",
                        borderRadius: "50%",
                        backgroundColor: "#D4B896",
                        border: "2px solid #8B5A2B",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#333",
                        fontSize: "22px",
                        flexShrink: 0,
                        boxShadow: "0 2px 8px rgba(139, 90, 43, 0.3)",
                      }}
                    >
                      🎩
                    </div>
                  )}
                  <div
                    style={{
                      maxWidth: "75%",
                      padding: "12px 14px",
                      borderRadius: "14px",
                      backgroundColor:
                        msg.sender === "user" ? "#D4B896" : "#ffffff",
                      color: msg.sender === "user" ? "#fff" : "#333",
                      wordWrap: "break-word",
                      fontSize: "14px",
                      lineHeight: "1.5",
                      boxShadow:
                        msg.sender === "user"
                          ? "0 2px 8px rgba(212, 184, 150, 0.4)"
                          : "0 1px 3px rgba(0, 0, 0, 0.1)",
                      border: msg.sender === "user" ? "1px solid #C9A876" : "1px solid #e0d5c7",
                    }}
                  >
                    {msg.text}
                  </div>
                </div>

                {/* Search Prompt */}
                {msg.showSearchPrompt && (
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      paddingLeft: "48px",
                      paddingRight: "10%",
                    }}
                  >
                    <button
                      onClick={handleApproveSearch}
                      style={{
                        padding: "8px 12px",
                        backgroundColor: "#D4B896",
                        color: "#333",
                        border: "1px solid #8B5A2B",
                        borderRadius: "6px",
                        fontSize: "12px",
                        cursor: "pointer",
                        fontWeight: "bold",
                        transition: "all 0.2s",
                      }}
                      onMouseOver={(e) => {
                        e.target.style.backgroundColor = "#C9A876";
                      }}
                      onMouseOut={(e) => {
                        e.target.style.backgroundColor = "#D4B896";
                      }}
                    >
                      Ja nee
                    </button>
                    <button
                      onClick={() => setPendingSearch(null)}
                      style={{
                        padding: "8px 12px",
                        backgroundColor: "#f0f0f0",
                        color: "#333",
                        border: "1px solid #ddd",
                        borderRadius: "6px",
                        fontSize: "12px",
                        cursor: "pointer",
                      }}
                    >
                      Nah
                    </button>
                  </div>
                )}
              </div>
            ))}

            {loading && (
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <div
                  style={{
                    width: "40px",
                    height: "40px",
                    borderRadius: "50%",
                    backgroundColor: "#D4B896",
                    border: "2px solid #8B5A2B",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#333",
                    fontSize: "22px",
                  }}
                >
                  🎩
                </div>
                <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      style={{
                        width: "8px",
                        height: "8px",
                        backgroundColor: "#8B5A2B",
                        borderRadius: "50%",
                        animation: `pulse 1.4s infinite`,
                        animationDelay: `${i * 0.2}s`,
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Escalation Modal */}
          {showEscalation && (
            <div
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                backgroundColor: "white",
                padding: "20px",
                borderRadius: "12px",
                boxShadow: "0 10px 40px rgba(0, 0, 0, 0.3)",
                zIndex: 1001,
                maxWidth: "90%",
              }}
            >
              <h3 style={{ margin: "0 0 12px 0", color: "#8B5A2B" }}>
                Need more help? 🎩
              </h3>
              <p style={{ margin: "0 0 12px 0", fontSize: "14px", color: "#666" }}>
                Let me get our team involved. What's the issue?
              </p>
              <textarea
                value={escalationReason}
                onChange={(e) => setEscalationReason(e.target.value)}
                placeholder="Tell us what we can help with..."
                style={{
                  width: "100%",
                  padding: "10px",
                  border: "1px solid #ddd",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontFamily: "inherit",
                  marginBottom: "12px",
                  boxSizing: "border-box",
                  minHeight: "60px",
                  resize: "none",
                }}
              />
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  onClick={handleEscalate}
                  style={{
                    flex: 1,
                    padding: "10px",
                    backgroundColor: "#D4B896",
                    color: "#333",
                    border: "1px solid #8B5A2B",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "12px",
                    fontWeight: "bold",
                  }}
                >
                  Get Support
                </button>
                <button
                  onClick={() => setShowEscalation(false)}
                  style={{
                    flex: 1,
                    padding: "10px",
                    backgroundColor: "#f0f0f0",
                    color: "#333",
                    border: "1px solid #ddd",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "12px",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Input */}
          <form
            onSubmit={handleSendMessage}
            style={{
              display: "flex",
              gap: "8px",
              padding: "12px 16px",
              borderTop: "1px solid #e0d5c7",
              backgroundColor: "#f9f5f0",
              borderRadius: "0 0 16px 16px",
            }}
          >
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Ask Frikkie..."
              disabled={loading}
              style={{
                flex: 1,
                padding: "10px 12px",
                border: "1px solid #ddd",
                borderRadius: "6px",
                fontSize: "14px",
                fontFamily: "inherit",
                outline: "none",
                transition: "border-color 0.2s",
              }}
              onFocus={(e) => {
                e.target.style.borderColor = "#8B5A2B";
              }}
              onBlur={(e) => {
                e.target.style.borderColor = "#ddd";
              }}
            />
            <button
              type="submit"
              disabled={loading || !inputValue.trim()}
              style={{
                padding: "10px 16px",
                backgroundColor: loading || !inputValue.trim() ? "#ccc" : "#D4B896",
                color: "#333",
                border: "1px solid #8B5A2B",
                borderRadius: "6px",
                cursor: loading || !inputValue.trim() ? "default" : "pointer",
                fontSize: "16px",
                fontWeight: "bold",
                transition: "background-color 0.2s",
              }}
            >
              →
            </button>
          </form>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 60%, 100% { opacity: 1; }
          30% { opacity: 0.2; }
        }
      `}</style>
    </>
  );
};

export default FrokkieWidgetFinal;
