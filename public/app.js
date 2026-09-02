"use strict";

const socket = io();

const joinScreen = document.querySelector("#join-screen");
const appShell = document.querySelector("#app");
const userForm = document.querySelector("#user-form");
const adminForm = document.querySelector("#admin-form");
const nicknameInput = document.querySelector("#nickname");
const adminPasswordInput = document.querySelector("#admin-password");
const entryError = document.querySelector("#entry-error");
const roomError = document.querySelector("#room-error");
const roleChip = document.querySelector("#role-chip");
const countChip = document.querySelector("#count-chip");
const listSummary = document.querySelector("#list-summary");
const userList = document.querySelector("#user-list");
const adminControls = document.querySelector("#admin-controls");
const startPushButton = document.querySelector("#start-push-button");
const resetPushButton = document.querySelector("#reset-push-button");
const pushProgress = document.querySelector("#push-progress");
const blocklistSummary = document.querySelector("#blocklist-summary");
const blocklist = document.querySelector("#blocklist");
const pushPanel = document.querySelector("#push-panel");
const pushTitle = document.querySelector("#push-title");
const pushDescription = document.querySelector("#push-description");
const pressPushButton = document.querySelector("#press-push-button");
const messages = document.querySelector("#messages");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const fileInput = document.querySelector("#file-input");
const attachButton = document.querySelector("#attach-button");
const uploadStatus = document.querySelector("#upload-status");
const leaveButton = document.querySelector("#leave-button");
const completeModal = document.querySelector("#complete-modal");
const completeMessage = document.querySelector("#complete-message");
const completeOkButton = document.querySelector("#complete-ok-button");
const BROWSER_ID_KEY = "studychat.browserClientId";
const NICKNAME_KEY = "studychat.nickname";
const SESSION_ROLE_KEY = "studychat.sessionRole";
const ADMIN_SESSION_TOKEN_KEY = "studychat.adminSessionToken";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

let role = null;
let myUserId = null;
let latestState = null;
let completeRoundShown = null;
let autoResumeAttempted = false;
let isLeaving = false;

function createBrowserClientId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `browser-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getBrowserClientId() {
  try {
    const saved = localStorage.getItem(BROWSER_ID_KEY);
    if (saved) {
      return saved;
    }

    const next = createBrowserClientId();
    localStorage.setItem(BROWSER_ID_KEY, next);
    return next;
  } catch (_error) {
    return createBrowserClientId();
  }
}

const browserClientId = getBrowserClientId();

function readStoredValue(key) {
  try {
    return localStorage.getItem(key);
  } catch (_error) {
    return null;
  }
}

function writeStoredValue(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_error) {
    // Best effort only.
  }
}

function removeStoredValue(key) {
  try {
    localStorage.removeItem(key);
  } catch (_error) {
    // Best effort only.
  }
}

function clearStoredSession() {
  removeStoredValue(SESSION_ROLE_KEY);
  removeStoredValue(NICKNAME_KEY);
  removeStoredValue(ADMIN_SESSION_TOKEN_KEY);
}

try {
  const savedNickname = localStorage.getItem(NICKNAME_KEY);
  if (savedNickname) {
    nicknameInput.value = savedNickname;
  }
} catch (_error) {
  // Local storage can be disabled in private browser modes.
}

function emitWithAck(eventName, payload = {}) {
  return new Promise((resolve) => {
    socket.timeout(5000).emit(eventName, payload, (error, response) => {
      if (error) {
        resolve({ ok: false, error: "서버 응답이 지연되고 있습니다." });
        return;
      }

      resolve(response ?? { ok: true });
    });
  });
}

function setEntryError(message = "") {
  entryError.textContent = message;
}

function setRoomError(message = "") {
  roomError.textContent = message;
}

function setUploadStatus(message = "") {
  uploadStatus.textContent = message;
}

function formatFileSize(size) {
  const value = Number(size || 0);
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)}MB`;
  }

  if (value >= 1024) {
    return `${Math.ceil(value / 1024)}KB`;
  }

  return `${value}B`;
}

