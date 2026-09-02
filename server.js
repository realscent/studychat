"use strict";

const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const { Server } = require("socket.io");
const { ClassroomState, normalizeIpAddress } = require("./src/state");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";
const BLOCKLIST_FILE =
  process.env.BLOCKLIST_FILE || path.join(__dirname, "data", "blocked-ips.json");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "data", "uploads");
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024);
const MAX_ATTACHMENTS_PER_UPLOAD = 4;
const INLINE_MEDIA_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
]);

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
const io = new Server(server, {
  maxHttpBufferSize: MAX_UPLOAD_BYTES * MAX_ATTACHMENTS_PER_UPLOAD + 1024 * 1024,
});
const state = new ClassroomState({ blockedIps: loadBlockedIps() });

app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/uploads",
  express.static(UPLOAD_DIR, {
    fallthrough: false,
    setHeaders(res, filePath) {
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (!INLINE_MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        res.setHeader("Content-Disposition", "attachment");
      }
    },
  }),
);

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

function createSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function disconnectSockets(socketIds) {
  socketIds.forEach((socketId) => {
    const target = io.sockets.sockets.get(socketId);
    target?.disconnect(true);
  });
}

function sanitizeOriginalName(input) {
  const basename = path.basename(String(input ?? "첨부파일"));
  return basename.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").slice(0, 120) || "첨부파일";
}

function getStoredExtension(originalName, mimeType) {
  const rawExtension = path.extname(originalName).toLowerCase();
  if (/^\.[a-z0-9]{1,12}$/.test(rawExtension)) {
    return rawExtension;
  }

  const fallbackByMime = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };

  return fallbackByMime[mimeType] || ".bin";
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) {
    return input;
  }

  if (input instanceof ArrayBuffer) {
    return Buffer.from(input);
  }

  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }

  return null;
}

function getAttachmentKind(mimeType) {
  if (mimeType.startsWith("image/")) {
    return "image";
  }

  if (mimeType.startsWith("video/")) {
    return "video";
  }

  return "file";
}

function saveUploadedFile(payload) {
  const buffer = toBuffer(payload?.file);
  if (!buffer || buffer.length === 0) {
    throw new Error("업로드할 파일이 없습니다.");
  }

  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`파일은 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 이하만 가능합니다.`);
  }

  const originalName = sanitizeOriginalName(payload?.name);
  const mimeType = String(payload?.type || "application/octet-stream").slice(0, 120);
  const id = crypto.randomUUID();
  const storedName = `${id}${getStoredExtension(originalName, mimeType)}`;
  const filePath = path.join(UPLOAD_DIR, storedName);

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(filePath, buffer);

  return {
    id,
    originalName,
    mimeType,
    size: buffer.length,
    url: `/uploads/${encodeURIComponent(storedName)}`,
    kind: getAttachmentKind(mimeType),
  };
}

function saveUploadedFiles(payload) {
  const rawFiles = Array.isArray(payload?.files) ? payload.files : [payload];
  if (rawFiles.length === 0) {
    throw new Error("업로드할 파일이 없습니다.");
  }

  if (rawFiles.length > MAX_ATTACHMENTS_PER_UPLOAD) {
    throw new Error(
      `한 메시지에는 파일을 ${MAX_ATTACHMENTS_PER_UPLOAD}개까지 첨부할 수 있습니다.`,
    );
  }

  const attachments = [];
  try {
    rawFiles.forEach((filePayload) => {
      attachments.push(saveUploadedFile(filePayload));
    });
    return attachments;
  } catch (error) {
    deleteAttachmentFiles(attachments);
    throw error;
  }
}

