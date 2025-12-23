"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import havenHeart from "../public/ai-haven-heart.png";

type Role = "user" | "assistant";
type Msg = { role: Role; content: string };

type Mode = "friend" | "romantic" | "intimate";
type ChatStatus = "safe" | "explicit_blocked" | "explicit_allowed";

type SessionState = {
  mode: Mode;
  adult_verified: boolean;
  romance_consented: boolean;
  explicit_consented: boolean;
  pending_consent: "intimate" | null;
  model: string;
  // optional extras tolerated
  [k: string]: any;
};

type ChatApiResponse = {
  reply: string;
  mode?: ChatStatus; // IMPORTANT: this is STATUS, not the UI pill mode
  session_state?: Partial<SessionState>;
};

type AllowedModeInfo =
  | {
      ok: true;
      allowed: Mode[];
      reason?: string;
    }
  | {
      ok: false;
      allowed: Mode[];
      reason: string;
    };

type CompanionMeta = {
  first: string;
  gender: string;
  ethnicity: string;
  generation: string;
  key: string;
};

const DEFAULT_COMPANION_NAME = "Haven";
const HEADSHOT_DIR = "/companion/headshot";
const GREET_ONCE_KEY = "AIHAVEN_GREETED";
const DEFAULT_AVATAR = havenHeart.src;

// If your API base already includes /api, keep it as-is. Do not add a trailing slash.
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/$/, "");

const MODE_LABELS: Record<Mode, string> = {
  friend: "Friend",
  romantic: "Romantic",
  intimate: "Intimate (18+)",
};

function isImageUrl(s: string) {
  return /^https?:\/\/.+\.(png|gif|jpg|jpeg|webp)$/i.test(s || "");
}

function stripImageExtFromUrl(s: string) {
  return (s || "").replace(/\.(png|gif|jpg|jpeg|webp)$/i, "");
}

function normalizeKeyForFile(raw: string) {
  return (raw || "").trim().replace(/\s+/g, "-");
}

function normalizeMode(raw: any): Mode | null {
  const t = String(raw ?? "").trim().toLowerCase();
  if (t === "friend") return "friend";
  if (t === "romantic" || t === "romance") return "romantic";
  if (t === "intimate" || t === "explicit" || t === "18+") return "intimate";
  return null;
}

function parseCompanionMeta(raw: string): CompanionMeta {
  const cleaned = normalizeKeyForFile(raw || "");
  const parts = cleaned.split("-").filter(Boolean);

  // Support just a single name
  if (parts.length < 2) {
    return {
      first: parts[0] || DEFAULT_COMPANION_NAME,
      gender: "",
      ethnicity: "",
      generation: "",
      key: cleaned || DEFAULT_COMPANION_NAME,
    };
  }

  const [first, gender, ethnicity, ...rest] = parts;
  const generation = rest.join("-");

  return {
    first: first || DEFAULT_COMPANION_NAME,
    gender: gender || "",
    ethnicity: ethnicity || "",
    generation: generation || "",
    key: cleaned,
  };
}

/**
 * Detect user asking to switch mode within their message.
 * Returns:
 *  - mode: the mode requested (or null)
 *  - cleaned: message with explicit token removed if present (so chat doesn't see the token)
 *
 * Supports:
 * - [mode:romantic] / mode:romantic
 * - "switch to romantic", "romantic mode", "set mode to romantic", etc.
 */
function detectModeSwitchAndClean(text: string): { mode: Mode | null; cleaned: string } {
  const raw = text || "";
  const t = raw.toLowerCase();

  // explicit tokens
  const tokenRe = /\[mode:(friend|romantic|intimate|explicit)\]|mode:(friend|romantic|intimate|explicit)/gi;

  let tokenMode: Mode | null = null;
  let cleaned = raw.replace(tokenRe, (m) => {
    const mm = m.toLowerCase();
    if (mm.includes("friend")) tokenMode = "friend";
    else if (mm.includes("romantic")) tokenMode = "romantic";
    else if (mm.includes("intimate") || mm.includes("explicit")) tokenMode = "intimate";
    return "";
  });

  cleaned = cleaned.trim();

  if (tokenMode) return { mode: tokenMode, cleaned };

  // soft phrasing (covers friend->romantic and intimate->romantic)
  const soft = t.trim();

  const wantsFriend =
    /\b(switch|set|turn|go|back)\b.*\b(friend)\b/.test(soft) || /\bfriend mode\b/.test(soft);
  const wantsRomantic =
    /\b(switch|set|turn|go|back)\b.*\b(romantic)\b/.test(soft) || /\bromantic mode\b/.test(soft);
  const wantsIntimate =
    /\b(switch|set|turn|go|back)\b.*\b(intimate|explicit)\b/.test(soft) ||
    /\b(intimate|explicit) mode\b/.test(soft);

  if (wantsFriend) return { mode: "friend", cleaned: raw };
  if (wantsRomantic) return { mode: "romantic", cleaned: raw };
  if (wantsIntimate) return { mode: "intimate", cleaned: raw };

  return { mode: null, cleaned: raw.trim() };
}

