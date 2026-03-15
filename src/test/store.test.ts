import { describe, expect, it, vi } from "vitest";

import { createAppStore } from "../app/store";
import type {
  AgentDecision,
  GenerateTurnRequest,
  GenerateTurnResult,
  ModelCacheStatus,
  ModelStatus,
  WorkspaceFileSnapshot,
  WorkspaceSearchHit,
  WorkspaceSnapshot,
  WorkspaceTreeNode,
} from "../lib/contracts";
import { AppDatabase } from "../lib/db";
import type { RuntimeServices } from "../services/runtime";

function createFakeHandle(name = "workspace"): FileSystemDirectoryHandle {
  return {
    kind: "directory",
    name,
    isSameEntry: async () => false,
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
  } as unknown as FileSystemDirectoryHandle;
}

function createMockRuntime(initialFiles: Record<string, string>) {
  const files = new Map<string, { content: string; revision: number }>(
    Object.entries(initialFiles).map(([path, content]) => [
      path,
      { content, revision: 1 },
    ]),
  );
  const decisions: AgentDecision[] = [
    {
      type: "tool",
      tool: "search_text",
      args: { query: "app" },
    },
    {
      type: "tool",
      tool: "read_file",
      args: { path: "src/app.ts" },
    },
    {
      type: "tool",
      tool: "write_file",
      args: {
        path: "src/app.ts",
        content: "export const app = 'updated';\n",
      },
    },
  ];
  let decisionIndex = 0;
  let modelCacheStatus: ModelCacheStatus = {
    configured: false,
    detail: "Browser cache only.",
    folderName: null,
    isReady: false,
    manifestComplete: false,
    permission: "unknown",
    source: null,
  };

  const buildTree = (): WorkspaceTreeNode[] => [
    {
      children: [
        {
          kind: "file",
          name: "app.ts",
          path: "src/app.ts",
        },
      ],
      kind: "directory",
      name: "src",
      path: "src",
    },
  ];

  const buildSnapshot = (): WorkspaceSnapshot => ({
    name: "workspace",
    summary: `Workspace "workspace" has ${files.size} files.`,
    tree: buildTree(),
  });

  const readFile = async (path: string): Promise<WorkspaceFileSnapshot> => {
    const existing = files.get(path);

    if (!existing) {
      throw new Error(`ERR_NOT_FOUND:${path}`);
    }

    return {
      content: existing.content,
      path,
      revision: `r${existing.revision}`,
      truncated: false,
    };
  };

  const runtime: RuntimeServices = {
    dispose() {},
    llm: {
      abortGeneration: vi.fn(async () => {}),
      clearModelCachePreference: vi.fn(async () => {
        modelCacheStatus = {
          configured: false,
          detail: "Browser cache only.",
          folderName: null,
          isReady: false,
          manifestComplete: false,
          permission: "unknown",
          source: null,
        };
        return modelCacheStatus;
      }),
      configureModelCache: vi.fn(
        async (handle: FileSystemDirectoryHandle | null) => {
          modelCacheStatus = handle
            ? {
                configured: true,
                detail:
                  "Model folder selected. Missing files will be downloaded on first load.",
                folderName: handle.name,
                isReady: false,
                manifestComplete: false,
                permission: "granted",
                source: null,
              }
            : {
                configured: false,
                detail: "Browser cache only.",
                folderName: null,
                isReady: false,
                manifestComplete: false,
                permission: "unknown",
                source: null,
              };
          return modelCacheStatus;
        },
      ),
      generateTurn: vi.fn(
        async (
          _request: GenerateTurnRequest,
          _onStream?: (chunk: { type: "text"; text: string }) => void,
        ): Promise<GenerateTurnResult> => {
          const fallback: AgentDecision = {
            type: "final",
            message: "done",
          };

          return {
            decision: decisions[decisionIndex++] ?? fallback,
            prompt:
              "<|im_start|>system\nmock\n<|im_end|>\n<|im_start|>assistant\n",
          };
        },
      ),
      getStatus: vi.fn(
        async (): Promise<ModelStatus> => ({
          detail: "Model ready on WebGPU.",
          phase: "ready",
        }),
      ),
      getModelCacheStatus: vi.fn(async () => modelCacheStatus),
      loadModel: vi.fn(
        async (): Promise<ModelStatus> => ({
          detail: "Model ready on WebGPU.",
          phase: "ready",
        }),
      ),
    },
    workspace: {
      deleteEntry: vi.fn(async (path: string) => {
        files.delete(path);
        return buildSnapshot();
      }),
      listTree: vi.fn(async () => buildSnapshot().tree),
      mountWorkspace: vi.fn(async () => buildSnapshot()),
      readTextFile: vi.fn(readFile),
      refresh: vi.fn(async () => buildSnapshot()),
      searchText: vi.fn(
        async (query: string): Promise<WorkspaceSearchHit[]> => [
          {
            column: 1,
            line: 1,
            path: "src/app.ts",
            preview: `match for ${query}`,
            revision: "r1",
            snippet: "export const app = 'initial';",
          },
        ],
      ),
      writeTextFile: vi.fn(
        async (path: string, content: string, expectedRevision) => {
          const existing = files.get(path);

          if (existing && expectedRevision !== `r${existing.revision}`) {
            throw new Error(`ERR_CONFLICT:${path}`);
          }

          const previousContent = existing?.content ?? "";
          const previousRevision = existing ? `r${existing.revision}` : null;
          const nextRevision = (existing?.revision ?? 0) + 1;

          files.set(path, {
            content,
            revision: nextRevision,
          });

          return {
            created: !existing,
            nextRevision: `r${nextRevision}`,
            path,
            previousContent,
            previousRevision,
          };
        },
      ),
    },
  };

  return { files, runtime };
}

