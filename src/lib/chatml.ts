import type {
  AgentToolName,
  ModelConversationMessage,
} from "./contracts";
import type { AutoProcessor } from "@huggingface/transformers";

export interface DebugPromptEntry {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
}

export function renderStructuredDebugPrompt(
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>,
  entries: Pick<ModelConversationMessage, "role" | "content">[],
): string {
  return processor.apply_chat_template(
    entries.map((entry) => ({
      role: entry.role,
      content: entry.content,
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      add_generation_prompt: true,
      tokenize: false,
      enable_thinking: false,
    } as any,
  ) as string;
}

export function renderToolDefinition(definition: {
  name: AgentToolName;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}): {
  type: "function";
  function: {
    name: AgentToolName;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
} {
  return {
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    },
  };
}
