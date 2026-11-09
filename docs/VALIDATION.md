# 驗證紀錄

每個里程碑記錄實際執行的命令、結果、限制與人工測試方式。

最新結果（2026-11-08）：M0–M5／M7 與後續追加功能完成；文字選取面板、留言與表情反應已驗證。最終 `npm run check` 全通過（97 tests／17 個測試檔），Docker healthy、`/healthz` 200，`test:app` 25 項 PASS。以下保留各次實際紀錄，最新內容在末段。

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

## 右鍵選單、反向代理 CSRF、登出與記住帳號（2026-11-08 稍後）

- **右鍵選單**（`src/client/features/shell/ContextMenu.tsx`、`PageMenuItems.tsx`）：頁面本體、側邊欄頁面、資料庫欄位標頭、資料列四種表面；桌面指標才啟用，輸入框、文字區、連結、`contenteditable`、BlockNote 編輯器、對話框與 Shift+右鍵保留瀏覽器原生選單；`Shift+F10` 與選單鍵以鍵盤開啟；捲動、縮放或 Esc 關閉；巢狀表面只開最近的一層。`tests/client/contextMenu.test.tsx` 覆蓋以上行為。隔離 Chrome（CDP）實測：頁面選單 8 項、側欄選單 6 項、欄位選單（標題欄 3 項）、資料列選單 3 項，各自 Esc 可關；在編輯器內右鍵沒有自訂選單；側欄項目 `Shift+F10` 開啟；從選單「加入最愛」後側欄出現「最愛」區塊。
- **反向代理下的 CSRF 403**（使用者回報 `https://notebook.yshongcode.com` 產生邀請碼 403 `csrf`）：原本比對完整 origin，代理或 tunnel 未轉送 `X-Forwarded-Proto` 時 `https` 對 `http` 不符而全部寫入被拒，登出也因此失敗並跳回原頁。改為只比對主機名（`Origin` 的 host 等於請求的 `Host`，`NOTES_TRUST_PROXY=1` 時改看 `X-Forwarded-Host`），或等於新設定 `NOTES_PUBLIC_ORIGIN`；不同主機仍 403，`Origin: null` 403。`compose.yaml` 新增 `PUBLIC_ORIGIN`。測試：同主機不同 scheme 201、不同主機與不同埠 403、`PUBLIC_ORIGIN` 與 `X-Forwarded-Host` 情境、代理下 cookie 帶 `Secure`。容器 curl：`Origin https://127.0.0.1:8081` 對 http 站 201，`https://evil.example` 與 `https://127.0.0.1:9999` 403，登出 204。
- **登出回跳**：根因同上（登出 403 後客戶端仍導向 `/login`，而 session 仍有效，登入頁又導回）。客戶端改為只在伺服器確認登出後清除本機狀態並導向；失敗時留在原頁並以警示顯示原因。瀏覽器實測登出後停在 `/login`。
- **記住帳號**：登入頁新增「記住帳號」核取方塊，只把帳號名稱存在 `localStorage`，不存密碼；勾選登入後登出，登入頁預填帳號並把焦點放在密碼欄；取消勾選再登入即忘記。瀏覽器實測三種情況。
- 檢查：typecheck、lint、13 檔／85 tests、build 通過；容器重建 healthy。

## 桌面版表格寬度（2026-11-08 稍後）

問題：頁面文字欄最大 900px（左右各留 96px），表格被限制在同一欄，寬視窗下右側欄位被切掉、只能在欄內橫捲。

變更：`useTableBleed.ts` 量測文字欄右緣到頁面區域右緣的距離（扣 24px 留白），寫入 `--table-bleed`；桌面（≥768px）CSS 讓表格區塊寬度為 `100% + --table-bleed`，一般文字維持閱讀寬度。視窗縮放、側邊欄收合、全寬切換由 ResizeObserver 重新計算；手機為 0，維持原本行為；表格仍比可用空間寬時在表格內橫捲。

驗證（隔離 Chrome，合成 7 欄表格頁，驗完已永久刪除）：1529px 視窗段落寬 654px 不變，表格外框延伸到距右緣 23px，7 欄全部可見、無橫捲；全寬頁面延伸 72px；1000px 視窗延伸 72px；390px 手機延伸 0，整頁無橫向捲軸。`tests/client/tableBleed.test.ts` 覆蓋計算。typecheck、lint、14 檔／87 tests、build 通過。

