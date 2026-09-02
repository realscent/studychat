"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const { Server } = require("socket.io");
const { ClassroomState, normalizeIpAddress } = require("./src/state");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";
const BLOCKLIST_FILE =
  process.env.BLOCKLIST_FILE || path.join(__dirname, "data", "blocked-ips.json");

function loadBlockedIps() {
  if (!fs.existsSync(BLOCKLIST_FILE)) {
    return [];
  }

  try {
    const text = fs.readFileSync(BLOCKLIST_FILE, "utf8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn(`Could not load blocklist file: ${error.message}`);
    return [];
  }
}

function saveBlockedIps(entries) {
  fs.mkdirSync(path.dirname(BLOCKLIST_FILE), { recursive: true });
  fs.writeFileSync(BLOCKLIST_FILE, `${JSON.stringify(entries, null, 2)}\n`);
}

const app = express();
app.set("trust proxy", true);

const server = http.createServer(app);
const io = new Server(server);
const state = new ClassroomState({ blockedIps: loadBlockedIps() });

app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, users: state.snapshot().userCount });
});

function respond(reply, payload) {
  if (typeof reply === "function") {
    reply(payload);
  }
}

function getHeaderValue(headers, name) {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function getSocketIp(socket) {
  const headers = socket.handshake.headers ?? {};
  const forwarded =
    getHeaderValue(headers, "cf-connecting-ip") ||
    getHeaderValue(headers, "x-real-ip") ||
    getHeaderValue(headers, "x-forwarded-for");
  const firstForwarded = String(forwarded ?? "").split(",")[0].trim();

  return normalizeIpAddress(firstForwarded || socket.handshake.address);
}

function getSnapshotFor(socket) {
  return state.snapshot({ includeAdmin: socket.data.role === "admin" });
}

function sendState(socket) {
  socket.emit("state:update", getSnapshotFor(socket));
}

function broadcastState() {
  io.sockets.sockets.forEach((socket) => sendState(socket));
}

function persistBlocklist() {
  saveBlockedIps(state.getBlockedIps());
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

function rejectBlockedUser(socket, reply) {
  if (!state.isIpBlocked(socket.data.ipAddress)) {
    return false;
  }

  const message = "차단된 IP입니다. 운영자에게 문의하세요.";
  socket.emit("access:blocked", { message, ipAddress: socket.data.ipAddress });
  respond(reply, { ok: false, error: message });
  return true;
}

io.on("connection", (socket) => {
  socket.data.ipAddress = getSocketIp(socket);

  if (state.isIpBlocked(socket.data.ipAddress)) {
    socket.emit("access:blocked", {
      message: "차단된 IP입니다. 운영자에게 문의하세요.",
      ipAddress: socket.data.ipAddress,
    });
  }

  sendState(socket);

  socket.on("user:join", (payload, reply) => {
    try {
      if (rejectBlockedUser(socket, reply)) {
        return;
      }

      const existingUser = state.getUserByClientId(payload?.clientId);
      const user = state.addUser(
        socket.id,
        payload?.nickname,
        socket.data.ipAddress,
        payload?.clientId,
      );
      socket.data.role = "user";
      socket.join("users");
      if (!existingUser) {
        state.addSystemMessage(`${user.nickname}님이 입장했습니다.`);
      }
      respond(reply, {
        ok: true,
        state: getSnapshotFor(socket),
        userId: user.id,
        nickname: user.nickname,
      });
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

    state.addAdmin(socket.id, "운영자", socket.data.ipAddress);
    socket.data.role = "admin";
    socket.join("admins");
    respond(reply, { ok: true, state: getSnapshotFor(socket) });
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

  socket.on("admin:kick-user", (payload, reply) => {
    if (!requireAdmin(socket, reply)) {
      return;
    }

    try {
      const user = state.getUser(payload?.userId);
      if (!user) {
        throw new Error("강퇴할 사용자를 찾을 수 없습니다.");
      }

      const blocked = state.blockIp(
        user.ipAddress,
        `강퇴: ${user.nickname}`,
      );
      persistBlocklist();

      const affectedUsers = state.getUsersByIp(blocked.ipAddress);
      affectedUsers.forEach((affectedUser) => {
        const socketIds = Array.from(affectedUser.socketIds);
        state.removeUser(affectedUser.id);
        socketIds.forEach((socketId) => {
          const affectedSocket = io.sockets.sockets.get(socketId);
          affectedSocket?.emit("access:blocked", {
            message: "운영자에 의해 강퇴되어 접속이 차단되었습니다.",
            ipAddress: blocked.ipAddress,
          });
          affectedSocket?.disconnect(true);
        });
      });

      state.addSystemMessage(
        `${blocked.ipAddress} IP가 차단되어 ${affectedUsers.length}명이 강퇴되었습니다.`,
      );
      notifyCompleteIfNeeded();
      respond(reply, {
        ok: true,
        blocked,
        kickedCount: affectedUsers.length,
      });
      broadcastState();
    } catch (error) {
      respond(reply, { ok: false, error: error.message });
    }
  });

  socket.on("admin:unblock-ip", (payload, reply) => {
    if (!requireAdmin(socket, reply)) {
      return;
    }

    try {
      const ipAddress = state.unblockIp(payload?.ipAddress);
      persistBlocklist();
      state.addSystemMessage(`${ipAddress} IP 차단이 해제되었습니다.`);
      respond(reply, { ok: true, ipAddress });
      io.sockets.sockets.forEach((clientSocket) => {
        if (clientSocket.data.ipAddress === ipAddress) {
          clientSocket.emit("access:unblocked", {
            message: "IP 차단이 해제되었습니다. 다시 입장할 수 있습니다.",
            ipAddress,
          });
        }
      });
      broadcastState();
    } catch (error) {
      respond(reply, { ok: false, error: error.message });
    }
  });

  socket.on("admin:delete-message", (payload, reply) => {
    if (!requireAdmin(socket, reply)) {
      return;
    }

    try {
      const deletedMessage = state.deleteMessage(payload?.messageId);
      respond(reply, { ok: true, deletedMessage });
      broadcastState();
    } catch (error) {
      respond(reply, { ok: false, error: error.message });
    }
  });

  socket.on("disconnect", () => {
    const removed = state.remove(socket.id);
    if (removed?.role === "user") {
      state.addSystemMessage(`${removed.user.nickname}님이 나갔습니다.`);
      notifyCompleteIfNeeded();
      broadcastState();
    } else if (removed?.role === "user-tab") {
      broadcastState();
    } else if (removed?.role === "admin") {
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Smart drone classroom listening on http://localhost:${PORT}`);
});
