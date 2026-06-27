import { detectLang } from "../utils/language.js";
import { buildMagicLink, hasExplicitMenuLinkIntent } from "../utils/magicLink.js";
import { getOrderStatus, getRuntimeStatus } from "../services/dle.service.js";
import { getRestaurantConfig, getShporContext } from "../services/nocodb.service.js";
import { connectRedis, getActiveShiftNotes, getChatHistory, getUserLang, hasMagicLinkBeenSent, saveUserLang, } from "../services/redis.service.js";
export async function preloadContext(input) {
    await connectRedis();
    const instanceId = String(input.instanceId || "").trim();
    const phone = String(input.phone || "").replace(/\D/g, "");
    const text = String(input.text || "").trim();
    if (!instanceId)
        throw new Error("instanceId is required");
    if (!phone)
        throw new Error("phone is required");
    if (!text)
        throw new Error("text is required");
    const [config, storedLang, chatHistory, activeShiftNotes, magicLinkAlreadySent] = await Promise.all([
        getRestaurantConfig(instanceId),
        getUserLang(instanceId, phone).catch(() => null),
        getChatHistory(instanceId, phone).catch(() => []),
        getActiveShiftNotes(instanceId).catch(() => []),
        hasMagicLinkBeenSent(instanceId, phone).catch(() => false),
    ]);
    const safeConfig = config || {};
    const language = detectLang(text, storedLang);
    const domain = safeConfig.domain || "";
    const [runtimeStatus, activeOrder, shporContext] = await Promise.all([
        domain
            ? getRuntimeStatus(instanceId, domain, { forceFresh: true }).catch(() => null)
            : Promise.resolve(null),
        domain
            ? getOrderStatus(instanceId, phone, domain).catch(() => null)
            : Promise.resolve(null),
        getShporContext(instanceId, text).catch(() => []),
    ]);
    await saveUserLang(instanceId, phone, language).catch(() => undefined);
    return {
        instanceId,
        phone,
        text,
        language,
        config: safeConfig,
        runtimeStatus,
        activeOrder,
        chatHistory,
        activeShiftNotes,
        shporContext,
        magicLinkAlreadySent,
        explicitMenuLinkIntent: hasExplicitMenuLinkIntent(text),
        magicLink: buildMagicLink(domain, phone),
    };
}
