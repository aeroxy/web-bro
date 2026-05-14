import {
  AutoProcessor,
  env,
  Gemma4ForCausalLM,
  InterruptableStoppingCriteria,
  TextStreamer,
} from "@huggingface/transformers";
import { expose } from "comlink";
import {
  buildToolDefinitions,
  getSystemPrompt,
  normalizeDecision,
} from "../lib/agent-prompt";
import { renderStructuredDebugPrompt } from "../lib/chatml";
import type {
  GenerateRawTextResult,
  GenerateTurnRequest,
  GenerateTurnResult,
  ModelCacheSource,
  ModelCacheStatus,
  ModelConversationMessage,
  ModelStatus,
  ModelWorkerAPI,
  StreamChunk,
  StreamListener,
} from "../lib/contracts";

export { normalizeDecision } from "../lib/agent-prompt";

const MODEL_ID = "onnx-community/gemma-4-E2B-it-ONNX";
const DEBUG_PREFIX = "[Web Bro][LLM]";
const interruptCriteria = new InterruptableStoppingCriteria();
const TOKENIZER_PROGRESS_SHARE = 0.12;
const FOLDER_PREFIX = "huggingface.co";
const MODEL_FILES = [
  "chat_template.jinja",
  "config.json",
  "generation_config.json",
  "processor_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/decoder_model_merged_q4f16.onnx",
  "onnx/decoder_model_merged_q4f16.onnx_data",
  "onnx/embed_tokens_q4f16.onnx",
  "onnx/embed_tokens_q4f16.onnx_data",
] as const;

let processorPromise: Promise<
  Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>
> | null = null;
let modelPromise: Promise<
  Awaited<ReturnType<typeof Gemma4ForCausalLM.from_pretrained>>
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

type LoadingProgressEvent = {
  file?: string;
  progress?: number;
  status?: string;
};

function setStatus(next: ModelStatus): void {
  status = next;
}

function configureEnvironment(): void {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = folderBackedCache;
}

function debugLog(message: string, meta?: unknown): void {
  if (meta === undefined) {
    console.debug(DEBUG_PREFIX, message);
    return;
  }

  console.debug(DEBUG_PREFIX, message, meta);
}

function resetLoadingDebugState(): void {
  lastLoadingLogBucket = -1;
}

function resetLoadedModel(): void {
  processorPromise = null;
  modelPromise = null;
}

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
      ? "Preparing processor assets"
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

  let foundDecoder = false;
  let foundEmbedTokens = false;

  for (const file of MODEL_FILES) {
    const relativePath = `${MODEL_ID}/resolve/main/${file}`;
    const resolved = await readFolderFile(`${FOLDER_PREFIX}/${relativePath}`);

    if (!resolved) {
      if (
        file === "onnx/decoder_model_merged_q4f16.onnx_data" ||
        file === "onnx/embed_tokens_q4f16.onnx_data"
      ) {
        continue;
      }
      return false;
    }

    if (file === "onnx/decoder_model_merged_q4f16.onnx_data") {
      foundDecoder = true;
    }
    if (file === "onnx/embed_tokens_q4f16.onnx_data") {
      foundEmbedTokens = true;
    }
  }

  return foundDecoder && foundEmbedTokens;
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

function loadProcessor() {
  if (!processorPromise) {
    processorPromise = AutoProcessor.from_pretrained(MODEL_ID, {
      progress_callback(info: unknown) {
        updateLoadingStatus("tokenizer", info as LoadingProgressEvent);
      },
    }).catch((error) => {
      processorPromise = null;
      throw error;
    });
  }

  return processorPromise;
}

