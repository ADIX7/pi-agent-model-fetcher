import {
  streamSimpleOpenAICompletions,
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

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



function parseSettings(ctx: ExtensionContext): Settings | null {
  try {
    const fs = require("fs");
    const agentDir = ctx.getAgentDir?.() || ctx.ui.cwd;
    const settingsPath = `${agentDir}/settings.json`;
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

  return response.json() as Promise<VLLMModelInfo[]>;
}


export default function (pi: ExtensionAPI) {
  function createStreamWrapper(apiKey?: string) {
    return (model: Model, context: Context, options?: SimpleStreamOptions) => {
      return streamSimpleOpenAICompletions(model as any, context, {
        ...options,
        apiKey: apiKey ?? options?.apiKey,
      });
    };
  }

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const settings = parseSettings(ctx);

    if (!settings?.vllm?.baseUrl) {
      ctx.ui.notify("vLLM configuration not found in settings.json. Add a 'vllm' section with 'baseUrl'.", "error");
      return;
    }

    const { baseUrl, apiKey } = settings.vllm;

    try {
      ctx.ui.notify("Fetching vLLM models...", "info");
      const modelData = await fetchVLLMModels(baseUrl, apiKey);

      if (modelData.length === 0) {
        ctx.ui.notify("No models found on vLLM instance.", "warn");
        return;
      }

      const models: Model<Api>[] = modelData.map((m) => ({
        id: m.id,
        name: m.id,
        api: "openai-completions" as Api,
        provider: "vllm",
        contextWindow: undefined,
        maxTokens: undefined,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }));

      const streamFn = createStreamWrapper(apiKey);

      pi.registerProvider("vllm", {
        baseUrl,
        apiKey: apiKey ? `env:${apiKey}` : undefined,
        api: "openai-completions",
        models,
        streamSimple: streamFn,
      });

      ctx.ui.notify(`vLLM provider registered with ${models.length} model(s): ${models.map((m) => m.id).join(", ")}`, "info");
    } catch (error) {
      ctx.ui.notify(`Failed to connect to vLLM: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });
}
