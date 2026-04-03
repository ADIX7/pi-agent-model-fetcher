import { streamSimpleOpenAICompletions, } from "@mariozechner/pi-ai";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
function parseSettings() {
    try {
        const fs = require("fs");
        const agentDir = getAgentDir();
        const settingsPath = `${agentDir}/settings.json`;
        const content = fs.readFileSync(settingsPath, "utf-8");
        return JSON.parse(content);
    }
    catch (error) {
        return null;
    }
}
async function fetchVLLMModels(baseUrl, apiKey) {
    const headers = {
        "Content-Type": "application/json",
    };
    if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const response = await fetch(`${baseUrl}/models`, { headers });
    if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }
    return response.json().then(r => r.data);
}
function matchPatterns(modelId, patterns) {
    return Object.entries(patterns)
        .filter(([pattern]) => {
        if (pattern === modelId) {
            return true;
        }
        if (pattern.endsWith("/*")) {
            const prefix = pattern.slice(0, -2);
            return modelId.startsWith(`${prefix}/`);
        }
        return false;
    })
        .map(([, options]) => options);
}
function mergeOptions(base, override) {
    return {
        ...base,
        ...override,
    };
}
export default function (pi) {
    async function registerRemoteProviders(ctx) {
        const settings = parseSettings();
        if (!settings?.["remote-providers"]?.providers) {
            ctx.ui.notify("No providers configured in settings.json.", "error");
            return;
        }
        const requiredErrors = [];
        const optionalErrors = [];
        for (const [serverName, config] of Object.entries(settings["remote-providers"]?.providers)) {
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
                const globalModelOptions = settings["remote-providers"]?.modelOptions ?? {};
                const models = modelData.map((m) => {
                    const defaults = {
                        maxTokens: 16384,
                        reasoning: false,
                        input: ["text"],
                        contextWindow: 128000,
                    };
                    const globalOptions = matchPatterns(m.id, globalModelOptions).reduce(mergeOptions, {});
                    const providerOptions = matchPatterns(m.id, config.modelOptions ?? {}).reduce(mergeOptions, {});
                    const finalOptions = mergeOptions(mergeOptions(defaults, globalOptions), providerOptions);
                    return {
                        id: m.id,
                        name: m.id,
                        api: "openai-completions",
                        provider: serverName,
                        baseUrl: config.url,
                        reasoning: finalOptions.reasoning ?? false,
                        contextWindow: finalOptions.contextWindow ?? 128000,
                        maxTokens: finalOptions.maxTokens ?? 16384,
                        input: finalOptions.input ?? ["text"],
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
                ctx.ui.notify(`${serverName}: Registered ${models.length} model(s)`, "info");
            }
            catch (error) {
                const errorMsg = `${serverName}: ${error instanceof Error ? error.message : String(error)}`;
                if (config.optional) {
                    optionalErrors.push(errorMsg);
                }
                else {
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
    function createStreamWrapper(apiKey) {
        return (model, context, options) => {
            return streamSimpleOpenAICompletions(model, context, {
                ...options,
                apiKey: apiKey ?? options?.apiKey ?? "placeholder",
            });
        };
    }
    // Register providers from settings
    pi.on("session_start", async (_event, ctx) => {
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
//# sourceMappingURL=index.js.map