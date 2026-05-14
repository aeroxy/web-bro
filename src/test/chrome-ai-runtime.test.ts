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

  it("preserves message roles when the last pending message isn't a user turn", async () => {
    let capturedInput: unknown = null;
    const session: MockSession = {
      destroy: vi.fn(),
      prompt: vi.fn(),
      promptStreaming: vi.fn((input: unknown) => {
        capturedInput = input;
        return streamFromChunks([
          JSON.stringify({ kind: "final", message: "ok" }),
        ]);
      }),
    };
    (
      globalThis as unknown as { LanguageModel: MockLanguageModel }
    ).LanguageModel = {
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => session),
    } satisfies MockLanguageModel;

    const backend = createChromeAIBackend();
    // Conversation ending in an assistant tool_call — toPromptInputMessages
    // synthesizes a {role:"assistant"} turn from it. Cold rebuild slices off
    // the last entry as `pending`. If we collapsed to a string we'd flip
    // that turn into a user prompt and confuse the model.
    await backend.generateTurn({
      conversation: [
        { role: "user", content: "list src" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ name: "list_dir", arguments: { path: "src" } }],
        },
      ],
      workspaceSummary: "ws",
    });

    // Must be passed as a structured array, not a bare string, so the role
    // survives the round-trip into the Chrome session.
    expect(typeof capturedInput).not.toBe("string");
    expect(Array.isArray(capturedInput)).toBe(true);
    const arr = capturedInput as { role: string; content: string }[];
    expect(arr).toHaveLength(1);
    expect(arr[0]?.role).toBe("assistant");
  });

  it("renderDebugPrompt mirrors what generateTurn actually sends", async () => {
    installLanguageModel("available", "");
    const backend = createChromeAIBackend();
    const debugJson = await backend.renderDebugPrompt([
      { role: "user", content: "hello" },
    ]);
    const debug = JSON.parse(debugJson) as {
      backend: string;
      systemPrompt: string;
      messages: unknown;
      responseConstraint: { oneOf: unknown[] };
    };
    expect(debug.backend).toBe("chrome-ai");
    // Must include the chrome-specific format addendum so devs see the actual
    // instructions the model receives, not just the shared base persona.
    expect(debug.systemPrompt).toContain("RESPONSE FORMAT");
    expect(debug.systemPrompt).toContain('"kind":"final"');
    expect(debug.systemPrompt).toContain('User: "hello"');
    // And the JSON schema constraint that shapes the output.
    expect(debug.responseConstraint.oneOf.length).toBeGreaterThan(1);
  });

  it("model cache stubs report 'Managed by Chrome.'", async () => {
    installLanguageModel("available", "");
    const backend = createChromeAIBackend();
    const status = await backend.getModelCacheStatus();
    expect(status.detail).toBe("Managed by Chrome.");
    expect(status.configured).toBe(false);
    expect(status.source).toBe(null);
  });

  it("forwards delta-mode stream chunks unchanged and concatenates them", async () => {
    const finalJson = JSON.stringify({ kind: "final", message: "Hi there!" });
    // Split the JSON into three deltas; none extends the previous as a prefix.
    const chunks = [
      finalJson.slice(0, 5),
      finalJson.slice(5, 20),
      finalJson.slice(20),
    ];
    const session: MockSession = {
      destroy: vi.fn(),
      prompt: vi.fn(),
      promptStreaming: vi.fn(() => streamFromChunks(chunks)),
    };
    (
      globalThis as unknown as { LanguageModel: MockLanguageModel }
    ).LanguageModel = {
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => session),
    } satisfies MockLanguageModel;

    const backend = createChromeAIBackend();
    const observed: string[] = [];
    const result = await backend.generateTurn(baseRequest, (chunk) => {
      observed.push(chunk.text);
    });
    expect(observed).toEqual(chunks);
    expect(result.decision.type).toBe("final");
  });

  it("emits only the delta for cumulative-mode streams", async () => {
    const finalJson = JSON.stringify({ kind: "final", message: "Hi there!" });
    // Cumulative: each chunk is the running total.
    const chunks = [finalJson.slice(0, 5), finalJson.slice(0, 20), finalJson];
    const session: MockSession = {
      destroy: vi.fn(),
      prompt: vi.fn(),
      promptStreaming: vi.fn(() => streamFromChunks(chunks)),
    };
    (
      globalThis as unknown as { LanguageModel: MockLanguageModel }
    ).LanguageModel = {
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => session),
    } satisfies MockLanguageModel;

    const backend = createChromeAIBackend();
    const observed: string[] = [];
    const result = await backend.generateTurn(baseRequest, (chunk) => {
      observed.push(chunk.text);
    });
    expect(observed.join("")).toBe(finalJson);
    expect(observed[0]).toBe(finalJson.slice(0, 5));
    expect(observed[1]).toBe(finalJson.slice(5, 20));
    expect(observed[2]).toBe(finalJson.slice(20));
    expect(result.decision.type).toBe("final");
  });

  it("does not duplicate text when a cumulative stream replaces its state mid-flight", async () => {
    const finalJson = JSON.stringify({ kind: "final", message: "Corrected." });
    // First two chunks look cumulative, then the model "rewrites" and emits a
    // fresh snapshot that no longer extends the previous value.
    const chunks = [
      "abc",
      "abcdef",
      finalJson, // does not start with "abcdef"
    ];
    const session: MockSession = {
      destroy: vi.fn(),
      prompt: vi.fn(),
      promptStreaming: vi.fn(() => streamFromChunks(chunks)),
    };
    (
      globalThis as unknown as { LanguageModel: MockLanguageModel }
    ).LanguageModel = {
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => session),
    } satisfies MockLanguageModel;

    const backend = createChromeAIBackend();
    const observed: StreamChunk[] = [];
    const result = await backend.generateTurn(baseRequest, (chunk) => {
      observed.push(chunk);
    });

    // Final decision reflects the corrected snapshot, NOT "abcdef" + finalJson.
    expect(result.decision.type).toBe("final");
    if (result.decision.type === "final") {
      expect(result.decision.message).toBe("Corrected.");
    }

    // A reset chunk must be emitted so consumers can drop the stale text and
    // re-sync — otherwise the UI would show "abcdef" plus future deltas of
    // the corrected value, diverging from the parsed decision.
    const resetChunk = observed.find((c) => c.type === "reset");
    expect(resetChunk).toBeDefined();
    expect(resetChunk?.text).toBe(finalJson);

    // Reconstruct what a "reset-aware" consumer would render and check it
    // matches the parsed full text.
    let rendered = "";
    for (const c of observed) {
      if (c.type === "reset") rendered = c.text;
      else if (c.type === "text") rendered += c.text;
    }
    expect(rendered).toBe(finalJson);
  });

  it("reuses the cached session across turns when the conversation extends a prefix", async () => {
    const create = vi.fn();
    const promptStreaming = vi.fn();
    const sessionDestroy = vi.fn();
    const session: MockSession = {
      destroy: sessionDestroy,
      prompt: vi.fn(),
      promptStreaming,
    };
    create.mockResolvedValue(session);
    promptStreaming
      .mockReturnValueOnce(
        streamFromChunks([
          JSON.stringify({
            kind: "list_dir",
            arguments: { path: "src" },
          }),
        ]),
      )
      .mockReturnValueOnce(
        streamFromChunks([JSON.stringify({ kind: "final", message: "Done." })]),
      );
    (
      globalThis as unknown as { LanguageModel: MockLanguageModel }
    ).LanguageModel = {
      availability: vi.fn(async () => "available"),
      create,
    } satisfies MockLanguageModel;

    const backend = createChromeAIBackend();

    // Turn 1: user asks "list src".
    await backend.generateTurn({
      conversation: [{ role: "user", content: "list src" }],
      workspaceSummary: "ws",
    });

    // Turn 2: store appends [assistant tool call, tool result] to thread; the
    // conversation grows but its user-side prefix still starts with "list src".
    await backend.generateTurn({
      conversation: [
        { role: "user", content: "list src" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ name: "list_dir", arguments: { path: "src" } }],
        },
        { role: "tool", content: '{"ok":true,"summary":"ok"}' },
      ],
      workspaceSummary: "ws",
    });

    // Only ONE session created across the two turns — the second turn reused.
    expect(create).toHaveBeenCalledTimes(1);
    // promptStreaming called twice — once per turn.
    expect(promptStreaming).toHaveBeenCalledTimes(2);
    // The second prompt() call should pass only the new tool-result message,
    // not the full conversation.
    const secondPromptInput = promptStreaming.mock.calls[1]?.[0];
    expect(typeof secondPromptInput).toBe("string");
    expect(String(secondPromptInput)).toContain("Tool result:");
    expect(String(secondPromptInput)).not.toContain("list src");
  });

  it("rebuilds the session when the system prompt changes (workspace summary changed)", async () => {
    const create = vi.fn();
    const session: MockSession = {
      destroy: vi.fn(),
      prompt: vi.fn(),
      promptStreaming: vi.fn(() =>
        streamFromChunks([JSON.stringify({ kind: "final", message: "ok" })]),
      ),
    };
    create.mockResolvedValue(session);
    (
      globalThis as unknown as { LanguageModel: MockLanguageModel }
    ).LanguageModel = {
      availability: vi.fn(async () => "available"),
      create,
    } satisfies MockLanguageModel;

    const backend = createChromeAIBackend();

    await backend.generateTurn({
      conversation: [{ role: "user", content: "hello" }],
      workspaceSummary: 'Workspace "demo" has 1 file.',
    });
    await backend.generateTurn({
      conversation: [{ role: "user", content: "hello" }],
      workspaceSummary: 'Workspace "demo" has 99 files.',
    });

    // Both turns spawned their own session because the system prompt embeds
    // the workspace summary.
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("rebuilds when the conversation prefix no longer matches (thread switch)", async () => {
    const create = vi.fn();
    const session: MockSession = {
      destroy: vi.fn(),
      prompt: vi.fn(),
      promptStreaming: vi.fn(() =>
        streamFromChunks([JSON.stringify({ kind: "final", message: "ok" })]),
      ),
    };
    create.mockResolvedValue(session);
    (
      globalThis as unknown as { LanguageModel: MockLanguageModel }
    ).LanguageModel = {
      availability: vi.fn(async () => "available"),
      create,
    } satisfies MockLanguageModel;

    const backend = createChromeAIBackend();

    await backend.generateTurn({
      conversation: [{ role: "user", content: "first thread message" }],
      workspaceSummary: "ws",
    });
    // Switch threads — entirely different first message.
    await backend.generateTurn({
      conversation: [{ role: "user", content: "different thread entirely" }],
      workspaceSummary: "ws",
    });

    expect(create).toHaveBeenCalledTimes(2);
  });

  it("invalidates the cache after abortGeneration so the next turn rebuilds", async () => {
    const create = vi.fn();
    const session: MockSession = {
      destroy: vi.fn(),
      prompt: vi.fn(),
      promptStreaming: vi.fn(() =>
        streamFromChunks([JSON.stringify({ kind: "final", message: "ok" })]),
      ),
    };
    create.mockResolvedValue(session);
    (
      globalThis as unknown as { LanguageModel: MockLanguageModel }
    ).LanguageModel = {
      availability: vi.fn(async () => "available"),
      create,
    } satisfies MockLanguageModel;

    const backend = createChromeAIBackend();

    await backend.generateTurn({
      conversation: [{ role: "user", content: "hi" }],
      workspaceSummary: "ws",
    });
    await backend.abortGeneration();
    await backend.generateTurn({
      conversation: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ name: "list_dir", arguments: { path: "." } }],
        },
        { role: "tool", content: "ok" },
      ],
      workspaceSummary: "ws",
    });

    expect(create).toHaveBeenCalledTimes(2);
  });

  it("releases the stream reader lock even when the consumer callback throws", async () => {
    const stream = streamFromChunks([
      JSON.stringify({ kind: "final", message: "ok" }),
    ]);
    const session: MockSession = {
      destroy: vi.fn(),
      prompt: vi.fn(),
      promptStreaming: vi.fn(() => stream),
    };
    (
      globalThis as unknown as { LanguageModel: MockLanguageModel }
    ).LanguageModel = {
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => session),
    } satisfies MockLanguageModel;

    const backend = createChromeAIBackend();
    await expect(
      backend.generateTurn(baseRequest, () => {
        throw new Error("consumer blew up");
      }),
    ).rejects.toThrow("consumer blew up");

    // If the reader lock leaked we couldn't reacquire it. getReader() throws
    // TypeError "ReadableStream is locked" when called on a still-locked
    // stream, so a successful second call proves the finally{} released it.
    expect(() => stream.getReader()).not.toThrow();
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
