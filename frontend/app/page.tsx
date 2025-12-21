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

/**
 * ✅ Standardize with backend: friend | romantic | intimate
 * (We still treat user text mentioning "explicit" as intimate intent.)
 */
type Mode = "friend" | "romantic" | "intimate";

type SessionState = {
  mode: Mode;
  adult_verified: boolean;
  romance_consented: boolean;
  explicit_consented: boolean; // keep key for backwards compatibility
  pending_consent: "romance" | "adult" | "intimate" | null;
  model: string;
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

type ChatApiResponse = {
  reply: string;
  session_state?: Partial<SessionState>;
  mode?: string; // backend echo (friend/romantic/intimate), but allow any string
};

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
    return false;
  } catch {
    return false;
  }
}

/**
 * Backend might return strings like "safe" in older versions.
 * We normalize only what we understand; otherwise return null (keep current).
 */
function normalizeBackendMode(maybe: any): Mode | null {
  const m = String(maybe || "").trim().toLowerCase();
  if (!m) return null;
  if (m === "friend") return "friend";
  if (m === "romantic") return "romantic";
  if (m === "intimate") return "intimate";
  if (m === "explicit") return "intimate"; // compatibility
  return null;
}

function requestedModeFromHint(text: string): Mode | null {
  const t = (text || "").toLowerCase();
  if (t.includes("mode:friend") || t.includes("[mode:friend]")) return "friend";
  if (t.includes("mode:romantic") || t.includes("[mode:romantic]")) return "romantic";
  if (t.includes("mode:intimate") || t.includes("[mode:intimate]")) return "intimate";
  // compatibility (old hint)
  if (t.includes("mode:explicit") || t.includes("[mode:explicit]")) return "intimate";
  return null;
}

function isRomanticRequest(text: string) {
  const t = (text || "").toLowerCase();
  return /\b(flirt|romance|romantic|date|kiss|love|boyfriend|girlfriend)\b/.test(t);
}

function isIntimateRequest(text: string) {
  const t = (text || "").toLowerCase();
  // Treat "explicit" as intimate intent
  return /\b(sex|nude|explicit|intimate|nsfw|oral|penetration|hardcore|18\+)\b/.test(t);
}

export default function Page() {
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = "AIHAVEN_SESSION_ID";
    let id = window.sessionStorage.getItem(key);
    if (!id) {
      id = (crypto as any).randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      window.sessionStorage.setItem(key, id);
    }
    sessionIdRef.current = id;
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

  // Greeting once per browser session per companion
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
      pickFirstExisting(avatarCandidates).then((picked) => setAvatarSrc(picked));

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

  async function callChat(nextMessages: Msg[], stateToSend: SessionState) {
    if (!API_BASE) throw new Error("NEXT_PUBLIC_API_BASE_URL is not set");

    const session_id =
      sessionIdRef.current ||
      (crypto as any).randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id,
        wants_explicit: stateToSend?.explicit_consented === true,
        session_state: stateToSend,
        messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Backend error ${res.status}: ${errText}`);
    }

    return (await res.json()) as ChatApiResponse;
  }

  async function send(textOverride?: string) {
    if (loading) return;

    const userText = (textOverride ?? input).trim();
    if (!userText) return;

    // Hint-based mode switch: [mode:intimate] etc
    const hintedMode = requestedModeFromHint(userText);
    if (hintedMode) {
      if (!allowedModes.includes(hintedMode)) {
        showUpgradeMessage(hintedMode);
        setInput("");
        return;
      }
      setSessionState((prev) => ({ ...prev, mode: hintedMode }));
      setInput("");
      const modeMsg: Msg = { role: "assistant", content: `Mode set to: ${MODE_LABELS[hintedMode]}` };
      setMessages((prev) => [...prev, modeMsg]);
      return;
    }

    // Plan gating for inferred intent
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

    // ✅ Auto-sync UI mode when the USER types "switch to romantic/intimate" (or uses intimate keywords)
    // This helps keep pills highlighted even without clicking the buttons.
    let inferredMode: Mode | null = null;
    if (isIntimateRequest(userText)) inferredMode = "intimate";
    else if (isRomanticRequest(userText)) inferredMode = "romantic";

    const stateToSend: SessionState =
      inferredMode && allowedModes.includes(inferredMode)
        ? { ...sessionState, mode: inferredMode }
        : sessionState;

    if (inferredMode && allowedModes.includes(inferredMode) && sessionState.mode !== inferredMode) {
      setSessionState(stateToSend);
      const modeMsg: Msg = { role: "assistant", content: `Mode set to: ${MODE_LABELS[inferredMode]}` };
      setMessages((prev) => [...prev, modeMsg]);
    }

    const userMsg: Msg = { role: "user", content: userText };
    const nextMessages: Msg[] = [...messages, userMsg];

    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      const data = await callChat(nextMessages, stateToSend);

      // Merge backend session_state + backend mode hint (if any)
      setSessionState((prev) => {
        const merged = { ...prev, ...(data.session_state ?? {}) };

        const backendMode = normalizeBackendMode(data.mode);
        if (backendMode && merged.mode !== backendMode) {
          return { ...merged, mode: backendMode };
        }
        return merged;
      });

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
        </div>
      </header>

      <section style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {modePills.map((m) => {
          const active = sessionState.mode === m;
          const disabled = !allowedModes.includes(m);
          return (
            <button
              key={m}
              disabled={disabled}
              onClick={() => {
                if (disabled) return showUpgradeMessage(m);

                setSessionState((prev) => ({ ...prev, mode: m }));

                const modeMsg: Msg = { role: "assistant", content: `Mode set to: ${MODE_LABELS[m]}` };
                setMessages((prev) => [...prev, modeMsg]);
              }}
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
      {sessionState.pending_consent && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
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
              Please confirm to proceed. (Pending: <b>{sessionState.pending_consent}</b>)
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => send("Yes")}
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
                onClick={() => send("No")}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  background: "#fff",
                }}
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
