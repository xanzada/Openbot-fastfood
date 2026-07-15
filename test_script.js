import { handleKanbanWebhook } from "./dist/controllers/kanban.js";

const mockRes = {
    status: (code) => ({ json: (data) => console.log(`Status ${code}:`, data) }),
    json: (data) => console.log('JSON:', data)
};

const reqs = [
    { body: { action: 'update_kitchen_status', instanceId: 'test1', status: { wait_time: 40 } } },
    { body: { action: 'developer_alert', instanceId: 'test1', text: 'Simulated DB drop' } }
];

async function run() {
    console.log("Simulating update_kitchen_status...");
    await handleKanbanWebhook({ ...reqs[0], app: { get: () => null } }, mockRes);

    console.log("\nSimulating developer_alert...");
    await handleKanbanWebhook({ ...reqs[1], app: { get: () => null } }, mockRes);
}

run();