function getAllowedModesFromPlan(plan: string | null | undefined): AllowedModeInfo {
  const p = (plan || "").toLowerCase();

  // Default: allow friend only unless specified
  if (!p) {
    return { ok: true, allowed: ["friend"] };
  }

  // Example plan names (adjust if your app uses different plan strings)
  // - free: friend only
  // - plus: friend + romantic
  // - pro: friend + romantic + intimate
  if (p.includes("pro")) return { ok: true, allowed: ["friend", "romantic", "intimate"] };
  if (p.includes("plus")) return { ok: true, allowed: ["friend", "romantic"] };
  if (p.includes("free")) return { ok: true, allowed: ["friend"] };

  // Unknown plan: be permissive but safe
  return { ok: true, allowed: ["friend", "romantic"] };
}

export default function Page() {
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Keep one session id for the page lifetime
    const id =
      sessionIdRef.current ||
      (crypto as any).randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    sessionIdRef.current = id;
  }, []);

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);

  const [chatStatus, setChatStatus] = useState<ChatStatus>("safe");

  const [sessionState, setSessionState] = useState<SessionState>({
    mode: "friend",
    model: "gpt-4o",
    adult_verified: false,
    romance_consented: false,
    explicit_consented: false,
    pending_consent: null,
  });

  const [plan, setPlan] = useState<string | null>(null);

  const allowedModes = useMemo(() => {
    return getAllowedModesFromPlan(plan).allowed;
  }, [plan]);

  const companionMeta = useMemo(() => {
    const raw = String(sessionState?.companion_key || sessionState?.companionKey || DEFAULT_COMPANION_NAME);
    return parseCompanionMeta(raw);
  }, [sessionState]);

  const avatarSrc = useMemo(() => {
    const raw = String(sessionState?.avatar_url || sessionState?.avatarUrl || "");
    if (raw && isImageUrl(raw)) return raw;

    const key = normalizeKeyForFile(companionMeta.key || DEFAULT_COMPANION_NAME);
    if (key) return `${HEADSHOT_DIR}/${key}.png`;
    return DEFAULT_AVATAR;
  }, [companionMeta, sessionState]);

  const showUpgradeMessage = useCallback((requested: Mode) => {
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: `That mode (${MODE_LABELS[requested]}) is not available on your current plan.`,
      },
    ]);
  }, []);

  useEffect(() => {
    // Receive plan updates from parent frame if embedded (optional)
    function onMessage(ev: MessageEvent) {
      const data = ev?.data;
      if (!data || typeof data !== "object") return;

      // Example: { type: 'plan', plan: 'plus' }
      if ((data as any).type === "plan") {
        const next = (data as any).plan ?? null;
        setPlan(next ? String(next) : null);
      }

      // Example: { type: 'setCompanion', key: 'ava-female-asian-genx' }
      if ((data as any).type === "setCompanion") {
        const key = String((data as any).key || "").trim();
        if (!key) return;
        setSessionState((prev) => ({ ...prev, companion_key: key }));
      }
    }

    if (typeof window === "undefined") return;

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function callChat(nextMessages: Msg[], stateToSend: SessionState): Promise<ChatApiResponse> {
    if (!API_BASE) throw new Error("NEXT_PUBLIC_API_BASE_URL is not set");

    const session_id =
      sessionIdRef.current ||
      (crypto as any).randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const wants_explicit = stateToSend.mode === "intimate" || stateToSend.explicit_consented === true;

    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id,
        wants_explicit,
        session_state: stateToSend,
        messages: nextMessages,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Backend error ${res.status}: ${errText}`);
    }

    return (await res.json()) as ChatApiResponse;
  }

  // This is the mode that drives the UI highlight:
  // - If backend is asking for intimate consent, keep intimate pill highlighted
  const effectiveActiveMode: Mode =
    sessionState.pending_consent === "intimate" ? "intimate" : sessionState.mode;

  const showConsentOverlay =
    sessionState.pending_consent === "intimate" || chatStatus === "explicit_blocked";

  function setModeFromPill(m: Mode) {
    if (!allowedModes.includes(m)) {
      showUpgradeMessage(m);
      return;
    }

    setSessionState((prev) => {
      // If switching away from intimate while pending consent, clear pending
      const nextPending = m === "intimate" ? prev.pending_consent : null;
      return { ...prev, mode: m, pending_consent: nextPending };
    });

    setMessages((prev) => [...prev, { role: "assistant", content: `Mode set to: ${MODE_LABELS[m]}` }]);
  }

  async function send(textOverride?: string, stateOverride?: Partial<SessionState>) {
    if (loading) return;

    const rawText = (textOverride ?? input).trim();
    if (!rawText) return;

    // detect mode switch from prompt text
    const { mode: detectedMode, cleaned } = detectModeSwitchAndClean(rawText);

    // Plan-gate mode if user is attempting to switch
    if (detectedMode && !allowedModes.includes(detectedMode)) {
      showUpgradeMessage(detectedMode);
      setInput("");
      return;
    }

    // If the user message is ONLY a mode switch token, apply locally and don't call backend
    // e.g. "[mode:romantic]" by itself OR exact "romantic"
    if (detectedMode && cleaned.length === 0) {
      setSessionState((prev) => ({ ...prev, mode: detectedMode, pending_consent: null }));
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Mode set to: ${MODE_LABELS[detectedMode]}` },
      ]);
      setInput("");
      return;
    }

    // Apply mode locally (so pill highlights immediately), but still send message.
    // If detectedMode is intimate, keep/trigger pending overlay on response.
    let nextState: SessionState = sessionState;
    if (detectedMode) {
      nextState = { ...sessionState, mode: detectedMode };
      setSessionState(nextState);
    }

    // Build user message content:
    // If a [mode:*] token was present, we remove it from content (cleaned) to keep chat natural.
    const outgoingText = detectedMode ? cleaned : rawText;

    const userMsg: Msg = { role: "user", content: outgoingText };
    const nextMessages: Msg[] = [...messages, userMsg];

    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      const sendState: SessionState = { ...nextState, ...(stateOverride || {}) };
      const data = await callChat(nextMessages, sendState);

      // status from backend (safe/explicit_blocked/explicit_allowed)
      if (
        data.mode === "safe" ||
        data.mode === "explicit_blocked" ||
        data.mode === "explicit_allowed"
      ) {
        setChatStatus(data.mode);
      }

      // merge session_state from backend WITHOUT using data.mode as pill mode
      if (data.session_state) {
        setSessionState((prev) => {
          const merged = { ...prev, ...data.session_state };

          // If backend says blocked, keep pill as intimate AND set pending
          if (data.mode === "explicit_blocked") {
            merged.mode = "intimate";
            merged.pending_consent = "intimate";
          }

          // If backend says allowed, clear pending (and keep mode whatever backend returned in session_state)
          if (data.mode === "explicit_allowed" && merged.pending_consent) {
            merged.pending_consent = null;
          }

          // NOW: normalize & apply backend session_state mode if it exists
          const backendMode = normalizeMode((data.session_state as any)?.mode);
          if (backendMode && data.mode !== "explicit_blocked") {
            merged.mode = backendMode;
          }

          return merged;
        });
      } else {
        // If blocked but session_state missing, still reflect pending
        if (data.mode === "explicit_blocked") {
          setSessionState((prev) => ({ ...prev, pending_consent: "intimate", mode: "intimate" }));
        }
        if (data.mode === "explicit_allowed") {
          setSessionState((prev) => ({ ...prev, pending_consent: null, explicit_consented: true }));
        }
      }

      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err?.message ?? "Unknown error"}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 880, margin: "24px auto", padding: "0 16px", fontFamily: "system-ui" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <div aria-hidden style={{ width: 56, height: 56, borderRadius: "50%", overflow: "hidden" }}>
          <img
            src={avatarSrc}
            alt="AI Haven 4U"
            style={{ width: "100%", height: "100%" }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).src = DEFAULT_AVATAR;
            }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            {companionMeta.first || DEFAULT_COMPANION_NAME}
          </div>
          <div style={{ fontSize: 12, color: "#666" }}>
            {companionMeta.gender ? `${companionMeta.gender}` : ""}
            {companionMeta.ethnicity ? ` • ${companionMeta.ethnicity}` : ""}
            {companionMeta.generation ? ` • ${companionMeta.generation}` : ""}
          </div>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {/* Pill buttons - UI unchanged */}
          {(["friend", "romantic", "intimate"] as Mode[]).map((m) => {
            const active = effectiveActiveMode === m;
            const label = MODE_LABELS[m];

            return (
              <button
                key={m}
                onClick={() => setModeFromPill(m)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  border: "1px solid #ddd",
                  background: active ? "#111" : "#fff",
                  color: active ? "#fff" : "#111",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontWeight: 600,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </header>

      <div
        style={{
          border: "1px solid #eee",
          borderRadius: 16,
          padding: 12,
          minHeight: 360,
          background: "#fff",
        }}
      >
        {messages.length === 0 ? (
          <div style={{ color: "#666", fontSize: 14 }}>
            Say hi! You can also type <b>switch to romantic</b>.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  background: m.role === "user" ? "#111" : "#f2f2f2",
                  color: m.role === "user" ? "#fff" : "#111",
                  padding: "10px 12px",
                  borderRadius: 14,
                  maxWidth: "80%",
                  whiteSpace: "pre-wrap",
                }}
              >
                {m.content}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          style={{
            flex: 1,
            padding: "12px 12px",
            border: "1px solid #ddd",
            borderRadius: 12,
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />

        <button
          onClick={() => void send()}
          disabled={loading}
          style={{
            padding: "12px 14px",
            borderRadius: 12,
            border: "1px solid #111",
            background: loading ? "#ddd" : "#111",
            color: "#fff",
            fontWeight: 700,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Sending…" : "Send"}
        </button>
      </div>

      {/* Consent overlay - UI unchanged */}
      {showConsentOverlay && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "grid",
            placeItems: "center",
            padding: 20,
            zIndex: 999,
          }}
        >
          <div style={{ width: "100%", maxWidth: 560, background: "#fff", borderRadius: 16, padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <img src={DEFAULT_AVATAR} alt="" width={28} height={28} />
              <div style={{ fontWeight: 800 }}>Confirm 18+</div>
            </div>

            <p style={{ color: "#444", marginTop: 10 }}>
              Intimate mode contains adult content. Please confirm you are 18+ to continue.
            </p>

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button
                onClick={() => {
                  // keep UI unchanged
                  setSessionState((prev) => ({ ...prev, pending_consent: null, mode: "friend" }));
                  setChatStatus("safe");
                }}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #111",
                  background: "#111",
                  color: "#fff",
                  fontWeight: 700,
                }}
              >
                No
              </button>

              <button
                onClick={() => {
                  // mark local consent; backend still enforces
                  setSessionState((prev) => ({
                    ...prev,
                    explicit_consented: true,
                    pending_consent: null,
                    mode: "intimate",
                  }));
                  setChatStatus("safe");
                }}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  background: "#fff",
                  fontWeight: 700,
                }}
              >
                Yes
              </button>

              <button
                onClick={() => {
                  setChatStatus("safe");
                  setSessionState((prev) => ({ ...prev, pending_consent: null, mode: "friend" }));
                }}
                style={{
                  marginLeft: "auto",
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  background: "#fff",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Optional debug */}
      {process.env.NODE_ENV !== "production" && (
        <div style={{ marginTop: 14, fontSize: 12, color: "#777" }}>
          <div>
            Debug: companionKey=<code>{String(sessionState?.companion_key || sessionState?.companionKey || "") || "(none)"}</code>
          </div>
          <div>
            Debug: api=<code>{API_BASE || "(missing NEXT_PUBLIC_API_BASE_URL)"}</code>
          </div>
        </div>
      )}
    </main>
  );
}
