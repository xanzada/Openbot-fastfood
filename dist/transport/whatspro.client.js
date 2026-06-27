import axios from "axios";
export async function sendWhatsProMessage(payload) {
    const baseUrl = String(process.env.WHATSPRO_BASE_URL || "").replace(/\/+$/, "");
    const url = process.env.WHATSPRO_SEND_URL || (baseUrl ? `${baseUrl}/api/send` : "");
    if (!url)
        return { skipped: true, reason: "WHATSPRO_SEND_URL or WHATSPRO_BASE_URL is not configured" };
    const headers = { "content-type": "application/json" };
    if (process.env.WHATSPRO_API_TOKEN) {
        headers.authorization = `Bearer ${process.env.WHATSPRO_API_TOKEN}`;
        headers["x-api-key"] = process.env.WHATSPRO_API_TOKEN;
    }
    const response = await axios.post(url, {
        instanceId: payload.instanceId,
        phone: payload.phone,
        text: payload.text,
        media: payload.media,
    }, { timeout: 10000, headers });
    return response.data;
}
