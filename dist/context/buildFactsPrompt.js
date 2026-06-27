function compactRuntime(runtime) {
    if (!runtime)
        return null;
    return {
        is_accepting_orders: runtime.is_accepting_orders,
        within_work_hours: runtime.within_work_hours,
        closed_reason: runtime.closed_reason,
        delivery: runtime.delivery,
        pickup: runtime.pickup,
        wait_time: Number(runtime.wait_time || 0),
        reset_at: Number(runtime.reset_at || 0),
        is_emergency: Boolean(runtime.is_emergency),
        payment_details: Array.isArray(runtime.payment_details) ? runtime.payment_details : [],
        source: runtime.source,
        stale: Boolean(runtime.stale || runtime.is_stale),
    };
}
function compactOrder(order) {
    if (!order)
        return null;
    return {
        order_id: order.order_id || order.id,
        status: order.status,
        status_text: order.status_text,
        total_price: order.total_price,
        items: order.items || order.cart_items || [],
        is_stale: Boolean(order.is_stale),
    };
}
export function buildFactsPrompt(ctx) {
    const runtime = compactRuntime(ctx.runtimeStatus);
    const activeOrder = compactOrder(ctx.activeOrder);
    const notes = ctx.activeShiftNotes.map((note) => ({
        id: note.id,
        text: note.text,
        expires_at: note.expires_at || note.expiresAt,
        category: note.category,
    }));
    return [
        "FACTS_CONTEXT_START",
        JSON.stringify({
            now_iso: new Date().toISOString(),
            language: ctx.language,
            restaurant: {
                instance_id: ctx.instanceId,
                name: ctx.config.name,
                domain: ctx.config.domain,
                work_hours: ctx.config.work_hours,
            },
            runtime_status: runtime,
            active_order: activeOrder,
            active_shift_notes: notes,
            magic_link: {
                already_sent: ctx.magicLinkAlreadySent,
                explicit_request: ctx.explicitMenuLinkIntent,
                value_available: Boolean(ctx.magicLink),
                validity_rule: "Magic link is valid for 1 month and is tied to the customer's WhatsApp number.",
            },
            recent_dialog: ctx.chatHistory.slice(-8),
            shpor_context: ctx.shporContext.slice(0, 6),
        }, null, 2),
        "FACTS_CONTEXT_END",
    ].join("\n");
}
