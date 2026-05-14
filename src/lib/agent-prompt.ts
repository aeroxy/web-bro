import { renderToolDefinition } from "./chatml";
import type {
  AgentDecision,
  AgentToolName,
  GenerateTurnRequest,
  ModelToolCall,
} from "./contracts";

export const VALID_TOOLS: AgentToolName[] = [
  "list_dir",
  "read_file",
  "search_text",
  "write_file",
];

export const SYSTEM_PROMPT = [
  "You are Web Bro, a workspace agent running fully inside a Chromium browser.",
  "",
  "Use the available functions when they are needed to inspect or modify the mounted workspace.",
  "If no function is needed, answer in normal plain text.",
  "Do not invent file contents, tool arguments, or workspace state that you have not inspected unless the user explicitly asked you to create them.",
].join("\n");

export function buildSystemContext(
  request: GenerateTurnRequest,
): string | null {
  if (!request.workspaceSummary) {
    return null;
  }

  return ["CURRENT WORKSPACE CONTEXT:", request.workspaceSummary].join("\n");
}

export function getSystemPrompt(request: GenerateTurnRequest): string {
  const sections = [SYSTEM_PROMPT];
  const context = buildSystemContext(request);

  if (context) {
    sections.push(context);
  }

  return sections.join("\n\n");
}

export function buildToolDefinitions() {
  return [
    renderToolDefinition({
      name: "list_dir",
      description: "List files and directories under a workspace path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Workspace-relative directory path. Use . for the root.",
          },
        },
      },
    }),
    renderToolDefinition({
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path to read.",
          },
        },
        required: ["path"],
      },
    }),
    renderToolDefinition({
      name: "search_text",
      description: "Search the workspace for a text query.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text query to search for.",
          },
        },
        required: ["query"],
      },
    }),
    renderToolDefinition({
      name: "write_file",
      description:
        "Write a UTF-8 text file in the workspace, replacing the file if it already exists.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path to write.",
          },
          content: {
            type: "string",
            description: "Complete UTF-8 file contents to write.",
          },
        },
        required: ["path", "content"],
      },
    }),
  ];
}

function parseGemmaToolCallArgs(
  argsStr: string,
): Record<string, unknown> | null {
  // Gemma 4 tool call args format: {key:<|"|>value<|"|>,key2:123}
  // The <|"|> tokens are decoded as literal strings by the tokenizer.
  // We parse the brace-enclosed key-value pairs.
  const result: Record<string, unknown> = {};

  // Strip outer braces
  const inner = argsStr
    .trim()
    .replace(/^\{|\}$/g, "")
    .trim();
  if (!inner) {
    return result;
  }

  // Tokenize by splitting on commas that are not inside string tokens
  // Strings are wrapped with <|"|>...<|"|>
  const STRING_TOKEN = '<|"|>';
  let i = 0;
  const pairs: string[] = [];
  let currentPair = "";

  while (i < inner.length) {
    if (inner.startsWith(STRING_TOKEN, i)) {
      const start = i + STRING_TOKEN.length;
      const end = inner.indexOf(STRING_TOKEN, start);
      if (end === -1) {
        return null;
      }
      currentPair += inner.slice(i, end + STRING_TOKEN.length);
      i = end + STRING_TOKEN.length;
    } else if (inner[i] === ",") {
      pairs.push(currentPair.trim());
      currentPair = "";
      i++;
    } else {
      currentPair += inner[i];
      i++;
    }
  }
  if (currentPair.trim()) {
    pairs.push(currentPair.trim());
  }

  for (const pair of pairs) {
    const colonIdx = pair.indexOf(":");
    if (colonIdx === -1) continue;
    const key = pair.slice(0, colonIdx).trim();
    const rawVal = pair.slice(colonIdx + 1).trim();

    if (rawVal.startsWith(STRING_TOKEN) && rawVal.endsWith(STRING_TOKEN)) {
      result[key] = rawVal.slice(STRING_TOKEN.length, -STRING_TOKEN.length);
    } else if (rawVal === "true") {
      result[key] = true;
    } else if (rawVal === "false") {
      result[key] = false;
    } else if (rawVal === "null") {
      result[key] = null;
    } else {
      const num = Number(rawVal);
      result[key] = isNaN(num) ? rawVal : num;
    }
  }

  return result;
}

