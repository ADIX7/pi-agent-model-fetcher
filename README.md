# vLLM Model Fetcher Plugin

A pi agent plugin that connects to a locally hosted vLLM instance, queries available models, and dynamically registers them as providers using the OpenAI-compatible streaming API.

## Configuration

Add the following to your `~/.pi/agent/settings.json`:

```json
{
  "vllm": {
    "baseUrl": "http://localhost:8000",
    "apiKey": "your-api-key"
  }
}
```

### Fields

- `baseUrl` (required): The URL of your vLLM instance (e.g., `http://localhost:8000`)
- `apiKey` (optional): API key for authentication with your vLLM instance

## Usage

1. Ensure your vLLM instance is running and accessible
2. Configure `settings.json` as shown above
3. Restart pi agent or run `/reload` to load the plugin
4. Use `/model` to select a vLLM model

The plugin will:
- Fetch available models from `GET /v1/models`
- Register them under the `vllm/` provider prefix
- Use `streamSimpleOpenAICompletions` for streaming responses

## Example

```bash
# Start vLLM
vllm serve meta-llama/Meta-Llama-3.1-8B-Instruct

# In pi agent, run:
/model
# Select: vllm/meta-llama/Meta-Llama-3.1-8B-Instruct
```

## Troubleshooting

- **Error: "vLLM configuration not found"**: Add `vllm` section to `~/.pi/agent/settings.json`
- **Error: "Failed to connect to vLLM"**: Check that your vLLM instance is running and the URL is correct
- **Error: "No models found"**: Your vLLM instance has no models loaded

## How It Works

1. On `session_start`, reads `~/.pi/agent/settings.json`
2. Fetches models from `{baseUrl}/v1/models`
3. Wraps `streamSimpleOpenAICompletions` to inject the vLLM API key
4. Registers provider with all discovered models

## License

MIT
