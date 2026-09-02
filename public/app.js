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
const mediaModal = document.querySelector("#media-modal");
const mediaStage = document.querySelector("#media-stage");
const mediaCaption = document.querySelector("#media-caption");
const mediaCloseButton = document.querySelector("#media-close-button");
const mediaPrevButton = document.querySelector("#media-prev-button");
const mediaNextButton = document.querySelector("#media-next-button");
const mediaZoomOutButton = document.querySelector("#media-zoom-out-button");
const mediaZoomInButton = document.querySelector("#media-zoom-in-button");
const mediaResetButton = document.querySelector("#media-reset-button");
const mediaZoomValue = document.querySelector("#media-zoom-value");
const BROWSER_ID_KEY = "studychat.browserClientId";
const NICKNAME_KEY = "studychat.nickname";
const SESSION_ROLE_KEY = "studychat.sessionRole";
const ADMIN_SESSION_TOKEN_KEY = "studychat.adminSessionToken";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_BATCH_BYTES = 150 * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 12;
const MESSAGE_PREVIEW_LENGTH = 220;
const MIN_MEDIA_ZOOM = 0.5;
const MAX_MEDIA_ZOOM = 6;
const MEDIA_ZOOM_STEP = 0.25;

let role = null;
let myUserId = null;
let latestState = null;
let completeRoundShown = null;
let autoResumeAttempted = false;
let isLeaving = false;
let mediaViewerItems = [];
let mediaViewerIndex = 0;
let mediaZoom = 1;
let mediaOffsetX = 0;
let mediaOffsetY = 0;
let mediaDrag = null;
const expandedMessageIds = new Set();

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

function isMediaAttachment(attachment) {
  return attachment?.kind === "image" || attachment?.kind === "video";
}

