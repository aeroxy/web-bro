import { wrap } from "comlink";

import type { ModelWorkerAPI, WorkspaceWorkerAPI } from "../lib/contracts";

export interface RuntimeServices {
  llm: ModelWorkerAPI;
  workspace: WorkspaceWorkerAPI;
  dispose(): void;
}

let runtime: RuntimeServices | null = null;

function createBrowserRuntime(): RuntimeServices {
  const llmWorker = new Worker(
    new URL("../workers/llm.worker.ts", import.meta.url),
    {
      type: "module",
    },
  );
  const workspaceWorker = new Worker(
    new URL("../workers/workspace.worker.ts", import.meta.url),
    {
      type: "module",
    },
  );

  return {
    llm: wrap<ModelWorkerAPI>(llmWorker),
    workspace: wrap<WorkspaceWorkerAPI>(workspaceWorker),
    dispose() {
      llmWorker.terminate();
      workspaceWorker.terminate();

      if (runtime === this) {
        runtime = null;
      }
    },
  };
}

export function getRuntime(): RuntimeServices {
  if (runtime) {
    return runtime;
  }

  runtime = createBrowserRuntime();
  return runtime;
}

export function setRuntimeForTesting(
  nextRuntime: RuntimeServices | null,
): void {
  runtime?.dispose();
  runtime = nextRuntime;
}
