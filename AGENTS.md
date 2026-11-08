# 開發指引 — Notes（Notion 式筆記網站）

## 專案目標

以 Docker 啟動的獨立筆記網站：自有帳號系統（邀請碼註冊、第一位註冊者為管理者）、BlockNote 區塊編輯器、頁面樹、資料庫表格視圖、全文搜尋、頁面歷史。單一容器 + SQLite，資料與附件放同一個 volume。不依賴 Joplin；原規劃的 Joplin 匯入已於 2026-11-08 取消，不要重新加入。

## 正式資料

- `pages.content` 的 BlockNote 區塊 JSON 是正式內容，Markdown 只在匯入／匯出時出現。
- 每次寫入以 `version` 做樂觀並行控制（`If-Match`），不靜默覆寫；舊內容在 `page_versions` 留快照。
- 附件 content-addressed（sha256）存於 `DATA_DIR/files`；資料庫以 `node:sqlite`（WAL），經 `src/server/db/driver.ts` 存取。

## 必須遵守

1. **安全優先**：所有查詢帶 `user_id`，他人資料回 404；寫入請求必須通過 CSRF（`X-CSRF-Token` + 同源 `Origin`）；cookie `HttpOnly; SameSite=Lax`，HTTPS 下 `Secure`；密碼只存 scrypt 雜湊；上傳檔案以 magic bytes 與允許清單判定 MIME，非圖片以 attachment 提供。
2. **不洩漏秘密**：帳密、session、邀請碼、`.env`、`data/` 不進版本控制、映像或文件；測試用隨機合成值。
3. **可驗證**：修改後執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run build`；涉及容器時 `docker compose up --build --wait` 並打 `/healthz`。記錄命令與結果，不假稱不存在的檢查。
4. **固定版本**：所有依賴 exact 版本；BlockNote 0.57 為 pre-1.0，升級前先核對型別與實測。
5. **可回退**：資料庫 migration 只前進且冪等；備份以 `cli backup`（線上 backup）為準，不直接複製使用中的 sqlite 檔。
6. **語言**：文件、UI 文字、驗收報告用繁體中文；程式識別符用英文。
7. **範圍**：按里程碑完整交付（見 docs/ARCHITECTURE.md 的里程碑表），不逐項等待確認；超出里程碑的需求先記錄再討論。

## 專案結構

- `src/shared`：zod schema、型別、純函式（前後端共用，不得引用 Node 或 DOM API）。
- `src/server`：Hono API、SQLite、認證、檔案、搜尋、資料庫。
- `src/client`：Vite + React + BlockNote + Mantine 的 SPA。
- `tests`：vitest（伺服器以 `app.request()` 對 `:memory:` 資料庫；客戶端 jsdom）。
- `docker/`、`Dockerfile`、`compose*.yaml`：容器與 HTTPS overlay。
