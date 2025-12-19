"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import havenHeart from "../public/ai-haven-heart.png";

/**
 * NOTE:
 * - This app is hosted on your Azure VM and embedded in Wix via iframe.
 * - Default Haven avatar is bundled (havenHeart.src) to avoid root public-path / routing issues.
 * - Greeting is once per browser session per companion (sessionStorage).
 */

type Role = "assistant" | "user";

type ChatMessage = {
  role: Role;
  content: string;
};

type CompanionMeta = {
  first: string;
  gender: string;
  ethnicity: string;
  generation: string;
  key: string;
};

const DEFAULT_COMPANION_NAME = "Haven";
const DEFAULT_AVATAR = havenHeart.src; // bundled fallback avatar (avoids public-path issues)
const HEADSHOT_DIR = "/companion/headshot"; // where headshots live (served by your VM)
const GREET_ONCE_KEY = "AIHAVEN_GREETED";

function stripExt(s: string) {
  return (s || "").replace(/\.(jpg|jpeg|png|webp)$/i, "").trim();
}

/**
 * IMPORTANT: We keep spaces for display, but for filename lookup we normalize
 * to the deployment’s convention (option A): spaces -> hyphens.
 *
 * This is ONLY for the filename; it does NOT change the companion name shown in UI.
 */
