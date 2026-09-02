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
    const uploadDir = path.join(
      os.tmpdir(),
      `studychat-uploads-${port}-${Date.now()}`,
    );

    const child = spawn(process.execPath, ["server.js"], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        PORT: String(port),
        ADMIN_PASSWORD: "test-password",
        BLOCKLIST_FILE: blocklistFile,
        UPLOAD_DIR: uploadDir,
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
    (
      await emitWithAck(user1, "user:join", {
        nickname: "학생1",
        clientId: "browser-user-1",
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await emitWithAck(user2, "user:join", {
        nickname: "학생2",
        clientId: "browser-user-2",
      })
    ).ok,
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
    clientId: "browser-kick-user",
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
    clientId: "browser-blocked-user",
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
    (
      await emitWithAck(blockedUser, "user:join", {
        nickname: "학생2",
        clientId: "browser-blocked-user",
      })
    ).ok,
    true,
  );
});

test("same browser tabs are counted as one logical user", async (t) => {
  const port = await getFreePort();
  const server = await startServer(port);
  t.after(() => server.kill());

  const url = `http://127.0.0.1:${port}`;
  const admin = await connect(url);
  const firstTab = await connect(url);
  const secondTab = await connect(url);
  t.after(() => {
    admin.close();
    firstTab.close();
    secondTab.close();
  });

  assert.equal(
    (await emitWithAck(admin, "admin:login", { password: "test-password" })).ok,
    true,
  );

  const firstJoin = await emitWithAck(firstTab, "user:join", {
    nickname: "학생1",
    clientId: "same-browser-user",
  });
  assert.equal(firstJoin.ok, true);

  const stateAfterSecondJoin = waitForState(
    admin,
    (state) =>
      state.userCount === 1 &&
      state.users[0].nickname === "학생1" &&
      state.users[0].tabCount === 2,
  );
  const secondJoin = await emitWithAck(secondTab, "user:join", {
    nickname: "다른닉네임",
    clientId: "same-browser-user",
  });
  assert.equal(secondJoin.ok, true);
  assert.equal(secondJoin.userId, firstJoin.userId);
  assert.equal(secondJoin.nickname, "학생1");

  const snapshot = await stateAfterSecondJoin;
  assert.equal(snapshot.users[0].ipAddress, "127.0.0.1");
});

test("stored user sessions resume in new tabs and block admin login", async (t) => {
  const port = await getFreePort();
  const server = await startServer(port);
  t.after(() => server.kill());

  const url = `http://127.0.0.1:${port}`;
  const firstTab = await connect(url);
  const secondTab = await connect(url);
  const adminAttempt = await connect(url);
  t.after(() => {
    firstTab.close();
    secondTab.close();
    adminAttempt.close();
  });

  const firstJoin = await emitWithAck(firstTab, "user:join", {
    nickname: "학생1",
    clientId: "locked-browser",
  });
  assert.equal(firstJoin.ok, true);

  const resumedJoin = await emitWithAck(secondTab, "session:resume", {
    role: "user",
    nickname: "다른닉네임",
    clientId: "locked-browser",
  });
  assert.equal(resumedJoin.ok, true);
  assert.equal(resumedJoin.userId, firstJoin.userId);
  assert.equal(resumedJoin.nickname, "학생1");
  assert.equal(resumedJoin.state.userCount, 1);
  assert.equal(resumedJoin.state.users[0].tabCount, 2);

  const blockedAdminLogin = await emitWithAck(adminAttempt, "admin:login", {
    password: "test-password",
    clientId: "locked-browser",
  });
  assert.equal(blockedAdminLogin.ok, false);
  assert.match(blockedAdminLogin.error, /이미 사용자/);
});

