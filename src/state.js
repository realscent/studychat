"use strict";

const DEFAULT_MAX_MESSAGES = 100;
const MAX_NICKNAME_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 500;
const MAX_ATTACHMENTS_PER_MESSAGE = 12;
const CLIENT_ID_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;

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

function normalizeAttachments(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.slice(0, MAX_ATTACHMENTS_PER_MESSAGE).map((attachment) => ({
    id: String(attachment?.id ?? ""),
    originalName: String(attachment?.originalName ?? "첨부파일"),
    mimeType: String(attachment?.mimeType ?? "application/octet-stream"),
    size: Number(attachment?.size ?? 0),
    url: String(attachment?.url ?? ""),
    kind: String(attachment?.kind ?? "file"),
  }));
}

function normalizeIpAddress(input) {
  const address = String(input ?? "").trim();
  if (!address) {
    return "알 수 없음";
  }

  if (address.startsWith("::ffff:")) {
    return address.slice(7);
  }

  if (address === "::1") {
    return "127.0.0.1";
  }

  return address;
}

function normalizeClientId(input, fallback) {
  const clientId = String(input ?? "").trim();
  if (CLIENT_ID_PATTERN.test(clientId)) {
    return clientId;
  }

  return String(fallback);
}

function normalizeBlockedEntry(entry) {
  if (typeof entry === "string") {
    return {
      ipAddress: normalizeIpAddress(entry),
      blockedAt: nowIso(),
      reason: "운영자 차단",
    };
  }

  return {
    ipAddress: normalizeIpAddress(entry?.ipAddress ?? entry?.ip),
    blockedAt: entry?.blockedAt || nowIso(),
    reason: entry?.reason || "운영자 차단",
  };
}

