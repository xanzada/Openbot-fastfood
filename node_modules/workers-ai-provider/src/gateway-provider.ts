import { WorkersAIGatewayError } from "./errors";
import { detectProviderByUrl, type GatewayProviderInfo } from "./gateway-providers";

/**
 * Bring-your-own-provider: route any `@ai-sdk/*` provider's HTTP traffic through
 * Cloudflare AI Gateway, without the catalog slug delegate. The provider keeps
 * its own request/response shaping; this only swaps the transport.
 *
 * Use it for providers the slug delegate cannot auto-wire (bedrock, replicate,
 * audio/image providers, anything provider-native), or when you want full control
 * of the underlying `@ai-sdk` provider. This is the gateway path only — BYOK and
 * caching are available, resume (`cf-aig-run-id`) is not.
 *
 * @example
 * ```ts
 * import { createOpenAI } from "@ai-sdk/openai";
 * import { createGatewayFetch } from "workers-ai-provider/gateway";
 *
 * const openai = createOpenAI({
 *   apiKey: env.OPENAI_API_KEY, // forwarded when byok: true
 *   fetch: createGatewayFetch({ binding: env.AI, gateway: "my-gw", byok: true }),
 * });
 * const model = openai("gpt-5");
 * ```
 */
export interface GatewayFetchConfig {
	/** A Cloudflare AI binding (e.g. `env.AI`). */
	binding: Ai;
	/** Gateway id (or options). */
	gateway: GatewayOptions | string;
	/**
	 * Force a gateway provider id instead of detecting it from the request URL.
	 * Required when the wrapped provider's host is not in the registry.
	 */
	provider?: string;
	/**
	 * Forward the upstream provider key (Authorization / x-api-key / …) instead of
	 * stripping it. Required for BYOK providers. Defaults to `false` (strip, so
	 * unified billing / the gateway's stored key applies).
	 */
	byok?: boolean;
	/** Extra headers added to every gateway entry. */
	extraHeaders?: Record<string, string>;
	/** Gateway-path response caching (seconds). */
	cacheTtl?: number;
	/** Bypass gateway cache. */
	skipCache?: boolean;
}

const STRIP_HEADERS_BASE = new Set(["content-length", "host"]);

interface AiGatewayRunner {
	run(body: unknown, options?: Record<string, unknown>): Promise<Response>;
}

function asText(body: BodyInit | null | undefined): string {
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
	return "{}";
}

function headersToObject(h: HeadersInit | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!h) return out;
	if (h instanceof Headers) {
		for (const [k, v] of h) out[k] = v;
	} else if (Array.isArray(h)) {
		for (const [k, v] of h) out[k] = v;
	} else {
		Object.assign(out, h);
	}
	return out;
}

/**
 * A `fetch` that dispatches the wrapped provider's request through AI Gateway.
 * Detects the gateway provider id from the request URL (or uses `config.provider`),
 * strips the provider host to the endpoint path, and forwards the body verbatim.
 */
export function createGatewayFetch(config: GatewayFetchConfig): typeof globalThis.fetch {
	if (!config?.binding) {
		throw new WorkersAIGatewayError(
			"gateway-error",
			"createGatewayFetch requires a `binding` (e.g. { binding: env.AI }).",
		);
	}
	const gatewayId = typeof config.gateway === "string" ? config.gateway : config.gateway?.id;
	if (!gatewayId) {
		throw new WorkersAIGatewayError(
			"gateway-error",
			'createGatewayFetch requires a `gateway` id (e.g. gateway: "my-gateway").',
		);
	}

	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const rawUrl = typeof input === "string" ? input : input.toString();

		let info: GatewayProviderInfo | undefined;
		if (config.provider) {
			info = undefined; // explicit provider id; no registry lookup needed
		} else {
			info = detectProviderByUrl(rawUrl);
			if (!info) {
				throw new WorkersAIGatewayError(
					"gateway-error",
					`Could not detect a gateway provider from URL "${rawUrl}". ` +
						'Pass `provider: "<gateway-provider-id>"` explicitly.',
					{ recoverable: false },
				);
			}
		}

		const providerId = config.provider ?? (info as GatewayProviderInfo).gatewayProviderId;
		const endpoint = info?.transformEndpoint
			? info.transformEndpoint(rawUrl)
			: rawUrl.replace(/^https?:\/\/[^/]+\//, "");
		const body = JSON.parse(asText(init?.body)) as Record<string, unknown>;

		const strip = new Set(STRIP_HEADERS_BASE);
		if (!config.byok && info) for (const h of info.authHeaders) strip.add(h.toLowerCase());

		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(headersToObject(init?.headers))) {
			if (!strip.has(k.toLowerCase())) headers[k] = v;
		}
		if (config.extraHeaders) Object.assign(headers, config.extraHeaders);
		if (config.cacheTtl !== undefined) headers["cf-aig-cache-ttl"] = String(config.cacheTtl);
		if (config.skipCache) headers["cf-aig-skip-cache"] = "true";

		const entry = { provider: providerId, endpoint, headers, query: body };
		const gw = (config.binding as unknown as { gateway(id: string): AiGatewayRunner }).gateway(
			gatewayId,
		);
		const runOptions: Record<string, unknown> = {};
		if (init?.signal) runOptions.signal = init.signal;
		return gw.run([entry], runOptions);
	}) as typeof globalThis.fetch;
}

/**
 * Wrap an `@ai-sdk/*` provider factory so its traffic flows through AI Gateway.
 * A thin convenience over {@link createGatewayFetch} — it injects the gateway
 * `fetch` (and a placeholder `apiKey` unless you supply one for BYOK).
 *
 * @example
 * ```ts
 * import { createOpenAI } from "@ai-sdk/openai";
 * import { createGatewayProvider } from "workers-ai-provider/gateway";
 *
 * const openai = createGatewayProvider(createOpenAI, {
 *   binding: env.AI,
 *   gateway: "my-gw",
 * });
 * const model = openai("gpt-5");
 * ```
 */
export function createGatewayProvider<T>(
	factory: (opts: { apiKey?: string; baseURL?: string; fetch: typeof globalThis.fetch }) => T,
	config: GatewayFetchConfig & { apiKey?: string; baseURL?: string },
): T {
	return factory({
		apiKey: config.apiKey ?? "unused",
		...(config.baseURL ? { baseURL: config.baseURL } : {}),
		fetch: createGatewayFetch(config),
	});
}
