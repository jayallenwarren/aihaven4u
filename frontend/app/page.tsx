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

type Phase1AvatarMedia = {
  didAgentId: string;
  didClientKey: string;
  elevenVoiceId: string;
};

const PHASE1_AVATAR_MEDIA: Record<string, Phase1AvatarMedia> = {
  "Jennifer": {
    "didAgentId": "v2_agt_n7itFF6f",
    "didClientKey": "YXV0aDB8Njk2MDdmMjQxNTNhMDBjOTQ2ZjExMjk0Ong3TExORDhuSUdhOEdyNUpMNTBQTA==",
    "elevenVoiceId": "19STyYD15bswVz51nqLf"
  },
  "Jason": {
    "didAgentId": "v2_agt_WpC1hOBQ",
    "didClientKey": "YXV0aDB8Njk2MDdmMjQxNTNhMDBjOTQ2ZjExMjk0Ong3TExORDhuSUdhOEdyNUpMNTBQTA==",
    "elevenVoiceId": "j0jBf06B5YHDbCWVmlmr"
  },
  "Tonya": {
    "didAgentId": "v2_agt_2lL6f5YY",
    "didClientKey": "YXV0aDB8Njk2MDdmMjQxNTNhMDBjOTQ2ZjExMjk0Ong3TExORDhuSUdhOEdyNUpMNTBQTA==",
    "elevenVoiceId": "Hybl6rg76ZOcgqZqN5WN"
  }
} as any;

const ELEVEN_VOICE_ID_BY_AVATAR: Record<string, string> = {
  "Jennifer": "19STyYD15bswVz51nqLf",
  "Jason": "j0jBf06B5YHDbCWVmlmr",
  "Tonya": "Hybl6rg76ZOcgqZqN5WN",
  "Darnell": "gYr8yTP0q4RkX1HnzQfX",
  "Michelle": "ui11Rd52NKH2DbWlcbvw",
  "Daniel": "tcO8jJ1XXzdQ4pzViV9c",
  "Veronica": "GDzHdQOi6jjf8zaXhCYD",
  "Ricardo": "l1zE9xgNpUTaQCZzpNJa",
  "Linda": "flHkNRp1BlvT73UL6gyz",
  "Robert": "uA0L9FxeLpzlG615Ueay",
  "Patricia": "zwbQ2XUiIlOKD6b3JWXd",
  "Clarence": "CXAc4DNZL6wonQQNlNgZ",
  "Mei": "bQQWtYx9EodAqMdkrNAc",
  "Minh": "cALE2CwoMM2QxiEdDEhv",
  "Maria": "WLjZnm4PkNmYtNCyiCq8",
  "Jose": "IP2syKL31S2JthzSSfZH",
  "Ashley": "GbDIo39THauInuigCmPM",
  "Ryan": "qIT7IrVUa21IEiKE1lug",
  "Latoya": "BZgkqPqms7Kj9ulSkVzn",
  "Jamal": "3w1kUvxu1LioQcLgp1KY",
  "Tiffany": "XeomjLZoU5rr4yNIg16w",
  "Kevin": "69Na567Zr0bPvmBYuGdc",
  "Adriana": "FGLJyeekUzxl8M3CTG9M",
  "Miguel": "dlGxemPxFMTY7iXagmOj",
  "Haven": "rJ9XoWu8gbUhVKZnKY8X",
};

function getElevenVoiceIdForAvatar(avatarName: string | null | undefined): string {
  const key = (avatarName || "").trim();
  if (key && ELEVEN_VOICE_ID_BY_AVATAR[key]) return ELEVEN_VOICE_ID_BY_AVATAR[key];
  // Fallback to Haven so audio-only TTS always has a voice.
  return ELEVEN_VOICE_ID_BY_AVATAR["Haven"] || "";
}
function getPhase1AvatarMedia(avatarName: string | null | undefined): Phase1AvatarMedia | null {
  if (!avatarName) return null;

  const direct = PHASE1_AVATAR_MEDIA[avatarName];
  if (direct) return direct;

  const key = Object.keys(PHASE1_AVATAR_MEDIA).find(
    (k) => k.toLowerCase() === avatarName.toLowerCase()
  );
  return key ? PHASE1_AVATAR_MEDIA[key] : null;
}

function isDidSessionError(err: any): boolean {
  const kind = typeof err?.kind === "string" ? err.kind : "";
  const description = typeof err?.description === "string" ? err.description : "";
  const message = typeof err?.message === "string" ? err.message : "";

  // The SDK sometimes uses { kind, description } and sometimes uses message strings.
  return (
    kind === "SessionError" ||
    description.toLowerCase().includes("session_id") ||
    message.toLowerCase().includes("session_id")
  );
}

