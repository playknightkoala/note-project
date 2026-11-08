# Notes

Notion 式的筆記網站：自有帳號（邀請碼註冊，第一位註冊者為管理者）、BlockNote 區塊編輯器、頁面樹、資料庫表格視圖、全文搜尋、頁面歷史。單一 Docker 容器 + SQLite，資料與附件放在同一個 volume。

文件：[部署指南](docs/DEPLOY.md)、[架構與里程碑](docs/ARCHITECTURE.md)、[驗證紀錄](docs/VALIDATION.md)、[交接紀錄](docs/HANDOFF.md)、[開發指引](AGENTS.md)。

## 啟動

```powershell
docker compose up -d --build --wait
```

開啟 `http://127.0.0.1:8080/`（埠由 `.env` 的 `NOTES_PORT` 決定，只綁 loopback）。第一次開啟時建立管理者帳號；之後的使用者需要管理者在「設定 → 邀請碼」產生的邀請連結。資料在 named volume `notes_notes-data`。

要架到網際網路、備份與還原、放在 Cloudflare 後面：見 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 功能

- **帳號**：邀請碼註冊、登入鎖定、CSRF 防護（反向代理或 tunnel 後面請設 `NOTES_PUBLIC_ORIGIN`，見部署指南）、管理者可停用使用者與撤銷邀請碼。
- **頁面**：巢狀頁面樹（拖曳搬移）、最愛、垃圾桶（還原／永久刪除）、麵包屑、複製頁面、emoji 圖示、封面（漸層或上傳圖片，可調整位置）、全寬與小字體。
- **編輯器**：BlockNote 完整區塊（標題、清單、待辦、可摺疊、引用、程式碼、分隔線、表格、圖片、影片、音訊、檔案），`/` 區塊選單、`@` 提及頁面、`:` 表情符號，貼上或拖入檔案自動上傳；繁體中文介面與輸入法防護。
- **保存**：自動保存，以版本號防止兩個分頁互相覆蓋；衝突時可載入最新版本或以自己的內容覆蓋（被覆蓋的版本留在頁面歷史）；頁面歷史可預覽與還原。
- **搜尋**：`Ctrl+K`（macOS `⌘K`）搜尋標題與內文，支援中英文與兩字查詢，含最近開啟與快速動作。
- **資料庫**：表格視圖，文字、數字、單選、多選、日期、核取方塊、網址七種屬性，排序、AND 篩選、隱藏欄位、欄寬，資料列可開成完整頁面。每個資料庫最多 5,000 列。
- **快捷鍵**：`Ctrl+K` 搜尋、`Ctrl+\` 收合側邊欄、`Ctrl+Alt+N` 新增頁面（macOS 用 `⌘`）。
- **右鍵選單**：頁面、側邊欄項目、資料庫欄位與資料列都有右鍵選單（鍵盤 `Shift+F10` 或選單鍵）；編輯器、輸入框與連結保留瀏覽器原生選單。
- **登入**：可勾選「記住帳號」，只記住帳號名稱，不存密碼。

不做的事：Joplin 匯入（已取消）、即時多人協作、多視圖／公式／關聯欄位。

## 開發

需要 Node 22 與 npm 10。

```bash
npm install
```

```bash
npm run dev
```

同時啟動 API（`http://127.0.0.1:8080`，資料寫在 `./data`）與 Vite 開發伺服器（`http://127.0.0.1:5173`，`/api` 代理到 API）。

```bash
npm run check
```

依序執行 typecheck、lint、test、build。容器啟動後可再跑 `npm run test:app -- http://127.0.0.1:8080` 做靜態安全檢查。

## 結構

- `src/shared`：zod schema、型別與純函式（前後端共用）。
- `src/server`：Hono API、SQLite（`node:sqlite`）、認證、檔案、搜尋、資料庫；以 esbuild 打包成 `dist/server`。
- `src/client`：Vite + React + BlockNote + Mantine 的 SPA，建置到 `dist/client`。
- `tests`：vitest；`scripts/check-app.mjs`：對運行中容器的靜態檢查。
