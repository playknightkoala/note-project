# 驗證紀錄

每個里程碑記錄實際執行的命令、結果、限制與人工測試方式。

最新結果（2026-11-08）：M2／M3 三項待驗證、M4 搜尋與 M5 資料庫已完成。最終 `npm run check` 全通過（76 tests／12 個測試檔），Docker healthy、`/healthz` 200。以下保留各次紀錄，末段為 M5。

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

## M5 資料庫表格視圖（2026-11-08）

- 開始 M5 前已依使用者要求提交並推送 M2–M4：`git commit -m "完成 M2/M3 驗收修正與 M4 全文搜尋"` → `a2e5d27`，`git push origin main` 成功。M5 修改另留工作區，未混入此前 checkpoint。
- `tests/server/databases.test.ts`（14 項）：預設視圖、七種屬性往返、名稱／值更新、獨立結構／屬性／區塊版本、If-Match 缺失 428／過期 409、交易失敗不留下部分資料、錯誤型別、無效日期／不安全網址／未知選項拒絕、typed sorting／AND filters／分頁、視圖保存、被使用型別與選項保護、刪欄位清理視圖、跨使用者 404／未登入 401／CSRF 403、列與資料庫垃圾桶還原／級聯刪除，以及包含垃圾桶的 5,000 列上限。
- `tests/client/database.test.tsx`（7 項）：編輯器開啟時固定基準版本，背景刷新不採新版本號；409 保留草稿、明確捨棄才重載；巢狀選項不關掉編輯器；未完成數字不會 NaN → null 清空儲存格；網址參數往返與無效欄位；選項依標籤排序且空值最後；多選 membership 與日期比較組合。既有 migration 測試包含 `0004_database_versions` 並驗證重跑無變動。
- 瀏覽器從側欄建立資料庫，新增數字欄位與單選選項（藍色「進行中」）；建立「實作 API」列，保存 12.5。其餘合成欄位由容器 API 補上後，透過列頁面的介面分別編輯文字、多選（前端＋重要）、日期（繁體日曆 2026-11-20）、核取方塊與 http(s) 網址，重載確認七種值都在。
- 列頁面：麵包屑、返回資料庫與開啟為頁面正常；BlockNote 輸入列內文，自動保存並重載仍在。容器回讀區塊 version 2、屬性 version 9，兩者獨立。
- 排序／篩選：數字遞增時「撰寫文件」（2）在「實作 API」（12.5）前；設定時數 > 10 後只剩後者。儲存視圖並清除網址 override，重載仍保留。欄標頭「依此欄篩選」能預填對應欄位；改名「預估工時」→「預估時數」後值 12.5 與已儲存條件仍在。
- 顯示／鍵盤：隱藏五個欄位並儲存，重載只顯示名稱／時數／狀態；欄寬用方向鍵從 180 調到 190，重載仍是 190。儲存格 ArrowRight 正確移到下一欄，Alt+Enter 開啟列頁面。
- 220 列虛擬捲動：初始 aria-rowcount=221（含標頭）、DOM 22 個資料列；捲到底能依序載入 100＋100＋20 筆，最後看得到第 220 列，而 DOM 仍約 22 列。效能合成資料庫驗完已移入垃圾桶，主驗收資料庫保留。
- 雙分頁：B 先打開摘要並寫草稿，A 保存不同內容；B 儲存得到衝突訊息，原草稿仍在。按「重新載入並捨棄草稿」才換成 A 的版本。截圖保存在 `.local/validation/m5-conflict.png`。
- 實測修正：Select／MultiSelect 預設 Portal 使外層 Popover 判定為點擊外部，導致選取時編輯器關閉；改 withinPortal:false 並補測。日期亦採同樣設定。數字草稿中間態保留為字串，提交前驗證有限數字，避免 NaN JSON 化變 null。多選開著時選項可能蓋住保存按鈕，驗收用 Tab 收起選項後保存。
- 最終容器 API 冒煙：`/healthz` 200；七種屬性／7 個已保存值、2 列；外人讀資料庫與列各 404；舊列版本寫入 409、舊視圖版本 409、缺 CSRF 403；220 列的 offset=200 回 20 列。未輸出帳密或 session。
- 最終 `npm run check` 成功：typecheck、lint、76 tests／12 files、build。`docker compose up -d --build --wait` 成功、容器 healthy。沒有更動依賴版本；仍有已知 SQLite experimental 與 Vite bundle >500 kB 提示。
- 中途測試環境錯誤：Testing Library 的 ByRoleOptions 不支援 `exact`，已改正；jsdom 沒有 ResizeObserver，以測試用替身補足後通過。這些失敗均已在最終完整檢查中重跑。
- 最後數字防護重測發現，NumberInput 在真實瀏覽器失焦時仍會把不完整值清成空白，原先未模擬失焦的測試不足。已改成 TextInput＋decimal inputMode、保存前驗證數字，並讓測試包含 blur。容器重建後，實測輸入 `-`、點儲存得到錯誤且草稿仍是 `-`；取消、重載後原值仍是 12.5。受影響的合成驗收數值已還原，最終屬性版為 11，區塊版仍為 2。此修正後再次完整 `npm run check`（76 tests）及容器驗證成功。
- 限制：只有一個預設表格視圖；多視圖、OR、公式／關聯與刪除屬性回收不在 M5。真實中文輸入法、觸控裝置與完整手機表格體驗仍留 M7，未宣稱通過。驗收截圖／合成資料皆在 gitignored 的 `.local/validation/`。

