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
  | "Test - Friend"
  | "Test - Romantic"
  | "Test - Intimate (18+)"
  | null;

const UPGRADE_URL = "https://www.aihaven4u.com/pricing-plans/list";

const ROMANTIC_ALLOWED_PLANS: PlanName[] = [
  "Week - Trial",
  "Weekly - Romantic",
  "Weekly - Intimate (18+)",
  "Test - Romantic",
  "Test - Intimate (18+)",
];

function allowedModesForPlan(planName: PlanName): Mode[] {
  const modes: Mode[] = ["friend"];
  if (ROMANTIC_ALLOWED_PLANS.includes(planName)) modes.push("romantic");
  if (planName === "Weekly - Intimate (18+)" || planName === "Test - Intimate (18+)") modes.push("explicit");
  return modes;
}

function isAllowedOrigin(origin: string) {
  if (origin === "https://aihaven4u.com") return true;
  if (origin === "https://www.aihaven4u.com") return true;
  if (origin === "https://editor.wix.com") return true;
  if (origin === "https://manage.wix.com") return true;
  if (/^https:\/\/[a-z0-9-]+\.wixsite\.com$/i.test(origin)) return true;
  return false;
}

function isRomanticRequest(text: string) {
  const t = (text || "").toLowerCase();
  return /\bromance\b|\bromantic\b|\bflirt\b|\bflirty\b|\bdate\b|\bgirlfriend\b|\bboyfriend\b|\bkiss\b|\bmake out\b|\blove you\b/.test(t);
}

function isExplicitRequest(text: string) {
  const t = (text || "").toLowerCase();
  return /\bexplicit\b|\bintimate\b|\b18\+\b|\bnsfw\b|\bsex\b|\bfuck\b|\bnude\b|\bnaked\b|\borgasm\b|\bblowjob\b|\bbj\b|\bdeep throat\b|\bsquirt\b|\bpee\b|\bfart\b|\bpussy\b|\banal\b/.test(t);
}

function requestedModeFromText(text: string): Mode | null {
  if (isExplicitRequest(text)) return "explicit";
  if (isRomanticRequest(text)) return "romantic";
  return null;
}

function requestedModeFromHint(text: string): Mode | null {
  const t = (text || "").toLowerCase().trim();
  const wantsSwitch =
    /\b(switch|change|go|return|get|set|move|put|back)\b/.test(t) ||
    /\b(back to|go back to|switch back to|return to)\b/.test(t);

  if ((/\bfriend\b/.test(t) || /\bfriendly\b/.test(t) || /\bkeep it friendly\b/.test(t)) && (wantsSwitch || /\bmode\b/.test(t))) {
    return "friend";
  }
  if ((/\bromantic\b/.test(t) || /\bromance\b/.test(t)) && (wantsSwitch || /\bmode\b/.test(t))) {
    return "romantic";
  }
  if ((/\bexplicit\b/.test(t) || /\bintimate\b/.test(t) || /\b18\+\b/.test(t) || /\bnsfw\b/.test(t)) && (wantsSwitch || /\bmode\b/.test(t) || /\bplease\b/.test(t))) {
    return "explicit";
  }
  return null;
}

