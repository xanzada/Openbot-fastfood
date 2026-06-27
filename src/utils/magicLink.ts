import crypto from "node:crypto";

export function buildMagicLink(domain: string, phone: string): string | null {
  const secret = process.env.CRM_SECRET_TOKEN;
  if (!domain || !phone || !secret) return null;
  const cleanDomain = String(domain).replace(/\/+$/, "");
  const timestamp = Date.now();
  const hash = crypto
    .createHash("sha256")
    .update(`${phone}${secret}${timestamp}`)
    .digest("hex");
  const cb = Math.floor(Math.random() * 9999999);
  return `${cleanDomain}/?phone=${phone}&hash=${hash}&t=${timestamp}&cb=${cb}`;
}

export function hasExplicitMenuLinkIntent(text: string): boolean {
  const value = String(text || "").toLowerCase();
  return /(сілтеме|ссылка|link|линк|меню жібер|мәзір жібер|меню бер|мәзір бер|қайта жібер|жоғалтып|өшіп|қалай заказ|қалай тапсырыс|заказ бер|тапсырыс бер)/iu.test(
    value
  );
}
