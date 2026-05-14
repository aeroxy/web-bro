import { wrap } from "comlink";

import type {
  AgentBackend,
  ModelWorkerAPI,
  WorkspaceWorkerAPI,
} from "../lib/contracts";
import { createChromeAIBackend } from "./chrome-ai-runtime";

export interface RuntimeServices {
  llm: ModelWorkerAPI;
  workspace: WorkspaceWorkerAPI;
  dispose(): void;
}

const runtimes = new Map<AgentBackend, RuntimeServices>();

function createRuntimeForBackend(backend: AgentBackend): RuntimeServices {
  const workspaceWorker = new Worker(
    new URL("../workers/workspace.worker.ts", import.meta.url),
    {
      type: "module",
    },
  );
  const workspace = wrap<WorkspaceWorkerAPI>(workspaceWorker);

  if (backend === "chrome-ai") {
    const llm = createChromeAIBackend();
    return {
      llm,
      workspace,
      dispose() {
        llm.destroy();
        workspaceWorker.terminate();
        if (runtimes.get("chrome-ai") === this) {
          runtimes.delete("chrome-ai");
        }
      },
    };
  }

  const llmWorker = new Worker(
    new URL("../workers/llm.worker.ts", import.meta.url),
    {
      type: "module",
    },
  );

  return {
    llm: wrap<ModelWorkerAPI>(llmWorker),
    workspace,
    dispose() {
      llmWorker.terminate();
      workspaceWorker.terminate();
      if (runtimes.get("gemma") === this) {
        runtimes.delete("gemma");
      }
    },
  };
}

export function getRuntime(backend: AgentBackend = "gemma"): RuntimeServices {
  let runtime = runtimes.get(backend);
  if (runtime) {
    return runtime;
  }
  runtime = createRuntimeForBackend(backend);
  runtimes.set(backend, runtime);
  return runtime;
}

export function setRuntimeForTesting(
  nextRuntime: RuntimeServices | null,
  backend: AgentBackend = "gemma",
): void {
  runtimes.get(backend)?.dispose();
  if (nextRuntime) {
    runtimes.set(backend, nextRuntime);
  } else {
    runtimes.delete(backend);
  }
}

export function disposeRuntime(backend: AgentBackend): void {
  runtimes.get(backend)?.dispose();
}
