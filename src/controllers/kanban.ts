import { getPhoneCandidatesFromWebhook, getRuntimeStatus, normalizePhone, normalizePhoneFromCandidates } from "../services/dle.service.js";
import { getRestaurantConfig } from "../services/nocodb.service.js";
import { deleteShiftNote, saveShiftNote } from "../services/redis.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";

const templates: Record<string, Record<string, string>> = {
  kk: {
    review: '⏳ Чек тексерілуде. Оператор растаған соң дайындаймыз.',
    paid: '✅ Төлем расталды, тапсырысыңыз қабылданды. Дайындалуда! 🍳',
    delivery: '🛵 Тапсырысыңыз курьерге берілді, жеткізу жолында.',
    completed: '🎉 Тапсырыс сәтті аяқталды, асыңыз дәмді болсын!',
    pickup_ready: '✅ Тапсырысыңыз дайын! Келіп алып кетуіңізге болады.',
    cancelled: '❌ Тапсырысыңыздан бас тартылды. Қажет болса, мәзір арқылы жаңа тапсырыс рәсімдей аласыз.',
    missing_payment: 'Реквизиттер әзірге бапталмаған. Оператор жауабын күте тұрыңыз.'
  },
  ru: {
    review: '⏳ Чек проверяется. Как только оператор подтвердит, начнем готовить.',
    paid: '✅ Оплата подтверждена, заказ принят. Готовим! 🍳',
    delivery: '🛵 Ваш заказ передан курьеру и уже в пути.',
    completed: '🎉 Заказ успешно доставлен, приятного аппетита!',
    pickup_ready: '✅ Ваш заказ готов! Можете забирать.',
    cancelled: '❌ Ваш заказ отменен. При необходимости вы можете оформить новый заказ через меню.',
    missing_payment: 'Реквизиты пока не настроены. Пожалуйста, подождите ответ оператора.'
  }
};

function getTemplate(lang: string, key: string): string {
  const normalizedLang = (lang === 'kk' || lang === 'kz') ? 'kk' : 'ru';
  return templates[normalizedLang]?.[key] || templates.ru[key] || '';
}

function getInstanceId(body: Record<string, any>) {
  return String(body.instanceId || body.instance || body.restaurant_id || "").trim();
}

function getPhone(body: Record<string, any>) {
  const eventData = body.data || body;
  const key = eventData.key || body.key || {};
  return normalizePhoneFromCandidates(getPhoneCandidatesFromWebhook(body, eventData, key));
}

function paymentDetailsText(details: any[]) {
  if (!details.length) return "";
  return details
    .map((item) => `${String(item.label || "Реквизит").trim()}: ${String(item.value || "").trim()}`)
    .filter(Boolean)
    .join("\n");
}

function emitPrintNewOrder(req: any, orderData: Record<string, any>) {
  const io = req.app.get("io");
  if (!io) {
    console.error("[SOCKET] Error: Socket.io (io) not found.");
    return false;
  }
  io.emit("print_new_order", orderData);
  console.log(`[SOCKET] Print signal sent. Order: #${orderData.order_id || orderData.id || "-"}`);
  return true;
}