function formatDidError(err: any): string {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (typeof err?.message === "string") return err.message;

  const kind = typeof err?.kind === "string" ? err.kind : undefined;
  const description = typeof err?.description === "string" ? err.description : undefined;

  if (kind || description) {
    return JSON.stringify({ kind, description });
  }

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

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


export default function Page() {
  // iOS detection (includes iPadOS 13+ which reports itself as "Macintosh")
  const isIOS = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const iOS = /iPad|iPhone|iPod/i.test(ua);
    const iPadOS13 = /Macintosh/i.test(ua) && typeof document !== "undefined" && "ontouchend" in document;
    return iOS || iPadOS13;
  }, []);

  const isIphone = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    return /iPhone|iPod/i.test(navigator.userAgent || "");
  }, []);

  const isEmbedded = useMemo(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.self !== window.top;
    } catch {
      // Cross-origin access to window.top can throw; assume embedded.
      return true;
    }
  }, []);


  const sessionIdRef = useRef<string | null>(null);

  // -----------------------
  // Debug overlay (mobile-friendly)
  // Enable with ?debug=1 OR tap the avatar image 5 times quickly.
  // -----------------------
  const DEBUG_KEY = "AIHAVEN_DEBUG_OVERLAY";
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const debugEnabledRef = useRef(false);
  const debugTapCountRef = useRef(0);
  const debugTapTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const qs = new URLSearchParams(window.location.search);
      const fromQuery = qs.get("debug") === "1";
      const fromStorage = window.localStorage.getItem(DEBUG_KEY) === "1";
      if (fromQuery || fromStorage) {
        setDebugEnabled(true);
        setDebugOpen(true);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    debugEnabledRef.current = debugEnabled;
    if (typeof window === "undefined") return;
    try {
      if (debugEnabled) window.localStorage.setItem(DEBUG_KEY, "1");
      else window.localStorage.removeItem(DEBUG_KEY);
    } catch {
      // ignore
    }
  }, [debugEnabled]);

  const pushDebug = useCallback((level: "log" | "warn" | "error", ...args: any[]) => {
    if (!debugEnabledRef.current) return;
    try {
      const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
      const text = args
        .map((a) => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");
      const line = `[${ts}] ${level.toUpperCase()}: ${text}`;
      setDebugLogs((prev) => {
        const next = [...prev, line];
        return next.length > 250 ? next.slice(next.length - 250) : next;
      });
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!debugEnabled) return;

    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args: any[]) => {
      origLog(...args);
      pushDebug("log", ...args);
    };
    console.warn = (...args: any[]) => {
      origWarn(...args);
      pushDebug("warn", ...args);
    };
    console.error = (...args: any[]) => {
      origError(...args);
      pushDebug("error", ...args);
    };

    const onError = (e: any) => {
      pushDebug("error", "window.error", e?.message ?? e);
    };
    const onRejection = (e: any) => {
      pushDebug("error", "unhandledrejection", e?.reason ?? e);
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    try {
      pushDebug("log", "Debug enabled", {
        href: window.location.href,
        embedded: isEmbedded,
        ua: navigator.userAgent,
      });
    } catch {
      // ignore
    }

    return () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [debugEnabled, isEmbedded, pushDebug]);

  const secretDebugTap = useCallback(() => {
    if (typeof window === "undefined") return;

    debugTapCountRef.current += 1;

    if (debugTapTimerRef.current) window.clearTimeout(debugTapTimerRef.current);
    debugTapTimerRef.current = window.setTimeout(() => {
      debugTapCountRef.current = 0;
      debugTapTimerRef.current = null;
    }, 1400);

    if (debugTapCountRef.current >= 5) {
      debugTapCountRef.current = 0;

      if (!debugEnabledRef.current) {
        debugEnabledRef.current = true;
        setDebugEnabled(true);
      }
      setDebugOpen((v) => !v);
    }
  }, []);



  // Local audio-only TTS element (used when Live Avatar is not active/available)
  const localTtsAudioRef = useRef<HTMLAudioElement | null>(null);
  const localTtsVideoRef = useRef<HTMLVideoElement | null>(null);
  const localTtsUnlockedRef = useRef(false);


  // Companion identity (drives persona + Phase 1 live avatar mapping)
  const [companionName, setCompanionName] = useState<string>(DEFAULT_COMPANION_NAME);
  const [avatarSrc, setAvatarSrc] = useState<string>(DEFAULT_AVATAR);
  const [companionKey, setCompanionKey] = useState<string>("");


// ----------------------------
// Phase 1: Live Avatar (D-ID) + TTS (ElevenLabs -> Azure Blob)
// ----------------------------
const avatarVideoRef = useRef<HTMLVideoElement | null>(null);
const didSrcObjectRef = useRef<any | null>(null);
const didAgentMgrRef = useRef<any | null>(null);
const didReconnectInFlightRef = useRef<boolean>(false);

// iPhone-only: boost Live Avatar audio by routing the streamed MediaStream audio through WebAudio.
// This avoids iPhone's low/receiver-like WebRTC audio output and makes the avatar clearly audible.
const didIphoneAudioCtxRef = useRef<AudioContext | null>(null);
const didIphoneAudioSrcRef = useRef<MediaStreamAudioSourceNode | null>(null);
const didIphoneAudioGainRef = useRef<GainNode | null>(null);
const didIphoneBoostActiveRef = useRef<boolean>(false);


  const [avatarStatus, setAvatarStatus] = useState<
    "idle" | "connecting" | "connected" | "reconnecting" | "error"
  >(
  "idle"
);
const [avatarError, setAvatarError] = useState<string | null>(null);

const phase1AvatarMedia = useMemo(() => getPhase1AvatarMedia(companionName), [companionName]);

  // UI layout
  const conversationHeight = 520;
  const showAvatarFrame = Boolean(phase1AvatarMedia) && avatarStatus !== "idle";

const cleanupIphoneLiveAvatarAudio = useCallback(() => {
  if (!didIphoneBoostActiveRef.current && !didIphoneAudioCtxRef.current) return;

  didIphoneBoostActiveRef.current = false;

  try {
    didIphoneAudioSrcRef.current?.disconnect();
  } catch {}
  try {
    didIphoneAudioGainRef.current?.disconnect();
  } catch {}

  didIphoneAudioSrcRef.current = null;
  didIphoneAudioGainRef.current = null;

  try {
    // Closing releases resources; we recreate on demand.
    didIphoneAudioCtxRef.current?.close?.();
  } catch {}
  didIphoneAudioCtxRef.current = null;

  // Restore video element audio defaults (in case we muted it for iPhone boost)
  const vid = avatarVideoRef.current;
  if (vid) {
    try {
      vid.muted = false;
      vid.volume = 1;
    } catch {}
  }
}, []);

const ensureIphoneAudioContextUnlocked = useCallback(() => {
  if (!isIphone) return;
  if (typeof window === "undefined") return;

  try {
    const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;

    if (!didIphoneAudioCtxRef.current) {
      didIphoneAudioCtxRef.current = new AudioCtx();
    }

    const ctx = didIphoneAudioCtxRef.current;
    // Resume inside user gesture when possible
    if (ctx?.state === "suspended" && ctx.resume) {
      ctx.resume().catch(() => {});
    }
  } catch {
    // ignore
  }
}, [isIphone]);

const applyIphoneLiveAvatarAudioBoost = useCallback(
  (stream: any) => {
    if (!isIphone) return;
    if (typeof window === "undefined") return;

    if (!stream || typeof stream.getAudioTracks !== "function") return;
    const tracks = stream.getAudioTracks();
    if (!tracks || tracks.length === 0) return;

    try {
      const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      let ctx = didIphoneAudioCtxRef.current;
      if (!ctx) {
        ctx = new AudioCtx();
        didIphoneAudioCtxRef.current = ctx;
      }

      if (ctx?.state === "suspended" && ctx.resume) {
        ctx.resume().catch(() => {});
      }

      // Clear any previous routing
      try {
        didIphoneAudioSrcRef.current?.disconnect();
      } catch {}
      try {
        didIphoneAudioGainRef.current?.disconnect();
      } catch {}

      // Route MediaStream audio -> Gain -> destination
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();

      // Boost amount tuned for iPhone; iPad/Desktop already fine.
      gain.gain.value = 2.6;

      source.connect(gain);
      gain.connect(ctx.destination);

      didIphoneAudioSrcRef.current = source;
      didIphoneAudioGainRef.current = gain;
      didIphoneBoostActiveRef.current = true;

      // Mute the <video>'s audio so we don't get double audio (and avoid iPhone low WebRTC path)
      const vid = avatarVideoRef.current;
      if (vid) {
        try {
          vid.muted = true;
          vid.volume = 0;
        } catch {}
      }
    } catch (e) {
      console.warn("iPhone Live Avatar audio boost failed:", e);
    }
  },
  [isIphone]
);




const stopLiveAvatar = useCallback(async () => {
  // Always clean up iPhone audio boost routing first
  cleanupIphoneLiveAvatarAudio();

  try {
    const mgr = didAgentMgrRef.current;
    didAgentMgrRef.current = null;

    // Stop any remembered MediaStream (important if we were showing idle_video and vid.srcObject is null)
    const remembered = didSrcObjectRef.current;
    didSrcObjectRef.current = null;

    if (mgr) {
      await mgr.disconnect();
    }

    try {
      if (remembered && typeof remembered.getTracks === "function") {
        remembered.getTracks().forEach((t: any) => t?.stop?.());
      }
    } catch {
      // ignore
    }

    const vid = avatarVideoRef.current;
    if (vid) {
      const srcObj = vid.srcObject as MediaStream | null;
      if (srcObj && typeof srcObj.getTracks === "function") {
        srcObj.getTracks().forEach((t) => t.stop());
      }
      vid.srcObject = null;

      // If we were displaying the presenter's idle_video, clear it too.
      try {
        vid.pause();
        vid.removeAttribute("src");
        (vid as any).src = "";
        vid.load?.();
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  } finally {
    setAvatarStatus("idle");
    setAvatarError(null);
  }
}, [cleanupIphoneLiveAvatarAudio]);

const reconnectLiveAvatar = useCallback(async () => {
  const mgr = didAgentMgrRef.current;
  if (!mgr) return;
  if (didReconnectInFlightRef.current) return;

  didReconnectInFlightRef.current = true;
  setAvatarError(null);
  setAvatarStatus("reconnecting");

  try {
    if (typeof (mgr as any).reconnect === "function") {
      await (mgr as any).reconnect();
    } else {
      // Fallback for SDK versions without reconnect()
      await mgr.disconnect();
      await mgr.connect();
    }
  } catch (err: any) {
    console.error("D-ID reconnect failed", err);
    setAvatarStatus("idle");
    setAvatarError(`Live Avatar reconnect failed: ${formatDidError(err)}`);
  } finally {
    didReconnectInFlightRef.current = false;
  }
}, []);

const startLiveAvatar = useCallback(async () => {
  setAvatarError(null);
  ensureIphoneAudioContextUnlocked();

  if (!phase1AvatarMedia) {
    setAvatarStatus("error");
    setAvatarError("Live Avatar is not enabled for this companion in Phase 1.");
    return;
  }

  if (
    avatarStatus === "connecting" ||
    avatarStatus === "connected" ||
    avatarStatus === "reconnecting"
  )
    return;

  setAvatarStatus("connecting");

  try {
    // Defensive: if something is lingering from a prior attempt, disconnect & clear.
    try {
      if (didAgentMgrRef.current) {
        await didAgentMgrRef.current.disconnect();
      }
    } catch {}
    didAgentMgrRef.current = null;

    try {
      const existingStream = didSrcObjectRef.current;
      if (existingStream && typeof existingStream.getTracks === "function") {
        existingStream.getTracks().forEach((t: any) => t?.stop?.());
      }
    } catch {}
    didSrcObjectRef.current = null;
    if (avatarVideoRef.current) {
      try {
        const vid = avatarVideoRef.current;
        vid.srcObject = null;
        vid.pause();
        vid.removeAttribute("src");
        (vid as any).src = "";
        vid.load?.();
      } catch {
        // ignore
      }
    }

    const { createAgentManager } = await import("@d-id/client-sdk");
    // NOTE: Some versions of @d-id/client-sdk ship stricter TS types (e.g., requiring
    // additional top-level fields like `mode`) that are not present in the public
    // quickstart snippets. We keep runtime behavior aligned with D-ID docs and
    // cast the options object to `any` to avoid CI type-check failures.
    const mgr = await createAgentManager(
      phase1AvatarMedia.didAgentId,
      {
      auth: { type: "key", clientKey: phase1AvatarMedia.didClientKey },
      callbacks: {
        onConnectionStateChange: (state: any) => {
          if (state === "connected") {
            setAvatarStatus("connected");
            setAvatarError(null);
          }
          if (state === "disconnected" || state === "closed") setAvatarStatus("idle");
        },

        // Mandatory per D-ID docs: bind the streamed MediaStream to the <video>.
        onSrcObjectReady: (value: any) => {
          didSrcObjectRef.current = value;
          const vid = avatarVideoRef.current;
          if (vid) {
            // If we were showing the presenter's idle_video, clear it before attaching the MediaStream
            try {
              vid.removeAttribute("src");
              (vid as any).src = "";
              vid.load?.();
            } catch {
              // ignore
            }
            vid.loop = false;
            vid.srcObject = value;
            vid.play().catch(() => {});
            // iPhone: route WebRTC audio through WebAudio gain so volume is audible
            applyIphoneLiveAvatarAudioBoost(value);
          }
          return value;
        },

        onVideoStateChange: (state: any) => {
          const vid = avatarVideoRef.current;
          if (!vid) return;

          const s = typeof state === "string" ? state : String(state ?? "");
          const mgr = didAgentMgrRef.current;
          const stream = didSrcObjectRef.current;

          // When the live stream stops, switch to the presenter's idle_video so the avatar isn't frozen.
          if (s === "STOP") {
            const idleUrl = mgr?.agent?.presenter?.idle_video;
            if (idleUrl) {
              try {
                // Detach the MediaStream (do NOT stop tracks; we may resume).
                vid.srcObject = null;
                if (vid.src !== idleUrl) vid.src = idleUrl;
                vid.loop = true;
                vid.play().catch(() => {});
              } catch {
                // ignore
              }
            }
            return;
          }

          // Any non-STOP state: ensure we are showing the live MediaStream.
          if (stream) {
            try {
              // Clear idle video if it was set
              if (vid.src) {
                vid.pause();
                vid.removeAttribute("src");
                (vid as any).src = "";
                vid.load?.();
              }
              vid.loop = false;
              vid.srcObject = stream;
              vid.play().catch(() => {});
            } catch {
              // ignore
            }
          }
        },

        onError: (err: any) => {
          if (isDidSessionError(err)) {
            console.warn("D-ID SessionError; attempting reconnect", err);
            void reconnectLiveAvatar();
            return;
          }
          setAvatarStatus("error");
          setAvatarError(formatDidError(err));
        },
      },
      streamOptions: { compatibilityMode: "auto", streamWarmup: true },
      } as any
    );

    didAgentMgrRef.current = mgr;
    await mgr.connect();
  } catch (e: any) {
    setAvatarStatus("error");
    setAvatarError(e?.message ? String(e.message) : "Failed to start Live Avatar");
    didAgentMgrRef.current = null;
  }
}, [phase1AvatarMedia, avatarStatus, reconnectLiveAvatar, ensureIphoneAudioContextUnlocked, applyIphoneLiveAvatarAudioBoost]);

useEffect(() => {
  // Stop when switching companions
  void stopLiveAvatar();
}, [companionKey]); // eslint-disable-line react-hooks/exhaustive-deps

const getTtsAudioUrl = useCallback(async (text: string, voiceId: string): Promise<string | null> => {
  try {
    const res = await fetch(`${API_BASE}/tts/audio-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionIdRef.current || "anon",
        voice_id: voiceId,
        text,
      }),
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      console.warn("TTS/audio-url failed:", res.status, msg);
      return null;
    }

    const data = (await res.json()) as { audio_url?: string };
    return data.audio_url || null;
  } catch (e) {
    console.warn("TTS/audio-url error:", e);
    return null;
  }
}, []);

  type SpeakAssistantHooks = {
    // Called right before we ask D-ID to speak.
    // Used to delay the assistant text until the avatar begins speaking.
    onWillSpeak?: () => void;
    // Called when we cannot / did not speak via D-ID.
    onDidNotSpeak?: () => void;
  };

  // ---------- Local (audio-only) TTS playback ----------
  // Used when Live Avatar is NOT active/available, but the user is in hands-free STT mode.
  // iOS Safari requires a user gesture to "unlock" programmatic audio playback, so we prime
  // this hidden <audio> element on the first mic click.
  const PRIME_SILENT_MP3 =
    "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU5LjI3LjEwMAAAAAAAAAAAAAAA//tAwAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAJAAAEXgBBQUFBQUFBQUFBQVlZWVlZWVlZWVlZcXFxcXFxcXFxcXGIiIiIiIiIiIiIiKCgoKCgoKCgoKCguLi4uLi4uLi4uLjQ0NDQ0NDQ0NDQ0Ojo6Ojo6Ojo6Ojo//////////////8AAAAATGF2YzU5LjM3AAAAAAAAAAAAAAAAJAPMAAAAAAAABF6gwS6ZAAAAAAD/+xDEAAPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVf/7EMQpg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVV//sQxFMDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVX/+xDEfIPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMSmA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxM+DwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDE1gPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMTWA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxNYDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=";

  const primeLocalTtsAudio = useCallback(() => {
    // iOS/Safari autoplay rules: unlocking media MUST happen synchronously in a user gesture
    // (e.g., mic button tap). We "prime" a hidden media element with a tiny silent MP3.
    if (localTtsUnlockedRef.current) return;

    let unlocked = false;
    const markUnlocked = () => {
      if (unlocked) return;
      unlocked = true;
      localTtsUnlockedRef.current = true;
      console.log("Local TTS unlocked");
    };

    const prime = (m: HTMLMediaElement | null, label: string) => {
      if (!m) return;
      try {
        // Load a tiny silent MP3 and attempt play/pause.
        m.src = PRIME_SILENT_MP3;
        m.muted = false;
        m.volume = 1;

        // playsinline helps on iOS; safe to set on audio too.
        try {
          (m as any).playsInline = true;
          (m as any).setAttribute?.("playsinline", "");
        } catch {}

        const p = m.play();
        Promise.resolve(p)
          .then(() => {
            markUnlocked();
            try {
              m.pause();
            } catch {}
            try {
              (m as any).currentTime = 0;
            } catch {}
          })
          .catch((e) => {
            console.warn("Failed to prime local TTS", {
            mediaTag: m.tagName,
              err: String(e),
              name: (e as any)?.name,
              message: (e as any)?.message,
            });
          });
      } catch (e) {
        console.warn("Failed to prime local TTS", {
            mediaTag: m.tagName,
          err: String(e),
          name: (e as any)?.name,
          message: (e as any)?.message,
        });
      }
    };

    // Prime BOTH. iOS prefers the hidden VIDEO element (routes like Live Avatar),
    // but we also prime the AUDIO element as fallback.
    prime(localTtsVideoRef.current, "video");
    prime(localTtsAudioRef.current, "audio");

    // If neither succeeds, localTtsUnlockedRef remains false and we'll retry on the next user gesture.
  }, []);

const playLocalTtsUrl = useCallback(
    async (url: string, hooks?: SpeakAssistantHooks) => {
      const audioEl = localTtsAudioRef.current;
      const videoEl = localTtsVideoRef.current;

      // iOS Safari can route <audio> to the receiver (or mute it) after mic/STT.
      // Using a hidden <video> element often matches Live Avatar output routing (speaker).
      const preferVideo = isIOS && !!videoEl;

      const stopWebSpeechIfNeeded = async () => {
        if (!(isIOS && sttRecRef.current)) return;

        const rec = sttRecRef.current;
        try {
          await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              resolve();
            };

            const prevOnEnd = (rec as any).onend;
            (rec as any).onend = (...args: any[]) => {
              try {
                prevOnEnd?.(...args);
              } catch {}
              finish();
            };

            try {
              rec.stop();
            } catch {
              finish();
            }

            // Safety if onend never arrives
            setTimeout(finish, 220);
          });
        } catch {
          // ignore
        }
      };

      const playOn = async (m: HTMLMediaElement, useVideo: boolean): Promise<boolean> => {
        await stopWebSpeechIfNeeded();

        // Give Safari a beat to swap audio-session away from capture.
        if (isIOS) await new Promise((r) => setTimeout(r, 180));

        // Cache-bust on iOS (some devices can aggressively cache the same URL path).
        const finalUrl = isIOS ? `${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}` : url;

        // Prepare element
        try {
          m.pause();
          m.currentTime = 0;
        } catch {}

        try {
          (m as any).crossOrigin = "anonymous";
        } catch {}

        if (useVideo) {
          try {
            const v = m as HTMLVideoElement;
            v.playsInline = true;
            v.setAttribute("playsinline", "true");
            v.setAttribute("webkit-playsinline", "true");
          } catch {}
        }

        try {
          m.muted = false;
          m.volume = 1;
        } catch {}

        try {
          (m as any).preload = "auto";
        } catch {}

        try {
          m.src = finalUrl;
          try {
            (m as any).load?.();
          } catch {}
        } catch {}

        try {
          hooks?.onWillSpeak?.();
        } catch {}

        try {
          await m.play();
          localTtsUnlockedRef.current = true;
          // iOS Safari can sometimes resolve play() but keep media effectively paused/silent.
          // Confirm playback actually started before we proceed.
          const started = await new Promise<boolean>((resolve) => {
            let settled = false;

            function finish(ok: boolean) {
              if (settled) return;
              settled = true;
              try {
                m.removeEventListener("playing", onPlaying);
                m.removeEventListener("timeupdate", onTimeUpdate);
                m.removeEventListener("error", onErr);
              } catch {}
              resolve(ok);
            }

            function onPlaying() {
              finish(true);
            }
            function onTimeUpdate() {
              if (m.currentTime > 0) finish(true);
            }
            function onErr() {
              finish(false);
            }

            try {
              m.addEventListener("playing", onPlaying, { once: true });
              m.addEventListener("timeupdate", onTimeUpdate);
              m.addEventListener("error", onErr, { once: true });
            } catch {
              // If we can't attach events, just accept.
              finish(true);
              return;
            }

            setTimeout(() => {
              finish(m.currentTime > 0 || !m.paused);
            }, 600);
          });

          if (!started) {
            try {
              m.pause();
              m.currentTime = 0;
            } catch {}
            return false;
          }
        } catch (e) {
          console.warn("Local TTS playback failed:", {
            mediaTag: m.tagName,
            err: String(e),
            name: (e as any)?.name,
            message: (e as any)?.message,
            readyState: m.readyState,
            networkState: m.networkState,
            src: (m as any).currentSrc || m.src,
            mediaError: m.error ? { code: m.error.code } : null,
          });
          localTtsUnlockedRef.current = false;
          return false;
        }

        await new Promise<void>((resolve) => {
          let done = false;

          const cleanup = () => {
            if (done) return;
            done = true;

            m.onended = null;
            m.onerror = null;
            m.onabort = null;

            try {
              m.pause();
              m.currentTime = 0;
            } catch {}

            // iOS Safari sometimes gets "stuck" if we leave the src attached.
            if (isIOS) {
              try {
                m.removeAttribute("src");
                (m as any).load?.();
              } catch {}
            }

            resolve();
          };

          m.onended = cleanup;
          m.onerror = cleanup;
          m.onabort = cleanup;

          // Hard timeout if Safari never fires ended
          setTimeout(() => cleanup(), 12000);
        });

        return true;
      };

      // Try iOS-preferred video first, then fallback to audio.
      if (preferVideo && videoEl) {
        const ok = await playOn(videoEl, true);
        if (ok) return;

        if (audioEl) {
          const ok2 = await playOn(audioEl, false);
          if (ok2) return;
        }

        try {
          hooks?.onDidNotSpeak?.();
        } catch {}
        return;
      }

      if (audioEl) {
        const ok = await playOn(audioEl, false);
        if (ok) return;
      }

      try {
        hooks?.onDidNotSpeak?.();
      } catch {}
    },
    [isIOS],
  );

  const speakLocalTtsReply = useCallback(
    async (replyText: string, voiceId: string, hooks?: SpeakAssistantHooks) => {
      const clean = (replyText || "").trim();
      if (!clean) {
        hooks?.onDidNotSpeak?.();
        return;
      }

      const audioUrl = await getTtsAudioUrl(clean, voiceId);
      if (!audioUrl) {
        hooks?.onDidNotSpeak?.();
        return;
      }

      await playLocalTtsUrl(audioUrl, hooks);
    },
    [getTtsAudioUrl, playLocalTtsUrl]
  );


const speakAssistantReply = useCallback(
    async (replyText: string, hooks?: SpeakAssistantHooks) => {
    // NOTE: We intentionally keep STT paused while the avatar is speaking.
    // The D-ID SDK's speak() promise can resolve before audio playback finishes,
    // so we add a best-effort duration wait to prevent STT feedback (avatar "talking to itself").
    const clean = (replyText || "").trim();

    const callDidNotSpeak = () => {
      try {
        hooks?.onDidNotSpeak?.();
      } catch {
        // ignore
      }
    };

    let willSpeakCalled = false;
    const callWillSpeakOnce = () => {
      if (willSpeakCalled) return;
      willSpeakCalled = true;
      try {
        hooks?.onWillSpeak?.();
      } catch {
        // ignore
      }
    };

    if (!clean) {
      callDidNotSpeak();
      return;
    }
    if (clean.startsWith("Error:")) {
      callDidNotSpeak();
      return;
    }

    if (avatarStatus !== "connected") {
      callDidNotSpeak();
      return;
    }
    if (!phase1AvatarMedia) {
      callDidNotSpeak();
      return;
    }

    const audioUrl = await getTtsAudioUrl(clean, phase1AvatarMedia.elevenVoiceId);
    if (!audioUrl) {
      callDidNotSpeak();
      return;
    }

    // Estimate duration (fallback) based on text length.
    const estimateSpeechMs = (text: string) => {
      const words = text.trim().split(/\s+/).filter(Boolean).length;
      // Typical conversational pace ~160-175 WPM. Use a slightly slower rate to be safe.
      const wpm = 160;
      const baseMs = (words / wpm) * 60_000;
      const punctPausesMs = (text.match(/[.!?]/g) || []).length * 250;
      return Math.min(60_000, Math.max(1_200, Math.round(baseMs + punctPausesMs)));
    };

    const fallbackMs = estimateSpeechMs(clean);

    // Best-effort: read actual audio duration from the blob URL (if metadata is accessible).
    const probeAudioDurationMs = (url: string, fallback: number) =>
      new Promise<number>((resolve) => {
        if (typeof Audio === "undefined") return resolve(fallback);
        const a = new Audio();
        a.preload = "metadata";
        // Some CDNs require this for cross-origin metadata access (best-effort).
        try {
          (a as any).crossOrigin = "anonymous";
        } catch {
          // ignore
        }

        let doneCalled = false;
        const done = (ms: number) => {
          if (doneCalled) return;
          doneCalled = true;
          try {
            a.onloadedmetadata = null as any;
            a.onerror = null as any;
          } catch {
            // ignore
          }
          // release resource
          try {
            a.src = "";
          } catch {
            // ignore
          }
          resolve(ms);
        };

        const t = window.setTimeout(() => done(fallback), 2500);

        a.onloadedmetadata = () => {
          window.clearTimeout(t);
          const d = a.duration;
          if (typeof d === "number" && isFinite(d) && d > 0) return done(Math.round(d * 1000));
          return done(fallback);
        };
        a.onerror = () => {
          window.clearTimeout(t);
          return done(fallback);
        };

        a.src = url;
      });

    const durationMsPromise = probeAudioDurationMs(audioUrl, fallbackMs);

    const speakPayload = {
      type: "audio",
      audio_url: audioUrl,
      audioType: "audio/mpeg",
    } as any;

    let spoke = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      const mgr = didAgentMgrRef.current;
      if (!mgr) {
        callDidNotSpeak();
        return;
      }

      try {
        callWillSpeakOnce();
        await mgr.speak(speakPayload);
        spoke = true;
        break;
      } catch (e) {
        if (attempt === 0 && isDidSessionError(e)) {
          console.warn("D-ID session error during speak; reconnecting and retrying...", e);
          await reconnectLiveAvatar();
          continue;
        }
        console.warn("D-ID speak failed:", e);
        setAvatarError(formatDidError(e));
        callDidNotSpeak();
        return;
      }
    }

    if (!spoke) {
      callDidNotSpeak();
      return;
    }

    // Wait for audio playback to finish (plus buffer) before allowing STT to resume.
    const durationMs = await durationMsPromise;
    const waitMs = Math.min(90_000, Math.max(fallbackMs, durationMs) + 900);
    await new Promise((r) => window.setTimeout(r, waitMs));
  },
  [avatarStatus, phase1AvatarMedia, getTtsAudioUrl, reconnectLiveAvatar]
);

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

  const modePills = useMemo(() => ["friend", "romantic", "intimate"] as const, []);
  const messagesBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = messagesBoxRef.current;
    if (!el) return;

    // Keep scrolling inside the message box so the page itself doesn't "jump"
    el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  // Speech-to-text (Web Speech API): "hands-free" mode
  // - User clicks mic once to start/stop
  // - Auto-sends after 2s of silence
  // - Automatically restarts recognition when it stops (browser behavior)
  const sttRecRef = useRef<any>(null);
  const sttSilenceTimerRef = useRef<number | null>(null);
  const sttRestartTimerRef = useRef<number | null>(null);
  const sttRecoverTimerRef = useRef<number | null>(null);
  const sttAudioCaptureFailsRef = useRef<number>(0);
  const sttLastAudioCaptureAtRef = useRef<number>(0);

  const sttFinalRef = useRef<string>("");
  const sttInterimRef = useRef<string>("");
  const sttIgnoreUntilRef = useRef<number>(0); // suppress STT while avatar is speaking (prevents feedback loop)

  const [sttEnabled, setSttEnabled] = useState(false);
  const [sttRunning, setSttRunning] = useState(false);
  const [sttError, setSttError] = useState<string | null>(null);

  // iOS: prefer backend STT (MediaRecorder → /stt/transcribe) for **audio-only** mode.
  // Browser SpeechRecognition can be flaky on iOS (especially after auto-restarts).
  const [backendSttAvailable, setBackendSttAvailable] = useState(true);

  // These state setters exist to trigger renders when backend STT updates refs (mobile stability).
  // We intentionally ignore the state values to avoid UI changes.
  const [, setSttInterim] = useState<string>("");
  const [, setSttFinal] = useState<string>("");

  const sttEnabledRef = useRef<boolean>(false);
  const sttPausedRef = useRef<boolean>(false);
  // Backend STT (iOS-safe): record mic audio via getUserMedia + MediaRecorder and transcribe server-side.
  const backendSttInFlightRef = useRef<boolean>(false);
  const backendSttAbortRef = useRef<AbortController | null>(null);
  const backendSttStreamRef = useRef<MediaStream | null>(null);
  const backendSttRecorderRef = useRef<MediaRecorder | null>(null);
  const backendSttAudioCtxRef = useRef<AudioContext | null>(null);
  const backendSttRafRef = useRef<number | null>(null);
  const backendSttHardStopTimerRef = useRef<number | null>(null);
  const backendSttLastVoiceAtRef = useRef<number>(0);
  const backendSttHasSpokenRef = useRef<boolean>(false);


  const getEmbedHint = useCallback(() => {
    if (typeof window === "undefined") return "";
    const hint =
      " (If this page is embedded, ensure the embed/iframe allows microphone access.)";
    try {
      return window.self !== window.top ? hint : "";
    } catch {
      return hint;
    }
  }, []);


  // Greeting once per browser session per companion
// Fix: if companionName arrives AFTER the initial greeting timer (e.g., slow Wix postMessage),
// we may have already inserted the default "Haven" greeting. If the user hasn't typed yet,
// replace the greeting so it matches the selected companion.
useEffect(() => {
  if (typeof window === "undefined") return;

  const desiredName =
    (companionName || DEFAULT_COMPANION_NAME).trim() || DEFAULT_COMPANION_NAME;

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
      // If no messages yet, insert greeting only if we haven't greeted this companion in this session.
      if (prev.length === 0) {
        return already ? prev : [greetingMsg];
      }

      // If the only existing message is a greeting for a different companion (and no user messages yet),
      // replace it so the name matches the current companion.
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

  function showUpgradeMessage(requestedMode: Mode) {
    const modeLabel = MODE_LABELS[requestedMode];
    const msg =
      `The requested mode (${modeLabel}) isn't available on your current plan. ` +
      `Please upgrade here: ${UPGRADE_URL}`;

    setMessages((prev) => [...prev, { role: "assistant", content: msg }]);
  }

  // Receive plan + companion from Wix postMessage
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

        // Keep session_state aligned with the selected companion so the backend can apply the correct persona.
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

      // If current mode is not allowed, force friend
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

// Ensure backend receives the selected companion so it can apply the correct persona.
// Without this, the backend may fall back to the default companion ("Haven") even when the UI shows another.
const companionForBackend =
  (companionKey || "").trim() ||
  (companionName || DEFAULT_COMPANION_NAME).trim() ||
  DEFAULT_COMPANION_NAME;

const stateToSendWithCompanion: SessionState = {
  ...stateToSend,
  companion: companionForBackend,
  // Backward/forward compatibility with any backend expecting different field names
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
    // e.g. "[mode:romantic]" by itself
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
      // If we switch away from intimate while consent is pending, clear the pending flag
      const nextPending = detectedMode === "intimate" ? sessionState.pending_consent : null;
      nextState = { ...sessionState, mode: detectedMode, pending_consent: nextPending };

      // If user is switching away from intimate, also clear any explicit_blocked overlay state
      if (detectedMode !== "intimate") {
        setChatStatus("safe");
      }

      setSessionState(nextState);
    }

    // Build user message content:
    // If a [mode:*] token was present, we remove it from content (cleaned) to keep chat natural.
    const outgoingText = detectedMode ? cleaned : rawText;

    const userMsg: Msg = { role: "user", content: outgoingText };
    const nextMessages: Msg[] = [...messages, userMsg];

    // If speech-to-text "hands-free" mode is enabled, pause recognition while we send
    // and while the avatar speaks. We'll auto-resume after speaking finishes.
    const resumeSttAfter = sttEnabledRef.current;
    let resumeScheduled = false;
    if (resumeSttAfter) {
      pauseSpeechToText();

      // Defensive: clear any in-progress transcript to avoid accidental duplicate sends.
      sttFinalRef.current = "";
      sttInterimRef.current = "";
    }

    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      const sendState: SessionState = { ...nextState, ...(stateOverride || {}) };
      const data = await callChat(nextMessages, sendState);

      // status from backend (safe/explicit_blocked/explicit_allowed)
      if (data.mode === "safe" || data.mode === "explicit_blocked" || data.mode === "explicit_allowed") {
        setChatStatus(data.mode);
      }

      // Some backends return camelCase "sessionState" instead of snake_case "session_state"
      const serverSessionState: any = (data as any).session_state ?? (data as any).sessionState;

      // Normalize & apply server session state WITHOUT using data.mode as pill mode
      if (serverSessionState) {
        setSessionState((prev) => {
          const merged: SessionState = { ...(prev as any), ...(serverSessionState as any) };

          // If backend says blocked, keep pill as intimate AND set pending
          if (data.mode === "explicit_blocked") {
            merged.mode = "intimate";
            merged.pending_consent = "intimate";
          }

          // If backend says allowed, clear pending (and keep mode whatever backend returned in session state)
          if (data.mode === "explicit_allowed" && merged.pending_consent) {
            merged.pending_consent = null;
          }

          // If the backend sent a mode (in session state OR top-level), normalize it so Romantic always highlights
          const backendMode = normalizeMode((serverSessionState as any)?.mode ?? (data as any)?.mode);
          if (backendMode && data.mode !== "explicit_blocked") {
            merged.mode = backendMode;
          }

          // If we are not in intimate, never keep the intimate pending flag (prevents the Intimate pill from "sticking")
          if (merged.mode !== "intimate" && merged.pending_consent === "intimate") {
            merged.pending_consent = null;
          }

          return merged;
        });
      } else {
        // If blocked but session_state missing, still reflect pending
        if (data.mode === "explicit_blocked") {
          setSessionState((prev) => ({ ...prev, mode: "intimate", pending_consent: "intimate" }));
        }

        // If allowed but session_state missing, clear pending and mark consented
        if (data.mode === "explicit_allowed") {
          setSessionState((prev) => ({ ...prev, pending_consent: null, explicit_consented: true }));
        }

        // Fallback: if backend returned a pill mode at top-level, apply it
        const backendMode = normalizeMode((data as any)?.mode);
        if (backendMode && data.mode !== "explicit_blocked") {
          setSessionState((prev) => ({
            ...prev,
            mode: backendMode,
            pending_consent: backendMode === "intimate" ? prev.pending_consent : null,
          }));
        }
      }

      // Phase 1: Speak the assistant reply (if Live Avatar is connected).
      // When Live Avatar is active, we delay the assistant's text from appearing until
      // we are about to trigger the avatar speech.
      const replyText = String(data.reply || "");
      let assistantCommitted = false;
      const commitAssistantMessage = () => {
        if (assistantCommitted) return;
        assistantCommitted = true;
        setMessages((prev) => [...prev, { role: "assistant", content: replyText }]);
      };

      // Guard against STT feedback: ignore any recognition results until after the avatar finishes speaking.
      // (We also keep STT paused during speak; this is an extra safety net.)
      const estimateSpeechMs = (text: string) => {
        const words = text.trim().split(/\s+/).filter(Boolean).length;
        const wpm = 160;
        const baseMs = (words / wpm) * 60_000;
        const punctPausesMs = (text.match(/[.!?]/g) || []).length * 250;
        return Math.min(60_000, Math.max(1_200, Math.round(baseMs + punctPausesMs)));
      };
      const estimatedSpeechMs = estimateSpeechMs(replyText);

      const hooks: SpeakAssistantHooks = {
        onWillSpeak: () => {
          // We'll treat "speaking" the same whether it's Live Avatar or local audio-only.
          if (!assistantCommitted) {
            commitAssistantMessage();
            assistantCommitted = true;
          }

          // Block STT from capturing the assistant speech.
          if (sttEnabledRef.current) {
            const now = Date.now();
            const ignoreMs = estimatedSpeechMs + 1200;
            sttIgnoreUntilRef.current = Math.max(sttIgnoreUntilRef.current || 0, now + ignoreMs);
          }
        },
        onDidNotSpeak: () => {
          // If we can't speak, still show the assistant message immediately.
          if (!assistantCommitted) {
            commitAssistantMessage();
            assistantCommitted = true;
          }
        },
      };

      const voiceId = getElevenVoiceIdForAvatar(companionName);

      const canLiveAvatarSpeak =
        avatarStatus === "connected" && !!phase1AvatarMedia && !!didAgentMgrRef.current;

      // Audio-only TTS is only played in hands-free STT mode (mic button enabled),
      // when Live Avatar is NOT speaking.
      const shouldUseLocalTts = !canLiveAvatarSpeak && sttEnabledRef.current;

      const speakPromise = (canLiveAvatarSpeak
        ? speakAssistantReply(replyText, hooks)
        : shouldUseLocalTts
          ? speakLocalTtsReply(replyText, voiceId, hooks)
          : (hooks.onDidNotSpeak(), Promise.resolve())
      ).catch(() => {
        // If something goes wrong, just fall back to showing text.
        hooks.onDidNotSpeak();
      });


      // If STT is enabled, resume listening only after the avatar finishes speaking.
      if (resumeSttAfter) {
        resumeScheduled = true;
        speakPromise.finally(() => {
          if (sttEnabledRef.current) resumeSpeechToText();
        });
      }
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err?.message ?? "Unknown error"}` },
      ]);
    } finally {
      setLoading(false);
      if (resumeSttAfter && !resumeScheduled) {
        // No speech was triggered (e.g., request failed). Resume immediately.
        if (sttEnabledRef.current) resumeSpeechToText();
      }
    }
  }

  // Keep a ref to the latest send() callback so STT handlers don't close over stale state.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  function clearSttSilenceTimer() {
    if (sttSilenceTimerRef.current) {
      window.clearTimeout(sttSilenceTimerRef.current);
      sttSilenceTimerRef.current = null;
    }
  }

  function clearSttRestartTimer() {
    if (sttRestartTimerRef.current) {
      window.clearTimeout(sttRestartTimerRef.current);
      sttRestartTimerRef.current = null;
    }
  }

  function clearSttRecoverTimer() {
    if (sttRecoverTimerRef.current) {
      window.clearTimeout(sttRecoverTimerRef.current);
      sttRecoverTimerRef.current = null;
    }
  }

  const resetSpeechRecognition = useCallback(() => {
    const rec = sttRecRef.current as any;
    if (!rec) return;

    try {
      rec.onstart = null;
      rec.onend = null;
      rec.onerror = null;
      rec.onresult = null;
    } catch {
      // ignore
    }

    try {
      rec.abort?.();
    } catch {
      // ignore
    }
    try {
      rec.stop?.();
    } catch {
      // ignore
    }

    sttRecRef.current = null;
    setSttRunning(false);
  }, []);

  const getCurrentSttText = useCallback((): string => {
    return `${(sttFinalRef.current || "").trim()} ${(sttInterimRef.current || "").trim()}`.trim();
  }, []);

    // ------------------------------------------------------------
  // Backend STT (record + server-side transcription).
  // iOS/iPadOS Web Speech STT can be unstable; this path is far more reliable.
  // Requires backend endpoint: POST /stt/transcribe (raw audio Blob; Content-Type audio/webm|audio/mp4) -> { text }
  // ------------------------------------------------------------
  const liveAvatarActive =
    avatarStatus === "connecting" || avatarStatus === "connected" || avatarStatus === "reconnecting";

  // Prefer backend STT for iOS **audio-only** mode (more stable than browser SpeechRecognition).
  // Keep Live Avatar mode on browser STT (it is already stable across devices).
  const useBackendStt = isIOS && backendSttAvailable && !liveAvatarActive && !isEmbedded;

  const cleanupBackendSttResources = useCallback(() => {
    try {
      if (backendSttRecorderRef.current && backendSttRecorderRef.current.state !== "inactive") {
        backendSttRecorderRef.current.stop();
      }
    } catch {}
    backendSttRecorderRef.current = null;

    if (backendSttHardStopTimerRef.current) {
      window.clearTimeout(backendSttHardStopTimerRef.current);
      backendSttHardStopTimerRef.current = null;
    }

    if (backendSttRafRef.current !== null) {
      cancelAnimationFrame(backendSttRafRef.current);
      backendSttRafRef.current = null;
    }

    if (backendSttStreamRef.current) {
      backendSttStreamRef.current.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
      backendSttStreamRef.current = null;
    }

    if (backendSttAudioCtxRef.current) {
      try {
        backendSttAudioCtxRef.current.close();
      } catch {}
      backendSttAudioCtxRef.current = null;
    }

    backendSttHasSpokenRef.current = false;
    backendSttLastVoiceAtRef.current = 0;
  }, []);

  const abortBackendStt = useCallback(() => {
    try {
      backendSttAbortRef.current?.abort();
    } catch {}
    backendSttAbortRef.current = null;

    cleanupBackendSttResources();

    // NOTE: we intentionally do NOT flip backendSttInFlightRef here.
    // startBackendSttOnce() owns that lifecycle and will clear it in its own finally blocks.
    setSttRunning(false);
  }, [cleanupBackendSttResources]);

  const transcribeBackendStt = useCallback(
    async (blob: Blob): Promise<string> => {
      if (!API_BASE) throw new Error("Missing NEXT_PUBLIC_API_BASE_URL");

      // Backend expects raw audio bytes in the request body (NOT multipart/form-data).
      const controller = new AbortController();
      backendSttAbortRef.current = controller;

      const apiBase = API_BASE.replace(/\/+$/, "");
      const contentType = blob.type || (isIOS ? "audio/mp4" : "audio/webm");

      const resp = await fetch(`${apiBase}/stt/transcribe`, {
        method: "POST",
        headers: { "Content-Type": contentType, Accept: "application/json" },
        body: blob,
        signal: controller.signal,
      });

      if (!resp.ok) {
        let detail = "";
        try {
          detail = await resp.text();
        } catch {}
        throw new Error(`STT backend error ${resp.status}: ${detail || resp.statusText}`);
      }

      const data = (await resp.json()) as any;
      return String(data?.text ?? "").trim();
    },
    [API_BASE, isIOS],
  );

  const startBackendSttOnce = useCallback(async (): Promise<void> => {
    if (!useBackendStt) return;
    if (!sttEnabledRef.current || sttPausedRef.current) return;
    if (backendSttInFlightRef.current) return;

    const now0 = performance.now();
    if (now0 < sttIgnoreUntilRef.current) {
      const waitMs = Math.max(0, Math.ceil(sttIgnoreUntilRef.current - now0 + 50));
      setTimeout(() => {
        if (sttEnabledRef.current && !sttPausedRef.current) {
          startBackendSttOnce().catch(() => {});
        }
      }, waitMs);
      return;
    }

    backendSttInFlightRef.current = true;
    backendSttHasSpokenRef.current = false;
    backendSttLastVoiceAtRef.current = performance.now();

    clearSttSilenceTimer();
    setSttError(null);
    setSttRunning(true);
    setSttInterim("");
    setSttFinal("");

    try {
      const getStreamWithRetries = async (): Promise<MediaStream> => {
        const constraints: MediaStreamConstraints = {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        };

        let lastErr: any = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return await navigator.mediaDevices.getUserMedia(constraints);
          } catch (e: any) {
            lastErr = e;
            const name = e?.name || "";
            // Permission/security errors won't succeed on retry.
            if (name === "NotAllowedError" || name === "SecurityError") break;
            await new Promise((r) => setTimeout(r, 250));
          }
        }

        throw lastErr;
      };

      const stream = await getStreamWithRetries();
      backendSttStreamRef.current = stream;

      // Choose best available recording MIME type for this browser.
      let mimeType = "";
      try {
        const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/mpeg"];
        for (const c of candidates) {
          if (typeof MediaRecorder !== "undefined" && (MediaRecorder as any).isTypeSupported?.(c)) {
            mimeType = c;
            break;
          }
        }
      } catch {}

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      } catch {
        throw new Error("This browser cannot record audio for STT. Please use Live Avatar mode on this device.");
      }
      backendSttRecorderRef.current = recorder;

      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };

      const blobPromise = new Promise<Blob>((resolve, reject) => {
        recorder.onstop = () => {
          const type = recorder.mimeType || mimeType || "audio/webm";
          resolve(new Blob(chunks, { type }));
        };
        (recorder as any).onerror = (ev: any) => reject(ev?.error || new Error("Recorder error"));
      });

      // Simple VAD (silence detection) using AnalyserNode
      try {
        const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
        const ctx: AudioContext = new Ctx();
        backendSttAudioCtxRef.current = ctx;
        try {
          await ctx.resume();
        } catch {}

        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        src.connect(analyser);

        const data = new Uint8Array(analyser.fftSize);

        const threshold = 0.02; // RMS threshold
        const minRecordMs = 350;
        const maxRecordMs = 15000;
        const silenceMs = 2000;
        const startedAt = performance.now();

        const tick = () => {
          if (!sttEnabledRef.current || sttPausedRef.current) {
            try {
              if (recorder.state !== "inactive") recorder.stop();
            } catch {}
            return;
          }

          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          const now = performance.now();

          if (rms > threshold) {
            backendSttLastVoiceAtRef.current = now;
            backendSttHasSpokenRef.current = true;
          }

          const elapsed = now - startedAt;
          const silentFor = now - backendSttLastVoiceAtRef.current;

          if (elapsed >= maxRecordMs) {
            try {
              if (recorder.state !== "inactive") recorder.stop();
            } catch {}
            return;
          }

          if (backendSttHasSpokenRef.current && elapsed > minRecordMs && silentFor >= silenceMs) {
            try {
              if (recorder.state !== "inactive") recorder.stop();
            } catch {}
            return;
          }

          backendSttRafRef.current = requestAnimationFrame(tick);
        };

        backendSttRafRef.current = requestAnimationFrame(tick);
      } catch {
        // If VAD setup fails, we still record; hard-stop timer will end it.
      }

      backendSttHardStopTimerRef.current = window.setTimeout(() => {
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {}
      }, 16000);

      try {
        recorder.start(250);
      } catch {
        throw new Error("Failed to start recording.");
      }

      const blob = await blobPromise;
      const hadSpeech = backendSttHasSpokenRef.current;

      // Important: release the mic/audio session BEFORE we attempt any TTS playback.
      cleanupBackendSttResources();
      setSttRunning(false);

      // If user disabled/paused during capture, do nothing further.
      if (!sttEnabledRef.current || sttPausedRef.current) return;

      // If we never detected speech, skip transcription to avoid cost/noise.
      if (!hadSpeech) return;
      if (!blob || blob.size < 2048) return;

      const text = await transcribeBackendStt(blob);
      if (!text) return;

      // Ignore if we're still inside an ignore window (e.g., avatar speech bleed).
      if (performance.now() < sttIgnoreUntilRef.current) return;

      setSttFinal(text);
      sttFinalRef.current = text;

      await send(text);
    } catch (e: any) {
      setSttError(e?.message || "STT failed.");
    } finally {
      cleanupBackendSttResources();
      setSttRunning(false);
      backendSttInFlightRef.current = false;

      // Hands-free loop: if still enabled, start listening again.
      if (sttEnabledRef.current && !sttPausedRef.current) {
        const now = performance.now();
        const ignoreWait = now < sttIgnoreUntilRef.current ? Math.ceil(sttIgnoreUntilRef.current - now + 50) : 0;
        const baseDelay = isIOS ? 100 : 0;

        setTimeout(() => {
          startBackendSttOnce().catch(() => {});
        }, Math.max(ignoreWait, baseDelay));
      }
    }
  }, [
    clearSttSilenceTimer,
    cleanupBackendSttResources,
    isIOS,
    send,
    transcribeBackendStt,
    useBackendStt,
  ]);

  const kickBackendStt = useCallback(() => {
    if (!useBackendStt) return;
    if (!sttEnabledRef.current || sttPausedRef.current) return;
    if (backendSttInFlightRef.current) return;

    // Small delay helps iOS fully exit previous audio state.
    setTimeout(() => {
      startBackendSttOnce().catch(() => {});
    }, isIOS ? 100 : 0);
  }, [isIOS, startBackendSttOnce, useBackendStt]);

const pauseSpeechToText = useCallback(() => {
    sttPausedRef.current = true;
    clearSttSilenceTimer();

    setSttInterim("");
    setSttFinal("");

    // Backend STT: abort any in-flight record/transcribe
    abortBackendStt();

    // Browser STT: stop recognition if it exists
    const rec = sttRecRef.current;
    try {
      rec?.stop?.();
    } catch {
      // ignore
    }

    // iOS Web Speech can get stuck after stop(); force a fresh recognizer next time.
    // (Embedded iOS uses Web Speech; backend STT is disabled when embedded.)
    if (isIOS && !useBackendStt) {
      resetSpeechRecognition();
    }

    setSttRunning(false);
  }, [abortBackendStt, clearSttSilenceTimer, isIOS, useBackendStt, resetSpeechRecognition]);

  const scheduleSttAutoSend = useCallback(() => {
    if (!sttEnabledRef.current) return;

    clearSttSilenceTimer();

    sttSilenceTimerRef.current = window.setTimeout(() => {
      const text = getCurrentSttText();
      if (!text) return;

      // Pause BEFORE we send so the assistant doesn't "talk to itself".
      pauseSpeechToText();

      sttFinalRef.current = "";
      sttInterimRef.current = "";
      setInput("");

      void sendRef.current(text);
    }, 2000);
  }, [getCurrentSttText, pauseSpeechToText]);

  const requestMicPermission = useCallback(async (): Promise<boolean> => {
    // NOTE: Web Speech API does not reliably prompt on iOS if start() is called
    // outside the user's click. We still use getUserMedia to ensure permission exists.
    if (!navigator.mediaDevices?.getUserMedia) return true;
    // iOS Safari (especially when embedded) can reject getUserMedia even when SpeechRecognition still works.
    // If we're not using backend STT, let SpeechRecognition trigger the permission prompt instead.
    if (isIOS && !useBackendStt) return true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return true;
    } catch (e: any) {
      console.warn("Mic permission denied/unavailable:", e);
      setSttError(getEmbedHint());

      const name = e?.name || "";
      // If backend STT can't access the mic (common in some embedded contexts),
      // fall back to browser SpeechRecognition for this session.
      if (name === "NotAllowedError" || name === "SecurityError") {
        setBackendSttAvailable(false);
        try {
          sttRecRef.current?.abort?.();
        } catch {
          // ignore
        }
        sttRecRef.current = null;
      }

      return false;
    }
  }, [getEmbedHint, isIOS, setBackendSttAvailable, useBackendStt]);

  const ensureSpeechRecognition = useCallback((): any | null => {
    if (typeof window === "undefined") return null;

    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) return null;

    if (sttRecRef.current) return sttRecRef.current as any;

    const rec = new SpeechRecognitionCtor();

    // iOS + embedded contexts are more stable with continuous=false and manual restarts.
    try {
      rec.continuous = !isIOS;
    } catch {
      // ignore
    }

    try {
      rec.interimResults = true;
    } catch {
      // ignore
    }

    try {
      rec.lang = "en-US";
    } catch {
      // ignore
    }

    rec.onstart = () => {
      setSttRunning(true);
      setSttError(null);
      // reset audio-capture fail window on successful start
      sttAudioCaptureFailsRef.current = 0;
      sttLastAudioCaptureAtRef.current = 0;
    };

    rec.onend = () => {
      setSttRunning(false);

      if (!sttEnabledRef.current || sttPausedRef.current) return;

      clearSttRestartTimer();

      const now = Date.now();
      const ignoreDelay = Math.max(0, (sttIgnoreUntilRef.current || 0) - now);

      // On iOS we add a larger delay between restarts to avoid transient audio-capture failures.
      const baseDelay = isIOS ? 850 : 250;

      sttRestartTimerRef.current = window.setTimeout(() => {
        if (!sttEnabledRef.current || sttPausedRef.current) return;

        try {
          rec.start();
        } catch {
          // ignore
        }
      }, baseDelay + ignoreDelay);
    };

    rec.onerror = (event: any) => {
      const code = String(event?.error || "");

      if (code === "no-speech" || code === "aborted") {
        return;
      }

      if (code === "not-allowed" || code === "service-not-allowed") {
        sttEnabledRef.current = false;
        sttPausedRef.current = false;
        setSttEnabled(false);
        setSttRunning(false);
        clearSttSilenceTimer();
        clearSttRestartTimer();
        clearSttRecoverTimer();
        clearSttRecoverTimer();
        setSttError("Microphone permission was blocked." + getEmbedHint());
        try {
          rec.stop?.();
        } catch {
          // ignore
        }
        return;
      }

      if (code === "audio-capture") {
        const now = Date.now();
        const withinWindow = now - sttLastAudioCaptureAtRef.current < 10_000;
        sttAudioCaptureFailsRef.current = withinWindow
          ? sttAudioCaptureFailsRef.current + 1
          : 1;
        sttLastAudioCaptureAtRef.current = now;

        setSttError("Speech-to-text error: audio-capture (no microphone found). Retrying…");

        // If it keeps failing, we stop instead of looping forever.
        if (sttAudioCaptureFailsRef.current >= 4) {
          sttEnabledRef.current = false;
          sttPausedRef.current = false;
          setSttEnabled(false);
          setSttRunning(false);
          clearSttSilenceTimer();
          clearSttRestartTimer();
        clearSttRecoverTimer();
          clearSttRecoverTimer();
          setSttError(
            "Speech-to-text could not access the microphone on this device. Please reload the page and try again."
              + getEmbedHint()
          );
          try {
            rec.stop?.();
          } catch {
            // ignore
          }
          return;
        }

        // Recovery path: recreate recognition (helps iOS) and try again after a short delay.
        clearSttRecoverTimer();
        sttRecoverTimerRef.current = window.setTimeout(async () => {
          if (!sttEnabledRef.current || sttPausedRef.current) return;

          resetSpeechRecognition();

          const ok = await requestMicPermission();
          if (!ok) return;

          const r2 = ensureSpeechRecognition();
          if (!r2) return;

          try {
            r2.start();
          } catch {
            // ignore
          }
        }, isIOS ? 1200 : 650);

        return;
      }

      console.warn("STT error:", code, event);
      setSttError(`Speech-to-text error: ${code}`);
    };

    rec.onresult = (event: any) => {
      if (!sttEnabledRef.current || sttPausedRef.current) return;
      if (Date.now() < (sttIgnoreUntilRef.current || 0)) return;

      let finalText = "";
      let interimText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res?.[0]?.transcript ?? "";
        if (res?.isFinal) finalText += txt;
        else interimText += txt;
      }

      if (finalText) sttFinalRef.current = `${sttFinalRef.current} ${finalText}`.trim();
      sttInterimRef.current = interimText.trim();

      const combined = getCurrentSttText();
      setInput(combined);

      scheduleSttAutoSend();
    };

    sttRecRef.current = rec;
    return rec;
  }, [
    isIOS,
    getCurrentSttText,
    scheduleSttAutoSend,
    getEmbedHint,
    requestMicPermission,
    resetSpeechRecognition,
  ]);

  const resumeSpeechToText = useCallback(() => {
    if (!sttEnabledRef.current) return;

    sttPausedRef.current = false;

    // iOS/iPadOS: use backend STT recorder (more stable than Web Speech)
    if (useBackendStt) {
      kickBackendStt();
      return;
    }

    // After assistant TTS on iOS, restarting recognition immediately can trigger
    // intermittent "audio-capture" failures. Delay + reuse the existing restart timer.
    clearSttRestartTimer();
    const delayMs = isIOS ? 850 : 0;

    sttRestartTimerRef.current = window.setTimeout(() => {
      if (!sttEnabledRef.current) return;
      if (sttPausedRef.current) return;

      const ok = ensureSpeechRecognition();
      if (!ok) {
        sttEnabledRef.current = false;
        setSttRunning(false);
        setSttError("Speech-to-text is not supported in this browser.");
        return;
      }

      const rec = sttRecRef.current;
      if (!rec) return;

      try {
        rec.start();
        setSttRunning(true);
      } catch {
        // ignore; will restart on onend if needed
      }
    }, delayMs);
  }, [
    clearSttRestartTimer,
    ensureSpeechRecognition,
    isIOS,
    kickBackendStt,
    useBackendStt,
  ]);

  const stopSpeechToText = useCallback(
    (clearError: boolean = true) => {
      sttEnabledRef.current = false;
      sttPausedRef.current = false;
      setSttEnabled(false);
      clearSttSilenceTimer();

      setSttInterim("");
      setSttFinal("");
      setSttRunning(false);

      // Abort backend STT capture/transcribe if in flight
      abortBackendStt();
      backendSttInFlightRef.current = false;

      // Stop browser SpeechRecognition if it exists
      resetSpeechRecognition();

      if (clearError) setSttError(null);
    },
    [abortBackendStt, clearSttSilenceTimer, resetSpeechRecognition]
  );

  const startSpeechToText = useCallback(async (opts?: { forceBrowser?: boolean }) => {
    const forceBrowser = !!opts?.forceBrowser;
    primeLocalTtsAudio();

    sttEnabledRef.current = true;
    sttPausedRef.current = false;
    setSttEnabled(true);
    setSttError(null);

    const usingBackend = useBackendStt && !forceBrowser;

    // IMPORTANT (iOS Safari / iOS embedded): SpeechRecognition.start() must be invoked directly
    // from the user's gesture. Avoid awaiting anything before starting browser STT.
    if (isIOS && !usingBackend) {
      const ok = ensureSpeechRecognition();
      if (!ok) {
        setSttError("Speech-to-text is not supported in this browser.");
        stopSpeechToText(false);
        return;
      }
      resumeSpeechToText();
      return;
    }

    const permOk = await requestMicPermission();
    if (!permOk) {
      setSttError("Microphone permission denied.");
      stopSpeechToText(false);
      return;
    }

    // iOS/iPadOS: prefer backend STT recorder (more stable than Web Speech)
    // NOTE: When starting Live Avatar, we force browser STT so D-ID voice doesn't rely on backend recorder.
    if (usingBackend) {
      kickBackendStt();
      return;
    }

    const ok = ensureSpeechRecognition();
    if (!ok) {
      setSttError("Speech-to-text is not supported in this browser.");
      stopSpeechToText(false);
      return;
    }

    resumeSpeechToText();
  }, [
    ensureSpeechRecognition,
    kickBackendStt,
    primeLocalTtsAudio,
    requestMicPermission,
    resumeSpeechToText,
    stopSpeechToText,
    useBackendStt,
  ]);

  const toggleSpeechToText = useCallback(async () => {
    // In Live Avatar mode, mic is required. We don't allow toggling it off.
    // If STT isn't running (permission denied or stopped), we try to start it again.
    if (liveAvatarActive) {
      if (!sttEnabledRef.current) {
        await startSpeechToText({ forceBrowser: true });
      }
      return;
    }

    if (sttEnabledRef.current) stopSpeechToText();
    else await startSpeechToText();
  }, [liveAvatarActive, startSpeechToText, stopSpeechToText]);

  const stopHandsFreeSTT = useCallback(() => {
    // Stop listening immediately
    stopSpeechToText();

    // Stop any local audio-only playback
    try {
      const a = localTtsAudioRef.current;
      if (a) {
        a.pause();
        a.currentTime = 0;
      }
    } catch {
      // ignore
    }

    // If Live Avatar is running, stop it too (mic is required in Live Avatar mode)
    if (liveAvatarActive) {
      void stopLiveAvatar();
    }
  }, [liveAvatarActive, stopLiveAvatar, stopSpeechToText]);

  // Cleanup
  useEffect(() => {
    return () => {
      try {
        sttEnabledRef.current = false;
        sttPausedRef.current = false;
        clearSttSilenceTimer();
        clearSttRestartTimer();
        clearSttRecoverTimer();
        const rec = sttRecRef.current;
        if (rec) {
          try {
            rec.onstart = null;
            rec.onend = null;
            rec.onresult = null;
            rec.onerror = null;
          } catch {}
          try {
            rec.abort?.();
          } catch {
            try {
              rec.stop?.();
            } catch {}
          }
        }
      } catch {}
    };
  }, []);
  return (
    <main style={{ maxWidth: 880, margin: "24px auto", padding: "0 16px", fontFamily: "system-ui" }}>
      {/* Hidden audio element for audio-only TTS (mic mode) */}
      <audio ref={localTtsAudioRef} style={{ display: "none" }} />
      {/* Hidden video element used on iOS to play audio-only TTS reliably (matches Live Avatar routing) */}
      <video
        ref={localTtsVideoRef}
        playsInline
        preload="auto"
        style={{ position: "absolute", width: 1, height: 1, left: -9999, top: -9999, opacity: 0 }}
      />
      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <div aria-hidden onClick={secretDebugTap} style={{ width: 56, height: 56, borderRadius: "50%", overflow: "hidden" }}>
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


{phase1AvatarMedia && (
  <section style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
    <button
      onClick={() => {
        if (
          avatarStatus === "connected" ||
          avatarStatus === "connecting" ||
          avatarStatus === "reconnecting"
        ) {
          void stopLiveAvatar();
        } else {
          void (async () => {
            // Live Avatar requires microphone / STT. Start it automatically.
            // If iOS audio-only backend STT is currently running, restart in browser STT for Live Avatar.
            if (sttEnabledRef.current && useBackendStt) {
              stopSpeechToText();
            }

            if (!sttEnabledRef.current) {
              await startSpeechToText({ forceBrowser: true });
            }

            // If mic permission was denied, don't start Live Avatar.
            if (!sttEnabledRef.current) return;

            await startLiveAvatar();
          })();
        }
      }}
      style={{
        padding: "10px 14px",
        borderRadius: 10,
        border: "1px solid #111",
        background: "#fff",
        color: "#111",
        cursor: "pointer",
        fontWeight: 700,
      }}
    >
      {avatarStatus === "connected" ||
      avatarStatus === "connecting" ||
      avatarStatus === "reconnecting"
        ? "Stop Live Avatar"
        : "Start Live Avatar"}
    </button>

    <div style={{ fontSize: 12, color: "#666" }}>
      Live Avatar: <b>{avatarStatus}</b>
      {avatarError ? <span style={{ color: "#b00020" }}> — {avatarError}</span> : null}
    </div>
  </section>
)}


      {/* Conversation area (Avatar + Chat) */}
      <section
        style={{
          display: "flex",
          gap: 12,
          alignItems: "stretch",
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        {showAvatarFrame ? (
          <div style={{ flex: "1 1 0", minWidth: 260, height: conversationHeight }}>
            <div
              style={{
                border: "1px solid #e5e5e5",
                borderRadius: 12,
                overflow: "hidden",
                background: "#000",
                height: "100%",
                position: "relative",
              }}
            >
              <video
                ref={avatarVideoRef}
                style={{ width: "100%", height: "100%", objectFit: "contain" }}
                playsInline
                autoPlay
                muted={false}
              />
              {avatarStatus !== "connected" ? (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontSize: 14,
                    background: "rgba(0,0,0,0.25)",
                    padding: 12,
                    textAlign: "center",
                  }}
                >
                  {avatarStatus === "connecting"
                    ? "Connecting…"
                    : avatarStatus === "reconnecting"
                    ? "Reconnecting…"
                    : avatarStatus === "error"
                    ? "Avatar error"
                    : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <div
          style={{
            flex: showAvatarFrame ? "2 1 0" : "1 1 0",
            minWidth: 280,
            height: conversationHeight,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            ref={messagesBoxRef}
            style={{
              flex: "1 1 auto",
              border: "1px solid #e5e5e5",
              borderRadius: 12,
              padding: 12,
              overflowY: "auto",
              background: "#fff",
            }}
          >
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  marginBottom: 10,
                  whiteSpace: "pre-wrap",
                  color: m.role === "assistant" ? "#111" : "#333",
                }}
              >
                <b>{m.role === "assistant" ? companionName : "You"}:</b> {m.content}
              </div>
            ))}
            {loading ? <div style={{ color: "#666" }}>Thinking…</div> : null}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              onClick={toggleSpeechToText}
              disabled={(!sttEnabled && loading) || (liveAvatarActive && sttEnabled)}
              title={
                liveAvatarActive
                  ? sttEnabled
                    ? "Mic is required in Live Avatar (use Stop to end)"
                    : "Enable microphone (required for Live Avatar)"
                  : sttEnabled
                    ? "Stop speech-to-text"
                    : "Start speech-to-text"
              }
              style={{
                width: 44,
                minWidth: 44,
                borderRadius: 10,
                border: "1px solid #111",
                background: sttEnabled ? "#b00020" : "#fff",
                color: sttEnabled ? "#fff" : "#111",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              🎤
            </button>

            {sttEnabled ? (
              <button
                type="button"
                onClick={stopHandsFreeSTT}
                title="Stop listening"
                style={{
                  width: 44,
                  minWidth: 44,
                  borderRadius: 10,
                  border: "1px solid #111",
                  background: "#fff",
                  color: "#111",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                ■
              </button>
            ) : null}

            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={sttEnabled ? "Listening…" : "Type a message…"}
              style={{
                flex: 1,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid #ddd",
              }}
            />

            <button
              onClick={() => send()}
              disabled={loading}
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
          </div>

          {sttError ? (
            <div style={{ marginTop: 6, fontSize: 12, color: "#b00020" }}>{sttError}</div>
          ) : null}
        </div>
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
                  // Ensure backend receives pending_consent + intimate mode
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

      {/* Debug overlay (mobile-friendly) */}
      {debugOpen && (
        <div
          style={{
            position: "fixed",
            left: 10,
            right: 10,
            top: 10,
            zIndex: 999999,
            background: "rgba(0,0,0,0.88)",
            color: "#fff",
            borderRadius: 12,
            padding: 10,
            boxShadow: "0 10px 24px rgba(0,0,0,0.35)",
            maxHeight: "35vh",
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>Debug Logs ({debugLogs.length})</div>
            <button
              onClick={() => {
                try {
                  const text = debugLogs.join("\n");
                  if (navigator.clipboard?.writeText) {
                    navigator.clipboard.writeText(text);
                  } else {
                    // Fallback for older browsers
                    // eslint-disable-next-line no-alert
                    alert(text);
                  }
                } catch {}
              }}
              style={{
                marginLeft: "auto",
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.25)",
                background: "rgba(255,255,255,0.10)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Copy
            </button>
            <button
              onClick={() => setDebugLogs([])}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.25)",
                background: "rgba(255,255,255,0.10)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Clear
            </button>
            <button
              onClick={() => setDebugOpen(false)}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.25)",
                background: "rgba(255,255,255,0.10)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Close
            </button>
            <button
              onClick={() => {
                setDebugOpen(false);
                setDebugEnabled(false);
                setDebugLogs([]);
              }}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.25)",
                background: "rgba(255,80,80,0.25)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Disable
            </button>
          </div>

          <div
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
              fontSize: 11,
              lineHeight: 1.35,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflowY: "auto",
              maxHeight: "26vh",
              borderRadius: 10,
              padding: 8,
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.12)",
            }}
          >
            {debugLogs.length === 0 ? (
              <div style={{ opacity: 0.8 }}>No logs yet. Tap around, then press Copy.</div>
            ) : (
              debugLogs.map((l, i) => <div key={i}>{l}</div>)
            )}
          </div>

          <div style={{ marginTop: 8, fontSize: 11, opacity: 0.85 }}>
            Tip: Tap the avatar image 5 times to toggle this overlay.
          </div>
        </div>
      )}

</main>
  );
}