function getMediaAttachmentsForMessage(messageId) {
  const message = latestState?.messages.find((item) => item.id === messageId);
  return (message?.attachments || []).filter(isMediaAttachment);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resetMediaViewport() {
  mediaZoom = 1;
  mediaOffsetX = 0;
  mediaOffsetY = 0;
  mediaDrag = null;
  applyMediaTransform();
}

function applyMediaTransform() {
  const media = mediaStage.querySelector(".media-viewer-image, .media-viewer-video");
  if (media) {
    media.style.transform = `translate3d(${mediaOffsetX}px, ${mediaOffsetY}px, 0) scale(${mediaZoom})`;
    media.style.cursor = mediaZoom > 1 ? "grab" : "zoom-in";
  }

  mediaStage.dataset.zoomed = mediaZoom > 1 ? "true" : "false";
  mediaZoomValue.textContent = `${Math.round(mediaZoom * 100)}%`;
  mediaZoomOutButton.disabled = mediaZoom <= MIN_MEDIA_ZOOM;
  mediaZoomInButton.disabled = mediaZoom >= MAX_MEDIA_ZOOM;
}

function setMediaZoom(nextZoom) {
  const previousZoom = mediaZoom;
  mediaZoom = clamp(Number(nextZoom) || 1, MIN_MEDIA_ZOOM, MAX_MEDIA_ZOOM);

  if (mediaZoom <= 1) {
    mediaOffsetX = 0;
    mediaOffsetY = 0;
  } else if (previousZoom <= 1) {
    mediaOffsetX = 0;
    mediaOffsetY = 0;
  }

  applyMediaTransform();
}

function closeMediaViewer() {
  mediaViewerItems = [];
  mediaViewerIndex = 0;
  resetMediaViewport();
  mediaStage.replaceChildren();
  mediaModal.hidden = true;
}

function renderMediaViewer() {
  const attachment = mediaViewerItems[mediaViewerIndex];
  if (!attachment) {
    closeMediaViewer();
    return;
  }

  resetMediaViewport();
  mediaStage.replaceChildren();

  if (attachment.kind === "video") {
    const video = document.createElement("video");
    video.className = "media-viewer-video";
    video.src = attachment.url;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = "metadata";
    mediaStage.append(video);
  } else {
    const image = document.createElement("img");
    image.className = "media-viewer-image";
    image.src = attachment.url;
    image.alt = attachment.originalName || "첨부 이미지";
    image.draggable = false;
    mediaStage.append(image);
  }

  applyMediaTransform();
  mediaCaption.textContent = `${attachment.originalName || "첨부파일"} · ${formatFileSize(
    attachment.size,
  )} · ${mediaViewerIndex + 1}/${mediaViewerItems.length}`;
  mediaPrevButton.hidden = mediaViewerItems.length <= 1;
  mediaNextButton.hidden = mediaViewerItems.length <= 1;
}

function openMediaViewer(items, index = 0) {
  if (!items.length) {
    return;
  }

  mediaViewerItems = items;
  mediaViewerIndex = Math.min(Math.max(index, 0), items.length - 1);
  mediaModal.hidden = false;
  renderMediaViewer();
  mediaCloseButton.focus();
}

function moveMediaViewer(delta) {
  if (mediaViewerItems.length <= 1) {
    return;
  }

  mediaViewerIndex =
    (mediaViewerIndex + delta + mediaViewerItems.length) % mediaViewerItems.length;
  renderMediaViewer();
}

function startMediaDrag(event) {
  if (event.button !== 0 || mediaModal.hidden || mediaZoom <= 1) {
    return;
  }

  const media = event.target.closest(".media-viewer-image, .media-viewer-video");
  if (!media) {
    return;
  }

  mediaDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: mediaOffsetX,
    offsetY: mediaOffsetY,
  };
  media.style.cursor = "grabbing";
  mediaStage.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveMediaDrag(event) {
  if (!mediaDrag || event.pointerId !== mediaDrag.pointerId) {
    return;
  }

  mediaOffsetX = mediaDrag.offsetX + event.clientX - mediaDrag.startX;
  mediaOffsetY = mediaDrag.offsetY + event.clientY - mediaDrag.startY;
  applyMediaTransform();
}

function endMediaDrag(event) {
  if (!mediaDrag || event.pointerId !== mediaDrag.pointerId) {
    return;
  }

  mediaDrag = null;
  mediaStage.releasePointerCapture(event.pointerId);
  applyMediaTransform();
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

function renderMediaAttachment(attachment, messageId, mediaIndex) {
  const button = createElement("button", "attachment-media");
  button.type = "button";
  button.dataset.mediaMessageId = messageId;
  button.dataset.mediaIndex = String(mediaIndex);
  button.setAttribute(
    "aria-label",
    `${attachment.originalName || "첨부 미디어"} 크게 보기`,
  );

  if (attachment.kind === "video") {
    const video = document.createElement("video");
    video.className = "attachment-video";
    video.src = attachment.url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    const badge = createElement("span", "video-badge", "▶");
    badge.setAttribute("aria-hidden", "true");
    button.append(video, badge);
  } else {
    const image = document.createElement("img");
    image.className = "attachment-image";
    image.src = attachment.url;
    image.alt = attachment.originalName || "첨부 이미지";
    image.loading = "lazy";
    button.append(image);
  }

  return button;
}

function renderFileAttachment(attachment) {
  const wrapper = createElement("div", "attachment-file-row");
  const link = createElement("a", "attachment-file");
  link.href = attachment.url;
  link.target = "_blank";
  link.rel = "noopener";
  link.download = attachment.originalName || "첨부파일";
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

function renderAttachments(attachments = [], messageId) {
  const visibleAttachments = attachments.filter((attachment) => attachment?.url);
  const list = createElement("div", "attachments");
  const mediaAttachments = visibleAttachments.filter(isMediaAttachment);
  const fileAttachments = visibleAttachments.filter(
    (attachment) => !isMediaAttachment(attachment),
  );

  if (mediaAttachments.length) {
    const countClass =
      mediaAttachments.length > 4 ? "many" : String(mediaAttachments.length);
    const mediaGrid = createElement("div", `media-grid media-count-${countClass}`);
    mediaGrid.dataset.mediaCount = String(mediaAttachments.length);
    mediaAttachments.forEach((attachment, index) => {
      mediaGrid.append(renderMediaAttachment(attachment, messageId, index));
    });
    list.append(mediaGrid);

    if (mediaAttachments.length === 1) {
      const attachment = mediaAttachments[0];
      list.append(
        createElement(
          "span",
          "attachment-caption",
          `${attachment.originalName || "미디어"} · ${formatFileSize(attachment.size)}`,
        ),
      );
    }
  }

  fileAttachments.forEach((attachment) => {
    list.append(renderFileAttachment(attachment));
  });

  return list;
}

function renderMessageBody(message) {
  const expanded = expandedMessageIds.has(message.id);
  const isLong = message.body.length > MESSAGE_PREVIEW_LENGTH;
  const bodyText =
    isLong && !expanded
      ? `${message.body.slice(0, MESSAGE_PREVIEW_LENGTH).trimEnd()}...`
      : message.body;
  const fragment = document.createDocumentFragment();
  const body = createElement("div", "message-body", bodyText);
  body.id = `message-body-${message.id}`;
  if (isLong) {
    body.classList.add("message-body-collapsed");
  }
  fragment.append(body);

  if (isLong) {
    const toggleButton = createElement(
      "button",
      "message-more-button",
      expanded ? "접기" : "더보기",
    );
    toggleButton.type = "button";
    toggleButton.dataset.toggleMessageId = message.id;
    toggleButton.setAttribute("aria-controls", body.id);
    toggleButton.setAttribute("aria-expanded", String(expanded));
    fragment.append(toggleButton);
  }

  return fragment;
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
          row.append(renderMessageBody(message));
        }
        if (message.attachments?.length) {
          row.append(renderAttachments(message.attachments, message.id));
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

async function readUploadFile(file, index = 0) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `${file.name || "파일"}은 ${formatFileSize(MAX_UPLOAD_BYTES)} 이하만 업로드할 수 있습니다.`,
    );
  }

  const buffer = await file.arrayBuffer();
  return {
    name: file.name || `clipboard-image-${Date.now()}-${index + 1}.png`,
    type: file.type || "application/octet-stream",
    size: file.size,
    file: buffer,
  };
}

async function uploadFileBatch(fileBatch, body = "", batchIndex = 0) {
  const files = await Promise.all(
    fileBatch.map((file, index) =>
      readUploadFile(file, batchIndex * MAX_FILES_PER_MESSAGE + index),
    ),
  );

  return emitWithAck("file:upload", {
    body,
    files,
  });
}

function createFileBatches(files) {
  const batches = [];
  let batch = [];
  let batchSize = 0;

  files.forEach((file) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `${file.name || "파일"}은 ${formatFileSize(MAX_UPLOAD_BYTES)} 이하만 업로드할 수 있습니다.`,
      );
    }

    const shouldStartNextBatch =
      batch.length >= MAX_FILES_PER_MESSAGE ||
      (batch.length > 0 && batchSize + file.size > MAX_UPLOAD_BATCH_BYTES);

    if (shouldStartNextBatch) {
      batches.push(batch);
      batch = [];
      batchSize = 0;
    }

    batch.push(file);
    batchSize += file.size;
  });

  if (batch.length) {
    batches.push(batch);
  }

  return batches;
}