function deleteAttachmentFiles(attachments = []) {
  const uploadRoot = path.resolve(UPLOAD_DIR);

  attachments.forEach((attachment) => {
    try {
      const pathname = new URL(attachment.url, "http://localhost").pathname;
      const storedName = decodeURIComponent(path.basename(pathname));
      const filePath = path.resolve(UPLOAD_DIR, storedName);
      if (!filePath.startsWith(`${uploadRoot}${path.sep}`)) {
        return;
      }

      fs.rmSync(filePath, { force: true });
    } catch (_error) {
      // Best effort cleanup; the chat message deletion should still succeed.
    }
  });
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

  socket.on("session:resume", (payload, reply) => {
    try {
      const requestedRole = String(payload?.role ?? "");
      const clientId = payload?.clientId;

      if (requestedRole === "user") {
        if (rejectBlockedUser(socket, reply)) {
          return;
        }

        const existingUser = state.getUserByClientId(clientId);
        const user = state.addUser(
          socket.id,
          payload?.nickname,
          socket.data.ipAddress,
          clientId,
        );
        socket.data.role = "user";
        socket.data.clientId = user.clientId;
        socket.join("users");
        if (!existingUser) {
          state.addSystemMessage(`${user.nickname}님이 입장했습니다.`);
        }
        respond(reply, {
          ok: true,
          role: "user",
          state: getSnapshotFor(socket),
          userId: user.id,
          nickname: user.nickname,
        });
        broadcastState();
        return;
      }

      if (requestedRole === "admin") {
        const existingAdmin = state.getAdminSession(
          clientId,
          payload?.adminSessionToken,
        );
        if (!existingAdmin) {
          throw new Error("운영자 세션이 만료되었습니다. 다시 로그인하세요.");
        }

        const admin = state.addAdmin(
          socket.id,
          existingAdmin.name,
          socket.data.ipAddress,
          clientId,
          existingAdmin.sessionToken,
        );
        socket.data.role = "admin";
        socket.data.clientId = admin.clientId;
        socket.join("admins");
        respond(reply, {
          ok: true,
          role: "admin",
          state: getSnapshotFor(socket),
          adminSessionToken: admin.sessionToken,
        });
        broadcastState();
        return;
      }

      throw new Error("재개할 세션 정보가 없습니다.");
    } catch (error) {
      respond(reply, { ok: false, error: error.message });
    }
  });

  socket.on("session:leave", (_payload, reply) => {
    const client = state.getClient(socket.id);
    if (!client) {
      respond(reply, { ok: true });
      return;
    }

    if (client.role === "user") {
      const socketIds = Array.from(client.user.socketIds);
      const removed = state.removeUser(client.user.id);
      if (removed) {
        state.addSystemMessage(`${removed.nickname}님이 나갔습니다.`);
        notifyCompleteIfNeeded();
      }
      socketIds.forEach((socketId) => {
        io.sockets.sockets.get(socketId)?.emit("session:left");
      });
      respond(reply, { ok: true });
      setImmediate(() => disconnectSockets(socketIds));
      broadcastState();
      return;
    }

    if (client.role === "admin") {
      const socketIds = Array.from(client.admin.socketIds);
      state.removeAdmin(client.admin.id);
      socketIds.forEach((socketId) => {
        io.sockets.sockets.get(socketId)?.emit("session:left");
      });
      respond(reply, { ok: true });
      setImmediate(() => disconnectSockets(socketIds));
      broadcastState();
      return;
    }

    respond(reply, { ok: true });
  });

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
      socket.data.clientId = user.clientId;
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

    try {
      const admin = state.addAdmin(
        socket.id,
        "운영자",
        socket.data.ipAddress,
        payload?.clientId,
        createSessionToken(),
      );
      socket.data.role = "admin";
      socket.data.clientId = admin.clientId;
      socket.join("admins");
      respond(reply, {
        ok: true,
        state: getSnapshotFor(socket),
        adminSessionToken: admin.sessionToken,
      });
      broadcastState();
    } catch (error) {
      respond(reply, { ok: false, error: error.message });
    }
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

  socket.on("file:upload", (payload, reply) => {
    try {
      if (!state.getClient(socket.id)) {
        throw new Error("먼저 입장하세요.");
      }

      const attachments = saveUploadedFiles(payload);
      const message = state.addChatMessage({
        socketId: socket.id,
        body: payload?.body,
        attachments,
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
      deleteAttachmentFiles(deletedMessage.attachments);
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
    } else if (removed?.role === "admin-tab") {
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Smart drone classroom listening on http://localhost:${PORT}`);
});
