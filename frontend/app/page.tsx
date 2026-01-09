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

type PlanName =
  | "Trial"
  | "Friend"
  | "Romantic"
  | "Intimate (18+)"
  | "Test - Friend"
  | "Test - Romantic"
  | "Test - Intimate (18+)"
  | null;

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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
const UPGRADE_URL = "https://www.aihaven4u.com/pricing-plans/list";

const MODE_LABELS: Record<Mode, string> = {
  friend: "Friend",
  romantic: "Romantic",
  intimate: "Intimate (18+)",
};

const ROMANTIC_ALLOWED_PLANS: PlanName[] = [
  "Trial",
  "Romantic",
  "Intimate (18+)",
  "Test - Romantic",
  "Test - Intimate (18+)",
];

// --- Phase 1: Live streaming talking-head avatars (D-ID) + unique ElevenLabs voices ---
// Source of truth: "Voice and Video Mappings v2.xlsx" (rows where Phase == 1)
type Phase1LiveAvatarConfig = {
  didAgentId: string;
  didClientKey: string;
  elevenVoiceId: string;
};

const PHASE1_LIVE_AVATARS: Record<string, Phase1LiveAvatarConfig> = {
  jennifer: {
    didAgentId: "v2_agt_n7itFF6f",
    didClientKey: "YXV0aDB8Njk2MDdmMjQxNTNhMDBjOTQ2ZjExMjk0Ong3TExORDhuSUdhOEdyNUpMNTBQTA==",
    elevenVoiceId: "19STyYD15bswVz51nqLf",
  },
  jason: {
    didAgentId: "v2_agt_WpC1hOBQ",
    didClientKey: "YXV0aDB8Njk2MDdmMjQxNTNhMDBjOTQ2ZjExMjk0Ong3TExORDhuSUdhOEdyNUpMNTBQTA==",
    elevenVoiceId: "j0jBf06B5YHDbCWVmlmr",
  },
  tonya: {
    didAgentId: "v2_agt_2lL6f5YY",
    didClientKey: "YXV0aDB8Njk2MDdmMjQxNTNhMDBjOTQ2ZjExMjk0Ong3TExORDhuSUdhOEdyNUpMNTBQTA==",
    elevenVoiceId: "Hybl6rg76ZOcgqZqN5WN",
  },
};

function getPhase1LiveAvatarConfig(companionFirstName: string): Phase1LiveAvatarConfig | null {
  const k = String(companionFirstName || "").trim().toLowerCase();
  if (!k) return null;
  return (PHASE1_LIVE_AVATARS as any)[k] ?? null;
}

function allowedModesForPlan(planName: PlanName): Mode[] {
  const modes: Mode[] = ["friend"];
  if (ROMANTIC_ALLOWED_PLANS.includes(planName)) modes.push("romantic");
  if (planName === "Intimate (18+)" || planName === "Test - Intimate (18+)")
    modes.push("intimate");
  return modes;
}

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
      // ignore
    }
  }
  return DEFAULT_AVATAR;
}

