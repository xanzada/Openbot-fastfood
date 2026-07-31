import axios from "axios";
import { redisClient } from "../services/redis.service.js";
import { normalizePublicDomain, safeHttpAgent, safeHttpsAgent } from "../services/dle.service.js";
import { getAllRestaurantConfigs } from "../services/platformConfig.service.js";
import { notifyAllDevelopersSystemFailure, notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
const ANALYTICS_TIMEZONE = process.env.ANALYTICS_TIMEZONE || "Asia/Almaty";
const ANALYTICS_CRON_EXPR = process.env.ANALYTICS_CRON_EXPR || "59 23 * * *";
function getLocalReportDate(timeZone = ANALYTICS_TIMEZONE) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date());
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
}
function asNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}
function asText(value) {
    if (value === null || value === undefined)
        return "";
    if (typeof value === "string")
        return value.trim();
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    return JSON.stringify(value);
}
function firstValue(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && String(value).trim() !== "")
            return String(value).trim();
    }
    return "";
}
function tenantSecret(config) {
    return firstValue(config.crm_secret_token, config.crmSecretToken, config.secret_token, config.secretToken, config.secret_key, config.secretKey);
}
function normalizeLeadRows(rows = []) {
    return (Array.isArray(rows) ? rows : [])
        .map((row) => ({
        instance: asText(row.instance || row.restaurant_id),
        interest: asText(row.interest),
        sales_stage: asText(row.sales_stage),
        psycho_analysis: asText(row.psycho_analysis),
    }))
        .filter((row) => row.interest || row.sales_stage || row.psycho_analysis);
}
function buildFallbackAnalytics(logs = [], reason = "") {
    const blob = logs
        .map((log) => [log.action, log.interest, log.sales_stage, log.psycho_analysis, log.text].map(asText).join(" "))
        .join("\n")
        .toLowerCase();
    const totalChats = logs.length;
    const intentOrders = (blob.match(/order|menu|food|заказ|меню|еда|тапсырыс|мәзір|тамақ|тағам/gi) || []).length;
    const intentPayments = (blob.match(/receipt|payment|paid|чек|оплат|төлем|төлед/gi) || []).length;
    const complaints = (blob.match(/complaint|refund|cancel|bad|жалоб|возврат|отмен|шағым|қайтар|болдыр/gi) || []).length;
    return {
        total_chats: totalChats,
        intent_orders: intentOrders,
        intent_payments: intentPayments,
        conversion_rate: intentOrders > 0 ? Number(((intentPayments / intentOrders) * 100).toFixed(2)) : 0,
        total_complaints: complaints,
        top_complaints_tags: "",
        total_canceled: (blob.match(/cancel|отмен|болдыр/gi) || []).length,
        cancellation_reasons: "",
        popular_items: "",
        avg_mood: totalChats > 0 ? "Қалыпты" : "Дерек жоқ",
        escalated_tickets: (blob.match(/operator|admin|human|оператор|админ/gi) || []).length,
        ai_daily_advice: totalChats > 0
            ? "Бүгінгі диалогтар сақталды. Толық AI талдау уақытша қолжетімсіз болса да, негізгі статистика жазылды."
            : "Бүгін ботқа жаңа диалог түспеді.",
        critical_alert: reason ? `Fallback analytics used: ${reason}` : "",
    };
}
function normalizeAnalyticsPayload(aiData = {}, logs = []) {
    const fallback = buildFallbackAnalytics(logs);
    return {
        total_chats: asNumber(aiData.total_chats, fallback.total_chats),
        intent_orders: asNumber(aiData.intent_orders, fallback.intent_orders),
        intent_payments: asNumber(aiData.intent_payments, fallback.intent_payments),
        conversion_rate: asNumber(aiData.conversion_rate, fallback.conversion_rate),
        total_complaints: asNumber(aiData.total_complaints, fallback.total_complaints),
        top_complaints_tags: asText(aiData.top_complaints_tags || fallback.top_complaints_tags),
        total_canceled: asNumber(aiData.total_canceled, fallback.total_canceled),
        cancellation_reasons: asText(aiData.cancellation_reasons || fallback.cancellation_reasons),
        popular_items: asText(aiData.popular_items || fallback.popular_items),
        avg_mood: asText(aiData.avg_mood || fallback.avg_mood),
        escalated_tickets: asNumber(aiData.escalated_tickets, fallback.escalated_tickets),
        ai_daily_advice: asText(aiData.ai_daily_advice || fallback.ai_daily_advice),
        critical_alert: asText(aiData.critical_alert || fallback.critical_alert),
    };
}
async function fetchTodayCrmLeads(config, reportDate) {
    const instanceId = String(config.instance_id || "").trim();
    const domain = String(config.domain || "").trim();
    if (!instanceId || !domain) {
        throw new Error("missing instance_id or domain");
    }
    const cleanDomain = await normalizePublicDomain(domain);
    const token = tenantSecret(config);
    if (!token)
        throw new Error("missing tenant CRM secret");
    const response = await axios.post(`${cleanDomain}/api_bot.php`, {
        token,
        action: "get_today_crm",
        restaurant_id: instanceId,
        date: reportDate,
    }, {
        timeout: 15000,
        maxRedirects: 0,
        httpAgent: safeHttpAgent,
        httpsAgent: safeHttpsAgent,
    });
    if (response.data?.success === false) {
        throw new Error(response.data.error || "get_today_crm returned success=false");
    }
    return normalizeLeadRows(response.data?.data || []);
}
async function sendAnalyticsToSite(config, reportDate, analytics) {
    const instanceId = String(config.instance_id || "").trim();
    const domain = String(config.domain || "").trim();
    if (!instanceId || !domain) {
        throw new Error("missing instance_id or domain");
    }
    const cleanDomain = await normalizePublicDomain(domain);
    const token = tenantSecret(config);
    if (!token)
        throw new Error("missing tenant CRM secret");
    const response = await axios.post(`${cleanDomain}/api_bot.php`, {
        token,
        action: "save_daily_analytics",
        restaurant_id: instanceId,
        report_date: reportDate,
        ...analytics,
    }, {
        timeout: 15000,
        maxRedirects: 0,
        httpAgent: safeHttpAgent,
        httpsAgent: safeHttpsAgent,
    });
    if (response.data?.success === false) {
        throw new Error(response.data.error || "save_daily_analytics returned success=false");
    }
    return true;
}
async function buildDailyAnalytics(logs = []) {
    return normalizeAnalyticsPayload({}, logs);
}
async function processRestaurantAnalytics(config, reportDate) {
    const instanceId = String(config.instance_id || "").trim();
    if (!instanceId)
        return;
    const leads = await fetchTodayCrmLeads(config, reportDate);
    console.log(`[CRON] analytics ${instanceId}: bot_leads=${leads.length}, report_date=${reportDate}`);
    const analytics = await buildDailyAnalytics(leads);
    await sendAnalyticsToSite(config, reportDate, analytics);
    console.log(`[CRON] analytics saved: ${instanceId}`);
}
export async function processDailyAnalytics() {
    console.log("[CRON] Daily AI analytics started...");
    if (!redisClient.isOpen)
        return;
    const reportDate = getLocalReportDate();
    const configs = await getAllRestaurantConfigs();
    if (!configs.length) {
        console.warn("[CRON] No restaurant configs found for daily analytics.");
        return;
    }
    for (const config of configs) {
        try {
            await processRestaurantAnalytics(config, reportDate);
        }
        catch (error) {
            console.error(`[CRON] analytics error (${config?.instance_id || "unknown"}):`, error?.message || error);
            await notifyDeveloperSystemFailure(String(config?.instance_id || ""), error, {
                scope: "daily_analytics",
                action: "process_restaurant_analytics",
            }).catch(() => undefined);
        }
    }
}
function parseDailyCron(expr = ANALYTICS_CRON_EXPR) {
    const [minuteRaw, hourRaw] = String(expr || "").trim().split(/\s+/);
    const minute = Number(minuteRaw);
    const hour = Number(hourRaw);
    return {
        minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 59,
        hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 23,
    };
}
function localTimeParts(date, timeZone = ANALYTICS_TIMEZONE) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).formatToParts(date);
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}
function nextDelayMs() {
    const target = parseDailyCron();
    const now = Date.now();
    for (let offsetMinutes = 1; offsetMinutes <= 60 * 48; offsetMinutes += 1) {
        const candidate = new Date(now + offsetMinutes * 60 * 1000);
        const parts = localTimeParts(candidate);
        if (Number(parts.hour) === target.hour && Number(parts.minute) === target.minute) {
            return Math.max(1000, candidate.getTime() - now);
        }
    }
    return 24 * 60 * 60 * 1000;
}
export function startDailyCron() {
    const scheduleNext = () => {
        const delay = nextDelayMs();
        setTimeout(() => {
            processDailyAnalytics()
                .catch((error) => {
                console.error("[CRON] analytics fatal error:", error?.message || error);
                void notifyAllDevelopersSystemFailure(error, {
                    scope: "daily_analytics_fatal",
                }).catch(() => undefined);
            })
                .finally(scheduleNext);
        }, delay);
    };
    scheduleNext();
    console.log(`[CRON] Daily AI analytics scheduled: ${ANALYTICS_CRON_EXPR} ${ANALYTICS_TIMEZONE}`);
}
