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
  disabled?: boolean;
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

// Collect startup messages for display via pi.notify
const startupMessages: Array<{ type: "error"; message: string }> = [];
let hasDisplayedStartupMessages = false;

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
  // Collect startup messages instead of logging to console
  const collectError = (msg: string) =>
    startupMessages.push({ type: "error", message: msg });

  async function loadRemoteProviders(
    settings: Settings | null,
    notifyError: (msg: string) => void,
  ): Promise<void> {
    await registerProviders(settings?.["remote-providers"], notifyError);
  }

  async function registerProviders(
    providersConfig: Settings["remote-providers"],
    notifyError: (msg: string) => void,
  ): Promise<void> {
    if (!providersConfig?.providers) {
      notifyError("No providers configured in settings.json.");
      return;
    }

    const providerEntries = Object.entries(providersConfig.providers);
    const activeProviders = providerEntries.filter(
      ([, config]) => config.disabled !== true,
    );
    const requiredProviders = activeProviders.filter(
      ([, config]) => config.optional !== true,
    );
    const optionalProviders = activeProviders.filter(
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

          const contextWindow = m.max_model_len ??
            finalOptions.contextWindow ??
            128000;

          return {
            id: m.id,
            name: m.id,
            api: "openai-completions" as Api,
            provider: serverName,
            baseUrl: config.url,
            reasoning: finalOptions.reasoning ?? false,
            contextWindow,
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
    await loadRemoteProviders(settings, (msg) => ctx.ui.notify(msg, "error"));
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
    await loadRemoteProviders(settings, collectError);
  } catch (err) {
    collectError(
      `Failed to load remote providers: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Display collected startup messages on first session start
  // We only show them once by checking the flag before display
  pi.on("session_start", async (_event, ctx) => {
    if (hasDisplayedStartupMessages) {
      return;
    }

    const errors = startupMessages
      .filter((m) => m.type === "error")
      .map((m) => m.message);

    startupMessages.length = 0; // Clear the array
    hasDisplayedStartupMessages = true;

    if (errors.length > 0) {
      ctx.ui.notify(
        `Remote model loading errors:\n${errors.join("\n")}`,
        "error",
      );
    }
  });

  // Reload command with full UI feedback
  pi.registerCommand("reload-remote-providers", {
    description: "Reload remote vLLM providers without restart",
    handler: async (_args, ctx) => {
      await registerRemoteProviders(ctx);
    },
  });
}