function enterRoom(nextRole, snapshot) {
  role = nextRole;
  joinScreen.hidden = true;
  appShell.hidden = false;
  adminControls.hidden = role !== "admin";
  roleChip.textContent = role === "admin" ? "운영자" : "사용자";
  renderState(snapshot);
  chatInput.focus();
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function formatTime(isoText) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoText));
}

function renderUsers(snapshot) {
  userList.replaceChildren();
  countChip.textContent = `${snapshot.userCount}명 접속`;
  listSummary.textContent = `${snapshot.userCount}명`;

  if (snapshot.users.length === 0) {
    userList.append(createElement("li", "empty-row", "접속한 사용자가 없습니다."));
    return;
  }

  snapshot.users.forEach((user) => {
    const row = createElement("li", "user-row");
    if (snapshot.push.active) {
      row.classList.add(user.pressed ? "pressed" : "waiting");
    }

    const main = createElement("div", "user-main");
    main.append(createElement("span", "nickname", user.nickname));

    if (role === "admin") {
      main.append(createElement("span", "ip-address", user.ipAddress || "IP 없음"));
      if (user.tabCount > 1) {
        main.append(createElement("span", "tab-count", `탭 ${user.tabCount}개`));
      }
    }

    const status = createElement(
      "span",
      "status",
      snapshot.push.active ? (user.pressed ? "완료" : "대기") : "접속중",
    );

    row.append(main, status);

    if (role === "admin") {
      const kickButton = createElement("button", "danger-button", "강퇴");
      kickButton.type = "button";
      kickButton.dataset.kickUser = user.id;
      kickButton.dataset.nickname = user.nickname;
      kickButton.dataset.ipAddress = user.ipAddress || "";
      row.append(kickButton);
    }

    userList.append(row);
  });
}

function renderBlocklist(snapshot) {
  if (role !== "admin") {
    return;
  }

  const blockedIps = snapshot.blockedIps || [];
  blocklist.replaceChildren();
  blocklistSummary.textContent = `${blockedIps.length}개`;

  if (blockedIps.length === 0) {
    blocklist.append(createElement("li", "empty-row", "차단된 IP가 없습니다."));
    return;
  }

  blockedIps.forEach((entry) => {
    const row = createElement("li", "block-row");
    const main = createElement("div", "block-main");
    main.append(
      createElement("span", "ip-address strong", entry.ipAddress),
      createElement("span", "block-reason", entry.reason || "운영자 차단"),
    );

    const unblockButton = createElement("button", "secondary-button", "해제");
    unblockButton.type = "button";
    unblockButton.dataset.unblockIp = entry.ipAddress;

    row.append(main, unblockButton);
    blocklist.append(row);
  });
}

function renderAttachment(attachment) {
  const wrapper = createElement("div", "attachment");
  const link = createElement("a", null);
  link.href = attachment.url;
  link.target = "_blank";
  link.rel = "noopener";
  link.download = attachment.originalName || "첨부파일";

  if (attachment.kind === "image") {
    const image = document.createElement("img");
    image.className = "attachment-image";
    image.src = attachment.url;
    image.alt = attachment.originalName || "첨부 이미지";
    image.loading = "lazy";
    link.append(image);

    const caption = createElement(
      "span",
      "attachment-caption",
      `${attachment.originalName || "이미지"} · ${formatFileSize(attachment.size)}`,
    );
    wrapper.append(link, caption);
    return wrapper;
  }

  link.className = "attachment-file";
  link.append(
    createElement("span", "attachment-icon", "파일"),
    createElement(
      "span",
      "attachment-name",
      `${attachment.originalName || "첨부파일"} · ${formatFileSize(attachment.size)}`,
    ),
  );
  wrapper.append(link);
  return wrapper;
}

function renderAttachments(attachments = []) {
  const list = createElement("div", "attachments");
  attachments.forEach((attachment) => {
    if (attachment?.url) {
      list.append(renderAttachment(attachment));
    }
  });

  return list;
}

