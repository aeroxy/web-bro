import {
  AutoTokenizer,
  env,
  InterruptableStoppingCriteria,
  Qwen3_5ForConditionalGeneration,
  TextStreamer,
} from "@huggingface/transformers";
import { expose } from "comlink";

import type {
  AgentDecision,
  AgentFinalResponse,
  GenerateTurnRequest,
  ModelCacheSource,
  ModelCacheStatus,
  ModelStatus,
  ModelWorkerAPI,
  StreamChunk,
  StreamListener,
} from "../lib/contracts";
import { extractFirstJsonObject, promptRequestsFileWrite } from "../lib/text";

const MODEL_ID = "onnx-community/Qwen3.5-0.8B-ONNX";
const DEBUG_PREFIX = "[Web Bro][LLM]";
const interruptCriteria = new InterruptableStoppingCriteria();
const TOKENIZER_PROGRESS_SHARE = 0.12;
const FOLDER_PREFIX = "huggingface.co";
const MODEL_FILES = [
  "config.json",
  "generation_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "chat_template.json",
  "special_tokens_map.json",
  "onnx/decoder_model_merged_q4.onnx",
  "onnx/embed_tokens_q4.onnx",
  "onnx/vision_encoder_q4.onnx",
] as const;

let tokenizerPromise: Promise<
  Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>
> | null = null;
let modelPromise: Promise<
  Awaited<ReturnType<typeof Qwen3_5ForConditionalGeneration.from_pretrained>>
> | null = null;
let status: ModelStatus = {
  phase: "idle",
  detail: "Model idle.",
};
let lastLoadingLogBucket = -1;
let activeCacheSource: ModelCacheSource | null = null;
let modelCacheFolder: FileSystemDirectoryHandle | null = null;
let modelCachePermission: PermissionState | "unknown" = "unknown";
let modelCacheDownloadBytes = 0;
let browserCachePromise: Promise<Cache | null> | null = null;

function setStatus(next: ModelStatus): void {
  status = next;
}

function debugLog(message: string, meta?: unknown): void {
  if (meta === undefined) {
    console.debug(DEBUG_PREFIX, message);
    return;
  }

  console.debug(DEBUG_PREFIX, message, meta);
}

function previewText(value: string, maxLength = 320): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function resetLoadingDebugState(): void {
  lastLoadingLogBucket = -1;
}

function resetLoadedModel(): void {
  tokenizerPromise = null;
  modelPromise = null;
}

type LoadingProgressEvent = {
  file?: string;
  progress?: number;
  status?: string;
};

function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, progress));
}

function setActiveCacheSource(source: ModelCacheSource): void {
  activeCacheSource = source;
}

function scaleProgress(
  progress: number | undefined,
  start: number,
  end: number,
): number {
  const normalized = clampProgress(progress ?? 0);
  return start + (end - start) * (normalized / 100);
}

function toFileLabel(file?: string): string | null {
  if (!file) {
    return null;
  }

  const segments = file.split("/");
  return segments.at(-1) ?? file;
}

function updateLoadingStatus(
  stage: "tokenizer" | "model",
  event?: LoadingProgressEvent,
): void {
  const [start, end] =
    stage === "tokenizer"
      ? [0, TOKENIZER_PROGRESS_SHARE * 100]
      : [TOKENIZER_PROGRESS_SHARE * 100, 100];
  const label =
    stage === "tokenizer"
      ? "Preparing tokenizer assets"
      : "Downloading model weights";
  const fileLabel = toFileLabel(event?.file);
  const progress =
    event?.status === "done" ? end : scaleProgress(event?.progress, start, end);
  const detail =
    typeof event?.progress === "number"
      ? `${label}${fileLabel ? ` (${fileLabel})` : ""} (${Math.round(progress)}%).`
      : `${label}${fileLabel ? ` (${fileLabel})` : ""}.`;

  setStatus({
    phase: "loading",
    detail,
    progress: clampProgress(progress),
  });

  const bucket = Math.floor(clampProgress(progress) / 10);

  if (bucket !== lastLoadingLogBucket) {
    lastLoadingLogBucket = bucket;
    debugLog("model load progress", {
      file: fileLabel,
      progress: Math.round(progress),
      stage,
      status: event?.status,
    });
  }
}

