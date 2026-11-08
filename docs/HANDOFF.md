# 交接紀錄（下次接力從這裡開始）

更新：2026-11-08。動手前讀本文件、[AGENTS.md](../AGENTS.md)、[ARCHITECTURE.md](ARCHITECTURE.md)。原始完整計畫在 `C:\Users\yhhon\.claude\plans\dreamy-enchanting-hopcroft.md`；若不存在，以專案文件及程式為準。

## 目前狀態

M0、M1 先前已驗證。**M2、M3 的三項待驗證已重測並修正發現的問題；M4 搜尋已完成，API、客戶端測試、容器與瀏覽器已驗證。下一個里程碑是 M5 資料庫表格視圖。**

最後一次 `npm run check`：typecheck、lint、55 tests（10 個測試檔）、build 全通過。`docker compose up -d --build --wait` healthy，`http://127.0.0.1:8081/healthz` 200。實際命令、失敗後重跑及驗證限制見 [VALIDATION.md](VALIDATION.md)。

## 已驗證清單

| 項目 | 證據與現況 |
|---|---|
| M0 骨架、SQLite、單容器 | 先前驗過唯讀根檔案系統、uid 101、volume、重啟持久性；本次再次重建 healthy |
| M1 帳號與管理 | 既有 API、容器 curl、首次註冊／登入／設定瀏覽器驗證；本次沿用本機合成帳號登入，未變更帳號功能 |
| M2 頁面 API、樹、最愛、垃圾桶、版本 | 既有伺服器／純函式測試；新增明確覆蓋的強制快照測試 |
| M2 連續自動保存 | 瀏覽器：一般段落 → `/` 引用 → 輸入 → 再輸入，各次「已儲存」，重載仍在；新增 hook 測試直接驗證下一次 If-Match 使用回傳版本 |
| M2 雙分頁衝突 | 實際兩個分頁觸發衝突，分別驗證載入最新版本、以我的內容覆蓋及重載；回讀歷史確認被覆蓋的內容仍在 |
| M3 圖示與封面 | 繁體圖示選擇、漸層、上傳合成 PNG、拖曳封面 50% → 22%，保存後重載仍是 22% |
| M3 編輯器與提及 | 剪貼簿貼圖自動上傳，重載後圖片 naturalWidth 160；上傳 PDF 後重載仍有檔案區塊；`@` 插入、重載、點擊連結可到目標頁 |
| M3 檔案提供 | 非圖片一律 attachment＋sandbox；容器回讀 PDF 的標頭與位元組符合原始合成檔。瀏覽器下載按鈕會開啟檔案網址，但內建瀏覽器未回報 download event，未宣稱驗過 OS 的實際存檔 |
| M4 全文搜尋 | API 測試含中英文、單字／兩字、特殊符號、權限、垃圾桶、更新／還原／刪除、排序與分頁；瀏覽器驗證 Ctrl+K、側欄入口、高亮、空結果、Enter 導覽、Esc 關閉 |

## 三項待驗證的處理結果與修正

1. **連續保存：完成。** `useAutosave.ts` 的版本 ref 修正已在瀏覽器通過；新增 `autosaveHook.test.ts`，不只測 reducer。
2. **M3 前端：完成主要驗收。** 圖示選擇器原本連外部 CDN 而被同源 CSP 阻擋，現改用固定版 BlockNote 隨附的 `zh-hant` 資料。封面調整時，父層 pointer capture 原本攔住「儲存位置」按鈕，已隔離控制列事件並實測持久性。上傳錯誤有畫面提示。PDF 等非圖片不再 inline。
3. **雙分頁：完成。** 載入遠端區塊原本觸發 onChange，再自動存一次，會連鎖衝突；現在載入內容不標記 dirty。遠端 GET 完成前保留舊 If-Match，期間若又輸入，就保留本地草稿。明確覆蓋用 `overwrite: true` 強制先留快照，仍須通過 If-Match，沒有免版本檢查的強寫。

## M4 實作位置

- API：`GET /api/search?q&limit&offset`，登入後只搜自己的非垃圾桶頁面；長查詢用 FTS5 trigram 的字面片語，少於三個 Unicode 字元用跳脫 `%`／`_` 的 LIKE。標題命中優先，預設 20 筆、上限 50 筆。
- `src/server/services/search.ts`：查詢、總筆數、片段、麵包屑。回傳純文字 snippet；前端以 React text node／`<mark>` 呈現，不插入 HTML。
- `0003_search_content`：修正原本 FTS 的 `body` 與實體 `content_text` 不一致，重建索引並保留全部筆記；既有資料升級與冪等有測試。不要回改 `0001_init`。
- `src/client/features/search/CommandPalette.tsx`：Ctrl / ⌘ K、側欄入口、最近開啟（按 user id 儲存 ID）、新增頁面／設定／垃圾桶動作、麵包屑、高亮、分頁、載入／錯誤／空結果與 IME 防護。輸入 debounce 200ms；換查詢會取消舊請求並立即隱藏舊結果。