function parseGemmaToolCallPayload(
  funcName: string,
  argsStr: string,
): ModelToolCall | AgentDecision {
  const args = parseGemmaToolCallArgs(argsStr);

  if (!args) {
    return {
      type: "error",
      message: "Function call arguments could not be parsed.",
      raw: `<|tool_call>call:${funcName}{${argsStr}}<tool_call|>`,
    };
  }

  if (!VALID_TOOLS.includes(funcName as AgentToolName)) {
    return {
      type: "error",
      message: `Unknown function call: ${funcName}.`,
      raw: `<|tool_call>call:${funcName}{${argsStr}}<tool_call|>`,
    };
  }

  return {
    name: funcName as AgentToolName,
    arguments: args,
  };
}

export function toolCallToDecision(
  call: ModelToolCall,
  raw: string,
): AgentDecision {
  switch (call.name) {
    case "list_dir":
      return {
        type: "tool",
        tool: "list_dir",
        args: call.arguments,
        raw,
      };
    case "read_file": {
      const readPath = call.arguments.path;
      if (typeof readPath !== "string") {
        return {
          type: "error",
          message: "Function call arguments must be a JSON object.",
          raw,
        };
      }
      return {
        type: "tool",
        tool: "read_file",
        args: { path: readPath },
        raw,
      };
    }
    case "search_text": {
      const searchQuery = call.arguments.query;
      if (typeof searchQuery !== "string") {
        return {
          type: "error",
          message: "Function call arguments must be a JSON object.",
          raw,
        };
      }
      return {
        type: "tool",
        tool: "search_text",
        args: { query: searchQuery },
        raw,
      };
    }
    case "write_file": {
      const writePath = call.arguments.path;
      const writeContent = call.arguments.content;
      if (typeof writePath !== "string" || typeof writeContent !== "string") {
        return {
          type: "error",
          message: "Function call arguments must be a JSON object.",
          raw,
        };
      }
      return {
        type: "tool",
        tool: "write_file",
        args: { path: writePath, content: writeContent },
        raw,
      };
    }
  }
}

export function normalizeDecision(
  raw: string,
  allowBareContinuation = false,
): AgentDecision {
  const trimmed = raw
    .replace(/<\|tool_response>$/g, "")
    .replace(/<turn\|>$/g, "")
    .replace(/<end_of_turn>$/g, "")
    .replace(/<eos>$/g, "")
    .trim();

  const completeToolCallMatch = trimmed.match(
    /^<\|tool_call>call:([A-Za-z_][A-Za-z0-9_]*)\{([\s\S]*?)\}<tool_call\|>$/,
  );

  if (completeToolCallMatch) {
    const funcName = completeToolCallMatch[1] ?? "";
    const argsStr = completeToolCallMatch[2] ?? "";
    const payload = parseGemmaToolCallPayload(funcName, argsStr);

    if ("type" in payload) {
      return {
        ...payload,
        raw,
      };
    }

    return toolCallToDecision(payload, raw);
  }

  if (trimmed.startsWith("<|tool_call>")) {
    if (trimmed.includes("<tool_call|>")) {
      return {
        type: "error",
        message: "Function call arguments could not be parsed.",
        raw,
      };
    }

    return {
      type: "incomplete",
      partial: trimmed,
      raw,
    };
  }

  if (allowBareContinuation && trimmed) {
    return {
      type: "final",
      message: trimmed,
      raw,
    };
  }

  if (!trimmed) {
    return {
      type: "incomplete",
      partial: trimmed,
      raw,
    };
  }

  return {
    type: "final",
    message: trimmed,
    raw,
  };
}