function normalizeKey(request: string): string {
  return request.replace(/^https?:\/\//, "");
}

function toFolderPath(request: string): string {
  const url = new URL(request);
  return `${FOLDER_PREFIX}${url.pathname}`;
}

async function getBrowserCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") {
    return null;
  }

  if (!browserCachePromise) {
    browserCachePromise = caches.open(env.cacheKey).catch(() => null);
  }

  return browserCachePromise;
}

async function queryFolderPermission(
  handle: FileSystemDirectoryHandle | null,
): Promise<PermissionState | "unknown"> {
  if (!handle) {
    return "unknown";
  }

  try {
    return await handle.queryPermission({
      mode: "readwrite",
      name: "file-system",
    });
  } catch {
    return "unknown";
  }
}

async function getDirectoryHandleAtPath(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  const segments = path.split("/").filter(Boolean);
  let current = root;

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, {
      create,
    });
  }

  return current;
}

async function readFolderFile(relativePath: string): Promise<File | null> {
  if (!modelCacheFolder || modelCachePermission !== "granted") {
    return null;
  }

  const segments = relativePath.split("/").filter(Boolean);
  const fileName = segments.pop();

  if (!fileName) {
    return null;
  }

  try {
    const directory = await getDirectoryHandleAtPath(
      modelCacheFolder,
      segments.join("/"),
      false,
    );
    const fileHandle = await directory.getFileHandle(fileName);
    return await fileHandle.getFile();
  } catch {
    return null;
  }
}

async function writeFolderFile(
  relativePath: string,
  response: Response,
): Promise<Response> {
  if (!modelCacheFolder || modelCachePermission !== "granted") {
    return response;
  }

  const payload = await response.arrayBuffer();
  const segments = relativePath.split("/").filter(Boolean);
  const fileName = segments.pop();

  if (!fileName) {
    return response;
  }

  const directory = await getDirectoryHandleAtPath(
    modelCacheFolder,
    segments.join("/"),
    true,
  );
  const fileHandle = await directory.getFileHandle(fileName, {
    create: true,
  });
  const writer = await fileHandle.createWritable();

  try {
    await writer.write(payload);
    await writer.close();
  } catch (error) {
    await writer.abort();
    throw error;
  }

  modelCacheDownloadBytes += payload.byteLength;
  debugLog("cache:folder-write", {
    bytes: payload.byteLength,
    path: relativePath,
  });

  return new Response(payload.slice(0), {
    headers: new Headers(response.headers),
    status: response.status,
    statusText: response.statusText,
  });
}

async function isManifestComplete(): Promise<boolean> {
  if (!modelCacheFolder || modelCachePermission !== "granted") {
    return false;
  }

  for (const file of MODEL_FILES) {
    const relativePath = `${MODEL_ID}/resolve/main/${file}`;
    const resolved = await readFolderFile(`${FOLDER_PREFIX}/${relativePath}`);

    if (!resolved) {
      return false;
    }
  }

  return true;
}

function buildCacheStatus(detail = "Browser cache only."): ModelCacheStatus {
  return {
    configured: modelCacheFolder !== null,
    detail,
    downloadBytes: modelCacheDownloadBytes || undefined,
    folderName: modelCacheFolder?.name ?? null,
    isReady:
      activeCacheSource === "folder"
        ? true
        : modelCacheFolder !== null && modelCachePermission === "granted",
    manifestComplete: false,
    permission: modelCachePermission,
    source: activeCacheSource,
  };
}

