import type { FastFoodContext } from "../context/types.js";
import { routeComplaintToAdmin } from "./complaintRouting.service.js";

/**
 * Two answers that must not depend on a model (owner rules, 2026-10-04).
 *
 * 1. No model answered. The A6API proxy rejects angry guests («где мой заказ?? 55 минут»)
 *    with a security-check 400 on every lane, and a lane can time out; the webhook then
 *    threw and the guest got silence on exactly the turn that mattered most. Now the
 *    guest gets a holding line and the operator gets an SOS.
 * 2. A composition / allergen question about dishes whose catalog entry has no
 *    ingredients. Any answer would be a guess about a child's allergy, so the bot only
 *    says it is checking with the kitchen - and an SOS makes that sentence true.
 */

type Route = typeof routeComplaintToAdmin;

const say = (ctx: FastFoodContext, kk: string, ru: string) => (ctx.language === "kk" ? kk : ru);

export async function answerAgentFailure(ctx: FastFoodContext, error: unknown, route: Route = routeComplaintToAdmin) {
  const reason = String((error as any)?.message || error || "unknown").slice(0, 80);
  const routing = await route(ctx, {
    summary: `ИИ жауап бере алмады (${reason}). Клиент жазды: ${String(ctx.text || "").slice(0, 300)}`,
    customerText: ctx.text,
    urgency: "high",
    source: "ai_unavailable",
  }).catch(() => null);
  return routing?.action === "operator_case_created"
    ? say(ctx, "Кешіріңіз, қазір ақпаратты нақтылап жатырмыз. Оператор осы чатта жақын арада жауап береді.",
      "Извините, уточняем информацию. Оператор ответит вам в этом чате в ближайшее время.")
    : say(ctx, "Кешіріңіз, қазір ақпаратты нақтылап жатырмыз. Бір-екі минуттан кейін қайта жазыңызшы.",
      "Извините, уточняем информацию. Напишите, пожалуйста, ещё раз через пару минут.");
}

// «составить заказ» is not a composition question, «составе» is.
const COMPOSITION_QUESTION_RE =
  /(құрам|курам|состав(?![иял])|ингредиент|аллерг|жаңғақ|жангак|орех|глютен|лактоз|ішінде не|ишинде не|что внутри|из чего)/iu;
const fold = (value: unknown) => String(value || "").toLowerCase().replace(/ё/g, "е");

/**
 * True when the guest asks what is inside a dish and the menu cannot say: either the
 * whole catalog carries no ingredients (dorumclub: 71 of 71 empty), or every dish the
 * guest names has none. A snapshot without a `composition` field says nothing, so it
 * changes nothing.
 */
export function needsKitchenCompositionCheck(ctx: FastFoodContext): boolean {
  if (!COMPOSITION_QUESTION_RE.test(String(ctx.text || ""))) return false;
  const items: any[] = Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot!.items : [];
  if (!items.length || items.some((item) => !("composition" in Object(item)))) return false;
  const known = (item: any) => Boolean(String(item.composition || "").trim());
  if (!items.some(known)) return true;
  const text = fold(ctx.text);
  const named = items.filter((item) => {
    const head = fold(item.name).split(/\s+/)[0] || "";
    return head.length >= 4 && text.includes(head);
  });
  return named.length > 0 && !named.some(known);
}

export async function answerCompositionQuestion(ctx: FastFoodContext, route: Route = routeComplaintToAdmin) {
  const routing = await route(ctx, {
    summary: `Құрам / аллерген сұрағы, мәзірде құрамы жоқ: ${String(ctx.text || "").slice(0, 300)}`,
    customerText: ctx.text,
    urgency: "normal",
    source: "composition_check",
  }).catch(() => null);
  // Without a person behind it the kitchen promise would be false, so the fallback only
  // says what is true: there is no verified composition to quote.
  return routing?.action === "operator_case_created"
    ? say(ctx, "Құрамын дәл қазір асүйден нақтылап беремін.", "Уточняю точный состав на кухне.")
    : say(ctx, "Құрамы бойынша нақты дерек қазір жоқ, сондықтан кепілдік бере алмаймын.",
      "Точного состава у меня сейчас нет, поэтому гарантировать не могу.");
}
