"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Role = "user" | "assistant";
type Msg = { role: Role; content: string };

type SessionState = {
  mode: "friend" | "romantic" | "explicit";
  adult_verified?: boolean;
  romance_consented?: boolean;
  explicit_consented?: boolean;
  pending_consent?: "romance" | "adult" | "explicit" | null;
  model?: string;
};

const MODE_LABELS: Record<SessionState["mode"], string> = {
  friend: "Friend",
  romantic: "Romantic",
  explicit: "Intimate (18+)",
};

export default function Home() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [sessionState, setSessionState] = useState<SessionState>({
    mode: "friend",
    model: "gpt-4o",
    adult_verified: false,
    romance_consented: false,
    explicit_consented: false,
    pending_consent: null,
  });
  const [loading, setLoading] = useState(false);
  const [showDebug, setShowDebug] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const pendingConsent = sessionState.pending_consent ?? null;

  const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
if (!API_BASE) {
  throw new Error("Missing NEXT_PUBLIC_API_BASE_URL");
}

async function callChat(
  userText: string,
  nextMessages: Msg[],
  nextState?: SessionState
) {
  const stateToSend = nextState ?? sessionState;

  const res = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: userText,
      session_state: stateToSend,
      history: nextMessages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Backend error ${res.status}: ${errText}`);
  }

  return res.json();
}

  async function send(userTextOverride?: string) {
    if (loading) return;

    const userText = (userTextOverride ?? input).trim();
    if (!userText) return;

    const nextMessages: Msg[] = [
      ...messages,
      { role: "user", content: userText },
    ];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      const data = await callChat(userText, nextMessages);
      setMessages([...nextMessages, { role: "assistant", content: data.reply }]);
      setSessionState(data.session_state);
    } catch {
      setMessages([
        ...nextMessages,
        { role: "assistant", content: "⚠️ Error talking to backend." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function handleConsent(choice: "yes" | "no") {
    // send a short consent reply into the same conversation
    await send(choice);
  }

  function requestMode(mode: SessionState["mode"]) {
    // UI request only. Backend gates still apply.
    const hint =
      mode === "friend"
        ? "Let’s stay in Friend Mode."
        : mode === "romantic"
        ? "Can we switch to Romantic Mode?"
        : "Can we switch to Explicit Mode?";

    // Optimistically set mode so UI pill highlights,
    // but backend may revert if consent isn't granted.
    const optimisticState = { ...sessionState, mode };
    setSessionState(optimisticState);
    send(hint);
  }

  const modePills = useMemo(() => (["friend", "romantic", "explicit"] as const), []);

  return (
    <main
      style={{
        maxWidth: 880,
        margin: "24px auto",
        padding: "0 16px",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      {/* Header */}
      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <div
          aria-hidden
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",      // ✅ circular frame
            overflow: "hidden",
            boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
            background: "white",
            display: "grid",
            placeItems: "center",
          }}
        >
          <img
            src="/ai-haven-heart.png"   // or your generated PNG filename
            alt="AI Haven 4U Heart"
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",       // ✅ fills circle without distortion
              objectPosition: "center",
            }}
          />
        </div>


        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>AI Haven 4U</h1>
          <div style={{ fontSize: 13, color: "#555" }}>
            Companion MVP · reducing loneliness with consent-first intimacy
          </div>
        </div>
      </header>

      {/* Mode pills */}
      <section style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {modePills.map((m) => {
          const active = sessionState.mode === m;
          return (
            <button
              key={m}
              onClick={() => requestMode(m)}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                border: active ? "1px solid #222" : "1px solid #ccc",
                background: active ? "#111" : "white",
                color: active ? "white" : "#111",
                fontSize: 13,
                cursor: "pointer",
              }}
              title={`Request ${MODE_LABELS[m]} Mode`}
            >
              {MODE_LABELS[m]}
            </button>
          );
        })}
        <div style={{ marginLeft: "auto", fontSize: 12, color: "#666", alignSelf: "center" }}>
          Current: <b>{MODE_LABELS[sessionState.mode]}</b>
        </div>
      </section>

      {/* Chat window */}
      <section
        style={{
          border: "1px solid #e5e5e5",
          borderRadius: 14,
          padding: 12,
          minHeight: 420,
          background: "#fafafa",
        }}
      >
        {messages.length === 0 && (
          <div style={{ color: "#777", fontSize: 14, padding: 12 }}>
            Say hi. I’m here with you.
          </div>
        )}

        {messages.map((m, i) => {
          const isUser = m.role === "user";
          return (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: isUser ? "flex-end" : "flex-start",
                margin: "8px 0",
              }}
            >
              <div
                style={{
                  maxWidth: "75%",
                  padding: "10px 12px",
                  borderRadius: 12,
                  background: isUser ? "#111" : "white",
                  color: isUser ? "white" : "#111",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {m.content}
              </div>
            </div>
          );
        })}

        {loading && (
          <div style={{ display: "flex", justifyContent: "flex-start", marginTop: 8 }}>
            <div
              style={{
                padding: "8px 10px",
                borderRadius: 12,
                background: "white",
                color: "#444",
                fontSize: 14,
              }}
            >
              Thinking…
            </div>
          </div>
        )}

        <div ref={scrollRef} />
      </section>

      {/* Input row */}
      <section style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Type here…"
          style={{
            flex: 1,
            padding: 12,
            borderRadius: 10,
            border: "1px solid #ccc",
            fontSize: 15,
          }}
        />
        <button
          onClick={() => send()}
          disabled={loading}
          style={{
            padding: "12px 16px",
            borderRadius: 10,
            border: "none",
            background: "#111",
            color: "white",
            fontWeight: 600,
            cursor: "pointer",
            opacity: loading ? 0.7 : 1,
          }}
        >
          Send
        </button>
      </section>

      {/* Safety footer */}
      <footer style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
        AI Haven 4U is a supportive companion, not a replacement for professional help.
        If you’re in danger, contact local emergency services.
      </footer>

      {/* Debug drawer */}
      <section style={{ marginTop: 12 }}>
        <button
          onClick={() => setShowDebug((v) => !v)}
          style={{
            fontSize: 12,
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid #ddd",
            background: "white",
            cursor: "pointer",
          }}
        >
          {showDebug ? "Hide" : "Show"} session debug
        </button>

        {showDebug && (
          <pre
            style={{
              marginTop: 8,
              fontSize: 12,
              background: "#0b0b0b",
              color: "#d7d7d7",
              padding: 10,
              borderRadius: 10,
              overflowX: "auto",
            }}
          >
{JSON.stringify(sessionState, null, 2)}
          </pre>
        )}
      </section>

      {/* Consent modal */}
      {pendingConsent && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 440,
              background: "white",
              borderRadius: 14,
              padding: 16,
              boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
            }}
          >
            <h3 style={{ marginTop: 0 }}>
              {pendingConsent === "romance" && "Opt into Romantic Mode?"}
              {pendingConsent === "adult" && "Confirm you’re 18+?"}
              {pendingConsent === "explicit" && "Opt into Explicit Mode?"}
            </h3>

            <p style={{ fontSize: 14, color: "#333" }}>
              {pendingConsent === "romance" && (
                <>We can be romantic only if you want that. You can say yes or no.</>
              )}
              {pendingConsent === "adult" && (
                <>I need to confirm you’re 18+ before any explicit adult conversation.</>
              )}
              {pendingConsent === "explicit" && (
                <>Explicit Mode is optional and consent-first. You can say yes or no.</>
              )}
            </p>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => handleConsent("no")}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #ccc",
                  background: "white",
                  cursor: "pointer",
                }}
              >
                No
              </button>
              <button
                onClick={() => handleConsent("yes")}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "none",
                  background: "#111",
                  color: "white",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