const folderBackedCache = {
  async match(request: string) {
    const cacheKey = normalizeKey(request);
    const folderPath = toFolderPath(request);
    const folderFile = await readFolderFile(folderPath);

    if (folderFile) {
      setActiveCacheSource("folder");
      debugLog("cache:folder-hit", {
        path: folderPath,
      });
      return new Response(await folderFile.arrayBuffer(), {
        headers: new Headers({
          "content-length": String(folderFile.size),
          "content-type": folderFile.type || "application/octet-stream",
        }),
        status: 200,
      });
    }

    const browserCache = await getBrowserCache();
    const browserResponse = browserCache
      ? await browserCache.match(cacheKey)
      : undefined;

    if (browserResponse) {
      setActiveCacheSource("browser-cache");
      debugLog("cache:browser-hit", {
        key: cacheKey,
      });
      return browserResponse;
    }

    return undefined;
  },
  async put(request: string, response: Response) {
    const cacheKey = normalizeKey(request);
    let nextResponse = response;

    if (modelCacheFolder && modelCachePermission === "granted") {
      setActiveCacheSource("network");
      nextResponse = await writeFolderFile(toFolderPath(request), response);
    }

    const browserCache = await getBrowserCache();

    if (browserCache) {
      await browserCache.put(cacheKey, nextResponse.clone());
    }
  },
};

function loadTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = AutoTokenizer.from_pretrained(MODEL_ID, {
      progress_callback(info) {
        updateLoadingStatus("tokenizer", info as LoadingProgressEvent);
      },
    }).catch((error) => {
      tokenizerPromise = null;
      throw error;
    });
  }

  return tokenizerPromise;
}

function loadModel() {
  if (!modelPromise) {
    modelPromise = Qwen3_5ForConditionalGeneration.from_pretrained(MODEL_ID, {
      device: "webgpu",
      dtype: {
        decoder_model_merged: "q4",
        embed_tokens: "q4",
        vision_encoder: "q4",
      },
      progress_callback(info) {
        updateLoadingStatus("model", info as LoadingProgressEvent);
      },
    }).catch((error) => {
      modelPromise = null;
      throw error;
    });
  }

  return modelPromise;
}

async function loadResources() {
  debugLog("loadResources:start", {
    device: "webgpu",
    modelId: MODEL_ID,
  });
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = folderBackedCache;
  modelCacheDownloadBytes = 0;
  activeCacheSource = null;

  const tokenizer = await loadTokenizer();
  debugLog("tokenizer:ready");

  setStatus({
    phase: "loading",
    detail: "Tokenizer ready. Preparing model weights.",
    progress: TOKENIZER_PROGRESS_SHARE * 100,
  });

  const model = await loadModel();
  debugLog("model:ready");
  setStatus({
    phase: "ready",
    detail:
      activeCacheSource === "folder"
        ? "Model ready on WebGPU from local folder cache."
        : activeCacheSource === "browser-cache"
          ? "Model ready on WebGPU from browser cache."
          : "Model ready on WebGPU.",
    progress: 100,
  });

  return { tokenizer, model };
}