function renderMessages(snapshot) {
  const shouldStickToBottom =
    messages.scrollTop + messages.clientHeight >= messages.scrollHeight - 32;

  messages.replaceChildren();

  if (snapshot.messages.length === 0) {
    messages.append(createElement("div", "message system", "아직 메시지가 없습니다."));
  } else {
    snapshot.messages.forEach((message) => {
      const row = createElement("article", `message ${message.role}`);
      row.dataset.messageId = message.id;

      if (message.role !== "system" && message.author !== "운영자") {
        const ownMessage =
          role === "user" &&
          latestState?.users.find((user) => user.id === myUserId)?.nickname ===
            message.author;
        if (ownMessage) {
          row.classList.add("mine");
        }
      }

      if (message.role === "system") {
        row.textContent = message.body;
      } else {
        const meta = createElement("div", "message-meta");
        meta.append(
          createElement("span", null, message.author),
          createElement("span", null, formatTime(message.createdAt)),
        );
        row.append(meta);
        if (message.body) {
          row.append(createElement("div", "message-body", message.body));
        }
        if (message.attachments?.length) {
          row.append(renderAttachments(message.attachments));
        }
      }

      messages.append(row);
    });
  }

  if (shouldStickToBottom) {
    messages.scrollTop = messages.scrollHeight;
  }
}

function renderPush(snapshot) {
  const push = snapshot.push;
  const me = snapshot.users.find((user) => user.id === myUserId);

  startPushButton.disabled = push.active;
  resetPushButton.hidden = !push.active;
  pushProgress.textContent = push.active
    ? `${push.pressedCount}/${push.totalCount} 완료`
    : "";

  if (!push.active) {
    pushPanel.hidden = true;
    pressPushButton.hidden = false;
    pressPushButton.disabled = false;
    pressPushButton.textContent = "완료했습니다";
    completeModal.hidden = true;
    completeRoundShown = null;
    return;
  }

  pushPanel.hidden = false;

  if (role === "admin") {
    pushTitle.textContent = "푸쉬 진행 중";
    pushDescription.textContent = `${push.totalCount}명 중 ${push.pressedCount}명 완료`;
    pressPushButton.hidden = true;
    return;
  }

  pressPushButton.hidden = false;
  if (me?.pressed) {
    pushTitle.textContent = "제출 완료";
    pushDescription.textContent = "운영자가 확인하면 상태가 초기화됩니다.";
    pressPushButton.textContent = "완료됨";
    pressPushButton.disabled = true;
  } else {
    pushTitle.textContent = "푸쉬버튼";
    pushDescription.textContent = "완료하면 버튼을 눌러주세요.";
    pressPushButton.textContent = "완료했습니다";
    pressPushButton.disabled = false;
  }
}

function renderState(snapshot) {
  if (!snapshot) {
    return;
  }

  latestState = snapshot;
  renderUsers(snapshot);
  renderBlocklist(snapshot);
  renderMessages(snapshot);
  renderPush(snapshot);
}

function showCompleteModal(payload) {
  if (role !== "admin" || completeRoundShown === payload.roundId) {
    return;
  }

  completeRoundShown = payload.roundId;
  completeMessage.textContent =
    payload.message || "접속한 모든 사용자가 푸쉬버튼을 눌렀습니다.";
  completeModal.hidden = false;
  completeOkButton.focus();
}

function showBlocked(message) {
  role = null;
  myUserId = null;
  clearStoredSession();
  appShell.hidden = true;
  joinScreen.hidden = false;
  nicknameInput.disabled = true;
  userForm.querySelector("button").disabled = true;
  setEntryError(message || "차단된 IP입니다. 운영자에게 문의하세요.");
}

function storeUserSession(nickname) {
  writeStoredValue(SESSION_ROLE_KEY, "user");
  writeStoredValue(NICKNAME_KEY, nickname);
  removeStoredValue(ADMIN_SESSION_TOKEN_KEY);
}

function storeAdminSession(adminSessionToken) {
  writeStoredValue(SESSION_ROLE_KEY, "admin");
  if (adminSessionToken) {
    writeStoredValue(ADMIN_SESSION_TOKEN_KEY, adminSessionToken);
  }
  removeStoredValue(NICKNAME_KEY);
}

