# 部署指南

單一容器：Node 伺服器同時提供 SPA 與 API，SQLite 資料庫與附件都在 `/data` named volume。所有設定項目見 [.env.example](../.env.example)。

## 本機或內網

```powershell
docker compose up -d --build --wait
```

網站在 `http://127.0.0.1:${NOTES_PORT:-8080}/`，只綁 loopback。第一次開啟會要求建立管理者帳號；之後的使用者需要管理者在「設定 → 邀請碼」產生的邀請連結。

檢查：

```powershell
npm run test:app -- http://127.0.0.1:8080
```

（健康檢查、安全標頭、SPA fallback、未登入 401、跨來源 POST 拒絕、原始碼與秘密不外露。）

## 同一個區網的其他裝置（手機、另一台電腦）

預設只綁 `127.0.0.1`，所以 `http://192.168.x.x:埠` 連不上。要讓區網裝置連入，在 `.env` 設定：

```
NOTES_BIND=0.0.0.0
```

再執行 `docker compose up -d --wait`。第一次對外發布埠時 Windows 可能跳出防火牆詢問，要允許；若沒有詢問，請在 Windows 防火牆為該埠新增輸入規則。

這是明文 HTTP：密碼與內容在區網上未加密，只適合自己信任的家用網路；瀏覽器也會把 `http://192.168…` 視為不安全環境，少數功能（例如剪貼簿寫入）可能受限。跨出區網或在公共網路一律用下面的 HTTPS。

## 公開到網際網路

瀏覽器只在安全環境（HTTPS，或 `localhost`／`127.0.0.1`）允許本站需要的功能，而且密碼與 cookie 不能走明文，所以對外一定要 HTTPS。

1. 準備真實主機名的憑證與私鑰（Let's Encrypt、Cloudflare Origin Certificate 等）。
2. 在 `.env` 設定：

```
NOTES_TLS_CERT_FILE=/path/to/fullchain.pem
NOTES_TLS_KEY_FILE=/path/to/privkey.pem
NOTES_HTTPS_BIND=0.0.0.0
NOTES_HTTPS_PORT=443
```

3. 啟動 HTTPS overlay：

```powershell
docker compose -f compose.yaml -f compose.https.yaml up -d --build --wait
```

overlay 會：以 nginx 終結 TLS（TLS 1.2／1.3）並轉給 app；把 app 的 `TRUST_PROXY` 設為 1，讓伺服器信任 `X-Forwarded-Proto`／`X-Forwarded-For`，因此 session cookie 會帶 `Secure`，速率限制用真實來源 IP。app 自己的 8080 仍只綁 `127.0.0.1`，不要另外發布。

驗證：

```powershell
npm run test:app -- https://你的網域
```

### 放在 Cloudflare 後面

- DNS「僅 DNS」（灰雲）：瀏覽器直接連主機，憑證由你的主機提供（例如 Let's Encrypt）。
- 「已代理」（橘雲）：訪客看到 Cloudflare 的憑證；Cloudflare 到主機請用 **Full (strict)** 搭配免費的 Origin Certificate 當上面的憑證檔，並在主機防火牆只允許 Cloudflare 的 IP 範圍連 443，否則知道 IP 的人能繞過 Cloudflare 直連。不要用 Flexible（Cloudflare 到主機是明文）。
- 或用 Cloudflare Tunnel：主機不開對外埠，把 tunnel 指到 `http://127.0.0.1:${NOTES_PORT}`，並在 app 設 `NOTES_TRUST_PROXY=1`（compose.yaml 的 `TRUST_PROXY` 讀這個變數）。

### 反向代理注意事項

- 代理必須傳 `X-Forwarded-Proto: https` 與 `X-Forwarded-For`，且 app 只在 `TRUST_PROXY=1` 時信任這些標頭。沒有代理時不要開，否則客戶端可以偽造來源 IP 影響速率限制。
- 寫入請求的來源檢查只比對主機名：`Origin` 必須是 `NOTES_PUBLIC_ORIGIN`，或等於請求抵達時的 `Host`（`NOTES_TRUST_PROXY=1` 時改看 `X-Forwarded-Host`）。若代理或 tunnel 改寫了 `Host`（症狀：登入後所有寫入動作都回 403 `csrf`，例如產生邀請碼、登出），在 `.env` 設 `NOTES_PUBLIC_ORIGIN=https://你的網域` 後 `docker compose up -d --wait`。
- 匯入或上傳大檔時代理的 body 上限要高於 `NOTES_MAX_UPLOAD_MB`（overlay 已設 220 MB、讀取逾時 300 秒）。

## 備份與還原

資料庫使用 WAL，**不要直接複製使用中的 `notes.sqlite`**。用內建的線上備份：

```powershell
docker compose exec app node dist/server/cli.js backup
```

這會在 `/data/backups/notes-<時間>.sqlite` 產生一致的快照並只保留最近 7 份。接著把整個 volume 的 `files/`（附件，content-addressed）與 `backups/` 打包帶走：

```powershell
docker run --rm -v notes_notes-data:/data:ro -v ${PWD}:/out alpine tar czf /out/notes-backup.tgz -C /data files backups
```

還原到全新 volume：

```powershell
docker compose down
docker run --rm -v notes_notes-data:/data -v ${PWD}:/in alpine sh -c "tar xzf /in/notes-backup.tgz -C /data && cp /data/backups/<要還原的檔>.sqlite /data/notes.sqlite && chown -R 101:101 /data"
docker compose up -d --wait
```

啟動時 migration 會自動補齊；`backups/` 裡其他快照仍保留。

其他指令：`cli migrate`（手動套用 migration）、`cli rebuild-index`（重建全文索引）。

## 升級

```powershell
git pull
docker compose up -d --build --wait
```

migration 只前進且冪等。升級前先做一次備份。

## 限制

- 單一程序、同步 SQLite：適合個人到數十人。
- 速率限制狀態在記憶體，重啟歸零。
- 未引用的附件 blob 目前不會自動回收。
- 附件 `GET` 不支援 Range（影片不能拖曳進度，待補）。
