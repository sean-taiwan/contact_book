# kids_care scraper

自動抓取 [牽牽手](https://www.holdinghands.com.tw) 托嬰聯絡簿，支援自動簽名、托藥單、Telegram／LINE 推播與 AI 回覆建議。

## 需求

- Node.js 20+
- 牽牽手家長帳號

---

## 安裝

```bash
git clone https://github.com/sean-taiwan/contact_book.git
cd contact_book
# 無需安裝任何 npm 套件，scraper.js 僅使用 Node.js 內建模組
```

---

## 設定 `.env`

在專案根目錄建立 `.env` 檔案：

```env
# 必填：牽牽手登入帳號
PHONE=0912345678
PASSWORD=your_password

# 選填：Telegram 推播（--notice / --msg / --auto_reply 需要）
TG_BOT_TOKEN=123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TG_CHAT_ID=987654321

# 選填：Gemini AI 回覆建議（--auto_reply 需要）
GEMINI_API_KEY=AIzaSy...

# 選填：LINE 推播（有設定才會發送）
LINE_ACCESS_TOKEN=xxxxxx...
LINE_USER_ID=Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 使用方式

### 基本指令

```bash
# 抓取今日聯絡簿，自動簽名，存至 ./Daily
node scraper.js

# 指定日期
node scraper.js --date 2026-04-01

# 指定日期區間
node scraper.js --from 2026-04-01 --to 2026-04-07

# 只推播 Telegram／LINE，不寫檔案
node scraper.js --notice

# 推播 + 等到台北時間 18:00 再執行 + AI 回覆建議
node scraper.js --notice --wait --auto_reply
```

### 私訊轉發

```bash
# 轉發老師未讀私訊到 Telegram
node scraper.js --msg
```

### 托藥單

```bash
# 送出孩子1的托藥單（讀取 ./medicine/孩子1.txt）
node scraper.js --med 1

# 送出孩子2的托藥單，從明天起連續 3 天
node scraper.js --med 2 --duration 3

# 刪除孩子1所有待處理托藥單
node scraper.js --del_med 1
```

### 全部選項

| 選項 | 說明 |
|---|---|
| `--date YYYY-MM-DD` | 指定單一日期 |
| `--from` / `--to` | 指定日期區間（需同時使用） |
| `--output PATH` | 聯絡簿輸出目錄（預設 `./Daily`） |
| `--notice` | 推播 Telegram／LINE，不寫檔案 |
| `--msg` | 轉發老師未讀私訊到 Telegram |
| `--msg_debug` | [偵錯] 轉發所有聊天室最新兩條訊息到 Telegram（不論已讀） |
| `--auto_reply` | 用 Gemini 擬三段聯絡簿回覆，推播到 Telegram |
| `--med 1\|2` | 送出托藥單（1=孩子1，2=孩子2） |
| `--duration N` | 搭配 `--med`，連續送出 N 天（預設 1） |
| `--del_med 1\|2` | 刪除指定孩子所有待處理托藥單 |
| `--no-sign-missing` | 停用自動簽名 |
| `--wait` | 等到台北時間 18:00:01 再執行 |
| `--debug` | 顯示額外偵錯資訊 |

---

## 取得 Telegram Bot Token 與 Chat ID

### 1. 建立 Bot，取得 Token

1. 在 Telegram 搜尋 **[@BotFather](https://t.me/BotFather)** 並開啟對話
2. 傳送 `/newbot`
3. 依提示輸入 Bot 名稱與帳號（帳號須以 `bot` 結尾，例如 `my_kids_bot`）
4. BotFather 回傳的 token 格式如下，複製備用：
   ```
   123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

### 2. 取得 Chat ID

1. 在 Telegram 搜尋你剛建立的 Bot 並傳一則任意訊息（例如 `/start`）
2. 開啟瀏覽器，造訪以下網址（將 `<TOKEN>` 替換成你的 token）：
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. 在回傳的 JSON 中找到 `"chat"` → `"id"` 的數字，即為 `TG_CHAT_ID`：
   ```json
   "chat": { "id": 987654321, ... }
   ```

---

## 取得 LINE Token 與 User ID

### 1. 建立 LINE Messaging API Channel，取得 Access Token

1. 登入 [LINE Developers Console](https://developers.line.biz/console/)
2. 建立或選擇一個 Provider，點擊 **Create a new channel** → 選 **Messaging API**
3. 填寫必要欄位後建立 Channel
4. 進入 Channel 設定頁，切換到 **Messaging API** 分頁
5. 滑到底部 **Channel access token**，點擊 **Issue** 產生 token，複製備用

### 2. 取得 LINE User ID

1. 在同一個 Channel 設定頁的 **Basic settings** 分頁
2. 滑到 **Your user ID** 欄位（格式為 `Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`），複製備用
3. 用 LINE 掃描頁面上的 QR Code，將自己的帳號加入該 Bot 為好友

> LINE 推播使用 Push Message API，需確認帳號已加 Bot 為好友，否則發送會失敗。

---

## 取得 Google Gemini API Key

`--auto_reply` 功能使用 Gemini API 擬回覆建議，需要 Google API Key。

1. 前往 [Google AI Studio](https://aistudio.google.com/apikey)
2. 登入 Google 帳號後，點擊 **Create API key**
3. 選擇或建立一個 Google Cloud 專案
4. 複製產生的 API Key（格式為 `AIzaSy...`），填入 `.env` 的 `GEMINI_API_KEY`

> 免費額度通常足夠個人使用；若超量可在 [Google Cloud Console](https://console.cloud.google.com/) 設定用量上限。

---

## GitHub Actions 自動排程

`.github/workflows/scraper.yml` 已設定兩個排程：

| 排程 | 執行內容 |
|---|---|
| 每小時 :42（台北時間 08:42–18:42） | `--msg`：轉發老師未讀私訊 |
| 每天台北時間 16:42 | `--notice --wait --auto_reply`：推播聯絡簿 + AI 回覆建議 |

將以下 Secrets 設定在 GitHub Repo → **Settings → Secrets and variables → Actions**：

| Secret 名稱 | 說明 |
|---|---|
| `PHONE` | 牽牽手登入手機號碼 |
| `PASSWORD` | 牽牽手登入密碼 |
| `TG_BOT_TOKEN` | Telegram Bot Token |
| `TG_CHAT_ID` | Telegram Chat ID |
| `GEMINI_API_KEY` | Google Gemini API Key |
| `LINE_ACCESS_TOKEN` | LINE Channel Access Token（選填） |
| `LINE_USER_ID` | LINE User ID（選填） |