function loadModel() {
  if (!modelPromise) {
    modelPromise = Gemma4ForCausalLM.from_pretrained(MODEL_ID, {
      device: "webgpu",
      dtype: "q4f16",
      progress_callback(info: unknown) {
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
  configureEnvironment();
  modelCacheDownloadBytes = 0;
  activeCacheSource = null;

  const processor = await loadProcessor();
  debugLog("processor:ready");

  setStatus({
    phase: "loading",
    detail: "Processor ready. Preparing model weights.",
    progress: TOKENIZER_PROGRESS_SHARE * 100,
  });

  const model = await loadModel();
  debugLog("model:ready");
  setStatus({
    phase: "ready",
    detail:
      activeCacheSource === "folder"
        ? "Gemma model ready on WebGPU from local folder cache."
        : activeCacheSource === "browser-cache"
          ? "Gemma model ready on WebGPU from browser cache."
          : "Gemma model ready on WebGPU.",
    progress: 100,
  });

  return { processor, model };
}

function buildMessages(
  request: GenerateTurnRequest,
): ModelConversationMessage[] {
  return [
    {
      role: "system",
      content: getSystemPrompt(request),
    },
    ...request.conversation,
  ];
}

// Gemma's apply_chat_template expects tool_calls in { function: { name, arguments } } shape
function toGemmaMessages(messages: ModelConversationMessage[]) {
  return messages.map((msg) => {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      return {
        ...msg,
        tool_calls: msg.tool_calls.map((tc) => ({
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    return msg;
  });
}

export function renderGenerationPrompt(
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>,
  request: GenerateTurnRequest,
): string {
  const messages = buildMessages(request);
  const tools = buildToolDefinitions();

  if (request.partialOutput) {
    const lastMessage = messages.at(-1);
    if (
      lastMessage?.role === "assistant" &&
      lastMessage.content === request.partialOutput
    ) {
      const withoutLast = messages.slice(0, -1);
      const base = processor.apply_chat_template(toGemmaMessages(withoutLast), {
        tools,
        add_generation_prompt: true,
        tokenize: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        enable_thinking: false,
      } as any) as string;
      return base + request.partialOutput;
    }
  }

  return processor.apply_chat_template(toGemmaMessages(messages), {
    tools,
    add_generation_prompt: true,
    tokenize: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    enable_thinking: false,
  } as any) as string;
}

async function generateText(
  prompt: string,
  onStream?: StreamListener,
): Promise<{ output: string; prompt: string }> {
  const { processor, model } = await loadResources();
  const inputs = processor.tokenizer!(prompt, {
    add_special_tokens: false,
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
      : new TextStreamer(processor.tokenizer!, {
          callback_function(text) {
            streamed += text;
            onStream({
              type: "text",
              text,
            } satisfies StreamChunk);
          },
          skip_prompt: true,
          skip_special_tokens: false,
        });

  try {
    const output = await model.generate({
      ...inputs,
      do_sample: false,
      max_new_tokens: 1024,
      temperature: 1.0,
      top_p: 0.95,
      top_k: 64,
      stopping_criteria: [interruptCriteria],
      streamer,
    });

    if (interruptCriteria.interrupted) {
      throw new Error("Generation interrupted.");
    }

    if (streamed.trim()) {
      setStatus({
        phase: "ready",
        detail: "Gemma model ready on WebGPU.",
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
      processor.tokenizer!.batch_decode(
        sequences.slice(null, [
          promptLength,
          sequences.dims[sequences.dims.length - 1]!,
        ]),
        {
          skip_special_tokens: false,
        },
      )[0] ?? "";

    setStatus({
      phase: "ready",
      detail: "Gemma model ready on WebGPU.",
      progress: 100,
    });

    return {
      output: decoded.trim(),
      prompt,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "Generation interrupted.") {
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
    setStatus({
      phase: "loading",
      detail: "Preparing processor and model.",
      progress: 0,
    });

    try {
      await loadResources();
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      setStatus({
        phase: "error",
        detail: "Model failed to load.",
        error: message,
        progress: undefined,
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
          : "Model folder selected. Missing Gemma files will be downloaded on first load.";

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

  async renderDebugPrompt(messages) {
    configureEnvironment();
    const processor = await loadProcessor();
    return renderStructuredDebugPrompt(processor, messages);
  },

  async generateRawText(request, onStream) {
    const { output, prompt } = await generateText(request.prompt, onStream);
    return {
      output,
      prompt,
    } satisfies GenerateRawTextResult;
  },

  async generateTurn(request, onStream) {
    const { processor } = await loadResources();
    const prompt = renderGenerationPrompt(processor, request);
    const { output } = await generateText(prompt, onStream);
    const decision = normalizeDecision(output, Boolean(request.partialOutput));
    return {
      decision,
      prompt,
    } satisfies GenerateTurnResult;
  },

  async abortGeneration() {
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