## M7 收尾（2026-11-08）

決定：M6 Joplin 匯入取消，不再列入範圍。

- **帳號稽核修正**（接手文件列出的三項）：改密碼時目前密碼錯誤改回 400（原 401 會被客戶端當成登入失效而登出）；速率限制器改為每個 key 記住自己的時間窗，sweep 不再用其他 key 的短時間窗清掉長時間窗的紀錄（新增測試）；session cookie 的 `Max-Age` 改為 90 天絕對上限，以資料庫的 30 天滑動過期為準，瀏覽器不會先於伺服器丟掉 cookie。
- **頁面歷史 UI**（`HistoryDrawer.tsx`）：頁面選單「頁面歷史」開啟右側抽屜，列出快照（版本、原因、時間、大小），選取後顯示純文字預覽，「還原此版本」走原本的 `If-Match` 還原 API，成功後以遠端重載流程替換編輯器內容。瀏覽器實測：還原到版本 1（空白頁）→ 版本清單出現 `[4, restore]`（被覆蓋的內容先存成快照）→ 再從該快照還原回「這是第一段文字。」，狀態皆為「已儲存」。
- **快捷鍵與版面**：`Ctrl/⌘ + \` 收合或展開側邊欄（桌面記在 localStorage，收合時上方列出現漢堡鈕）、`Ctrl/⌘ + Alt + N` 新增頁面（瀏覽器保留 Ctrl+N，不能攔截）、頁面選單「小字體」（本機偏好，編輯器 16px → 14px、標題 32px）。瀏覽器實測三者。
- **手機版**（CDP 模擬 390×844、觸控）：上方列 sticky、側邊欄預設隱藏並以漢堡鈕開啟為抽屜、點選頁面後抽屜關閉並顯示編輯器、內文邊距 16px、標題 30px、搜尋面板可開啟。截圖留在本機 scratch，未提交。未以實體手機與行動鍵盤驗收。
- **CSP／主控台稽核**：以 CDP `Log` 走首頁、頁面、頁面歷史、搜尋、設定、垃圾桶與手機版流程，沒有任何 CSP 違規、例外或錯誤訊息。
- **靜態檢查** `npm run test:app -- <origin>`（`scripts/check-app.mjs`，25 項）：health、CSP／COOP／nosniff／Referrer、無 inline script、SPA fallback 與 no-cache、未登入 API 401、跨來源 POST 拒絕、錯誤登入 401 且不設 cookie、API `no-store`、`.env`／原始碼／資料庫路徑不外露、靜態路徑拒絕 POST。對 `http://127.0.0.1:8081` 與 HTTPS overlay 皆 PASS。
- **HTTPS overlay 冒煙**：以自簽憑證（只存在本機 scratch）執行 `docker compose -f compose.yaml -f compose.https.yaml up -d --wait`（`NOTES_HTTPS_PORT=8444`）：`https` 容器 healthy；`/healthz`、`/`、`/api/auth/status` 200、`/api/pages/tree` 401；回應帶 HSTS；app 的 `TRUST_PROXY=1`；成功登入的 cookie 帶 `Secure; HttpOnly; SameSite=Lax; Max-Age=7776000`。驗完已移除 overlay 容器並以基本 compose 重建 app（`TRUST_PROXY=0`）。尚未以可信憑證做真實網域部署。
- **備份**：`cli backup` 使用 `node:sqlite` 線上備份並保留 7 份；還原與 Cloudflare 部署步驟寫在 [DEPLOY.md](DEPLOY.md)。本輪未實際演練整個還原流程。
- 檢查：`npm run check` 全過（typecheck、lint、12 檔／77 tests、build）；容器重建 healthy。
- 未做：Playwright 端到端套件（改以 `test:app` 靜態檢查＋CDP 冒煙腳本，腳本在 scratch 未納入專案）、真實手機與輸入法、附件 Range 請求、未引用 blob 回收。
