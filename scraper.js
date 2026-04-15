const fs = require("node:fs/promises");
const path = require("node:path");

const API_BASE = "https://api.holdinghands.com.tw";
const WEB_ORIGIN = "https://www.holdinghands.com.tw";
const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, ".env");
const LAST_MSG_PATH = path.join(ROOT, ".last_msg_id");
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "Daily");
const DEFAULT_MEDICINE_DIR = path.join(ROOT, "medicine");
const KNOWN_VALUE_FLAGS = new Set(["--date", "--from", "--to", "--output", "--med", "--duration", "--del_med"]);
const MEDICINE_FILE_BY_INDEX = {
  "1": "孩子1.txt",
  "2": "孩子2.txt",
};

function getHelpText() {
  return [
    "Usage:",
    "  node scraper.js [options]",
    "",
    "Description:",
    "  讀取聯絡簿，預設抓今天資料，並在可簽名時自動簽名。",
    "  也可用 --med 指定孩子送出托藥單,托藥單日期預設為明天。",
    "",
    "Options:",
    "  --date YYYY-MM-DD        指定單一天日期",
    "  --from YYYY-MM-DD        指定起始日期，需搭配 --to",
    "  --to YYYY-MM-DD          指定結束日期，需搭配 --from",
    "  --output PATH            聯絡簿輸出目錄，預設為 ./Daily",
    "  --med 1|2                送出托藥單：1=孩子1，2=孩子2",
    "  --duration N             搭配 --med，從明天起連續送出 N 天藥單（預設 1）",
    "  --del_med 1|2            刪除指定孩子的所有托藥單：1=孩子1，2=孩子2",
    "  --notice                 抓取後發送 Telegram／LINE 通知，不寫入 ./Daily",
    "  --msg                    讀取老師未讀私訊並透過 Telegram 轉發",
    "  --msg_debug              讀取所有聊天室的最後兩條訊息並轉發（不論已讀，僅供除錯用）",
    "  --auto_reply             擷取今日兩位孩子聯絡簿老師留言，請 Gemini 擬三段回覆後透過 Telegram 傳送",
    "  --no-sign-missing        不自動簽名聯絡簿",
    "  --wait                   等待至台北時間 18:00:01 再執行",
    "  --debug                  顯示額外偵錯資訊",
    "",
    "Medicine Files:",
    "  --med 1 會讀取 ./medicine/孩子1.txt",
    "  --med 2 會讀取 ./medicine/孩子2.txt",
    "",
    "Examples:",
    "  node scraper.js",
    "  node scraper.js --date 2026-04-01",
    "  node scraper.js --from 2026-04-01 --to 2026-04-07",
    "  node scraper.js --med 1",
    "  node scraper.js --med 1 --duration 3",
    "  node scraper.js --date 2026-04-01 --med 2 --no-sign-missing",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    output: DEFAULT_OUTPUT_DIR,
    debug: false,
    medicineTarget: null,
    medicineDuration: 1,
    deleteMedicineTarget: null,
    sendTelegram: false,
    telegramOnly: false,
    signMissing: true,
    fetchMessages: false,
    autoReply: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--debug") {
      args.debug = true;
      continue;
    }
    if (value === "--help" || value === "-h") {
      args.help = true;
      continue;
    }
    if (value === "--no-sign-missing") {
      args.signMissing = false;
      continue;
    }
    if (value === "--wait") {
      args.wait = true;
      continue;
    }
    if (value === "--notice") {
      args.sendTelegram = true;
      args.telegramOnly = true;
      continue;
    }
    if (value === "--msg") {
      args.fetchMessages = true;
      continue;
    }
    if (value === "--msg_debug") {
      args.fetchMessagesAll = true; // 不過濾已讀，強制取每間聊天室最後兩則（除錯用）
      continue;
    }
    if (value === "--auto_reply") {
      args.autoReply = true;
      continue;
    }

    if (!KNOWN_VALUE_FLAGS.has(value)) {
      throw new Error(`Unknown argument: ${value}\n\n${getHelpText()}`);
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${value}\n\n${getHelpText()}`);
    }

    if (value === "--date") {
      args.date = next;
    } else if (value === "--from") {
      args.from = next;
    } else if (value === "--to") {
      args.to = next;
    } else if (value === "--output") {
      args.output = next;
    } else if (value === "--med") {
      if (!["1", "2"].includes(next)) {
        throw new Error(`--med must be 1 (孩子1) or 2 (孩子2)\n\n${getHelpText()}`);
      }
      args.medicineTarget = next;
    } else if (value === "--duration") {
      const n = parseInt(next, 10);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--duration must be a positive integer\n\n${getHelpText()}`);
      }
      args.medicineDuration = n;
    } else if (value === "--del_med") {
      if (!["1", "2"].includes(next)) {
        throw new Error(`--del_med must be 1 (孩子1) or 2 (孩子2)\n\n${getHelpText()}`);
      }
      args.deleteMedicineTarget = next;
    }
    index += 1;
  }

  if (args.date && (args.from || args.to)) {
    throw new Error(`--date cannot be combined with --from/--to\n\n${getHelpText()}`);
  }
  if ((args.from && !args.to) || (!args.from && args.to)) {
    throw new Error(`--from and --to must be used together\n\n${getHelpText()}`);
  }
  if (args.autoReply && (args.from || args.to)) {
    throw new Error(`--auto_reply does not support date ranges, use --date instead\n\n${getHelpText()}`);
  }

  return args;
}

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    values[key] = value;
  }
  return values;
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime()) && dateToString(date) === value;
}

function dateToString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTaipeiDateString(offsetDays = 0) {
  const now = new Date();
  const taipeiStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // "YYYY-MM-DD"
  if (offsetDays === 0) return taipeiStr;
  const d = new Date(`${taipeiStr}T00:00:00`);
  d.setDate(d.getDate() + offsetDays);
  return dateToString(d);
}

function getTomorrowString() {
  return getTaipeiDateString(1);
}

