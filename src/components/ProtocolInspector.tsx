import { useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  KeyRound,
  Loader2,
  Lock,
  Radio,
  Terminal,
  XCircle,
} from "lucide-react";
import type {
  ConnectionPhase,
  ProtocolLogEntry,
} from "../protocol/qsocketClient";

interface ProtocolInspectorProps {
  phase: ConnectionPhase;
  logs: ProtocolLogEntry[];
  e2eEnabled: boolean;
}

const STAGES = [
  {
    key: "ws_connecting",
    step: "01",
    title: "QSRN Knock",
    subtitle: "WSS /web-cli?key=<UID>",
    icon: Radio,
  },
  {
    key: "srp_exchange",
    step: "02",
    title: "SRP-6a PAKE",
    subtitle: "4096-bit Prime · BLAKE2b",
    icon: KeyRound,
  },
  {
    key: "e2e_init",
    step: "03",
    title: "Encrypted Stream",
    subtitle: "AES-256-GCM · 64KB Frames",
    icon: Lock,
  },
  {
    key: "pty_session",
    step: "04",
    title: "PTY Negotiation",
    subtitle: "QS v1 · CMD_SSH | FLAG_PTY",
    icon: Terminal,
  },
] as const;

const PHASE_ORDER: Record<string, number> = {
  idle: -1,
  ws_connecting: 0,
  srp_exchange: 1,
  e2e_init: 2,
  pty_session: 3,
  connected: 4,
};

export function ProtocolInspector({
  phase,
  logs,
  e2eEnabled,
}: ProtocolInspectorProps) {
  const [logsExpanded, setLogsExpanded] = useState(false);

  const currentIdx = PHASE_ORDER[phase] ?? -1;

  return (
    <section className="rounded-xl border border-surface-container-high/70 bg-surface-container-low/90 p-4 shadow-sm">
      {/* 4-Stage Pipeline */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {STAGES.map((stage, index) => {
          const Icon = stage.icon;
          const skipped = !e2eEnabled && stage.key === "srp_exchange";
          const isDone =
            phase === "connected" ||
            (currentIdx > index && phase !== "error" && phase !== "disconnected");
          const isActive = currentIdx === index;
          const isErrorHere =
            phase === "error" &&
            logs.length > 0 &&
            ((index === 0 && logs.length <= 3) ||
              (index === 1 &&
                logs.some((l) => l.stage === "SRP-4096" && l.level === "error")));

          return (
            <div
              key={stage.key}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                skipped
                  ? "border-surface-container-high/40 bg-surface-container-lowest/40 opacity-50"
                  : isDone
                    ? "border-primary/35 bg-primary/10"
                    : isActive
                      ? "border-amber-400/45 bg-amber-400/10"
                      : isErrorHere
                        ? "border-error/45 bg-error-container/25"
                        : "border-surface-container-high/60 bg-surface-container/60"
              }`}
            >
              <div
                className={`flex size-8 shrink-0 items-center justify-center rounded-md border ${
                  isDone
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : isActive
                      ? "border-amber-400/40 bg-amber-400/15 text-amber-300"
                      : isErrorHere
                        ? "border-error/40 bg-error-container/40 text-error"
                        : "border-surface-container-highest bg-surface-container-low text-outline"
                }`}
              >
                {isActive ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : isDone ? (
                  <CheckCircle2 className="size-4" />
                ) : isErrorHere ? (
                  <XCircle className="size-4" />
                ) : skipped ? (
                  <Circle className="size-3.5" />
                ) : (
                  <Icon className="size-4" />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-outline">
                    {stage.step}
                  </span>
                  <span className="truncate text-xs font-semibold text-on-surface">
                    {stage.title}
                  </span>
                </div>
                <p className="truncate font-mono text-[11px] text-on-surface-variant">
                  {skipped
                    ? "Bypassed (--no-e2e)"
                    : stage.key === "e2e_init" && !e2eEnabled
                      ? "Plain WSS stream"
                      : stage.subtitle}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Expandable Handshake Trace Log */}
      {logs.length > 0 && (
        <div className="mt-3 border-t border-surface-container-high/60 pt-2.5">
          <button
            type="button"
            onClick={() => setLogsExpanded((prev) => !prev)}
            className="flex w-full items-center justify-between text-left font-mono text-xs text-on-surface-variant transition-colors hover:text-on-surface"
          >
            <span className="inline-flex items-center gap-2">
              <Activity className="size-3.5 text-primary" />
              <span>Protocol Handshake Trace</span>
              <span className="hidden truncate text-outline sm:inline">
                — {logs[logs.length - 1]?.message}
              </span>
            </span>
            {logsExpanded ? (
              <ChevronUp className="size-4 shrink-0 text-outline" />
            ) : (
              <ChevronDown className="size-4 shrink-0 text-outline" />
            )}
          </button>

          {logsExpanded && (
            <div className="mt-2 max-h-44 overflow-y-auto rounded-lg border border-surface-container-high bg-surface-container-lowest p-2.5 font-mono text-xs">
              {logs.map((entry) => {
                const time = new Date(entry.timestamp).toLocaleTimeString([], {
                  hour12: false,
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                });
                const badgeClass =
                  entry.level === "success"
                    ? "text-primary"
                    : entry.level === "error"
                      ? "text-error"
                      : entry.level === "warn"
                        ? "text-amber-300"
                        : "text-secondary";
                return (
                  <div
                    key={entry.id}
                    className="flex items-start gap-2 py-0.5 leading-relaxed"
                  >
                    <span className="shrink-0 text-outline">[{time}]</span>
                    <span className={`w-20 shrink-0 font-semibold ${badgeClass}`}>
                      {entry.stage}
                    </span>
                    <span className="break-all text-on-surface-variant">
                      {entry.message}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
