"use strict";

const DEFAULT_MAX_MESSAGES = 100;
const MAX_NICKNAME_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 500;

function nowIso() {
  return new Date().toISOString();
}

function normalizeNickname(input) {
  const nickname = String(input ?? "").trim().replace(/\s+/g, " ");

  if (!nickname) {
    throw new Error("닉네임을 입력하세요.");
  }

  if (nickname.length > MAX_NICKNAME_LENGTH) {
    throw new Error(`닉네임은 ${MAX_NICKNAME_LENGTH}자 이하로 입력하세요.`);
  }

  return nickname;
}

function normalizeMessage(input) {
  const body = String(input ?? "").trim();
  if (!body) {
    return null;
  }

  return body.slice(0, MAX_MESSAGE_LENGTH);
}

class ClassroomState {
  constructor({ maxMessages = DEFAULT_MAX_MESSAGES } = {}) {
    this.maxMessages = maxMessages;
    this.users = new Map();
    this.admins = new Map();
    this.messages = [];
    this.roundSequence = 0;
    this.pushRound = this.createInactiveRound();
  }

  createInactiveRound() {
    return {
      active: false,
      id: null,
      startedAt: null,
      pressed: new Set(),
      completedNotified: false,
    };
  }

  addUser(socketId, rawNickname) {
    const nickname = normalizeNickname(rawNickname);
    const normalized = nickname.toLocaleLowerCase("ko-KR");
    const duplicate = Array.from(this.users.values()).some(
      (user) => user.nickname.toLocaleLowerCase("ko-KR") === normalized,
    );

    if (duplicate) {
      throw new Error("이미 사용 중인 닉네임입니다.");
    }

    const user = {
      socketId,
      nickname,
      joinedAt: nowIso(),
    };

    this.users.set(socketId, user);
    this.admins.delete(socketId);

    if (this.pushRound.active) {
      this.pushRound.pressed.delete(socketId);
    }

    return user;
  }

  addAdmin(socketId, name = "운영자") {
    const admin = {
      socketId,
      name,
      joinedAt: nowIso(),
    };

    this.admins.set(socketId, admin);
    this.users.delete(socketId);
    this.pushRound.pressed.delete(socketId);
    return admin;
  }

  remove(socketId) {
    const user = this.users.get(socketId);
    if (user) {
      this.users.delete(socketId);
      this.pushRound.pressed.delete(socketId);
      return { role: "user", user };
    }

    const admin = this.admins.get(socketId);
    if (admin) {
      this.admins.delete(socketId);
      return { role: "admin", admin };
    }

    return null;
  }

  getClient(socketId) {
    const user = this.users.get(socketId);
    if (user) {
      return { role: "user", user };
    }

    const admin = this.admins.get(socketId);
    if (admin) {
      return { role: "admin", admin };
    }

    return null;
  }

  addChatMessage({ socketId, body }) {
    const client = this.getClient(socketId);
    if (!client) {
      throw new Error("먼저 입장하세요.");
    }

    const normalizedBody = normalizeMessage(body);
    if (!normalizedBody) {
      throw new Error("메시지를 입력하세요.");
    }

    const author = client.role === "admin" ? "운영자" : client.user.nickname;
    return this.addMessage({
      author,
      role: client.role,
      body: normalizedBody,
    });
  }

  addSystemMessage(body) {
    const normalizedBody = normalizeMessage(body);
    if (!normalizedBody) {
      return null;
    }

    return this.addMessage({
      author: "시스템",
      role: "system",
      body: normalizedBody,
    });
  }

  addMessage({ author, role, body }) {
    const message = {
      id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      author,
      role,
      body,
      createdAt: nowIso(),
    };

    this.messages.push(message);
    if (this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages);
    }

    return message;
  }

  startPushRound() {
    if (this.users.size === 0) {
      throw new Error("현재 접속한 사용자가 없습니다.");
    }

    this.roundSequence += 1;
    this.pushRound = {
      active: true,
      id: String(this.roundSequence),
      startedAt: nowIso(),
      pressed: new Set(),
      completedNotified: false,
    };

    return this.pushRound.id;
  }

  markPressed(socketId) {
    if (!this.pushRound.active) {
      throw new Error("진행 중인 푸쉬가 없습니다.");
    }

    if (!this.users.has(socketId)) {
      throw new Error("사용자만 누를 수 있습니다.");
    }

    this.pushRound.pressed.add(socketId);
    return {
      roundId: this.pushRound.id,
      shouldNotifyComplete: this.consumeCompletionIfReady(),
    };
  }

  consumeCompletionIfReady() {
    if (!this.isPushComplete() || this.pushRound.completedNotified) {
      return false;
    }

    this.pushRound.completedNotified = true;
    return true;
  }

  isPushComplete() {
    if (!this.pushRound.active || this.users.size === 0) {
      return false;
    }

    return Array.from(this.users.keys()).every((socketId) =>
      this.pushRound.pressed.has(socketId),
    );
  }

  resetPushRound() {
    this.pushRound = this.createInactiveRound();
  }

  snapshot() {
    const users = Array.from(this.users.values())
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
      .map((user) => ({
        id: user.socketId,
        nickname: user.nickname,
        joinedAt: user.joinedAt,
        pressed: this.pushRound.active
          ? this.pushRound.pressed.has(user.socketId)
          : false,
      }));

    const pressedCount = this.pushRound.active
      ? users.filter((user) => user.pressed).length
      : 0;

    return {
      userCount: users.length,
      users,
      messages: [...this.messages],
      push: {
        active: this.pushRound.active,
        roundId: this.pushRound.id,
        startedAt: this.pushRound.startedAt,
        pressedCount,
        totalCount: users.length,
        completed: this.isPushComplete(),
      },
    };
  }
}

module.exports = {
  ClassroomState,
  normalizeNickname,
  normalizeMessage,
};
