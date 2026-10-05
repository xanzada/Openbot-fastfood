import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Server } from "socket.io";

test("transport upgrade must keep the existing Engine.IO protocol before socket authentication", () => {
  const io = new Server(http.createServer(), {cors: {origin: false}});
  let socketAuthCalls = 0;
  io.use((_socket, next) => {socketAuthCalls += 1; next(new Error("unauthorized"));});
  const engine = io.engine as any;
  engine.clients.auditSynthetic = {protocol: 4, transport: {name: "polling"}};
  try {
    for (const eio of ["4", "3", undefined]) {
      let code: number | undefined;
      const query: Record<string, string> = {transport: "websocket", sid: "auditSynthetic"};
      if (eio !== undefined) query.EIO = eio;
      engine.verify({_query: query, headers: {}, method: "GET"}, true, (result: number | undefined) => {code = result;});
      assert.equal(code === undefined, eio === "4", "an upgrade cannot change or omit the negotiated protocol");
    }
    assert.equal(socketAuthCalls, 0, "protocol check must reject mismatches before application authentication");
  } finally {
    delete engine.clients.auditSynthetic;
    io.close();
  }
});
