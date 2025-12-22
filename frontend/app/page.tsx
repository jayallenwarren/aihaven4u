"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import havenHeart from "../public/ai-haven-heart.png";

type Role = "user" | "assistant";
type Msg = { role: Role; content: string };

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

// Bundled default avatar (avoids public-path issues when embedded in Wix iframe)
const DEFAULT_AVATAR = havenHeart.src;

function stripExt(s: string) {
  return (s || "").replace(/\.(png|jpg|jpeg|webp)$/i, "");
}

function normalizeKeyForFile(raw: string) {
  return (raw || "").trim().replace(/\s+/g, "-");
}

function parseCompanionMeta(raw: string): CompanionMeta {
  const cleaned = stripExt(raw || "");
  const parts = cleaned
    .split("-")
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length < 4) {
    return {
      first: cleaned || DEFAULT_COMPANION_NAME,
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
 * Generates candidate headshot URLs:
 * - We try .jpeg, .jpg, then .png
 * - We normalize spaces to hyphens ONLY for filenames
 */
function buildAvatarCandidates(companionKeyOrName: string) {
  const raw = (companionKeyOrName || "").trim();
  const normalized = normalizeKeyForFile(stripExt(raw));
  const base = normalized ? `${HEADSHOT_DIR}/${encodeURIComponent(normalized)}` : "";

  const candidates: string[] = [];
  if (base) {
    candidates.push(`${base}.jpeg`);
    candidates.push(`${base}.jpg`);
    candidates.push(`${base}.png`);
  }

  // Always end with bundled default avatar
  candidates.push(DEFAULT_AVATAR);
  return candidates;
}

async function pickFirstExisting(urls: string[]) {
  for (const url of urls) {
    if (url === DEFAULT_AVATAR) return url;

    try {
      const res = await fetch(url, { method: "HEAD", cache: "no-store" });
      if (res.ok) return url;
    } catch {
      // ignore and continue
    }
  }
  return DEFAULT_AVATAR;
}

function greetingFor(name: string) {
  const n = (name || DEFAULT_COMPANION_NAME).trim() || DEFAULT_COMPANION_NAME;
  return `Hi, ${n} here. 😊 What's on your mind?`;
}

type Mode = "friend" | "romantic" | "intimate";

/**
 * IMPORTANT:
 * Backend ChatResponse.mode is a STATUS:
 *   "safe" | "explicit_blocked" | "explicit_allowed"
 * Conversational mode is session_state.mode:
 *   "friend" | "romantic" | "intimate"
 */
type ChatStatus = "safe" | "explicit_blocked" | "explicit_allowed";

type SessionState = {
  mode: Mode;
  adult_verified?: boolean;
  romance_consented?: boolean;
  explicit_consented?: boolean;
  pending_consent?: "intimate" | null;
  model?: string;

  // optional extras we might echo back
  planName?: string;
  plan_name?: string;
  companion?: string;
  companionName?: string;
  companion_name?: string;
  companion_meta?: any;
};

const MODE_LABELS: Record<Mode, string> = {
  friend: "Friend",
  romantic: "Romantic",
  intimate: "Intimate (18+)",
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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
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
  if (planName === "Weekly - Intimate (18+)" || planName === "Test - Intimate (18+)")
    modes.push("intimate");
  return modes;
}

function isAllowedOrigin(origin: string) {
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    if (host.endsWith("aihaven4u.com")) return true;
    if (host.endsWith("wix.com")) return true;
    if (host.endsWith("wixsite.com")) return true;
    if (host.endsWith("azurestaticapps.net")) return true; // editor/preview environments
    if (host === "localhost" || host === "127.0.0.1") return true;
    return false;
  } catch {
    return false;
  }
}

function requestedModeFromHint(text: string): Mode | null {
  const t = (text || "").toLowerCase();
  if (t.includes("mode:friend") || t.includes("[mode:friend]")) return "friend";
  if (t.includes("mode:romantic") || t.includes("[mode:romantic]")) return "romantic";
  if (t.includes("mode:intimate") || t.includes("[mode:intimate]")) return "intimate";
  if (t.includes("mode:explicit") || t.includes("[mode:explicit]")) return "intimate";
  return null;
}

// optional intent detection (plan gating)
function isRomanticRequest(text: string) {
  const t = (text || "").toLowerCase();
  return /\b(flirt|romance|romantic|date|kiss|love|boyfriend|girlfriend)\b/.test(t);
}

function isIntimateRequest(text: string) {
  const t = (text || "").toLowerCase();
  return /\b(sex|nude|explicit|intimate|nsfw|oral|penetration|hardcore)\b/.test(t);
}

type ChatResponse = {
  session_id: string;
  reply: string;
  mode: ChatStatus;
  session_state?: SessionState;
};

export default function Page() {
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = "AIHAVEN_SESSION_ID";
    let id = window.sessionStorage.getItem(key);
    if (!id) {
      id =
        (crypto as any).randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      window.sessionStorage.setItem(key, id);
    }
    sessionIdRef.current = id;
  }, []);

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);

  // conversational session state (synced with backend session_state)
  const [sessionState, setSessionState] = useState<SessionState>({
    mode: "friend",
    model: "gpt-4o",
    adult_verified: false,
    romance_consented: false,
    explicit_consented: false,
    pending_consent: null,
  });

  // backend status (safe/blocked/allowed)
  const [chatStatus, setChatStatus] = useState<ChatStatus>("safe");

  const [planName, setPlanName] = useState<PlanName>(null);
  const [companionName, setCompanionName] = useState<string>(DEFAULT_COMPANION_NAME);
  const [avatarSrc, setAvatarSrc] = useState<string>(DEFAULT_AVATAR);
  const [companionKey, setCompanionKey] = useState<string>("");

  const [allowedModes, setAllowedModes] = useState<Mode[]>(["friend"]);

  const modePills = useMemo(() => ["friend", "romantic", "intimate"] as const, []);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading, scrollToBottom]);

  // Greeting: once per *browser session* per companion
  useEffect(() => {
    if (typeof window === "undefined") return;

    const keyName = normalizeKeyForFile(companionName || DEFAULT_COMPANION_NAME);
    const greetKey = `${GREET_ONCE_KEY}:${keyName}`;

    const tmr = window.setTimeout(() => {
      const already = sessionStorage.getItem(greetKey) === "1";
      if (already) return;

      const greetingMsg: Msg = {
        role: "assistant",
        content: greetingFor(companionName || DEFAULT_COMPANION_NAME),
      };

      setMessages((prev) => {
        if (prev && prev.length > 0) return prev;
        return [greetingMsg];
      });

      sessionStorage.setItem(greetKey, "1");
    }, 150);

    return () => window.clearTimeout(tmr);
  }, [companionName]);

  function showUpgradeMessage(requestedMode: Mode) {
    const modeLabel = MODE_LABELS[requestedMode];
    const msg =
      `The requested mode (${modeLabel}) isn't available on your current plan. ` +
      `Please upgrade here: ${UPGRADE_URL}`;

    const upgradeMsg: Msg = { role: "assistant", content: msg };
    setMessages((prev) => [...prev, upgradeMsg]);
  }

  // Listen for Wix postMessage with plan + companion meta
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isAllowedOrigin(event.origin)) return;

      const data = event.data;
      if (!data || data.type !== "WEEKLY_PLAN") return;

      const incomingPlan = (data.planName ?? null) as PlanName;
      setPlanName(incomingPlan);

      const incomingCompanion =
        typeof (data as any).companion === "string" ? (data as any).companion.trim() : "";
      const resolvedCompanionKey = incomingCompanion || "";

      if (resolvedCompanionKey) {
        const parsed = parseCompanionMeta(resolvedCompanionKey);
        setCompanionKey(parsed.key);
        setCompanionName(parsed.first || DEFAULT_COMPANION_NAME);
      } else {
        setCompanionKey("");
        setCompanionName(DEFAULT_COMPANION_NAME);
      }

      const avatarCandidates = buildAvatarCandidates(resolvedCompanionKey || DEFAULT_COMPANION_NAME);
      pickFirstExisting(avatarCandidates).then((picked) => {
        setAvatarSrc(picked);
      });

      const nextAllowed = allowedModesForPlan(incomingPlan);
      setAllowedModes(nextAllowed);

      // If current mode is not allowed, drop to friend
      setSessionState((prev) => {
        if (nextAllowed.includes(prev.mode)) return prev;
        return { ...prev, mode: "friend" };
      });
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function callChat(nextMessages: Msg[], stateToSend: SessionState): Promise<ChatResponse> {
    if (!API_BASE) throw new Error("NEXT_PUBLIC_API_BASE_URL is not set");

    const session_id =
      sessionIdRef.current ||
      (crypto as any).randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // wants_explicit is a HINT; backend is authoritative and will return explicit_blocked/allowed
      body: JSON.stringify({
        session_id,
        wants_explicit: stateToSend?.mode === "intimate" || stateToSend?.explicit_consented === true,
        session_state: stateToSend,
        messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Backend error ${res.status}: ${errText}`);
    }

    return (await res.json()) as ChatResponse;
  }

  // Main send function
  async function send(textOverride?: string) {
    if (loading) return;

    const userText = (textOverride ?? input).trim();
    if (!userText) return;

    // allow [mode:xxx] hints
    const hintedMode = requestedModeFromHint(userText);
    if (hintedMode) {
      if (!allowedModes.includes(hintedMode)) {
        showUpgradeMessage(hintedMode);
        setInput("");
        return;
      }
      setSessionState((prev) => ({ ...prev, mode: hintedMode }));
      setInput("");
      return;
    }

    // Plan gating (soft detection)
    if (isIntimateRequest(userText) && !allowedModes.includes("intimate")) {
      showUpgradeMessage("intimate");
      setInput("");
      return;
    }
    if (isRomanticRequest(userText) && !allowedModes.includes("romantic")) {
      showUpgradeMessage("romantic");
      setInput("");
      return;
    }

    const userMsg: Msg = { role: "user", content: userText };
    const nextMessages: Msg[] = [...messages, userMsg];

    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      const data = await callChat(nextMessages, sessionState);

      // backend status determines consent overlay behavior
      if (data.mode) setChatStatus(data.mode);

      // Merge backend session_state (authoritative) into ours
      if (data.session_state) {
        setSessionState((prev) => ({
          ...prev,
          ...data.session_state,
          // ensure mode always exists
          mode: (data.session_state?.mode as Mode) || prev.mode,
        }));
      }

      const assistantMsg: Msg = { role: "assistant", content: data.reply };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      const errorMsg: Msg = {
        role: "assistant",
        content: `Error: ${err?.message ?? "Unknown error"}`,
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  }

  // UI pill click: sets conversational mode locally, and adds a visible message
  function setModeFromPill(m: Mode) {
    if (!allowedModes.includes(m)) {
      showUpgradeMessage(m);
      return;
    }

    setSessionState((prev) => {
      const next: SessionState = { ...prev, mode: m };
      // IMPORTANT: do NOT set explicit_consented here.
      // Backend will set it only after user responds "yes" while pending_consent=intimate.
      if (m !== "intimate") {
        next.pending_consent = null;
      }
      return next;
    });

    const modeMsg: Msg = { role: "assistant", content: `Mode set to: ${MODE_LABELS[m]}` };
    setMessages((prev) => [...prev, modeMsg]);
  }

  // Consent overlay: show when backend says explicit_blocked OR session_state.pending_consent==intimate
  const showConsentOverlay =
    chatStatus === "explicit_blocked" || sessionState.pending_consent === "intimate";

  // Cosmetic: if we are pending consent, keep pill highlighted on intimate
  const effectiveActiveMode: Mode =
    sessionState.pending_consent === "intimate" ? "intimate" : sessionState.mode;

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
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>AI Haven 4U</h1>
          <div style={{ fontSize: 12, color: "#666" }}>
            Companion: <b>{companionName || DEFAULT_COMPANION_NAME}</b> • Plan:{" "}
            <b>{planName ?? "Unknown / Not provided"}</b>
          </div>
          <div style={{ fontSize: 12, color: "#666" }}>
            Mode: <b>{MODE_LABELS[effectiveActiveMode]}</b>
            {chatStatus === "explicit_allowed" ? (
              <span style={{ marginLeft: 8, color: "#0a7a2f" }}>• Consent: Allowed</span>
            ) : chatStatus === "explicit_blocked" ? (
              <span style={{ marginLeft: 8, color: "#b00020" }}>• Consent: Required</span>
            ) : null}
          </div>
        </div>
      </header>

      <section style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {modePills.map((m) => {
          const active = effectiveActiveMode === m;
          const disabled = !allowedModes.includes(m);
          return (
            <button
              key={m}
              disabled={disabled}
              onClick={() => setModeFromPill(m)}
              style={{
                padding: "8px 12px",
                borderRadius: 999,
                border: "1px solid #ddd",
                background: active ? "#111" : "#fff",
                color: active ? "#fff" : "#111",
                opacity: disabled ? 0.45 : 1,
                cursor: disabled ? "not-allowed" : "pointer",
              }}
            >
              {MODE_LABELS[m]}
            </button>
          );
        })}
      </section>

      <section
        style={{
          border: "1px solid #e5e5e5",
          borderRadius: 12,
          padding: 12,
          minHeight: 360,
        }}
      >
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: "#666" }}>{m.role === "user" ? "You" : "AI"}</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
          </div>
        ))}
        {loading && <div style={{ color: "#666" }}>Thinking…</div>}
        <div ref={scrollRef} />
      </section>

      <section style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          placeholder="Type a message…"
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid #ddd",
          }}
        />
        <button
          onClick={() => send()}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #111",
            background: "#111",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Send
        </button>
      </section>

      {/* Consent overlay */}
      {showConsentOverlay && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 12,
              padding: 16,
              maxWidth: 520,
              width: "100%",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Consent Required</h3>
            <p style={{ marginTop: 0 }}>
              To enable <b>Intimate (18+)</b> mode, please confirm you are 18+ and consent to an
              Intimate (18+) conversation.
            </p>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  // We must send "Yes" as a user message so the backend can grant consent.
                  // Also keep session_state pending so backend knows we were asked.
                  setSessionState((prev) => ({ ...prev, pending_consent: "intimate", mode: "intimate" }));
                  send("Yes");
                }}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #111",
                  background: "#111",
                  color: "#fff",
                }}
              >
                Yes
              </button>

              <button
                onClick={() => {
                  // decline locally and tell backend
                  setSessionState((prev) => ({
                    ...prev,
                    pending_consent: "intimate",
                    mode: "intimate",
                  }));
                  send("No");
                }}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  background: "#fff",
                }}
              >
                No
              </button>

              <button
                onClick={() => {
                  // just dismiss UI (keeps current state)
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

            <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
              Tip: If you don’t see the overlay when you tap Intimate, send a message like{" "}
              <b>[mode:intimate]</b>.
            </div>
          </div>
        </div>
      )}

      {/* Hidden: useful for debugging in Wix iframe */}
      <div style={{ marginTop: 14, fontSize: 12, color: "#777" }}>
        <div>
          Debug: companionKey=<code>{companionKey || "(none)"}</code>
        </div>
        <div>
          Debug: api=<code>{API_BASE || "(missing NEXT_PUBLIC_API_BASE_URL)"}</code>
        </div>
      </div>
    </main>
  );
}
