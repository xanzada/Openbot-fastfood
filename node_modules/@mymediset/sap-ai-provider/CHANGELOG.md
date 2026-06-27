# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

**Documentation:**
- Comprehensive JSDoc comments throughout codebase for better IDE support
- API_REFERENCE.md with complete API documentation
- MIGRATION_GUIDE.md for version upgrade guidance
- Enhanced ARCHITECTURE.md with v2 API details
- Table of Contents in README.md for improved navigation
- Quick Start section in README.md
- Troubleshooting guide with common issues and solutions
- Performance & Best Practices section
- Security best practices documentation
- Debug mode instructions

**Features:**
- Orchestration v2 API support
  - Request body built under `config.modules.prompt_templating`
  - Response schemas aligned to v2 (`intermediate_results`, `final_result`)
  - Tool calls surfaced via `tool_calls` in choices and stream deltas
  - `messages_history` support in request schema
  - `output_unmasking` in intermediate results
- Data masking with SAP Data Privacy Integration (DPI)
  - Anonymization and pseudonymization support
  - Standard and custom entity detection
  - Allowlist configuration
- Response format control
  - `SAPAISettings.responseFormat` for text/json/json_schema
  - Default to `{ type: "text" }` when no tools are used
- `createSAPAIProviderSync` for synchronous initialization with token
- `defaultSettings` option for provider-wide configuration
- `completionPath` option for custom endpoint paths
- Enhanced error messages with `intermediateResults`
- Improved streaming support with better error handling

**Examples:**
- New streaming example: `examples/example-streaming-chat.ts`
- Updated examples to reflect v2 API and new features
- Data masking example: `examples/example-data-masking.ts`

### Changed

**API:**
- Default endpoint: `${baseURL}/inference/deployments/{deploymentId}/v2/completion`
- Legacy v1 endpoint support maintained for backward compatibility
- Enhanced `SAPAIError` with `intermediateResults` property
- Improved type definitions with better JSDoc

**Documentation:**
- Enhanced documentation for all public interfaces
- More detailed error handling examples
- Expanded configuration options documentation
- Better model selection guidance
- Real-world code examples

### Deprecated

- v1 completion endpoint (`POST /completion`) - Decommission on October 31, 2026
- Use v2 endpoint (`POST /v2/completion`) instead (default)

### Fixed

- Improved error messages for authentication failures
- Better handling of v1/v2 API fallback
- Enhanced stream processing reliability

---

## [1.0.3] - 2024-01-XX

### Added
- Support for multiple SAP AI Core model types
- OAuth2 authentication with automatic token management
- Streaming support for real-time text generation
- Tool calling capabilities for function integration
- Multi-modal input support (text + images)
- Structured output support with JSON schemas
- Comprehensive error handling with automatic retries
- TypeScript support with full type safety

### Features
- Integration with Vercel AI SDK v5
- Support for 40+ AI models including GPT-4, Claude, Gemini
- Automatic service key parsing and authentication
- Configurable deployment and resource group settings
- Custom fetch implementation support
- Built-in error recovery and retry logic

### Initial Release
- Core SAP AI Core provider implementation
- Basic documentation and examples
- Test suite with comprehensive coverage
- Build configuration with TypeScript support
- Package configuration for npm publishing