# 架構與里程碑

更新：2026-11-08。接手請先讀 [HANDOFF.md](HANDOFF.md)。

## 決策

| 項目 | 決定 |
|---|---|
| 結構 | 單一 npm 套件：`src/server`（Node）、`src/client`（React）、`src/shared`（zod schema、型別、純函式） |
| 後端 | Hono 4 + `@hono/node-server`，zod 4 驗證；esbuild 打包成單檔，執行映像不含 node_modules |
| 資料庫 | `node:sqlite`（Node 22.23 內建，含 FTS5），經 `src/server/db/driver.ts` adapter；WAL |
| 密碼 | `node:crypto` scrypt（N=2^15, r=8, p=1），`timingSafeEqual` |
| 前端 | Vite + React 19 + BlockNote 0.57 + Mantine 9.7 + TanStack Query 5 + react-router 7 + dnd-kit + react-virtual |
| 正式資料 | `pages.content` 的 BlockNote 區塊 JSON；`version` 樂觀並行；`page_versions` 快照 |
| 搜尋 | FTS5 `trigram`（中文子字串），少於 3 個 Unicode 字元用跳脫萬用字元的 LIKE；純文字片段由 React 高亮 |
| 匯入 | 伺服器端 markdown-it → 區塊 JSON；JEX（tar）與 Markdown 匯出（zip）；以 `import_key` 冪等 |
| 部署 | 單容器、`/data` named volume、唯讀根檔案系統、uid 101、`cap_drop ALL`；HTTPS 以 nginx overlay |

資料模型、API、自動保存協定、匯入流程與安全規則的完整說明見專案計畫（實作時逐段落實於程式與本文件）。

## 里程碑

| 里程碑 | 範圍 | 狀態 |
|---|---|---|
| M0 骨架與容器 | 套件與設定、Hono `/healthz`、migration `0001_init`、Vite 骨架、Dockerfile／compose、AGENTS.md | 已驗證 |
| M1 帳號 | 註冊（邀請碼、第一位為管理者）、登入／登出／me、session、CSRF、速率限制、管理者邀請碼與使用者管理、登入／註冊／設定頁 | 已驗證（API 測試＋容器 curl＋瀏覽器） |
| M2 頁面與編輯器 | 頁面樹、CRUD、搬移、最愛、垃圾桶、麵包屑；BlockNote 完整 schema、IME 防護、自動保存協定、深淺色 | 已驗證；連續存檔、雙分頁兩種解法、遠端同步及覆蓋快照已補測 |
| M3 檔案與頁面標頭 | 上傳／提供、圖片與檔案區塊、封面、圖示、`@` 頁面提及 | 已驗證主要流程；圖示本機資料、封面位置、貼圖、附件與提及皆重測，下載事件觀測限制見 VALIDATION |
| M4 搜尋 | 文字擷取、FTS、Ctrl+K 指令面板 | 已完成並驗證（API／客戶端測試、既有索引 migration、容器與瀏覽器） |
| M5 資料庫 | 屬性、列、表格視圖含排序篩選、列頁面 | 未開始 |
| M6 Joplin 匯入 | 管線、進度頁、報告 | 未開始 |
| M7 收尾 | 頁面歷史、手機版、快捷鍵、備份 CLI、CSP 稽核、HTTPS 冒煙、文件 | 未開始 |

## 驗證紀錄

見 [VALIDATION.md](VALIDATION.md)。

## 搜尋與版本保存協定補充（M2–M4）

- `PUT /api/pages/:id/content` 仍必須帶 `If-Match`；使用者選擇解決衝突時，以目前衝突 head 重送並帶 `overwrite: true`，伺服器強制保存被覆蓋版本的快照。若 head 又變更，仍回 409。
- `GET /api/search?q&limit&offset` 需要登入，只回自己的非垃圾桶頁面（含資料庫與列頁面）。`q` 最長 200 字元，limit 預設 20、上限 50，offset 上限 10000；空查詢回空集合。回傳 `results`、`total`、`limit`、`offset`，每筆包含麵包屑與純文字 snippet。
- FTS 長查詢以雙引號包成字面片語，內部引號跳脫；短查詢以參數化 LIKE 並跳脫 `%`、`_`、反斜線。FTS 以標題較高權重排序，再依更新時間與 ID 排序。
- migration `0003_search_content` 將外部內容 FTS 欄名修正為 `content_text`，重建既有索引；不改筆記內容。套用紀錄確保只執行一次。
- 圖示資料取自固定版本 BlockNote 的本機動態 chunk，不開放外部 CDN。只有 PNG／JPEG／GIF／WebP inline；SVG 與所有非圖片以 attachment＋sandbox 提供。
