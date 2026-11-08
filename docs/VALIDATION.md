# 驗證紀錄

每個里程碑記錄實際執行的命令、結果、限制與人工測試方式。

## M0 骨架與容器（2026-11-08）

- 命令：`npm run typecheck`、`npm run lint`、`npm test`（bootstrap 測試：健康檢查、安全標頭、API 404、migration 冪等、FTS5 trigram 中文查詢）、`npm run build`（Vite 客戶端 + esbuild 伺服器單檔）皆通過。
- 本機執行 `node dist/server/index.js`：`/healthz` 200 並帶 CSP／COOP／nosniff 等標頭，`/api/version` 回版本，SPA fallback 200，`/api/*` 未知路由 JSON 404。
- Docker：`docker compose up -d --build --wait` healthy（本機以 `.env` 的 `NOTES_PORT=8081`，因 8080 被舊專案佔用）；容器內 `touch /app/x` 回 Read-only file system；程序以 uid 101 執行，`/data` 建立 `files`、`tmp`、`backups` 與 `notes.sqlite`；`docker compose restart` 後資料仍在、`/healthz` 200、migration 回報已套用為空。
- 限制：`node:sqlite` 為 experimental（以 `NODE_OPTIONS=--disable-warning=ExperimentalWarning` 抑制警告）；尚未做 HTTPS overlay 實測（M7）。

## M1 帳號（2026-11-08）

- `tests/server/auth.test.ts`：密碼雜湊往返與參數、速率限制、第一人成管理者、邀請碼單次／過期／撤銷、重複 email 409、以 email 或 username 登入、錯誤密碼與不存在帳號回同一訊息、五次失敗後 429 帶 `Retry-After`、CSRF 缺 header／錯 token／跨 Origin 403、session 30 天滑動過期、改密碼讓其他 session 失效、管理者不能停用自己或最後一位管理者、停用立即踢掉 session。
- 容器（`http://127.0.0.1:8081`）以 curl：登入 200、無 CSRF header 403、建立邀請碼、成員以邀請碼註冊 201、重用同一邀請碼 400、成員存取管理 API 403。
- 瀏覽器（Claude 內建瀏覽器）：首次開站導到「建立管理者帳號」，填表送出後進首頁；修正了註冊表單在 React 函式式更新中讀取 `currentTarget` 為 null 的錯誤。

## M2 頁面與編輯器（2026-11-08）

- `tests/server/pages.test.ts`：建立／巢狀／排序／搬移與循環拒絕、位置重編號、`If-Match` 保存與 409、快照間隔與版本還原、PATCH 不動內容版本、最愛、垃圾桶子樹／還原／永久刪除／清空、複製子樹、跨使用者 404。`tests/client/tree.test.ts`：樹索引、樂觀更新、拖曳投影。`tests/client/autosave.test.ts`：狀態機。
- 隔離 Chrome（CDP）：登入 → 新增頁面 → 打標題（側邊欄即時更新）→ 打內文 → 狀態「已儲存」→ API 回讀 version 2 → 重載內容仍在 → `/` 選單 25 項 → 插入一級標題。發現連續存檔用舊版本號造成「有衝突」，已修正 `useAutosave.ts`（版本以 ref 為準），**瀏覽器重測未完成**。

## M3 檔案（2026-11-08，部分）

- `tests/server/files.test.ts`：嗅探優先於宣告型別、PNG 去重（同 sha256 只存一份、tmp 清空）、inline 與快取標頭、304、非媒體 attachment＋`CSP: sandbox`、空檔 400、超過上限 413、跨使用者 404、刪除時只在無引用才刪 blob。封面預設／檔案／清除在 `pages.test.ts`。
- 前端圖示選擇器、封面、上傳尚未在瀏覽器驗證。