function greetingFor(name: string) {
  const n = (name || DEFAULT_COMPANION_NAME).trim() || DEFAULT_COMPANION_NAME;
  return `Hi, ${n} here. 😊 What's on your mind?`;
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
 * Detects a mode switch request in *user text* and returns:
 * - mode: desired mode
 * - cleaned: text with explicit [mode:*] removed (so it won't pollute the chat)
 *
 * Supports:
 * - [mode:romantic], mode:romantic
 * - "switch to romantic", "romantic mode", "set mode to romantic", etc.
 */
function detectModeSwitchAndClean(text: string): { mode: Mode | null; cleaned: string } {
  const raw = text || "";
  const t = raw.toLowerCase();

  // explicit tokens
  // NOTE: allow "romance" token from older builds as a synonym for "romantic"
  const tokenRe =
    /\[mode:(friend|romantic|romance|intimate|explicit)\]|mode:(friend|romantic|romance|intimate|explicit)/gi;

  let tokenMode: Mode | null = null;
  let cleaned = raw.replace(tokenRe, (m) => {
    const mm = m.toLowerCase();
    if (mm.includes("friend")) tokenMode = "friend";
    else if (mm.includes("romantic") || mm.includes("romance")) tokenMode = "romantic";
    else if (mm.includes("intimate") || mm.includes("explicit")) tokenMode = "intimate";
    return "";
  });

  cleaned = cleaned.trim();

  if (tokenMode) return { mode: tokenMode, cleaned };

  // soft phrasing (covers friend->romantic and intimate->romantic)
  const soft = t.trim();

  const wantsFriend =
    /\b(switch|set|turn|go|back)\b.*\bfriend\b/.test(soft) || /\bfriend mode\b/.test(soft);

  const wantsRomantic =
    // "romantic mode" / "romance mode"
    /\b(romantic|romance) mode\b/.test(soft) ||
    // switch/set/back/go/turn ... romantic
    /\b(switch|set|turn|go|back)\b.*\b(romantic|romance)\b/.test(soft) ||
    // natural phrasing users actually type
    /\b(let['’]?s|lets)\b.*\b(romantic|romance)\b/.test(soft) ||
    /\b(be|being|try|trying|have|having)\b.*\b(romantic|romance)\b/.test(soft) ||
    /\bromantic conversation\b/.test(soft) ||
    /\bromance again\b/.test(soft) ||
    /\btry romance again\b/.test(soft);

  const wantsIntimate =
    /\b(switch|set|turn|go|back)\b.*\b(intimate|explicit|adult|18\+)\b/.test(soft) ||
    /\b(intimate|explicit) mode\b/.test(soft);

  if (wantsFriend) return { mode: "friend", cleaned: raw };
  if (wantsRomantic) return { mode: "romantic", cleaned: raw };
  if (wantsIntimate) return { mode: "intimate", cleaned: raw };

  return { mode: null, cleaned: raw.trim() };
}

function normalizeMode(raw: any): Mode | null {
  const t = String(raw ?? "").trim().toLowerCase();
  if (!t) return null;

  if (t === "friend") return "friend";
  if (t === "romantic" || t === "romance") return "romantic";
  if (t === "intimate" || t === "explicit" || t === "adult" || t === "18+" || t === "18") return "intimate";

  return null;
}

type LiveAvatarStatus = "off" | "connecting" | "connected" | "error";

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

  const [chatStatus, setChatStatus] = useState<ChatStatus>("safe");

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

  const [companionName, setCompanionName] = useState<string>(DEFAULT_COMPANION_NAME);
  const [avatarSrc, setAvatarSrc] = useState<string>(DEFAULT_AVATAR);
  const [companionKey, setCompanionKey] = useState<string>("");

  // Phase 1 D-ID + ElevenLabs config
  const phase1LiveCfg = useMemo(() => getPhase1LiveAvatarConfig(companionName), [companionName]);
  const liveAvatarAvailable = !!phase1LiveCfg;

  // D-ID streaming refs/state
  const didVideoRef = useRef<HTMLVideoElement | null>(null);
  const didAgentManagerRef = useRef<any>(null);
  const didAgentIdRef = useRef<string | null>(null);

  const [liveAvatarEnabled, setLiveAvatarEnabled] = useState(false);
  const [liveAvatarStatus, setLiveAvatarStatus] = useState<LiveAvatarStatus>("off");
  const [liveAvatarError, setLiveAvatarError] = useState("");

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

    const desiredName = (companionName || DEFAULT_COMPANION_NAME).trim() || DEFAULT_COMPANION_NAME;

    const keyName = normalizeKeyForFile(desiredName);
    const greetKey = `${GREET_ONCE_KEY}:${keyName}`;

    const tmr = window.setTimeout(() => {
      const already = sessionStorage.getItem(greetKey) === "1";
      const greetingText = greetingFor(desiredName);

      const greetingMsg: Msg = {
        role: "assistant",
        content: greetingText,
      };

      setMessages((prev) => {
        if (prev.length === 0) {
          return already ? prev : [greetingMsg];
        }

        if (prev.length === 1 && prev[0].role === "assistant") {
          const existing = String((prev[0] as any)?.content ?? "");
          const m = existing.match(/^Hi,\s*(.+?)\s+here\./i);
          const existingName = m?.[1]?.trim();
          if (existingName && existingName.toLowerCase() !== desiredName.toLowerCase()) {
            return [{ ...prev[0], content: greetingText }];
          }
        }

        return prev;
      });

      if (!already) sessionStorage.setItem(greetKey, "1");
    }, 150);

    return () => window.clearTimeout(tmr);
  }, [companionName]);

  async function disconnectLiveAvatar() {
    try {
      await didAgentManagerRef.current?.disconnect?.();
    } catch {
      // ignore
    }
    didAgentManagerRef.current = null;
    didAgentIdRef.current = null;

    if (didVideoRef.current) {
      try {
        (didVideoRef.current as any).srcObject = null;
      } catch {
        // ignore
      }
    }
  }

  async function connectLiveAvatar(): Promise<boolean> {
    if (!phase1LiveCfg || !liveAvatarAvailable) {
      setLiveAvatarStatus("error");
      setLiveAvatarError("Live avatar is not configured for this companion.");
      return false;
    }

    if (didAgentManagerRef.current && didAgentIdRef.current === phase1LiveCfg.didAgentId) {
      setLiveAvatarStatus("connected");
      return true;
    }

    setLiveAvatarStatus("connecting");
    setLiveAvatarError("");

    await disconnectLiveAvatar();

    try {
      const sdk: any = await import("@d-id/client-sdk");
      const createAgentManager: any = sdk.createAgentManager || sdk.default?.createAgentManager;

      if (!createAgentManager) throw new Error("D-ID SDK: createAgentManager not found");

      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const videoEl = didVideoRef.current;
      if (!videoEl) throw new Error("Live Avatar video element is not ready.");

      const manager: any = await createAgentManager(phase1LiveCfg.didAgentId, {
        auth: { type: "key", clientKey: phase1LiveCfg.didClientKey },
        callbacks: {
          onSrcObjectReady: (stream: MediaStream) => {
            if (!didVideoRef.current) return;
            (didVideoRef.current as any).srcObject = stream as any;

            const p = didVideoRef.current.play?.();
            if (p && typeof (p as any).catch === "function") {
              (p as any).catch(() => {});
            }
          },
        },
        streamOptions: { compatibilityMode: "auto", streamWarmup: true },
      });

      didAgentManagerRef.current = manager;
      didAgentIdRef.current = phase1LiveCfg.didAgentId;

      await manager.connect?.();
      setLiveAvatarStatus("connected");
      return true;
    } catch (err: any) {
      setLiveAvatarStatus("error");
      setLiveAvatarError(err?.message ?? "Failed to connect to live avatar");
      await disconnectLiveAvatar();
      return false;
    }
  }

  async function startLiveAvatar() {
    if (!liveAvatarAvailable) {
      setLiveAvatarStatus("error");
      setLiveAvatarError("Live avatar is not available for this companion.");
      return;
    }
    setLiveAvatarEnabled(true);
    await connectLiveAvatar();
  }

  async function stopLiveAvatar() {
    setLiveAvatarEnabled(false);
    setLiveAvatarStatus("off");
    setLiveAvatarError("");
    await disconnectLiveAvatar();
  }

  useEffect(() => {
    return () => {
      void disconnectLiveAvatar();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!liveAvatarEnabled) return;
    void stopLiveAvatar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companionName]);

  async function getTtsAudioUrl(text: string): Promise<string | null> {
    if (!API_BASE) return null;
    if (!phase1LiveCfg?.elevenVoiceId) return null;

    const session_id =
      sessionIdRef.current ||
      (crypto as any).randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    try {
      const res = await fetch(`${API_BASE}/tts/audio-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id,
          voice_id: phase1LiveCfg.elevenVoiceId,
          text,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`TTS error ${res.status}: ${errText}`);
      }

      const data = await res.json().catch(() => ({} as any));
      return (data as any)?.audio_url ?? null;
    } catch (e: any) {
      setLiveAvatarStatus("error");
      setLiveAvatarError(e?.message ?? "Failed to fetch TTS audio URL");
      return null;
    }
  }

  async function speakAssistantReply(text: string, statusFromBackend?: ChatStatus) {
    try {
      if (!liveAvatarEnabled) return;
      if (liveAvatarStatus !== "connected") return;
      if (!phase1LiveCfg) return;
      if (!didAgentManagerRef.current) return;

      if (statusFromBackend === "explicit_blocked") return;

      const audioUrl = await getTtsAudioUrl(text);
      if (!audioUrl) return;

      await didAgentManagerRef.current.speak?.({
        type: "audio",
        audio_url: audioUrl,
      });
    } catch (e: any) {
      setLiveAvatarStatus("error");
      setLiveAvatarError(e?.message ?? "Failed to speak via live avatar");
    }
  }

  function showUpgradeMessage(requestedMode: Mode) {
    const modeLabel = MODE_LABELS[requestedMode];
    const msg =
      `The requested mode (${modeLabel}) isn't available on your current plan. ` +
      `Please upgrade here: ${UPGRADE_URL}`;

    setMessages((prev) => [...prev, { role: "assistant", content: msg }]);
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

        setSessionState((prev) => ({
          ...prev,
          companion: parsed.key,
          companionName: parsed.key,
          companion_name: parsed.key,
        }));
      } else {
        setCompanionKey("");
        setCompanionName(DEFAULT_COMPANION_NAME);

        setSessionState((prev) => ({
          ...prev,
          companion: DEFAULT_COMPANION_NAME,
          companionName: DEFAULT_COMPANION_NAME,
          companion_name: DEFAULT_COMPANION_NAME,
        }));
      }

      const avatarCandidates = buildAvatarCandidates(resolvedCompanionKey || DEFAULT_COMPANION_NAME);
      pickFirstExisting(avatarCandidates).then((picked) => setAvatarSrc(picked));

      const nextAllowed = allowedModesForPlan(incomingPlan);
      setAllowedModes(nextAllowed);

      setSessionState((prev) => {
        if (nextAllowed.includes(prev.mode)) return prev;
        return { ...prev, mode: "friend", pending_consent: null };
      });
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function callChat(nextMessages: Msg[], stateToSend: SessionState): Promise<ChatApiResponse> {
    if (!API_BASE) throw new Error("NEXT_PUBLIC_API_BASE_URL is not set");

    const session_id =
      sessionIdRef.current ||
      (crypto as any).randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const wants_explicit = stateToSend.mode === "intimate";

    const companionForBackend =
      (companionKey || "").trim() ||
      (companionName || DEFAULT_COMPANION_NAME).trim() ||
      DEFAULT_COMPANION_NAME;

    const stateToSendWithCompanion: SessionState = {
      ...stateToSend,
      companion: companionForBackend,
      companionName: companionForBackend,
      companion_name: companionForBackend,
    };

    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id,
        wants_explicit,
        session_state: stateToSendWithCompanion,
        messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Backend error ${res.status}: ${errText}`);
    }

    return (await res.json()) as ChatApiResponse;
  }

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
      const nextPending = m === "intimate" ? prev.pending_consent : null;
      return { ...prev, mode: m, pending_consent: nextPending };
    });

    setMessages((prev) => [...prev, { role: "assistant", content: `Mode set to: ${MODE_LABELS[m]}` }]);
  }

  async function send(textOverride?: string, stateOverride?: Partial<SessionState>) {
    if (loading) return;

    const rawText = (textOverride ?? input).trim();
    if (!rawText) return;

    const { mode: detectedMode, cleaned } = detectModeSwitchAndClean(rawText);

    if (detectedMode && !allowedModes.includes(detectedMode)) {
      showUpgradeMessage(detectedMode);
      setInput("");
      return;
    }

    if (detectedMode && cleaned.length === 0) {
      setSessionState((prev) => ({ ...prev, mode: detectedMode, pending_consent: null }));
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Mode set to: ${MODE_LABELS[detectedMode]}` },
      ]);
      setInput("");
      return;
    }

    let nextState: SessionState = sessionState;
    if (detectedMode) {
      const nextPending = detectedMode === "intimate" ? sessionState.pending_consent : null;
      nextState = { ...sessionState, mode: detectedMode, pending_consent: nextPending };

      if (detectedMode !== "intimate") {
        setChatStatus("safe");
      }

      setSessionState(nextState);
    }

    const outgoingText = detectedMode ? cleaned : rawText;

    const userMsg: Msg = { role: "user", content: outgoingText };
    const nextMessages: Msg[] = [...messages, userMsg];

    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      const sendState: SessionState = { ...nextState, ...(stateOverride || {}) };
      const data = await callChat(nextMessages, sendState);

      if (data.mode === "safe" || data.mode === "explicit_blocked" || data.mode === "explicit_allowed") {
        setChatStatus(data.mode);
      }

      const serverSessionState: any = (data as any).session_state ?? (data as any).sessionState;

      if (serverSessionState) {
        setSessionState((prev) => {
          const merged: SessionState = { ...(prev as any), ...(serverSessionState as any) };

          if (data.mode === "explicit_blocked") {
            merged.mode = "intimate";
            merged.pending_consent = "intimate";
          }

          if (data.mode === "explicit_allowed" && merged.pending_consent) {
            merged.pending_consent = null;
          }

          const backendMode = normalizeMode((serverSessionState as any)?.mode ?? (data as any)?.mode);
          if (backendMode && data.mode !== "explicit_blocked") {
            merged.mode = backendMode;
          }

          if (merged.mode !== "intimate" && merged.pending_consent === "intimate") {
            merged.pending_consent = null;
          }

          return merged;
        });
      } else {
        if (data.mode === "explicit_blocked") {
          setSessionState((prev) => ({ ...prev, mode: "intimate", pending_consent: "intimate" }));
        }

        if (data.mode === "explicit_allowed") {
          setSessionState((prev) => ({ ...prev, pending_consent: null, explicit_consented: true }));
        }

        const backendMode = normalizeMode((data as any)?.mode);
        if (backendMode && data.mode !== "explicit_blocked") {
          setSessionState((prev) => ({
            ...prev,
            mode: backendMode,
            pending_consent: backendMode === "intimate" ? prev.pending_consent : null,
          }));
        }
      }

      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);

      void speakAssistantReply(data.reply, data.mode as any);
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

          {liveAvatarAvailable && (
            <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button
                onClick={() => {
                  if (liveAvatarEnabled) void stopLiveAvatar();
                  else void startLiveAvatar();
                }}
                style={{
                  padding: "6px 10px",
                  borderRadius: 10,
                  border: "1px solid #111",
                  background: liveAvatarEnabled ? "#fff" : "#111",
                  color: liveAvatarEnabled ? "#111" : "#fff",
                  cursor: "pointer",
                }}
              >
                {liveAvatarEnabled ? "Stop Live Avatar" : "Start Live Avatar"}
              </button>

              <span style={{ fontSize: 12, color: "#666" }}>
                Live Avatar: <b>{liveAvatarStatus}</b>
              </span>

              {liveAvatarStatus === "error" && liveAvatarError ? (
                <span style={{ fontSize: 12, color: "#b00020" }}>{liveAvatarError}</span>
              ) : null}
            </div>
          )}
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
              onClick={() => {
                if (disabled) return showUpgradeMessage(m);
                setModeFromPill(m);
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
        {liveAvatarEnabled && (
          <div style={{ marginBottom: 12 }}>
            <video
              ref={didVideoRef}
              playsInline
              autoPlay
              style={{
                width: "100%",
                maxHeight: 320,
                borderRadius: 12,
                background: "#000",
              }}
            />
          </div>
        )}

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
                  setSessionState((prev) => ({ ...prev, pending_consent: "intimate", mode: "intimate" }));
                  send("Yes", { pending_consent: "intimate", mode: "intimate" });
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
                  setSessionState((prev) => ({ ...prev, pending_consent: "intimate", mode: "intimate" }));
                  send("No", { pending_consent: "intimate", mode: "intimate" });
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
              Tip: You can also type <b>[mode:intimate]</b> or <b>[mode:romantic]</b> to switch.
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
