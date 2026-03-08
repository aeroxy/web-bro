import { DiffEditor, Editor } from "@monaco-editor/react";
import { useDeferredValue, useEffect, useState } from "react";

import { useAppStore } from "../../app/store";
import { FileTree } from "../../components/FileTree";
import { getLanguageFromPath } from "../../lib/text";

type WorkspaceTab = "files" | "changes";

export function WorkspacePanel() {
  const workspace = useAppStore((state) => state.workspace);
  const connectWorkspace = useAppStore((state) => state.connectWorkspace);
  const openFile = useAppStore((state) => state.openFile);
  const refreshWorkspace = useAppStore((state) => state.refreshWorkspace);
  const searchWorkspace = useAppStore((state) => state.searchWorkspace);
  const clearSearch = useAppStore((state) => state.clearSearch);
  const undoWrite = useAppStore((state) => state.undoWrite);
  const dismissDiff = useAppStore((state) => state.dismissDiff);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<WorkspaceTab>("files");
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    if (!deferredSearch.trim()) {
      clearSearch();
      return;
    }

    void searchWorkspace(deferredSearch);
  }, [clearSearch, deferredSearch, searchWorkspace]);

  useEffect(() => {
    if (workspace.diff) {
      setTab("changes");
    }
  }, [workspace.diff]);

  if (!workspace.name) {
    return (
      <div className="panel-surface flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
        <span className="pill">Workspace</span>
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold text-accent-300">
            Connect a local folder
          </h2>
          <p className="max-w-lg text-sm leading-6 text-slate-400">
            The app never uploads your repository to a backend. It reads and
            writes directly through the browser's directory handle.
          </p>
        </div>
        <button
          className="primary-button"
          onClick={() => void connectWorkspace()}
          type="button"
        >
          Open workspace
        </button>
      </div>
    );
  }

  return (
    <div className="panel-surface flex h-full flex-col">
      <div className="panel-header">
        <div>
          <p className="panel-title">Workspace</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-100">
            {workspace.name}
          </h2>
        </div>
        <button
          className="ghost-button"
          onClick={() => void refreshWorkspace()}
          type="button"
        >
          Refresh
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-[auto_auto_minmax(13rem,1fr)_minmax(18rem,1fr)] gap-4 px-5 py-4">
        <div className="surface-muted rounded-[26px] px-4 py-4">
          <p className="text-sm leading-6 text-slate-300">
            {workspace.summary ?? "Workspace ready."}
          </p>
          {workspace.error ? (
            <p className="mt-2 text-sm text-danger-400">{workspace.error}</p>
          ) : null}
        </div>

        <input
          className="input-shell"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search files and symbols..."
          value={search}
        />

        <div className="surface-muted subtle-scrollbar rounded-[26px] px-3 py-3">
          {search.trim() ? (
            <div className="space-y-2">
              {workspace.searchResults.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-slate-500">
                  No search matches.
                </div>
              ) : (
                workspace.searchResults.map((result) => (
                  <button
                    className="w-full rounded-2xl border border-white/8 bg-white/4 px-4 py-3 text-left transition hover:bg-white/6"
                    key={`${result.path}:${result.line}:${result.column}`}
                    onClick={() => void openFile(result.path)}
                    type="button"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-slate-200">
                        {result.path}
                      </span>
                      <span className="font-mono text-xs text-slate-500">
                        {result.line}:{result.column}
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      {result.preview}
                    </p>
                  </button>
                ))
              )}
            </div>
          ) : (
            <FileTree
              activePath={workspace.activeFile?.path ?? null}
              nodes={workspace.tree}
              onSelect={(path) => {
                void openFile(path);
                setTab("files");
              }}
            />
          )}
        </div>

        <div className="surface-muted flex min-h-0 flex-col rounded-[26px]">
          <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
            <div className="flex items-center gap-2">
              <button
                className={`rounded-2xl px-3 py-2 text-sm transition ${
                  tab === "files"
                    ? "bg-accent-500/12 text-accent-300"
                    : "text-slate-400 hover:bg-white/6"
                }`}
                onClick={() => setTab("files")}
                type="button"
              >
                File
              </button>
              <button
                className={`rounded-2xl px-3 py-2 text-sm transition ${
                  tab === "changes"
                    ? "bg-accent-500/12 text-accent-300"
                    : "text-slate-400 hover:bg-white/6"
                }`}
                onClick={() => setTab("changes")}
                type="button"
              >
                Changes
              </button>
            </div>

            {tab === "changes" && workspace.diff ? (
              <div className="flex items-center gap-2">
                <button
                  className="ghost-button"
                  onClick={() => void undoWrite(workspace.diff?.backupId ?? "")}
                  type="button"
                >
                  Undo
                </button>
                <button
                  className="ghost-button"
                  onClick={() => dismissDiff()}
                  type="button"
                >
                  Dismiss
                </button>
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1">
            {tab === "changes" && workspace.diff ? (
              <DiffEditor
                height="100%"
                language={getLanguageFromPath(workspace.diff.path)}
                modified={workspace.diff.after}
                options={{
                  minimap: { enabled: false },
                  readOnly: true,
                  renderSideBySide: true,
                }}
                original={workspace.diff.before}
                theme="vs-dark"
              />
            ) : workspace.activeFile ? (
              <Editor
                height="100%"
                language={getLanguageFromPath(workspace.activeFile.path)}
                options={{
                  minimap: { enabled: false },
                  readOnly: true,
                  wordWrap: "on",
                }}
                path={workspace.activeFile.path}
                theme="vs-dark"
                value={workspace.activeFile.content}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500">
                Pick a file from the tree or search results to inspect it.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
