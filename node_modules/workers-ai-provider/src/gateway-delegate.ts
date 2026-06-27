import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createClientFallbackModel } from "./client-fallback";
import { findProviderBySlug, type GatewayProviderInfo, type WireFormat } from "./gateway-providers";
import { createResumableStream, type ResumeExpiredPolicy } from "./resumable-stream";

export {
	createResumableStream,
	type ResumableStreamOptions,
	type ResumeExpiredPolicy,
} from "./resumable-stream";
export {
	type FallbackAttempt,
	type GatewayErrorCode,
	type GatewayErrorContext,
	WorkersAIFallbackError,
	WorkersAIGatewayError,
} from "./errors";
export { type FallbackLeg, createClientFallbackModel } from "./client-fallback";
export {
	type Billing,
	GATEWAY_PROVIDERS,
	type GatewayProviderInfo,
	type WireFormat,
	detectProviderByUrl,
	findProviderBySlug,
	wireableProviders,
} from "./gateway-providers";

/**
 * Gateway delegate — route AI SDK catalog models through Cloudflare AI Gateway,
 * with capability-driven transport selection.
 *
 * Two transports back the same model, chosen from the requested options:
 *
 *   - **Run path** `env.AI.run(slug, body, { returnRawResponse })` — resumable
 *     streaming (`cf-aig-run-id`). The default.
 *   - **Gateway path** `env.AI.gateway(id).run([entry, …fallback])` — server-side
 *     fallback and caching. Does not surface `cf-aig-run-id`, so resume is off.
 *
 * The SAME `@ai-sdk/*` provider parses the response on either path, so there is no
 * per-provider or per-path response parsing here. Provider plugins (which import
 * `@ai-sdk/openai`, `@ai-sdk/anthropic`, …) are injected from sub-path modules
 * (`workers-ai-provider/openai`, …) so those AI SDK packages stay OPTIONAL peer
 * dependencies — you only install the ones you use.
 *
 * @example
 * ```ts
 * import { createGatewayDelegate } from "workers-ai-provider/gateway-delegate";
 * import { openai } from "workers-ai-provider/openai";
 * import { streamText } from "ai";
 *
 * const wai = createGatewayDelegate({
 *   binding: env.AI,
 *   gateway: "my-gateway",
 *   providers: [openai],
 * });
 *
 * const result = streamText({ model: wai("openai/gpt-5"), prompt: "Hello" });
 * // result.response.headers["cf-aig-run-id"] is set — resume from there.
 * ```
 */

// ---------------------------------------------------------------------------
// Slug parsing
// ---------------------------------------------------------------------------

export interface ParsedSlug {
	/** First path segment — the registry resolver key (selects provider + wire format). */
	resolverKey: string;
	/** Remaining segments — the provider-native model id. */
	modelId: string;
}

/**
 * Parse a `vendor/model` slug. The first segment is the resolver key (which
 * registry entry handles it); the rest is the provider-native model id. Routing
 * providers keep multi-segment model ids, e.g. `openrouter/anthropic/claude`.
 */
export function parseSlug(slug: string): ParsedSlug {
	const slash = slug.indexOf("/");
	if (slash === -1) {
		throw new GatewayDelegateError(
			"config",
			`Model slug "${slug}" has no resolver key. Use "<provider>/<model>" (e.g. "openai/gpt-5").`,
		);
	}
	const resolverKey = slug.slice(0, slash);
	const modelId = slug.slice(slash + 1);
	if (!resolverKey || !modelId) {
		throw new GatewayDelegateError(
			"config",
			`Model slug "${slug}" is malformed. Use "<provider>/<model>" (e.g. "openai/gpt-5").`,
		);
	}
	return { resolverKey, modelId };
}

/**
 * Resolve a slug to its registry entry, raising a helpful error for unknown or
 * bring-your-own-provider-only providers.
 */
export function resolveProvider(slug: string, parsed: ParsedSlug): GatewayProviderInfo {
	const info = findProviderBySlug(parsed.resolverKey);
	if (!info) {
		throw new GatewayDelegateError(
			"config",
			`Unknown gateway provider "${parsed.resolverKey}" (from slug "${slug}"). ` +
				"See the AI Gateway provider directory for valid slugs, or use " +
				"createGatewayProvider to bring your own @ai-sdk provider.",
		);
	}
	if (!info.wireFormat) {
		throw new GatewayDelegateError(
			"config",
			`Provider "${parsed.resolverKey}" is not chat/completions-shaped and has no built-in ` +
				"parser. Reach it with createGatewayProvider (bring your own @ai-sdk provider).",
		);
	}
	return info;
}

