import { describe, expect, it, vi } from "vitest";

import { createAppStore } from "../app/store";
import type {
  AgentDecision,
  GenerateRawTextRequest,
  GenerateRawTextResult,
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
import type { AutoProcessor } from "@huggingface/transformers";
import {
  normalizeDecision,
  renderGenerationPrompt,
} from "../workers/llm.worker";

function createMockProcessor(): Awaited<
  ReturnType<typeof AutoProcessor.from_pretrained>
> {
  return {
    apply_chat_template(
      messages: { role: string; content: unknown }[],
      options: { add_generation_prompt?: boolean },
    ): string {
      const rendered = messages
        .map((m) => `<start_of_turn>${m.role}\n${m.content}<end_of_turn>`)
        .join("\n");
      return options?.add_generation_prompt
        ? `${rendered}\n<start_of_turn>model\n`
        : rendered;
    },
    tokenizer: {},
  } as unknown as Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
}

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
  const rawPrompts: string[] = [];
  const renderedDebugPrompts: GenerateTurnRequest["conversation"][] = [];
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
      renderDebugPrompt: vi.fn(async (messages) => {
        renderedDebugPrompts.push(messages);
        return "native debug prompt";
      }),
      generateRawText: vi.fn(
        async (
          request: GenerateRawTextRequest,
          onStream?: (chunk: { type: "text"; text: string }) => void,
        ): Promise<GenerateRawTextResult> => {
          rawPrompts.push(request.prompt);
          onStream?.({
            type: "text",
            text: "raw stream",
          });
          return {
            output: "raw stream",
            prompt: request.prompt,
          };
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
              "<bos><start_of_turn>developer\nmock<end_of_turn><start_of_turn>model\n",
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

  return { files, rawPrompts, renderedDebugPrompts, runtime };
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
            "<bos><start_of_turn>developer\nmock<end_of_turn><start_of_turn>model\n",
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
              "<bos><start_of_turn>developer\nmock<end_of_turn><start_of_turn>model\n",
          };
        }

        return {
          decision: {
            type: "final",
            message: "done",
          },
          prompt:
            "<bos><start_of_turn>developer\nmock<end_of_turn><start_of_turn>model\n",
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
        content: "",
        tool_calls: [
          {
            name: "read_file",
            arguments: {
              path: "src/app.ts",
            },
          },
        ],
      },
      {
        role: "tool",
        content:
          '{"detail":"src/app.ts\\n\\nexport const app = \'initial\';\\n","ok":true,"summary":"Read src/app.ts."}',
      },
    ]);
  });

  it("retries malformed tool json by replaying assistant output and tool error", async () => {
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
              type: "error",
              message:
                "Function call requested but no valid JSON object was found.",
              raw: '<start_function_call>call:write_file{"path":"hi.txt","content":"Hi! ..."<end_function_call>',
            },
            prompt:
              "<bos><start_of_turn>developer\nmock<end_of_turn><start_of_turn>model\n",
          };
        }

        return {
          decision: {
            type: "final",
            message: "done",
          },
          prompt:
            "<bos><start_of_turn>developer\nmock<end_of_turn><start_of_turn>model\n",
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
        tree: [],
      },
    }));

    await store.getState().sendPrompt("hi intro urself in hi.txt :)");

    expect(requests).toHaveLength(2);
    expect(requests[1]?.conversation).toEqual([
      {
        role: "user",
        content: "hi intro urself in hi.txt :)",
      },
      {
        role: "assistant",
        content:
          '<start_function_call>call:write_file{"path":"hi.txt","content":"Hi! ..."<end_function_call>',
      },
      {
        role: "system",
        content:
          "Your previous response was invalid: Function call requested but no valid JSON object was found. Return either plain text or a valid tool call.",
      },
    ]);
  });

  it("retries fully malformed output by replaying assistant output and system correction", async () => {
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
              type: "error",
              message: "Unknown function call: write_filex.",
              raw: '<start_function_call>call:write_filex{"path":"hi.txt","content":"Hi!"}<end_function_call>',
            },
            prompt:
              "<bos><start_of_turn>developer\nmock<end_of_turn><start_of_turn>model\n",
          };
        }

        return {
          decision: {
            type: "final",
            message: "done",
          },
          prompt:
            "<bos><start_of_turn>developer\nmock<end_of_turn><start_of_turn>model\n",
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
        tree: [],
      },
    }));

    await store.getState().sendPrompt("hi intro urself in hi.txt :)");

    expect(requests).toHaveLength(2);
    expect(requests[1]?.conversation).toEqual([
      {
        role: "user",
        content: "hi intro urself in hi.txt :)",
      },
      {
        role: "assistant",
        content:
          '<start_function_call>call:write_filex{"path":"hi.txt","content":"Hi!"}<end_function_call>',
      },
      {
        role: "system",
        content:
          "Your previous response was invalid: Unknown function call: write_filex. Return either plain text or a valid tool call.",
      },
    ]);
  });

  it("continues incomplete tool calls across turns until end tag arrives", async () => {
    const database = new AppDatabase(`web-bro-test-${crypto.randomUUID()}`);
    const { files, runtime } = createMockRuntime({});
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
              type: "incomplete",
              partial:
                '<start_function_call>call:write_file{"path":"poem.txt","content":"hello',
              raw: '<start_function_call>call:write_file{"path":"poem.txt","content":"hello',
            },
            prompt:
              "<bos><start_of_turn>developer\nmock<end_of_turn><start_of_turn>model\n",
          };
        }

        return {
          decision: {
            type: "tool",
            tool: "write_file",
            args: {
              path: "poem.txt",
              content: "hello world",
            },
            raw: '<start_function_call>call:write_file{"path":"poem.txt","content":"hello world"}<end_function_call>',
          },
          prompt:
            '<bos><start_of_turn>developer\nmock<end_of_turn><start_of_turn>user\nwrite a poem in poem.txt for me<end_of_turn><start_of_turn>model\n<start_function_call>call:write_file{"path":"poem.txt","content":"hello',
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
        summary: 'Workspace "workspace" has 0 files.',
        tree: [],
      },
    }));

    await store.getState().sendPrompt("write a poem in poem.txt for me");

    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[1]?.conversation).toEqual([
      {
        role: "user",
        content: "write a poem in poem.txt for me",
      },
      {
        role: "assistant",
        content:
          '<start_function_call>call:write_file{"path":"poem.txt","content":"hello',
      },
    ]);
    expect(requests[1]?.partialOutput).toBe(
      '<start_function_call>call:write_file{"path":"poem.txt","content":"hello',
    );
    expect(files.get("poem.txt")?.content).toBe("hello world");
  });

  it("continues Gemma partial output without reopening an assistant block", () => {
    const partialOutput =
      '<|tool_call>call:write_file{path:<|"|>poem.txt<|"|>content:<|"|>hello';
    const processor = createMockProcessor();
    const prompt = renderGenerationPrompt(processor, {
      conversation: [
        {
          role: "user",
          content: "write a poem.txt for me",
        },
        {
          role: "assistant",
          content: partialOutput,
        },
      ],
      workspaceSummary: null,
      agentNotes: [],
      partialOutput,
    });

    expect(prompt).toContain(partialOutput);
    // Partial should be appended after the generation prompt, not closed in an assistant block
    expect(prompt).not.toContain(`${partialOutput}<end_of_turn>`);
    // The partial content from the last assistant message should not be rendered inside messages
    // (it should only appear as a raw suffix after the generation prompt)
    expect(prompt).not.toContain(
      `<start_of_turn>assistant\n${partialOutput}`,
    );
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

  it("renders structured debug entries with the Gemma template", async () => {
    const database = new AppDatabase(`web-bro-test-${crypto.randomUUID()}`);
    const { renderedDebugPrompts, runtime } = createMockRuntime({});
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
    const firstEntryId = store.getState().debug.entries[0]?.id;

    if (!firstEntryId) {
      throw new Error("Expected an initial debug entry.");
    }

    store.getState().setDebugMode("structured");
    store.getState().setDebugEntryRole(firstEntryId, "system");
    store.getState().setDebugEntryContent(firstEntryId, "You are terse.");
    store.getState().addDebugEntry();

    const secondEntryId = store.getState().debug.entries[1]?.id;

    if (!secondEntryId) {
      throw new Error("Expected a second debug entry.");
    }

    store.getState().setDebugEntryRole(secondEntryId, "user");
    store.getState().setDebugEntryContent(secondEntryId, "Hello");
    await store.getState().parseDebugPrompt();

    expect(renderedDebugPrompts).toEqual([
      [
        {
          role: "system",
          content: "You are terse.",
        },
        {
          role: "user",
          content: "Hello",
        },
      ],
    ]);
    expect(store.getState().debug.prompt).toBe("native debug prompt");
    expect(store.getState().debug.mode).toBe("raw");
  });

  it("sends the exact raw debug prompt and stores streamed output", async () => {
    const database = new AppDatabase(`web-bro-test-${crypto.randomUUID()}`);
    const { rawPrompts, runtime } = createMockRuntime({});
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
    store
      .getState()
      .setDebugPrompt(
        "<bos><start_of_turn>user\nHello<end_of_turn><start_of_turn>model\n",
      );

    await store.getState().sendDebugPrompt();

    expect(rawPrompts).toEqual([
      "<bos><start_of_turn>user\nHello<end_of_turn><start_of_turn>model\n",
    ]);
    expect(store.getState().debug.output).toBe("raw stream");
    expect(runtime.llm.generateTurn).not.toHaveBeenCalled();
  });

  it("parses a Gemma tool call", () => {
    expect(
      normalizeDecision(
        '<|tool_call>call:read_file{path:<|"|>src/app.ts<|"|>}<tool_call|>',
      ),
    ).toEqual({
      type: "tool",
      tool: "read_file",
      args: {
        path: "src/app.ts",
      },
      raw: '<|tool_call>call:read_file{path:<|"|>src/app.ts<|"|>}<tool_call|>',
    });
  });

  it("parses plain text as a final response", () => {
    expect(normalizeDecision("done")).toEqual({
      type: "final",
      message: "done",
      raw: "done",
    });
  });

  it("returns incomplete for a truncated Gemma tool call", () => {
    expect(
      normalizeDecision(
        '<|tool_call>call:write_file{path:<|"|>a.txt<|"|>',
      ),
    ).toEqual({
      type: "incomplete",
      partial: '<|tool_call>call:write_file{path:<|"|>a.txt<|"|>',
      raw: '<|tool_call>call:write_file{path:<|"|>a.txt<|"|>',
    });
  });

  it("rejects Gemma tool call with missing required arguments", () => {
    expect(
      normalizeDecision(
        '<|tool_call>call:write_file{path:<|"|>a.txt<|"|>}<tool_call|>',
      ),
    ).toEqual({
      type: "error",
      message: "Function call arguments must be a JSON object.",
      raw: '<|tool_call>call:write_file{path:<|"|>a.txt<|"|>}<tool_call|>',
    });
  });

  it("rejects unknown Gemma function names", () => {
    expect(
      normalizeDecision(
        '<|tool_call>call:unknown_tool{path:<|"|>a.txt<|"|>}<tool_call|>',
      ),
    ).toEqual({
      type: "error",
      message: "Unknown function call: unknown_tool.",
      raw: '<|tool_call>call:unknown_tool{path:<|"|>a.txt<|"|>}<tool_call|>',
    });
  });
});
