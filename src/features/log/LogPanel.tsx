import { useState } from "react";
import type { LogEntry } from "../../app/store";
import { useAppStore } from "../../app/store";
import { formatTimestamp } from "../../lib/text";

function formatLogForCopy(entry: LogEntry): string {
  const parts: string[] = [];
  const label = entry.toolName ? "tool" : "turn";

  parts.push(`[${formatTimestamp(entry.timestamp)}] ${label}`);

  if (entry.error) {
    parts.push(`Error: ${entry.error}`);
  }

  if (entry.streamingChunks && entry.streamingChunks.length > 0) {
    parts.push(`Streaming: ${entry.streamingChunks.join("")}`);
  }

  if (entry.toolName) {
    parts.push(`Tool: ${entry.toolName}`);
    if (entry.toolArgs) {
      parts.push(`Args: ${JSON.stringify(entry.toolArgs, null, 2)}`);
    }
    if (entry.toolResult) {
      parts.push(`Result: ${JSON.stringify(entry.toolResult, null, 2)}`);
    }
  } else {
    parts.push(`Payload:\n${entry.payload || "(not captured)"}`);
    if (entry.raw) {
      parts.push(`Raw Output:\n${entry.raw}`);
    }
    if (entry.raw) {
      parts.push(`Raw Output:\n${entry.raw}`);
    }
    if (entry.parsed) {
      parts.push(`Parsed: ${JSON.stringify(entry.parsed, null, 2)}`);
    }
  }

  return parts.join("\n\n");
}

function JsonDisplay({ data }: { data: unknown }) {
  const json = JSON.stringify(data, null, 2);
  return (
    <pre className="whitespace-pre-wrap font-mono text-xs text-slate-300">
      {json}
    </pre>
  );
}

function LogEntryComponent({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = formatLogForCopy(entry);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-2xl border border-white/8 bg-white/4">
      <button
        className="flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-white/6"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-slate-500">
            {formatTimestamp(entry.timestamp)}
          </span>
          <span
            className={`rounded-2xl px-2 py-1 text-xs ${
              entry.toolName
                ? "bg-orange-500/12 text-orange-300"
                : "bg-accent-500/12 text-accent-300"
            }`}
          >
            {entry.toolName ? "tool" : "turn"}
          </span>
          {entry.error && (
            <span className="rounded-2xl bg-danger-500/12 px-2 py-1 text-xs text-danger-300">
              error
            </span>
          )}
          {entry.streamingChunks &&
            entry.streamingChunks.length > 0 &&
            !entry.streamingComplete && (
              <span className="rounded-2xl bg-yellow-500/12 px-2 py-1 text-xs text-yellow-300">
                streaming...
              </span>
            )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleCopy();
            }}
            className="rounded px-2 py-1 text-xs text-slate-400 transition hover:bg-white/10 hover:text-slate-200"
            type="button"
            title="Copy log entry"
          >
            {copied ? "✓" : "Copy"}
          </button>
          <span className="text-slate-500">{expanded ? "▲" : "▼"}</span>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-white/8 px-4 py-3">
          <div className="space-y-4">
            {entry.toolName ? (
              <>
                <div>
                  <p className="mb-2 text-xs font-medium text-slate-400">
                    Tool
                  </p>
                  <JsonDisplay
                    data={{ tool: entry.toolName, args: entry.toolArgs }}
                  />
                </div>
                {entry.toolResult && (
                  <div>
                    <p className="mb-2 text-xs font-medium text-slate-400">
                      Result
                    </p>
                    <JsonDisplay data={entry.toolResult} />
                  </div>
                )}
              </>
            ) : (
              <>
                <div>
                  <p className="mb-2 text-xs font-medium text-slate-400">
                    Payload Sent to Model
                  </p>
                  <pre className="whitespace-pre-wrap font-mono text-xs text-slate-300 max-h-96 overflow-auto">
                    {entry.payload || "(not captured)"}
                  </pre>
                </div>
                {entry.request && (
                  <div>
                    <p className="mb-2 text-xs font-medium text-slate-400">
                      Request
                    </p>
                    <JsonDisplay data={entry.request} />
                  </div>
                )}
                {entry.raw && (
                  <div>
                    <p className="mb-2 text-xs font-medium text-slate-400">
                      Raw Output
                    </p>
                    <pre className="whitespace-pre-wrap font-mono text-xs text-slate-300">
                      {entry.raw}
                    </pre>
                  </div>
                )}
                {entry.parsed && (
                  <div>
                    <p className="mb-2 text-xs font-medium text-slate-400">
                      Parsed Decision
                    </p>
                    <JsonDisplay data={entry.parsed} />
                  </div>
                )}
                {entry.streamingChunks && entry.streamingChunks.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-medium text-slate-400">
                      Streaming Chunks ({entry.streamingChunks.length})
                    </p>
                    <pre className="whitespace-pre-wrap font-mono text-xs text-slate-300">
                      {entry.streamingChunks.join("")}
                    </pre>
                  </div>
                )}
                {entry.error && (
                  <div>
                    <p className="mb-2 text-xs font-medium text-slate-400">
                      Error
                    </p>
                    <p className="text-xs text-danger-300">{entry.error}</p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function LogPanel() {
  const logs = useAppStore((state) => state.logs);
  const clearLogs = useAppStore((state) => state.clearLogs);

  return (
    <div className="panel-surface flex h-full flex-col">
      <div className="panel-header">
        <div>
          <p className="panel-title">Log</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-100">
            Model Requests
          </h2>
        </div>
        <button
          className="ghost-button"
          onClick={() => clearLogs()}
          type="button"
        >
          Clear
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500">
            No logs yet. Send a prompt to see model requests.
          </div>
        ) : (
          <div className="space-y-3">
            {logs.map((log) => (
              <LogEntryComponent key={log.id} entry={log} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
