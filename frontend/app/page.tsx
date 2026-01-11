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

  // Optional optimization: backend may return a ready-to-play ElevenLabs->Blob URL
  // so the frontend can skip a second /tts/audio-url round trip.
  audio_url?: string;
  audioUrl?: string;
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

const ELEVEN_VOICE_ID_BY_COMPANION: Record<string, string> = {
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
  const sessionIdRef = useRef<string | null>(null);

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

  const [avatarStatus, setAvatarStatus] = useState<
    "idle" | "connecting" | "connected" | "reconnecting" | "error"
  >(
  "idle"
);
const [avatarError, setAvatarError] = useState<string | null>(null);

// Local (non-live-avatar) ElevenLabs audio playback
const localTtsAudioRef = useRef<HTMLAudioElement | null>(null);
const localTtsCleanupRef = useRef<(() => void) | null>(null);

const phase1AvatarMedia = useMemo(() => getPhase1AvatarMedia(companionName), [companionName]);

  // UI layout
  const conversationHeight = 520;
  const showAvatarFrame = Boolean(phase1AvatarMedia) && avatarStatus !== "idle";


const stopLiveAvatar = useCallback(async () => {
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
}, []);

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
}, [phase1AvatarMedia, avatarStatus, reconnectLiveAvatar]);

useEffect(() => {
  // Stop when switching companions
  void stopLiveAvatar();
}, [companionKey]); // eslint-disable-line react-hooks/exhaustive-deps