class ClassroomState {
  constructor({ maxMessages = DEFAULT_MAX_MESSAGES, blockedIps = [] } = {}) {
    this.maxMessages = maxMessages;
    this.users = new Map();
    this.socketToUserId = new Map();
    this.admins = new Map();
    this.socketToAdminId = new Map();
    this.messages = [];
    this.blockedIps = new Map();
    this.roundSequence = 0;
    this.pushRound = this.createInactiveRound();

    blockedIps.map(normalizeBlockedEntry).forEach((entry) => {
      if (entry.ipAddress !== "알 수 없음") {
        this.blockedIps.set(entry.ipAddress, entry);
      }
    });
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

  addUser(socketId, rawNickname, rawIpAddress = "알 수 없음", rawClientId = null) {
    const ipAddress = normalizeIpAddress(rawIpAddress);
    if (this.isIpBlocked(ipAddress)) {
      throw new Error("차단된 IP입니다. 운영자에게 문의하세요.");
    }

    const clientId = normalizeClientId(rawClientId, socketId);
    if (this.admins.has(clientId)) {
      throw new Error("이미 운영자로 로그인한 브라우저입니다. 나가기 후 사용자로 입장하세요.");
    }

    const existingUser = this.users.get(clientId);
    if (existingUser) {
      existingUser.socketIds.add(socketId);
      existingUser.ipAddress = ipAddress;
      existingUser.lastSeenAt = nowIso();
      this.socketToUserId.set(socketId, existingUser.id);
      this.admins.delete(socketId);
      return existingUser;
    }

    const nickname = normalizeNickname(rawNickname);
    const normalized = nickname.toLocaleLowerCase("ko-KR");
    const duplicate = Array.from(this.users.values()).some(
      (user) => user.nickname.toLocaleLowerCase("ko-KR") === normalized,
    );

    if (duplicate) {
      throw new Error("이미 사용 중인 닉네임입니다.");
    }

    const user = {
      id: clientId,
      clientId,
      nickname,
      ipAddress,
      joinedAt: nowIso(),
      lastSeenAt: nowIso(),
      socketIds: new Set([socketId]),
    };

    this.users.set(user.id, user);
    this.socketToUserId.set(socketId, user.id);
    this.admins.delete(socketId);

    if (this.pushRound.active) {
      this.pushRound.pressed.delete(user.id);
    }

    return user;
  }

  addAdmin(
    socketId,
    name = "운영자",
    rawIpAddress = "알 수 없음",
    rawClientId = null,
    sessionToken = null,
  ) {
    const clientId = normalizeClientId(rawClientId, socketId);
    if (this.users.has(clientId)) {
      throw new Error("이미 사용자로 입장한 브라우저입니다. 나가기 후 운영자로 로그인하세요.");
    }

    const existingAdmin = this.admins.get(clientId);
    if (existingAdmin) {
      existingAdmin.socketIds.add(socketId);
      existingAdmin.ipAddress = normalizeIpAddress(rawIpAddress);
      existingAdmin.lastSeenAt = nowIso();
      if (sessionToken) {
        existingAdmin.sessionToken = sessionToken;
      }
      this.socketToAdminId.set(socketId, existingAdmin.id);
      this.detachUserSocket(socketId);
      return existingAdmin;
    }

    const admin = {
      id: clientId,
      clientId,
      name,
      ipAddress: normalizeIpAddress(rawIpAddress),
      joinedAt: nowIso(),
      lastSeenAt: nowIso(),
      sessionToken,
      socketIds: new Set([socketId]),
    };

    this.admins.set(admin.id, admin);
    this.socketToAdminId.set(socketId, admin.id);
    this.detachUserSocket(socketId);
    return admin;
  }

  detachUserSocket(socketId) {
    const userId = this.socketToUserId.get(socketId);
    if (!userId) {
      return null;
    }

    this.socketToUserId.delete(socketId);
    const user = this.users.get(userId);
    if (!user) {
      return null;
    }

    user.socketIds.delete(socketId);
    user.lastSeenAt = nowIso();

    if (user.socketIds.size > 0) {
      return { role: "user-tab", user };
    }

    this.users.delete(userId);
    this.pushRound.pressed.delete(userId);
    return { role: "user", user };
  }

  detachAdminSocket(socketId) {
    const adminId = this.socketToAdminId.get(socketId);
    if (!adminId) {
      return null;
    }

    this.socketToAdminId.delete(socketId);
    const admin = this.admins.get(adminId);
    if (!admin) {
      return null;
    }

    admin.socketIds.delete(socketId);
    admin.lastSeenAt = nowIso();
    return { role: "admin-tab", admin };
  }

  remove(socketId) {
    const removedUser = this.detachUserSocket(socketId);
    if (removedUser) {
      return removedUser;
    }

    const removedAdmin = this.detachAdminSocket(socketId);
    if (removedAdmin) {
      return removedAdmin;
    }

    return null;
  }

  removeUser(userId) {
    const user = this.users.get(userId);
    if (!user) {
      return null;
    }

    this.users.delete(userId);
    this.pushRound.pressed.delete(userId);
    user.socketIds.forEach((socketId) => this.socketToUserId.delete(socketId));
    return user;
  }

  removeAdmin(adminId) {
    const admin = this.admins.get(adminId);
    if (!admin) {
      return null;
    }

    this.admins.delete(adminId);
    admin.socketIds.forEach((socketId) => this.socketToAdminId.delete(socketId));
    return admin;
  }

  getClient(socketId) {
    const userId = this.socketToUserId.get(socketId);
    const user = userId ? this.users.get(userId) : null;
    if (user) {
      return { role: "user", user };
    }

    const adminId = this.socketToAdminId.get(socketId);
    const admin = adminId ? this.admins.get(adminId) : null;
    if (admin) {
      return { role: "admin", admin };
    }

    return null;
  }

  getUser(userId) {
    return this.users.get(userId) ?? null;
  }

  getUserByClientId(rawClientId) {
    const clientId = normalizeClientId(rawClientId, "");
    return this.users.get(clientId) ?? null;
  }

  getAdminByClientId(rawClientId) {
    const clientId = normalizeClientId(rawClientId, "");
    return this.admins.get(clientId) ?? null;
  }

  getAdminSession(rawClientId, sessionToken) {
    const admin = this.getAdminByClientId(rawClientId);
    if (!admin || !admin.sessionToken || admin.sessionToken !== sessionToken) {
      return null;
    }

    return admin;
  }

  getUsersByIp(rawIpAddress) {
    const ipAddress = normalizeIpAddress(rawIpAddress);
    return Array.from(this.users.values()).filter(
      (user) => user.ipAddress === ipAddress,
    );
  }

  addChatMessage({ socketId, body, attachments = [] }) {
    const client = this.getClient(socketId);
    if (!client) {
      throw new Error("먼저 입장하세요.");
    }

    const normalizedBody = normalizeMessage(body);
    const normalizedAttachments = normalizeAttachments(attachments);
    if (!normalizedBody && normalizedAttachments.length === 0) {
      throw new Error("메시지나 첨부파일을 입력하세요.");
    }

    const author = client.role === "admin" ? "운영자" : client.user.nickname;
    const authorId = client.role === "admin" ? client.admin.id : client.user.id;
    return this.addMessage({
      author,
      authorId,
      role: client.role,
      body: normalizedBody ?? "",
      attachments: normalizedAttachments,
    });
  }

  addSystemMessage(body) {
    const normalizedBody = normalizeMessage(body);
    if (!normalizedBody) {
      return null;
    }

    return this.addMessage({
      author: "시스템",
      authorId: null,
      role: "system",
      body: normalizedBody,
    });
  }

  addMessage({ author, authorId, role, body, attachments = [] }) {
    const message = {
      id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      author,
      authorId,
      role,
      body,
      attachments,
      createdAt: nowIso(),
    };

    this.messages.push(message);
    if (this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages);
    }

    return message;
  }

