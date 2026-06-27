export type WorkersAITranscriptionSettings = {
	/**
	 * Language of the audio, as an ISO-639-1 code (e.g. "en", "fr").
	 * Only supported by Whisper models. Nova-3 detects language automatically.
	 */
	language?: string;

	/**
	 * Initial prompt / context to guide the transcription.
	 * Mapped to `initial_prompt` for Whisper models.
	 */
	prompt?: string;
};
