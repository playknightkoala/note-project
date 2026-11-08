# 交接紀錄

更新：2026-11-08。動手前讀本文件、[AGENTS.md](../AGENTS.md)、[ARCHITECTURE.md](ARCHITECTURE.md)、[DEPLOY.md](DEPLOY.md)。

## 目前狀態

目前套件版本為 **1.0.2**，本機容器 `/api/version` 已實測回報同版本；發布前重跑的檢查皆通過，詳見 VALIDATION 的 1.0.2 段落。

**M0–M5 與 M7 完成並驗證；M6 Joplin 匯入已取消。** 之後追加：右鍵選單、登入頁記住帳號、反向代理 CSRF／登出修正、桌面表格延伸寬度、參考 Notion 的文字選取面板（段落類型右側子選單、文字格式、範圍留言、表情反應；無 Skills／AI），以及資料庫直接編輯與表格／清單／看板多視圖。最新個別命令 `npm run typecheck`、`npm run lint`、`npm test -- --reporter=dot`（19 檔／107 tests）、`npm run build` 全過；`docker compose up -d --build --wait` healthy、`/healthz` 200；`npm run test:app -- http://127.0.0.1:8081` 25 項 PASS。功能範圍見 README，各次驗證與限制見 [VALIDATION.md](VALIDATION.md)。

資料庫追加功能：migration `0006_database_views` 保留既有設定並支援三種類型；空表格的兩列是輸入位置，輸入後才建立正式資料。上方「＋」新增視圖，「編輯視圖」管理名稱、類型、分組與刪除；各視圖共用列且各自保存條件。看板自動選用單選欄位，沒有時建立狀態欄位；原有未分類資料留在「未設定」。清單／看板每批 100 列、手動載入更多，群組計數僅已載入資料。升級前已用容器 CLI 線上備份；實際容器 API 冒煙通過並清除合成資料。本輪 Windows 瀏覽器工具無法可靠辨識網址而停止，尚未目視驗收版面與實際拖曳手勢，未繞過工具改用 CDP。

選取留言：migration `0005_annotations` 與三個 annotations API 已加入。討論獨立保存並以自己的 If-Match 防衝突；原文標記是 BlockNote JSON 的 `annotation` 字串樣式，可重疊，走既有自動保存。原文刪除或標記未保存時，仍可從「留言與反應」看摘要；還原頁面歷史不回退討論，複製頁面不攜帶討論與標記。細節見 ARCHITECTURE 的追加功能段落。合成「選取面板驗收」頁保留供使用者查看，截圖在 `.local/validation/selection-panel-types.png` 與 `selection-comments.png`；本輪測試分頁已關閉。

登入期限已核對：持久 Cookie 最多 90 天，伺服器為 30 天滑動閒置期限（每小時最多延長一次）與登入後 90 天絕對上限。背景查詢也算活動；本輪沒有改動登入政策。

## 下一步（若要繼續）

沒有必做事項。可選的改進，依價值排序：

1. 真實環境驗收：以可信憑證部署到真實網域（步驟在 DEPLOY.md），用實體手機與中文輸入法走一遍編輯、搜尋、資料庫。
2. 還原演練：依 DEPLOY.md 的備份／還原步驟在另一個 volume 實際還原一次。
3. 附件 `GET` 支援 Range（影片拖曳進度）；未引用 blob 的回收指令。
4. 額外視圖類型、OR 篩選、公式／關聯欄位（表格／清單／看板已依追加授權完成）。
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
