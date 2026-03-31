import {
  streamSimpleOpenAICompletions,
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
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


export default function (pi: ExtensionAPI) {
  // Store settings for use in stream wrapper
  let vllmSettings: { baseUrl: string; apiKey?: string } | null = null;

  function createStreamWrapper(baseUrl: string, apiKey?: string) {
    return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      return streamSimpleOpenAICompletions(model, context, {
        ...options,
        apiKey: apiKey ?? options?.apiKey,
      });
    };
  }
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

      vllmSettings = { baseUrl, apiKey };
      const streamFn = createStreamWrapper(baseUrl, apiKey);

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
