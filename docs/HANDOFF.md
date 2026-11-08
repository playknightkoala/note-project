# 交接紀錄

更新：2026-11-08。動手前讀本文件、[AGENTS.md](../AGENTS.md)、[ARCHITECTURE.md](ARCHITECTURE.md)、[DEPLOY.md](DEPLOY.md)。

## 目前狀態

**M0–M5 與 M7 完成並驗證；M6 Joplin 匯入已取消。** 功能範圍以 README「功能」段落為準。最後一次 `npm run check`：typecheck、lint、77 tests、build 全過；`docker compose up -d --build --wait` healthy；`npm run test:app -- http://127.0.0.1:8081` 25 項 PASS。各里程碑的實際驗證內容與限制見 [VALIDATION.md](VALIDATION.md)。

## 下一步（若要繼續）

沒有必做事項。可選的改進，依價值排序：

1. 真實環境驗收：以可信憑證部署到真實網域（步驟在 DEPLOY.md），用實體手機與中文輸入法走一遍編輯、搜尋、資料庫。
2. 還原演練：依 DEPLOY.md 的備份／還原步驟在另一個 volume 實際還原一次。
3. 附件 `GET` 支援 Range（影片拖曳進度）；未引用 blob 的回收指令。
4. 多視圖、OR 篩選、公式／關聯欄位（M5 明確不在範圍）。
5. Playwright 端到端套件（目前以 `scripts/check-app.mjs` 靜態檢查與 CDP 冒煙腳本代替，後者在 scratch 未納入專案）。

## 已知限制

- 速率限制狀態在記憶體，重啟歸零。
- `node:sqlite` 在 Node 22 仍是 experimental；若升級 Node 出問題，只需改 `src/server/db/driver.ts` 換 `better-sqlite3`。
- `import_jobs` 表與 `markdown-it`、`tar`、`fflate` 依賴是為已取消的 M6 準備，目前未使用；要清理時一併刪除 migration 之外的引用即可（不要改既有 migration）。
- 客戶端 tsconfig 關閉 `exactOptionalPropertyTypes`（BlockNote 型別需要），伺服器端開啟。
- Vite 建置有主 bundle 大於 500 kB 的提示，未做 code splitting。

## 環境與工具備忘

- 本機 `.env` 的 `NOTES_PORT=8081`（8080 被舊專案 `D:\joplin-blocknote-editor` 的站占用；不要停掉舊專案）。本站 `http://127.0.0.1:8081/`。
- 開發合成帳號在 `.local/dev-accounts.json`（gitignored）；驗收用截圖與合成檔在 `.local/validation/`。不要把帳密、session、邀請碼、`.env`、資料庫或附件寫進文件、提交或映像。
- 瀏覽器自動化：Claude 內建瀏覽器在視窗被遮住時點擊會失敗；可改用隔離 Chrome＋CDP（`--remote-debugging-port`），頁面有未保存變更時關閉會跳 `beforeunload`，driver 需先 `Page.handleJavaScriptDialog`。手機視口要在同一個 CDP 連線內用 `Emulation.setDeviceMetricsOverride`，斷線即失效。
- Windows：Python 改檔請用 `open(..., newline='')`；長 Bash heredoc 可能被截斷，改成檔案再執行；`.gitattributes` 指定 LF。
- 沙箱內 Docker named pipe 可能 permission denied、Vitest 子程序 `spawn EPERM`，需提升權限重跑，不是程式錯誤。

## 命令

```bash
npm run check
```

```bash
docker compose up -d --build --wait
```

```bash
npm run test:app -- http://127.0.0.1:8081
```
