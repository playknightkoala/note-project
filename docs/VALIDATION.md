# 驗證紀錄

每個里程碑記錄實際執行的命令、結果、限制與人工測試方式。

最新結果（2026-11-08 接續驗收）：M2／M3 三項待驗證已完成；M4 搜尋完成。最終 `npm run check` 全通過（55 tests／10 個測試檔），Docker healthy、`/healthz` 200。以下保留初次紀錄，後段補充本次修正與限制。

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

## M2／M3 接續驗收與修正（2026-11-08）

- 容器：反覆以 `docker compose up -d --build --wait` 重建修正版本，最終 healthy；`(Invoke-WebRequest -Uri http://127.0.0.1:8081/healthz).StatusCode` 回 200。沿用現有 volume，未複製使用中的 SQLite 檔。
- 使用內建瀏覽器與 `.local/dev-accounts.json` 內的合成開發帳號登入。新增合成驗收頁，沒有修改原本筆記內容。
- 連續自動保存：輸入一般段落 → Enter → `/` 選「引用」 → 輸入 → 下一段再輸入；各次停在「已儲存」，重載後三段都在。最終版本又重跑兩次連續輸入及衝突載入。`autosaveHook.test.ts` 直接驗證後續寫入的 If-Match 是上一個回應版本。
- 雙分頁：兩頁先載入同一版本，A 保存後 B 編輯，B 出現「有衝突」。分別實測「載入最新版本」與「以我的內容覆蓋」，重載回讀符合選擇。原本遠端 replaceBlocks 會誤標 dirty，已修正；等待遠端 GET 時不提前更新 If-Match，若期間再輸入，就保留本地草稿。遠端載入錯誤有提示。
- 明確覆蓋現在帶 `overwrite: true`，仍受 If-Match 保護。新增 API 回歸測試：過期覆蓋回 409、成功覆蓋即使仍在十分鐘快照間隔內也留歷史。容器實測在 version 20 回讀到 version 19、reason `overwrite` 的快照，內含「覆蓋前保留快照」。
- 圖示：原本 frimousse 預設連外部 CDN，載入失敗。改用固定版 BlockNote 隨附 `zh-hant` 資料後，表情符號網格、選取與重載均成功，無須放寬 CSP。
- 封面：新增漸層、上傳合成 PNG。發現調整位置的父層 pointer capture 會攔住儲存按鈕；修正後實測背景位置 50% → 22%，按儲存後重載，DOM 樣式與 API 的 coverPosition 都是 22。上傳失敗現在會顯示錯誤。
- 編輯器圖片：以剪貼簿 `image/png` 貼上 160×120 合成圖片，自動上傳；保存、重載後圖片 complete=true、naturalWidth=160，src 為本站 `/api/files/.../clipboard.png`。
- 附件：透過檔案區塊上傳合成 PDF，保存後重載仍顯示。原本 PDF 被 inline 提供，已修正為只有 PNG／JPEG／GIF／WebP inline；PDF、音訊、影片等非圖片回 attachment＋`CSP: sandbox`。新增 PDF／WAV／MP4 測試；容器 PDF GET 回 200、attachment＋sandbox，回應位元組與原檔一致。
- 頁面提及：輸入 `@`、選取頁面、保存與重載後連結仍在，點擊可導覽到目標頁。
- 限制：瀏覽器的「下載檔案」按鈕確實開啟檔案 URL；BlockNote 使用 window.open，新分頁的下載未由內建瀏覽器回報為原分頁 download event。已驗證 HTTP 提供與檔案內容，尚未觀測 OS 的最終存檔。真實中文輸入法與完整手機／觸控驗收留 M7；本次只做小視口側欄、建頁與搜尋的基本操作。
- 驗收圖與合成檔放 `.local/validation/`（gitignored），不提交帳密或附件。

## M4 搜尋（2026-11-08）

- `tests/server/search.test.ts`：中英文標題／內文子字串、大小寫、單字／兩字、麵包屑、長內文片段、空查詢、SQL 萬用字元與 FTS 引號／運算子採字面查詢、未登入 401、其他使用者資料排除、垃圾桶排除、改名／還原／永久刪除即時反映、標題權重、總筆數／limit／offset 與參數範圍。
- 既有索引 migration：先只套用 `0001_init`、`0002_cover_preset` 並寫入筆記，再套用 `0003_search_content`。確認筆記仍在、以正確 external-content 欄名讀得到內文，重跑 migration 回空陣列。正式容器升級後，原有驗收頁可立即搜尋，未修改正式 BlockNote JSON。
- `tests/client/search.test.tsx`：方向鍵＋Enter 執行動作、200ms debounce、輸入改變立即隱藏舊結果、IME 組字期間不搜尋／不送出、HTML 以文字呈現、含 regex 符號的關鍵字照字面高亮。
- 內建瀏覽器：Ctrl+K 打開面板，空查詢顯示最近開啟與常用動作；「引用」兩字查詢命中內文，高亮正確；`ATTACHMENT` 命中附件名稱（英文不分大小寫）；無命中顯示「沒有符合的頁面。」；從另一頁搜尋後 Enter 導覽到結果頁，Esc 關閉；小視口先打開側欄再按「搜尋」也能開啟面板。
- 最終容器 API 冒煙：以隨機標題建合成頁，本人搜尋 200／1 筆、另一合成帳號 0 筆、移入垃圾桶後 0 筆、還原後 1 筆；測試頁最後移回垃圾桶。持續開啟雙分頁驗證後，驗收頁維持 version 22，沒有因遠端回填繼續增版。
- 面板每頁 20 筆，有上一頁／下一頁；API 每次最多 50 筆。片段以純文字回傳、React text node 與 mark 呈現，不使用 innerHTML。搜尋 query key 包含 user id，最近開啟只保存按帳號區分的 ID，顯示時再對照自己的活動頁面樹。

## 本次最終命令與限制（2026-11-08）

- `npm run check` 最終成功，依序實際執行 `npm run typecheck`、`npm run lint`、`npm test`（55 tests，10 個檔案）、`npm run build`（Vite 客戶端＋esbuild 伺服器）。
- `docker compose up -d --build --wait` 最終成功，容器 healthy；`/healthz` 200。
- 初次沙箱內 Docker named pipe 回 permission denied；Vitest 在 Vite 載入設定時遭 `spawn EPERM`。使用執行權限提升重跑同一專案命令後成功。中途新增客戶端測試的 mock 型別曾使 typecheck 回 TS2352，已修正並通過最終完整檢查。
- 仍有既有 `node:sqlite` experimental 提示與 Vite 主 bundle 大於 500 kB 警告；不影響本次成功結果。沒有新增／升級依賴。未執行不存在的 `npm run test:app`。
- 本次未重新做 HTTPS overlay、真實手機鍵盤或 OS 下載落地測試；未把它們記為通過。
- 驗收結束已關閉本次建立的測試與檔案下載分頁，容器維持運行；最後搜尋畫面保存在 `.local/validation/m4-search.png`。
