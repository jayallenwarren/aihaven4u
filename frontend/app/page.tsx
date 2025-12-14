"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Role = "user" | "assistant";
type Msg = { role: Role; content: string };

type Mode = "friend" | "romantic" | "explicit";

type SessionState = {
  mode: Mode;
  adult_verified: boolean;
  romance_consented: boolean;
  explicit_consented: boolean;
  pending_consent: "romance" | "adult" | "explicit" | null;
  model: string;
};

const MODE_LABELS: Record<Mode, string> = {
  friend: "Friend",
  romantic: "Romantic",
  explicit: "Intimate (18+)",
};

type PlanName =
  | "Week - Trial"
  | "Weekly - Friend"
  | "Weekly - Romantic"
  | "Weekly - Intimate (18+)"
  | null;

const UPGRADE_URL = "https://www.aihaven4u.com/pricing-plans/list";

const ROMANTIC_ALLOWED_PLANS: PlanName[] = [
  "Week - Trial",
  "Weekly - Romantic",
  "Weekly - Intimate (18+)",
];

function allowedModesForPlan(planName: PlanName): Mode[] {
  const modes: Mode[] = ["friend"];

  if (ROMANTIC_ALLOWED_PLANS.includes(planName)) {
    modes.push("romantic");
  }

  if (planName === "Weekly - Intimate (18+)") {
    modes.push("explicit");
  }

  return modes;
}

/**
 * event.origin is the Wix parent origin (NOT Azure).
 * Allow production + Wix Editor Preview.
 */
function isAllowedOrigin(origin: string) {
  // Production
  if (origin === "https://aihaven4u.com") return true;
  if (origin === "https://www.aihaven4u.com") return true;

  // Wix Editor Preview
  if (origin === "https://editor.wix.com") return true;
  if (origin === "https://manage.wix.com") return true;

  // Preview/published site subdomains
  if (/^https:\/\/[a-z0-9-]+\.wixsite\.com$/i.test(origin)) return true;

  return false;
}

/** Lightweight intent detection to prevent prompt-based bypass. */
function isRomanticRequest(text: string) {
  const t = (text || "").toLowerCase();
  return /\bromance\b|\bromantic\b|\bflirt\b|\bflirty\b|\bdate\b|\bgirlfriend\b|\bboyfriend\b|\bkiss\b|\bmake out\b|\blove you\b/.test(
    t
  );
}

function isExplicitRequest(text: string) {
  const t = (text || "").toLowerCase();
  return /\bexplicit\b|\bintimate\b|\b18\+\b|\bnsfw\b|\bsex\b|\bfuck\b|\bnude\b|\bnaked\b|\borgasm\b|\bblowjob\b|\bbj\b|\bdeep throat\b|\bsquirt\b|\bpee\b|\bfart\b|\bpussy\b|\banal\b/.test(
    t
  );
}

/** Explicit outranks Romantic if both match. */
function requestedModeFromText(text: string): Mode | null {
  if (isExplicitRequest(text)) return "explicit";
  if (isRomanticRequest(text)) return "romantic";
  return null;
}

