"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ClassroomState, normalizeIpAddress } = require("../src/state");

test("admin sessions are excluded from user count and presence list", () => {
  const state = new ClassroomState();
  state.addUser("user-1", "학생1");
  state.addAdmin("admin-1");

  const snapshot = state.snapshot();
  assert.equal(snapshot.userCount, 1);
  assert.deepEqual(
    snapshot.users.map((user) => user.nickname),
    ["학생1"],
  );
});

test("duplicate nicknames are rejected case-insensitively", () => {
  const state = new ClassroomState();
  state.addUser("user-1", "Alpha");

  assert.throws(() => state.addUser("user-2", "alpha"), {
    message: "이미 사용 중인 닉네임입니다.",
  });
});

test("admin snapshots include user IPs and blocklist", () => {
  const state = new ClassroomState();
  state.addUser("user-1", "학생1", "::ffff:10.1.3.10");
  state.blockIp("10.1.3.99");

  const publicSnapshot = state.snapshot();
  assert.equal(publicSnapshot.users[0].ipAddress, undefined);
  assert.equal(publicSnapshot.blockedIps, undefined);

  const adminSnapshot = state.snapshot({ includeAdmin: true });
  assert.equal(adminSnapshot.users[0].ipAddress, "10.1.3.10");
  assert.deepEqual(
    adminSnapshot.blockedIps.map((entry) => entry.ipAddress),
    ["10.1.3.99"],
  );
});

test("blocked IPs cannot join until unblocked", () => {
  const state = new ClassroomState();
  state.blockIp("10.1.3.10");

  assert.equal(state.isIpBlocked("::ffff:10.1.3.10"), true);
  assert.throws(() => state.addUser("user-1", "학생1", "10.1.3.10"), {
    message: "차단된 IP입니다. 운영자에게 문의하세요.",
  });

  state.unblockIp("10.1.3.10");
  assert.equal(state.addUser("user-1", "학생1", "10.1.3.10").ipAddress, "10.1.3.10");
});

test("chat messages can be deleted by id", () => {
  const state = new ClassroomState();
  state.addUser("user-1", "학생1", "10.1.3.10");
  const message = state.addChatMessage({
    socketId: "user-1",
    body: "삭제할 메시지",
  });

  assert.equal(state.deleteMessage(message.id).body, "삭제할 메시지");
  assert.equal(state.snapshot().messages.length, 0);
});

test("push round tracks waiting and completed users", () => {
  const state = new ClassroomState();
  state.addUser("user-1", "학생1");
  state.addUser("user-2", "학생2");

  const roundId = state.startPushRound();
  let snapshot = state.snapshot();
  assert.equal(snapshot.push.active, true);
  assert.equal(snapshot.push.roundId, roundId);
  assert.equal(snapshot.push.pressedCount, 0);
  assert.equal(snapshot.push.completed, false);

  const firstPress = state.markPressed("user-1");
  assert.equal(firstPress.shouldNotifyComplete, false);

  const secondPress = state.markPressed("user-2");
  assert.equal(secondPress.shouldNotifyComplete, true);

  snapshot = state.snapshot();
  assert.equal(snapshot.push.pressedCount, 2);
  assert.equal(snapshot.push.completed, true);

  state.resetPushRound();
  snapshot = state.snapshot();
  assert.equal(snapshot.push.active, false);
  assert.equal(snapshot.users.every((user) => user.pressed === false), true);
});

test("users joining during an active round start as waiting", () => {
  const state = new ClassroomState();
  state.addUser("user-1", "학생1");
  state.startPushRound();
  state.markPressed("user-1");

  state.addUser("user-2", "학생2");

  const snapshot = state.snapshot();
  assert.equal(snapshot.push.completed, false);
  assert.equal(snapshot.push.pressedCount, 1);
  assert.equal(snapshot.users.find((user) => user.id === "user-2").pressed, false);
});

test("round completion is notified once", () => {
  const state = new ClassroomState();
  state.addUser("user-1", "학생1");
  state.startPushRound();

  assert.equal(state.markPressed("user-1").shouldNotifyComplete, true);
  assert.equal(state.markPressed("user-1").shouldNotifyComplete, false);
});

test("IP addresses are normalized", () => {
  assert.equal(normalizeIpAddress("::ffff:10.1.3.10"), "10.1.3.10");
  assert.equal(normalizeIpAddress("::1"), "127.0.0.1");
});
