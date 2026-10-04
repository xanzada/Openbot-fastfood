/**
 * "Was the menu link sent RECENTLY?" - not "was it ever sent".
 *
 * has_sent_link lives for 30 days, and the old code read it as a plain boolean:
 * a guest who got a link two days ago and now says «Бауырым екі пицца екі донер»
 * was refused the link as a "duplicate", while the model had already written
 * «Төмендегі сілтеме арқылы…» - the guest saw a promise and nothing below it
 * (owner report, 2026-10-04). A duplicate is only a duplicate while the old link
 * is still on the guest's screen: sent minutes ago, or among the last messages.
 */
const URL_RE = /https?:\/\/\S+/i;
const BOT_ROLES = new Set(["assistant", "model", "bot"]);

export const MAGIC_LINK_RECENT_MS = (() => {
  const raw = Number(process.env.OPENBOT_MAGIC_LINK_RECENT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10 * 60_000;
})();

function isBotEntry(entry: any) {
  return BOT_ROLES.has(String(entry?.role || "").toLowerCase());
}

function hasUrl(entry: any) {
  return URL_RE.test(String(entry?.text || ""));
}

/** A link URL among the last `lastN` history entries written by the bot. */
export function linkVisibleInRecentHistory(history: unknown, lastN = 4) {
  const rows = Array.isArray(history) ? history : [];
  return rows.slice(-lastN).some((entry) => isBotEntry(entry) && hasUrl(entry));
}

/**
 * The bot's previous reply already carried the link (the reply and the URL are
 * stored as two bot entries, so the last two bot entries are checked). Only then
 * is "the link is below" safe to drop instead of being honoured with a resend.
 */
export function linkInLastBotReply(history: unknown) {
  const rows = Array.isArray(history) ? history : [];
  return rows.filter(isBotEntry).slice(-2).some(hasUrl);
}

export function isMagicLinkRecent(sentAt: number, history: unknown, now = Date.now()) {
  const at = Number(sentAt) || 0;
  // Values below 1e12 are legacy boolean-ish markers ("1") without a real time.
  const recentByTime = at > 1e12 && now - at >= 0 && now - at < MAGIC_LINK_RECENT_MS;
  return recentByTime || linkVisibleInRecentHistory(history);
}