## 後續里程碑與現有基礎

1. **M5 資料庫表格視圖**：`db_properties`、`row_values`、`db_views` 表已建，建立 `kind='database'` 會建預設表格 view；畫面目前仍是占位文字。待完成屬性 API／UI、列與列頁面、表格視圖、排序篩選及使用者隔離驗證。
2. **M6 Joplin 匯入**：已有 `import_jobs` 表、檔案儲存與 BlockNote schema；待完成 JEX／Markdown zip 解析、markdown-it 轉換器、冪等匯入、進度頁與報告。不依賴 Joplin 執行環境或同步。
3. **M7 收尾**：頁面歷史 UI（API 已有）、完整手機／觸控／行動鍵盤驗收、其他快捷鍵、備份與還原文件、CSP 稽核、HTTPS overlay 自簽實測、端到端測試與 README／DEPLOY／IMPORT。CLI 已有 `cli backup`；備份請用線上 backup，不直接複製使用中的 SQLite。

M7 帳號稽核候選（本次閱讀發現、尚未做整體修正與重測）：錯誤的目前密碼會回 401，前端可能誤當登入失效；限流器 sweep 混用不同時間窗；資料庫 session 滑動續期與瀏覽器 cookie 到期日未同步。後續以合成帳號重現並處理，不要視為本次已修正。

## 環境與工具備忘

- 本機 `.env` 的 `NOTES_PORT=8081`；8080 被舊專案 `D:\joplin-blocknote-editor` 使用。本站 `http://127.0.0.1:8081/`；不要重建或停止舊專案。
- 開發合成帳號在 `.local/dev-accounts.json`（gitignored）。不要將帳密、session、邀請碼、`.env`、資料庫或附件寫進文件、提交或映像。
- 本次驗收圖與合成檔在 `.local/validation/`（gitignored）；頁面「M2 M3 驗收筆記」為合成驗收資料。
- 本次建立的測試分頁與檔案下載分頁已關閉，容器仍在運行。
- 本次使用內建瀏覽器（CUA／Browser Use），未重開先前的隔離 Chrome。預設視口可能小於 768px；側欄隱藏時先按「開啟側邊欄」，否則對隱藏按鈕的操作可能沒有作用。Modal 有關閉動畫，請等 dialog hidden 再操作。
- 圖片可透過 clipboard 的 `image/png` 測試貼上；檔案上傳以 filechooser 搭配絕對路徑。BlockNote 的下載按鈕用 `window.open`，下載可能出現在新分頁；不要把等待原分頁 download event 逾時直接當成伺服器錯誤。
- 舊交接提到的 `scratchpad/notes/launch-chrome.mjs`／`drive.mjs` 不在本專案；不可假設仍存在。使用隔離 Chrome 時，未保存內容可能出現 beforeunload 對話框。
- Windows：Python 改檔請用 `open(..., newline='')`，`.gitattributes` 指定 LF。長 Bash heredoc 曾被截斷；改用 apply_patch 或分段檔案。本次新增／修改檔案維持 LF。
- 沙箱內 Docker named pipe 會 permission denied，Vitest／Vite 的子程序可能 `spawn EPERM`；本次透過執行權限提升完成檢查，並非測試失敗。若重現，保留真實錯誤並用相同的專案命令重試。
- `node:sqlite` experimental 警告是目前 Node 的已知訊息；映像有抑制。客戶端未開 `exactOptionalPropertyTypes`（BlockNote 型別），伺服器仍開啟。Vite 尚有主 bundle 大於 500 kB 提示。
- 低於 768px 的側欄與搜尋入口已做基本操作驗證；完整行動體驗留在 M7。IME 的自動化測試通過，尚未以真實中文輸入法人工驗收。

## 驗證命令

```powershell
npm run check
docker compose up -d --build --wait
(Invoke-WebRequest -Uri http://127.0.0.1:8081/healthz).StatusCode
```

`check` 包含 typecheck、lint、test、build。專案目前沒有 `test:app` script，不要把它列為已執行檢查。
