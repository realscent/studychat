"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { io } = require("socket.io-client");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const blocklistFile = path.join(
      os.tmpdir(),
      `studychat-blocklist-${port}-${Date.now()}.json`,
    );

    const child = spawn(process.execPath, ["server.js"], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        PORT: String(port),
        ADMIN_PASSWORD: "test-password",
        BLOCKLIST_FILE: blocklistFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("server did not start in time"));
    }, 5000);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("listening on")) {
        clearTimeout(timer);
        resolve(child);
      }
    });

    child.stderr.on("data", (chunk) => {
      const output = chunk.toString();
      if (output.includes("EADDRINUSE")) {
        clearTimeout(timer);
        reject(new Error(output));
      }
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) {
        reject(new Error(`server exited with code ${code}`));
      }
    });
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      forceNew: true,
      reconnection: false,
      transports: ["websocket"],
    });

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("socket did not connect in time"));
    }, 3000);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

function emitWithAck(socket, eventName, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(eventName, payload, (error, response) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(response);
    });
  });
}

function waitForEvent(socket, eventName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`event ${eventName} did not arrive in time`)),
      3000,
    );

    socket.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function waitForState(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("state update did not arrive in time")),
      3000,
    );

    function onState(snapshot) {
      if (!predicate(snapshot)) {
        return;
      }

      clearTimeout(timer);
      socket.off("state:update", onState);
      resolve(snapshot);
    }

    socket.on("state:update", onState);
  });
}

test("socket flow logs in admin, joins users, and completes a push round", async (t) => {
  const port = await getFreePort();
  const server = await startServer(port);
  t.after(() => server.kill());

  const url = `http://127.0.0.1:${port}`;
  const admin = await connect(url);
  const user1 = await connect(url);
  const user2 = await connect(url);
  t.after(() => {
    admin.close();
    user1.close();
    user2.close();
  });

  assert.equal(
    (await emitWithAck(admin, "admin:login", { password: "test-password" })).ok,
    true,
  );
  const adminStateWithUsers = waitForState(
    admin,
    (snapshot) =>
      snapshot.users.length === 2 &&
      snapshot.users.every((user) => user.ipAddress === "127.0.0.1"),
  );
  assert.equal(
    (await emitWithAck(user1, "user:join", { nickname: "학생1" })).ok,
    true,
  );
  assert.equal(
    (await emitWithAck(user2, "user:join", { nickname: "학생2" })).ok,
    true,
  );
  assert.equal((await adminStateWithUsers).blockedIps.length, 0);

  const completeEvent = waitForEvent(admin, "push:complete");
  const startResponse = await emitWithAck(admin, "push:start");
  assert.equal(startResponse.ok, true);

  assert.equal((await emitWithAck(user1, "push:press")).ok, true);
  assert.equal((await emitWithAck(user2, "push:press")).ok, true);

  const completed = await completeEvent;
  assert.equal(completed.roundId, startResponse.roundId);
  assert.match(completed.message, /모든 사용자/);

  assert.equal((await emitWithAck(admin, "push:reset")).ok, true);
});

test("admin can delete chat, kick users, block IPs, and unblock IPs", async (t) => {
  const port = await getFreePort();
  const server = await startServer(port);
  t.after(() => server.kill());

  const url = `http://127.0.0.1:${port}`;
  const admin = await connect(url);
  const user = await connect(url);
  t.after(() => {
    admin.close();
    user.close();
  });

  assert.equal(
    (await emitWithAck(admin, "admin:login", { password: "test-password" })).ok,
    true,
  );
  const joinResponse = await emitWithAck(user, "user:join", {
    nickname: "학생1",
  });
  assert.equal(joinResponse.ok, true);

  const chatResponse = await emitWithAck(user, "chat:send", {
    body: "삭제할 메시지",
  });
  assert.equal(chatResponse.ok, true);
  assert.equal(
    (
      await emitWithAck(admin, "admin:delete-message", {
        messageId: chatResponse.message.id,
      })
    ).ok,
    true,
  );

  const blockedEvent = waitForEvent(user, "access:blocked");
  const kickResponse = await emitWithAck(admin, "admin:kick-user", {
    userId: joinResponse.userId,
  });
  assert.equal(kickResponse.ok, true);
  assert.equal(kickResponse.blocked.ipAddress, "127.0.0.1");
  assert.equal(kickResponse.kickedCount, 1);
  assert.equal((await blockedEvent).ipAddress, "127.0.0.1");

  const blockedUser = await connect(url);
  t.after(() => blockedUser.close());

  const blockedJoin = await emitWithAck(blockedUser, "user:join", {
    nickname: "학생2",
  });
  assert.equal(blockedJoin.ok, false);
  assert.match(blockedJoin.error, /차단된 IP/);

  assert.equal(
    (
      await emitWithAck(admin, "admin:unblock-ip", {
        ipAddress: "127.0.0.1",
      })
    ).ok,
    true,
  );
  assert.equal(
    (await emitWithAck(blockedUser, "user:join", { nickname: "학생2" })).ok,
    true,
  );
});