async function sendFiles(files, body = "") {
  const selectedFiles = Array.from(files || []);
  if (selectedFiles.length === 0) {
    return true;
  }

  if (!role) {
    setEntryError("먼저 입장하세요.");
    return false;
  }

  setRoomError();
  setUploadStatus(`${selectedFiles.length}개 파일 업로드 중입니다.`);
  attachButton.disabled = true;
  chatInput.disabled = true;

  let ok = true;
  try {
    const batches = createFileBatches(selectedFiles);
    for (const [index, batch] of batches.entries()) {
      const batchNumber = index + 1;
      const totalBatches = batches.length;
      if (totalBatches > 1) {
        setUploadStatus(`${batchNumber}/${totalBatches} 묶음 업로드 중입니다.`);
      }

      const response = await uploadFileBatch(
        batch,
        batchNumber === 1 ? body : "",
        batchNumber - 1,
      );
      if (!response.ok) {
        setRoomError(response.error);
        ok = false;
        break;
      }
    }
  } catch (error) {
    setRoomError(error.message || "파일 업로드에 실패했습니다.");
    ok = false;
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

messages.addEventListener("click", (event) => {
  const toggleButton = event.target.closest("[data-toggle-message-id]");
  if (toggleButton) {
    const messageId = toggleButton.dataset.toggleMessageId;
    if (expandedMessageIds.has(messageId)) {
      expandedMessageIds.delete(messageId);
    } else {
      expandedMessageIds.add(messageId);
    }
    renderMessages(latestState);
    return;
  }

  const trigger = event.target.closest("[data-media-message-id]");
  if (!trigger) {
    return;
  }

  const mediaItems = getMediaAttachmentsForMessage(trigger.dataset.mediaMessageId);
  openMediaViewer(mediaItems, Number(trigger.dataset.mediaIndex || 0));
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

mediaCloseButton.addEventListener("click", closeMediaViewer);
mediaPrevButton.addEventListener("click", () => moveMediaViewer(-1));
mediaNextButton.addEventListener("click", () => moveMediaViewer(1));
mediaZoomOutButton.addEventListener("click", () => {
  setMediaZoom(mediaZoom - MEDIA_ZOOM_STEP);
});
mediaZoomInButton.addEventListener("click", () => {
  setMediaZoom(mediaZoom + MEDIA_ZOOM_STEP);
});
mediaResetButton.addEventListener("click", resetMediaViewport);
mediaStage.addEventListener(
  "wheel",
  (event) => {
    if (mediaModal.hidden) {
      return;
    }

    event.preventDefault();
    setMediaZoom(mediaZoom + (event.deltaY < 0 ? MEDIA_ZOOM_STEP : -MEDIA_ZOOM_STEP));
  },
  { passive: false },
);
mediaStage.addEventListener("pointerdown", startMediaDrag);
mediaStage.addEventListener("pointermove", moveMediaDrag);
mediaStage.addEventListener("pointerup", endMediaDrag);
mediaStage.addEventListener("pointercancel", endMediaDrag);
mediaModal.addEventListener("click", (event) => {
  if (event.target === mediaModal) {
    closeMediaViewer();
  }
});

window.addEventListener("keydown", (event) => {
  if (mediaModal.hidden) {
    return;
  }

  if (event.key === "Escape") {
    closeMediaViewer();
  } else if (event.key === "ArrowLeft") {
    moveMediaViewer(-1);
  } else if (event.key === "ArrowRight") {
    moveMediaViewer(1);
  } else if (event.key === "+" || event.key === "=") {
    setMediaZoom(mediaZoom + MEDIA_ZOOM_STEP);
  } else if (event.key === "-") {
    setMediaZoom(mediaZoom - MEDIA_ZOOM_STEP);
  } else if (event.key === "0") {
    resetMediaViewport();
  }
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