export async function handleKanbanWebhook(req: any, res: any) {
  const body = req.body || {};
  const instanceId = getInstanceId(body);
  const action = String(body.action || body.event || "").trim();
  const phone = getPhone(body);
  const lang = String(body.lang || "ru").toLowerCase();

  if (!instanceId) return res.status(400).json({ ok: false, error: "instance is required" });

  const io = req.app.get("io");

  // Sync Shift Notes (Redis)
  if (action === "shift_note_created") {
    await saveShiftNote(instanceId, body.id || body.note_id || body.key, body.text || body.note, body.expires_at || body.expiresAt);
    return res.json({ ok: true, action, saved: true });
  }

  if (action === "shift_note_deleted") {
    await deleteShiftNote(instanceId, body.id || body.note_id || body.key, body.text || body.note || "");
    return res.json({ ok: true, action, deleted: true });
  }

  // Kitchen Status Update (Pass-through for metrics/tracking or forcing local cache clears if needed in the future)
  if (action === "update_kitchen_status") {
      // In a more complex integration, we might push this to Redis immediately to bypass NocoDB caching,
      // but the current architecture relies on DLE and getRuntimeStatus fetching it.
      // We will acknowledge the hook here to maintain feature parity.
      return res.json({ ok: true, action: "update_kitchen_status_acknowledged", status: body.status || {} });
  }

  if (action === "get_kitchen_status") {
      return res.json({ ok: true, action: "get_kitchen_status_acknowledged" });
  }

  // DLE Order Flow
  if (action === "new_order" && phone) {
    if (io) emitPrintNewOrder(req, body);

    let cartMessage = `📦 Жаңа тапсырыс / Новый заказ #${body.order_id || 'Белгісіз'}\n\n`;
    if (Array.isArray(body.items)) {
      cartMessage += body.items.map((item: any) =>
        `▪️ ${item.name || 'Тауар'} x${item.quantity || 1} = ${item.price || 0} ₸`
      ).join('\n');
    }

    const totalPrice = body.total_price || 0;
    cartMessage += `\n\nБарлығы / Итого: ${totalPrice} ₸`;

    await sendWhatsProMessage({
      instanceId,
      phone,
      text: cartMessage
    });

    return res.json({ ok: true, action, sent: true });
  }

  if (action === "print_order" || body.print) {
      if (io) emitPrintNewOrder(req, body);
      return res.json({ ok: true, action: "print_order" });
  }

  if (action === "status_changed" && phone) {
    const kanbanStatus = String(body?.status || body?.new_status || body?.order_status || "").trim();
    if (kanbanStatus === "paid") {
      emitPrintNewOrder(req, body);
    }

    let templateKey = kanbanStatus;
    // Map DLE status correctly if needed
    if (kanbanStatus === "delivery" && body.is_pickup) {
        templateKey = "pickup_ready";
    }

    const message = getTemplate(lang, templateKey);
    if (message) {
      await sendWhatsProMessage({
        instanceId,
        phone,
        text: message
      });
      return res.json({ ok: true, action, sent: true, status: kanbanStatus });
    }
    return res.json({ ok: true, action, sent: false, reason: "unknown_status" });
  }

  if (action === "request_payment" && phone) {
    const config = await getRestaurantConfig(instanceId);
    const runtime = config?.domain ? await getRuntimeStatus(instanceId, config.domain, { forceFresh: true }) : null;
    const runtimeDetails = Array.isArray(runtime?.payment_details) ? runtime.payment_details : [];
    const fallback = !runtimeDetails.length && config?.kaspi_info
      ? [{ label: "Kaspi", value: config.kaspi_info, source: "nocodb_fallback" }]
      : [];
    const detailsText = paymentDetailsText(runtimeDetails.length ? runtimeDetails : fallback);

    if (detailsText) {
      await sendWhatsProMessage({
        instanceId,
        phone,
        text: `Төлем реквизиттері:\n${detailsText}\n\nТөлеген соң чекті осы чатқа жіберіңіз.`
      });
      return res.json({ ok: true, action, sent: true });
    } else {
      const fallbackMsg = getTemplate(lang, "missing_payment");
      await sendWhatsProMessage({
        instanceId,
        phone,
        text: fallbackMsg
      });
      return res.json({ ok: true, action, sent: true, missing: true });
    }
  }

  if (action === "order_rejected" && phone) {
      const message = getTemplate(lang, "cancelled");
      await sendWhatsProMessage({
          instanceId,
          phone,
          text: message
      });
      return res.json({ ok: true, action, sent: true });
  }

  // Developer Alerts / Complaint routing
  if (action === "developer_alert" || action === "complaint") {
      const config = await getRestaurantConfig(instanceId);
      const developerPhone = normalizePhone(config?.developer || config?.developer_phone || config?.dev_phone || process.env.DEVELOPER_PHONE || "");
      if (developerPhone) {
          const alertMessage = body.text || body.message || `🚨 Тұтынушы шағымы / Системалық қате (Instance: ${instanceId})`;
          await sendWhatsProMessage({
             instanceId,
             phone: developerPhone,
             text: `[SYSTEM ALERT]: ${alertMessage}`
          });
      }
      return res.json({ ok: true, action: "alert_sent" });
  }

  if (body.text || body.message) {
    if (!phone) return res.status(400).json({ ok: false, error: "phone is required" });
    const send = await sendWhatsProMessage({
      instanceId,
      phone,
      text: String(body.text || body.message),
    });
    return res.json({ ok: true, action: action || "send_message", send });
  }

  return res.json({ ok: true, action: action || "noop" });
}
