/**
 * Typed errors for the gateway delegate.
 *
 *   - {@link WorkersAIGatewayError} — a single dispatch failed. Carries a coarse
 *     {@link GatewayErrorCode}, a `recoverable` hint (whether a retry/fallback is
 *     worth attempting), and the parsed gateway/provider envelope.
 *   - {@link WorkersAIFallbackError} — every model in a client-side fallback chain
 *     failed. Carries the per-attempt tree so callers can see exactly what was
 *     tried and why each leg failed.
 */

/** Coarse classification of a gateway/provider failure. */
export type GatewayErrorCode =
	| "auth" // 401 / 403 — bad or missing key (BYOK), or unified billing not enabled
	| "rate-limit" // 429 — throttled
	| "not-found" // 404 — unknown model/endpoint (or expired resume buffer)
	| "bad-request" // 400 / 422 — malformed request
	| "provider-error" // 5xx — upstream provider failure
	| "gateway-error" // gateway/transport failure with no usable status
	| "resume-expired" // resume buffer TTL elapsed (404 from resume endpoint)
	| "unknown";

/** Context attached to a {@link WorkersAIGatewayError}. */
export interface GatewayErrorContext {
	/** Gateway provider id (e.g. `"openai"`, `"google-ai-studio"`). */
	provider?: string;
	/** Provider-native model id. */
	modelId?: string;
	/** Transport the failed dispatch used. */
	transport?: "run" | "gateway";
	/** HTTP status, if any. */
	status?: number | null;
	/** `cf-aig-log-id` for cross-referencing in the dashboard. */
	logId?: string | null;
	/** `cf-aig-run-id`, if the run path issued one. */
	runId?: string | null;
}

/** Map an HTTP status to a {@link GatewayErrorCode} + recoverability hint. */
export function classifyStatus(status: number): {
	code: GatewayErrorCode;
	recoverable: boolean;
} {
	if (status === 401 || status === 403) return { code: "auth", recoverable: false };
	if (status === 429) return { code: "rate-limit", recoverable: true };
	if (status === 404) return { code: "not-found", recoverable: false };
	if (status === 400 || status === 422) return { code: "bad-request", recoverable: false };
	if (status >= 500) return { code: "provider-error", recoverable: true };
	return { code: "unknown", recoverable: false };
}

/** Best-effort extraction of a human message from a CF/provider error envelope. */
export function extractErrorMessage(raw: unknown): string | undefined {
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) return undefined;
		try {
			return extractErrorMessage(JSON.parse(trimmed));
		} catch {
			return trimmed.slice(0, 500);
		}
	}
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	// CF gateway envelope: { errors: [{ code, message }] }
	if (Array.isArray(obj.errors) && obj.errors.length > 0) {
		const first = obj.errors[0] as Record<string, unknown>;
		if (typeof first?.message === "string") return first.message;
	}
	// Provider envelopes: { error: { message } } or { error: "..." } or { message }
	if (obj.error && typeof obj.error === "object") {
		const err = obj.error as Record<string, unknown>;
		if (typeof err.message === "string") return err.message;
	}
	if (typeof obj.error === "string") return obj.error;
	if (typeof obj.message === "string") return obj.message;
	return undefined;
}

/** A single dispatch failure through AI Gateway (run or gateway path). */
export class WorkersAIGatewayError extends Error {
	readonly code: GatewayErrorCode;
	/** Whether a retry or fallback to another model is worth attempting. */
	readonly recoverable: boolean;
	readonly status: number | null;
	readonly context: GatewayErrorContext;
	/** Parsed gateway/provider error envelope (or raw text). */
	readonly raw?: unknown;
	override readonly cause?: unknown;