function renderConversation(request: GenerateTurnRequest): string {
  const history =
    request.conversation.length > 0
      ? request.conversation
          .map(
            (message) =>
              `${message.role.toUpperCase()}: ${message.content.trim()}`,
          )
          .join("\n\n")
      : "No prior conversation.";

  const tools =
    request.toolResults.length > 0
      ? request.toolResults
          .map((result) =>
            [
              `Tool: ${result.tool}`,
              `Success: ${result.ok ? "yes" : "no"}`,
              `Summary: ${result.summary}`,
              result.detail ? `Detail:\n${result.detail}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n\n---\n\n")
      : "No tool results yet.";
  const agentNotes =
    request.agentNotes && request.agentNotes.length > 0
      ? request.agentNotes.map((note) => `- ${note}`).join("\n")
      : "No additional guidance.";

  return [
    `Current user request:\n${request.userInput}`,
    `Workspace summary:\n${request.workspaceSummary ?? "No workspace connected."}`,
    `Recent conversation:\n${history}`,
    `Tool results from this turn:\n${tools}`,
    `Agent guidance:\n${agentNotes}`,
  ].join("\n\n");
}

function buildMessages(request: GenerateTurnRequest) {
  const requiresWrite = promptRequestsFileWrite(request.userInput);
  const writeAttempted = request.toolResults.some(
    (result) => result.tool === "write_file",
  );

  if (request.mode === "decide") {
    return [
      {
        role: "system" as const,
        content: [
          "You are Web Bro, a coding assistant running fully inside a Chromium browser with no backend.",
          "You may only use these tools:",
          "- list_dir { path?: string } to inspect directory contents.",
          "- search_text { query: string } to find relevant text across the workspace.",
          "- read_file { path: string } to inspect a text file.",
          "- write_file { path: string, content: string } to create a text file or overwrite a file that was read earlier in this turn.",
          "Rules:",
          "- Existing files must be read with read_file earlier in this turn before write_file.",
          "- Prefer search_text when the right file is not obvious.",
          "- Use list_dir only when structure is missing.",
          "- When you have enough information, stop calling tools.",
          ...(requiresWrite && !writeAttempted
            ? [
                "- The user explicitly asked for a file creation or edit.",
                "- You must call write_file before returning a final response unless the task is impossible.",
                "- Never draft file contents in a final response when the user asked you to write them into the workspace.",
              ]
            : []),
          '- Reply with exactly one compact JSON object and no markdown. Valid shapes are {"type":"tool","tool":"search_text","args":{"query":"..."},"reason":"..."} or {"type":"final","message":"..."}.',
        ].join("\n"),
      },
      {
        role: "user" as const,
        content: renderConversation(request),
      },
    ];
  }

  return [
    {
      role: "system" as const,
      content: [
        "You are Web Bro, a concise local coding assistant.",
        "Respond to the user in plain language.",
        "Summarize what you changed or discovered.",
        "Mention written file paths when relevant.",
        "If you wrote a file, confirm the path and summarize the change instead of pasting the whole file unless the user asked to see it.",
        "Do not mention JSON, hidden tools, or internal protocol details.",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: renderConversation(request),
    },
  ];
}

function normalizeDecision(raw: string): AgentDecision {
  debugLog("decide:raw-output", {
    preview: previewText(raw),
  });
  const candidate = extractFirstJsonObject(raw);

  if (!candidate) {
    debugLog("decide:parse-miss");
    return {
      type: "final",
      message:
        "I could not produce a reliable tool plan from the local model output.",
    };
  }

  try {
    const parsed = JSON.parse(candidate) as AgentDecision;

    if (parsed.type === "tool" || parsed.type === "final") {
      debugLog("decide:parsed", {
        ...(parsed.type === "tool"
          ? parsed.tool === "write_file"
            ? {
                args: {
                  contentLength: parsed.args.content.length,
                  path: parsed.args.path,
                },
                reason: parsed.reason,
                tool: parsed.tool,
                type: parsed.type,
              }
            : parsed
          : {
              message: previewText(parsed.message),
              type: parsed.type,
            }),
      });
      return parsed;
    }
  } catch {
    debugLog("decide:parse-error", {
      candidate: previewText(candidate),
    });
    return {
      type: "final",
      message:
        "I could not parse the local model output into a valid agent action.",
    };
  }

  return {
    type: "final",
    message: "I could not determine the next step safely.",
  };
}

async function generateText(
  request: GenerateTurnRequest,
  onStream?: StreamListener,
): Promise<string> {
  debugLog("generate:start", {
    agentNotes: request.agentNotes?.length ?? 0,
    conversationMessages: request.conversation.length,
    mode: request.mode,
    toolResults: request.toolResults.length,
    userInput: previewText(request.userInput, 120),
  });
  const { tokenizer, model } = await loadResources();
  const messages = buildMessages(request);
  const prompt = tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    tokenize: false,
  });
  const inputs = tokenizer(prompt, {
    return_tensor: true,
  });
  const promptTokens = inputs.input_ids.dims.at(-1) ?? 0;
  debugLog("generate:prepared", {
    mode: request.mode,
    promptChars: String(prompt).length,
    promptTokens,
  });

  interruptCriteria.reset();
  setStatus({
    phase: "generating",
    detail:
      request.mode === "decide"
        ? "Planning the next tool step."
        : "Streaming the final response.",
    progress: 100,
  });

  let streamed = "";
  const streamer =
    onStream === undefined
      ? undefined
      : new TextStreamer(tokenizer, {
          callback_function(text) {
            streamed += text;
            onStream({
              type: "text",
              text,
            } satisfies StreamChunk);
          },
          skip_prompt: true,
          skip_special_tokens: true,
        });

  try {
    const output = await model.generate({
      ...inputs,
      do_sample: false,
      max_new_tokens: request.mode === "decide" ? 256 : 420,
      repetition_penalty: 1.05,
      stopping_criteria: [interruptCriteria],
      streamer,
      temperature: 0.15,
    });

    if (interruptCriteria.interrupted) {
      throw new Error("Generation interrupted.");
    }

    if (streamed.trim()) {
      debugLog("generate:stream-complete", {
        characters: streamed.trim().length,
        mode: request.mode,
      });
      setStatus({
        phase: "ready",
        detail: "Model ready on WebGPU.",
        progress: 100,
      });
      return streamed.trim();
    }

    const promptLength = inputs.input_ids.dims.at(-1) ?? 0;
    const sequences =
      "slice" in output
        ? output
        : (
            output as {
              sequences: typeof inputs.input_ids;
            }
          ).sequences;
    const decoded =
      tokenizer.batch_decode(sequences.slice(null, [promptLength, null]), {
        skip_special_tokens: true,
      })[0] ?? "";

    setStatus({
      phase: "ready",
      detail: "Model ready on WebGPU.",
      progress: 100,
    });

    debugLog("generate:complete", {
      characters: decoded.trim().length,
      mode: request.mode,
    });

    return decoded.trim();
  } catch (error) {
    if (error instanceof Error && error.message === "Generation interrupted.") {
      debugLog("generate:interrupted", {
        mode: request.mode,
      });
      setStatus({
        phase: "ready",
        detail: "Generation cancelled.",
        progress: 100,
      });
      throw error;
    }

    setStatus({
      phase: "error",
      detail: "Model generation failed.",
      error: error instanceof Error ? error.message : String(error),
      progress: undefined,
    });
    debugLog("generate:error", {
      error: error instanceof Error ? error.message : String(error),
      mode: request.mode,
    });
    throw error;
  }
}

const llmApi: ModelWorkerAPI = {
  async loadModel() {
    if (status.phase === "ready") {
      debugLog("loadModel:cache-hit");
      return status;
    }

    resetLoadingDebugState();
    debugLog("loadModel:start");
    setStatus({
      phase: "loading",
      detail: "Preparing tokenizer and model.",
      progress: 0,
    });

    try {
      await loadResources();
      debugLog("loadModel:complete");
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      setStatus({
        phase: "error",
        detail: "Model failed to load.",
        error: message,
        progress: undefined,
      });

      debugLog("loadModel:error", {
        error: message,
      });

      throw error;
    }
  },

  async configureModelCache(directoryHandle) {
    modelCacheFolder = directoryHandle;
    modelCachePermission = await queryFolderPermission(directoryHandle);
    modelCacheDownloadBytes = 0;
    activeCacheSource = null;
    resetLoadedModel();

    const manifestComplete = await isManifestComplete();
    const detail = !directoryHandle
      ? "Browser cache only."
      : modelCachePermission !== "granted"
        ? "Model folder selected, but permission must be reconnected."
        : manifestComplete
          ? "Model folder cache is ready."
          : "Model folder selected. Missing files will be downloaded on first load.";

    return {
      configured: directoryHandle !== null,
      detail,
      downloadBytes: undefined,
      folderName: directoryHandle?.name ?? null,
      isReady: manifestComplete,
      manifestComplete,
      permission: modelCachePermission,
      source: activeCacheSource,
    };
  },

  async generateTurn(request, onStream) {
    const output = await generateText(request, onStream);

    if (request.mode === "decide") {
      return normalizeDecision(output);
    }

    return {
      type: "final",
      message: output,
    } satisfies AgentFinalResponse;
  },

  async abortGeneration() {
    debugLog("abortGeneration");
    interruptCriteria.interrupt();
  },

  async clearModelCachePreference() {
    return await llmApi.configureModelCache(null);
  },

  async getModelCacheStatus() {
    const manifestComplete = await isManifestComplete();
    const detail = !modelCacheFolder
      ? "Browser cache only."
      : modelCachePermission !== "granted"
        ? "Model folder selected, but permission must be reconnected."
        : manifestComplete
          ? "Model folder cache is ready."
          : "Model folder is selected but still needs model files.";

    return {
      ...buildCacheStatus(detail),
      manifestComplete,
      isReady: manifestComplete,
    };
  },

  async getStatus() {
    return status;
  },
};

expose(llmApi);
