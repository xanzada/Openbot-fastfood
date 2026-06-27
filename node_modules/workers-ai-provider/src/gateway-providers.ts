/**
 * Registry of Cloudflare AI Gateway providers.
 *
 * One table drives both delegate surfaces:
 *
 *   - **Slug delegate** (`wai("openai/gpt-5")`): `resolverKey` is the slug prefix
 *     the user types. `runCatalog` providers dispatch through the resumable run
 *     path (`env.AI.run`, unified billing, `cf-aig-run-id`); the rest go through
 *     the gateway path (`env.AI.gateway().run`, BYOK, no resume). `wireFormat`
 *     selects the built-in `@ai-sdk/*` parser; absent ⇒ the provider is reachable
 *     only via the bring-your-own-provider wrapper (it isn't chat/completions
 *     shaped, e.g. audio/image providers).
 *   - **Bring-your-own-provider** (`createGatewayProvider`): `hostPattern` +
 *     `transformEndpoint` map a wrapped provider's request URL to the gateway
 *     `provider` id + endpoint path.
 *
 * Slugs mirror the AI Gateway provider directory
 * (developers.cloudflare.com/ai-gateway/usage/providers/); endpoint transforms
 * mirror `ai-gateway-provider`'s provider table. `runCatalog` / `billing` flags
 * follow the documented unified-billing list (OpenAI, Anthropic, Google AI
 * Studio, Google Vertex, xAI/Grok, Groq) and are otherwise conservative — the
 * e2e suite confirms them live, since resume is undocumented upstream.
 */

/** Response wire format the slug delegate can parse with a built-in `@ai-sdk/*` provider. */
export type WireFormat = "openai" | "anthropic" | "google";

/** How a provider is billed + keyed when reached through the gateway. */
export type Billing = "unified" | "byok";

export interface GatewayProviderInfo {
	/**
	 * Slug prefix the user types in `wai("<resolverKey>/<model>")`. For
	 * `runCatalog` providers this is also the run-catalog author (so
	 * `env.AI.run("<resolverKey>/<model>")` resolves).
	 */
	resolverKey: string;
	/** Provider id for the gateway universal endpoint (`env.AI.gateway().run([{ provider }])`). */
	gatewayProviderId: string;
	/**
	 * Built-in parser wire format. `openai` covers the whole OpenAI-compatible
	 * long tail (deepseek, grok, groq, mistral, perplexity, …). Absent ⇒ reachable
	 * only via the bring-your-own-provider wrapper (provider-native, non-chat, or a
	 * gateway-path URL shape we don't reproduce reliably from the slug delegate).
	 */
	wireFormat?: WireFormat;
	/**
	 * Wire format the unified-billing **run path** (`env.AI.run`) emits for this
	 * provider — which is NOT always the provider's native format. Cloudflare's
	 * unified catalog normalizes most providers to OpenAI chat-completions (so
	 * `google` is parsed with the `openai` plugin on the run path), but passes
	 * **Anthropic through natively** (`content[].text`, native tool shape), so
	 * anthropic must be parsed with the `anthropic` plugin. Defaults to `"openai"`
	 * for run-catalog providers when omitted. Only meaningful when `runCatalog`.
	 */
	runWireFormat?: WireFormat;
	/**
	 * Base URL the wire-format builder should target so the request URL it
	 * generates host-strips (via {@link transformEndpoint}) to the provider's
	 * gateway-native endpoint. Omit to use the `@ai-sdk` provider's default (the
	 * provider's own host — correct for `openai`/`anthropic`/`google`). Required
	 * for OpenAI-wire providers that share the `openai` plugin but live on a
	 * different host (deepseek, grok, groq, mistral, perplexity, …).
	 */
	baseURL?: string;
	/** On the unified-billing resumable run catalog (`env.AI.run`, `cf-aig-run-id`). */
	runCatalog: boolean;
	/**
	 * Whether the provider has a gateway path (`env.AI.gateway().run`). `false` ⇒
	 * **run-path only**: the provider is on the unified run catalog but is not a
	 * native gateway provider, so caching, server-side fallback, and
	 * `transport: "gateway"` are unavailable and the delegate rejects them with a
	 * clear error (rather than failing upstream). Defaults to `true`.
	 */
	gatewayPath?: boolean;
	/** Billing model when reached through the gateway. */
	billing: Billing;
	/** Header(s) carrying the upstream provider key (stripped on the gateway path unless BYOK-forwarded). */
	authHeaders: string[];
	/** Host matcher for bring-your-own-provider URL detection. */
	hostPattern?: RegExp;
	/** Strip the provider host, leaving the gateway endpoint path (+ query). */
	transformEndpoint?: (url: string) => string;
}