describe("app store", () => {
  it("runs the agent loop, stores a backup, and undoes the write", async () => {
    const database = new AppDatabase(`web-bro-test-${crypto.randomUUID()}`);
    const { files, runtime } = createMockRuntime({
      "src/app.ts": "export const app = 'initial';\n",
    });
    const store = createAppStore({
      capabilityReport: {
        hasDirectoryPicker: true,
        hasWebGPU: true,
        isChromium: true,
        isSecureContext: true,
        reasons: [],
        supported: true,
      },
      database,
      pickWorkspace: async () => createFakeHandle(),
      runtime,
    });

    await store.getState().initialize();
    store.setState((state) => ({
      ...state,
      workspace: {
        ...state.workspace,
        handle: createFakeHandle(),
        name: "workspace",
        permission: "granted",
        reconnectRequired: false,
        summary: 'Workspace "workspace" has 1 files.',
        tree: [
          {
            children: [
              {
                kind: "file",
                name: "app.ts",
                path: "src/app.ts",
              },
            ],
            kind: "directory",
            name: "src",
            path: "src",
          },
        ],
      },
    }));
    await store.getState().sendPrompt("Update the app constant.");

    const state = store.getState();
    const currentThread =
      state.threads.find((thread) => thread.id === state.currentThreadId) ??
      null;
    const toolMessage = currentThread?.messages.find(
      (message) => message.role === "tool",
    );

    expect(runtime.llm.loadModel).toHaveBeenCalledTimes(1);
    expect(
      currentThread?.messages.some((message) => message.role === "tool"),
    ).toBe(true);
    expect(
      toolMessage && "call" in toolMessage ? toolMessage.call : null,
    ).toContain('"query": "app"');
    expect(state.workspace.diff?.path).toBe("src/app.ts");
    expect(files.get("src/app.ts")?.content).toBe(
      "export const app = 'updated';\n",
    );

    const backups = await database.write_backups.toArray();
    expect(backups).toHaveLength(1);

    const backup = backups[0];

    if (!backup) {
      throw new Error("Expected a backup to exist.");
    }

    await store.getState().undoWrite(backup.id);
    expect(files.get("src/app.ts")?.content).toBe(
      "export const app = 'initial';\n",
    );
  });

  it("restores persisted threads on a new store instance", async () => {
    const database = new AppDatabase(`web-bro-test-${crypto.randomUUID()}`);
    const { runtime } = createMockRuntime({
      "src/app.ts": "export const app = 'initial';\n",
    });
    const firstStore = createAppStore({
      capabilityReport: {
        hasDirectoryPicker: true,
        hasWebGPU: true,
        isChromium: true,
        isSecureContext: true,
        reasons: [],
        supported: true,
      },
      database,
      pickWorkspace: async () => createFakeHandle(),
      runtime,
    });

    await firstStore.getState().initialize();
    await firstStore.getState().sendPrompt("Hello there.");

    const secondStore = createAppStore({
      capabilityReport: {
        hasDirectoryPicker: true,
        hasWebGPU: true,
        isChromium: true,
        isSecureContext: true,
        reasons: [],
        supported: true,
      },
      database,
      runtime,
    });

    await secondStore.getState().initialize();

    expect(secondStore.getState().threads[0]?.title).toBe("Hello there.");
  });

  it("surfaces model download progress while loading", async () => {
    const database = new AppDatabase(`web-bro-test-${crypto.randomUUID()}`);
    const { runtime } = createMockRuntime({
      "src/app.ts": "export const app = 'initial';\n",
    });
    let modelReady = false;

    runtime.llm.getStatus = vi.fn(async (): Promise<ModelStatus> => {
      if (modelReady) {
        return {
          detail: "Model ready on WebGPU.",
          phase: "ready",
          progress: 100,
        };
      }

      return {
        detail: "Downloading model weights (64%).",
        phase: "loading",
        progress: 64,
      };
    });
    runtime.llm.loadModel = vi.fn(async (): Promise<ModelStatus> => {
      await new Promise((resolve) => {
        setTimeout(resolve, 220);
      });
      modelReady = true;

      return {
        detail: "Model ready on WebGPU.",
        phase: "ready",
        progress: 100,
      };
    });

    const store = createAppStore({
      capabilityReport: {
        hasDirectoryPicker: true,
        hasWebGPU: true,
        isChromium: true,
        isSecureContext: true,
        reasons: [],
        supported: true,
      },
      database,
      pickWorkspace: async () => createFakeHandle(),
      runtime,
    });

    await store.getState().initialize();
    store.setState((state) => ({
      ...state,
      workspace: {
        ...state.workspace,
        handle: createFakeHandle(),
        name: "workspace",
        permission: "granted",
        reconnectRequired: false,
        summary: 'Workspace "workspace" has 1 files.',
        tree: [
          {
            children: [
              {
                kind: "file",
                name: "app.ts",
                path: "src/app.ts",
              },
            ],
            kind: "directory",
            name: "src",
            path: "src",
          },
        ],
      },
    }));

    const pendingTurn = store.getState().sendPrompt("Update the app constant.");

    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });

    expect(store.getState().agentActivity).toBe("Loading local model...");
    expect(store.getState().modelStatus.phase).toBe("loading");
    expect(store.getState().modelStatus.progress).toBe(64);

    await pendingTurn;

    expect(store.getState().modelStatus.phase).toBe("ready");
    expect(store.getState().modelStatus.progress).toBe(100);
  });

  it("calls write_file when the model outputs a tool call", async () => {
    const database = new AppDatabase(`web-bro-test-${crypto.randomUUID()}`);
    const { files, runtime } = createMockRuntime({
      "src/app.ts": "export const app = 'initial';\n",
    });

    runtime.llm.generateTurn = vi.fn(
      async (
        _request: GenerateTurnRequest,
        _onStream?: (chunk: { type: "text"; text: string }) => void,
      ): Promise<GenerateTurnResult> => {
        return {
          decision: {
            type: "tool",
            tool: "write_file",
            args: {
              path: "web-bro.md",
              content: "# Web Bro\n\nI introduce myself here.\n",
            },
          },
          prompt:
            "<|im_start|>system\nmock\n<|im_end|>\n<|im_start|>assistant\n",
        };
      },
    );

    const store = createAppStore({
      capabilityReport: {
        hasDirectoryPicker: true,
        hasWebGPU: true,
        isChromium: true,
        isSecureContext: true,
        reasons: [],
        supported: true,
      },
      database,
      pickWorkspace: async () => createFakeHandle(),
      runtime,
    });

    await store.getState().initialize();
    store.setState((state) => ({
      ...state,
      workspace: {
        ...state.workspace,
        handle: createFakeHandle(),
        name: "workspace",
        permission: "granted",
        reconnectRequired: false,
        summary: 'Workspace "workspace" has 1 files.',
        tree: [
          {
            children: [
              {
                kind: "file",
                name: "app.ts",
                path: "src/app.ts",
              },
            ],
            kind: "directory",
            name: "src",
            path: "src",
          },
        ],
      },
    }));

    await store
      .getState()
      .sendPrompt("write a new file web-bro.md to intro urself");

    expect(files.get("web-bro.md")?.content).toBe(
      "# Web Bro\n\nI introduce myself here.\n",
    );
    expect(runtime.workspace.writeTextFile).toHaveBeenCalledWith(
      "web-bro.md",
      "# Web Bro\n\nI introduce myself here.\n",
      null,
    );
  });

  it("sends full conversation history including assistant and tool messages", async () => {
    const database = new AppDatabase(`web-bro-test-${crypto.randomUUID()}`);
    const { runtime } = createMockRuntime({
      "src/app.ts": "export const app = 'initial';\n",
    });
    const requests: GenerateTurnRequest[] = [];

    runtime.llm.generateTurn = vi.fn(
      async (
        request: GenerateTurnRequest,
        _onStream?: (chunk: { type: "text"; text: string }) => void,
      ): Promise<GenerateTurnResult> => {
        requests.push(request);

        if (requests.length === 1) {
          return {
            decision: {
              type: "tool",
              tool: "read_file",
              args: {
                path: "src/app.ts",
              },
            },
            prompt:
              "<|im_start|>system\nmock\n<|im_end|>\n<|im_start|>assistant\n",
          };
        }

        return {
          decision: {
            type: "final",
            message: "done",
          },
          prompt:
            "<|im_start|>system\nmock\n<|im_end|>\n<|im_start|>assistant\n",
        };
      },
    );

    const store = createAppStore({
      capabilityReport: {
        hasDirectoryPicker: true,
        hasWebGPU: true,
        isChromium: true,
        isSecureContext: true,
        reasons: [],
        supported: true,
      },
      database,
      pickWorkspace: async () => createFakeHandle(),
      runtime,
    });

    await store.getState().initialize();
    store.setState((state) => ({
      ...state,
      workspace: {
        ...state.workspace,
        handle: createFakeHandle(),
        name: "workspace",
        permission: "granted",
        reconnectRequired: false,
        summary: 'Workspace "workspace" has 1 files.',
        tree: [
          {
            children: [
              {
                kind: "file",
                name: "app.ts",
                path: "src/app.ts",
              },
            ],
            kind: "directory",
            name: "src",
            path: "src",
          },
        ],
      },
    }));

    await store.getState().sendPrompt("Read src/app.ts and tell me about it.");

    expect(requests).toHaveLength(2);
    expect(requests[0]?.conversation).toEqual([
      {
        role: "user",
        content: "Read src/app.ts and tell me about it.",
      },
    ]);
    expect(requests[1]?.conversation).toEqual([
      {
        role: "user",
        content: "Read src/app.ts and tell me about it.",
      },
      {
        role: "assistant",
        content: '[TOOL]{"tool":"read_file","args":{"path":"src/app.ts"}}[END]',
      },
      {
        role: "tool",
        content:
          "[Tool: read_file]\nStatus: SUCCESS\nSummary: Read src/app.ts.\nResult:\nsrc/app.ts\n\nexport const app = 'initial';\n",
      },
    ]);
  });

  it("deletes the active thread, clears its diff, and creates a replacement when needed", async () => {
    const database = new AppDatabase(`web-bro-test-${crypto.randomUUID()}`);
    const { runtime } = createMockRuntime({
      "src/app.ts": "export const app = 'initial';\n",
    });
    const store = createAppStore({
      capabilityReport: {
        hasDirectoryPicker: true,
        hasWebGPU: true,
        isChromium: true,
        isSecureContext: true,
        reasons: [],
        supported: true,
      },
      database,
      pickWorkspace: async () => createFakeHandle(),
      runtime,
    });

    await store.getState().initialize();
    store.setState((state) => ({
      ...state,
      workspace: {
        ...state.workspace,
        handle: createFakeHandle(),
        name: "workspace",
        permission: "granted",
        reconnectRequired: false,
        summary: 'Workspace "workspace" has 1 files.',
        tree: [
          {
            children: [
              {
                kind: "file",
                name: "app.ts",
                path: "src/app.ts",
              },
            ],
            kind: "directory",
            name: "src",
            path: "src",
          },
        ],
      },
    }));

    await store.getState().sendPrompt("Update the app constant.");

    const deletedThreadId = store.getState().currentThreadId;

    if (!deletedThreadId) {
      throw new Error("Expected an active thread to exist.");
    }

    await store.getState().deleteThread(deletedThreadId);

    const persistedThreads = await database.threads.toArray();
    const backups = await database.write_backups.toArray();
    const state = store.getState();

    expect(state.threads).toHaveLength(1);
    expect(state.threads[0]?.id).not.toBe(deletedThreadId);
    expect(state.currentThreadId).toBe(state.threads[0]?.id ?? null);
    expect(state.workspace.diff).toBeNull();
    expect(backups).toHaveLength(0);
    expect(
      persistedThreads.some((thread) => thread.id === deletedThreadId),
    ).toBe(false);
  });

  it("persists and clears the model cache folder preference", async () => {
    const database = new AppDatabase(`web-bro-test-${crypto.randomUUID()}`);
    const { runtime } = createMockRuntime({
      "src/app.ts": "export const app = 'initial';\n",
    });
    const modelHandle = createFakeHandle("models");
    const store = createAppStore({
      capabilityReport: {
        hasDirectoryPicker: true,
        hasWebGPU: true,
        isChromium: true,
        isSecureContext: true,
        reasons: [],
        supported: true,
      },
      database,
      runtime,
    });

    await store.getState().initialize();
    vi.spyOn(modelHandle, "requestPermission");
    const putSpy = vi
      .spyOn(database.model_cache_sessions, "put")
      .mockResolvedValue("active");
    const deleteSpy = vi
      .spyOn(database.model_cache_sessions, "delete")
      .mockResolvedValue(undefined);

    const originalPicker = window.showDirectoryPicker;
    window.showDirectoryPicker = vi.fn(async () => modelHandle);

    try {
      await store.getState().connectModelCacheFolder();
    } finally {
      window.showDirectoryPicker = originalPicker;
    }

    expect(store.getState().modelCache.folderName).toBe("models");
    expect(runtime.llm.configureModelCache).toHaveBeenCalled();
    expect(putSpy).toHaveBeenCalledTimes(1);

    await store.getState().clearModelCacheFolder();

    expect(store.getState().modelCache.configured).toBe(false);
    expect(deleteSpy).toHaveBeenCalledWith("active");
  });
});
