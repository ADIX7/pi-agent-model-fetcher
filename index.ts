import type {
  Api,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  StopReason,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const SETTINGS_PATH = "~/.pi/agent/settings.json";

interface Settings {
  vllm?: {
    baseUrl: string;
    apiKey?: string;
  };
}

interface VLLMModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

interface VLLMListResponse {
  object: "list";
  data: VLLMModelInfo[];
}

interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>;
  name?: string;
  tool_call_id?: string;
}

interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string; tool_calls?: Array<{ index: number; id: string; type: string; function?: { name: string; arguments: string } }> };
    logprobs?: any;
    finish_reason?: "stop" | "length" | "tool_calls" | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function parseSettings(ctx: ExtensionContext): Settings | null {
  try {
    const fs = require("fs");
    const path = require("path");
    const settingsPath = path.resolve(ctx.ui.cwd, SETTINGS_PATH.replace("~", require("os").homedir()));
    const content = fs.readFileSync(settingsPath, "utf-8");
    return JSON.parse(content) as Settings;
  } catch (error) {
    return null;
  }
}

async function fetchVLLMModels(baseUrl: string, apiKey?: string): Promise<VLLMModelInfo[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${baseUrl}/v1/models`, { headers });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<VLLMListResponse>;
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "stop":
    case "eos_token":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "toolUse";
    default:
      return "error";
  }
}

function convertMessages(messages: Message[]): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else {
        const content = msg.content.map((block) => {
          if (block.type === "text") {
            return { type: "text" as const, text: block.text };
          }
          return { type: "image" as const, data: block.data, mimeType: block.mimeType };
        });
        result.push({ role: "user", content });
      }
    } else if (msg.role === "assistant") {
      const contentBlocks: Array<{ type: "text" | "tool_call"; text?: string; tool_call?: ToolCall }> = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          contentBlocks.push({ type: "text", text: block.text });
        } else if (block.type === "toolCall") {
          contentBlocks.push({
            type: "tool_call",
            tool_call: block,
          });
        }
      }

      if (contentBlocks.length === 1 && contentBlocks[0]?.type === "text") {
        result.push({ role: "assistant", content: contentBlocks[0].text! });
      } else {
        result.push({ role: "assistant", content: contentBlocks.filter((b) => b.type === "text").map((b) => ({ type: "text" as const, text: b.text! })).join("\n") });
      }
    } else if (msg.role === "toolResult") {
      const textContent = msg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      result.push({
        role: "tool",
        content: textContent,
        tool_call_id: msg.toolCallId,
      });
    }
  }

  return result;
}

function streamVLLM(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): any {
  const stream = context.ai.createAssistantMessageEventStream();

  (async () => {
    const output = context.ai.createAssistantMessage({
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as StopReason,
      timestamp: Date.now(),
    });

    stream.push({ type: "start", partial: output });

    try {
      const baseUrl = model.baseUrl!;
      const apiKey = (options?.apiKey ?? "") || (context.ai as any).apiKeys?.[model.api] ?? "";

      const messages = convertMessages(context.messages);

      const body: any = {
        model: model.id,
        messages: messages,
        stream: true,
        max_tokens: options?.maxTokens,
      };

      if (context.tools) {
        body.tools = context.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`vLLM API error: ${response.status} ${errorText}`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const blocks: Array<TextContent | ToolCall> = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") break;

            try {
              const completion: ChatCompletionChunk = JSON.parse(data);

              if (completion.usage) {
                output.usage.input = completion.usage.prompt_tokens;
                output.usage.output = completion.usage.completion_tokens;
                output.usage.totalTokens = completion.usage.total_tokens;
                context.ai.calculateCost(model, output.usage);
              }

              for (const choice of completion.choices) {
                if (choice.delta.content) {
                  const textBlock = { type: "text" as const, text: choice.delta.content };
                  blocks.push(textBlock as any);
                  stream.push({ type: "text_start", contentIndex: blocks.length - 1, partial: output });
                  stream.push({ type: "text_delta", contentIndex: blocks.length - 1, delta: choice.delta.content, partial: output });
                  stream.push({ type: "text_end", contentIndex: blocks.length - 1, content: choice.delta.content, partial: output });
                }

                if (choice.delta.tool_calls) {
                  for (const toolCall of choice.delta.tool_calls) {
                    const block: ToolCall = {
                      type: "toolCall",
                      id: toolCall.id,
                      name: toolCall.function?.name || "",
                      arguments: {},
                      partialJson: "",
                      index: toolCall.index,
                    };
                    blocks.push(block as any);
                    stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });

                    if (toolCall.function?.arguments) {
                      block.partialJson += toolCall.function.arguments;
                      try {
                        block.arguments = JSON.parse(block.partialJson);
                      } catch {}
                      stream.push({ type: "toolcall_delta", contentIndex: blocks.length - 1, delta: toolCall.function.arguments, partial: output });
                      stream.push({ type: "toolcall_end", contentIndex: blocks.length - 1, toolCall: block, partial: output });
                    }
                  }
                }

                if (choice.finish_reason) {
                  output.stopReason = mapStopReason(choice.finish_reason);
                  context.ai.calculateCost(model, output.usage);
                }
              }
            } catch (e) {
              // Ignore parse errors for malformed chunks
            }
          }
        }
      }

      if (options?.signal?.aborted) {
        output.stopReason = "aborted";
      }

      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const settings = parseSettings(ctx);

    if (!settings?.vllm?.baseUrl) {
      ctx.ui.notify("vLLM configuration not found in settings.json. Add a 'vllm' section with 'baseUrl'.", "error");
      return;
    }

    const { baseUrl, apiKey } = settings.vllm;

    try {
      ctx.ui.notify("Fetching vLLM models...", "info");
      const modelData = await fetchVLLMModels(baseUrl, apiKey);

      if (modelData.data.length === 0) {
        ctx.ui.notify("No models found on vLLM instance.", "warn");
        return;
      }

      const models: Model<Api>[] = modelData.data.map((m) => ({
        id: m.id,
        name: m.id,
        contextWindow: undefined,
        maxTokens: undefined,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }));

      pi.registerProvider("vllm", {
        baseUrl,
        apiKey: apiKey ? `env:${apiKey}` : undefined,
        api: "vllm-api",
        models,
        streamSimple: streamVLLM,
      });

      ctx.ui.notify(`vLLM provider registered with ${models.length} model(s): ${models.map((m) => m.id).join(", ")}`, "info");
    } catch (error) {
      ctx.ui.notify(`Failed to connect to vLLM: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });
}