test("stored admin sessions resume in new tabs and block user join", async (t) => {
  const port = await getFreePort();
  const server = await startServer(port);
  t.after(() => server.kill());

  const url = `http://127.0.0.1:${port}`;
  const adminTab = await connect(url);
  const secondAdminTab = await connect(url);
  const userAttempt = await connect(url);
  t.after(() => {
    adminTab.close();
    secondAdminTab.close();
    userAttempt.close();
  });

  const login = await emitWithAck(adminTab, "admin:login", {
    password: "test-password",
    clientId: "admin-browser",
  });
  assert.equal(login.ok, true);
  assert.ok(login.adminSessionToken);

  const resumedAdmin = await emitWithAck(secondAdminTab, "session:resume", {
    role: "admin",
    clientId: "admin-browser",
    adminSessionToken: login.adminSessionToken,
  });
  assert.equal(resumedAdmin.ok, true);
  assert.equal(resumedAdmin.role, "admin");

  const blockedUserJoin = await emitWithAck(userAttempt, "user:join", {
    nickname: "학생1",
    clientId: "admin-browser",
  });
  assert.equal(blockedUserJoin.ok, false);
  assert.match(blockedUserJoin.error, /이미 운영자/);

  assert.equal((await emitWithAck(adminTab, "session:leave")).ok, true);

  const newUser = await connect(url);
  t.after(() => newUser.close());
  const joinAfterLeave = await emitWithAck(newUser, "user:join", {
    nickname: "학생1",
    clientId: "admin-browser",
  });
  assert.equal(joinAfterLeave.ok, true);
});

test("users can upload attachments into chat messages", async (t) => {
  const port = await getFreePort();
  const server = await startServer(port);
  t.after(() => server.kill());

  const url = `http://127.0.0.1:${port}`;
  const user = await connect(url);
  t.after(() => user.close());

  assert.equal(
    (
      await emitWithAck(user, "user:join", {
        nickname: "학생1",
        clientId: "upload-browser",
      })
    ).ok,
    true,
  );

  const uploadResponse = await emitWithAck(user, "file:upload", {
    body: "자료입니다",
    files: [
      {
        name: "hello.txt",
        type: "text/plain",
        file: Buffer.from("hello file"),
      },
      {
        name: "demo.mp4",
        type: "video/mp4",
        file: Buffer.from("video bytes"),
      },
      {
        name: "photo-1.jpg",
        type: "image/jpeg",
        file: Buffer.from("image bytes"),
      },
      {
        name: "photo-2.png",
        type: "image/png",
        file: Buffer.from("image bytes"),
      },
      {
        name: "photo-3.webp",
        type: "image/webp",
        file: Buffer.from("image bytes"),
      },
    ],
  });

  assert.equal(uploadResponse.ok, true);
  assert.equal(uploadResponse.message.body, "자료입니다");
  assert.equal(uploadResponse.message.attachments.length, 5);
  assert.equal(uploadResponse.message.attachments[0].originalName, "hello.txt");
  assert.equal(uploadResponse.message.attachments[0].kind, "file");
  assert.equal(uploadResponse.message.attachments[1].originalName, "demo.mp4");
  assert.equal(uploadResponse.message.attachments[1].kind, "video");
  assert.equal(uploadResponse.message.attachments[2].originalName, "photo-1.jpg");
  assert.equal(uploadResponse.message.attachments[2].kind, "image");

  const download = await fetch(`${url}${uploadResponse.message.attachments[0].url}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-disposition"), "attachment");
  assert.equal(await download.text(), "hello file");

  const video = await fetch(`${url}${uploadResponse.message.attachments[1].url}`);
  assert.equal(video.status, 200);
  assert.equal(video.headers.get("content-disposition"), null);

  const image = await fetch(`${url}${uploadResponse.message.attachments[2].url}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-disposition"), null);

  const tooManyResponse = await emitWithAck(user, "file:upload", {
    files: Array.from({ length: 13 }, (_, index) => ({
      name: `photo-${index + 1}.jpg`,
      type: "image/jpeg",
      file: Buffer.from("image bytes"),
    })),
  });
  assert.equal(tooManyResponse.ok, false);
  assert.match(tooManyResponse.error, /12개/);
});
