# SAP AI Core Provider for Vercel AI SDK

[![npm](https://img.shields.io/npm/v/@mymediset/sap-ai-provider/latest?label=npm&color=blue)](https://www.npmjs.com/package/@mymediset/sap-ai-provider)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A community provider for SAP AI Core that integrates seamlessly with the Vercel AI SDK. Built on top of the official **@sap-ai-sdk/orchestration** package, this provider enables you to use SAP's enterprise-grade AI models through the familiar Vercel AI SDK interface.

## ⚠️ Breaking Changes in v2.0

Version 2.0 is a complete rewrite using the official SAP AI SDK. Key changes:

- **Authentication**: Now uses `AICORE_SERVICE_KEY` environment variable (SAP AI SDK standard)
- **Provider creation**: Now synchronous - `createSAPAIProvider()` instead of `await createSAPAIProvider()`
- **No more `serviceKey` option**: Authentication is handled automatically by the SAP AI SDK
- **New helper functions**: Use `buildDpiMaskingProvider()`, `buildAzureContentSafetyFilter()` etc. from the SDK

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Authentication](#authentication)
- [Basic Usage](#basic-usage)
- [Supported Models](#supported-models)
- [Advanced Features](#advanced-features)
- [Configuration Options](#configuration-options)
- [Error Handling](#error-handling)
- [Examples](#examples)
- [Migration from v1](#migration-from-v1)
- [Contributing](#contributing)
- [License](#license)

## Features

- 🔐 **Automatic Authentication** - Uses SAP AI SDK's built-in credential handling
- 🎯 **Tool Calling Support** - Full function calling capabilities
- 🖼️ **Multi-modal Input** - Support for text and image inputs
- 📡 **Streaming Support** - Real-time text generation
- 🔒 **Data Masking** - Built-in SAP DPI integration for privacy
- 🛡️ **Content Filtering** - Azure Content Safety and Llama Guard support
- 🔧 **TypeScript Support** - Full type safety and IntelliSense
- 🎨 **Multiple Models** - Support for GPT-4, Claude, Gemini, Nova, and more

## Quick Start

```bash
npm install @mymediset/sap-ai-provider ai
```

```typescript
import { createSAPAIProvider } from "@mymediset/sap-ai-provider";
import { generateText } from "ai";

// Create provider (authentication via AICORE_SERVICE_KEY env var)
const provider = createSAPAIProvider();

// Generate text with gpt-4o
const result = await generateText({
  model: provider("gpt-4o"),
  prompt: "Explain quantum computing in simple terms.",
});

console.log(result.text);
```

## Installation

**Requirements:** Node.js 18+ and Vercel AI SDK 6.0+

```bash
npm install @mymediset/sap-ai-provider ai
```

Or with other package managers:

```bash
# Yarn
yarn add @mymediset/sap-ai-provider ai

# pnpm
pnpm add @mymediset/sap-ai-provider ai
```

## Authentication

The SAP AI SDK handles authentication automatically. You need to provide credentials in one of these ways:

### On SAP BTP (Recommended)

When running on SAP BTP, bind an AI Core service instance to your application. The SDK will automatically detect the service binding from `VCAP_SERVICES`.

### Local Development

Set the `AICORE_SERVICE_KEY` environment variable with your service key JSON:

```bash
# .env
AICORE_SERVICE_KEY='{"serviceurls":{"AI_API_URL":"https://..."},"clientid":"...","clientsecret":"...","url":"..."}'
```

Get your service key from SAP BTP:

1. Go to your SAP BTP Cockpit
2. Navigate to your AI Core instance
3. Create a service key
4. Copy the JSON and set it as the environment variable

## Basic Usage

### Text Generation

```typescript
import { createSAPAIProvider } from "@mymediset/sap-ai-provider";
import { generateText } from "ai";

const provider = createSAPAIProvider();

const result = await generateText({
  model: provider("gpt-4o"),
  prompt: "Write a short story about a robot learning to paint.",
});

console.log(result.text);
```

### Chat Conversations

```typescript
import { generateText } from "ai";

const result = await generateText({
  model: provider("anthropic--claude-3.5-sonnet"),
  messages: [
    { role: "system", content: "You are a helpful coding assistant." },
    {
      role: "user",
      content: "How do I implement binary search in TypeScript?",
    },
  ],
});
```

### Streaming Responses

```typescript
import { streamText } from "ai";

const result = streamText({
  model: provider("gpt-4o"),
  prompt: "Explain machine learning concepts.",
});

for await (const delta of result.textStream) {
  process.stdout.write(delta);
}
```

### Model Configuration

```typescript
const model = provider("gpt-4o", {
  modelParams: {
    temperature: 0.3,
    maxTokens: 2000,
    topP: 0.9,
  },
});

const result = await generateText({
  model,
  prompt: "Write a technical blog post about TypeScript.",
});
```

## Supported Models

### Azure OpenAI Models

- `gpt-4o`, `gpt-4o-mini`
- `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`
- `o1`, `o3`, `o3-mini`, `o4-mini`

### Google Vertex AI Models

- `gemini-2.0-flash`, `gemini-2.0-flash-lite`
- `gemini-2.5-flash`, `gemini-2.5-pro`

### AWS Bedrock Models

- `anthropic--claude-3-haiku`, `anthropic--claude-3-sonnet`, `anthropic--claude-3-opus`
- `anthropic--claude-3.5-sonnet`, `anthropic--claude-3.7-sonnet`
- `anthropic--claude-4-sonnet`, `anthropic--claude-4-opus`
- `amazon--nova-pro`, `amazon--nova-lite`, `amazon--nova-micro`, `amazon--nova-premier`

### AI Core Open Source Models

- `mistralai--mistral-large-instruct`, `mistralai--mistral-medium-instruct`, `mistralai--mistral-small-instruct`
- `cohere--command-a-reasoning`

Model availability depends on your SAP AI Core subscription and region.

## Advanced Features

### Tool Calling

```typescript
import { generateText, tool } from "ai";
import { z } from "zod";

const weatherSchema = z.object({
  location: z.string(),
});

const weatherTool = tool({
  description: "Get weather for a location",
  inputSchema: weatherSchema,
  execute: (args: z.infer<typeof weatherSchema>) => {
    const { location } = args;
    return `Weather in ${location}: sunny, 72°F`;
  },
});

const result = await generateText({
  model: provider("gpt-4o"),
  prompt: "What's the weather in Tokyo?",
  tools: { getWeather: weatherTool },
  maxSteps: 3,
});

console.log(result.text);
```

### Multi-modal Input (Images)

```typescript
const result = await generateText({
  model: provider("gpt-4o"),
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What do you see in this image?" },
        { type: "image", image: new URL("https://example.com/image.jpg") },
      ],
    },
  ],
});
```

### Data Masking (SAP DPI)

Use SAP's Data Privacy Integration to mask sensitive data:

```typescript
import {
  createSAPAIProvider,
  buildDpiMaskingProvider,
} from "@mymediset/sap-ai-provider";

const dpiConfig = buildDpiMaskingProvider({
  method: "anonymization",
  entities: [
    "profile-email",
    "profile-person",
    {
      type: "profile-phone",
      replacement_strategy: { method: "constant", value: "REDACTED" },
    },
  ],
});

const provider = createSAPAIProvider({
  defaultSettings: {
    masking: {
      masking_providers: [dpiConfig],
    },
  },
});

const result = await generateText({
  model: provider("gpt-4o"),
  prompt: "Email john@example.com about the meeting.",
});
```

### Content Filtering

```typescript
import {
  createSAPAIProvider,
  buildAzureContentSafetyFilter,
} from "@mymediset/sap-ai-provider";

const provider = createSAPAIProvider({
  defaultSettings: {
    filtering: {
      input: {
        filters: [
          buildAzureContentSafetyFilter("input", {
            hate: "ALLOW_SAFE",
            violence: "ALLOW_SAFE_LOW_MEDIUM",
          }),
        ],
      },
    },
  },
});
```

## Configuration Options

### Provider Settings

```typescript
interface SAPAIProviderSettings {
  resourceGroup?: string; // SAP AI Core resource group (default: 'default')
  deploymentId?: string; // Specific deployment ID (auto-resolved if not set)
  destination?: HttpDestinationOrFetchOptions; // Custom destination
  defaultSettings?: SAPAISettings; // Default settings for all models
}
```

### Model Settings

```typescript
interface SAPAISettings {
  modelVersion?: string; // Model version (default: 'latest')
  modelParams?: {
    maxTokens?: number; // Maximum tokens to generate
    temperature?: number; // Sampling temperature (0-2)
    topP?: number; // Nucleus sampling (0-1)
    frequencyPenalty?: number; // Frequency penalty (-2 to 2)
    presencePenalty?: number; // Presence penalty (-2 to 2)
    n?: number; // Number of completions
    parallel_tool_calls?: boolean; // Enable parallel tool calls
  };
  masking?: MaskingModule; // Data masking configuration
  filtering?: FilteringModule; // Content filtering configuration
}
```

## Error Handling

```typescript
import { SAPAIError } from "@mymediset/sap-ai-provider";

try {
  const result = await generateText({
    model: provider("gpt-4o"),
    prompt: "Hello world",
  });
} catch (error) {
  if (error instanceof SAPAIError) {
    console.error("Code:", error.code);
    console.error("Location:", error.location);
    console.error("Request ID:", error.requestId);
  }
}
```

## Examples

Check out the [examples directory](./examples) for complete working examples:

- [Simple Chat Completion](./examples/example-simple-chat-completion.ts)
- [Tool Calling](./examples/example-chat-completion-tool.ts)
- [Image Recognition](./examples/example-image-recognition.ts)
- [Text Generation](./examples/example-generate-text.ts)
- [Data Masking](./examples/example-data-masking.ts)
- [Streaming](./examples/example-streaming-chat.ts)

## Migration from v1

### Authentication

**Before (v1):**

```typescript
const provider = await createSAPAIProvider({
  serviceKey: process.env.SAP_AI_SERVICE_KEY,
});
```

**After (v2):**

```typescript
// Set AICORE_SERVICE_KEY env var instead
const provider = createSAPAIProvider();
```

### Masking Configuration

**Before (v1):**

```typescript
const dpiMasking = {
  type: "sap_data_privacy_integration",
  method: "anonymization",
  entities: [{ type: "profile-email" }],
};
```

**After (v2):**

```typescript
import { buildDpiMaskingProvider } from "@mymediset/sap-ai-provider";

const dpiMasking = buildDpiMaskingProvider({
  method: "anonymization",
  entities: ["profile-email"],
});
```

### Provider is now synchronous

**Before (v1):**

```typescript
const provider = await createSAPAIProvider({ serviceKey });
```

**After (v2):**

```typescript
const provider = createSAPAIProvider();
```

## Important Note

> **Third-Party Provider**: This SAP AI Core provider (`@mymediset/sap-ai-provider`) is developed and maintained by mymediset, not by SAP SE. While it uses the official SAP AI SDK and integrates with SAP AI Core services, it is not an official SAP product.

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## License

Apache License 2.0 - see [LICENSE](LICENSE.md) for details.

## Support

- 📖 [Documentation](https://github.com/BITASIA/sap-ai-provider)
- 🐛 [Issue Tracker](https://github.com/BITASIA/sap-ai-provider/issues)

## Related

- [Vercel AI SDK](https://sdk.vercel.ai/) - The AI SDK this provider extends
- [SAP AI SDK](https://sap.github.io/ai-sdk/) - Official SAP Cloud SDK for AI
- [SAP AI Core Documentation](https://help.sap.com/docs/ai-core) - Official SAP AI Core docs
