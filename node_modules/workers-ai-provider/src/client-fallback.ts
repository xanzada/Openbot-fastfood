import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import { type FallbackAttempt, WorkersAIFallbackError, WorkersAIGatewayError } from "./errors";
import type { Transport } from "./gateway-delegate";

/** One model in a client-side fallback chain. */
export interface FallbackLeg {
	/** The model slug this leg dispatches. */
	slug: string;
	/** The built AI SDK model. */
	model: LanguageModelV3;
	/** Transport the leg uses. */
	transport: Transport;
}

/**
 * Wrap a chain of models so a failed *pre-stream* dispatch falls through to the
 * next model, preserving resume on each leg's own transport. If every leg fails,
 * throws a {@link WorkersAIFallbackError} carrying the full attempt tree.
 *
 * Fallback triggers on `doGenerate`/`doStream` rejection (the dispatch never
 * produced a stream). Errors that surface *mid-stream* — after content has
 * already been emitted — are not recoverable here and propagate as-is.
 */
export function createClientFallbackModel(legs: FallbackLeg[]): LanguageModelV3 {
	if (legs.length === 0) {
		throw new Error("createClientFallbackModel requires at least one model leg.");
	}
	const primary = legs[0].model;

	async function attempt<T>(run: (model: LanguageModelV3) => PromiseLike<T>): Promise<T> {
		const attempts: FallbackAttempt[] = [];
		for (const leg of legs) {
			try {
				const result = await run(leg.model);
				attempts.push({ model: leg.slug, transport: leg.transport, ok: true });
				return result;
			} catch (e) {
				const err = WorkersAIGatewayError.fromUnknown(e);
				attempts.push({
					model: leg.slug,
					transport: leg.transport,
					ok: false,
					status: err.status,
					error: err,
				});
			}
		}
		throw new WorkersAIFallbackError(attempts);
	}

	return {
		specificationVersion: "v3",
		provider: primary.provider,
		modelId: primary.modelId,
		supportedUrls: primary.supportedUrls,
		doGenerate(
			options: LanguageModelV3CallOptions,
		): PromiseLike<LanguageModelV3GenerateResult> {
			return attempt((m) => m.doGenerate(options));
		},
		doStream(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3StreamResult> {
			return attempt((m) => m.doStream(options));
		},
	};
}
