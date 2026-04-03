import {
  streamSimpleOpenAICompletions,
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

interface CompatOptions {
  supportsDeveloperRole?: boolean;
  thinkingFormat?: "qwen" | "other";
}

interface ModelOptions {
  maxTokens?: number;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  compat?: CompatOptions;
}

type ModelOptionsMap = {
  [pattern: string]: ModelOptions;
};

interface ServerConfig {
  url: string;
  apiKey?: string;
  optional?: boolean;
  modelOptions?: ModelOptionsMap;
}

interface Settings {
  "remote-providers"?: {
    providers: {
      [name: string]: ServerConfig;
    };
    modelOptions?: ModelOptionsMap;
  };
}

interface VLLMModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  max_model_len?: number; // Optional: context window size from vLLM
}

function parseSettings(): Settings | null {
  try {
    const fs = require("fs");
    const agentDir = getAgentDir();
    const settingsPath = `${agentDir}/settings.json`;
    const content = fs.readFileSync(settingsPath, "utf-8");
    return JSON.parse(content) as Settings;
  } catch (error) {
    return null;
  }
}

async function fetchVLLMModels(
  baseUrl: string,
  apiKey?: string,
): Promise<VLLMModelInfo[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${baseUrl}/models`, { headers });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch models: ${response.status} ${response.statusText}`,
    );
  }

  return response.json().then((r) => r.data) as Promise<VLLMModelInfo[]>;
}

function matchPatterns(
  modelId: string,
  patterns: ModelOptionsMap,
): ModelOptions[] {
  return Object.entries(patterns)
    .filter(([pattern]) => {
      if (pattern === modelId) {
        return true;
      }

      if (pattern.endsWith("*")) {
        const prefix = pattern.slice(0, -1);
        return modelId.startsWith(`${prefix}`);
      }

      return false;
    })
    .map(([, options]) => options);
}

function mergeOptions(
  base: ModelOptions,
  override: ModelOptions,
): ModelOptions {
  return {
    ...base,
    ...override,
    compat: base.compat ? mergeOptions(base.compat, override.compat ?? {}) as CompatOptions : override.compat,
  };
}

export default function (pi: ExtensionAPI) {
  async function registerRemoteProviders(ctx: ExtensionContext): Promise<void> {
    const settings = parseSettings();

    if (!settings?.["remote-providers"]?.providers) {
      ctx.ui.notify("No providers configured in settings.json.", "error");
      return;
    }

    const requiredErrors: string[] = [];
    const optionalErrors: string[] = [];

    for (const [serverName, config] of Object.entries(
      settings["remote-providers"]?.providers,
    )) {
      try {
        if (!config.url) {
          if (config.optional) {
            continue;
          }
          requiredErrors.push(`${serverName}: URL not set`);
          continue;
        }

        const modelData = await fetchVLLMModels(config.url, config.apiKey);

        if (modelData.length === 0) {
          ctx.ui.notify(`${serverName}: No models found`, "warning");
          continue;
        }

        const globalModelOptions =
          settings["remote-providers"]?.modelOptions ?? {};

        const models: Model<Api>[] = modelData.map((m) => {
          const globalOptions = matchPatterns(m.id, globalModelOptions).reduce(
            mergeOptions,
            {},
          );
          const providerOptions = matchPatterns(
            m.id,
            config.modelOptions ?? {},
          ).reduce(mergeOptions, {});
          const finalOptions = mergeOptions(globalOptions, providerOptions);


          ctx.ui.notify(`settings for ${m.id} ${JSON.stringify(finalOptions)} ${finalOptions.reasoning ?? true}`, "warning");

          return {
            id: m.id,
            name: m.id,
            api: "openai-completions" as Api,
            provider: serverName,
            baseUrl: config.url,
            reasoning: finalOptions.reasoning ?? false,
            contextWindow: finalOptions.contextWindow ?? 128000,
            maxTokens: finalOptions.maxTokens ?? 16384,
            input: finalOptions.input ?? ["text"],
            compat: finalOptions.compat,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          };
        });

        const streamFn = createStreamWrapper(config.apiKey);

        pi.registerProvider(serverName, {
          baseUrl: config.url,
          apiKey: config.apiKey ? `env:${config.apiKey}` : "placeholder",
          api: "openai-completions",
          models,
          streamSimple: streamFn,
        });

        ctx.ui.notify(
          `${serverName}: Registered ${models.length} model(s)`,
          "info",
        );
      } catch (error) {
        const errorMsg = `${serverName}: ${error instanceof Error ? error.message : String(error)}`;
        if (config.optional) {
          optionalErrors.push(errorMsg);
        } else {
          requiredErrors.push(errorMsg);
        }
      }
    }

    if (requiredErrors.length > 0) {
      let message = `Failed to register ${requiredErrors.length} server(s):\n${requiredErrors.join("\n")}`;
      if (optionalErrors.length > 0) {
        message += `\n\nOptional providers that failed:\n${optionalErrors.join("\n")}`;
      }
      ctx.ui.notify(message, "error");
    }
  }

  function createStreamWrapper(apiKey?: string) {
    return (
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ) => {
      return streamSimpleOpenAICompletions(model as any, context, {
        ...options,
        apiKey: apiKey ?? options?.apiKey ?? "placeholder",
      });
    };
  }

  // Register providers from settings
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    await registerRemoteProviders(ctx);
  });

  // Reload command
  pi.registerCommand("reload-remote-providers", {
    description: "Reload remote vLLM providers without restart",
    handler: async (_args, ctx) => {
      await registerRemoteProviders(ctx);
    },
  });
}