  deleteMessage(messageId) {
    const index = this.messages.findIndex((message) => message.id === messageId);
    if (index === -1) {
      throw new Error("삭제할 메시지를 찾을 수 없습니다.");
    }

    const [deleted] = this.messages.splice(index, 1);
    return deleted;
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

    const userId = this.socketToUserId.get(socketId);
    if (!userId || !this.users.has(userId)) {
      throw new Error("사용자만 누를 수 있습니다.");
    }

    this.pushRound.pressed.add(userId);
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

    return Array.from(this.users.keys()).every((userId) =>
      this.pushRound.pressed.has(userId),
    );
  }

  resetPushRound() {
    this.pushRound = this.createInactiveRound();
  }

  isIpBlocked(rawIpAddress) {
    const ipAddress = normalizeIpAddress(rawIpAddress);
    return this.blockedIps.has(ipAddress);
  }

  blockIp(rawIpAddress, reason = "운영자 차단") {
    const ipAddress = normalizeIpAddress(rawIpAddress);
    if (ipAddress === "알 수 없음") {
      throw new Error("차단할 IP를 확인할 수 없습니다.");
    }

    const existing = this.blockedIps.get(ipAddress);
    if (existing) {
      return existing;
    }

    const entry = {
      ipAddress,
      blockedAt: nowIso(),
      reason,
    };
    this.blockedIps.set(ipAddress, entry);
    return entry;
  }

  unblockIp(rawIpAddress) {
    const ipAddress = normalizeIpAddress(rawIpAddress);
    if (!this.blockedIps.delete(ipAddress)) {
      throw new Error("차단 목록에서 IP를 찾을 수 없습니다.");
    }

    return ipAddress;
  }

  getBlockedIps() {
    return Array.from(this.blockedIps.values()).sort((a, b) =>
      a.blockedAt.localeCompare(b.blockedAt),
    );
  }

  snapshot({ includeAdmin = false } = {}) {
    const users = Array.from(this.users.values())
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
      .map((user) => {
        const visibleUser = {
          id: user.id,
          nickname: user.nickname,
          joinedAt: user.joinedAt,
          tabCount: user.socketIds.size,
          pressed: this.pushRound.active ? this.pushRound.pressed.has(user.id) : false,
        };

        if (includeAdmin) {
          visibleUser.ipAddress = user.ipAddress;
        }

        return visibleUser;
      });

    const pressedCount = this.pushRound.active
      ? users.filter((user) => user.pressed).length
      : 0;

    const snapshot = {
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

    if (includeAdmin) {
      snapshot.blockedIps = this.getBlockedIps();
    }

    return snapshot;
  }
}

module.exports = {
  ClassroomState,
  normalizeClientId,
  normalizeAttachments,
  normalizeIpAddress,
  normalizeNickname,
  normalizeMessage,
};