export default function Page() {
  const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

  // ✅ persistent per-tab session_id (fixes 422)
  const sessionIdRef = useRef<string>("");

  useEffect(() => {
    const key = "aihaven4u_session_id";
    const existing = window.sessionStorage.getItem(key);
    if (existing) {
      sessionIdRef.current = existing;
      return;
    }
    const id =
      (crypto as any).randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionIdRef.current = id;
    window.sessionStorage.setItem(key, id);
  }, []);

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

  const [planName, setPlanName] = useState<PlanName>(null);
  const [allowedModes, setAllowedModes] = useState<Mode[]>(["friend"]);

  const modePills = useMemo(() => ["friend", "romantic", "explicit"] as const, []);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function showUpgradeMessage(requestedMode: Mode) {
    const modeLabel = MODE_LABELS[requestedMode];
    const msg =
      `The requested ${modeLabel} mode is not available for your current plan. ` +
      `Your plan will need to be upgraded to complete your request.\n\n` +
      `[Upgrade Plan](${UPGRADE_URL})`;
    setMessages((prev) => [...prev, { role: "assistant", content: msg }]);
  }

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isAllowedOrigin(event.origin)) return;

      const data = event.data;
      if (!data || data.type !== "WEEKLY_PLAN") return;

      const incomingPlan = (data.planName ?? null) as PlanName;
      setPlanName(incomingPlan);

      const nextAllowed = allowedModesForPlan(incomingPlan);
      setAllowedModes(nextAllowed);

      setSessionState((prev) => {
        if (nextAllowed.includes(prev.mode)) return prev;
        return { ...prev, mode: "friend" };
      });
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function callChat(nextMessages: Msg[], stateToSend: any) {
    if (!API_BASE) throw new Error("NEXT_PUBLIC_API_BASE_URL is not set");

    const session_id =
      sessionIdRef.current ||
      (crypto as any).randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    // ✅ Send what backend expects: session_id + messages (+ wants_explicit)
    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id,
        wants_explicit: stateToSend?.explicit_consented === true,
        session_state: stateToSend, // optional; backend accepts it
        messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Backend error ${res.status}: ${errText}`);
    }

    return res.json() as Promise<{ reply: string; session_state?: SessionState }>;
  }

  async function send(textOverride?: string) {
    if (loading) return;

    const userText = (textOverride ?? input).trim();
    if (!userText) return;

    const hintedMode = requestedModeFromHint(userText);
    if (hintedMode) {
      if (!allowedModes.includes(hintedMode)) {
        showUpgradeMessage(hintedMode);
        setInput("");
        return;
      }
      setSessionState((prev) => ({ ...prev, mode: hintedMode }));
    }

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
      const desiredMode = hintedMode ?? sessionState.mode;
      const safeMode: Mode = allowedModes.includes(desiredMode) ? desiredMode : "friend";

      const stateToSend = { ...sessionState, mode: safeMode, plan_name: planName };

      const data = await callChat(nextMessages, stateToSend);

      setMessages([...nextMessages, { role: "assistant", content: data.reply }]);

      // backend may or may not send session_state; don’t require it
      if (data.session_state) {
        const coercedMode: Mode = allowedModes.includes(data.session_state.mode) ? data.session_state.mode : "friend";
        setSessionState({ ...data.session_state, mode: coercedMode });
      }
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
    <main style={{ maxWidth: 880, margin: "24px auto", padding: "0 16px", fontFamily: "system-ui" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <div aria-hidden style={{ width: 56, height: 56, borderRadius: "50%", overflow: "hidden" }}>
          <img src="/ai-haven-heart.png" alt="AI Haven 4U Heart" style={{ width: "100%", height: "100%" }} />
        </div>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>AI Haven 4U</h1>
          <div style={{ fontSize: 12, color: "#666" }}>
            Plan: <b>{planName ?? "Unknown / Not provided"}</b>
          </div>
        </div>
      </header>

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
      </section>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 14, padding: 12, minHeight: 420 }}>
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              margin: "8px 0",
            }}
          >
            <div
              style={{
                maxWidth: "75%",
                padding: "10px 12px",
                borderRadius: 12,
                background: m.role === "user" ? "#111" : "white",
                color: m.role === "user" ? "white" : "#111",
                whiteSpace: "pre-wrap",
              }}
            >
              {m.content}
            </div>
          </div>
        ))}
        {loading && <div style={{ color: "#444" }}>Thinking…</div>}
        <div ref={scrollRef} />
      </section>

      <section style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Type here…"
          style={{ flex: 1, padding: 12, borderRadius: 10, border: "1px solid #ccc", fontSize: 15 }}
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
          }}
        >
          Send
        </button>
      </section>

      {pendingConsent && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
        >
          <div style={{ width: "100%", maxWidth: 440, background: "white", borderRadius: 14, padding: 16 }}>
            <h3 style={{ marginTop: 0 }}>
              {pendingConsent === "romance" && "Opt into Romantic Mode?"}
              {pendingConsent === "adult" && "Confirm you’re 18+?"}
              {pendingConsent === "explicit" && "Opt into Explicit Mode?"}
            </h3>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => handleConsent("no")}
                style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ccc", background: "white" }}
              >
                No
              </button>
              <button
                onClick={() => handleConsent("yes")}
                style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: "#111", color: "white", fontWeight: 600 }}
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
