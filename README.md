# Remote vLLM Provider Plugin

A pi agent plugin that connects to multiple vLLM instances, queries available models from each, and dynamically registers them as providers using the OpenAI-compatible streaming API.

## Configuration

Add the following to your `~/.pi/agent/settings.json`:

```json
{
  "remote-providers": {
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
```

### Fields

- `remote-providers` (required): Object with server names as keys
  - Each server config contains:
    - `url` (required): The URL of your vLLM instance
    - `apiKey` (optional): API key for authentication
    - `optional` (optional): If true, server errors won't block registration. Useful for non-critical providers.
- Server names become provider prefixes (e.g., `local/model-name`, `remote-cluster/model-name`)

## Usage

1. Start your vLLM instances
2. Configure `settings.json` with all server endpoints
3. Restart pi agent or run `/reload`
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
```

With `optional: true`, the backup provider will be skipped silently if unreachable, without showing error notifications.

## Troubleshooting

- **Error: "No remote-providers configured"**: Add `remote-providers` object to `~/.pi/agent/settings.json`
- **Error: "Failed to register N server(s)"**: Check that unreachable servers are running and URLs are correct
- **Warning: "No models found"**: Server is reachable but has no models loaded

## How It Works

1. On `session_start`, reads `~/.pi/agent/settings.json`
2. Iterates over `remote-providers` object
3. Fetches models from each server's `/v1/models` endpoint
4. Skips servers with no models (warning only)
5. Wraps `streamSimpleOpenAICompletions` with server-specific API key
6. Registers each server as a distinct provider
7. Shows error notification if any servers fail

## License

MIT
