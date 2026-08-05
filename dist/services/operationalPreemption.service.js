import { menuItemBlockedByNotes } from "./noteProvenance.service.js";
function normalize(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/ё/g, "е")
        .replace(/[^а-яәғқңөұүһіa-z0-9]+/giu, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function stemOf(term) {
    if (term.length >= 6)
        return term.slice(0, term.length - 2);
    if (term.length >= 5)
        return term.slice(0, term.length - 1);
    return term;
}
function messageNamesItem(message, itemName) {
    const words = normalize(message).split(" ").filter(Boolean);
    // Parentheses usually contain an alias ("Донер (или донер-кебаб)"). A guest
    // naming the primary menu title must not be forced to repeat every alias.
    const primaryName = itemName.replace(/\([^)]*\)/gu, " ").trim() || itemName;
    const nameTerms = normalize(primaryName).split(" ").filter((term) => term.length >= 3);
    return nameTerms.length > 0 && nameTerms.every((term) => {
        const stem = stemOf(term);
        return words.some((word) => word.startsWith(stem));
    });
}
export function findBlockedMenuItemMention(notes = [], menuItems = [], customerText = "") {
    if (!notes.length || !menuItems.length || !normalize(customerText))
        return null;
    for (const item of menuItems) {
        const name = String(item?.name || item?.title || "").trim();
        if (!name || !messageNamesItem(customerText, name))
            continue;
        const blocked = menuItemBlockedByNotes(notes, item);
        if (!blocked.blocked)
            continue;
        return {
            name,
            price: item?.price ?? null,
            noteIds: blocked.noteIds,
        };
    }
    return null;
}
export function buildBlockedMenuItemReply(item, language) {
    return language === "ru"
        ? `Сейчас ${item.name} временно недоступны. Помочь выбрать другое блюдо?`
        : `${item.name} қазір уақытша қолжетімсіз. Басқа тағам таңдауға көмектесейін бе?`;
}
export function isUnverifiedPaymentClaim(text = "") {
    const value = normalize(text);
    if (!value)
        return false;
    const pastPaymentClaim = /(аудардым|аударып\s+қойдым|аударып\s+жібердім|төледім|толедим|оплатила?|перевела?|деньги\s+отправила?|payment\s+sent|paid\s+[қк]ыл)/iu.test(value);
    const paymentContext = /(каспи|kaspi|төлем|толем|оплат|аудар|перевел|paid|тг|теңге|тенге|заказ|тапсырыс)/iu.test(value);
    return pastPaymentClaim && paymentContext;
}
export function buildUnverifiedPaymentClaimReply(language) {
    return language === "ru"
        ? "Отправьте чек или полный скриншот оплаты в этот чат. Оператор проверит его и сам подтвердит статус на сайте."
        : "Чек немесе төлемнің толық скриншотын осы чатқа жіберіңіз. Оператор оны тексеріп, сайттағы статусты өзі растайды.";
}
