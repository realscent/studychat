"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ClassroomState } = require("../src/state");

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
