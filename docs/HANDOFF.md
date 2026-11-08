# 交接紀錄（下次接力從這裡開始）

更新：2026-11-08。讀完本文件與 [AGENTS.md](../AGENTS.md)、[ARCHITECTURE.md](ARCHITECTURE.md) 再動手。完整計畫（資料模型、API、自動保存協定、匯入流程、各里程碑驗證方式）在 `C:\Users\yhhon\.claude\plans\dreamy-enchanting-hopcroft.md`；若找不到，ARCHITECTURE.md 的決策表加上本文件足以接續。

## 目前狀態一句話

M0 完成並驗證；M1（帳號）完成並在容器與瀏覽器驗證；M2（頁面樹、編輯器、自動保存）程式完成、單元測試通過、瀏覽器已驗證主要流程，但最後一個自動保存修正只做了單元測試層級；M3（檔案上傳、封面、圖示）伺服器端完成並測試，前端已寫好但**尚未在瀏覽器驗證**。M4 之後未開始。

## 已完成且已驗證

| 項目 | 驗證方式 |
|---|---|
| 骨架、SQLite migration（`0001_init`、`0002_cover_preset`）、Hono、Vite、esbuild 單檔伺服器 | `npm run check`（typecheck／lint／40 tests／build）全過 |
| Docker 單容器：唯讀根檔案系統、uid 101、`/data` volume、healthcheck、重啟後資料仍在 | `docker compose up -d --build --wait`，容器內 `touch /app/x` 被拒，`/healthz` 200 |
| 帳號：第一人成管理者、邀請碼單次／期限／撤銷、登入鎖定、CSRF、session 滑動與過期、改密碼踢掉其他 session、管理者停用使用者 | `tests/server/auth.test.ts`；容器上以 curl 走完 登入→建邀請碼→成員註冊→重用邀請碼被拒→成員不能進管理 API |
| 登入／註冊／設定（個人資料、密碼、外觀、邀請碼、使用者）頁面 | 瀏覽器：第一次開站導到「建立管理者帳號」，註冊後進首頁；邀請碼頁可產生代碼 |
| 頁面 API：樹、建立、搬移（循環檢查、位置重編號）、最愛、垃圾桶（子樹、還原到根、永久刪除、清空）、複製、`If-Match` 內容保存、409、快照、版本還原、跨使用者 404 | `tests/server/pages.test.ts` |
| 前端：側邊欄頁面樹（dnd-kit 拖曳投影 `treeDrag.ts` 有單元測試）、最愛、垃圾桶頁、麵包屑、頁面選單、BlockNote 完整 schema＋zh-TW＋IME 防護、`/` 選單（含子頁面／資料庫／提及）、`@` 提及、自動保存狀態機（reducer 有單元測試）、衝突列 | 瀏覽器（隔離 Chrome＋CDP）：建頁、打標題（側邊欄即時更新）、打內文自動保存、重載後內容仍在、`/` 選單列出全部區塊並插入標題 |
| 檔案 API：magic bytes 嗅探、允許清單、content-addressed 去重、inline／attachment、`CSP: sandbox`、ETag／304、刪除時只在無人引用才刪 blob、跨使用者 404 | `tests/server/files.test.ts` |

## 已完成但尚未驗證（接手第一件事）

1. **自動保存連續存檔的修正**（`src/client/features/page/useAutosave.ts`）：原本連續兩次保存會用到舊版本號而出現「有衝突」。已改成版本號以 ref 為準，單元測試過，容器已用修正後的程式重建，但瀏覽器重測被中斷。重測步驟：開任一頁面 → 文末按 Enter → 輸入 `/` 選「引用」→ 打字 → 再 Enter 打字 → 狀態應停在「已儲存」而非「有衝突」，`GET /api/pages/:id` 的 `version` 遞增。
2. **M3 前端**：`PageHeader.tsx`（emoji 圖示選擇器用 BlockNote 自帶的 `frimousse`、封面：內建漸層或上傳圖片、拖曳調整位置）、BlockEditor 的 `uploadFile` 接 `/api/files`。需要 `docker compose up -d --build --wait` 重建後在瀏覽器驗證：新增圖示、新增封面、上傳封面圖、在編輯器貼上或拖入圖片後重載仍顯示、非圖片檔變成檔案區塊可下載。
3. 兩個分頁同時編輯同一頁的衝突列（載入最新版本／以我的內容覆蓋）只有 API 測試，沒有瀏覽器實測。
4. 手機版（<768px）側邊欄 Drawer、sticky 上方列只寫了 CSS 與 Burger，沒有實測。

## 尚未開始

依序：M4 搜尋（`content_text` 擷取已在存檔時寫入，FTS5 trigram 表與 trigger 已在 migration；缺 `/api/search` 路由、Ctrl+K 指令面板、側邊欄「搜尋」按鈕目前 disabled）→ M5 資料庫表格視圖（`db_properties`、`row_values`、`db_views` 表已建；`kind='database'` 的頁面目前只顯示占位文字）→ M6 Joplin 匯入（`import_jobs` 表已建；轉換器、JEX／zip 解析、進度頁全未寫）→ M7 收尾（頁面歷史 UI：API 已有 `/api/pages/:id/versions`；備份 CLI 已有 `cli backup`；CSP 稽核、HTTPS overlay 自簽實測、Playwright、README／DEPLOY／IMPORT 文件）。

## 環境與工具備忘

- 本機容器用 `.env` 的 `NOTES_PORT=8081`（8080 被舊專案 D:\joplin-blocknote-editor 的站占用）。網址 `http://127.0.0.1:8081/`。
- 開發帳號在 `.local/dev-accounts.json`（gitignored）：admin 與 member 的 email／密碼都是合成值，只用於本機容器。
- 瀏覽器自動化：Claude 內建瀏覽器視窗被遮住時點擊會失敗；改用隔離 Chrome＋CDP：`scratchpad/notes/launch-chrome.mjs 9223 <profileDir> http://127.0.0.1:8081/` 與 `drive.mjs`（text／navigate／click／fill／type／key／char／mouse／eval／shot）。頁面有未保存變更時關閉會跳 `beforeunload` 對話框，driver 需先 `Page.handleJavaScriptDialog`。這些腳本在 session 的 scratchpad，不在專案內；接手時可重寫（約 80 行）。
- 用 Python 改檔請用 `open(..., newline='')`，否則 Windows 會把檔案寫成 CRLF；`.gitattributes` 已設 `eol=lf`。Bash heredoc 超過約 8 KB 會被截斷，長 patch 請寫成檔案再執行。
- `node:sqlite` 是 experimental，`NODE_OPTIONS=--disable-warning=ExperimentalWarning` 已設在映像；若遇到驅動問題，只需改 `src/server/db/driver.ts` 換成 `better-sqlite3`。
- 客戶端 tsconfig 關閉了 `exactOptionalPropertyTypes`（BlockNote 型別需要）；伺服器端仍開啟。

## 命令

```bash
npm run check
```

```bash
docker compose up -d --build --wait
```

```bash
npm run test:app
```

（`test:app` 尚未建立；接手時可仿照舊專案 `scripts/check-app.cjs` 寫對容器的靜態檢查。）