async function resumeStoredSession() {
  if (role || autoResumeAttempted) {
    return;
  }

  let storedRole = readStoredValue(SESSION_ROLE_KEY);
  if (!storedRole && readStoredValue(NICKNAME_KEY)) {
    storedRole = "user";
    writeStoredValue(SESSION_ROLE_KEY, "user");
  }

  if (!storedRole) {
    return;
  }

  autoResumeAttempted = true;
  setEntryError("기존 세션으로 입장 중입니다.");

  const payload = {
    role: storedRole,
    clientId: browserClientId,
  };

  if (storedRole === "user") {
    const nickname = readStoredValue(NICKNAME_KEY);
    if (!nickname) {
      clearStoredSession();
      setEntryError();
      return;
    }
    payload.nickname = nickname;
  } else if (storedRole === "admin") {
    const adminSessionToken = readStoredValue(ADMIN_SESSION_TOKEN_KEY);
    if (!adminSessionToken) {
      clearStoredSession();
      setEntryError();
      return;
    }
    payload.adminSessionToken = adminSessionToken;
  } else {
    clearStoredSession();
    setEntryError();
    return;
  }

  const response = await emitWithAck("session:resume", payload);
  if (!response.ok) {
    clearStoredSession();
    setEntryError(response.error);
    return;
  }

  if (response.role === "user") {
    myUserId = response.userId;
    nicknameInput.value = response.nickname || payload.nickname;
    storeUserSession(nicknameInput.value);
    enterRoom("user", response.state);
    return;
  }

  if (response.role === "admin") {
    storeAdminSession(response.adminSessionToken || payload.adminSessionToken);
    enterRoom("admin", response.state);
  }
}

async function uploadFile(file, body = "") {
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `${file.name || "파일"}은 10MB 이하만 업로드할 수 있습니다.`,
    };
  }

  const buffer = await file.arrayBuffer();
  return emitWithAck("file:upload", {
    name: file.name || `clipboard-image-${Date.now()}.png`,
    type: file.type || "application/octet-stream",
    size: file.size,
    body,
    file: buffer,
  });
}

async function sendFiles(files, body = "") {
  const uploadFiles = Array.from(files || []);
  if (uploadFiles.length === 0) {
    return true;
  }

  if (!role) {
    setEntryError("먼저 입장하세요.");
    return false;
  }

  setRoomError();
  setUploadStatus(`${uploadFiles.length}개 파일 업로드 중입니다.`);
  attachButton.disabled = true;
  chatInput.disabled = true;

  let ok = true;
  for (const [index, file] of uploadFiles.entries()) {
    const response = await uploadFile(file, index === 0 ? body : "");
    if (!response.ok) {
      setRoomError(response.error);
      ok = false;
      break;
    }
  }

  setUploadStatus();
  attachButton.disabled = false;
  chatInput.disabled = false;
  chatInput.focus();
  return ok;
}

userForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setEntryError();

  const response = await emitWithAck("user:join", {
    nickname: nicknameInput.value,
    clientId: browserClientId,
  });

  if (!response.ok) {
    setEntryError(response.error);
    return;
  }

  myUserId = response.userId;
  if (response.nickname) {
    nicknameInput.value = response.nickname;
  }
  storeUserSession(nicknameInput.value);
  enterRoom("user", response.state);
});

adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setEntryError();

  const response = await emitWithAck("admin:login", {
    password: adminPasswordInput.value,
    clientId: browserClientId,
  });

  if (!response.ok) {
    setEntryError(response.error);
    return;
  }

  nicknameInput.disabled = false;
  userForm.querySelector("button").disabled = false;
  storeAdminSession(response.adminSessionToken);
  enterRoom("admin", response.state);
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setRoomError();

  const body = chatInput.value;
  chatInput.value = "";

  const response = await emitWithAck("chat:send", { body });
  if (!response.ok) {
    setRoomError(response.error);
    chatInput.value = body;
  }
});

attachButton.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", async () => {
  const files = Array.from(fileInput.files || []);
  const body = chatInput.value;
  chatInput.value = "";
  fileInput.value = "";
  if (!(await sendFiles(files, body))) {
    chatInput.value = body;
  }
});

