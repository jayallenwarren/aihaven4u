"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Types
 */
type Role = "user" | "assistant";

type Msg = {
  role: Role;
  content: string;
};

type Mode = "friend" | "romantic" | "intimate";

type ChatStatus = "safe" | "explicit_blocked" | "explicit_allowed";

type SessionState = {
  companionKey: string | null;
  mode: Mode;
  explicit_consented: boolean;
  pending_consent: "intimate" | null;
};

type ChatResponse = {
  reply: string;
  mode?: ChatStatus; // backend safety status (NOT pill mode)
  session_state?: Partial<SessionState>; // snake_case
  // NOTE: some backends return camelCase:
  // sessionState?: Partial<SessionState>;
};

/**
 * Env + constants
 */
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "";

const MODE_LABELS: Record<Mode, string> = {
  friend: "Friend",
  romantic: "Romantic",
  intimate: "Intimate (18+)",
};

// TODO: update plan gating rules if needed
const allowedModes: Mode[] = ["friend", "romantic", "intimate"];

/**
 * Helpers
 */
function normalizeMode(raw: any): Mode | null {
  const t = String(raw ?? "").trim().toLowerCase();
  if (t === "friend") return "friend";
  if (t === "romantic" || t === "romance") return "romantic";
  if (t === "intimate" || t === "explicit" || t === "18+") return "intimate";
  return null;
}

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

  const soft = t.trim();

  const wantsFriend =
    /\b(switch|set|turn|go|back)\b.*\b(friend)\b/.test(soft) || /\bfriend mode\b/.test(soft);

  const wantsRomantic =
    /\bromantic\b/.test(soft) ||
    /\bromance\b/.test(soft) ||
    /\blet['’]s be romantic\b/.test(soft) ||
    /\bbe romantic\b/.test(soft) ||
    /\bromantic mode\b/.test(soft) ||
    /\b(switch|set|turn|go|back|enable)\b.*\b(romantic|romance)\b/.test(soft);

  const wantsIntimate =
    /\b(switch|set|turn|go|back)\b.*\b(intimate|explicit)\b/.test(soft) ||
    /\b(intimate|explicit) mode\b/.test(soft);

  if (wantsFriend) return { mode: "friend", cleaned: raw };

  // Optional: treat exact "romantic"/"romance" as a switch request
  if (/^\s*(romantic|romance)\s*$/i.test(raw)) return { mode: "romantic", cleaned: "" };

  // ✅ critical: actually return romantic when detected
  if (wantsRomantic) return { mode: "romantic", cleaned: raw };

  if (wantsIntimate) return { mode: "intimate", cleaned: raw };

  return { mode: null, cleaned: raw.trim() };
}

