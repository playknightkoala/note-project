# 部署指南

單一容器：Node 伺服器同時提供 SPA 與 API，SQLite 資料庫與附件都在 `/data` named volume。所有設定項目見 [.env.example](../.env.example)。

## 本機或內網

```powershell
docker compose up -d --build --wait
```

網站在 `http://127.0.0.1:${NOTES_PORT:-8080}/`，只綁 loopback。第一次開啟會要求建立管理者帳號；之後的使用者需要管理者在「設定 → 邀請碼」產生的邀請連結。

**第一個註冊的人就是管理者。** 若網站在你建立帳號之前就能被其他人連到（對外網域、共用區網），先在 `.env` 設 `NOTES_SETUP_TOKEN`（16 個字元以上的隨機值）：建立第一個帳號時必須在「設定碼」欄位輸入這個值，其他人無法搶先註冊。管理者建立後這個設定不再有作用。

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

手機的離線筆記功能也需要 HTTPS；區網明文 HTTP 仍可一般連線使用，但不會啟用離線介面。部署及升級後，先連線開啟「離線與同步」完成介面準備與筆記下載，詳見 [OFFLINE.md](OFFLINE.md)。反向代理應讓 `/sw.js` 保持 `Cache-Control: no-cache`，`/api/version` 保持 `no-store`，不要另外長期快取 Service Worker、版本資訊或登入 API。

1.0.6 起左下角顯示目前介面版本。發布時同步更新 package.json／package-lock.json 根版本及 `src/server/releases.ts` 的更新資訊，重新建置部署後，使用者會收到更新 Modal，可按「立即更新」讓新版介面接手。首次從 1.0.5 或更早版升級仍須手動連線重載一次，才能載入此功能。只建立 GitHub Release 不會自行升級容器；偵測的是目前伺服器已部署的版號。

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

overlay 會：以 nginx 終結 TLS（TLS 1.2／1.3）並轉給 app；把 app 的 `TRUST_PROXY` 設為 1，讓伺服器信任 `X-Forwarded-Proto`／`X-Forwarded-Host`／`X-Forwarded-For`，因此 session cookie 會帶 `Secure`。nginx 會以實際連線位址覆寫 `X-Forwarded-For`（不沿用客戶端送來的值），速率限制因此以連到 nginx 的位址計算；若 nginx 前面還有 Cloudflare，請依下節設定 `NOTES_CLIENT_IP_HEADER`，否則所有訪客會被算成 Cloudflare 的節點位址。app 自己的 8080 仍只綁 `127.0.0.1`，不要另外發布。

驗證：

```powershell
npm run test:app -- https://你的網域
```

### 放在 Cloudflare 後面

- DNS「僅 DNS」（灰雲）：瀏覽器直接連主機，憑證由你的主機提供（例如 Let's Encrypt）。
- 「已代理」（橘雲）：訪客看到 Cloudflare 的憑證；Cloudflare 到主機請用 **Full (strict)** 搭配免費的 Origin Certificate 當上面的憑證檔，並在主機防火牆只允許 Cloudflare 的 IP 範圍連 443，否則知道 IP 的人能繞過 Cloudflare 直連。不要用 Flexible（Cloudflare 到主機是明文）。
- 或用 Cloudflare Tunnel：主機不開對外埠，把 tunnel 指到 `http://127.0.0.1:${NOTES_PORT}`，並在 app 設 `NOTES_TRUST_PROXY=1`（compose.yaml 的 `TRUST_PROXY` 讀這個變數）。
- 經過 Cloudflare（橘雲或 Tunnel）時設 `NOTES_CLIENT_IP_HEADER=cf-connecting-ip`，速率限制才會以訪客的真實位址計算。只有在所有流量都確實經過 Cloudflare 時才設定：能繞過 Cloudflare 直連的人可以自行填寫這個標頭。

### 反向代理注意事項

- 代理必須傳 `X-Forwarded-Proto: https` 與 `X-Forwarded-For`，且 app 只在 `TRUST_PROXY=1` 時信任這些標頭。沒有代理時不要開，否則客戶端可以偽造來源 IP 影響速率限制。
- 來源位址取 `X-Forwarded-For` 的最後一段（緊鄰 app 的代理所附加的位址）；前面各段可能是客戶端自己填的，不採用。自架代理請覆寫或附加真實位址（nginx：`proxy_set_header X-Forwarded-For $remote_addr;`）。代理另以專用標頭提供真實位址時，用 `NOTES_CLIENT_IP_HEADER` 指定。
- 公開連結（`/s/…` 與 `/api/public/…`，見 [SHARING.md](SHARING.md)）不需登入，依來源位址限流（每分鐘 600 次）。在代理或 tunnel 後面若沒有設定 `NOTES_TRUST_PROXY=1`（及必要的 `NOTES_CLIENT_IP_HEADER`），所有訪客都會被當成代理的位址而共用同一個額度。公開連結的網址本身就是鑰匙，會出現在代理的存取紀錄中；app 自己的錯誤紀錄會遮蔽它，代理的紀錄請自行控管保存與存取。
- 登入限制：每個來源位址 15 分鐘 10 次；同一來源對同一帳號 5 次失敗後暫停 15 分鐘；同一帳號不分來源以 30 次為上限。別人從其他位址猜錯密碼不會鎖住帳號本人。登入與註冊只接受同源的 `application/json` 請求。
- 請求大小：帳號相關端點 64 KB、其他 JSON 端點 8 MB、附件為 `NOTES_MAX_UPLOAD_MB`；超過即回 413，未帶 `Content-Length`（chunked）的請求也在讀到上限時中止。
- 寫入請求的來源檢查只比對主機名：`Origin` 必須是 `NOTES_PUBLIC_ORIGIN`，或等於請求抵達時的 `Host`（`NOTES_TRUST_PROXY=1` 時改看 `X-Forwarded-Host`）。若代理或 tunnel 改寫了 `Host`（症狀：登入後所有寫入動作都回 403 `csrf`，例如產生邀請碼、登出），在 `.env` 設 `NOTES_PUBLIC_ORIGIN=https://你的網域` 後 `docker compose up -d --wait`。
- 附件上傳預設 `NOTES_MAX_UPLOAD_MB=90`；既有 `.env` 若仍明確設定為 20，升級時需自行改為 90 才會放寬。上傳大檔時代理的 body 上限要高於附件上限（含 multipart 包裝；overlay 已設 220 MB、讀取逾時 300 秒）。Cloudflare 若為單次請求 100 MB 上限，建議維持 90，避免容量單位與包裝造成 413；此限制與裝置離線快取總容量不同。

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