	constructor(
		code: GatewayErrorCode,
		message: string,
		opts: {
			recoverable?: boolean;
			status?: number | null;
			context?: GatewayErrorContext;
			raw?: unknown;
			cause?: unknown;
		} = {},
	) {
		super(message);
		this.name = "WorkersAIGatewayError";
		this.code = code;
		this.recoverable = opts.recoverable ?? false;
		this.status = opts.status ?? null;
		this.context = opts.context ?? {};
		this.raw = opts.raw;
		this.cause = opts.cause;
	}

	/**
	 * Classify an arbitrary thrown value. Understands AI SDK `APICallError`
	 * (reads `statusCode` / `responseBody` / `isRetryable`); falls back to a
	 * recoverable `gateway-error` for transport/connection failures so a fallback
	 * chain keeps trying.
	 */
	static fromUnknown(e: unknown): WorkersAIGatewayError {
		if (e instanceof WorkersAIGatewayError) return e;
		const obj = e && typeof e === "object" ? (e as Record<string, unknown>) : {};
		const status = typeof obj.statusCode === "number" ? obj.statusCode : null;
		const responseBody = typeof obj.responseBody === "string" ? obj.responseBody : undefined;

		if (status !== null) {
			const classified = classifyStatus(status);
			// AI SDK already decides retryability per status; prefer it when present.
			const recoverable =
				typeof obj.isRetryable === "boolean" ? obj.isRetryable : classified.recoverable;
			const message =
				extractErrorMessage(responseBody) ??
				(e instanceof Error ? e.message : `Gateway dispatch failed (HTTP ${status}).`);
			let raw: unknown = responseBody;
			try {
				raw = responseBody ? JSON.parse(responseBody) : responseBody;
			} catch {
				// keep raw text
			}
			return new WorkersAIGatewayError(classified.code, message, {
				recoverable,
				status,
				raw,
				cause: e,
			});
		}

		return new WorkersAIGatewayError(
			"gateway-error",
			e instanceof Error ? e.message : String(e),
			{ recoverable: true, cause: e },
		);
	}

	/** Build from an HTTP `Response` (reads the body for the envelope). */
	static async fromResponse(
		resp: Response,
		context: GatewayErrorContext = {},
	): Promise<WorkersAIGatewayError> {
		const text = await resp.text().catch(() => "");
		const { code, recoverable } = classifyStatus(resp.status);
		const message =
			extractErrorMessage(text) ?? `Gateway dispatch failed (HTTP ${resp.status}).`;
		let raw: unknown = text;
		try {
			raw = text ? JSON.parse(text) : text;
		} catch {
			// keep raw text
		}
		return new WorkersAIGatewayError(code, message, {
			recoverable,
			status: resp.status,
			raw,
			context: {
				...context,
				status: resp.status,
				logId: resp.headers.get("cf-aig-log-id"),
				runId: resp.headers.get("cf-aig-run-id"),
			},
		});
	}
}

/** One leg of a client-side fallback chain. */
export interface FallbackAttempt {
	/** The model slug attempted. */
	model: string;
	/** Transport used for this attempt. */
	transport: "run" | "gateway";
	/** Whether this attempt succeeded. */
	ok: boolean;
	/** HTTP status, if any. */
	status?: number | null;
	/** The classified error, when the attempt failed. */
	error?: WorkersAIGatewayError;
}

/** Every model in a client-side fallback chain failed. */
export class WorkersAIFallbackError extends Error {
	/** The ordered attempt tree (primary first, then each fallback). */
	readonly attempts: FallbackAttempt[];

	constructor(attempts: FallbackAttempt[], message?: string) {
		const tried = attempts.map((a) => a.model).join(" → ");
		super(message ?? `All fallback models failed: ${tried}.`);
		this.name = "WorkersAIFallbackError";
		this.attempts = attempts;
	}

	/** The last (most recent) attempt's error, if any. */
	get lastError(): WorkersAIGatewayError | undefined {
		for (let i = this.attempts.length - 1; i >= 0; i--) {
			const e = this.attempts[i].error;
			if (e) return e;
		}
		return undefined;
	}
}