## 文字選取面板、留言與表情反應（2026-11-08 稍後）

- 依使用者截圖改成緊湊面板：段落類型向右展開、顏色／粗斜體／底線／刪除線／行內程式碼／連結／清除格式、留言與表情反應。不加入 Skills／AI。段落選單只列目前 schema 支援的類型，包含一至六級標題、可摺疊標題、清單、引用與程式碼；不放無法執行的假選項。檔案區塊保留原有格式工具。
- `tests/server/annotations.test.ts`（5 項）：原文摘要與純文字留言保存、回覆、完整 emoji（含 ZWJ）往返／切換、解決／重開；未登入 401、他人 GET／POST／PATCH 404、缺 CSRF／跨來源 403、垃圾桶禁止操作與還原、永久刪頁級聯清除；過期 If-Match 409／缺少 428 且先前回覆不遺失；輸入上限與無效 emoji 拒絕；複製頁面保留文字格式但不帶原頁討論標記。
- 客戶端測試（5 項）：重疊範圍標記在正式 JSON 中保留、文字編輯／序列化後仍在；加反應不清掉未送出的回覆、409 顯示錯誤並保留草稿；同一段完整標記文字再次操作時重用討論；編輯器掛載後點原文可開啟討論、桌面選取右鍵攔截與 Shift+右鍵原生行為。
- 內建瀏覽器以既有合成帳號新增「選取面板驗收」頁：輸入文字、選取顯示面板、段落轉為檢查清單，再改二級標題；粗體操作成功且原文標記仍在；對選取文字右鍵可開啟面板與右側類型子選單。留言送出、加 👍、重載後摘要／留言／反應與標記均在。另從完整本機 emoji 網格選 🥰 成功；同範圍再次加反應時開啟既有討論。回覆草稿中先加 🎉 再送出，文字仍保留且成功保存；標示解決／重新開啟成功；直接點擊標記文字能開啟討論。
- 實測修正：段落子選單放在 toolbar 的 DOM 內，避免 Portal 失焦使整個面板關閉；標記點擊使用 DOM 已折疊的選取狀態，並在 editor mount 後綁定捕獲事件。自動化對多行 inline span 的 bounding-box 中央可能點到行間空白，改以畫面上實際文字位置驗證。客戶端測試補齊 jsdom 的 `document.fonts` 替身。
- 檢查：`npm run check` 實際依序通過 typecheck、lint、17 檔／97 tests、client＋server build；`docker compose up -d --build --wait` 成功且 healthy；`(Invoke-WebRequest -Uri http://127.0.0.1:8081/healthz).StatusCode` 為 200；`npm run test:app -- http://127.0.0.1:8081` 25 項 PASS；`git diff --check` 通過。沒有新增或升級依賴。
- 限制：本輪是桌面驗收，未重新做實體手機、真實 IME、HTTPS 或完整備份還原；SQLite experimental、Vite 大 bundle 提示仍在。瀏覽器沒有 error，仍有既有 BlockNote viewport meta 缺少 `interactive-widget=resizes-content` 的手機相容性 warning。討論與頁面內容分別保存、分別版本控制；頁面歷史不回退留言或反應。只有自己的頁面可留言，沒有新增分享或多人協作。
- 截圖：`.local/validation/selection-panel-types.png`、`selection-comments.png`（gitignored）。合成驗收頁保留供使用者查看，測試分頁已關閉。

## 資料庫直接編輯與表格／清單／看板（2026-11-08 稍後）

