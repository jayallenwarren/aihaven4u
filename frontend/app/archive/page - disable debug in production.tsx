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

  // ✅ Dev-only debug UI
  const isDev = process.env.NODE_ENV !== "production";
  const [showDebug, setShowDebug] = useState(isDev);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const pendingConsent = sessionState.pending_consent ?? null;

  const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

  async function callChat(
    userText: string,
    nextMessages: Msg[],
    nextState?: SessionState
  ) {
    if (!API_BASE) {
      throw new Error("API base URL not configured");
    }

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

    const nextMessages: Msg[] = [...messages, { role: "user", content: userText }];
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

  const modePills = useMemo(
    () => ["friend", "romantic", "explicit"] as const,
    []
  );

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
      <header
        style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}
      >
        <div
          aria-hidden
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%", // ✅ circular frame
            overflow: "hidden",
            boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
            background: "white",
            display: "grid",
            placeItems: "center",
          }}
        >
          <img
            src="/ai-haven-heart.png" // or your generated PNG filename
            alt="AI Haven 4U Heart"
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover", // ✅ fills circle without distortion
              objectPosition: "center