chatInput.addEventListener("paste", async (event) => {
  const pastedImages = Array.from(event.clipboardData?.files || []).filter(
    (file) => file.type.startsWith("image/"),
  );

  if (pastedImages.length === 0) {
    return;
  }

  event.preventDefault();
  const body = chatInput.value;
  chatInput.value = "";
  if (!(await sendFiles(pastedImages, body))) {
    chatInput.value = body;
  }
});

startPushButton.addEventListener("click", async () => {
  setRoomError();
  const response = await emitWithAck("push:start");
  if (!response.ok) {
    setRoomError(response.error);
  }
});

resetPushButton.addEventListener("click", async () => {
  setRoomError();
  const response = await emitWithAck("push:reset");
  if (!response.ok) {
    setRoomError(response.error);
  }
});

pressPushButton.addEventListener("click", async () => {
  setRoomError();
  pressPushButton.disabled = true;
  const response = await emitWithAck("push:press");
  if (!response.ok) {
    setRoomError(response.error);
    pressPushButton.disabled = false;
  }
});

completeOkButton.addEventListener("click", async () => {
  completeModal.hidden = true;
  const response = await emitWithAck("push:reset");
  if (!response.ok) {
    setRoomError(response.error);
  }
});

userList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-kick-user]");
  if (!button || role !== "admin") {
    return;
  }

  const nickname = button.dataset.nickname || "사용자";
  const ipAddress = button.dataset.ipAddress || "IP 없음";
  const confirmed = window.confirm(
    `${nickname}님을 강퇴하고 ${ipAddress} IP를 차단할까요?`,
  );

  if (!confirmed) {
    return;
  }

  const response = await emitWithAck("admin:kick-user", {
    userId: button.dataset.kickUser,
  });
  if (!response.ok) {
    setRoomError(response.error);
  }
});

blocklist.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-unblock-ip]");
  if (!button || role !== "admin") {
    return;
  }

  const response = await emitWithAck("admin:unblock-ip", {
    ipAddress: button.dataset.unblockIp,
  });
  if (!response.ok) {
    setRoomError(response.error);
  }
});

messages.addEventListener("contextmenu", async (event) => {
  const message = event.target.closest("[data-message-id]");
  if (!message || role !== "admin") {
    return;
  }

  event.preventDefault();
  const body = message.querySelector(".message-body")?.textContent || message.textContent;
  const confirmed = window.confirm(`이 채팅을 삭제할까요?\n\n${body.slice(0, 120)}`);
  if (!confirmed) {
    return;
  }

  const response = await emitWithAck("admin:delete-message", {
    messageId: message.dataset.messageId,
  });
  if (!response.ok) {
    setRoomError(response.error);
  }
});

leaveButton.addEventListener("click", async () => {
  isLeaving = true;
  clearStoredSession();
  if (role) {
    await emitWithAck("session:leave", { clientId: browserClientId });
  }
  window.location.reload();
});

socket.on("state:update", renderState);
socket.on("push:complete", showCompleteModal);
socket.on("session:left", () => {
  if (isLeaving) {
    return;
  }

  clearStoredSession();
  window.location.reload();
});
socket.on("access:blocked", (payload) => {
  showBlocked(payload?.message);
});
socket.on("access:unblocked", (payload) => {
  if (!role) {
    nicknameInput.disabled = false;
    userForm.querySelector("button").disabled = false;
    setEntryError(payload?.message || "다시 입장할 수 있습니다.");
  }
});
socket.on("disconnect", () => {
  if (role) {
    setRoomError("서버 연결이 끊어졌습니다. 새로고침 후 다시 입장하세요.");
  }
});
socket.on("connect", () => {
  if (role) {
    setRoomError("연결이 다시 생성되었습니다. 새로고침 후 다시 입장하세요.");
    return;
  }

  resumeStoredSession();
});

if (socket.connected) {
  resumeStoredSession();
}

window.addEventListener("storage", (event) => {
  if (event.key === SESSION_ROLE_KEY && event.newValue === null && role) {
    window.location.reload();
  }
});
