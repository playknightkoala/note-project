# 驗證紀錄

每個里程碑記錄實際執行的命令、結果、限制與人工測試方式。

## M0 骨架與容器（2026-11-08）

- 命令：`npm run typecheck`、`npm run lint`、`npm test`（bootstrap 測試：健康檢查、安全標頭、API 404、migration 冪等、FTS5 trigram 中文查詢）、`npm run build`（Vite 客戶端 + esbuild 伺服器單檔）皆通過。
- 本機執行 `node dist/server/index.js`：`/healthz` 200 並帶 CSP／COOP／nosniff 等標頭，`/api/version` 回版本，SPA fallback 200，`/api/*` 未知路由 JSON 404。
- Docker：`docker compose up -d --build --wait` healthy（本機以 `.env` 的 `NOTES_PORT=8081`，因 8080 被舊專案佔用）；容器內 `touch /app/x` 回 Read-only file system；程序以 uid 101 執行，`/data` 建立 `files`、`tmp`、`backups` 與 `notes.sqlite`；`docker compose restart` 後資料仍在、`/healthz` 200、migration 回報已套用為空。
- 限制：`node:sqlite` 為 experimental（以 `NODE_OPTIONS=--disable-warning=ExperimentalWarning` 抑制警告）；尚未做 HTTPS overlay 實測（M7）。
