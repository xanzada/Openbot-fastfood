import axios from "axios";

function maskPhone(phone = "") {
  const clean = String(phone || "").replace(/\D/g, "");
  if (clean.length <= 6) return clean || "-";
  return `${clean.slice(0, 3)}***${clean.slice(-3)}`;
}

function hostFromUrl(url = "") {
  try {
    return new URL(url).host;
  } catch {
    return url || "-";
  }
}

export async function sendWhatsProMessage(payload: {
  instanceId: string;
  phone: string;
  text: string;
  media?: any;
}) {
  const baseUrl = String(process.env.WHATSPRO_BASE_URL || "").replace(/\/+$/, "");
  const url = process.env.WHATSPRO_SEND_URL || (baseUrl ? `${baseUrl}/api/send` : "");
  if (!url) {
    console.warn("[OPENBOT:WHATSPRO:SKIP] WHATSPRO_SEND_URL or WHATSPRO_BASE_URL is not configured");
    return { skipped: true, reason: "WHATSPRO_SEND_URL or WHATSPRO_BASE_URL is not configured" };
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.WHATSPRO_API_TOKEN) {
    headers.authorization = `Bearer ${process.env.WHATSPRO_API_TOKEN}`;
    headers["x-api-key"] = process.env.WHATSPRO_API_TOKEN;
  }

  const started = Date.now();
  console.log(
    `[OPENBOT:WHATSPRO] send begin host=${hostFromUrl(url)} instance=${payload.instanceId} phone=${maskPhone(payload.phone)} text_len=${payload.text?.length || 0} media=${payload.media ? "yes" : "no"}`
  );

  try {
    const response = await axios.post(
      url,
      {
        instanceId: payload.instanceId,
        phone: payload.phone,
        text: payload.text,
        media: payload.media,
      },
      { timeout: 10000, headers }
    );
    console.log(
      `[OPENBOT:WHATSPRO:OK] status=${response.status} elapsed=${Date.now() - started}ms instance=${payload.instanceId} phone=${maskPhone(payload.phone)}`
    );
    return response.data;
  } catch (error: any) {
    console.error(
      `[OPENBOT:WHATSPRO:FAIL] elapsed=${Date.now() - started}ms instance=${payload.instanceId} phone=${maskPhone(payload.phone)} status=${error?.response?.status || "-"} error=${error?.message || error}`
    );
    throw error;
  }
}