const getTtsAudioUrl = useCallback(async (text: string, voiceId: string, signal?: AbortSignal): Promise<string | null> => {
  try {
    const res = await fetch(`${API_BASE}/tts/audio-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
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

  // Local TTS playback (used when Live Avatar is NOT connected, but STT is enabled)
  const stopLocalTtsAudio = useCallback(() => {
    try {
      localTtsCleanupRef.current?.();
    } catch {
      // ignore
    }
    localTtsCleanupRef.current = null;

    try {
      const a = localTtsAudioRef.current;
      if (a) {
        a.pause();
        a.src = "";
        // Best-effort release
        try {
          (a as any).srcObject = null;
        } catch {
          // ignore
        }
        try {
          (a as any).load?.();
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    localTtsAudioRef.current = null;
  }, []);

  const speakLocalTtsAudio = useCallback(
    async (audioUrl: string | null, hooks?: SpeakAssistantHooks): Promise<void> => {
      const url = (audioUrl || "").trim();
      if (!url) {
        try {
          hooks?.onDidNotSpeak?.();
        } catch {
          // ignore
        }
        return;
      }

      // Stop any previous playback
      stopLocalTtsAudio();

      await new Promise<void>((resolve) => {
        if (typeof Audio === "undefined") {
          try {
            hooks?.onDidNotSpeak?.();
          } catch {
            // ignore
          }
          return resolve();
        }

        const audio = new Audio(url);
        audio.preload = "auto";
        try {
          (audio as any).crossOrigin = "anonymous";
        } catch {
          // ignore
        }

        localTtsAudioRef.current = audio;

        let doneCalled = false;
        let myCleanup: (() => void) | null = null;

        const done = () => {
          if (doneCalled) return;
          doneCalled = true;

          try {
            audio.removeEventListener("ended", done);
            audio.removeEventListener("error", done);
          } catch {
            // ignore
          }

          if (localTtsCleanupRef.current === myCleanup) {
            localTtsCleanupRef.current = null;
          }
          if (localTtsAudioRef.current === audio) {
            localTtsAudioRef.current = null;
          }

          resolve();
        };

        myCleanup = () => {
          try {
            audio.pause();
          } catch {
            // ignore
          }
          done();
        };

        // Allow stopConversation() to interrupt the current local playback and release the promise.
        localTtsCleanupRef.current = myCleanup;

        audio.addEventListener("ended", done);
        audio.addEventListener("error", done);

        // Start playback; only then signal onWillSpeak so the UI can delay the text until audio begins.
        audio
          .play()
          .then(() => {
            try {
              hooks?.onWillSpeak?.();
            } catch {
              // ignore
            }
          })
          .catch((e) => {
            console.warn("Local TTS play() failed:", e);
            try {
              hooks?.onDidNotSpeak?.();
            } catch {
              // ignore
            }
            myCleanup?.();
          });
      });
    },
    [stopLocalTtsAudio]
  );

const speakAssistantReply = useCallback(
    async (replyText: string, hooks?: SpeakAssistantHooks, audioUrlOverride?: string | null) => {
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

    const overrideUrl =
      typeof audioUrlOverride === "string" ? audioUrlOverride.trim() : "";
    const audioUrl = overrideUrl
      ? overrideUrl
      : await getTtsAudioUrl(clean, phase1AvatarMedia.elevenVoiceId);

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
  const sttSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sttRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sttFinalRef = useRef<string>("");
  const sttInterimRef = useRef<string>("");
  const sttIgnoreUntilRef = useRef<number>(0); // suppress STT while avatar is speaking (prevents feedback loop)

  // Stop/cancel coordination (Stop button can abort in-flight /chat and interrupt avatar speech)
  const stopSeqRef = useRef<number>(0);
  const chatAbortRef = useRef<AbortController | null>(null);

  const [sttEnabled, setSttEnabled] = useState(false);
  const [sttRunning, setSttRunning] = useState(false);
  const [sttError, setSttError] = useState<string | null>(null);

  const sttEnabledRef = useRef<boolean>(false);
  const sttPausedRef = useRef<boolean>(false);

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

  async function callChat(nextMessages: Msg[], stateToSend: SessionState, signal?: AbortSignal): Promise<ChatApiResponse> {
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

    // Backend-side optimization:
    // Request audio_url from the backend whenever:
    // - Live Avatar is connected (so we can lip-sync), OR
    // - Hands-free STT is enabled (so we can play voice-only TTS even without Live Avatar)
    const voice_id =
      avatarStatus === "connected" || sttEnabledRef.current
        ? getElevenVoiceId(companionName) || undefined
        : undefined;

    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        session_id,
        wants_explicit,
        voice_id,
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

    const myStopSeq = stopSeqRef.current;
    let controller: AbortController | null = null;

    try {
      const sendState: SessionState = { ...nextState, ...(stateOverride || {}) };
      controller = new AbortController();
      chatAbortRef.current = controller;

      const data = await callChat(nextMessages, sendState, controller.signal);

      // If Stop was clicked while request was in flight, ignore this response.
      if (myStopSeq !== stopSeqRef.current) {
        return;
      }

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

      // Backend optimization: if /chat already returned a ready-to-play TTS Blob URL, reuse it.
      const audioUrlFromChat: string | null =
        ((data as any).audio_url ?? (data as any).audioUrl ?? null) as any;
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

            const voiceIdForTts = getElevenVoiceId(companionName);
            const wantsVoiceOnly = resumeSttAfter && avatarStatus !== "connected";

            const speakHooks: SpeakAssistantHooks = {
              onWillSpeak: () => {
                // STT ducking window (only when we are actually about to speak)
                sttIgnoreUntilRef.current = Math.max(
                  sttIgnoreUntilRef.current,
                  Date.now() + estimatedSpeechMs + 1200
                );

                // Commit assistant text only once and only when we are about to speak (so UI syncs)
                commitAssistantMessage();
              },
              onDidNotSpeak: () => {
                commitAssistantMessage();
              },
            };

            let speakPromise: Promise<void>;

            if (avatarStatus === "connected") {
              speakPromise = Promise.resolve(
                speakAssistantReply(replyText, speakHooks, audioUrlFromChat)
              ).catch(() => {
                // Safety: ensure the message appears even if speech throws before hooks are called.
                commitAssistantMessage();
              });
            } else if (wantsVoiceOnly && voiceIdForTts) {
              // Voice-only TTS (no Live Avatar). Prefer /chat-provided audio_url; fallback to /tts/audio-url.
              let audioUrlForLocal: string | null = audioUrlFromChat;
              if (!audioUrlForLocal) {
                audioUrlForLocal = await getTtsAudioUrl(replyText, voiceIdForTts, controller?.signal);
              }

              speakPromise = Promise.resolve(
                speakLocalTtsAudio(audioUrlForLocal, speakHooks)
              ).catch(() => {
                commitAssistantMessage();
              });
            } else {
              // No speech; show the assistant message immediately.
              commitAssistantMessage();
              speakPromise = Promise.resolve();
            }

// If STT is enabled, resume listening only after the avatar finishes speaking.
      if (resumeSttAfter) {
        resumeScheduled = true;
        speakPromise.finally(() => {
          if (sttEnabledRef.current) resumeSpeechToText();
        });
      }
    } catch (err: any) {
      // If Stop was clicked (or the request was aborted), swallow the error to avoid a confusing "Error: aborted" bubble.
      const aborted =
        controller?.signal?.aborted ||
        err?.name === "AbortError" ||
        String(err?.message || "").toLowerCase().includes("aborted");

      if (aborted || myStopSeq !== stopSeqRef.current) {
        // no-op (intentional)
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${err?.message ?? "Unknown error"}` },
        ]);
      }
    } finally {
      // Clear the active abort controller (if it is still ours)
      if (chatAbortRef.current === controller) chatAbortRef.current = null;

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
      try {
        clearTimeout(sttSilenceTimerRef.current);
      } catch {}
      sttSilenceTimerRef.current = null;
    }
  }

  function clearSttRestartTimer() {
    if (sttRestartTimerRef.current) {
      try {
        clearTimeout(sttRestartTimerRef.current);
      } catch {}
      sttRestartTimerRef.current = null;
    }
  }

  const getCurrentSttText = useCallback(() => {
    const finalText = sttFinalRef.current.trim();
    const interimText = sttInterimRef.current.trim();
    return `${finalText} ${interimText}`.trim();
  }, []);

  const pauseSpeechToText = useCallback(() => {
    if (!sttEnabledRef.current) return;
    sttPausedRef.current = true;
    clearSttSilenceTimer();
    clearSttRestartTimer();
    try {
      const rec = sttRecRef.current;
      if (rec?.stop) rec.stop();
    } catch {}
  }, []);

  const resumeSpeechToText = useCallback(() => {
    if (!sttEnabledRef.current) return;
    sttPausedRef.current = false;
    clearSttRestartTimer();

    const delayMs = Math.max(0, sttIgnoreUntilRef.current - Date.now());
    if (delayMs > 0) {
      // Delay restart until after our ignore window (prevents picking up the avatar's audio tail).
      sttRestartTimerRef.current = setTimeout(() => {
        if (!sttEnabledRef.current) return;
        if (sttPausedRef.current) return;
        try {
          const rec = sttRecRef.current;
          if (!rec?.start) return;
          rec.start();
        } catch {
          // Ignore InvalidStateError if already started.
        }
      }, delayMs);
      return;
    }

    try {
      const rec = sttRecRef.current;
      if (!rec?.start) return;
      rec.start();
    } catch {
      // Ignore InvalidStateError if already started.
    }
  }, []);

  const scheduleSttAutoSend = useCallback(() => {
    if (!sttEnabledRef.current) return;

    clearSttSilenceTimer();
    sttSilenceTimerRef.current = setTimeout(() => {
      const text = getCurrentSttText();
      if (!text) return;

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

      // Stop listening while we send + while the avatar speaks, but keep STT enabled.
      pauseSpeechToText();

      // Clear current transcript so the next turn starts clean.
      sttFinalRef.current = "";
      sttInterimRef.current = "";

      void sendRef.current(text);
    }, 2000);
  }, [getCurrentSttText, pauseSpeechToText]);

  const requestMicPermission = useCallback(async () => {
    // IMPORTANT:
    // - Must be triggered by a user gesture (e.g., mic button click), or browsers may block it.
    // - If embedded, the embedding iframe must include: allow="microphone"
    if (typeof window === "undefined" || !navigator?.mediaDevices?.getUserMedia) return false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Immediately stop tracks. We only need to trigger the permission prompt / verify access.
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {}
      }
      return true;
    } catch (e: any) {
      const msg = String(e?.name || e?.message || "");
      if (msg.toLowerCase().includes("notallowed") || msg.toLowerCase().includes("permission")) {
        setSttError(getEmbedHint());
      } else {
        setSttError(`Speech-to-text error: ${msg || "microphone not available"}`);
      }
      return false;
    }
  }, [getEmbedHint]);

  const ensureSpeechRecognition = useCallback(() => {
    if (typeof window === "undefined") return null;

    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) return null;

    if (sttRecRef.current) return sttRecRef.current;

    const rec = new SpeechRecognitionCtor();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;

    rec.onstart = () => {
      setSttRunning(true);
    };

    rec.onend = () => {
      setSttRunning(false);

      // Browsers often end recognition automatically (silence, time limits, etc).
      // If STT is enabled and not intentionally paused, restart.
      if (sttEnabledRef.current && !sttPausedRef.current) {
        clearSttRestartTimer();
        sttRestartTimerRef.current = setTimeout(() => {
          try {
            rec.start();
          } catch {}
        }, 250);
      }
    };

    rec.onerror = (event: any) => {
      const code = String(event?.error || "");
      if (code === "not-allowed" || code === "service-not-allowed") {
        // Hard block — stop "hands-free" mode until user explicitly starts again.
        sttEnabledRef.current = false;
        sttPausedRef.current = false;
        setSttEnabled(false);
        setSttRunning(false);
        clearSttSilenceTimer();
        clearSttRestartTimer();
        setSttError(getEmbedHint());
        return;
      }

      if (code === "audio-capture") {
        setSttError("Speech-to-text error: audio-capture (no microphone found).");
        return;
      }

      // Other errors are often transient (no-speech, aborted, network). Let onend handle restart.
    };

    rec.onresult = (event: any) => {
      try {
        const results = event?.results;
        if (!results) return;
        if (!sttEnabledRef.current) return;
        if (sttPausedRef.current) return;
        if (Date.now() < sttIgnoreUntilRef.current) return;

        let finalText = "";
        let interimText = "";

        for (let i = 0; i < results.length; i++) {
          const res = results[i];
          const t = String(res?.[0]?.transcript || "");
          if (res?.isFinal) finalText += t;
          else interimText += t;
        }

        sttFinalRef.current = finalText.trim();
        sttInterimRef.current = interimText.trim();

        const combined = getCurrentSttText();
        if (combined) setInput(combined);

        scheduleSttAutoSend();
      } catch {}
    };

    sttRecRef.current = rec;
    return rec;
  }, [getCurrentSttText, scheduleSttAutoSend, getEmbedHint]);

  const startSpeechToText = useCallback(async () => {
    setSttError(null);

    // 1) Ask for mic permission (or validate it)
    const ok = await requestMicPermission();
    if (!ok) return;

    // 2) Ensure SpeechRecognition exists
    const rec = ensureSpeechRecognition();
    if (!rec) {
      setSttError("Speech-to-text is not supported in this browser.");
      return;
    }

    // 3) Enable hands-free mode and start listening
    sttEnabledRef.current = true;
    sttPausedRef.current = false;
    setSttEnabled(true);

    try {
      rec.start();
    } catch {
      // ignore InvalidStateError if already started
    }
  }, [ensureSpeechRecognition, requestMicPermission]);

  const stopSpeechToText = useCallback(() => {
    sttEnabledRef.current = false;
    sttPausedRef.current = false;
    setSttEnabled(false);
    setSttRunning(false);
    clearSttSilenceTimer();
    clearSttRestartTimer();

    sttFinalRef.current = "";
    sttInterimRef.current = "";

    try {
      const rec = sttRecRef.current;
      if (rec?.stop) rec.stop();
    } catch {}
  }, []);

  const toggleSpeechToText = useCallback(async () => {
    if (sttEnabledRef.current) {
      stopSpeechToText();
      return;
    }
    await startSpeechToText();
  }, [startSpeechToText, stopSpeechToText]);

  // Stop conversation: abort in-flight /chat, stop hands-free STT, and interrupt the Live Avatar if it's speaking.
  const stopConversation = useCallback(async () => {
    // Bump stop sequence so in-flight async work can self-cancel
    stopSeqRef.current += 1;

    // Abort any in-flight chat request
    try {
      chatAbortRef.current?.abort();
    } catch {
      // ignore
    }
    chatAbortRef.current = null;

    // Stop hands-free STT immediately
    stopSpeechToText();

    // Stop any local (non-live-avatar) audio playback
    stopLocalTtsAudio();

    // Clear any in-progress transcript/input to avoid accidental re-sends
    try {
      sttFinalRef.current = "";
      sttInterimRef.current = "";
    } catch {
      // ignore
    }
    setInput("");

    // If Live Avatar is connected, attempt to interrupt speech (Premium+ Fluent).
    // If interrupt isn't supported, disconnect as a safe fallback to stop audio/video.
    try {
      const mgr: any = didAgentMgrRef.current;
      if (mgr) {
        if (typeof mgr.interrupt === "function") {
          await mgr.interrupt({ type: "click" });
        } else if (typeof mgr.disconnect === "function") {
          await mgr.disconnect();
          didAgentMgrRef.current = null;
          setAvatarStatus("idle");
        }
      }
    } catch (e) {
      console.warn("Stop conversation: unable to interrupt/disconnect D-ID agent:", e);
    }
  }, [stopSpeechToText, stopLocalTtsAudio]);

  // Dedicated stop button (stops conversation, not just mic)
  const stopHandsFreeSTT = useCallback(() => {
    void stopConversation();
  }, [stopConversation]);

  // Cleanup
  useEffect(() => {
    return () => {
      try {
        sttEnabledRef.current = false;
        sttPausedRef.current = false;
        clearSttSilenceTimer();
        clearSttRestartTimer();
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
          void startLiveAvatar();
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
              disabled={!sttEnabled && loading}
              title={sttEnabled ? "Stop speech-to-text" : "Start speech-to-text"}
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
                title="Stop conversation"
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
</main>
  );
}