export default function Page() {
  const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);

  const [sessionState, setSessionState] = useState<SessionState>({
    mode: "friend",
    model: "gpt-4o",
    adult_verified: false,
    romance_consented: false,
    explicit_consented: false,
    pending_consent: null,
  });

  // From Wix
  const [planName, setPlanName] = useState<PlanName>(null);
  const [allowedModes, setAllowedModes] = useState<Mode[]>(["friend"]);

  const modePills = useMemo(() => ["friend", "romantic", "explicit"] as const, []);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // ✅ Markdown upgrade link
  function showUpgradeMessage(requestedMode: Mode) {
    const modeLabel = MODE_LABELS[requestedMode];

    const msg =
      `The requested ${modeLabel} mode is not available for your current plan. ` +
      `Your plan will need to be upgraded to complete your request.\n\n` +
      `[Upgrade Plan](${UPGRADE_URL})`;

    setMessages((prev) => [...prev, { role: "assistant", content: msg }]);
  }

  // Receive Wix -> iframe messages
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isAllowedOrigin(event.origin)) return;

      const data = event.data;
      if (!data || data.type !== "WEEKLY_PLAN") return;

      const incomingPlan = (data.planName ?? null) as PlanName;
      setPlanName(incomingPlan);

      const nextAllowed = allowedModesForPlan(incomingPlan);
      setAllowedModes(nextAllowed);

      // If current mode becomes invalid, force fallback
      setSessionState((prev) => {
        if (nextAllowed.includes(prev.mode)) return prev;
        return { ...prev, mode: "friend" };
      });
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function callChat(userText: string, nextMessages: Msg[], stateToSend: any) {
    if (!API_BASE) throw new Error("NEXT_PUBLIC_API_BASE_URL is not set");

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

  async function send(textOverride?: string) {
    if (loading) return;

    const userText = (textOverride ?? input).trim();
    if (!userText) return;

    // ✅ Prevent prompt-based bypass (block BEFORE calling FastAPI)
    const requested = requestedModeFromText(userText);
    if (requested && !allowedModes.includes(requested)) {
      showUpgradeMessage(requested);
      setInput("");
      return;
    }

    const nextMessages: Msg[] = [...messages, { role: "user", content: userText }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      // ✅ Send plan_name to backend (FastAPI) so server can enforce too
      // ✅ Pin mode to valid value if client ever gets out of sync
      const safeMode: Mode = allowedModes.includes(sessionState.mode) ? sessionState.mode : "friend";

      const stateToSend = {
        ...sessionState,
        mode: safeMode,
        plan_name: planName,
      };

      const data = await callChat(userText, nextMessages, stateToSend);

      setMessages([...nextMessages, { role: "assistant", content: data.reply }]);

      // Prefer backend’s returned session state, but never let it set an invalid mode client-side
      const nextState: SessionState = data.session_state ?? sessionState;
      const coercedMode: Mode = allowedModes.includes(nextState.mode) ? nextState.mode : "friend";
      setSessionState({ ...nextState, mode: coercedMode });
    } catch {
      setMessages([...nextMessages, { role: "assistant", content: "⚠️ Error talking to backend." }]);
    } finally {
      setLoading(false);
    }
  }

  function requestMode(mode: Mode) {
    if (!allowedModes.includes(mode)) {
      showUpgradeMessage(mode);
      return;
    }

    const hint =
      mode === "friend"
        ? "Let’s stay in Friend Mode."
        : mode === "romantic"
        ? "Can we switch to Romantic Mode?"
        : "Can we switch to Explicit Mode?";

    setSessionState((prev) => ({ ...prev, mode }));
    send(hint);
  }

  async function handleConsent(choice: "yes" | "no") {
    await send(choice);
  }

  const pendingConsent = sessionState.pending_consent;

  return (
    <main
      style={{
        maxWidth: 880,
        margin: "24px auto",
        padding: "0 16px",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <div
          aria-hidden
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            overflow: "hidden",
            boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
            background: "white",
            display: "grid",
            placeItems: "center",
          }}
        >
          <img
            src="/ai-haven-heart.png"
            alt="AI Haven 4U Heart"
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </div>

        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>AI Haven 4U</h1>
          <div style={{ fontSize: 13, color: "#555" }}>
            Companion MVP · reducing loneliness with consent-first intimacy
          </div>
          <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
            Plan: <b>{planName ?? "Unknown / Not provided"}</b>
          </div>
        </div>
      </header>

      {/* Mode buttons */}
      <section style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {modePills.map((m) => {
          const active = sessionState.mode === m;
          const enabled = allowedModes.includes(m);

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
                opacity: enabled ? 1 : 0.5,
              }}
              title={enabled ? `Request ${MODE_LABELS[m]} Mode` : "Upgrade required"}
            >
              {MODE_LABELS[m]}
            </button>
          );
        })}

        <div style={{ marginLeft: "auto", fontSize: 12, color: "#666", alignSelf: "center" }}>
          Current: <b>{MODE_LABELS[sessionState.mode]}</b>
        </div>
      </section>

      {/* Chat */}
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

      {/* Input */}
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
              {pendingConsent === "romance" && <>We can be romantic only if you want that.</>}
              {pendingConsent === "adult" && <>I need to confirm you’re 18+ first.</>}
              {pendingConsent === "explicit" && <>Explicit Mode is optional and consent-first.</>}
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
