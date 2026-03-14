import { useEffect, useState } from "react";
import {
  Panel,
  Group as PanelGroup,
  Separator as PanelResizeHandle,
} from "react-resizable-panels";

import { CapabilityGate } from "../components/CapabilityGate";
import { ThreadSidebar } from "../components/ThreadSidebar";
import { ChatPanel } from "../features/chat/ChatPanel";
import { LogPanel } from "../features/log/LogPanel";
import { WorkspacePanel } from "../features/workspace/WorkspacePanel";
import { useAppStore } from "./store";

function LoadingShell() {
  return (
    <div className="app-shell">
      <div className="panel-surface flex h-full flex-col items-center justify-center gap-5 text-center">
        <p className="pill">Booting</p>
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold text-accent-300">Web Bro</h1>
          <p className="max-w-xl text-sm text-slate-400">
            Restoring local threads, workspace permissions, and the browser-only
            agent shell.
          </p>
        </div>
      </div>
    </div>
  );
}

function RightPanel() {
  const [tab, setTab] = useState<"workspace" | "log">("workspace");

  return (
    <div className="panel-surface flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            className={`rounded-2xl px-3 py-2 text-sm transition ${
              tab === "workspace"
                ? "bg-accent-500/12 text-accent-300"
                : "text-slate-400 hover:bg-white/6"
            }`}
            onClick={() => setTab("workspace")}
            type="button"
          >
            Workspace
          </button>
          <button
            className={`rounded-2xl px-3 py-2 text-sm transition ${
              tab === "log"
                ? "bg-accent-500/12 text-accent-300"
                : "text-slate-400 hover:bg-white/6"
            }`}
            onClick={() => setTab("log")}
            type="button"
          >
            Log
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === "workspace" ? <WorkspacePanel /> : <LogPanel />}
      </div>
    </div>
  );
}

export default function App() {
  const initialize = useAppStore((state) => state.initialize);
  const hydrated = useAppStore((state) => state.hydrated);
  const capabilities = useAppStore((state) => state.capabilities);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  if (!hydrated) {
    return <LoadingShell />;
  }

  if (!capabilities.supported) {
    return <CapabilityGate report={capabilities} />;
  }

  return (
    <div className="app-shell">
      <PanelGroup className="h-full" orientation="horizontal">
        <Panel defaultSize={20} minSize={15}>
          <ThreadSidebar />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={44} minSize={32}>
          <ChatPanel />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={36} minSize={24}>
          <RightPanel />
        </Panel>
      </PanelGroup>
    </div>
  );
}
