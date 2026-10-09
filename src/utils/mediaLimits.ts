// One configurable resource bound for decoded media; upstream limits remain independent.
const configured = Number(process.env.MAX_MEDIA_BYTES || process.env.OPENBOT_MAX_MEDIA_BYTES);
export const MAX_MEDIA_BYTES = Number.isSafeInteger(configured) && configured >= 1024
  && configured <= Math.floor((Number.MAX_SAFE_INTEGER - 262_144) / 6)
  ? configured : 64 * 1024 * 1024;
export const MAX_MEDIA_BASE64_LENGTH = Math.ceil(MAX_MEDIA_BYTES / 3) * 4;
// Preserve both existing webhook media representations and bounded metadata.
export const MEDIA_WEBHOOK_JSON_BYTES = 2 * MAX_MEDIA_BASE64_LENGTH + 65_536;
export const MAX_INBOUND_WEBHOOK_BYTES = MEDIA_WEBHOOK_JSON_BYTES + 65_536;