function expandDates(args) {
  if (args.date) {
    if (!isValidDateString(args.date)) {
      throw new Error(`Invalid --date: ${args.date}`);
    }
    return [args.date];
  }

  if (args.from && args.to) {
    if (!isValidDateString(args.from) || !isValidDateString(args.to)) {
      throw new Error("Invalid --from/--to date format");
    }
    const start = new Date(`${args.from}T00:00:00`);
    const end = new Date(`${args.to}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error("Invalid --from/--to date value");
    }
    if (start > end) {
      throw new Error("--from must be earlier than or equal to --to");
    }

    const dates = [];
    const current = new Date(start);
    while (current <= end) {
      dates.push(dateToString(current));
      current.setDate(current.getDate() + 1);
    }
    return dates;
  }

  return [getTaipeiDateString(0)];
}

async function loadConfig() {
  const envText = await fs.readFile(ENV_PATH, "utf8");
  const env = parseEnv(envText);
  const phone = env.PHONE || env.USERNAME;
  const password = env.PASSWORD;
  if (!phone || !password) {
    throw new Error("Expected PHONE or USERNAME and PASSWORD in .env");
  }

  function parseTgAccount(suffix) {
    const token = env[`TG_BOT_TOKEN${suffix}`] || "";
    const chatId = env[`TG_CHAT_ID${suffix}`] || "";
    if (!token || !chatId) return null;
    const format = env[`TG_FORMAT${suffix}`] || "full";
    return { token, chatId, format };
  }

  function parseLineAccount(suffix) {
    const accessToken = env[`LINE_ACCESS_TOKEN${suffix}`] || "";
    const userId = env[`LINE_USER_ID${suffix}`] || "";
    if (!accessToken || !userId) return null;
    const format = env[`LINE_FORMAT${suffix}`] || "compact";
    return { accessToken, userId, format };
  }

  return {
    phone,
    password,
    geminiApiKey: env.GEMINI_API_KEY || "",
    tgAccounts: [parseTgAccount(""), parseTgAccount("_2")].filter(Boolean),
    lineAccounts: [parseLineAccount(""), parseLineAccount("_2")].filter(Boolean),
  };
}


async function loadLastMsgMap() {
  try {
    const text = await fs.readFile(LAST_MSG_PATH, "utf8").then((t) => t.trim());
    // Legacy format: plain number — discard, start per-room tracking fresh
    if (/^\d+$/.test(text)) {
      return {};
    }
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return {};
    // Drop any leftover _global key
    delete parsed._global;
    return parsed;
  } catch {
    return {};
  }
}

async function saveLastMsgMap(map) {
  await fs.writeFile(LAST_MSG_PATH, JSON.stringify(map), "utf8");
}

async function withRetry(fn, { retries = 3, delayMs = 2000, label = "" } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const wait = delayMs * attempt;
        process.stderr.write(`${label ? label + ": " : ""}attempt ${attempt} failed (${err.message}), retrying in ${wait}ms...\n`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  throw lastErr;
}

async function requestJsonSoft(url, options = {}) {
  try {
    const response = await fetch(url, options);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

async function requestJson(url, options = {}) {
  return withRetry(async () => {
    const response = await fetch(url, options);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}: ${text.slice(0, 500)}`);
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 500)}`);
    }
  }, { label: url.replace(/\?.*/, "").split("/").slice(-2).join("/") });
}

function buildHeaders(token) {
  return {
    accept: "application/json, text/plain, */*",
    authorization: token,
    origin: WEB_ORIGIN,
    referer: `${WEB_ORIGIN}/`,
  };
}

function buildJsonHeaders(token) {
  return {
    ...buildHeaders(token),
    "content-type": "application/json;charset=UTF-8",
  };
}

async function login(phone, password) {
  const payload = await requestJson(`${API_BASE}/user/login`, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json;charset=UTF-8",
      origin: WEB_ORIGIN,
      referer: `${WEB_ORIGIN}/`,
    },
    body: JSON.stringify({
      phone,
      password,
      user_type: 3,
    }),
  });

  if (payload.ret_code !== 200 || !payload.token) {
    throw new Error(`Login failed: ${payload.ret_desc || JSON.stringify(payload)}`);
  }

  return payload.token;
}

async function fetchUser(token) {
  const payload = await requestJson(`${API_BASE}/family/user`, {
    headers: buildHeaders(token),
  });
  if (payload.ret_code !== 200 || !payload.user) {
    throw new Error(`Could not load family user: ${payload.ret_desc || JSON.stringify(payload)}`);
  }
  return payload.user;
}

async function checkUserPassword(token, phone, password) {
  const payload = await requestJson(`${API_BASE}/family/check_user`, {
    method: "POST",
    headers: buildJsonHeaders(token),
    body: JSON.stringify({ phone, password }),
  });
  if (payload.ret_code !== 200) {
    throw new Error(`User verification failed: ${payload.ret_desc || JSON.stringify(payload)}`);
  }
}

async function fetchChildren(token) {
  const payload = await requestJson(`${API_BASE}/family/babies`, {
    headers: buildHeaders(token),
  });

  if (payload.ret_code !== 200 || !Array.isArray(payload.babies)) {
    throw new Error(`Could not load babies: ${payload.ret_desc || JSON.stringify(payload)}`);
  }

  return payload.babies.map((baby) => ({
    babyId: String(baby.id),
    name: baby.name || `baby-${baby.id}`,
    raw: baby,
  }));
}

async function fetchContactBooks(token, babyId, startDate, endDate) {
  const url = new URL(`${API_BASE}/family/contact_books`);
  url.searchParams.set("baby_id", babyId);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);

  const payload = await requestJson(url.toString(), {
    headers: buildHeaders(token),
  });

  if (payload.ret_code !== 200 || !Array.isArray(payload.contact_books)) {
    throw new Error(`Could not load contact books for baby ${babyId}: ${payload.ret_desc || JSON.stringify(payload)}`);
  }

  return {
    sourceUrl: url.toString(),
    payload,
  };
}

async function signContactBook(token, { classId, babyId, date, location }) {
  const payload = await requestJson(`${API_BASE}/family/sign_contact_book`, {
    method: "POST",
    headers: buildJsonHeaders(token),
    body: JSON.stringify({
      class_id: classId,
      baby_id: Number(babyId),
      date,
      location,
    }),
  });
  if (payload.ret_code !== 200) {
    throw new Error(`Could not sign contact book: ${payload.ret_desc || JSON.stringify(payload)}`);
  }
  return payload;
}

async function fetchMedicineForms(token, babyId, startDate, endDate) {
  const url = new URL(`${API_BASE}/family/medicine_forms`);
  url.searchParams.set("baby_id", babyId);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);

  const payload = await requestJson(url.toString(), {
    headers: buildHeaders(token),
  });

  if (payload.ret_code !== 200 || !Array.isArray(payload.medicine_forms)) {
    throw new Error(`Could not load medicine forms for baby ${babyId}: ${payload.ret_desc || JSON.stringify(payload)}`);
  }
  return payload.medicine_forms;
}

async function postMedicineForm(token, body) {
  const payload = await requestJson(`${API_BASE}/family/medicine_form`, {
    method: "POST",
    headers: buildJsonHeaders(token),
    body: JSON.stringify(body),
  });
  if (payload.ret_code !== 200) {
    throw new Error(`Could not create medicine form: ${payload.ret_desc || JSON.stringify(payload)}`);
  }
  return payload.medicine_form;
}

async function patchMedicineForm(token, body) {
  const payload = await requestJson(`${API_BASE}/family/medicine_form`, {
    method: "PATCH",
    headers: buildJsonHeaders(token),
    body: JSON.stringify(body),
  });
  if (payload.ret_code !== 200) {
    throw new Error(`Could not update medicine form: ${payload.ret_desc || JSON.stringify(payload)}`);
  }
  return payload.medicine_form;
}

async function deleteMedicineForm(token, id) {
  const payload = await requestJson(`${API_BASE}/family/medicine_form`, {
    method: "DELETE",
    headers: buildJsonHeaders(token),
    body: JSON.stringify({ id }),
  });
  if (payload.ret_code !== 200) {
    throw new Error(`Could not delete medicine form: ${payload.ret_desc || JSON.stringify(payload)}`);
  }
}

async function processDeleteMedicine({ token, phone, password, children, debug }) {
  const summary = [];
  await checkUserPassword(token, phone, password);

  // Search a wide range: from today to 6 months ahead
  const today = new Date();
  const startDate = dateToString(today);
  const future = new Date(today);
  future.setMonth(future.getMonth() + 6);
  const endDate = dateToString(future);

  for (const child of children) {
    try {
      const existingForms = await fetchMedicineForms(token, child.babyId, startDate, endDate);
      const deletable = existingForms
        .filter((form) => !form.checked?.status)
        .sort((left, right) => Number(right.id) - Number(left.id));

      if (deletable.length === 0) {
        summary.push({ child_name: child.name, status: "skipped", reason: "no deletable medicine form found" });
        continue;
      }

      for (const form of deletable) {
        await deleteMedicineForm(token, form.id);
        if (debug) {
          console.error(`Medicine deleted for ${child.name} id=${form.id} on ${form.date}`);
        }
        summary.push({ child_name: child.name, action: "deleted", date: form.date, id: form.id });
      }
    } catch (err) {
      console.error(`Error deleting medicine for ${child.name}: ${err.message}`);
      summary.push({ child_name: child.name, status: "error", error: err.message });
    }
  }

  return summary;
}

async function sendTelegramMessage(botToken, chatId, text) {
  const payload = await requestJson(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json;charset=UTF-8",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });
  if (!payload.ok) {
    throw new Error(`Telegram send failed: ${payload.description || JSON.stringify(payload)}`);
  }
}

async function sendTelegramPhotoFromUrl(botToken, chatId, imageUrl, caption, authHeaders) {
  return withRetry(async () => {
    // Download image with auth headers, then upload to Telegram as binary
    const imgResponse = await fetch(imageUrl, { headers: authHeaders });
    if (!imgResponse.ok) {
      throw new Error(`Failed to download image ${imageUrl}: ${imgResponse.status}`);
    }
    const blob = await imgResponse.blob();
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("photo", blob, "photo.jpg");
    if (caption) {
      form.append("caption", caption);
    }
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: "POST",
      body: form,
    });
    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(`Telegram sendPhoto failed: ${payload.description || JSON.stringify(payload)}`);
    }
  }, { label: "Telegram sendPhoto" });
}

async function sendLineMessage(accessToken, userId, text) {
  return withRetry(async () => {
    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: "text", text }],
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`LINE send failed (${response.status}): ${body.slice(0, 200)}`);
    }
  }, { label: "LINE sendMessage" });
}

async function sendLineImage(accessToken, userId, imageUrl, text) {
  return withRetry(async () => {
    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        to: userId,
        messages: [
          {
            type: "image",
            originalContentUrl: imageUrl,
            previewImageUrl: imageUrl,
          },
          { type: "text", text },
        ],
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`LINE image send failed (${response.status}): ${body.slice(0, 200)}`);
    }
  }, { label: "LINE sendImage" });
}

function toLineText(document) {
  const lines = [`${document.child_name} ${document.date} 聯絡簿`];

  if (!document.exists) {
    lines.push("今天沒有已發布的聯絡簿。");
    return lines.join("\n");
  }

  if (document.teacher_message.batch || document.teacher_message.content) {
    lines.push("");
    lines.push("【老師的話】");
    if (hasText(document.teacher_message.batch)) {
      lines.push(stripComments(document.teacher_message.batch));
    }
    if (hasText(document.teacher_message.content)) {
      lines.push(document.teacher_message.content);
    }
  }

  const bringEntries = document.entries.filter(
    (e) => e.receipt_required || /需備/.test(e.name || e.category || ""),
  );
  if (bringEntries.length > 0) {
    lines.push("");
    for (const entry of bringEntries) {
      const label = entry.name || entry.type;
      const value = entry.content || entry.values.join("、");
      if (hasText(label) && hasText(value)) {
        lines.push(`• ${label}：${value}`);
      }
    }
  }

  return lines.join("\n").trimEnd();
}

function formatDocumentText(document, format) {
  return format === "compact" ? toLineText(document) : toTelegramText(document);
}

async function sendDocumentToLine(accessToken, userId, document, format = "compact") {
  const text = formatDocumentText(document, format);
  await sendLineMessage(accessToken, userId, text);
}

const TELEGRAM_CAPTION_LIMIT = 1024;

function truncateTelegramCaption(text) {
  if (!text || text.length <= TELEGRAM_CAPTION_LIMIT) return text;
  return `${text.slice(0, TELEGRAM_CAPTION_LIMIT - 1)}\u2026`;
}

function isImageContent(content) {
  return /\.(jpg|jpeg|png|gif|webp)$/i.test(content);
}

const ASSET_BASE = "https://assn.holdinghands.com.tw:8084/master";

function buildImageUrl(content, createTime) {
  if (content.startsWith("http")) {
    return content;
  }
  // Extract date from createTime (e.g. "2026-03-13 09:31:48" → "2026-03")
  const yearMonth = String(createTime || "").slice(0, 7);

  if (content.includes("/")) {
    // Extract filename from path (e.g. "message/2026-03/filename.jpg" → "filename.jpg")
    const filename = content.split("/").pop();
    return `${ASSET_BASE}/message/${yearMonth}/${filename}`;
  }
  // content is filename only
  return `${ASSET_BASE}/message/${yearMonth}/${content}`;
}

async function callGeminiText(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  return withRetry(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!response.ok) {
      throw new Error(`Gemini HTTP ${response.status}: ${await response.text().catch(() => "")}`);
    }
    const json = await response.json();
    if (json.error) {
      throw new Error(`Gemini API 錯誤: ${json.error.message}`);
    }
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      const reason = json.candidates?.[0]?.finishReason || "unknown";
      throw new Error(`Gemini 回應無文字內容 (finishReason: ${reason})`);
    }
    return text;
  }, { label: "Gemini" });
}

async function processAutoReply({ token, children, date, tgAccounts, geminiApiKey, debug }) {
  const sections = [];

  for (const child of children) {
    let books;
    try {
      const fetched = await fetchContactBooks(token, child.babyId, date, date);
      books = fetched.payload.contact_books;
    } catch (err) {
      process.stderr.write(`auto_reply: 無法取得 ${child.name} 聯絡簿: ${err.message}\n`);
      continue;
    }

    const book = books.find((b) => b.date === date);
    const parts = [];
    const batch = book?.teacher_message?.batch ? stripComments(book.teacher_message.batch).trim() : "";
    const content = book?.teacher_message?.content ? stripComments(book.teacher_message.content).trim() : "";
    if (batch) parts.push(batch);
    if (content) parts.push(content);
    if (parts.length === 0) {
      if (debug) process.stderr.write(`auto_reply: ${child.name} 今日無老師留言，略過。\n`);
      continue;
    }
    sections.push(`【${child.name}的聯絡簿】\n${parts.join("\n")}`);
  }

  if (sections.length === 0) {
    if (debug) process.stderr.write(`auto_reply: 今日聯絡簿無內容，略過。\n`);
    return;
  }

  const combinedNotes = sections.join("\n\n");
  const prompt =
    `你是一位溫柔且充滿感激的家長（家有兩歲雙胞胎）。以下是今日托嬰聯絡簿老師的留言，` +
    `包含兩位孩子（孩子1、孩子2）的紀錄。請根據老師紀錄的細節，撰寫三段不同風格且自然的家長回覆` +
    `（例如：感謝風格、成長觀察風格、簡潔溫馨風格）。每段回覆在 30-50 字內，可以同時提及兩位孩子。` +
    `請直接輸出這三段回覆，中間用 '###' 隔開，不要提供任何序言、標題或額外解釋。\n\n${combinedNotes}`;

  if (debug) process.stderr.write(`auto_reply: 傳送 prompt 給 Gemini...\n`);

  const aiResponse = await callGeminiText(geminiApiKey, prompt);
  const versions = aiResponse.split("###").map((t) => t.trim()).filter(Boolean);

  for (const acct of tgAccounts) {
    await sendTelegramMessage(acct.token, acct.chatId, `📋 聯絡簿回覆建議（${date}）`);
    for (const text of versions) {
      for (const chunk of splitTelegramMessage(text)) {
        await sendTelegramMessage(acct.token, acct.chatId, chunk);
      }
    }
  }
}

async function fetchMessageRooms(token) {
  const payload = await requestJson(`${API_BASE}/family/message_rooms`, {
    headers: buildHeaders(token),
  });
  if (payload.ret_code !== 200) {
    throw new Error(`Could not load message rooms: ${payload.ret_desc || JSON.stringify(payload)}`);
  }
  return Array.isArray(payload.message_rooms) ? payload.message_rooms : [];
}

async function markRoomAsRead(token, roomId) {
  const payload = await requestJson(`${API_BASE}/family/message_read`, {
    method: "POST",
    headers: buildJsonHeaders(token),
    body: JSON.stringify({ room_id: roomId }),
  });
  if (payload.ret_code !== 200) {
    throw new Error(`Could not mark room ${roomId} as read: ${payload.ret_desc || JSON.stringify(payload)}`);
  }
}

async function fetchMessagesByRoomId(token, roomId) {
  const url = new URL(`${API_BASE}/family/messages_by_room_id`);
  url.searchParams.set("room_id", roomId);
  const payload = await requestJson(url.toString(), {
    headers: buildHeaders(token),
  });
  if (payload.ret_code !== 200) {
    throw new Error(`Could not load messages for room ${roomId}: ${payload.ret_desc || JSON.stringify(payload)}`);
  }
  return Array.isArray(payload.messages) ? payload.messages : [];
}

async function processMessages({ token, user, children, tgAccounts, lineAccounts, debug, allMessages = false }) {
  const rooms = await fetchMessageRooms(token);

  if (debug) {
    process.stderr.write(`取得 ${rooms.length} 個聊天室。\n`);
  }

  // Build member key for current logged-in parent (user_type 3)
  const memberKey = user?.id ? `${user.id}-3` : null;

  const lastMsgMap = await loadLastMsgMap();
  // Drop legacy global floor key — each room is tracked independently
  const updatedMap = { ...lastMsgMap };
  delete updatedMap._global;
  const sent = [];
  const authHeaders = buildHeaders(token);

  for (const room of rooms) {
    const roomId = room.id || room.room_id;

    // Determine from-ID: per-room local tracking takes precedence; fall back to legacy global floor
    const memberInfo = memberKey && room.members ? room.members[memberKey] : null;
    const serverLastReadId = memberInfo ? Number(memberInfo.last_read_id || 0) : 0;
    const unreadCount = memberInfo ? Number(memberInfo.unread_count || 0) : 0;
    const localRoomLastId = Number(lastMsgMap[roomId] || 0);
    // Server's last_read_id is authoritative; local cursor only used when server has no data
    const fromId = serverLastReadId > 0 ? serverLastReadId : localRoomLastId;

    if (debug) {
      process.stderr.write(
        `Room ${roomId}: memberKey=${memberKey}, serverLastReadId=${serverLastReadId}, unreadCount=${unreadCount}, fromId=${fromId}\n`,
      );
    }

    // Skip if no unread messages according to server (skip for --msg_debug)
    if (!allMessages && memberKey && unreadCount === 0) {
      continue;
    }

    // Skip if latest message is not newer than what we've already processed (skip for --msg_debug)
    const latestId = Number(room.latest_message_id || 0);
    if (!allMessages && latestId <= fromId) {
      continue;
    }

    let messages;
    try {
      messages = await fetchMessagesByRoomId(token, roomId);
    } catch (err) {
      process.stderr.write(`讀取聊天室 ${roomId} 失敗: ${err.message}\n`);
      continue;
    }

    // For --msg_debug, take first 2 messages (newest); otherwise filter to new messages
    let newMessages;
    if (allMessages) {
      // Take first 2 messages (newest), exclude messages sent by the logged-in user
      newMessages = messages
        .slice(0, 2)
        .filter((msg) => {
          if (!memberKey || !msg.user) return true;
          return `${msg.user.id}-${msg.user.user_type}` !== memberKey;
        });
    } else {
      // Filter to only new messages, exclude messages sent by the logged-in user
      newMessages = messages
        .filter((msg) => Number(msg.id || 0) > fromId)
        .filter((msg) => {
          if (!memberKey || !msg.user) return true;
          return `${msg.user.id}-${msg.user.user_type}` !== memberKey;
        });
    }

    if (debug) {
      process.stderr.write(`聊天室 ${roomId}：共 ${messages.length} 則，新訊息 ${newMessages.length} 則。\n`);
      if (allMessages && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        const lastId = Number(lastMsg.id || 0);
        const lastTime = lastMsg.create_time || "N/A";
        process.stderr.write(`  最新訊息: ID=${lastId}, 時間=${lastTime}\n`);
      }
    }

    // Derive child name from room name (e.g. "xxx-孩子全名的聊天室")
    const roomChildName =
      children.find((c) => room.name?.includes(c.name))?.name || "";

    let roomHadDeliveryFailure = false;
    for (const msg of newMessages) {
      const id = Number(msg.id || 0);
      const childName = roomChildName;
      const sender = msg.user?.name || "老師";
      const date = (msg.create_time || "").slice(0, 10);
      const header = ["私訊", childName, date].filter(Boolean).join(" — ");
      const content = String(msg.content || "").trim();

      if (!isImageContent(content) && !content) {
        continue;
      }

      if (debug) {
        process.stderr.write(`訊息 ${id} (${msg.create_time}): ${isImageContent(content) ? "圖片" : "文字"} - ${sender}\n`);
        if (isImageContent(content)) {
          process.stderr.write(`  原始內容: ${content}\n`);
          const imageUrl = buildImageUrl(content, msg.create_time);
          process.stderr.write(`  圖片網址: ${imageUrl}\n`);
        }
      }

      const lineText = `${header}\n${sender}${content ? `\n\n${content}` : ""}`;

      // TG
      let tgOk = true;
      for (const acct of tgAccounts) {
        try {
          if (isImageContent(content)) {
            const imageUrl = buildImageUrl(content, msg.create_time);
            const caption = truncateTelegramCaption(`${header}\n${sender}`);
            await sendTelegramPhotoFromUrl(acct.token, acct.chatId, imageUrl, caption, authHeaders);
          } else {
            await sendTelegramMessage(acct.token, acct.chatId, lineText);
          }
        } catch (err) {
          process.stderr.write(`Telegram 轉發訊息 ${id} 失敗: ${err.message}\n`);
          tgOk = false;
        }
      }

      // LINE（文字訊息 + 圖片）
      let lineOk = true;
      for (const acct of lineAccounts) {
        try {
          if (isImageContent(content)) {
            const imageUrl = buildImageUrl(content, msg.create_time);
            await sendLineImage(acct.accessToken, acct.userId, imageUrl, lineText);
          } else {
            await sendLineMessage(acct.accessToken, acct.userId, lineText);
          }
        } catch (err) {
          process.stderr.write(`LINE 轉發訊息 ${id} 失敗: ${err.message}\n`);
          lineOk = false;
        }
      }

      if (!tgOk || !lineOk) {
        process.stderr.write(`訊息 ${id} 傳送未完成，略過更新游標以便下次重試。\n`);
        roomHadDeliveryFailure = true;
        continue;
      }

      if (id > (updatedMap[roomId] || 0)) updatedMap[roomId] = id;
      sent.push({ id, childName, sender });
    }

    // Only mark room as read when every message in this room was delivered
    if (unreadCount > 0 && !roomHadDeliveryFailure) {
      try {
        await markRoomAsRead(token, roomId);
        if (debug) {
          process.stderr.write(`Room ${roomId}: 已標示已讀。\n`);
        }
      } catch (err) {
        process.stderr.write(`Room ${roomId}: 標示已讀失敗: ${err.message}\n`);
      }
    }
  }

  await saveLastMsgMap(updatedMap);

  return sent;
}

function sanitizePathSegment(value) {
  return String(value).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim() || "unknown";
}

function stripComments(value) {
  return String(value || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[\t ])\/\/.*$/gm, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasText(value) {
  return Boolean(String(value || "").trim());
}

function formatInlineValue(value) {
  return stripComments(value).replace(/\n+/g, " ").trim();
}

function splitTelegramMessage(text, limit = 4000) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return [];
  }

  const chunks = [];
  let current = "";
  for (const block of normalized.split("\n\n")) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (block.length <= limit) {
      current = block;
      continue;
    }
    const lines = block.split("\n");
    let partial = "";
    for (const line of lines) {
      const lineCandidate = partial ? `${partial}\n${line}` : line;
      if (lineCandidate.length <= limit) {
        partial = lineCandidate;
        continue;
      }
      if (partial) {
        chunks.push(partial);
        partial = "";
      }
      if (line.length <= limit) {
        partial = line;
        continue;
      }
      // line itself exceeds limit — split by character
      for (let i = 0; i < line.length; i += limit) {
        const slice = line.slice(i, i + limit);
        if (i + limit < line.length) {
          chunks.push(slice);
        } else {
          partial = slice;
        }
      }
    }
    current = partial;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function normalizeItem(itemId, item) {
  const values = Array.isArray(item.value)
    ? item.value
        .filter((value) => value && value !== "other")
        .map((value) => String(value).trim())
        .filter(Boolean)
    : [];
  const other = typeof item.other === "string" ? item.other.trim() : "";
  const valueText = values.join("、");
  const content = stripComments([valueText, other].filter(Boolean).join("\n"));
  const signEntries = Array.isArray(item.receipt?.sign)
    ? item.receipt.sign.map((sign) => ({
        name: sign.name || "",
        kinship: sign.kinship || "",
        time: sign.time || "",
      }))
    : [];

  return {
    id: itemId,
    category: item.category || "未分類",
    type: item.type || "",
    name: item.name || "",
    content,
    values,
    other,
    author: item.author?.name || "",
    author_time: item.author?.time || "",
    photos: Array.isArray(item.photos) ? item.photos : [],
    receipt_required: Boolean(item.receipt_required || item.receipt?.required),
    signed: signEntries.length > 0,
    signers: signEntries,
    raw: item,
  };
}

function sortContactBookItems(contactBook) {
  return Object.entries(contactBook.items || {})
    .sort(([, left], [, right]) => Number(left.sort || 0) - Number(right.sort || 0))
    .map(([itemId, item]) => normalizeItem(itemId, item));
}

function normalizeContactBook(child, targetDate, contactBook, sourceUrl, autoSigned = false) {
  const itemEntries = sortContactBookItems(contactBook);
  const signers = Object.values(contactBook.sign || {}).map((sign) => ({
    name: sign.name || "",
    kinship: sign.kinship || "",
    time: sign.time || "",
  }));

  return {
    child_name: child.name,
    baby_id: child.babyId,
    date: targetDate,
    exists: true,
    auto_signed: autoSigned,
    source_url: sourceUrl,
    school: contactBook.school || null,
    class: contactBook.class || null,
    public_time: contactBook.public_time || "",
    close_time: contactBook.close_time || "",
    checked: Boolean(contactBook.checked),
    type: contactBook.type || "",
    teacher_message: {
      author: contactBook.teacher_message?.author || "",
      time: contactBook.teacher_message?.time || "",
      batch: contactBook.teacher_message?.batch || "",
      content: stripComments(contactBook.teacher_message?.content || ""),
    },
    family_message: {
      author: contactBook.family_message?.author || "",
      content: stripComments(contactBook.family_message?.content || ""),
    },
    signed: signers.length > 0,
    signers,
    entries: itemEntries,
    raw_contact_book: contactBook,
  };
}

function buildEmptyDocument(child, targetDate, sourceUrl) {
  return {
    child_name: child.name,
    baby_id: child.babyId,
    date: targetDate,
    exists: false,
    auto_signed: false,
    source_url: sourceUrl,
    school: null,
    class: null,
    public_time: "",
    close_time: "",
    checked: false,
    type: "",
    teacher_message: {
      author: "",
      time: "",
      batch: "",
      content: "",
    },
    family_message: {
      author: "",
      content: "",
    },
    signed: false,
    signers: [],
    entries: [],
    raw_contact_book: null,
  };
}

function toMarkdown(document) {
  const lines = [`# ${document.child_name} - ${document.date} 聯絡簿`];

  if (!document.exists) {
    lines.push("當日沒有已發布的聯絡簿資料。");
    return lines.join("\n");
  }

  const schoolClassParts = [];
  if (document.school?.name) {
    schoolClassParts.push(`學校：${document.school.name}`);
  }
  if (document.class?.name) {
    schoolClassParts.push(`班級：${document.class.name}`);
  }
  if (schoolClassParts.length > 0) {
    lines.push(schoolClassParts.join("　"));
  }
  lines.push("");

  if (document.teacher_message.batch || document.teacher_message.content) {
    lines.push("## 老師的話");
    if (hasText(document.teacher_message.batch)) {
      lines.push("### 公告");
      lines.push(stripComments(document.teacher_message.batch));
      if (hasText(document.teacher_message.content)) {
        lines.push("");
      }
    }
    if (hasText(document.teacher_message.content)) {
      lines.push(document.teacher_message.content);
    }
    lines.push("");
  }

  if (hasText(document.family_message.content)) {
    lines.push("## 家長回覆");
    lines.push(document.family_message.content);
    lines.push("");
  }

  const groupedEntries = new Map();
  for (const entry of document.entries) {
    const value = entry.content || entry.values.join("、");
    const content = formatInlineValue(value);
    if (!hasText(content)) {
      continue;
    }
    const category = entry.category || "其他";
    const label = formatInlineValue(entry.name || entry.type);
    if (!hasText(label)) {
      continue;
    }
    if (!groupedEntries.has(category)) {
      groupedEntries.set(category, []);
    }
    groupedEntries.get(category).push(`- **${label}**：${content}`);
    if (entry.photos.length > 0) {
      for (const photo of entry.photos) {
        groupedEntries.get(category).push(`- ${photo}`);
      }
    }
  }

  for (const [category, items] of groupedEntries.entries()) {
    if (items.length === 0) {
      continue;
    }
    lines.push(`## ${category}`);
    lines.push(...items);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function toTelegramText(document) {
  const lines = [`${document.child_name} ${document.date} 聯絡簿`];

  if (!document.exists) {
    lines.push("今天沒有已發布的聯絡簿。");
    return lines.join("\n");
  }

  const schoolClassParts = [];
  if (document.school?.name) {
    schoolClassParts.push(document.school.name);
  }
  if (document.class?.name) {
    schoolClassParts.push(document.class.name);
  }
  if (schoolClassParts.length > 0) {
    lines.push(schoolClassParts.join(" / "));
  }

  if (document.teacher_message.batch || document.teacher_message.content) {
    lines.push("");
    lines.push("老師的話");
    if (hasText(document.teacher_message.batch)) {
      lines.push(stripComments(document.teacher_message.batch));
    }
    if (hasText(document.teacher_message.content)) {
      lines.push(stripComments(document.teacher_message.content));
    }
  }

  const groupedEntries = new Map();
  for (const entry of document.entries) {
    const value = entry.content || entry.values.join("、");
    const content = formatInlineValue(value);
    if (!hasText(content)) {
      continue;
    }
    const category = formatInlineValue(entry.category || "其他");
    const label = formatInlineValue(entry.name || entry.type);
    if (!hasText(category) || !hasText(label)) {
      continue;
    }
    if (!groupedEntries.has(category)) {
      groupedEntries.set(category, []);
    }
    groupedEntries.get(category).push(`• ${label}：${content}`);
  }

  if (hasText(document.family_message.content)) {
    groupedEntries.set("家長回覆", [`• ${formatInlineValue(document.family_message.content)}`]);
  }

  for (const [category, items] of groupedEntries.entries()) {
    if (items.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(category);
    lines.push(...items);
  }

  return lines.join("\n").trimEnd();
}

async function writeDocument(outputDir, document) {
  const childDir = path.join(outputDir, sanitizePathSegment(document.child_name));
  await fs.mkdir(childDir, { recursive: true });
  const mdPath = path.join(childDir, `${document.date}.md`);
  await fs.writeFile(mdPath, toMarkdown(document), "utf8");
  return { mdPath };
}

async function maybeWriteDocument(outputDir, document, telegramOnly) {
  if (telegramOnly) {
    return null;
  }
  return writeDocument(outputDir, document);
}

async function sendDocumentToTelegram(botToken, chatId, document, format = "full") {
  const messages = splitTelegramMessage(formatDocumentText(document, format));
  for (const message of messages) {
    await sendTelegramMessage(botToken, chatId, message);
  }
}

async function handleTelegramError(summary, botToken, chatId, childName, targetDate, telegramError) {
  const errorMessage = telegramError.message || String(telegramError);
  summary.telegram_errors.push({ child_name: childName, date: targetDate, error: errorMessage });
  try {
    await reportTelegramDeliveryError(botToken, chatId, childName, targetDate, errorMessage);
  } catch (reportError) {
    console.error(
      `Telegram delivery failed for ${childName} on ${targetDate}: ${errorMessage}; report failed: ${
        reportError.message || String(reportError)
      }`,
    );
  }
}

async function reportTelegramDeliveryError(botToken, chatId, childName, targetDate, errorMessage) {
  const text = [
    "聯絡簿 Telegram 發送失敗",
    `孩子：${childName}`,
    `日期：${targetDate}`,
    `原因：${errorMessage}`,
  ].join("\n");
  await sendTelegramMessage(botToken, chatId, text);
}

function hasPendingReceipts(contactBook) {
  return Object.values(contactBook.items || {}).some((item) => {
    if (!item.receipt?.required) {
      return false;
    }
    return !item.receipt.sign || Object.keys(item.receipt.sign).length === 0;
  });
}

async function maybeAutoSignContactBook(token, child, date, contactBook) {
  const alreadySigned = contactBook.sign && Object.keys(contactBook.sign).length > 0;
  if (alreadySigned || hasPendingReceipts(contactBook)) {
    return false;
  }

  await signContactBook(token, {
    classId: contactBook.class?.id || contactBook.class_id,
    babyId: child.babyId,
    date,
    location: "root", // API 固定接受 "root" 作為家長簽名的 location 值
  });

  return true;
}

function monthRange(dateString) {
  const start = new Date(`${dateString}T00:00:00`);
  const monthStart = new Date(start.getFullYear(), start.getMonth(), 1);
  const monthEnd = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  return {
    start: dateToString(monthStart),
    end: dateToString(monthEnd),
  };
}

function normalizeMedicineText(text) {
  return text.replace(/\r/g, "").trim();
}

function parseMedicineFile(content, fallbackDate) {
  const text = normalizeMedicineText(content);
  if (!text) {
    throw new Error("Medicine file is empty");
  }

  const result = {
    date: fallbackDate,
    reason: "",
    storeWay: "常溫",
    details: [],
  };

  const sections = text.split(/\n\s*\n/).map((section) => section.trim()).filter(Boolean);
  let currentDetail = null;

  for (const section of sections) {
    const lines = section.split("\n").map((line) => line.trim()).filter(Boolean);
    const detailMarkers = [/^時機\s*[:\uff1a]/, /^時間\s*[:\uff1a]/, /^類型\s*[:\uff1a]/];
    const markerCount = detailMarkers.filter((rx) => lines.some((line) => rx.test(line))).length;
    const looksLikeDetail = markerCount >= 2;
    if (looksLikeDetail) {
      const detail = {
        timing: "",
        timeList: [],
        type: "",
        amount: "",
        unit: "",
        part: "口服",
        remark: "",
      };
      for (const line of lines) {
        const separator = line.search(/[:\uff1a]/);
        if (separator === -1) {
          continue;
        }
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (key === "藥品") {
          continue;
        }
        if (key === "時機") {
          detail.timing = value;
        } else if (key === "時間") {
          detail.timeList = value.split(/[,\u3001]/).map((item) => item.trim()).filter(Boolean);
        } else if (key === "類型") {
          detail.type = value;
        } else if (key === "用量") {
          detail.amount = value;
        } else if (key === "單位") {
          detail.unit = value;
        } else if (key === "部位") {
          detail.part = value;
        } else if (key === "備註") {
          detail.remark = value;
        }
      }
      result.details.push(detail);
      currentDetail = detail;
      continue;
    }

    for (const line of lines) {
      const separator = line.search(/[:\uff1a]/);
      if (separator === -1) {
        continue;
      }
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key === "原因") {
        result.reason = value;
      } else if (key === "保存方式") {
        result.storeWay = value || "常溫";
      } else if (key === "備註" && currentDetail) {
        currentDetail.remark = value;
      }
    }
  }

  if (!result.reason) {
    throw new Error("Medicine file requires `原因:`");
  }
  if (!isValidDateString(result.date)) {
    throw new Error(`Medicine file has invalid date: ${result.date}`);
  }
  if (result.details.length === 0) {
    throw new Error("Medicine file requires at least one medicine detail block");
  }

  return result;
}

function buildMedicinePayload(child, user, parsed) {
  const details = {};
  for (const detail of parsed.details) {
    if (!detail.timing || !detail.type || !detail.amount || !detail.unit || detail.timeList.length === 0) {
      throw new Error("Each medicine detail requires 時機, 時間, 類型, 用量, 單位");
    }
    const times = {};
    for (const time of detail.timeList) {
      times[time] = {
        time,
      };
    }
    const detailId = String(Object.keys(details).length);
    details[detailId] = {
      timing: detail.timing,
      time_list: detail.timeList,
      times,
      type: detail.type,
      amount: detail.amount,
      unit: detail.unit,
      part: detail.part || "口服",
      remark: detail.remark || "",
    };
  }

  const currentSchools = child.raw.schools?.now || {};
  const schoolKeys = Object.keys(currentSchools);
  if (schoolKeys.length === 0) {
    throw new Error(`Could not determine current class for ${child.name}: no current schools`);
  }
  if (schoolKeys.length > 1) {
    throw new Error(`${child.name} 目前有多所學校 (${schoolKeys.join(", ")})，請確認正確班級後手動指定`);
  }
  const schoolKey = schoolKeys[0];
  const school = currentSchools[schoolKey];
  const classKeys = Object.keys(school?.classes || {});
  if (classKeys.length === 0) {
    throw new Error(`Could not determine current class for ${child.name}: no classes in school ${schoolKey}`);
  }
  if (classKeys.length > 1) {
    throw new Error(`${child.name} 在學校 ${schoolKey} 有多個班級 (${classKeys.join(", ")})，請確認正確班級後手動指定`);
  }
  const classKey = classKeys[0];
  const classId = Number(classKey);
  const classInfo = school?.classes?.[classKey];
  if (!classId || !classInfo) {
    throw new Error(`Could not determine current class for ${child.name}`);
  }

  return {
    baby_id: Number(child.babyId),
    class_id: classId,
    date: parsed.date,
    reason: parsed.reason,
    details,
    store_way: parsed.storeWay,
    sign: user.sign || "",
    doctor_orders: {},
  };
}

async function resolveMedicineFile(medicineIndex, medicineDir) {
  const fileName = MEDICINE_FILE_BY_INDEX[medicineIndex] || `孩子${medicineIndex}.txt`;
  const filePath = path.join(medicineDir, fileName);
  try {
    const stat = await fs.stat(filePath);
    if (stat.isFile()) return filePath;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return null;
}

async function processMedicineFiles({ token, user, phone, password, children, fallbackDate, debug }) {
  const summary = [];

  if (children.length === 0) {
    summary.push({ status: "error", error: "找不到對應的孩子，請確認 --med 的編號正確" });
    return summary;
  }

  await checkUserPassword(token, phone, password);

  for (const child of children) {
    try {
      const filePath = await resolveMedicineFile(child.medicineIndex, DEFAULT_MEDICINE_DIR);
      if (!filePath) {
        const expected = MEDICINE_FILE_BY_INDEX[child.medicineIndex] || `孩子${child.medicineIndex}.txt`;
        summary.push({
          child_name: child.name,
          status: "skipped",
          reason: `找不到托藥單檔案，請確認 ./medicine/${expected} 存在`,
        });
        continue;
      }

      const parsed = parseMedicineFile(await fs.readFile(filePath, "utf8"), fallbackDate);
      const payload = buildMedicinePayload(child, user, parsed);
      const range = monthRange(parsed.date);
      const existingForms = await fetchMedicineForms(token, child.babyId, range.start, range.end);
      const existingSameDay = existingForms
        .filter((form) => form.date === parsed.date)
        .sort((left, right) => Number(right.id) - Number(left.id));

      const editable = existingSameDay.find((form) => !form.checked?.status);
      let medicineForm;
      let action;
      if (editable) {
        medicineForm = await patchMedicineForm(token, {
          id: editable.id,
          date: payload.date,
          reason: payload.reason,
          details: payload.details,
          store_way: payload.store_way,
          sign: payload.sign,
          doctor_orders: payload.doctor_orders,
        });
        action = "updated";
      } else {
        medicineForm = await postMedicineForm(token, payload);
        action = "created";
      }

      summary.push({
        child_name: child.name,
        action,
        date: parsed.date,
        id: medicineForm.id,
        file: filePath,
        detail_count: Object.keys(medicineForm.details || {}).length,
      });

      if (debug) {
        console.error(`Medicine ${action} for ${child.name} on ${parsed.date}`);
      }
    } catch (err) {
      console.error(`Error processing medicine for ${child.name}: ${err.message}`);
      summary.push({ child_name: child.name, status: "error", error: err.message });
    }
  }

  return summary;
}

function filterChildrenForMedicine(children, medicineTarget) {
  if (!medicineTarget) {
    return children.map((child, i) => ({ ...child, medicineIndex: String(i + 1) }));
  }
  const index = parseInt(medicineTarget, 10) - 1;
  if (index < 0 || index >= children.length) {
    return [];
  }
  return [{ ...children[index], medicineIndex: medicineTarget }];
}

async function waitUntilTaipei1800() {
  const now = new Date();
  const taipeiDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // e.g. "2026-04-02"
  // 18:00:01 Taipei (UTC+8) = 10:00:01 UTC
  const target = new Date(`${taipeiDate}T10:00:01Z`);
  if (now >= target) {
    return;
  }
  const delay = target - now;
  const seconds = Math.round(delay / 1000);
  process.stderr.write(`等待至台北時間 18:00:01，剩餘約 ${seconds} 秒...\n`);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${getHelpText()}\n`);
    return;
  }
  if (args.wait) {
    await waitUntilTaipei1800();
  }
  const { phone, password, geminiApiKey, tgAccounts, lineAccounts } = await loadConfig();
  const dates = expandDates(args);
  const outputDir = path.resolve(args.output);

  if (args.sendTelegram && tgAccounts.length === 0 && lineAccounts.length === 0) {
    throw new Error("Expected at least one TG or LINE account in .env");
  }
  if (args.fetchMessages && tgAccounts.length === 0 && lineAccounts.length === 0) {
    throw new Error("Expected at least one TG or LINE account in .env");
  }
  if (args.autoReply && tgAccounts.length === 0) {
    throw new Error("Expected TG_BOT_TOKEN and TG_CHAT_ID in .env");
  }
  if (args.autoReply && !geminiApiKey) {
    throw new Error("Expected GEMINI_API_KEY in .env");
  }

  if (!args.telegramOnly) {
    await fs.mkdir(outputDir, { recursive: true });
  }

  const token = await login(phone, password);

  const user = await fetchUser(token);
  const children = await fetchChildren(token);

  const summary = {
    output_dir: outputDir,
    children: children.map((child) => ({ baby_id: child.babyId, name: child.name })),
    dates,
    files: [],
    auto_signs: [],
    medicine: [],
    telegram_errors: [],
  };

  for (const child of children) {
    let sourceUrl;
    let booksByDate = new Map();

    try {
      const fetched = await fetchContactBooks(token, child.babyId, dates[0], dates[dates.length - 1]);
      sourceUrl = fetched.sourceUrl;
      for (const book of fetched.payload.contact_books) {
        if (!book || typeof book.date !== "string") continue;
        booksByDate.set(book.date, book);
      }
      if (args.debug) {
        console.error(`Fetched ${fetched.payload.contact_books.length} contact_books for ${child.name}`);
      }
    } catch (err) {
      console.error(`Error fetching contact books for ${child.name}: ${err.message}`);
      summary.files.push({ child_name: child.name, baby_id: child.babyId, error: err.message });
      continue;
    }

    for (const targetDate of dates) {
      try {
        const book = booksByDate.get(targetDate);
        if (!book) {
          const document = buildEmptyDocument(child, targetDate, sourceUrl);
          const written = await maybeWriteDocument(outputDir, document, args.telegramOnly);
          if (args.sendTelegram && document.exists) {
            for (const acct of tgAccounts) {
              try {
                await sendDocumentToTelegram(acct.token, acct.chatId, document, acct.format);
              } catch (telegramError) {
                await handleTelegramError(summary, acct.token, acct.chatId, child.name, targetDate, telegramError);
              }
            }
            for (const acct of lineAccounts) {
              try {
                await sendDocumentToLine(acct.accessToken, acct.userId, document, acct.format);
              } catch (lineError) {
                process.stderr.write(`LINE 發送失敗 (${child.name} ${targetDate}): ${lineError.message}\n`);
              }
            }
          }
          summary.files.push({
            child_name: child.name,
            baby_id: child.babyId,
            date: targetDate,
            exists: false,
            markdown: written?.mdPath || null,
          });
          continue;
        }

        let autoSigned = false;
        if (args.signMissing) {
          autoSigned = await maybeAutoSignContactBook(token, child, targetDate, book);
          if (autoSigned) {
            summary.auto_signs.push({
              child_name: child.name,
              baby_id: child.babyId,
              date: targetDate,
              contact_book_id: book.id,
            });
            const refreshed = await fetchContactBooks(token, child.babyId, targetDate, targetDate);
            const refreshedBook = (refreshed.payload.contact_books || []).find((item) => item.date === targetDate);
            if (refreshedBook) {
              booksByDate.set(targetDate, refreshedBook);
            }
          }
        }

        const finalBook = booksByDate.get(targetDate);
        const document = normalizeContactBook(child, targetDate, finalBook, sourceUrl, autoSigned);
        const written = await maybeWriteDocument(outputDir, document, args.telegramOnly);
        if (args.sendTelegram && document.exists) {
          for (const acct of tgAccounts) {
            try {
              await sendDocumentToTelegram(acct.token, acct.chatId, document, acct.format);
            } catch (telegramError) {
              await handleTelegramError(summary, acct.token, acct.chatId, child.name, targetDate, telegramError);
            }
          }
          for (const acct of lineAccounts) {
            try {
              await sendDocumentToLine(acct.accessToken, acct.userId, document, acct.format);
            } catch (lineError) {
              process.stderr.write(`LINE 發送失敗 (${child.name} ${targetDate}): ${lineError.message}\n`);
            }
          }
        }
        summary.files.push({
          child_name: child.name,
          baby_id: child.babyId,
          date: targetDate,
          exists: true,
          auto_signed: autoSigned,
          markdown: written?.mdPath || null,
        });
      } catch (err) {
        console.error(`Error processing contact book for ${child.name} on ${targetDate}: ${err.message}`);
        summary.files.push({ child_name: child.name, baby_id: child.babyId, date: targetDate, error: err.message });
      }
    }
  }

  if (args.medicineTarget) {
    const medChildren = filterChildrenForMedicine(children, args.medicineTarget);
    const baseDateStr = args.date ? dates[0] : getTomorrowString();
    const baseDate = new Date(`${baseDateStr}T00:00:00`); // 用本地時間解析，避免 YYYY-MM-DD 被當 UTC 處理
    summary.medicine = [];
    for (let i = 0; i < args.medicineDuration; i++) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      const dateStr = dateToString(d);
      const result = await processMedicineFiles({
        token,
        user,
        phone,
        password,
        children: medChildren,
        fallbackDate: dateStr,
        debug: args.debug,
      });
      summary.medicine.push(...result);
    }
  }

  if (args.deleteMedicineTarget) {
    const medChildren = filterChildrenForMedicine(children, args.deleteMedicineTarget);
    const result = await processDeleteMedicine({
      token,
      phone,
      password,
      children: medChildren,
      debug: args.debug,
    });
    summary.medicine.push(...result);
  }

  if (args.fetchMessages || args.fetchMessagesAll) {
    const msgsSent = await processMessages({
      token,
      user,
      children,
      tgAccounts,
      lineAccounts,
      debug: args.debug,
      allMessages: args.fetchMessagesAll,
    });
    if (args.debug) {
      process.stderr.write(`轉發訊息 ${msgsSent.length} 則。\n`);
    }
  }

  if (args.autoReply) {
    await processAutoReply({
      token,
      children,
      date: dates[0],
      tgAccounts,
      geminiApiKey,
      debug: args.debug,
    });
  }

  const hasProblems =
    summary.files.some((item) => item.error) ||
    summary.medicine.some((item) => item.status === "skipped" || item.error) ||
    summary.telegram_errors.length > 0;

  for (const item of summary.medicine) {
    if (item.status === "skipped") {
      process.stderr.write(`警告: ${item.reason || "medicine file not found"}\n`);
    } else if (item.error) {
      process.stderr.write(`錯誤: ${item.error}\n`);
    }
  }

  process.stdout.write(`${hasProblems ? "有問題" : "成功完成"}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
