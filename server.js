"use strict";

const http = require("node:http");
const path = require("node:path");
const express = require("express");
const { Server } = require("socket.io");
const { ClassroomState } = require("./src/state");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const state = new ClassroomState();

app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, users: state.snapshot().userCount });
});

function respond(reply, payload) {
  if (typeof reply === "function") {
    reply(payload);
  }
}

function broadcastState() {
  io.emit("state:update", state.snapshot());
}

function notifyCompleteIfNeeded() {
  if (state.consumeCompletionIfReady()) {
    const snapshot = state.snapshot();
    io.to("admins").emit("push:complete", {
      roundId: snapshot.push.roundId,
      message: "접속한 모든 사용자가 푸쉬버튼을 눌렀습니다.",
    });
  }
}

function requireAdmin(socket, reply) {
  if (socket.data.role !== "admin") {
    respond(reply, { ok: false, error: "운영자 권한이 필요합니다." });
    return false;
  }

  return true;
}

io.on("connection", (socket) => {
  socket.emit("state:update", state.snapshot());

  socket.on("user:join", (payload, reply) => {
    try {
      const user = state.addUser(socket.id, payload?.nickname);
      socket.data.role = "user";
      socket.join("users");
      state.addSystemMessage(`${user.nickname}님이 입장했습니다.`);
      respond(reply, { ok: true, state: state.snapshot(), userId: socket.id });
      broadcastState();
    } catch (error) {
      respond(reply, { ok: false, error: error.message });
    }
  });

  socket.on("admin:login", (payload, reply) => {
    const password = String(payload?.password ?? "");
    if (password !== ADMIN_PASSWORD) {
      respond(reply, {
        ok: false,
        error: "운영자 비밀번호가 올바르지 않습니다.",
      });
      return;
    }

    state.addAdmin(socket.id);
    socket.data.role = "admin";
    socket.join("admins");
    respond(reply, { ok: true, state: state.snapshot() });
    broadcastState();
  });

  socket.on("chat:send", (payload, reply) => {
    try {
      const message = state.addChatMessage({
        socketId: socket.id,
        body: payload?.body,
      });

      respond(reply, { ok: true, message });
      broadcastState();
    } catch (error) {
      respond(reply, { ok: false, error: error.message });
    }
  });

  socket.on("push:start", (_payload, reply) => {
    if (!requireAdmin(socket, reply)) {
      return;
    }

    try {
      const roundId = state.startPushRound();
      state.addSystemMessage("운영자가 푸쉬버튼을 시작했습니다.");
      respond(reply, { ok: true, roundId });
      io.to("users").emit("push:requested", { roundId });
      broadcastState();
    } catch (error) {
      respond(reply, { ok: false, error: error.message });
    }
  });

  socket.on("push:press", (_payload, reply) => {
    try {
      const result = state.markPressed(socket.id);
      respond(reply, { ok: true, roundId: result.roundId });
      broadcastState();

      if (result.shouldNotifyComplete) {
        io.to("admins").emit("push:complete", {
          roundId: result.roundId,
          message: "접속한 모든 사용자가 푸쉬버튼을 눌렀습니다.",
        });
      }
    } catch (error) {
      respond(reply, { ok: false, error: error.message });
    }
  });

  socket.on("push:reset", (_payload, reply) => {
    if (!requireAdmin(socket, reply)) {
      return;
    }

    state.resetPushRound();
    state.addSystemMessage("푸쉬 상태가 초기화되었습니다.");
    respond(reply, { ok: true });
    io.emit("push:reset");
    broadcastState();
  });

  socket.on("disconnect", () => {
    const removed = state.remove(socket.id);
    if (removed?.role === "user") {
      state.addSystemMessage(`${removed.user.nickname}님이 나갔습니다.`);
      notifyCompleteIfNeeded();
      broadcastState();
    } else if (removed?.role === "admin") {
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Button push site listening on http://localhost:${PORT}`);
});
