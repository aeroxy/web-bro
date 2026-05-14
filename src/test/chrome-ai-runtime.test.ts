import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GenerateTurnRequest, StreamChunk } from "../lib/contracts";
import { createChromeAIBackend } from "../services/chrome-ai-runtime";

type Availability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

interface MockSession {
  prompt: ReturnType<typeof vi.fn>;
  promptStreaming: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

interface MockLanguageModel {
  availability: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
}

function streamFromChunks(chunks: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function installLanguageModel(
  availability: Availability,
  promptResponse: string,
  options: { onCreate?: (opts: unknown) => void } = {},
): MockLanguageModel {
  const session: MockSession = {
    destroy: vi.fn(),
    prompt: vi.fn(async () => promptResponse),
    promptStreaming: vi.fn(() => streamFromChunks([promptResponse])),
  };
  const model: MockLanguageModel = {
    availability: vi.fn(async () => availability),
    create: vi.fn(async (opts: unknown) => {
      options.onCreate?.(opts);
      return session;
    }),
  };
  (
    globalThis as unknown as { LanguageModel: MockLanguageModel }
  ).LanguageModel = model;
  return model;
}

function uninstallLanguageModel(): void {
  delete (globalThis as unknown as { LanguageModel?: unknown }).LanguageModel;
}

const baseRequest: GenerateTurnRequest = {
  conversation: [{ role: "user", content: "List the workspace root." }],
  workspaceSummary: 'Workspace "demo" has 1 file.',
};

describe("createChromeAIBackend", () => {
  beforeEach(() => {
    uninstallLanguageModel();
  });

  afterEach(() => {
    uninstallLanguageModel();
  });

  it("loadModel reports ready when LanguageModel is available", async () => {
    installLanguageModel("available", "");
    const backend = createChromeAIBackend();
    const status = await backend.loadModel();
    expect(status.phase).toBe("ready");
  });

  it("loadModel throws and reports error when unavailable", async () => {
    installLanguageModel("unavailable", "");
    const backend = createChromeAIBackend();
    await expect(backend.loadModel()).rejects.toThrow();
    const status = await backend.getStatus();
    expect(status.phase).toBe("error");
  });

  it("generateTurn streams text deltas and parses a final decision", async () => {
    installLanguageModel(
      "available",
      JSON.stringify({ kind: "final", message: "All good." }),
    );
    const backend = createChromeAIBackend();
    const chunks: StreamChunk[] = [];
    const result = await backend.generateTurn(baseRequest, (chunk) => {
      chunks.push(chunk);
    });
    expect(chunks.map((c) => c.text).join("")).toContain("All good");
    expect(result.decision.type).toBe("final");
    if (result.decision.type === "final") {
      expect(result.decision.message).toBe("All good.");
    }
  });

  it("generateTurn parses a list_dir tool call", async () => {
    installLanguageModel(
      "available",
      JSON.stringify({
        kind: "list_dir",
        arguments: { path: "src" },
      }),
    );
    const backend = createChromeAIBackend();
    const result = await backend.generateTurn(baseRequest);
    expect(result.decision.type).toBe("tool");
    if (result.decision.type === "tool") {
      expect(result.decision.tool).toBe("list_dir");
      expect(result.decision.args).toEqual({ path: "src" });
    }
  });

  it("generateTurn parses a write_file tool call", async () => {
    installLanguageModel(
      "available",
      JSON.stringify({
        kind: "write_file",
        arguments: { path: "src/x.ts", content: "export const x = 1;\n" },
      }),
    );
    const backend = createChromeAIBackend();
    const result = await backend.generateTurn(baseRequest);
    expect(result.decision.type).toBe("tool");
    if (
      result.decision.type === "tool" &&
      result.decision.tool === "write_file"
    ) {
      expect(result.decision.args.path).toBe("src/x.ts");
      expect(result.decision.args.content).toBe("export const x = 1;\n");
    }
  });

  it("generateTurn returns an error decision for unknown tool kinds", async () => {
    installLanguageModel(
      "available",
      JSON.stringify({ kind: "delete_everything", arguments: {} }),
    );
    const backend = createChromeAIBackend();
    const result = await backend.generateTurn(baseRequest);
    expect(result.decision.type).toBe("error");
  });

  it("generateTurn returns an error decision for malformed JSON", async () => {
    installLanguageModel("available", "not-json");
    const backend = createChromeAIBackend();
    const result = await backend.generateTurn(baseRequest);
    expect(result.decision.type).toBe("error");
  });

  it("passes the system prompt and initial prompts to LanguageModel.create", async () => {
    let capturedOptions: unknown = null;
    installLanguageModel(
      "available",
      JSON.stringify({ kind: "final", message: "ok" }),
      {
        onCreate(options) {
          capturedOptions = options;
        },
      },
    );
    const backend = createChromeAIBackend();
    await backend.generateTurn({
      conversation: [
        { role: "user", content: "First message." },
        { role: "assistant", content: "Reply." },
        { role: "user", content: "Final message." },
      ],
      workspaceSummary: 'Workspace "demo" has 0 files.',
    });
    const opts = capturedOptions as {
      systemPrompt?: string;
      initialPrompts?: { role: string; content: string }[];
    };
    expect(opts.systemPrompt).toContain("Web Bro");
    expect(opts.systemPrompt).toContain("CURRENT WORKSPACE CONTEXT");
    expect(opts.initialPrompts).toHaveLength(2);
    expect(opts.initialPrompts?.at(-1)?.role).toBe("assistant");
  });

  it("abortGeneration aborts the in-flight request", async () => {
    let capturedSignal: AbortSignal | undefined;
    const session: MockSession = {
      destroy: vi.fn(),
      prompt: vi.fn(),
      promptStreaming: vi.fn((_input, options?: { signal?: AbortSignal }) => {
        capturedSignal = options?.signal;
        return new ReadableStream<string>({
          start(controller) {
            options?.signal?.addEventListener("abort", () => {
              controller.error(new Error("aborted"));
            });
          },
        });
      }),
    };
    (
      globalThis as unknown as { LanguageModel: MockLanguageModel }
    ).LanguageModel = {
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => session),
    } satisfies MockLanguageModel;

    const backend = createChromeAIBackend();
    const turnPromise = backend.generateTurn(baseRequest);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await backend.abortGeneration();
    await expect(turnPromise).rejects.toThrow();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("model cache stubs report 'Managed by Chrome.'", async () => {
    installLanguageModel("available", "");
    const backend = createChromeAIBackend();
    const status = await backend.getModelCacheStatus();
    expect(status.detail).toBe("Managed by Chrome.");
    expect(status.configured).toBe(false);
    expect(status.source).toBe(null);
  });

  it("destroy aborts in-flight work, destroys the session, and resets status", async () => {
    const sessionDestroy = vi.fn();
    let captured: AbortSignal | undefined;
    const session: MockSession = {
      destroy: sessionDestroy,
      prompt: vi.fn(),
      promptStreaming: vi.fn((_input, options?: { signal?: AbortSignal }) => {
        captured = options?.signal;
        return new ReadableStream<string>({
          start(controller) {
            options?.signal?.addEventListener("abort", () => {
              controller.error(new Error("aborted"));
            });
          },
        });
      }),
    };
    (
      globalThis as unknown as { LanguageModel: MockLanguageModel }
    ).LanguageModel = {
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => session),
    } satisfies MockLanguageModel;

    const backend = createChromeAIBackend();
    const turnPromise = backend.generateTurn(baseRequest);
    await new Promise((resolve) => setTimeout(resolve, 0));

    backend.destroy();

    await expect(turnPromise).rejects.toThrow();
    expect(captured?.aborted).toBe(true);
    expect(sessionDestroy).toHaveBeenCalled();
  });
});
