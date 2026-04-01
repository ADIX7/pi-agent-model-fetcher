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

interface ServerConfig {
  url: string;
  apiKey?: string;
  optional?: boolean;
}

interface Settings {
  "remote-providers"?: {
    [name: string]: ServerConfig;
  };
}

interface VLLMModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
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

  return response.json().then(r => r.data) as Promise<VLLMModelInfo[]>;
}

export default function (pi: ExtensionAPI) {
  // Track registered server names for cleanup
  const registeredServers = new Set<string>();

  async function registerRemoteProviders(ctx: ExtensionContext): Promise<void> {
    const settings = parseSettings();

    if (!settings?.["remote-providers"]) {
      ctx.ui.notify(
        "No remote-providers configured in settings.json.",
        "error",
      );
      return;
    }

    // Unregister existing providers first
    for (const serverName of registeredServers) {
      pi.unregisterProvider(serverName);
    }
    registeredServers.clear();

    const requiredErrors: string[] = [];
    const optionalErrors: string[] = [];

    for (const [serverName, config] of Object.entries(
      settings["remote-providers"],
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

        const models: Model<Api>[] = modelData.map((m) => ({
          id: m.id,
          name: m.id,
          api: "openai-completions" as Api,
          provider: serverName,
          baseUrl: config.url,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }));

        const streamFn = createStreamWrapper(config.apiKey);

        pi.registerProvider(serverName, {
          baseUrl: config.url,
          apiKey: config.apiKey ? `env:${config.apiKey}` : "placeholder",
          api: "openai-completions",
          models,
          streamSimple: streamFn,
        });

        registeredServers.add(serverName);

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
  pi.defineCommand({
    name: "reload-remote-providers",
    description: "Reload remote vLLM providers without restart",
    handler: async () => {
      const context = pi.getContext();
      if (!context) {
        console.error("Extension context not available");
        return;
      }
      await registerRemoteProviders(context);
    },
  });
}
