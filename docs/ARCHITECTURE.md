# 架構與里程碑

更新：2026-11-08（M0）。

## 決策

| 項目 | 決定 |
|---|---|
| 結構 | 單一 npm 套件：`src/server`（Node）、`src/client`（React）、`src/shared`（zod schema、型別、純函式） |
| 後端 | Hono 4 + `@hono/node-server`，zod 4 驗證；esbuild 打包成單檔，執行映像不含 node_modules |
| 資料庫 | `node:sqlite`（Node 22.23 內建，含 FTS5），經 `src/server/db/driver.ts` adapter；WAL |
| 密碼 | `node:crypto` scrypt（N=2^15, r=8, p=1），`timingSafeEqual` |
| 前端 | Vite + React 19 + BlockNote 0.57 + Mantine 9.7 + TanStack Query 5 + react-router 7 + dnd-kit + react-virtual |
| 正式資料 | `pages.content` 的 BlockNote 區塊 JSON；`version` 樂觀並行；`page_versions` 快照 |
| 搜尋 | FTS5 `trigram`（中文子字串），少於 3 字元用 LIKE |
| 匯入 | 伺服器端 markdown-it → 區塊 JSON；JEX（tar）與 Markdown 匯出（zip）；以 `import_key` 冪等 |
| 部署 | 單容器、`/data` named volume、唯讀根檔案系統、uid 101、`cap_drop ALL`；HTTPS 以 nginx overlay |

資料模型、API、自動保存協定、匯入流程與安全規則的完整說明見專案計畫（實作時逐段落實於程式與本文件）。

## 里程碑

| 里程碑 | 範圍 | 狀態 |
|---|---|---|
| M0 骨架與容器 | 套件與設定、Hono `/healthz`、migration `0001_init`、Vite 骨架、Dockerfile／compose、AGENTS.md | 進行中 |
| M1 帳號 | 註冊（邀請碼、第一位為管理者）、登入／登出／me、session、CSRF、速率限制、管理者邀請碼與使用者管理、登入／註冊／設定頁 | 未開始 |
| M2 頁面與編輯器 | 頁面樹、CRUD、搬移、最愛、垃圾桶、麵包屑；BlockNote 完整 schema、IME 防護、自動保存協定、深淺色 | 未開始 |
| M3 檔案與頁面標頭 | 上傳／提供、圖片與檔案區塊、封面、圖示、`@` 頁面提及 | 未開始 |
| M4 搜尋 | 文字擷取、FTS、Ctrl+K 指令面板 | 未開始 |
| M5 資料庫 | 屬性、列、表格視圖含排序篩選、列頁面 | 未開始 |
| M6 Joplin 匯入 | 管線、進度頁、報告 | 未開始 |
| M7 收尾 | 頁面歷史、手機版、快捷鍵、備份 CLI、CSP 稽核、HTTPS 冒煙、文件 | 未開始 |

## 驗證紀錄

見 [VALIDATION.md](VALIDATION.md)。
