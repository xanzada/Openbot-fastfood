export type AISearchChatSettings = {
	/**
	 * Whether to inject a safety prompt before all conversations.
	 * Defaults to `false`.
	 */
	safePrompt?: boolean;

	/**
	 * Passthrough settings that are provided directly to the run function.
	 */
	[key: string]: unknown;
};
