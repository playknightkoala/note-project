# Notes

Notion 式的筆記網站：自有帳號（邀請碼註冊，第一位註冊者為管理者）、BlockNote 區塊編輯器、頁面樹、資料庫表格視圖、全文搜尋、Joplin 匯入。單一 Docker 容器 + SQLite，資料與附件放在同一個 volume。

> 開發中：M0–M4 已完成主要驗證，下一步是 M5 資料庫表格視圖。接手請先讀 [docs/HANDOFF.md](docs/HANDOFF.md)；里程碑與驗證限制見 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 與 [docs/VALIDATION.md](docs/VALIDATION.md)。

## Docker 啟動

```powershell
docker compose up -d --build --wait
```

開啟 `http://127.0.0.1:8080/`。第一次開啟時建立管理者帳號；之後的使用者需要管理者在設定頁產生的邀請碼。資料在 named volume `notes_notes-data`。

要架在網路上：準備真實主機名的可信憑證，在 `.env` 設定 `NOTES_TLS_CERT_FILE`／`NOTES_TLS_KEY_FILE`，執行

```powershell
docker compose -f compose.yaml -f compose.https.yaml up -d --build --wait
```

預設綁 `127.0.0.1:8443`，以 `NOTES_HTTPS_BIND`／`NOTES_HTTPS_PORT` 調整。設定項目見 [.env.example](.env.example)。

## 開發

需要 Node 22 與 npm 10。

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` 同時啟動 API（`http://127.0.0.1:8080`，資料寫在 `./data`）與 Vite 開發伺服器（`http://127.0.0.1:5173`，`/api` 代理到 API）。

```bash
npm run check
```

依序執行 typecheck、lint、test、build。

## 已可使用

帳號與邀請碼、頁面樹、BlockNote 編輯與自動保存、雙分頁衝突處理、圖示／封面、圖片與附件、頁面提及、最愛與垃圾桶。按 `Ctrl+K`（macOS 為 `⌘K`）或側邊欄「搜尋」，可查標題與內文；支援中英文、單字／兩字查詢、麵包屑與高亮。搜尋面板也有最近開啟與新增頁面／設定／垃圾桶動作。

資料庫表格視圖與 Joplin 匯入尚未完成；頁面歷史 UI、完整手機與 HTTPS 驗收留在 M7。

## 結構

- `src/shared`：zod schema、型別與純函式（前後端共用）。
- `src/server`：Hono API、SQLite（`node:sqlite`）、認證、檔案、搜尋、匯入；以 esbuild 打包成 `dist/server`。
- `src/client`：Vite + React + BlockNote + Mantine 的 SPA，建置到 `dist/client`。
- `tests`：vitest。