- 依使用者追加授權實作三種視圖的新增、切換、重新命名、設定與確認刪除；上限 20 個且最後一個不可刪除。共用資料列，各自保存排序、AND 篩選、顯示欄位與看板分組；網址保存視圖 ID，分頁支援鍵盤方向鍵與 Home／End。沒有新增其他視圖類型或依賴。
- 空表格顯示兩列空白輸入位置，空白位置不寫入正式資料；可從名稱或屬性開始輸入。名稱／文字／數字／網址在格內編輯，Enter／失焦儲存、Escape 取消，中文組字不誤送；核取方塊直接切換。底部「新增頁面」與工具列「新增」直接輸入，失敗保留名稱或草稿並可重試，409 保留原版本與草稿、不靜默覆寫。
- 看板依單選欄位分組，沒有時自動建立「狀態」與三個繁中選項；既有資料留在「未設定」，不自動改值。支援群組內新增、拖曳把手移組與卡片選單移組。拖曳保留開始時的列版本，不在成功前搬移資料。清單可直接編輯名稱／屬性。清單與看板仍分批載入，每批 100 列，群組計數為已載入數量，介面明示未載入完整資料；未實作卡片手動排序。
- migration `0006_database_views` 在交易中保留舊視圖所有欄位並放寬類型 CHECK；測試既有 ID／config／順序／時間保留、重跑冪等、刪頁級聯及外鍵完整性。新 API 繼續驗證 user_id、CSRF、Origin 與 If-Match，測試他人 404、缺 CSRF／外站 403、缺 If-Match 428、舊版 409；分組只接受本資料庫單選欄位，刪欄或變更型別清除失效分組。
- 客戶端測試覆蓋：兩列空白不預建紀錄、先填屬性建列、Enter＋blur 不重複送出、IME Enter、Escape、未完成數字、409 保留草稿、核取方塊防重複、清單改名、看板選單帶原版本移組。整合測試使用真正 API hooks 與模擬 fetch，驗證三視圖共用資料、視圖新增／改名／刪除、各自欄位設定、看板 groupBy 不被 URL override 清掉及鍵盤切換。
- 命令與結果：`npm run typecheck`、`npm run lint`、`npm test -- --reporter=dot`（19 檔／107 tests）、`npm run build` 全部通過；`git diff --check` 通過。沙箱內 Vitest／Vite 首次因 `spawn EPERM` 無法啟動，依批准在沙箱外重跑後通過。SQLite experimental 與 Vite 大 bundle 提示仍在。
- 容器：先執行 `docker compose exec -T app node dist/server/cli.js backup` 線上備份，再執行 `docker compose up -d --build --wait`，最終 healthy。`(Invoke-WebRequest -Uri http://127.0.0.1:8081/healthz).StatusCode` 為 200；`npm run test:app -- http://127.0.0.1:8081` 25 項 PASS。
- 實際 HTTP 冒煙：`node .local/database-smoke.mjs`（本機合成帳號、憑證不輸出）13 個主要請求通過，確認建立三種類型、正式空表沒有空白紀錄、自動狀態欄位、資料列直接改名／移組、過期版本拒絕、視圖改名保留類型、刪視圖不刪列；合成資料庫已清除並登出。第一次清理步驟將永久刪除的 204 誤判為 200，已修正驗收腳本並完整重跑通過，應用 API 本身正常。
- 限制：瀏覽器 inventory 回報 access host unavailable；Windows CUA 隨後因無法可靠辨識當前瀏覽器網址而停止。本輪沒有實際瀏覽器目視／截圖驗收、拖曳手勢驗收、實體手機或真實輸入法測試，未改用 CDP 繞過工具限制。以上元件與 HTTP 測試不等同瀏覽器端到端驗收。

## 桌面資料庫寬度修正（2026-11-08）

- 使用者截圖顯示桌面看板仍被筆記的 900px 閱讀欄與左右留白壓縮，需要橫捲才能看到所有群組。資料庫頁新增專用 class，桌面（≥768px）使用主內容區寬度、左右留 32px，移除資料庫本身額外的水平 margin；封面負 margin 同步調整。一般筆記與列頁面維持原閱讀欄。
- 桌面看板改用 grid，每欄在 220–280px 之間分配可用空間；空間足夠時完整呈現群組，群組太多或視窗太窄時才橫捲。手機保留原本 280px 固定欄寬與橫向捲動。
- `npm run typecheck`、`npm run lint`、`npm test -- --reporter=dot`（19 檔／107 tests）、`npm run build` 全過；`docker compose up -d --build --wait` healthy，`/healthz` 200；`git diff --check` 通過。這次是版面修正，沒有新增對應 CSS 的實作鏡像測試。
- 瀏覽器工具再次回報 access host unavailable，已停止 UI 驗收；本輪未取得修正後的實際瀏覽器截圖或量測結果。

## 1.0.2 發布前檢查（2026-11-08）

