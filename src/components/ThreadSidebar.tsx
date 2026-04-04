import { startTransition } from "react";

import { useAppStore } from "../app/store";
import type { ChatThread } from "../lib/contracts";
import { truncate } from "../lib/text";

function describeLastMessage(thread: ChatThread): string {
  const lastMessage = thread.messages.at(-1);

  if (!lastMessage) {
    return "Empty thread";
  }

  if (lastMessage.role === "tool") {
    return lastMessage.summary ?? "Tool call";
  }

  return lastMessage.content ?? "";
}

export function ThreadSidebar() {
  const threads = useAppStore((state) => state.threads);
  const currentThreadId = useAppStore((state) => state.currentThreadId);
  const createThread = useAppStore((state) => state.createThread);
  const deleteThread = useAppStore((state) => state.deleteThread);
  const isBusy = useAppStore((state) => state.isBusy);
  const selectThread = useAppStore((state) => state.selectThread);
  const connectWorkspace = useAppStore((state) => state.connectWorkspace);
  const connectModelCacheFolder = useAppStore(
    (state) => state.connectModelCacheFolder,
  );
  const clearModelCacheFolder = useAppStore(
    (state) => state.clearModelCacheFolder,
  );
  const reconnectWorkspace = useAppStore((state) => state.reconnectWorkspace);
  const reconnectModelCacheFolder = useAppStore(
    (state) => state.reconnectModelCacheFolder,
  );
  const modelCache = useAppStore((state) => state.modelCache);
  const workspace = useAppStore((state) => state.workspace);
  const modelStatus = useAppStore((state) => state.modelStatus);
  const modelProgress =
    modelStatus.phase === "loading" && typeof modelStatus.progress === "number"
      ? Math.round(Math.max(0, Math.min(100, modelStatus.progress)))
      : null;

  return (
    <div className="panel-surface flex h-full flex-col">
      <div className="panel-header">
        <div className="flex items-center">
          <h1 className="sr-only">Threads</h1>
          <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-[14px] border border-white/10 bg-white/5 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
            <img
              alt="Web Bro"
              className="h-full w-full scale-[1.18] object-cover object-center"
              src="/icon-512.png"
            />
          </div>
        </div>
        <button
          className="primary-button"
          onClick={() => void createThread()}
          type="button"
        >
          New
        </button>
      </div>

      <div className="panel-body flex flex-col gap-4">
        <div className="surface-muted rounded-[26px] px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-200">Workspace</p>
              <p className="mt-1 text-sm text-slate-500">
                {workspace.name ?? "No folder connected"}
              </p>
            </div>
            <span className="pill">
              {workspace.reconnectRequired
                ? "Reconnect"
                : workspace.name
                  ? "Mounted"
                  : "Idle"}
            </span>
          </div>

          <button
            className="ghost-button mt-4 w-full"
            onClick={() =>
              workspace.reconnectRequired
                ? void reconnectWorkspace()
                : void connectWorkspace()
            }
            type="button"
          >
            {workspace.reconnectRequired
              ? "Reconnect workspace"
              : "Open workspace"}
          </button>
        </div>

        <div className="surface-muted rounded-[26px] px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-200">Model</p>
              <p className="mt-1 truncate text-sm text-slate-500">
                {modelStatus.detail}
              </p>
            </div>
            <span className="pill shrink-0">{modelStatus.phase}</span>
          </div>

          {modelStatus.phase === "loading" ? (
            <div className="mt-4">
              <div className="h-2 overflow-hidden rounded-full bg-white/8">
                <div
                  className={`h-full rounded-full bg-accent-400 transition-[width] duration-300 ${
                    modelProgress === null ? "animate-pulse" : ""
                  }`}
                  style={{
                    width: `${modelProgress ?? 8}%`,
                  }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-slate-500">
                <span>Model load</span>
                <span>
                  {modelProgress === null ? "..." : `${modelProgress}%`}
                </span>
              </div>
            </div>
          ) : null}

          <p className="mt-4 text-xs leading-6 text-slate-500">
            Gemma 4 E2B-it ONNX on WebGPU. Cache source:{" "}
            {modelCache.source ?? "pending"}.
          </p>

          <div className="mt-4 rounded-[20px] border border-white/8 bg-black/30 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-300">
                  Cache folder
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  {modelCache.folderName ?? "Not Selected"}
                </p>
              </div>
              <span className="pill">
                {modelCache.reconnectRequired
                  ? "Reconnect"
                  : modelCache.manifestComplete
                    ? "Ready"
                    : modelCache.configured
                      ? "Priming"
                      : "Optional"}
              </span>
            </div>

            <p className="mt-3 text-xs leading-6 text-slate-500">
              {modelCache.detail}
            </p>

            <div className="mt-3 flex gap-2">
              <button
                className="ghost-button flex-1"
                onClick={() =>
                  modelCache.reconnectRequired
                    ? void reconnectModelCacheFolder()
                    : void connectModelCacheFolder()
                }
                type="button"
              >
                {modelCache.reconnectRequired
                  ? "Reconnect cache"
                  : modelCache.configured
                    ? "Change folder"
                    : "Select folder"}
              </button>
              {modelCache.configured ? (
                <button
                  className="ghost-button"
                  onClick={() => void clearModelCacheFolder()}
                  type="button"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 px-5 pb-5">
        <div className="subtle-scrollbar h-full space-y-2">
          {threads.map((thread) => (
            <div className="group relative" key={thread.id}>
              <button
                className={`w-full rounded-[24px] border px-4 py-3 pr-14 text-left transition ${
                  thread.id === currentThreadId
                    ? "border-accent-500/30 bg-accent-500/10 text-accent-300"
                    : "border-white/8 bg-white/3 text-slate-300 hover:bg-white/6"
                }`}
                onClick={() =>
                  startTransition(() => {
                    selectThread(thread.id);
                  })
                }
                type="button"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="text-sm font-medium">{thread.title}</span>
                  <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-500">
                    {thread.messages.length}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  {truncate(describeLastMessage(thread), 88)}
                </p>
              </button>

              <button
                aria-label={`Delete ${thread.title}`}
                className={`absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-shell-900/95 text-sm text-slate-400 transition ${
                  isBusy
                    ? "cursor-not-allowed opacity-0"
                    : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:border-white/20 hover:bg-white/8 hover:text-slate-100"
                }`}
                disabled={isBusy}
                onClick={(event) => {
                  event.stopPropagation();
                  void deleteThread(thread.id);
                }}
                type="button"
              >
                x
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
