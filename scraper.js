const fs = require("node:fs/promises");
const path = require("node:path");

const API_BASE = "https://api.holdinghands.com.tw";
const WEB_ORIGIN = "https://www.holdinghands.com.tw";
const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, ".env");
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "data");
const DEFAULT_MEDICINE_DIR = path.join(ROOT, "medicine");
const KNOWN_VALUE_FLAGS = new Set(["--date", "--from", "--to", "--output", "--med"]);
const MEDICINE_FILE_ALIASES = {
  "戴于硯": ["于硯.txt"],
  "戴于喬": ["于喬.txt"],
};

function getHelpText() {
  return [
    "Usage:",
    "  node scraper.js [options]",
    "",
    "Description:",
    "  讀取聯絡簿，預設抓今天資料，並在可簽名時自動簽名。",
    "  也可用 --med 指定孩子送出托藥單,托藥單日期固定為明天。",
    "",
    "Options:",
    "  --date YYYY-MM-DD        指定單一天日期",
    "  --from YYYY-MM-DD        指定起始日期，需搭配 --to",
    "  --to YYYY-MM-DD          指定結束日期，需搭配 --from",
    "  --output PATH            聯絡簿輸出目錄，預設為 ./data",
    "  --med 1|2                送出托藥單：1=于硯，2=于喬",
    "  --notice                 抓取後發送 Telegram 通知",
    "  --tg-only                只發送 Telegram，不寫入 ./data",
    "  --no-sign-missing        不自動簽名聯絡簿",
    "  --wait                   等待至台北時間 18:00:01 再執行",
    "  --debug                  顯示額外偵錯資訊",
    "",
    "Medicine Files:",
    "  --med 1 會讀取 ./medicine/于硯.txt",
    "  --med 2 會讀取 ./medicine/于喬.txt",
    "",
    "Examples:",
    "  node scraper.js",
    "  node scraper.js --date 2026-04-01",
    "  node scraper.js --from 2026-04-01 --to 2026-04-07",
    "  node scraper.js --med 1",
    "  node scraper.js --date 2026-04-01 --med 2 --no-sign-missing",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    output: DEFAULT_OUTPUT_DIR,
    debug: false,
    medicineTarget: null,
    sendTelegram: false,
    telegramOnly: false,
    signMissing: true,
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
      continue;
    }
    if (value === "--tg-only") {
      args.sendTelegram = true;
      args.telegramOnly = true;
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
        throw new Error(`--med must be 1 (于硯) or 2 (于喬)\n\n${getHelpText()}`);
      }
      args.medicineTarget = next;
    }
    index += 1;
  }

  if (args.date && (args.from || args.to)) {
    throw new Error(`--date cannot be combined with --from/--to\n\n${getHelpText()}`);
  }
  if ((args.from && !args.to) || (!args.from && args.to)) {
    throw new Error(`--from and --to must be used together\n\n${getHelpText()}`);
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

function getTomorrowString() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return dateToString(tomorrow);
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

  return [dateToString(new Date())];
}

async function loadConfig() {
  const envText = await fs.readFile(ENV_PATH, "utf8");
  const env = parseEnv(envText);
  const phone = env.PHONE || env.USERNAME;
  const password = env.PASSWORD;
  if (!phone || !password) {
    throw new Error("Expected PHONE or USERNAME and PASSWORD in .env");
  }
  return {
    phone,
    password,
    telegramBotToken: env.TG_BOT_TOKEN || "",
    telegramChatId: env.TG_CHAT_ID || "",
  };
}

async function requestJson(url, options = {}) {
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
      }
      partial = line;
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

async function sendDocumentToTelegram(botToken, chatId, document) {
  const messages = splitTelegramMessage(toTelegramText(document));
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
    const detailMarkers = [/^時機\s*:/, /^時間\s*:/, /^類型\s*:/];
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
        const separator = line.indexOf(":");
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
      const separator = line.indexOf(":");
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
  const schoolKey = Object.keys(currentSchools)[0];
  const school = currentSchools[schoolKey];
  const classKey = Object.keys(school?.classes || {})[0];
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

async function resolveMedicineFile(child, medicineDir) {
  const aliases = MEDICINE_FILE_ALIASES[child.name] || [`${child.name}.txt`];
  for (const alias of aliases) {
    const filePath = path.join(medicineDir, alias);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        return filePath;
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return null;
}

async function processMedicineFiles({ token, user, phone, password, children, fallbackDate, debug }) {
  const summary = [];
  await checkUserPassword(token, phone, password);

  for (const child of children) {
    const filePath = await resolveMedicineFile(child, DEFAULT_MEDICINE_DIR);
    if (!filePath) {
      summary.push({
        child_name: child.name,
        status: "skipped",
        reason: "medicine file not found",
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
  }

  return summary;
}

function filterChildrenForMedicine(children, medicineTarget) {
  if (!medicineTarget) {
    return children;
  }
  const childByOption = {
    "1": "戴于硯",
    "2": "戴于喬",
  };
  const targetName = childByOption[medicineTarget];
  return children.filter((child) => child.name === targetName);
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
  const { phone, password, telegramBotToken, telegramChatId } = await loadConfig();
  const dates = expandDates(args);
  const outputDir = path.resolve(args.output);

  if (args.sendTelegram && (!telegramBotToken || !telegramChatId)) {
    throw new Error("Expected TG_BOT_TOKEN and TG_CHAT_ID in .env");
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
    try {
      const { sourceUrl, payload } = await fetchContactBooks(token, child.babyId, dates[0], dates[dates.length - 1]);
      const booksByDate = new Map();
      for (const book of payload.contact_books) {
        if (!book || typeof book.date !== "string") {
          continue;
        }
        booksByDate.set(book.date, book);
      }

      for (const targetDate of dates) {
        const book = booksByDate.get(targetDate);
        if (!book) {
          const document = buildEmptyDocument(child, targetDate, sourceUrl);
          const written = await maybeWriteDocument(outputDir, document, args.telegramOnly);
          if (args.sendTelegram) {
            try {
              await sendDocumentToTelegram(telegramBotToken, telegramChatId, document);
            } catch (telegramError) {
              await handleTelegramError(summary, telegramBotToken, telegramChatId, child.name, targetDate, telegramError);
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
        if (args.sendTelegram) {
          try {
            await sendDocumentToTelegram(telegramBotToken, telegramChatId, document);
          } catch (telegramError) {
            await handleTelegramError(summary, telegramBotToken, telegramChatId, child.name, targetDate, telegramError);
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
      }

      if (args.debug) {
        console.error(`Fetched ${payload.contact_books.length} contact_books for ${child.name}`);
      }
    } catch (err) {
      console.error(`Error processing contact books for ${child.name}: ${err.message}`);
      summary.files.push({
        child_name: child.name,
        baby_id: child.babyId,
        error: err.message,
      });
    }
  }

  if (args.medicineTarget) {
    summary.medicine = await processMedicineFiles({
      token,
      user,
      phone,
      password,
      children: filterChildrenForMedicine(children, args.medicineTarget),
      fallbackDate: getTomorrowString(),
      debug: args.debug,
    });
  }

  const hasProblems =
    summary.files.some((item) => item.error) ||
    summary.medicine.some((item) => item.status === "skipped" || item.error) ||
    summary.telegram_errors.length > 0;
  process.stdout.write(`${hasProblems ? "有問題" : "成功完成"}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
