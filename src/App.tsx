import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Dices,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Link2,
  Lock,
  Play,
  PowerOff,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import { Header } from "./components/Header";
import { ProtocolInspector } from "./components/ProtocolInspector";
import {
  TerminalWorkspace,
  type TerminalWorkspaceHandle,
} from "./components/TerminalWorkspace";
import {
  DEFAULT_QSRN_RELAY,
  buildQsrnWebCliUrl,
  connectToQSocketRelay,
  type ActiveQSocketConnection,
  type ConnectionPhase,
  type ProtocolLogEntry,
  type SessionMetadata,
} from "./protocol/qsocketClient";
import {
  URI_SCHEME,
  extractSecretFromUrlHash,
  generateRandomUUIDv4,
  resolveQSocketSecret,
  stripURIScheme,
} from "./protocol/secret";

const MASK = "••••••••";

/**
 * Replaces every secret-bearing token (the canonical secret, which also hides
 * the qs:// URI, and the knock UID) in a log line with a mask.
 */
function maskSecrets(text: string, tokens: readonly string[]): string {
  let out = text;
  for (const token of tokens) {
    out = out.split(token).join(MASK);
  }
  return out;
}

function formatLogTime(timestamp = Date.now()): string {
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export default function App() {
  // The secret field holds the part after the fixed qs:// prefix it shows.
  // Pre-populate it from the URL hash on initial load.
  const [secretInput, setSecretInput] = useState<string>(() =>
    stripURIScheme(extractSecretFromUrlHash(window.location.hash))
  );
  const secretUri = secretInput.trim()
    ? `${URI_SCHEME}${secretInput.trim()}`
    : "";
  const [showSecret, setShowSecret] = useState<boolean>(true);

  // Secret-bearing tokens of the current connection, and whether the logs
  // have to hide them. Refs, so the callbacks of a running connection mask
  // the lines they write according to the current mask toggle.
  const secretTokensRef = useRef<string[]>([]);
  const showSecretRef = useRef(showSecret);
  showSecretRef.current = showSecret;
  const maskLog = useCallback(
    (text: string) =>
      showSecretRef.current ? text : maskSecrets(text, secretTokensRef.current),
    []
  );
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false);

  // Advanced connection options matching qsock / qsocket-go flags
  const [relayServer, setRelayServer] = useState<string>(DEFAULT_QSRN_RELAY);
  const [e2eEnabled, setE2eEnabled] = useState<boolean>(true);
  const [normalizeUuid, setNormalizeUuid] = useState<boolean>(true);
  const [execCommand, setExecCommand] = useState<string>("");

  // Live session state
  const [phase, setPhase] = useState<ConnectionPhase>("idle");
  const [phaseDetail, setPhaseDetail] = useState<string>("Ready to connect");
  const [logs, setLogs] = useState<ProtocolLogEntry[]>([]);
  const [stats, setStats] = useState<{ txBytes: number; rxBytes: number }>({
    txBytes: 0,
    rxBytes: 0,
  });
  const [sessionMeta, setSessionMeta] = useState<SessionMetadata | null>(null);

  // Copy feedback states
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const terminalRef = useRef<TerminalWorkspaceHandle | null>(null);
  const activeConnRef = useRef<ActiveQSocketConnection | null>(null);

  // Keep secret pre-populated if user navigates/changes URL hash
  useEffect(() => {
    const onHashChange = () => {
      const hashSecret = extractSecretFromUrlHash(window.location.hash);
      if (hashSecret && !activeConnRef.current) {
        setSecretInput(stripURIScheme(hashSecret));
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Clean up socket on unmount
  useEffect(() => {
    return () => {
      activeConnRef.current?.disconnect();
    };
  }, []);

  // Live preview of resolved canonical qs:// URI and Base64 knock UID
  const secretResolution = useMemo(() => {
    if (!secretUri) {
      return { resolved: null, error: null };
    }
    try {
      const resolved = resolveQSocketSecret(secretUri, normalizeUuid);
      return { resolved, error: null };
    } catch (err) {
      return {
        resolved: null,
        error: err instanceof Error ? err.message : "Invalid secret format.",
      };
    }
  }, [secretUri, normalizeUuid]);

  const previewWsUrl = useMemo(() => {
    if (!secretResolution.resolved) return null;
    try {
      return buildQsrnWebCliUrl(
        relayServer,
        secretResolution.resolved.uidBase64
      );
    } catch {
      return null;
    }
  }, [relayServer, secretResolution.resolved]);

  // The inspector re-renders, so its log lines follow the mask toggle.
  const displayLogs = useMemo(
    () =>
      showSecret
        ? logs
        : logs.map((l) => ({ ...l, message: maskLog(l.message) })),
    [logs, showSecret, maskLog]
  );

  const isBusy =
    phase === "ws_connecting" ||
    phase === "srp_exchange" ||
    phase === "e2e_init" ||
    phase === "pty_session";
  const isConnected = phase === "connected";

  const handleDisconnect = useCallback(() => {
    activeConnRef.current?.disconnect();
    activeConnRef.current = null;
  }, []);

  const startConnection = useCallback(() => {
    const targetSecret = secretUri;
    if (!targetSecret) {
      const msg =
        "Please enter a QSocket secret (e.g. a UUID) or click qsock -g to generate one.";
      const now = Date.now();
      setPhase("error");
      setPhaseDetail(msg);
      setLogs((prev) => [
        ...prev,
        {
          id: `${now}-secret-empty`,
          timestamp: now,
          level: "error",
          stage: "SECRET",
          message: msg,
        },
      ]);
      terminalRef.current?.writeln(
        `\x1b[1;31m[${formatLogTime(now)}]\x1b[0m \x1b[90m[SECRET]\x1b[0m ${msg}`
      );
      return;
    }

    // Validate secret upfront
    try {
      const resolved = resolveQSocketSecret(targetSecret, normalizeUuid);
      // Longest first, so a token containing another is masked whole.
      secretTokensRef.current = [
        resolved.canonicalSecret,
        resolved.uidBase64,
        resolved.uidHex,
      ].sort((a, b) => b.length - a.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid QSocket secret.";
      const now = Date.now();
      setPhase("error");
      setPhaseDetail(msg);
      setLogs((prev) => [
        ...prev,
        {
          id: `${now}-secret-invalid`,
          timestamp: now,
          level: "error",
          stage: "SECRET",
          message: msg,
        },
      ]);
      terminalRef.current?.writeln(
        `\x1b[1;31m[${formatLogTime(now)}]\x1b[0m \x1b[90m[SECRET]\x1b[0m ${msg}`
      );
      return;
    }

    // Close any existing session
    activeConnRef.current?.disconnect();
    activeConnRef.current = null;

    setLogs([]);
    setStats({ txBytes: 0, rxBytes: 0 });
    setSessionMeta(null);

    // Update URL hash cleanly without scrolling
    try {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#${encodeURIComponent(
          secretInput.trim()
        )}`
      );
    } catch {
      // Ignore history state restrictions in sandboxed iframes
    }

    // Reset xterm.js and print handshake status
    terminalRef.current?.reset();
    terminalRef.current?.writeln(
      `\x1b[1;32m[#] .::QSocket Web CLI::.\x1b[0m \x1b[90m(${
        relayServer || DEFAULT_QSRN_RELAY
      })\x1b[0m`
    );

    const conn = connectToQSocketRelay({
      secretInput: targetSecret,
      relayServer,
      e2e: e2eEnabled,
      normalizeSecretUuid: normalizeUuid,
      execCommand,
      getTerminalSize: () =>
        terminalRef.current?.measureWinsize() ?? {
          rows: 40,
          cols: 80,
          x: 0,
          y: 0,
        },
      onPhaseChange: (nextPhase, detail) => {
        setPhase(nextPhase);
        setPhaseDetail(detail);
      },
      onLog: (entry) => {
        setLogs((prev) => [...prev, entry]);
        if (entry.stage !== "SESSION" || entry.level !== "success") {
          const color =
            entry.level === "error"
              ? "\x1b[1;31m"
              : entry.level === "success"
                ? "\x1b[1;32m"
                : entry.level === "warn"
                  ? "\x1b[1;33m"
                  : "\x1b[36m";
          const timeStr = formatLogTime(entry.timestamp);
          terminalRef.current?.writeln(
            `${color}[${timeStr}]\x1b[0m \x1b[90m[${entry.stage}]\x1b[0m ${maskLog(entry.message)}`
          );
        }
      },
      onSessionEstablished: (meta) => {
        setSessionMeta(meta);
        const timeStr = formatLogTime(meta.connectedAt);
        terminalRef.current?.writeln(
          `\x1b[1;32m[${timeStr}]\x1b[0m \x1b[90m[SESSION]\x1b[0m Session attached (${meta.initialTermSize.cols}x${meta.initialTermSize.rows} PTY · ${meta.cipherSuite})\r\n`
        );
        requestAnimationFrame(() => {
          terminalRef.current?.focus();
        });
      },
      onOutput: (chunk) => {
        terminalRef.current?.write(chunk);
      },
      onStats: (nextStats) => {
        setStats(nextStats);
      },
      onClose: (reason, hadError) => {
        activeConnRef.current = null;
        const timeStr = formatLogTime();
        if (hadError) {
          terminalRef.current?.writeln(
            `\x1b[1;31m[${timeStr}]\x1b[0m Connection terminated: ${maskLog(reason)}\r\n`
          );
        } else {
          terminalRef.current?.writeln(
            `\r\n\x1b[90m[${timeStr}]\x1b[0m ${maskLog(reason)}\r\n`
          );
        }
      },
    });

    activeConnRef.current = conn;
  }, [secretUri, secretInput, relayServer, e2eEnabled, normalizeUuid, execCommand, maskLog]);

  const handleTerminalInput = useCallback((data: string | Uint8Array) => {
    activeConnRef.current?.sendInput(data);
  }, []);

  const handleGenerateSecret = () => {
    // The field shows qs:// as its prefix, it only takes the UUID itself.
    const newSecret = generateRandomUUIDv4();
    setSecretInput(newSecret);
    try {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#${encodeURIComponent(
          newSecret
        )}`
      );
    } catch {
      // Ignore
    }
  };

  const listenerCommand = secretResolution.resolved
    ? `qsock -l ${secretResolution.resolved.uri}`
    : "qsock -l qs://<secret>";

  const handleCopyListenerCommand = async () => {
    try {
      await navigator.clipboard.writeText(listenerCommand);
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 1800);
    } catch {
      // Ignore
    }
  };

  const handleCopyShareUrl = async () => {
    const secret = secretInput.trim();
    if (!secret) return;
    const shareUrl = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(
      secret
    )}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 1800);
    } catch {
      // Ignore
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col bg-surface text-on-surface">
      {/* Subtle Ambient Forest Glow + Dot Matrix */}
      <div
        className="pointer-events-none fixed inset-0 qs-grid-dots opacity-45"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none fixed -top-40 left-1/2 h-96 w-[44rem] -translate-x-1/2 rounded-full bg-primary/8 blur-[120px]"
        aria-hidden="true"
      />

      {/* Top Navigation Header with How It Works & Examples links */}
      <Header
        phase={phase}
        e2eActive={sessionMeta?.e2eEnabled ?? e2eEnabled}
      />

      {/* Main Content */}
      <main className="relative z-10 mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 px-4 py-5 sm:px-6 sm:py-6">
        {/* Connection Control Card */}
        <section className="rounded-xl border border-surface-container-high/80 bg-surface-container-low/95 p-4 shadow-lg sm:p-5">
          <div className="mb-3.5 flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
            <div>
              <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-on-surface sm:text-xl">
                <span>Encrypted Peer-to-Peer Web Terminal</span>
                <span className="hidden rounded-full border border-primary/25 bg-primary/10 px-2.5 py-0.5 font-mono text-[11px] font-medium text-primary sm:inline-flex">
                  SRP-4096 + AES-256-GCM
                </span>
              </h1>
              <p className="text-xs text-on-surface-variant sm:text-sm">
                Connect directly from your browser to any remote{" "}
                <code className="rounded bg-surface-container-high px-1.5 py-0.5 font-mono text-xs text-primary">
                  qsock -l
                </code>{" "}
                peer behind NAT or firewalls over the QSocket Relay Network (QSRN).
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setAdvancedOpen((prev) => !prev)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  advancedOpen
                    ? "border-primary/45 bg-primary/15 text-primary"
                    : "border-surface-container-highest bg-surface-container text-on-surface-variant hover:text-on-surface"
                }`}
              >
                <Settings2 className="size-3.5" />
                <span>Options</span>
              </button>
            </div>
          </div>

          {/* Secret Input Form */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (isConnected || isBusy) {
                handleDisconnect();
              } else {
                startConnection();
              }
            }}
            className="flex flex-col gap-2.5 sm:flex-row"
          >
            <div className="flex min-w-0 flex-1 items-center rounded-lg border border-surface-container-highest bg-surface-container-lowest focus-within:border-primary has-[input:disabled]:opacity-60">
              <KeyRound className="pointer-events-none ml-3.5 size-4 shrink-0 text-primary/80" />
              {/* The scheme is a fixed prefix, not part of the editable value */}
              <label
                htmlFor="qs-secret"
                className="ml-2.5 shrink-0 cursor-text select-none font-mono text-sm text-outline/60"
              >
                {URI_SCHEME}
              </label>
              <input
                id="qs-secret"
                type={showSecret ? "text" : "password"}
                value={secretInput}
                onChange={(e) => {
                  setSecretInput(stripURIScheme(e.target.value));
                }}
                disabled={isBusy || isConnected}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                placeholder="f81d4fae-7dec-41d0-a765-00a0c91e6bf6 or secret phrase..."
                aria-label="QSocket connection secret"
                className="min-w-0 flex-1 bg-transparent py-2.5 pr-2 font-mono text-sm text-on-surface placeholder:text-outline/75 focus:outline-none"
              />
              <div className="mr-2 flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setShowSecret((s) => !s)}
                  className="rounded p-1.5 text-outline transition-colors hover:bg-surface-container hover:text-on-surface"
                  title={showSecret ? "Mask secret" : "Reveal secret"}
                  aria-label={showSecret ? "Mask secret" : "Reveal secret"}
                >
                  {showSecret ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleGenerateSecret}
                  disabled={isBusy || isConnected}
                  className="inline-flex items-center gap-1 rounded border border-surface-container-highest bg-surface-container px-2 py-1 font-mono text-[11px] font-medium text-on-surface-variant transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-40"
                  title="Generate random v4 UUID secret (qsock -g)"
                >
                  <Dices className="size-3.5" />
                  <span className="hidden sm:inline">qsock -g</span>
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {secretInput.trim() && (
                <button
                  type="button"
                  onClick={handleCopyShareUrl}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-surface-container-highest bg-surface-container px-3 py-2.5 text-xs font-medium text-on-surface-variant transition-colors hover:border-primary/35 hover:text-on-surface"
                  title="Copy pre-populated #secret URL"
                >
                  {copiedUrl ? (
                    <Check className="size-4 text-primary" />
                  ) : (
                    <Link2 className="size-4" />
                  )}
                  <span className="sm:hidden lg:inline">
                    {copiedUrl ? "Copied URL" : "Share URL"}
                  </span>
                </button>
              )}

              {isConnected || isBusy ? (
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-error/45 bg-error-container/45 px-5 py-2.5 text-sm font-semibold text-error transition-all hover:bg-error-container/65 sm:flex-none"
                >
                  <PowerOff className="size-4" />
                  <span>{isBusy ? "Cancel" : "Disconnect"}</span>
                </button>
              ) : (
                <button
                  type="submit"
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-on-primary shadow-[0_0_24px_-6px_rgba(164,210,166,0.5)] transition-all hover:bg-[#b5dfb7] active:scale-[0.99] sm:flex-none"
                >
                  <Play className="size-4 fill-current" />
                  <span>Connect to QSRN</span>
                </button>
              )}
            </div>
          </form>

          {/* Helper Bar: Peer Listener Command + Resolved UID Preview */}
          <div className="mt-3 flex flex-col justify-between gap-2 rounded-lg border border-surface-container-high/60 bg-surface-container/60 px-3 py-2 text-xs sm:flex-row sm:items-center">
            <div className="flex min-w-0 items-center gap-2">
              <Terminal className="size-3.5 shrink-0 text-primary" />
              <span className="shrink-0 text-on-surface-variant">
                Remote host listener:
              </span>
              <code className="truncate font-mono text-on-surface">
                {showSecret
                  ? listenerCommand
                  : "qsock -l qs://••••••••••••••••••••••••••••••••••••"}
              </code>
              <button
                type="button"
                onClick={handleCopyListenerCommand}
                disabled={!secretResolution.resolved}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-surface-container-highest bg-surface-container-low px-2 py-0.5 font-mono text-[11px] text-on-surface-variant transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-40"
                title="Copy qsock listener command"
              >
                {copiedCmd ? (
                  <>
                    <Check className="size-3 text-primary" />
                    <span className="text-primary">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="size-3" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>

            {secretResolution.resolved && previewWsUrl && (
              <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-outline">
                {secretResolution.resolved.wasDerivedUUID && (
                  <span
                    className="inline-flex items-center gap-1 rounded bg-surface-container-high px-1.5 py-0.5 text-secondary"
                    title="Non-UUID secret deterministically hashed into RFC 9562 UUIDv8 per qsocket/config/uri.go"
                  >
                    <Sparkles className="size-3" />
                    UUIDv8 derived
                  </span>
                )}
                <span className="truncate" title={previewWsUrl}>
                  Endpoint:{" "}
                  <span className="text-on-surface-variant">
                    /web-cli?key=
                    {showSecret
                      ? secretResolution.resolved.uidBase64
                      : "••••••••••••"}
                  </span>
                </span>
              </div>
            )}
          </div>

          {/* Collapsible Advanced Options */}
          {advancedOpen && (
            <div className="mt-3.5 grid grid-cols-1 gap-3 border-t border-surface-container-high/70 pt-3.5 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-on-surface-variant">
                  QSRN Relay Gate (--relay-server)
                </label>
                <input
                  type="text"
                  value={relayServer}
                  onChange={(e) => setRelayServer(e.target.value)}
                  disabled={isBusy || isConnected}
                  placeholder="relay.qsocket.io"
                  className="w-full rounded-md border border-surface-container-highest bg-surface-container-lowest px-2.5 py-1.5 font-mono text-xs text-on-surface placeholder:text-outline focus:border-primary focus:outline-none disabled:opacity-60"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-on-surface-variant">
                  Initial Command (optional Exec TLV)
                </label>
                <input
                  type="text"
                  value={execCommand}
                  onChange={(e) => setExecCommand(e.target.value)}
                  disabled={isBusy || isConnected}
                  placeholder="Default login shell (/bin/bash -il)"
                  className="w-full rounded-md border border-surface-container-highest bg-surface-container-lowest px-2.5 py-1.5 font-mono text-xs text-on-surface placeholder:text-outline focus:border-primary focus:outline-none disabled:opacity-60"
                />
              </div>

              <div className="flex flex-col justify-end">
                <label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-surface-container-highest bg-surface-container px-3 py-2 text-xs">
                  <input
                    type="checkbox"
                    checked={e2eEnabled}
                    onChange={(e) => setE2eEnabled(e.target.checked)}
                    disabled={isBusy || isConnected}
                    className="size-3.5 accent-[#a4d2a6]"
                  />
                  <span className="font-medium text-on-surface">
                    E2E Encryption (--e2e)
                  </span>
                </label>
              </div>

              <div className="flex flex-col justify-end">
                <label
                  className="flex cursor-pointer items-center gap-2.5 rounded-md border border-surface-container-highest bg-surface-container px-3 py-2 text-xs"
                  title="Matches qsock v0.1.0+ URI normalization (hashes plain ASCII secrets into RFC 9562 v8 UUIDs). Uncheck only when connecting to raw qsocket-go custom binaries."
                >
                  <input
                    type="checkbox"
                    checked={normalizeUuid}
                    onChange={(e) => setNormalizeUuid(e.target.checked)}
                    disabled={isBusy || isConnected}
                    className="size-3.5 accent-[#a4d2a6]"
                  />
                  <span className="font-medium text-on-surface">
                    qs:// UUIDv8 Derivation
                  </span>
                </label>
              </div>
            </div>
          )}
        </section>

        {/* E2E Protocol Handshake Stepper & Trace Log */}
        <ProtocolInspector
          phase={phase}
          logs={displayLogs}
          e2eEnabled={sessionMeta?.e2eEnabled ?? e2eEnabled}
        />

        {/* Interactive xterm.js PTY Terminal Window */}
        <TerminalWorkspace
          ref={terminalRef}
          phase={phase}
          phaseDetail={showSecret ? phaseDetail : maskLog(phaseDetail)}
          sessionMeta={sessionMeta}
          stats={stats}
          onInput={handleTerminalInput}
          onDisconnect={handleDisconnect}
          onReconnect={() => startConnection()}
        />
      </main>

      {/* Footer matching qsocket.io Forest Fidelity aesthetic */}
      <footer className="relative z-10 mt-auto border-t border-surface-container-high/50 bg-surface-container-lowest/90 py-4">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-4 text-xs text-on-surface-variant sm:flex-row sm:px-6">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded border border-surface-container-high bg-surface-container px-2.5 py-1">
              <Lock className="size-3 text-primary" />
              <span>End-to-end encrypted (SRP-4096 + AES-256-GCM)</span>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded border border-surface-container-high bg-surface-container px-2.5 py-1">
              <ShieldCheck className="size-3 text-secondary" />
              <span>100% Static Client · Zero Backend</span>
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-4">
            <a
              href="https://www.qsocket.io/#architecture"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 transition-colors hover:text-on-surface hover:underline"
            >
              How It Works
              <ExternalLink className="size-3 opacity-60" />
            </a>
            <a
              href="https://www.qsocket.io/#examples"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 transition-colors hover:text-on-surface hover:underline"
            >
              Examples
              <ExternalLink className="size-3 opacity-60" />
            </a>
            <a
              href="https://github.com/qsocket/qsocket-go"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 transition-colors hover:text-on-surface hover:underline"
            >
              qsocket-go
              <ExternalLink className="size-3 opacity-60" />
            </a>
            <span className="text-outline">
              © {new Date().getFullYear()} QSocket
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