// ---------------------------------------------------------------------------
// Provider plugins (injected from sub-path modules)
// ---------------------------------------------------------------------------

/**
 * Adapts a `@ai-sdk/*` provider to the delegate, keyed by the response wire
 * format it parses. Imported from a sub-path module (e.g.
 * `workers-ai-provider/openai`) so the AI SDK package stays an optional peer
 * dependency. One plugin serves every registry provider of that wire format —
 * the `openai` plugin covers the whole OpenAI-compatible long tail (deepseek,
 * grok, groq, mistral, perplexity, openrouter, …).
 */
export interface ProviderPlugin {
	/** The response wire format this builder parses. */
	readonly wireFormat: WireFormat;
	/**
	 * Build the AI SDK model, wiring the gateway-dispatching `fetch`. `baseURL`
	 * (when provided by the registry) targets the provider's host so the request
	 * URL host-strips to its gateway-native endpoint — pass it to the underlying
	 * `@ai-sdk` provider.
	 */
	create(args: {
		modelId: string;
		fetch: typeof globalThis.fetch;
		baseURL?: string;
	}): LanguageModelV3;
}

// ---------------------------------------------------------------------------
// Options + transport selection
// ---------------------------------------------------------------------------

export type Transport = "run" | "gateway";

export interface FallbackOptions {
	/** `"client"` keeps resume (sequential run-path attempts); `"server"` uses the gateway path. */
	mode: "client" | "server";
	/** Ordered model slugs to try after the primary. */
	models: string[];
}

export interface DispatchInfo {
	transport: Transport;
	resumeEnabled: boolean;
	warnings: string[];
	runId: string | null;
	status: number | null;
	cfStep: string | null;
	cacheStatus: string | null;
	logId: string | null;
}

export interface DelegateCallOptions {
	/** Resumable streaming (run path). Defaults to the delegate's `resume` (true). */
	resume?: boolean;
	/** Cross-model fallback. `"server"` mode uses the gateway path (disables resume). */
	fallback?: FallbackOptions;
	/** Gateway-path response caching (seconds). Forces the gateway path. */
	cacheTtl?: number;
	/** Bypass gateway cache. Forces the gateway path. */
	skipCache?: boolean;
	/** Escape hatch: force a transport. */
	transport?: Transport;
	/**
	 * Run path only: behavior when the resume buffer has expired (404) after a
	 * mid-stream drop. `"error"` (default) surfaces a `GatewayDelegateError`;
	 * `"accept-partial"` ends the stream cleanly with whatever was delivered.
	 */
	onResumeExpired?: ResumeExpiredPolicy;
	/** Extra request headers (run path: `extraHeaders`; gateway path: entry headers). */
	extraHeaders?: Record<string, string>;
	/**
	 * Gateway path only: forward the upstream provider key instead of stripping it.
	 * Required for BYOK providers (not on unified billing). Supply the key via
	 * `extraHeaders` (e.g. `{ authorization: "Bearer …" }`); without `byok` the
	 * delegate strips provider auth headers so unified billing applies.
	 */
	byok?: boolean;
	/** Override the delegate's gateway for this model. */
	gateway?: GatewayOptions | string;
	/**
	 * Custom metadata attached to the gateway log for this request (spend
	 * attribution, tenant ids, etc.). Merges over any `metadata` already set via
	 * `gateway: { metadata }`. Applied on both transports (run path: gateway
	 * options; gateway path: `cf-aig-metadata` header). `bigint` values are
	 * coerced to strings for the header form.
	 */
	metadata?: Record<string, number | string | boolean | null | bigint>;
	/** Force gateway log collection on/off for this request (both transports). */
	collectLog?: boolean;
	/** Called once per dispatch with the resolved transport + gateway headers. */
	onDispatch?: (info: DispatchInfo) => void;
	/**
	 * Run path only: fired with the cumulative SSE event offset as the resumable
	 * stream advances. Pair with `onDispatch` (for `runId`) to persist
	 * `{ runId, eventOffset }` for cross-invocation re-attach after eviction.
	 * Throttle your own writes — this can fire per chunk.
	 */
	onProgress?: (eventOffset: number) => void;
}

