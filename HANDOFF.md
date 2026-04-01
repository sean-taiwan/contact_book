# Handoff

## 已完成
- 建立 [scraper.js](D:\vibe_coding\contact_book_codex\scraper.js)，可登入 `holdinghands` family API。
- 聯絡簿功能已完成：
  - 預設未給日期時抓今天。
  - 可用 `--date` 或 `--from/--to` 指定日期。
  - 會輸出 JSON/Markdown 到 `data/<孩子>/<日期>.*`。
  - 預設會自動簽名聯絡簿，可用 `--no-sign-missing` 關閉。
- 托藥單功能已完成：
  - 參數改為 `--med 1|2`。
  - `1=于硯`，`2=于喬`。
  - 會讀 `medicine/于硯.txt` 或 `medicine/于喬.txt`。
  - 托藥單日期固定為明天，忽略 txt 內的 `日期:`。
  - 同日有未鎖定托藥單時會更新，否則新增。
- CLI 錯誤說明已補齊：
  - 缺參數或錯參數時，會顯示完整 usage/help。
  - 支援 `--help` / `-h`。

## 目前進度
- 主流程可實際運作，且已用真實 API 驗證過：
  - 聯絡簿讀取成功。
  - 托藥單新增成功。
  - 托藥單同日更新成功。
- 測試時建立的托藥單已刪除，正式帳號未保留測試資料。

## 未完成
- 尚未補 README。
- 尚未把 txt 格式說明直接內建成更完整文件。
- 尚未做更細的托藥單結果輸出檔案（目前只有 API 執行 summary）。

## 下一步
- 若要補文件：
  - 優先新增 `README.md`
  - 內容建議放：CLI 用法、txt 格式、常見錯誤

## 注意事項
- `.env` 內目前使用正式帳號密碼，操作都會打到真實 API。
- `--med` 會真的新增或更新托藥單，不是 dry-run。
- 聯絡簿自動簽名預設開啟；若不想簽，記得加 `--no-sign-missing`。
- 托藥單日期不是從 txt 讀，而是固定明天。