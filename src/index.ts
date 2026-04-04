import {
  streamSimpleOpenAICompletions,
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type OpenAICompletionsCompat,
} from "@mariozechner/pi-ai";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

interface ModelOptions {
  maxTokens?: number;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  compat?: OpenAICompletionsCompat;
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
    compat: { ...base.compat, ...override.compat },
  };
}

export default async function (pi: ExtensionAPI) {
  async function loadRemoteProviders(
    settings: Settings | null,
    notifyError: (msg: string) => void,
    notifyInfo: (msg: string) => void,
  ): Promise<void> {
    await registerProviders(
      settings?.["remote-providers"],
      notifyError,
      notifyInfo,
    );
  }

  async function registerProviders(
    providersConfig: Settings["remote-providers"],
    notifyError: (msg: string) => void,
    notifyInfo: (msg: string) => void,
  ): Promise<void> {
    if (!providersConfig?.providers) {
      notifyError("No providers configured in settings.json.");
      return;
    }

    const providerEntries = Object.entries(providersConfig.providers);
    const requiredProviders = providerEntries.filter(
      ([, config]) => config.optional !== true,
    );
    const optionalProviders = providerEntries.filter(
      ([, config]) => config.optional === true,
    );

    const registerProvider = async (
      serverName: string,
      config: ServerConfig,
    ): Promise<string | null> => {
      if (!config.url) {
        if (config.optional) {
          return null;
        }
        return `${serverName}: URL not set`;
      }

      try {
        const modelData = await fetchVLLMModels(config.url, config.apiKey);

        if (modelData.length === 0) {
          notifyInfo(`${serverName}: No models found`);
          return null;
        }

        const globalModelOptions = providersConfig.modelOptions ?? {};

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

          notifyInfo(
            `settings for ${m.id} ${JSON.stringify(finalOptions)} ${finalOptions.reasoning ?? true}`,
          );

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

        notifyInfo(`${serverName}: Registered ${models.length} model(s)`);
        return null;
      } catch (error) {
        return `${serverName}: ${error instanceof Error ? error.message : String(error)}`;
      }
    };

    const reportPhaseResult = (
      phaseName: "required" | "optional",
      providers: Array<[string, ServerConfig]>,
      errors: string[],
    ): void => {
      if (providers.length === 0) {
        return;
      }

      const loadedCount = providers.length - errors.length;
      const phaseLabel = phaseName === "required" ? "Required" : "Optional";

      if (loadedCount > 0) {
        notifyInfo(
          `${phaseLabel} providers loaded: ${loadedCount}/${providers.length} server(s)`,
        );
      }

      if (errors.length > 0) {
        notifyError(
          `Failed to register ${errors.length} ${phaseName} server(s):\n${errors.join("\n")}`,
        );
      }
    };

    const loadProviderPhaseBlocking = async (
      phaseName: "required" | "optional",
      providers: Array<[string, ServerConfig]>,
    ): Promise<void> => {
      if (providers.length === 0) {
        return;
      }

      const errors = (
        await Promise.all(
          providers.map(([serverName, config]) =>
            registerProvider(serverName, config),
          ),
        )
      ).filter((error): error is string => error !== null);

      reportPhaseResult(phaseName, providers, errors);
    };

    const loadProviderPhaseInBackground = async (
      phaseName: "required" | "optional",
      providers: Array<[string, ServerConfig]>,
    ): Promise<void> => {
      if (providers.length === 0) {
        return;
      }

      try {
        const results = await Promise.all(
          providers.map(([serverName, config]) =>
            registerProvider(serverName, config),
          ),
        );
        const errors = results.filter(
          (error): error is string => error !== null,
        );
        reportPhaseResult(phaseName, providers, errors);
      } catch (error) {
        notifyError(
          `Failed to finish loading ${phaseName} providers: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    await loadProviderPhaseBlocking("required", requiredProviders);
    loadProviderPhaseInBackground("optional", optionalProviders);
  }

  async function registerRemoteProviders(ctx: ExtensionContext): Promise<void> {
    const settings = parseSettings();
    await loadRemoteProviders(
      settings,
      (msg) => ctx.ui.notify(msg, "error"),
      (msg) => ctx.ui.notify(msg, "info"),
    );
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

  // Register providers immediately on extension load
  try {
    const settings = parseSettings();
    await loadRemoteProviders(settings, console.error, console.info);
  } catch (err) {
    console.error("Failed to load remote providers:", err);
  }

  // Reload command with full UI feedback
  pi.registerCommand("reload-remote-providers", {
    description: "Reload remote vLLM providers without restart",
    handler: async (_args, ctx) => {
      await registerRemoteProviders(ctx);
    },
  });
}
