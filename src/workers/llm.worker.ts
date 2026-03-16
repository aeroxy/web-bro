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
  AgentToolName,
  GenerateRawTextResult,
  GenerateTurnRequest,
  GenerateTurnResult,
  ModelCacheSource,
  ModelCacheStatus,
  ModelStatus,
  ModelWorkerAPI,
  StreamChunk,
  StreamListener,
} from "../lib/contracts";
import { renderChatMl } from "../lib/chatml";
import { extractFirstJsonObject } from "../lib/text";

const MODEL_ID = "onnx-community/Qwen3.5-2B-ONNX";
const DEBUG_PREFIX = "[Web Bro][LLM]";
const interruptCriteria = new InterruptableStoppingCriteria();
const TOKENIZER_PROGRESS_SHARE = 0.12;
const FOLDER_PREFIX = "huggingface.co";
const MODEL_FILES = [
  "config.json",
  "generation_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "preprocessor_config.json",
  "processor_config.json",
  "onnx/decoder_model_merged_q4.onnx",
  "onnx/decoder_model_merged_q4.onnx_data",
  "onnx/embed_tokens_q4.onnx",
  "onnx/embed_tokens_q4.onnx_data",
  "onnx/vision_encoder_q4.onnx",
  "onnx/vision_encoder_q4.onnx_data",
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
      : activeCacheSource === "folder"
        ? "Loading model weights from folder"
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

    if (!modelCacheFolder || modelCachePermission !== "granted") {
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

function buildSystemContext(request: GenerateTurnRequest): string | null {
  const sections = [
    request.workspaceSummary
      ? ["CURRENT WORKSPACE CONTEXT:", request.workspaceSummary].join("\n")
      : null,
  ].filter((section): section is string => Boolean(section));

  if (sections.length === 0) {
    return null;
  }

  return sections.join("\n\n");
}

export const SYSTEM_PROMPT = [
  "You are Web Bro, a workspace agent running fully inside a Chromium browser.",
  "",
  "CRITICAL: YOU HAVE TOOLS. YOU CAN WRITE FILES. USE THEM.",
  "",
  "YOUR RESPONSE MUST USE EXACTLY ONE TAG:",
  "1. [TEXT]...[END]  - Talking only, no action taken",
  "2. [TOOL:name]{...}[END] - Actually does something",
  "",
  "ALWAYS start your answer with [TEXT] or [TOOL:name].",
  "NEVER explain what you will do in [TEXT] - just do it with [TOOL:name].",
  "TOOL RESPONSES MUST put the tool name in the tag and the args JSON immediately after it.",
  "Be extremely careful to produce valid JSON with all braces and quotes closed.",
  "Before finishing a [TOOL] response, ensure the JSON object is complete and exactly wrapped as [TOOL:name]{...}[END].",
  "[END] means the response is fully complete. If you are still writing the same [TEXT] or [TOOL:name] response, do not output [END] yet.",
  'Valid example: [TOOL:list_dir]{"path":"."}[END]',
  "",
  "IF THE USER WANTS A FILE CREATED:",
  "- Use ONLY [TOOL:write_file]{...}[END]. Do NOT use [TEXT] first.",
  "- Writing in [TEXT] does NOT create a file.",
  "",
  "YOUR TOOLS:",
  'list_dir:{"path":"."}',
  'read_file:{"path":string}',
  'search_text:{"query":string}',
  'write_file:{"path":string,"content":string}',
  "",
  "Use exactly one of those tool names in the [TOOL:name] tag.",
].join("\n");

export function getSystemPrompt(request: GenerateTurnRequest): string {
  const context = buildSystemContext(request);
  return context ? `${SYSTEM_PROMPT}\n\n${context}` : SYSTEM_PROMPT;
}

function buildMessages(request: GenerateTurnRequest) {
  return [
    {
      role: "system" as const,
      content: getSystemPrompt(request),
    },
    ...request.conversation,
  ];
}

function renderOpenAssistantContinuation(content: string): string {
  return `<|im_start|>assistant\n${content}`;
}

export function renderGenerationPrompt(request: GenerateTurnRequest): string {
  if (request.partialOutput) {
    const messages = buildMessages(request);
    const lastMessage = messages.at(-1);

    if (
      lastMessage?.role === "assistant" &&
      lastMessage.content === request.partialOutput
    ) {
      const prefix = messages.slice(0, -1);
      const serializedPrefix =
        prefix.length > 0 ? `${renderChatMl(prefix)}\n` : "";
      return `${serializedPrefix}${renderOpenAssistantContinuation(lastMessage.content)}`;
    }
  }

  const prompt = renderChatMl(buildMessages(request));
  const thinkContent = request.agentNotes?.length
    ? request.agentNotes.join("\n")
    : "";

  return `${prompt}\n<|im_start|>assistant\n<think>\n${thinkContent}\n</think>\n`;
}

function repairJson(str: string): string {
  let repaired = str;
  const open = (repaired.match(/{/g) || []).length;
  let close = (repaired.match(/}/g) || []).length;

  while (close < open) {
    repaired += "}";
    close += 1;
  }

  return repaired;
}

function normalizeDecision(
  raw: string,
  allowBareContinuation = false,
): AgentDecision {
  debugLog("decide:raw-output", {
    preview: previewText(raw),
  });

  const trimmed = raw.trim();
  const hasEndTag = trimmed.endsWith("[END]");
  const content = hasEndTag ? trimmed.slice(0, -5).trimEnd() : trimmed;

  const toolTagMatch = content.match(/^\[TOOL:([a-z_]+)\]/);

  if (allowBareContinuation && !content.startsWith("[TEXT]") && !toolTagMatch) {
    if (hasEndTag) {
      return {
        type: "final",
        message: content || "Done.",
        raw,
      };
    }

    return {
      type: "incomplete",
      partial: content,
      raw,
    };
  }

  if (!content.startsWith("[TEXT]") && !toolTagMatch) {
    debugLog("decide:invalid-format", { preview: previewText(content) });
    return {
      type: "error",
      message: "Response must start with [TEXT] or [TOOL:name].",
      raw,
    };
  }

  // Handle [TOOL:name] tag
  if (toolTagMatch) {
    const tool = toolTagMatch[1] as AgentToolName;
    const afterTag = content.slice(toolTagMatch[0].length).trim();

    if (!hasEndTag) {
      debugLog("decide:tool-incomplete");
      return {
        type: "incomplete",
        partial: content,
        raw,
      };
    }

    const repaired = repairJson(afterTag);
    const candidate = extractFirstJsonObject(repaired) ?? repaired;

    if (!candidate.trim()) {
      return {
        type: "error",
        message: "Tool call requested but no valid JSON found.",
        raw,
      };
    }

    try {
      const args = JSON.parse(candidate);

      if (args && typeof args === "object" && !Array.isArray(args)) {
        debugLog("decide:tool-parsed", {
          tool,
        });
        return {
          type: "tool",
          tool,
          args,
          raw,
        };
      }
    } catch {
      debugLog("decide:tool-parse-error");
    }

    return {
      type: "error",
      message: "Tool call JSON could not be parsed.",
      raw,
    };
  }

  // Handle [TEXT] tag
  const afterTag = content.slice("[TEXT]".length).trim();
  if (!hasEndTag) {
    debugLog("decide:text-incomplete");
    return {
      type: "incomplete",
      partial: content,
      raw,
    };
  }

  debugLog("decide:text-parsed", {
    message: previewText(afterTag),
  });
  return {
    type: "final",
    message: afterTag || "Done.",
    raw,
  };
}

async function generateText(
  prompt: string,
  onStream?: StreamListener,
): Promise<{ output: string; prompt: string }> {
  const { tokenizer, model } = await loadResources();
  const inputs = tokenizer(prompt, {
    return_tensor: true,
  });
  const promptTokens = inputs.input_ids.dims.at(-1) ?? 0;
  debugLog("generate:prepared", {
    promptChars: String(prompt).length,
    promptTokens,
  });

  interruptCriteria.reset();
  setStatus({
    phase: "generating",
    detail: "Thinking...",
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
      max_new_tokens: 1024,
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
      });
      setStatus({
        phase: "ready",
        detail: "Model ready on WebGPU.",
        progress: 100,
      });
      return {
        output: streamed.trim(),
        prompt,
      };
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
    });

    return {
      output: decoded.trim(),
      prompt,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "Generation interrupted.") {
      debugLog("generate:interrupted");
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
    resetLoadedModel();

    const manifestComplete = await isManifestComplete();
    const detail = !directoryHandle
      ? "Browser cache only."
      : modelCachePermission !== "granted"
        ? "Model folder selected, but permission must be reconnected."
        : manifestComplete
          ? "Model folder cache is ready."
          : "Model folder selected. Missing files will be downloaded on first load.";

    activeCacheSource = directoryHandle && manifestComplete ? "folder" : null;

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

  async generateRawText(request, onStream) {
    debugLog("generate:raw-start", {
      promptChars: request.prompt.length,
    });
    const { output, prompt } = await generateText(request.prompt, onStream);
    return {
      output,
      prompt,
    } satisfies GenerateRawTextResult;
  },

  async generateTurn(request, onStream) {
    debugLog("generate:start", {
      agentNotes: request.agentNotes?.length ?? 0,
      conversationMessages: request.conversation.length,
    });
    const prompt = renderGenerationPrompt(request);
    const { output } = await generateText(prompt, onStream);
    const decision = normalizeDecision(output, Boolean(request.partialOutput));
    return {
      decision,
      prompt,
    } satisfies GenerateTurnResult;
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

    const source =
      modelCacheFolder && manifestComplete ? "folder" : activeCacheSource;

    return {
      ...buildCacheStatus(detail),
      source,
      manifestComplete,
      isReady: manifestComplete,
    };
  },

  async getStatus() {
    return status;
  },
};

expose(llmApi);