interface Selection {
	transport: Transport;
	resumeEnabled: boolean;
	warnings: string[];
}

/**
 * Resolve the transport from the requested options. Gateway-only features (server
 * fallback, caching) force the gateway path and disable resume — with a loud
 * warning if resume was merely defaulted, or a thrown error if it was explicitly
 * requested.
 */
export function selectTransport(
	opts: DelegateCallOptions,
	resumeExplicitlyTrue: boolean,
	runCatalog = true,
	gatewayAvailable = true,
): Selection {
	const warnings: string[] = [];
	const wantsServerFallback = opts.fallback?.mode === "server";
	const wantsCaching = opts.cacheTtl !== undefined || opts.skipCache === true;
	const gatewayOnly = wantsServerFallback || wantsCaching;
	const feature = wantsServerFallback ? 'fallback.mode:"server"' : "caching (cacheTtl/skipCache)";

	// Run-path-only providers (on the run catalog, but not native gateway
	// providers) have no gateway path at all — reject anything that would need it
	// here, with a clear message, rather than letting it fail upstream.
	if (runCatalog && !gatewayAvailable && (opts.transport === "gateway" || gatewayOnly)) {
		const what = opts.transport === "gateway" ? 'transport:"gateway"' : feature;
		throw new GatewayDelegateError(
			"config",
			`${what} is unavailable: this provider is on the unified run catalog but is not a ` +
				"native gateway provider, so it has no gateway path (no caching, server-side " +
				'fallback, or transport:"gateway"). Use the default run path, or fallback.mode:"client".',
		);
	}

	// BYOK providers are not on the resumable run catalog — they can only be
	// reached through the gateway path.
	if (!runCatalog) {
		if (opts.transport === "run") {
			throw new GatewayDelegateError(
				"config",
				'transport:"run" is unavailable: this provider is not on the unified-billing run ' +
					"catalog, so it can only be reached through the gateway path (BYOK).",
			);
		}
		if (resumeExplicitlyTrue) {
			throw new GatewayDelegateError(
				"config",
				"resume:true is unavailable: this provider is not on the resumable run catalog " +
					"(cf-aig-run-id requires the unified-billing run path).",
			);
		}
		return { transport: "gateway", resumeEnabled: false, warnings };
	}

	if (opts.transport === "run" && gatewayOnly) {
		throw new GatewayDelegateError(
			"config",
			`transport:"run" cannot satisfy ${feature}: those features are only available on the ` +
				'gateway path. Use the gateway transport, or fallback.mode:"client".',
		);
	}
	if (opts.transport === "gateway" && resumeExplicitlyTrue) {
		throw new GatewayDelegateError(
			"config",
			'transport:"gateway" cannot provide resume — cf-aig-run-id is only on the run path.',
		);
	}

	if (gatewayOnly) {
		if (resumeExplicitlyTrue) {
			throw new GatewayDelegateError(
				"config",
				`resume:true conflicts with ${feature}: resume (cf-aig-run-id) is only on the run path, ` +
					`which does not support ${wantsServerFallback ? "server-side fallback" : "caching"}. ` +
					'Use fallback.mode:"client" to keep resume, or drop resume.',
			);
		}
		warnings.push(
			`[workers-ai-provider] resume disabled: ${feature} requires the gateway path, which does ` +
				'not surface cf-aig-run-id. Use fallback.mode:"client" to keep resumable streaming.',
		);
		return { transport: "gateway", resumeEnabled: false, warnings };
	}

	const transport = opts.transport ?? "run";
	return {
		transport,
		resumeEnabled: transport === "run" && opts.resume !== false,
		warnings,
	};
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type GatewayDelegateErrorKind = "config" | "dispatch" | "provider" | "resume-expired";

export class GatewayDelegateError extends Error {
	readonly kind: GatewayDelegateErrorKind;
	override readonly cause?: unknown;

	constructor(kind: GatewayDelegateErrorKind, message: string, cause?: unknown) {
		super(message);
		this.name = "GatewayDelegateError";
		this.kind = kind;
		this.cause = cause;
	}
}

// ---------------------------------------------------------------------------
// Dispatch internals
// ---------------------------------------------------------------------------

// Always stripped on the gateway path (transport-level headers the binding sets).
const STRIP_HEADERS_BASE = new Set(["content-length", "host"]);

interface GatewayEntry {
	provider: string;
	endpoint: string;
	headers: Record<string, string>;
	query: Record<string, unknown>;
}

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

function normalizeGateway(gateway: GatewayOptions | string | undefined): {
	id: string;
	options: GatewayOptions;
} {
	if (!gateway) {
		throw new GatewayDelegateError(
			"config",
			"A gateway is required for the delegate (resume needs a gateway). " +
				'Pass `gateway: "<gateway-id>"` to createGatewayDelegate or per call.',
		);
	}
	if (typeof gateway === "string") return { id: gateway, options: { id: gateway } };
	return { id: gateway.id, options: gateway };
}

export interface GatewayDelegateConfig {
	/** A Cloudflare AI binding (e.g. `env.AI`). Required — the gateway path needs `binding.gateway()`. */
	binding: Ai;
	/** Default gateway id (or options) for all models. Overridable per call. */
	gateway?: GatewayOptions | string;
	/** Provider plugins from sub-path modules (e.g. `[openai, anthropic]`). */
	providers: ProviderPlugin[];
	/** Default resume behavior when a call does not specify one. Defaults to `true`. */
	resume?: boolean;
	/** Default resume-expiry policy (run path). Defaults to `"error"`. */
	onResumeExpired?: ResumeExpiredPolicy;
}

export interface GatewayDelegate {
	(slug: string, options?: DelegateCallOptions): LanguageModelV3;
}

/**
 * Create a gateway delegate. Returns a function that builds an AI SDK model for a
 * `"<provider>/<model>"` slug, dispatched through AI Gateway on the transport the
 * requested options imply.
 */
export function createGatewayDelegate(config: GatewayDelegateConfig): GatewayDelegate {
	if (!config?.binding) {
		throw new GatewayDelegateError(
			"config",
			"createGatewayDelegate requires a `binding` (e.g. { binding: env.AI }).",
		);
	}
	if (!config.providers?.length) {
		throw new GatewayDelegateError(
			"config",
			"createGatewayDelegate requires at least one provider plugin, e.g. " +
				'`providers: [openai]` from "workers-ai-provider/openai".',
		);
	}

	const plugins = new Map<WireFormat, ProviderPlugin>();
	for (const p of config.providers) plugins.set(p.wireFormat, p);
	const defaultResume = config.resume ?? true;

	const buildOne = (
		slug: string,
		options: DelegateCallOptions,
	): { model: LanguageModelV3; transport: Transport } => {
		const parsed = parseSlug(slug);
		const info = resolveProvider(slug, parsed);

		const resumeExplicitlyTrue = options.resume === true;
		const effectiveOptions: DelegateCallOptions = {
			...options,
			resume: options.resume ?? defaultResume,
			onResumeExpired: options.onResumeExpired ?? config.onResumeExpired,
		};
		const selection = selectTransport(
			effectiveOptions,
			resumeExplicitlyTrue,
			info.runCatalog,
			info.gatewayPath !== false,
		);
		for (const w of selection.warnings) console.warn(w);

		// Pick the parser by transport. The unified-billing run path (`env.AI.run`)
		// does NOT speak a uniform wire format: Cloudflare normalizes most providers
		// to OpenAI chat-completions (so `google` is parsed with the `openai` plugin
		// on the run path), but passes Anthropic through natively. So the run path
		// uses the registry's `runWireFormat` (default "openai"), while the gateway
		// path — which hits provider-native endpoints — uses the native `wireFormat`.
		const wire: WireFormat =
			selection.transport === "run"
				? (info.runWireFormat ?? "openai")
				: (info.wireFormat as WireFormat);
		const plugin = plugins.get(wire);
		if (!plugin) {
			throw new GatewayDelegateError(
				"config",
				selection.transport === "run"
					? `The run path for "${parsed.resolverKey}" (from slug "${slug}") returns ` +
							`"${wire}"-wire responses, so it needs the "${wire}" plugin. ` +
							`Install + pass it from "workers-ai-provider/${wire}". ` +
							`Registered: ${[...plugins.keys()].join(", ") || "<none>"}.`
					: `No provider plugin for wire format "${wire}" (needed by "${parsed.resolverKey}" ` +
							`on the gateway path from slug "${slug}"). ` +
							`Registered: ${[...plugins.keys()].join(", ") || "<none>"}. ` +
							`Install + pass the matching plugin from "workers-ai-provider/${wire}".`,
			);
		}

		const { id: gatewayId, options: gatewayOptions } = normalizeGateway(
			options.gateway ?? config.gateway,
		);

		const fetchImpl =
			selection.transport === "run"
				? makeRunFetch(
						config.binding,
						// Use the canonical run-catalog author (e.g. "grok" → "xai"), not the
						// raw alias the caller typed, so `env.AI.run` resolves the model.
						`${info.resolverKey}/${parsed.modelId}`,
						gatewayOptions,
						effectiveOptions,
						selection,
						options,
					)
				: makeGatewayFetch(
						config.binding,
						info,
						gatewayId,
						gatewayOptions,
						effectiveOptions,
						selection,
						options,
					);

		return {
			model: plugin.create({
				modelId: parsed.modelId,
				fetch: fetchImpl,
				// baseURL only matters on the gateway path (host-strip to the native
				// endpoint); the run path ignores the request URL entirely.
				...(selection.transport === "gateway" && info.baseURL
					? { baseURL: info.baseURL }
					: {}),
			}),
			transport: selection.transport,
		};
	};

	return (slug, options = {}) => {
		// Client-side fallback: build a model per slug and wrap them so a failed
		// pre-stream dispatch falls through to the next, each on its own transport
		// (so resume is preserved per leg). Server-side fallback stays on the
		// gateway path inside makeGatewayFetch.
		if (options.fallback?.mode === "client") {
			const { fallback, ...rest } = options;
			const slugs = [slug, ...fallback.models];
			const legs = slugs.map((s) => {
				const { model, transport } = buildOne(s, rest);
				return { slug: s, model, transport };
			});
			return createClientFallbackModel(legs);
		}
		return buildOne(slug, options).model;
	};
}

function fireDispatch(resp: Response, selection: Selection, options: DelegateCallOptions): void {
	if (!options.onDispatch) return;
	options.onDispatch({
		transport: selection.transport,
		resumeEnabled: selection.resumeEnabled,
		warnings: selection.warnings,
		status: resp.status,
		runId: resp.headers.get("cf-aig-run-id"),
		cfStep: resp.headers.get("cf-aig-step"),
		cacheStatus: resp.headers.get("cf-aig-cache-status"),
		logId: resp.headers.get("cf-aig-log-id"),
	});
}

type GatewayMetadata = Record<string, number | string | boolean | null | bigint>;

/** Merge call-level metadata over gateway-option metadata (call wins). */
function mergeMetadata(
	base: GatewayMetadata | undefined,
	override: GatewayMetadata | undefined,
): GatewayMetadata | undefined {
	if (!base && !override) return undefined;
	return { ...base, ...override };
}

/** JSON-encode metadata for the `cf-aig-metadata` header (bigint → string). */
function serializeMetadata(metadata: GatewayMetadata): string {
	return JSON.stringify(metadata, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

function makeRunFetch(
	binding: Ai,
	slug: string,
	gatewayOptions: GatewayOptions,
	opts: DelegateCallOptions,
	selection: Selection,
	callOptions: DelegateCallOptions,
): typeof globalThis.fetch {
	return (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const body = JSON.parse(asText(init?.body)) as Record<string, unknown>;
		// The slug carries the model; drop the redundant body field (both are tolerated).
		delete body.model;

		// Fold first-class metadata/collectLog over anything supplied via
		// `gateway: { ... }`; explicit call options win.
		const mergedGateway: GatewayOptions = { ...gatewayOptions };
		const mergedMeta = mergeMetadata(gatewayOptions.metadata, opts.metadata);
		if (mergedMeta) mergedGateway.metadata = mergedMeta;
		if (opts.collectLog !== undefined) mergedGateway.collectLog = opts.collectLog;

		const runOptions = {
			gateway: mergedGateway,
			returnRawResponse: true,
			...(opts.extraHeaders ? { extraHeaders: opts.extraHeaders } : {}),
			...(init?.signal ? { signal: init.signal } : {}),
		};

		// The binding's `run` is heavily overloaded; narrow to the raw-Response
		// streaming signature. Call as a METHOD on the binding — extracting it
		// into a bare variable detaches `this` and the binding throws on a private
		// field access ("Cannot set properties of undefined (setting '#options')").
		const ai = binding as unknown as {
			run(
				model: string,
				inputs: Record<string, unknown>,
				options: Record<string, unknown>,
			): Promise<Response>;
		};
		const resp = await ai.run(slug, body, runOptions);
		fireDispatch(resp, selection, callOptions);

		// Wrap the stream so a transient mid-stream drop reconnects via the gateway
		// resume endpoint transparently — the @ai-sdk parser never sees the break.
		const runId = resp.headers.get("cf-aig-run-id");
		if (selection.resumeEnabled && runId && resp.body) {
			const resumable = createResumableStream({
				binding,
				gateway: gatewayOptions.id,
				runId,
				initial: resp.body,
				onResumeExpired: opts.onResumeExpired,
				...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
			});
			return new Response(resumable, { status: resp.status, headers: resp.headers });
		}
		return resp;
	}) as typeof globalThis.fetch;
}

function makeGatewayFetch(
	binding: Ai,
	info: GatewayProviderInfo,
	gatewayId: string,
	gatewayOptions: GatewayOptions,
	opts: DelegateCallOptions,
	selection: Selection,
	callOptions: DelegateCallOptions,
): typeof globalThis.fetch {
	// Strip the AI SDK's placeholder provider key unless BYOK forwards a real one;
	// unified billing / the gateway's stored key authenticates upstream otherwise.
	const strip = new Set(STRIP_HEADERS_BASE);
	if (!opts.byok) for (const h of info.authHeaders) strip.add(h.toLowerCase());

	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const rawUrl = typeof input === "string" ? input : input.toString();
		// Host-strip to the provider's gateway-native endpoint. The registry
		// transform matches because the builder targeted the provider's baseURL;
		// fall back to a generic pathname strip if it somehow doesn't.
		const endpoint = info.transformEndpoint
			? info.transformEndpoint(rawUrl)
			: new URL(rawUrl).pathname.replace(/^\//, "") + (new URL(rawUrl).search || "");
		const body = JSON.parse(asText(init?.body)) as Record<string, unknown>;

		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(headersToObject(init?.headers))) {
			if (!strip.has(k.toLowerCase())) headers[k] = v;
		}
		if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);
		// Best-effort gateway cache control (gateway-side config may still override).
		if (opts.cacheTtl !== undefined) headers["cf-aig-cache-ttl"] = String(opts.cacheTtl);
		if (opts.skipCache) headers["cf-aig-skip-cache"] = "true";
		// Gateway log controls (mirror the run path's typed gateway options).
		const metadata = mergeMetadata(gatewayOptions.metadata, opts.metadata);
		if (metadata) headers["cf-aig-metadata"] = serializeMetadata(metadata);
		if (opts.collectLog !== undefined) {
			headers["cf-aig-collect-log"] = String(opts.collectLog);
		}

		const primary: GatewayEntry = {
			provider: info.gatewayProviderId,
			endpoint,
			headers,
			query: body,
		};
		const entries: GatewayEntry[] = [primary];

		if (opts.fallback?.mode === "server") {
			for (const fb of opts.fallback.models) {
				const fbParsed = parseSlug(fb);
				const fbInfo = resolveProvider(fb, fbParsed);
				if (fbInfo.gatewayProviderId !== info.gatewayProviderId) {
					throw new GatewayDelegateError(
						"config",
						`Cross-vendor server-side fallback (${info.gatewayProviderId} → ` +
							`${fbInfo.gatewayProviderId}) is not supported yet. Use fallback.mode:"client", ` +
							"or same-vendor fallback models.",
					);
				}
				entries.push({ ...primary, query: { ...body, model: fbParsed.modelId } });
			}
		}

		const gw = (binding as unknown as { gateway(id: string): AiGatewayRunner }).gateway(
			gatewayId,
		);
		const runOptions: Record<string, unknown> = {};
		if (init?.signal) runOptions.signal = init.signal;
		const resp = await gw.run(entries, runOptions);
		fireDispatch(resp, selection, callOptions);
		return resp;
	}) as typeof globalThis.fetch;
}
