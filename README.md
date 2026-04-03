# Remote vLLM Provider Plugin

A pi agent plugin that connects to multiple vLLM instances, queries available models from each, and dynamically registers them as providers using the OpenAI-compatible streaming API.

## Configuration

Add the following to your `~/.pi/agent/settings.json`:

```json
{
  "remote-providers": {
    "providers": {
      "local": {
        "url": "http://localhost:8000",
        "apiKey": "your-api-key"
      },
      "remote-cluster": {
        "url": "https://vllm.company.com",
        "apiKey": "another-key"
      }
    }
  }
}
```

### Fields

- `remote-providers` (required): Object containing `providers` map and optional `model-options`
  - `providers` (required): Object with server names as keys
    - Each server config contains:
      - `url` (required): The URL of your vLLM instance
      - `apiKey` (optional): API key for authentication
      - `optional` (optional): If true, server errors won't block registration. Useful for non-critical providers.
      - `model-options` (optional): Pattern-matched model options for this provider
  - `model-options` (optional): Global pattern-matched model options
- Server names become provider prefixes (e.g., `local/model-name`, `remote-cluster/model-name`)

### Model Options

Model options define model behavior. Available options:

- `maxTokens` (optional): Maximum tokens per generation (default: 16384)
- `contextWindow` (optional): Context window size in tokens (default: 128000)
- `reasoning` (optional): Whether model has reasoning capabilities (default: false)
- `input` (optional): Input modalities (default: `["text"]`)

Options use pattern matching under `remote-providers.model-options` (global) or `remote-providers.providers.[name].model-options` (provider-specific):

- **Exact match**: `"meta-llama/Meta-Llama-3.1-8B-Instruct": { ... }`
- **Wildcard pattern**: `"Qwen/*": { ... }` matches any model starting with `Qwen/`
- Wildcard `*` must be at the end only

**Priority (lowest → highest):**
1. Hardcoded defaults
2. Global `model-options` patterns
3. Provider `model-options` patterns

Patterns match against model IDs from vLLM API (no provider prefix).

### Global Model Options Example

```json
{
  "remote-providers": {
    "model-options": {
      "meta-llama/Meta-Llama-3.1-8B-Instruct": {
        "reasoning": true,
        "contextWindow": 131072
      },
      "Qwen/*": {
        "maxTokens": 65536
      }
    }
  }
}
```

### Provider-Specific Model Options Example

```json
{
  "remote-providers": {
    "providers": {
      "grace": {
        "url": "http://172.16.0.23:8000/v1",
        "model-options": {
          "meta-llama/Meta-Llama-3.1-8B-Instruct": {
            "reasoning": true,
            "contextWindow": 131072
          },
          "Qwen/*": {
            "maxTokens": 65536
          }
        }
      }
    }
  }
}
```

## Usage

1. Start your vLLM instances
2. Configure `settings.json` with all server endpoints
3. Restart pi agent or run `/reload-remote-providers`
4. Use `/model` to select from available providers

The plugin will:
- Fetch available models from each server's `GET /v1/models`
- Register each server as a distinct provider
- Skip servers with no models
- Report errors for unreachable servers

## Example

```bash
# Start local vLLM
vllm serve meta-llama/Meta-Llama-3.1-8B-Instruct --port 8000

# In pi agent:
/model
# Select from: local/meta-llama/Meta-Llama-3.1-8B-Instruct
#              remote-cluster/other-model
```

### Optional Providers

Set `optional: true` for providers that shouldn't block startup if unavailable:

```json
{
  "remote-providers": {
    "providers": {
      "local": {
        "url": "http://localhost:8000",
        "apiKey": "your-api-key"
      },
      "backup": {
        "url": "https://backup-vllm.example.com",
        "apiKey": "backup-key",
        "optional": true
      }
    }
  }
}
```

With `optional: true`, the backup provider will be skipped silently if unreachable, without showing error notifications.

## Reload Providers

You can reload remote providers without restarting the pi agent:

```bash
/reload-remote-providers
```

This command:
- Re-reads `settings.json`
- Re-fetches models from all configured servers
- Re-registers providers with updated models
- Shows notifications for any errors

Use this after:
- Adding/removing servers from `settings.json`
- Loading/unloading models on remote servers
- Updating API keys
- Changing model-options configurations

## Troubleshooting

- **Error: "No providers configured in settings.json."**: Add `remote-providers.providers` to `~/.pi/agent/settings.json`
- **Error: "Failed to register N server(s)"**: Check that unreachable servers are running and URLs are correct
- **Warning: "No models found"**: Server is reachable but has no models loaded
- **Reload not working**: Ensure you're using pi agent version 0.51+ which supports custom commands

## How It Works

1. On `session_start`, reads `~/.pi/agent/settings.json`
2. Iterates over the `remote-providers.providers` object
3. Fetches models from each server's `/v1/models` endpoint
4. Skips servers with no models (warning only)
5. Wraps `streamSimpleOpenAICompletions` with server-specific API key
6. Registers each server as a distinct provider
7. Shows error notification if any servers fail

## License

MIT