function normalizeKeyForFile(key: string) {
  return (key || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// Parse "<First>-<Gender>-<Ethnicity>-<Generation>"
function parseCompanionMeta(raw: string): CompanionMeta {
  const cleaned = stripExt(raw || "");
  const parts = cleaned.split("-").map((p) => p.trim()).filter(Boolean);

  // If the string isn't 4 parts, treat as Haven-ish fallback
  if (parts.length < 4) {
    return {
      first: cleaned || DEFAULT_COMPANION_NAME,
      gender: "",
      ethnicity: "",
      generation: "",
      key: cleaned || DEFAULT_COMPANION_NAME,
    };
  }

  return {
    first: parts[0],
    gender: parts[1],
    ethnicity: parts[2],
    generation: parts.slice(3).join("-"),
    key: cleaned,
  };
}

function greetingFor(name: string) {
  const n = (name || DEFAULT_COMPANION_NAME).trim() || DEFAULT_COMPANION_NAME;
  return `Hi, ${n} here. 😊 What's on your mind?`;
}

/**
 * Build candidate headshot URLs:
 * - We try .jpeg then .png
 * - We normalize spaces to hyphens ONLY for filenames (option A).
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
    // If this is the bundled default, just take it (no need to probe)
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

export default function Page() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [companionName, setCompanionName] = useState<string>(DEFAULT_COMPANION_NAME);
  const [planName, setPlanName] = useState<string>("");
  const [avatarSrc, setAvatarSrc] = useState<string>(DEFAULT_AVATAR);

  // this holds the *full* companion key string if provided (e.g. "Aaliyah-Female-Black-Generation Z")
  // used strictly for avatar matching; does not override companionName when fallback is used.
  const [companionKey, setCompanionKey] = useState<string>("");

  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Greeting: once per *browser session* per companion
  useEffect(() => {
    if (typeof window === "undefined") return;

    const keyName = normalizeKeyForFile(companionName || DEFAULT_COMPANION_NAME);
    const greetKey = `${GREET_ONCE_KEY}:${keyName}`;

    // short delay so UI mounts + companionName can arrive from Wix postMessage
    const tmr = window.setTimeout(() => {
      const already = sessionStorage.getItem(greetKey) === "1";
      if (already) return;

      setMessages((prev) => {
        // Don't duplicate if something already populated messages (safety)
        if (prev && prev.length > 0) return prev;
        return [{ role: "assistant", content: greetingFor(companionName || DEFAULT_COMPANION_NAME) }];
      });

      sessionStorage.setItem(greetKey, "1");
    }, 150);

    return () => window.clearTimeout(tmr);
  }, [companionName]);

  // Listen for Wix -> iframe postMessage payload
  useEffect(() => {
    if (typeof window === "undefined") return;

    function onMessage(event: MessageEvent) {
      const data = event?.data;

      // Expecting something like:
      // { type: "WEEKLY_PLAN", loggedIn, planName, companion }
      if (!data || typeof data !== "object") return;

      if (data.type !== "WEEKLY_PLAN") return;

      // Plan name
      if (typeof data.planName === "string") {
        setPlanName(data.planName);
      }

      // Companion key/meta (the 4-part string) used for avatar matching
      const incomingCompanion =
        typeof (data as any).companion === "string" ? (data as any).companion.trim() : "";

      // If Wix sends a companion string, use it.
      // If not provided, default to Haven.
      const resolvedCompanionKey = incomingCompanion || "";

      // CompanionName is the display first name (or Haven)
      if (resolvedCompanionKey) {
        const parsed = parseCompanionMeta(resolvedCompanionKey);
        setCompanionKey(parsed.key);
        setCompanionName(parsed.first || DEFAULT_COMPANION_NAME);
      } else {
        setCompanionKey("");
        setCompanionName(DEFAULT_COMPANION_NAME);
      }

      // Avatar:
      // - If companionKey exists, try headshot candidates
      // - else use bundled default avatar
      const avatarCandidates = buildAvatarCandidates(resolvedCompanionKey || DEFAULT_COMPANION_NAME);
      pickFirstExisting(avatarCandidates).then((picked) => {
        setAvatarSrc(picked);
      });
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // ✅ OPTION B ONLY: make companionName and planName bold.
  // Everything else is unchanged.
  const headerSubtitle = useMemo(() => {
    const n = companionName || DEFAULT_COMPANION_NAME;
    return (
      <span>
        Companion: <strong>{n}</strong>
        {planName ? (
          <>
            {" "}
            • Plan: <strong>{planName}</strong>
          </>
        ) : null}
      </span>
    );
  }, [companionName, planName]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text) return;

    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");

    // TODO: Your existing backend call should remain here.
    // For now, keep the assistant response logic you already have in your file.
    // If your original file already calls an API, leave it intact.
  }, [input]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  return (
    <div style={{ width: "100%", minHeight: "100vh", background: "#fff" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "18px 16px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <img
            src={avatarSrc}
            alt="avatar"
            style={{ width: 64, height: 64, borderRadius: "50%", objectFit: "cover", border: "1px solid #e5e7eb" }}
            onError={() => setAvatarSrc(DEFAULT_AVATAR)}
          />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>AI Haven 4U</div>
            <div style={{ fontSize: 12, color: "#6b7280" }}>{headerSubtitle}</div>
          </div>
        </div>

        {/* Mode buttons (keep your existing styling/logic if you had any) */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            style={{ borderRadius: 999, padding: "6px 10px", border: "1px solid #111", background: "#111", color: "#fff" }}
          >
            Friend
          </button>
          <button style={{ borderRadius: 999, padding: "6px 10px", border: "1px solid #e5e7eb", background: "#fff" }}>
            Romantic
          </button>
          <button style={{ borderRadius: 999, padding: "6px 10px", border: "1px solid #e5e7eb", background: "#fff" }}>
            Intimate (18+)
          </button>
        </div>

        {/* Chat window */}
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            padding: 12,
            minHeight: 360,
            background: "#fff",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.map((m, idx) => (
              <div
                key={idx}
                style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "85%",
                  padding: "10px 12px",
                  borderRadius: 12,
                  background: m.role === "user" ? "#111827" : "#f3f4f6",
                  color: m.role === "user" ? "#fff" : "#111827",
                  whiteSpace: "pre-wrap",
                }}
              >
                {m.content}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
        </div>

        {/* Input row */}
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type here..."
            style={{
              flex: 1,
              borderRadius: 10,
              border: "1px solid #e5e7eb",
              padding: "10px 12px",
              outline: "none",
            }}
          />
          <button
            onClick={sendMessage}
            style={{
              borderRadius: 10,
              padding: "10px 14px",
              background: "#111",
              color: "#fff",
              border: "1px solid #111",
              cursor: "pointer",
            }}
          >
            Send
          </button>
        </div>

        {/* Debug (optional) */}
        {/* <pre style={{ marginTop: 12, fontSize: 12, color: "#6b7280" }}>
          companionKey: {companionKey || "(none)"}{"\n"}
          avatarSrc: {avatarSrc}
        </pre> */}
      </div>
    </div>
  );
}
