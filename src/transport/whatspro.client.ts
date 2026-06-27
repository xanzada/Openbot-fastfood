import axios from "axios";

export async function sendWhatsProMessage(payload: {
  instanceId: string;
  phone: string;
  text: string;
}) {
  const url = process.env.WHATSPRO_SEND_URL;
  if (!url) return { skipped: true, reason: "WHATSPRO_SEND_URL is not configured" };

  const response = await axios.post(
    url,
    {
      instanceId: payload.instanceId,
      phone: payload.phone,
      text: payload.text,
    },
    { timeout: 10000 }
  );
  return response.data;
}
