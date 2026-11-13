import { useState } from "react";
import {
  BookOpen,
  Code2,
  ExternalLink,
  Layers,
  Menu,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import type { ConnectionPhase } from "../protocol/qsocketClient";

interface HeaderProps {
  phase: ConnectionPhase;
  e2eActive: boolean;
  onResetToHome?: () => void;
}

const TOP_NAV_LINKS = [
  {
    label: "How It Works",
    href: "https://www.qsocket.io/#architecture",
    icon: Layers,
  },
  {
    label: "Examples",
    href: "https://www.qsocket.io/#examples",
    icon: BookOpen,
  },
] as const;

export function Header({ phase, e2eActive, onResetToHome }: HeaderProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const isConnecting =
    phase === "ws_connecting" ||
    phase === "srp_exchange" ||
    phase === "e2e_init" ||
    phase === "pty_session";
  const isConnected = phase === "connected";
  const isError = phase === "error";

  return (
    <header className="sticky top-0 z-40 w-full border-b border-surface-container-high/60 bg-surface/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        {/* Brand + Top Links */}
        <div className="flex min-w-0 items-center gap-6">
          <button
            type="button"
            onClick={onResetToHome}
            className="group flex shrink-0 items-center gap-2.5 text-left focus:outline-none"
          >
            <span
              className="relative flex size-6 items-center justify-center"
              aria-hidden="true"
            >
              <span className="size-2.5 animate-pulse rounded-full bg-primary" />
              <span className="absolute size-5 rounded-full bg-primary/20 blur-[2px] transition-transform group-hover:scale-125" />
            </span>
            <span className="text-base font-semibold uppercase tracking-wider text-on-surface transition-colors group-hover:text-primary">
              QSocket
            </span>
            <span className="inline-flex items-center gap-1 rounded border border-primary/25 bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-primary">
              <Terminal className="size-3" />
              Web CLI
            </span>
          </button>

          <nav
            aria-label="Primary"
            className="hidden items-center gap-1 md:flex"
          >
            {TOP_NAV_LINKS.map((item) => {
              const Icon = item.icon;
              return (
                <a
                  key={item.href}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container-low hover:text-on-surface"
                >
                  <Icon className="size-3.5 text-primary/80" />
                  <span>{item.label}</span>
                  <ExternalLink className="size-3 opacity-50" />
                </a>
              );
            })}
            <a
              href="https://github.com/qsocket/qsocket"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container-low hover:text-on-surface"
            >
              <Code2 className="size-3.5 text-secondary/80" />
              <span>GitHub</span>
              <ExternalLink className="size-3 opacity-50" />
            </a>
          </nav>
        </div>

        {/* Status Pill + Mobile Menu Button */}
        <div className="flex items-center gap-2.5">
          <div
            className={`hidden items-center gap-2 rounded-full border px-3 py-1 font-mono text-xs sm:inline-flex ${
              isConnected
                ? "border-primary/40 bg-primary/12 text-primary"
                : isConnecting
                  ? "border-amber-400/35 bg-amber-400/10 text-amber-300"
                  : isError
                    ? "border-error/40 bg-error-container/30 text-error"
                    : "border-surface-container-highest bg-surface-container-low text-on-surface-variant"
            }`}
          >
            <span
              className={`size-2 rounded-full ${
                isConnected
                  ? "bg-primary shadow-[0_0_8px_#a4d2a6]"
                  : isConnecting
                    ? "animate-ping bg-amber-300"
                    : isError
                      ? "bg-error"
                      : "bg-outline"
              }`}
            />
            {isConnected ? (
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="size-3.5" />
                {e2eActive ? "QSRN · E2E ENCRYPTED" : "QSRN · WSS CONNECTED"}
              </span>
            ) : isConnecting ? (
              <span>HANDSHAKE IN PROGRESS</span>
            ) : isError ? (
              <span>CONNECTION FAILED</span>
            ) : (
              <span>QSRN READY · relay.qsocket.io</span>
            )}
          </div>

          <button
            type="button"
            onClick={() => setMobileOpen((prev) => !prev)}
            className="inline-flex size-9 items-center justify-center rounded-md border border-surface-container-high bg-surface-container-low text-on-surface-variant transition-colors hover:text-on-surface md:hidden"
            aria-expanded={mobileOpen}
            aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
          >
            {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>

      {/* Mobile Navigation Drawer */}
      {mobileOpen && (
        <nav
          aria-label="Mobile"
          className="border-t border-surface-container-high/60 bg-surface-container-lowest/95 px-4 py-3 md:hidden"
        >
          <div className="flex flex-col gap-1">
            {TOP_NAV_LINKS.map((item) => {
              const Icon = item.icon;
              return (
                <a
                  key={item.href}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMobileOpen(false)}
                  className="flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
                >
                  <span className="flex items-center gap-2">
                    <Icon className="size-4 text-primary" />
                    {item.label}
                  </span>
                  <ExternalLink className="size-3.5 opacity-60" />
                </a>
              );
            })}
            <a
              href="https://github.com/qsocket/qsocket"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMobileOpen(false)}
              className="flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
            >
              <span className="flex items-center gap-2">
                <Code2 className="size-4 text-secondary" />
                GitHub Repository
              </span>
              <ExternalLink className="size-3.5 opacity-60" />
            </a>
          </div>
        </nav>
      )}
    </header>
  );
}