export default function Page() {
  const sessionKeyRef = useRef<string | null>(null);

  const [companionKey, setCompanionKey] = useState<string>("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const [chatStatus, setChatStatus] = useState<ChatStatus>("safe");

  const [sessionState, setSessionState] = useState<SessionState>({
    companionKey: null,
    mode: "friend",
    explicit_consented: false,
    pending_consent: null,
  });

  const effectiveActiveMode: Mode = useMemo(() => {
    return sessionState.pending_consent === "intimate" ? "intimate" : sessionState.mode;
  }, [sessionState.pending_consent, sessionState.mode]);

  // Ensure sessionState.companionKey stays synced
  useEffect(() => {
    setSessionState((prev) => ({ ...prev, companionKey: companionKey || null }));
  }, [companionKey]);

  const showUpgradeMessage = useCallback((requested: Mode) => {
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: `That mode (${MODE_LABELS[requested]}) is not available on your current plan.`,
      },
    ]);
  }, []);

  const callChat = useCallback(
    async (nextMessages: Msg[], sendState: SessionState): Promise<ChatResponse> => {
      if (!API_BASE) {
        return { reply: "Missing NEXT_PUBLIC_API_BASE_URL. Please set it and redeploy." };
      }

      const resp = await fetch(`${API_BASE.replace(/\/$/, "")}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages,
          session_state: sendState,
        }),
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${txt || resp.statusText}`);
      }

      const data = (await resp.json()) as any;
      // expecting: { reply, mode, session_state } (snake_case)
      return data as ChatResponse;
    },
    []
  );

  // If you have a companionKey in localStorage or query params, keep that behavior.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("companionKey");
      if (saved && !companionKey) setCompanionKey(saved);
    } catch {}
  }, [companionKey]);

  useEffect(() => {
    try {
      if (companionKey) window.localStorage.setItem("companionKey", companionKey);
    } catch {}
  }, [companionKey]);

  // Example: keep a stable sessionKey if your backend uses it
  useEffect(() => {
    if (!sessionKeyRef.current) {
      sessionKeyRef.current = Math.random().toString(36).slice(2);
    }
  }, []);

  const onPillClick = useCallback(
    (m: Mode) => {
      if (!allowedModes.includes(m)) {
        showUpgradeMessage(m);
        return;
      }
      setSessionState((prev) => ({ ...prev, mode: m, pending_consent: null }));
      setMessages((prev) => [...prev, { role: "assistant", content: `Mode set to: ${MODE_LABELS[m]}` }]);
    },
    [showUpgradeMessage]
  );

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

      // Accept either snake_case or camelCase session state from backend
      const serverSessionState: any = (data as any).session_state ?? (data as any).sessionState;

      // merge session state from backend WITHOUT using data.mode as pill mode
      if (serverSessionState) {
        setSessionState((prev) => {
          const merged = { ...prev, ...serverSessionState };

          // If backend says blocked, keep pill as intimate AND set pending
          if (data.mode === "explicit_blocked") {
            merged.mode = "intimate";
            merged.pending_consent = "intimate";
          }

          // If backend says allowed, clear pending (and keep mode whatever backend returned in session state)
          if (data.mode === "explicit_allowed" && merged.pending_consent) {
            merged.pending_consent = null;
          }

          // Normalize & apply backend mode if it exists
          const backendMode = normalizeMode(serverSessionState?.mode);
          if (backendMode && data.mode !== "explicit_blocked") {
            merged.mode = backendMode;
          }

          return merged;
        });
      } else {
        // If blocked but session state missing, still reflect pending
        if (data.mode === "explicit_blocked") {
          setSessionState((prev) => ({ ...prev, mode: "intimate", pending_consent: "intimate" }));
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
      <h1 style={{ marginBottom: 8 }}>Chat</h1>

      <div style={{ marginBottom: 12, display: "flex", gap: 10, alignItems: "center" }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#666" }}>Companion key</span>
          <input
            value={companionKey}
            onChange={(e) => setCompanionKey(e.target.value)}
            placeholder="e.g. ava"
            style={{ padding: "6px 8px", border: "1px solid #ccc", borderRadius: 8 }}
          />
        </label>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {(["friend", "romantic", "intimate"] as Mode[]).map((m) => {
            const active = effectiveActiveMode === m;
            const label = MODE_LABELS[m];
            return (
              <button
                key={m}
                onClick={() => onPillClick(m)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 999,
                  border: "1px solid #ccc",
                  background: active ? "#111" : "white",
                  color: active ? "white" : "#111",
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 12,
          padding: 12,
          minHeight: 340,
          background: "white",
        }}
      >
        {messages.length === 0 ? (
          <div style={{ color: "#666", fontSize: 14 }}>
            Type a message below. You can say “switch to romantic”.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  background: m.role === "user" ? "#111" : "#f1f1f1",
                  color: m.role === "user" ? "white" : "#111",
                  padding: "8px 10px",
                  borderRadius: 12,
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
          style={{ flex: 1, padding: "10px 12px", border: "1px solid #ccc", borderRadius: 10 }}
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
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #111",
            background: loading ? "#ccc" : "#111",
            color: "white",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Sending…" : "Send"}
        </button>
      </div>

      {sessionState.pending_consent === "intimate" && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "grid",
            placeItems: "center",
            padding: 20,
          }}
        >
          <div style={{ width: "100%", maxWidth: 520, background: "white", borderRadius: 16, padding: 16 }}>
            <h2 style={{ marginTop: 0 }}>Confirm 18+</h2>
            <p style={{ color: "#444" }}>
              Intimate mode contains adult content. Please confirm you are 18+ to continue.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  setSessionState((prev) => ({ ...prev, pending_consent: null, mode: "friend" }));
                }}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #ccc",
                  background: "white",
                  cursor: "pointer",
                }}
              >
                Cancel
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
                }}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #111",
                  background: "#111",
                  color: "white",
                  cursor: "pointer",
                }}
              >
                I’m 18+
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Optional debug */}
      {process.env.NODE_ENV !== "production" && (
        <div style={{ marginTop: 14, fontSize: 12, color: "#777" }}>
          <div>
            Debug: companionKey=<code>{companionKey || "(none)"}</code>
          </div>
          <div>
            Debug: api=<code>{API_BASE || "(missing NEXT_PUBLIC_API_BASE_URL)"}</code>
          </div>
          <div>
            Debug: chatStatus=<code>{chatStatus}</code>
          </div>
          <div>
            Debug: sessionState.mode=<code>{sessionState.mode}</code>
          </div>
        </div>
      )}
    </main>
  );
}
