import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import {
  ArrowDownUp,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Eraser,
  KeyRound,
  Lock,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  PowerOff,
  RefreshCw,
  Search,
  ShieldAlert,
  TerminalSquare,
  X,
} from "lucide-react";
import type {
  ConnectionPhase,
  SessionMetadata,
} from "../protocol/qsocketClient";
import type { Winsize } from "../protocol/session";

export interface TerminalWorkspaceHandle {
  measureWinsize: () => Winsize;
  write: (data: Uint8Array | string) => void;
  writeln: (line: string) => void;
  reset: () => void;
  focus: () => void;
}

interface TerminalWorkspaceProps {
  phase: ConnectionPhase;
  phaseDetail: string;
  sessionMeta: SessionMetadata | null;
  stats: { txBytes: number; rxBytes: number };
  onInput: (data: string | Uint8Array) => void;
  onDisconnect: () => void;
  onReconnect?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hrs > 0
    ? `${pad(hrs)}:${pad(mins)}:${pad(secs)}`
    : `${pad(mins)}:${pad(secs)}`;
}

const FOREST_XTERM_THEME = {
  background: "#0c0f0c",
  foreground: "#e2e3dd",
  cursor: "#a4d2a6",
  cursorAccent: "#0c0f0c",
  selectionBackground: "rgba(164, 210, 166, 0.28)",
  selectionForeground: "#ffffff",
  black: "#1a1c19",
  red: "#ff897d",
  green: "#a4d2a6",
  yellow: "#e7c873",
  blue: "#8ab4f8",
  magenta: "#f8b4c9",
  cyan: "#89dceb",
  white: "#c2c9be",
  brightBlack: "#5c635a",
  brightRed: "#ffb4ab",
  brightGreen: "#c0eec1",
  brightYellow: "#f5df98",
  brightBlue: "#adc8ff",
  brightMagenta: "#ffd9e3",
  brightCyan: "#b2ebf2",
  brightWhite: "#f4f5f0",
};

export const TerminalWorkspace = forwardRef<
  TerminalWorkspaceHandle,
  TerminalWorkspaceProps