- `package.json` 與 `package-lock.json` 根套件版本同步更新為 1.0.2，沒有調整任何依賴版本。
- 再次執行 `npm run typecheck`、`npm run lint`、`npm test -- --reporter=dot`（19 檔／107 tests）、`npm run build`：全部通過。`docker compose up -d --build --wait` 成功、容器 healthy，`/healthz` 200；`GET /api/version` 實測回 `{ "version": "1.0.2" }`。
- `npm run test:app -- http://127.0.0.1:8081` 25 項 PASS。瀏覽器驗收限制沿用前述紀錄；發布說明包含線上備份、自動 migration、回退需還原備份及已知限制。

## 手機選取面板、鍵盤遮擋與段落類型選單修正（2026-11-09）

- 問題：BlockNote 的 FormattingToolbarController 在觸控裝置鍵盤開啟／編輯器聚焦時，即使沒有文字選取也會顯示手機工具列；自訂的桌面縱向面板因此遮擋輸入，並與原生選取選單同時出現。自訂段落類型 Menu 沒有關閉焦點攔截，點第一項展開時可能讓外層工具列消失。
- 修正：手機／粗指標裝置不掛載自動工具列，保留原生 contextmenu，只顯示主動操作的「格式與段落」入口；中文組字期間隱藏入口。點擊後開獨立的底部 Drawer，段落類型改在面板內切換，保留格式、顏色、連結、留言／反應及既有檔案工具。桌面使用專用控制器，段落 Menu 關閉 trapFocus／returnFocus 並保存原選取範圍。
- 選取保存：useSavedSelection 將 bookmark 隨文件變更映射，格式或留言操作前還原；不因焦點轉移改到其他段落。原範圍已刪除時顯示錯誤；相同 selection 不重設，避免粗體後切斜體把 stored marks 清掉。面板關閉後還原原位置與焦點。
- 鍵盤避讓：工具入口／底部面板依 VisualViewport 的 top／left／width／height 定位，兼顧鍵盤、畫面方向與安全區域，編輯器預留底部高度並捲動游標到入口上方。HTML viewport 加入 interactive-widget=resizes-content；容器回傳 HTML 已確認包含該設定。
- 新增 `tests/client/mobileSelection.test.tsx` 9 項，使用真正的 BlockNoteView、手機面板、桌面工具列及 Mantine 選單，只模擬網路與裝置／視口能力：輸入／選取／鍵盤縮放不自動開啟面板、原生 contextmenu 未攔截、鍵盤與焦點變化不關閉段落頁、對原選取的多段落轉換後繼續加粗、留言摘要保留範圍、游標處多重樣式與關閉後恢復、組字時隱藏入口、鍵盤高度與位移下的游標避讓、顏色／連結與清除格式保留 annotation、插入文件後範圍映射、刪除範圍後拒絕格式化鄰段，以及桌面第一項子選單真實點擊流程（部分情境合併於同一測試）。既有留言測試更新為模擬桌面專用控制器。
- 實際命令：`npm run typecheck`、`npm run lint`、`npm test -- --reporter=dot`（20 檔／116 tests）、`npm run build` 全部通過；`docker compose up -d --build --wait` 成功且 healthy；`(Invoke-WebRequest -Uri http://127.0.0.1:8081/healthz).StatusCode` 為 200；`npm run test:app -- http://127.0.0.1:8081` 25 項 PASS；`git diff --check` 通過。Vitest／Vite 子程序及 Docker API 因沙箱限制，依批准在沙箱外執行。未新增依賴、未改資料庫或認證協定。
- 限制：瀏覽器工具回報 access host unavailable，隨後使用者明確指示可略過瀏覽器測試，因此未繼續 UI 自動化。以上為 jsdom 元件／整合與 HTTP 檢查，沒有實際瀏覽器版面量測、手機原生選取選單、軟鍵盤或真實輸入法的實機驗收；不將模擬測試當成實機已驗證。

## 1.0.3 發布前檢查（2026-11-09）

- package.json 與 package-lock.json 根套件版本同步更新為 1.0.3，依賴版本維持不變。
- `npm run typecheck`、`npm run lint`、`npm test -- --reporter=dot`（20 檔／116 tests）、`npm run build` 全部通過；`docker compose up -d --build --wait` 成功且 healthy，`/healthz` 200；`GET /api/version` 實測回 `{ "version": "1.0.3" }`。
- `npm run test:app -- http://127.0.0.1:8081` 25 項 PASS。發布說明列出手機格式面板、段落類型與選取範圍修正，並明示依使用者指示略過瀏覽器／實體手機驗收。
