import { useAppStore } from "../../app/store";

export function DebugPanel() {
  const debug = useAppStore((state) => state.debug);
  const isBusy = useAppStore((state) => state.isBusy);
  const setDebugMode = useAppStore((state) => state.setDebugMode);
  const setDebugPrompt = useAppStore((state) => state.setDebugPrompt);
  const addDebugEntry = useAppStore((state) => state.addDebugEntry);
  const removeDebugEntry = useAppStore((state) => state.removeDebugEntry);
  const setDebugEntryRole = useAppStore((state) => state.setDebugEntryRole);
  const setDebugEntryContent = useAppStore(
    (state) => state.setDebugEntryContent,
  );
  const parseDebugPrompt = useAppStore((state) => state.parseDebugPrompt);
  const sendDebugPrompt = useAppStore((state) => state.sendDebugPrompt);
  const cancelDebugPrompt = useAppStore((state) => state.cancelDebugPrompt);
  const clearDebugState = useAppStore((state) => state.clearDebugState);

  return (
    <div className="panel-surface flex h-full flex-col">
      <div className="panel-header">
        <div>
          <p className="panel-title">Debug</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-100">
            Raw Prompt Runner
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="ghost-button"
            onClick={() => clearDebugState()}
            type="button"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="panel-body flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex items-center gap-2">
          <button
            className={`rounded-2xl px-3 py-2 text-sm transition ${
              debug.mode === "raw"
                ? "bg-accent-500/12 text-accent-300"
                : "text-slate-400 hover:bg-white/6"
            }`}
            onClick={() => setDebugMode("raw")}
            type="button"
          >
            Raw
          </button>
          <button
            className={`rounded-2xl px-3 py-2 text-sm transition ${
              debug.mode === "structured"
                ? "bg-accent-500/12 text-accent-300"
                : "text-slate-400 hover:bg-white/6"
            }`}
            onClick={() => setDebugMode("structured")}
            type="button"
          >
            Structured
          </button>
        </div>

        {debug.mode === "structured" ? (
          <div className="subtle-scrollbar surface-muted flex-1 space-y-3 overflow-auto p-4">
            {debug.entries.map((entry, index) => (
              <div
                className="rounded-[24px] border border-white/8 bg-shell-900/80 p-3"
                key={entry.id}
              >
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="pill">#{index + 1}</span>
                    <select
                      aria-label={`Entry ${index + 1} role`}
                      className="input-shell w-auto pr-8"
                      onChange={(event) =>
                        setDebugEntryRole(entry.id, event.target.value as typeof entry.role)
                      }
                      value={entry.role}
                    >
                      <option value="system">system</option>
                      <option value="user">user</option>
                      <option value="assistant">assistant</option>
                    </select>
                  </div>
                  <button
                    className="ghost-button"
                    onClick={() => removeDebugEntry(entry.id)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
                <textarea
                  aria-label={`Entry ${index + 1} content`}
                  className="input-shell min-h-[120px] resize-y bg-transparent text-sm"
                  onChange={(event) =>
                    setDebugEntryContent(entry.id, event.target.value)
                  }
                  placeholder="Message content..."
                  value={entry.content}
                />
              </div>
            ))}

            <div className="flex items-center justify-between gap-3">
              <button
                className="ghost-button"
                onClick={() => addDebugEntry()}
                type="button"
              >
                + Add entry
              </button>
              <button
                className="primary-button"
                onClick={() => parseDebugPrompt()}
                type="button"
              >
                Parse
              </button>
            </div>
          </div>
        ) : null}
        {debug.mode === "raw" ? (
          <>
            <div className="surface-muted flex min-h-0 flex-1 flex-col p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="pill">Prompt</span>
              </div>
              <textarea
                aria-label="Raw prompt"
                className="input-shell min-h-[180px] flex-1 resize-y bg-transparent font-mono text-xs"
                onChange={(event) => setDebugPrompt(event.target.value)}
                placeholder="<|im_start|>user
Hello<|im_end|>"
                value={debug.prompt}
              />
            </div>

            <div className="surface-muted flex min-h-0 flex-1 flex-col p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="pill">Output</span>
                {debug.running ? <span className="pill">Streaming</span> : null}
              </div>
              <pre className="subtle-scrollbar min-h-[180px] flex-1 overflow-auto whitespace-pre-wrap rounded-[24px] border border-white/8 bg-shell-900/80 p-4 font-mono text-xs leading-6 text-slate-200">
                {debug.output || "Model output will stream here."}
              </pre>
              {debug.error ? (
                <p className="mt-3 text-xs text-danger-400">{debug.error}</p>
              ) : null}
            </div>

            <div className="flex items-center justify-between gap-3">
              <p className="text-xs leading-5 text-slate-500">
                Send uses the exact raw prompt above.
              </p>
              <div className="flex items-center gap-3">
                {debug.running ? (
                  <button
                    className="ghost-button-danger"
                    onClick={() => void cancelDebugPrompt()}
                    type="button"
                  >
                    Stop
                  </button>
                ) : null}
                <button
                  className="primary-button"
                  disabled={!debug.prompt.trim() || isBusy}
                  onClick={() => void sendDebugPrompt()}
                  type="button"
                >
                  Send
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