>(function TerminalWorkspace(
  {
    phase,
    phaseDetail,
    sessionMeta,
    stats,
    onInput,
    onDisconnect,
    onReconnect,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;

  const [fontSize, setFontSize] = useState(14);
  const [dims, setDims] = useState<{ cols: number; rows: number }>({
    cols: 80,
    rows: 28,
  });
  const [maximized, setMaximized] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [uptimeSec, setUptimeSec] = useState(0);
  const [copiedSelection, setCopiedSelection] = useState(false);

  const safeFitAndMeasure = (): Winsize => {
    const el = containerRef.current;
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;

    if (el && term && fitAddon && el.clientWidth > 20 && el.clientHeight > 20) {
      try {
        fitAddon.fit();
      } catch {
        // Ignore transient layout errors
      }
      const rows = term.rows > 0 ? term.rows : 40;
      const cols = term.cols > 0 ? term.cols : 80;
      setDims({ cols, rows });
      return {
        rows,
        cols,
        x: Math.max(0, el.clientWidth),
        y: Math.max(0, el.clientHeight),
      };
    }

    return {
      rows: term?.rows || 40,
      cols: term?.cols || 80,
      x: el?.clientWidth || 0,
      y: el?.clientHeight || 0,
    };
  };

  useImperativeHandle(ref, () => ({
    measureWinsize: () => safeFitAndMeasure(),
    write: (data: Uint8Array | string) => {
      termRef.current?.write(data);
    },
    writeln: (line: string) => {
      termRef.current?.writeln(line);
    },
    reset: () => {
      termRef.current?.reset();
      safeFitAndMeasure();
    },
    focus: () => {
      termRef.current?.focus();
    },
  }));

  // Initialize xterm.js once on mount
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily:
        '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.24,
      scrollback: 10000,
      allowProposedApi: true,
      convertEol: false,
      macOptionIsMeta: true,
      theme: FOREST_XTERM_THEME,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(searchAddon);
    term.open(el);

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    // Initial welcome banner inside terminal
    term.writeln(
      "\x1b[1;32m● QSocket Interactive PTY Terminal\x1b[0m \x1b[90m(xterm.js · SRP-4096 · AES-256-GCM)\x1b[0m"
    );
    term.writeln(
      "\x1b[90mEnter your QSocket secret URI above and click Connect to attach to your remote peer.\x1b[0m\r\n"
    );

    const dataDisposable = term.onData((data) => {
      onInputRef.current(data);
    });

    const binaryDisposable = term.onBinary((bin) => {
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i) & 0xff;
      }
      onInputRef.current(bytes);
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      setDims({ cols, rows });
    });

    // Fit after fonts & layout settle
    requestAnimationFrame(() => {
      safeFitAndMeasure();
    });
    if ("fonts" in document) {
      void document.fonts.ready.then(() => {
        safeFitAndMeasure();
      });
    }

    const observer = new ResizeObserver(() => {
      safeFitAndMeasure();
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      binaryDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, []);

  // Re-fit when fontSize or maximized state changes
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    const id = requestAnimationFrame(() => {
      safeFitAndMeasure();
    });
    return () => cancelAnimationFrame(id);
  }, [fontSize, maximized]);

  // Escape exits fullscreen only when Ctrl+Shift+Escape or search bar Escape
  useEffect(() => {
    if (!sessionMeta || phase !== "connected") {
      setUptimeSec(0);
      return;
    }
    const tick = () => {
      setUptimeSec(
        Math.max(0, Math.floor((Date.now() - sessionMeta.connectedAt) / 1000))
      );
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [sessionMeta, phase]);

  const isConnected = phase === "connected";
  const isConnecting =
    phase === "ws_connecting" ||
    phase === "srp_exchange" ||
    phase === "e2e_init" ||
    phase === "pty_session";

  const sizeDrifted =
    isConnected &&
    sessionMeta &&
    (dims.cols !== sessionMeta.initialTermSize.cols ||
      dims.rows !== sessionMeta.initialTermSize.rows);

  const handleCopySelection = async () => {
    const sel = termRef.current?.getSelection();
    if (!sel) return;
    try {
      await navigator.clipboard.writeText(sel);
      setCopiedSelection(true);
      setTimeout(() => setCopiedSelection(false), 1500);
    } catch {
      // Ignore clipboard permission errors
    }
  };

  const handlePasteClipboard = async () => {
    if (!isConnected) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        onInput(text);
        termRef.current?.focus();
      }
    } catch {
      // Ignore clipboard permission errors
    }
  };

  const handleSyncStty = () => {
    if (!isConnected) return;
    onInput(`stty rows ${dims.rows} cols ${dims.cols}\r`);
    termRef.current?.focus();
  };

  return (
    <div
      className={
        maximized
          ? "fixed inset-0 z-50 flex flex-col bg-surface-container-lowest p-2 sm:p-4"
          : "relative flex flex-col overflow-hidden rounded-xl border border-surface-container-high/80 bg-surface-container-lowest shadow-[0_20px_50px_-15px_rgba(0,0,0,0.75)]"
      }
    >
      {/* Top Terminal Title & Telemetry Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-container-high/70 bg-surface-container-low px-3.5 py-2">
        {/* Left: Window Dots + Session Title */}
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex items-center gap-1.5" aria-hidden="true">
            <span
              className={`size-2.5 rounded-full ${
                isConnected
                  ? "bg-error/80 hover:bg-error cursor-pointer"
                  : "bg-surface-container-highest"
              }`}
              onClick={isConnected ? onDisconnect : undefined}
              title={isConnected ? "Disconnect session" : undefined}
            />
            <span className="size-2.5 rounded-full bg-amber-400/60" />
            <span
              className="size-2.5 cursor-pointer rounded-full bg-primary/80 hover:bg-primary"
              onClick={() => setMaximized((m) => !m)}
              title="Toggle fullscreen terminal"
            />
          </div>

          <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
            <TerminalSquare className="size-3.5 shrink-0 text-primary" />
            <span className="truncate font-medium text-on-surface">
              {sessionMeta
                ? `${sessionMeta.wsUrl.split("?")[0]}`
                : "pty://awaiting-session"}
            </span>
          </div>

          {isConnected && sessionMeta && (
            <div className="hidden items-center gap-1.5 lg:flex">
              {sessionMeta.e2eEnabled ? (
                <span className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[11px] text-primary">
                  <Lock className="size-3" />
                  AES-256-GCM
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded border border-amber-400/35 bg-amber-400/10 px-2 py-0.5 font-mono text-[11px] text-amber-300">
                  <ShieldAlert className="size-3" />
                  NO-E2E
                </span>
              )}

              {sessionMeta.sessionKeyFingerprint && (
                <span
                  className="inline-flex items-center gap-1 rounded border border-surface-container-highest bg-surface-container px-2 py-0.5 font-mono text-[11px] text-on-surface-variant"
                  title="Ephemeral 256-bit SRP Session Key Fingerprint (SHA-256 prefix)"
                >
                  <KeyRound className="size-3 text-secondary" />
                  {sessionMeta.sessionKeyFingerprint}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right: Metrics + Terminal Actions */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Dimensions Pill */}
          <span
            className="inline-flex items-center rounded border border-surface-container-highest bg-surface-container px-2 py-0.5 font-mono text-[11px] text-on-surface-variant"
            title="Current xterm.js PTY grid dimensions (Columns × Rows)"
          >
            {dims.cols}×{dims.rows}
          </span>

          {/* Dynamic stty helper if window resized after handshake */}
          {sizeDrifted && (
            <button
              type="button"
              onClick={handleSyncStty}
              className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/15 px-2 py-0.5 font-mono text-[11px] text-primary transition-colors hover:bg-primary/25"
              title="Send `stty rows R cols C` to update remote shell dimensions"
            >
              <RefreshCw className="size-3" />
              Sync PTY
            </button>
          )}

          {/* Encrypted Byte Counters & Uptime */}
          {(isConnected || stats.rxBytes > 0 || stats.txBytes > 0) && (
            <span className="hidden items-center gap-1.5 rounded border border-surface-container-highest bg-surface-container px-2 py-0.5 font-mono text-[11px] text-on-surface-variant sm:inline-flex">
              <ArrowDownUp className="size-3 text-primary" />
              <span>↑{formatBytes(stats.txBytes)}</span>
              <span className="text-outline">·</span>
              <span>↓{formatBytes(stats.rxBytes)}</span>
              {isConnected && (
                <>
                  <span className="text-outline">·</span>
                  <span className="text-primary">{formatDuration(uptimeSec)}</span>
                </>
              )}
            </span>
          )}

          {/* Font Size Controls */}
          <div className="hidden items-center rounded border border-surface-container-highest bg-surface-container sm:inline-flex">
            <button
              type="button"
              onClick={() => setFontSize((s) => Math.max(11, s - 1))}
              className="px-1.5 py-1 text-on-surface-variant transition-colors hover:text-on-surface"
              title="Decrease terminal font size"
              aria-label="Decrease font size"
            >
              <Minus className="size-3" />
            </button>
            <span className="px-1 font-mono text-[11px] text-outline">
              {fontSize}
            </span>
            <button
              type="button"
              onClick={() => setFontSize((s) => Math.min(22, s + 1))}
              className="px-1.5 py-1 text-on-surface-variant transition-colors hover:text-on-surface"
              title="Increase terminal font size"
              aria-label="Increase font size"
            >
              <Plus className="size-3" />
            </button>
          </div>

          {/* Search Toggle */}
          <button
            type="button"
            onClick={() => setSearchOpen((v) => !v)}
            className={`inline-flex items-center justify-center rounded border p-1.5 transition-colors ${
              searchOpen
                ? "border-primary/50 bg-primary/15 text-primary"
                : "border-surface-container-highest bg-surface-container text-on-surface-variant hover:text-on-surface"
            }`}
            title="Search terminal buffer"
            aria-label="Search terminal"
          >
            <Search className="size-3.5" />
          </button>

          {/* Copy Selection */}
          <button
            type="button"
            onClick={handleCopySelection}
            className="inline-flex items-center justify-center rounded border border-surface-container-highest bg-surface-container p-1.5 text-on-surface-variant transition-colors hover:text-on-surface"
            title={copiedSelection ? "Copied!" : "Copy terminal selection"}
            aria-label="Copy selection"
          >
            <Copy
              className={`size-3.5 ${copiedSelection ? "text-primary" : ""}`}
            />
          </button>

          {/* Paste */}
          <button
            type="button"
            onClick={handlePasteClipboard}
            disabled={!isConnected}
            className="inline-flex items-center justify-center rounded border border-surface-container-highest bg-surface-container p-1.5 text-on-surface-variant transition-colors hover:text-on-surface disabled:opacity-40"
            title="Paste clipboard into PTY"
            aria-label="Paste clipboard"
          >
            <ClipboardPaste className="size-3.5" />
          </button>

          {/* Clear Terminal */}
          <button
            type="button"
            onClick={() => {
              termRef.current?.clear();
              termRef.current?.focus();
            }}
            className="inline-flex items-center justify-center rounded border border-surface-container-highest bg-surface-container p-1.5 text-on-surface-variant transition-colors hover:text-on-surface"
            title="Clear scrollback"
            aria-label="Clear terminal"
          >
            <Eraser className="size-3.5" />
          </button>

          {/* Maximize / Restore */}
          <button
            type="button"
            onClick={() => setMaximized((m) => !m)}
            className="inline-flex items-center justify-center rounded border border-surface-container-highest bg-surface-container p-1.5 text-on-surface-variant transition-colors hover:text-on-surface"
            title={maximized ? "Exit fullscreen" : "Maximize terminal"}
            aria-label={maximized ? "Exit fullscreen" : "Maximize terminal"}
          >
            {maximized ? (
              <Minimize2 className="size-3.5 text-primary" />
            ) : (
              <Maximize2 className="size-3.5" />
            )}
          </button>

          {/* Disconnect / Reconnect */}
          {isConnected || isConnecting ? (
            <button
              type="button"
              onClick={onDisconnect}
              className="inline-flex items-center gap-1 rounded border border-error/40 bg-error-container/35 px-2.5 py-1 text-xs font-medium text-error transition-colors hover:bg-error-container/55"
            >
              <PowerOff className="size-3.5" />
              <span>Disconnect</span>
            </button>
          ) : (
            (phase === "disconnected" || phase === "error") &&
            onReconnect && (
              <button
                type="button"
                onClick={onReconnect}
                className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/25"
              >
                <RefreshCw className="size-3.5" />
                <span>Reconnect</span>
              </button>
            )
          )}
        </div>
      </div>

      {/* Optional Search Bar */}
      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-surface-container-high/70 bg-surface-container px-3.5 py-1.5">
          <Search className="size-3.5 text-outline" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              const q = e.target.value;
              setSearchQuery(q);
              if (q) searchAddonRef.current?.findNext(q);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (e.shiftKey) {
                  searchAddonRef.current?.findPrevious(searchQuery);
                } else {
                  searchAddonRef.current?.findNext(searchQuery);
                }
              } else if (e.key === "Escape") {
                setSearchOpen(false);
                termRef.current?.focus();
              }
            }}
            placeholder="Find in terminal output..."
            autoFocus
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-on-surface placeholder:text-outline focus:outline-none"
          />
          <button
            type="button"
            onClick={() =>
              searchQuery && searchAddonRef.current?.findPrevious(searchQuery)
            }
            className="rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            title="Previous match"
          >
            <ChevronUp className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() =>
              searchQuery && searchAddonRef.current?.findNext(searchQuery)
            }
            className="rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            title="Next match"
          >
            <ChevronDown className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              termRef.current?.focus();
            }}
            className="rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            title="Close search"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* Handshake Overlay Banner while Negotiating */}
      {isConnecting && (
        <div className="flex items-center justify-between gap-3 border-b border-primary/25 bg-primary/10 px-4 py-2 font-mono text-xs text-primary">
          <div className="flex items-center gap-2.5">
            <span className="size-2 animate-ping rounded-full bg-primary" />
            <span>{phaseDetail}</span>
          </div>
          <span className="hidden text-[11px] text-primary/75 sm:inline">
            Measuring {dims.cols}×{dims.rows} PTY viewport
          </span>
        </div>
      )}

      {/* xterm.js Canvas Container */}
      <div
        ref={containerRef}
        onClick={() => termRef.current?.focus()}
        className={
          maximized
            ? "min-h-0 flex-1 w-full bg-[#0c0f0c]"
            : "h-[440px] sm:h-[520px] w-full bg-[#0c0f0c]"
        }
      />
    </div>
  );
});
