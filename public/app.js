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
const pushPanel = document.querySelector("#push-panel");
const pushTitle = document.querySelector("#push-title");
const pushDescription = document.querySelector("#push-description");
const pressPushButton = document.querySelector("#press-push-button");
const messages = document.querySelector("#messages");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const leaveButton = document.querySelector("#leave-button");
const completeModal = document.querySelector("#complete-modal");
const completeMessage = document.querySelector("#complete-message");
const completeOkButton = document.querySelector("#complete-ok-button");

let role = null;
let myUserId = null;
let latestState = null;
let completeRoundShown = null;

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

    const nickname = createElement("span", "nickname", user.nickname);
    const status = createElement(
      "span",
      "status",
      snapshot.push.active ? (user.pressed ? "완료" : "대기") : "접속중",
    );

    row.append(nickname, status);
    userList.append(row);
  });
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
        row.append(meta, createElement("div", "message-body", message.body));
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

userForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setEntryError();

  const response = await emitWithAck("user:join", {
    nickname: nicknameInput.value,
  });

  if (!response.ok) {
    setEntryError(response.error);
    return;
  }

  myUserId = response.userId;
  enterRoom("user", response.state);
});

adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setEntryError();

  const response = await emitWithAck("admin:login", {
    password: adminPasswordInput.value,
  });

  if (!response.ok) {
    setEntryError(response.error);
    return;
  }

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

leaveButton.addEventListener("click", () => {
  window.location.reload();
});

socket.on("state:update", renderState);
socket.on("push:complete", showCompleteModal);
socket.on("disconnect", () => {
  setRoomError("서버 연결이 끊어졌습니다. 새로고침 후 다시 입장하세요.");
});
socket.on("connect", () => {
  if (role) {
    setRoomError("연결이 다시 생성되었습니다. 새로고침 후 다시 입장하세요.");
  }
});