/** Strip a leading `https://<host>/` prefix, leaving the endpoint path + query. */
function hostStrip(pattern: RegExp): (url: string) => string {
	return (url: string) => url.replace(pattern, "");
}

const OPENAI_HOST = /^https:\/\/api\.openai\.com\//;
const ANTHROPIC_HOST = /^https:\/\/api\.anthropic\.com\//;
const GOOGLE_HOST = /^https:\/\/generativelanguage\.googleapis\.com\//;
const VERTEX_HOST = /^https:\/\/(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com\//;
const XAI_HOST = /^https:\/\/api\.x\.ai\//;
const GROQ_HOST = /^https:\/\/api\.groq\.com\/openai\/v1\//;
const DEEPSEEK_HOST = /^https:\/\/api\.deepseek\.com\//;
const MISTRAL_HOST = /^https:\/\/api\.mistral\.ai\//;
const PERPLEXITY_HOST = /^https:\/\/api\.perplexity\.ai\//;
const CEREBRAS_HOST = /^https:\/\/api\.cerebras\.ai\//;
const OPENROUTER_HOST = /^https:\/\/openrouter\.ai\/api\//;
const FIREWORKS_HOST = /^https:\/\/api\.fireworks\.ai\/inference\/v1\//;
const COHERE_HOST = /^https:\/\/api\.cohere\.(?:com|ai)\//;
const REPLICATE_HOST = /^https:\/\/api\.replicate\.com\//;
const HUGGINGFACE_HOST = /^https:\/\/api-inference\.huggingface\.co\/models\//;
const CARTESIA_HOST = /^https:\/\/api\.cartesia\.ai\//;
const FAL_HOST = /^https:\/\/fal\.run\//;
const IDEOGRAM_HOST = /^https:\/\/api\.ideogram\.ai\//;
const DEEPGRAM_HOST = /^https:\/\/api\.deepgram\.com\//;
const ELEVENLABS_HOST = /^https:\/\/api\.elevenlabs\.io\//;
const GROK_KEY = "grok";

// Bedrock's URL carries the AWS region, which the gateway endpoint preserves as
// `bedrock-runtime/<region>/<rest>` (mirrors ai-gateway-provider).
const BEDROCK_HOST = /^https:\/\/bedrock-runtime\.(?<region>[^.]+)\.amazonaws\.com\//;
function bedrockTransform(url: string): string {
	const m = url.match(
		/^https:\/\/bedrock-runtime\.(?<region>[^.]+)\.amazonaws\.com\/(?<rest>.*)$/,
	);
	if (!m?.groups) return url;
	const { region, rest } = m.groups;
	if (!region || rest === undefined) return url;
	return `bedrock-runtime/${region}/${rest}`;
}

// Azure's URL carries the resource + deployment, so it needs a bespoke transform
// (mirrors ai-gateway-provider). Only used for bring-your-own-provider detection.
const AZURE_HOST =
	/^https:\/\/(?<resource>[^.]+)\.openai\.azure\.com\/openai\/deployments\/(?<deployment>[^/]+)\/(?<rest>.*)$/;
function azureTransform(url: string): string {
	const m = url.match(AZURE_HOST);
	if (!m?.groups) return url;
	const { resource, deployment, rest } = m.groups;
	if (!resource || !deployment || !rest) return url;
	return `${resource}/${deployment}/${rest}`;
}

/**
 * The provider table. Order matters only for `detectProviderByUrl` (first match
 * wins); slugs are looked up by `resolverKey`.
 */
export const GATEWAY_PROVIDERS: GatewayProviderInfo[] = [
	// ---- Unified-billing run-catalog providers (resumable run path) ----
	{
		resolverKey: "openai",
		gatewayProviderId: "openai",
		wireFormat: "openai",
		runCatalog: true,
		billing: "unified",
		authHeaders: ["authorization"],
		hostPattern: OPENAI_HOST,
		transformEndpoint: hostStrip(OPENAI_HOST),
	},
	{
		resolverKey: "anthropic",
		gatewayProviderId: "anthropic",
		wireFormat: "anthropic",
		// Unified billing passes Anthropic through natively (unlike google, which it
		// normalizes to openai-wire), so the run path also speaks Anthropic Messages.
		runWireFormat: "anthropic",
		runCatalog: true,
		billing: "unified",
		authHeaders: ["x-api-key", "authorization"],
		hostPattern: ANTHROPIC_HOST,
		transformEndpoint: hostStrip(ANTHROPIC_HOST),
	},
	{
		resolverKey: "google",
		gatewayProviderId: "google-ai-studio",
		// Gateway path hits Gemini's native endpoint (google-wire); the unified run
		// path, however, returns openai-wire — so runWireFormat defaults to "openai".
		wireFormat: "google",
		runCatalog: true,
		billing: "unified",
		authHeaders: ["x-goog-api-key", "authorization"],
		hostPattern: GOOGLE_HOST,
		transformEndpoint: hostStrip(GOOGLE_HOST),
	},
	{
		resolverKey: "xai",
		gatewayProviderId: GROK_KEY,
		wireFormat: "openai",
		// Targeted so a forced gateway-path request host-strips correctly (the run
		// path, the default for xai, ignores this).
		baseURL: "https://api.x.ai/v1",
		runCatalog: true,
		billing: "unified",
		authHeaders: ["authorization"],
		hostPattern: XAI_HOST,
		transformEndpoint: hostStrip(XAI_HOST),
	},
	{
		resolverKey: "groq",
		gatewayProviderId: "groq",
		wireFormat: "openai",
		// Groq's gateway-native endpoint strips `/openai/v1/`, so the builder must
		// target that base or a forced gateway request doubles the prefix.
		baseURL: "https://api.groq.com/openai/v1",
		runCatalog: true,
		billing: "unified",
		authHeaders: ["authorization"],
		hostPattern: GROQ_HOST,
		transformEndpoint: hostStrip(GROQ_HOST),
	},
	// Unified-catalog chat providers that are NOT in the native gateway directory:
	// they exist only on the resumable run path (env.AI.run, unified billing), so
	// there's no BYOK gateway path. Both return OpenAI chat-completions wire (so the
	// `openai` plugin parses them) and emit `cf-aig-run-id` on streams (resumable),
	// verified live against the default gateway. Forcing transport:"gateway" for
	// these errors upstream (no native provider) — that's expected.
	{
		// Alibaba Qwen, served via DashScope's OpenAI-compatible endpoint.
		resolverKey: "alibaba",
		gatewayProviderId: "alibaba",
		wireFormat: "openai",
		runCatalog: true,
		gatewayPath: false,
		billing: "unified",
		authHeaders: ["authorization"],
	},
	{
		// MiniMax (M-series). OpenAI-wire with extra fields (reasoning_content,
		// audio_content) the openai parser ignores; core choices[].delta.content is standard.
		resolverKey: "minimax",
		gatewayProviderId: "minimax",
		wireFormat: "openai",
		runCatalog: true,
		gatewayPath: false,
		billing: "unified",
		authHeaders: ["authorization"],
	},
	{
		resolverKey: "google-vertex",
		gatewayProviderId: "google-vertex-ai",
		// Vertex's URL carries project/location/publisher segments that the
		// `@ai-sdk/google` default (AI Studio) does not produce, so the slug
		// delegate can't shape it reliably — reach Vertex via createGatewayProvider.
		runCatalog: false,
		billing: "unified",
		authHeaders: ["authorization"],
		hostPattern: VERTEX_HOST,
		transformEndpoint: hostStrip(VERTEX_HOST),
	},

	// ---- OpenAI-compatible long tail (gateway path, BYOK) ----
	{
		resolverKey: "deepseek",
		gatewayProviderId: "deepseek",
		wireFormat: "openai",
		baseURL: "https://api.deepseek.com",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization"],
		hostPattern: DEEPSEEK_HOST,
		transformEndpoint: hostStrip(DEEPSEEK_HOST),
	},
	{
		resolverKey: "mistral",
		gatewayProviderId: "mistral",
		wireFormat: "openai",
		baseURL: "https://api.mistral.ai/v1",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization"],
		hostPattern: MISTRAL_HOST,
		transformEndpoint: hostStrip(MISTRAL_HOST),
	},
	{
		resolverKey: "perplexity",
		gatewayProviderId: "perplexity-ai",
		wireFormat: "openai",
		baseURL: "https://api.perplexity.ai",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization"],
		hostPattern: PERPLEXITY_HOST,
		transformEndpoint: hostStrip(PERPLEXITY_HOST),
	},
	{
		resolverKey: "cerebras",
		gatewayProviderId: "cerebras",
		wireFormat: "openai",
		baseURL: "https://api.cerebras.ai/v1",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization"],
		hostPattern: CEREBRAS_HOST,
		transformEndpoint: hostStrip(CEREBRAS_HOST),
	},
	{
		resolverKey: "openrouter",
		gatewayProviderId: "openrouter",
		wireFormat: "openai",
		baseURL: "https://openrouter.ai/api/v1",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization"],
		hostPattern: OPENROUTER_HOST,
		transformEndpoint: hostStrip(OPENROUTER_HOST),
	},
	{
		// Fireworks is OpenAI-compatible. Present on ai-gateway-provider (#409) but
		// not the current provider directory — treat as BYOK long-tail.
		resolverKey: "fireworks",
		gatewayProviderId: "fireworks",
		wireFormat: "openai",
		baseURL: "https://api.fireworks.ai/inference/v1",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization"],
		hostPattern: FIREWORKS_HOST,
		transformEndpoint: hostStrip(FIREWORKS_HOST),
	},
	// Providers whose gateway-path URL shape isn't reliably reproducible from the
	// shared openai builder (cohere's /compat surface, baseten's per-deployment
	// hosts, parallel, azure's resource/deployment path) are bring-your-own-provider
	// only — set your own @ai-sdk provider baseURL and route via createGatewayProvider.
	{
		resolverKey: "cohere",
		gatewayProviderId: "cohere",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization"],
		hostPattern: COHERE_HOST,
		transformEndpoint: hostStrip(COHERE_HOST),
	},
	{
		// Baseten serves per-deployment hosts, so there's no single detectable URL
		// shape — reach it with an explicit `provider` via createGatewayProvider.
		resolverKey: "baseten",
		gatewayProviderId: "baseten",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization"],
	},
	{
		resolverKey: "parallel",
		gatewayProviderId: "parallel",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization", "x-api-key"],
	},
	{
		resolverKey: "azure-openai",
		gatewayProviderId: "azure-openai",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["api-key", "authorization"],
		hostPattern: AZURE_HOST,
		transformEndpoint: azureTransform,
	},

	// ---- Provider-native only: reachable via the bring-your-own-provider wrapper ----
	// (no `wireFormat` ⇒ not auto-wired by the slug delegate)
	{
		resolverKey: "aws-bedrock",
		gatewayProviderId: "aws-bedrock",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization"],
		hostPattern: BEDROCK_HOST,
		transformEndpoint: bedrockTransform,
	},
	{
		resolverKey: "huggingface",
		gatewayProviderId: "huggingface",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization"],
		hostPattern: HUGGINGFACE_HOST,
		transformEndpoint: hostStrip(HUGGINGFACE_HOST),
	},
	{
		resolverKey: "replicate",
		gatewayProviderId: "replicate",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization"],
		hostPattern: REPLICATE_HOST,
		transformEndpoint: hostStrip(REPLICATE_HOST),
	},
	{
		resolverKey: "fal",
		gatewayProviderId: "fal",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization"],
		hostPattern: FAL_HOST,
		transformEndpoint: hostStrip(FAL_HOST),
	},
	{
		resolverKey: "ideogram",
		gatewayProviderId: "ideogram",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization"],
		hostPattern: IDEOGRAM_HOST,
		transformEndpoint: hostStrip(IDEOGRAM_HOST),
	},
	{
		resolverKey: "cartesia",
		gatewayProviderId: "cartesia",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization", "x-api-key"],
		hostPattern: CARTESIA_HOST,
		transformEndpoint: hostStrip(CARTESIA_HOST),
	},
	{
		resolverKey: "deepgram",
		gatewayProviderId: "deepgram",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["authorization", "token"],
		hostPattern: DEEPGRAM_HOST,
		transformEndpoint: hostStrip(DEEPGRAM_HOST),
	},
	{
		resolverKey: "elevenlabs",
		gatewayProviderId: "elevenlabs",
		runCatalog: false,
		billing: "byok",
		authHeaders: ["xi-api-key", "authorization"],
		hostPattern: ELEVENLABS_HOST,
		transformEndpoint: hostStrip(ELEVENLABS_HOST),
	},
];

/** Aliases that map a friendly slug prefix to a canonical `resolverKey`. */
const RESOLVER_ALIASES: Record<string, string> = {
	// xAI's run-catalog author is `xai`, but `grok` is the common name.
	grok: "xai",
	"google-ai-studio": "google",
	"google-vertex-ai": "google-vertex",
	bedrock: "aws-bedrock",
	azure: "azure-openai",
};

const BY_RESOLVER_KEY = new Map<string, GatewayProviderInfo>(
	GATEWAY_PROVIDERS.map((p) => [p.resolverKey, p]),
);

/** Look up a provider by the slug prefix the user typed (honoring aliases). */
export function findProviderBySlug(resolverKey: string): GatewayProviderInfo | undefined {
	const canonical = RESOLVER_ALIASES[resolverKey] ?? resolverKey;
	return BY_RESOLVER_KEY.get(canonical);
}

/** Detect the gateway provider from a wrapped provider's request URL (BYOG). */
export function detectProviderByUrl(url: string): GatewayProviderInfo | undefined {
	return GATEWAY_PROVIDERS.find((p) => p.hostPattern?.test(url));
}

/** All slug keys with a built-in parser (auto-wireable by the slug delegate). */
export function wireableProviders(): GatewayProviderInfo[] {
	return GATEWAY_PROVIDERS.filter((p) => p.wireFormat !== undefined);
}
