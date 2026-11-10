# 驗證紀錄

## 公開連結與「知道連結的本站帳號」共用一個連結（2026-11-11，版本 1.1.2）

- 範圍：公開連結成為主開關，開啟後才能設定登入的本站帳號開啟同一個連結時的權限；頁面網址本身不再給任何權限；未登入者的行為不變。migration `0011_share_single_link`。沒有新增或升級任何依賴。以下檢查在版號仍為 1.1.1 時完成；使用者指定 1.1.2 後只改了版號、更新資訊與文件，並重跑本機檢查與容器檢查（`/api/version` 回報 1.1.2）。
- 本機檢查（Node 22.23.1）：`npm run typecheck`、`npm run lint`、`npm test`（**36 檔／271 tests**）、`npm run build` 全部通過。
- 測試：`tests/server/shares.test.ts` 的「what the public link gives a signed-in account」三項——公開連結關閉時設定帳號角色得 400；只有擁有者能設定；設定後只知道頁面網址仍是 404，未登入者照舊讀到公開內容且不能呼叫開啟端點（401）；登入的帳號查詢連結得到 `{ account: true }` 但不因此取得權限，開啟端點缺 CSRF 得 403、錯誤 token 得 404，開啟後取得角色（範圍照舊、唯讀不能寫、可留言），列入「與我共用」與 manifest，擁有者看得到開啟過的帳號；可編輯時能改內文與資料列但不能改結構、新增子頁、刪除或管理分享，與個別成員角色取較高者，檔案要開啟連結後才可讀；自行移除後失去存取，再開啟連結才回來；改回 null、關閉公開連結、移至垃圾桶都立即失效並清空開啟紀錄，重新開啟為新網址且帳號設定歸零；沒有帳號角色時，名單外的登入帳號讀到公開內容，擁有者與個別成員被帶到頁面；已停用帳號的 session 不改變公開回應。`tests/server/databaseMigration.test.ts` 驗證 0011：有公開連結者不變，沒有公開連結者清除帳號設定與開啟紀錄，個別成員保留，可重複執行。`tests/client/sharing.test.tsx`：公開連結關閉時沒有帳號選項，開啟後才出現，只有一個連結且不顯示頁面網址，關閉後設定歸零；登入帳號被帶入時依序呼叫公開端點、`/api/auth/me`、`POST /api/shares/open` 並導向 `/p/<id>`。
- 容器：`NOTES_PORT=18090 docker compose -p notes-m10-check up -d --build --wait`（獨立專案，不動 `notes_notes-data`），容器 healthy，`/healthz` 200；`node scripts/check-app.mjs`：**40 項 PASS**。完成後以 `down -v --rmi local` 移除。
- 真實 Chrome（本機 dist 伺服器、全新資料目錄）：`scripts/check-share.mjs` 9 段全部 PASS，其中改寫的一段：未設定帳號權限時登入的名單外帳號開啟公開連結看到唯讀公開頁；擁有者在公開連結下方選「皆可編輯」，視窗只有一個連結且沒有頁面網址；只知道頁面網址仍 404，開啟公開連結後被導向 `/p/<id>` 並可編輯，修改同步到擁有者，列在「與我共用」；子頁連結導向對應頁面；未登入者用同一連結仍只能閱讀；擁有者看到 2 個帳號開啟過；改回「與未登入相同」後立即 404、只能看公開頁；關閉公開連結後帳號選項消失、存取與舊網址失效，重新開啟為新網址且設定歸零；個別成員不受影響。既有 5 支瀏覽器腳本（`check-offline-m9`、`check-offline-sync`、`check-annotation-removal`、`check-sidebar-menu`、`check-app-update`）回歸全部 PASS。
- 沒有驗證的部分：同 M10 段落（實機、行動裝置、反向代理後的限流等）；這一項沒有做獨立審查；沒有以真實的 1.1.1 資料庫檔案做升級演練（只有測試中的合成資料）。正式環境尚未部署。

## 知道連結的本站帳號可唯讀或編輯（2026-11-10，版本 1.1.1）

- 範圍：使用者在 1.1.0 發布後要求於「與本站帳號共用」新增「知道連結的人皆可編輯／唯讀」。實作為已登入本站帳號的連結存取（`page_shares.account_role`、`share_visitors`，migration `0010_share_account_link`）；未登入的公開連結不變。沒有新增或升級任何依賴。
- 本機檢查（Node 22.23.1／npm 10.9.8，做法同下一段）：`npm run typecheck`、`npm run lint`、`npm test`（**36 檔／268 tests**）、`npm run build` 全部通過；`git diff --check` 無問題。
- 新增測試：`tests/server/shares.test.ts` 兩項——開放為唯讀後，名單以外的帳號開啟網址即取得唯讀權限（範圍照舊、不能寫入、可留言），開啟前不出現在任何清單，開啟後列入「與我共用」與 manifest 且摘要與頁面回應相等，擁有者看得到開啟過的帳號，未登入仍 401，只有擁有者能設定；開放為可編輯後任何帳號可改內文與資料列但仍不能改結構、新增子頁、刪除或管理分享，與個別成員的角色取較高者，檔案要先開過頁面才可讀，自行移除後再開啟會回到清單，關閉後透過連結進來的帳號立即失效而個別成員不受影響、開啟紀錄清空。`tests/client/sharing.test.tsx` 的分享視窗測試增加選擇「皆可編輯」、顯示頁面網址與開啟過的帳號、改回「不開放」。
- 容器：`NOTES_PORT=18090 docker compose -p notes-m10-check up -d --build --wait`（獨立專案，不動 `notes_notes-data`），容器 healthy，`/healthz` 200，`/api/version` 回報 1.1.1；`node scripts/check-app.mjs`：**40 項 PASS**。
- 真實 Chrome：`scripts/check-share.mjs` 增加一段（共 9 段，全部 PASS）：開放前名單以外的帳號得到 404；擁有者在分享視窗選「知道連結的人皆可編輯」並看到頁面網址；第四個帳號登入後開啟網址，頁面標示可編輯，修改同步到擁有者，重新載入後列在「與我共用」；未登入仍 401；擁有者看到「1 個帳號開啟過」；改為「不開放」後該帳號立即 404 且清單清空。既有 5 支瀏覽器腳本回歸全部 PASS。
- 沒有驗證的部分：同 M10 段落；另外這一項沒有做獨立審查。正式環境尚未部署。

## M10 分享：公開連結與站內帳號共用（2026-11-10，版本 1.1.0）

- 範圍：使用者以 plan 模式確認並核可的 M10：公開連結（唯讀、無留言、可停用）、以 email 與站內帳號共用（唯讀／可編輯，皆可留言與表情）、可選範圍、可編輯者只改內容、共用筆記也可離線。新增 migration `0009_shares`；沒有新增或升級任何依賴。
- 本機檢查（Node 22.23.1／npm 10.9.8，安裝於暫存目錄後以 `PATH=<暫存>/node_modules/node/bin:<暫存>/node_modules/.bin:$PATH npm run check` 執行）：`npm run typecheck`、`npm run lint`、`npm test`（**36 檔／266 tests**）、`npm run build` 全部通過；`git diff --check` 無問題。開發期間另以本機預設的 Node 24.22.1 反覆執行，結果相同。保留既有的 SQLite experimental 與 Vite 大 bundle 提示。
- 新增伺服器測試 `tests/server/shares.test.ts`：分享管理只限擁有者；以 email 加成員的 404 與限流；我分享的與分享給我的清單；成員看到的頁面不含擁有者的組織資訊；三種範圍對頁面、資料庫與資料列；巢狀分享取最高角色；以隨機樹檢查權限解析與範圍列舉一致；可編輯與唯讀各自能做的事，其餘一律 404；垃圾桶、擁有者停用、移除後失效；資料庫讀取與 `row.*`／`property.*`／`view.*` 操作的權限；留言作者與每人表情；刪除討論的權限；唯讀成員的討論不改動頁面內容與版本（夾帶的區塊內容被忽略）、不能解決別人的討論、每人表情與每頁討論數有上限、時間不能任意回溯；成員存檔 130 次後擁有者的版本仍在頁面歷史；垃圾桶中可移除成員；降級後重送草稿只得到目前可見的狀態；附件歸屬與引用檢查；manifest 與頁面回應的摘要相等；成員草稿的同步與衝突；撤銷後重送 `operationId` 不回任何資料；公開連結的內容清理、檔案標頭、404 一致性、唯讀、停用與換網址、垃圾桶清除、限流。
- 其他新增測試：`tests/shared/shares.test.ts`（範圍規則、公開內容清理含一般連結與表格內的頁面提及、每人表情與舊紀錄、摘要含角色）；`tests/client/sharing.test.tsx`（分享視窗、公開頁面不查詢登入狀態、公開的資料庫唯讀、成員的資料庫權限、共用筆記的離線下載、不可新增子頁、草稿不混入自己的頁面樹、降級與撤銷、與我共用清單）；`tests/client/selectionTools.test.tsx` 增加唯讀成員選字留言：只送出引文與區塊識別碼、編輯器文件不變、畫面在被留言的區塊標示引文。`tests/client/offlineStatus.test.tsx` 修正既有的時序競賽（平行執行時偶發失敗），改為等 manifest 請求送出後再回應。
- 容器：以獨立專案執行 `NOTES_PORT=18090 docker compose -p notes-m10-check up -d --build --wait`（不動本機既有的 `notes_notes-data` volume），容器 healthy；`curl http://127.0.0.1:18090/healthz` 回 200，`/api/version` 回報 1.1.0。`node scripts/check-app.mjs http://127.0.0.1:18090`：**40 項 PASS**（新增 9 項：分享端點需登入、未知公開連結一律 404 且唯讀、公開頁面與公開 API 標示不索引、一般頁面不受影響）。每支瀏覽器腳本前都以 `docker compose -p notes-m10-check down -v` 重建全新資料。
- 真實 Chrome（桌面 1280×900、localhost；`NOTES_PLAYWRIGHT_MODULE=<暫存>/node_modules/playwright-core/index.mjs NOTES_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node scripts/check-share.mjs http://127.0.0.1:18090`）。新腳本以四個互相隔離的瀏覽器情境（擁有者、可編輯者、唯讀者、匿名訪客）執行，8 段全部 PASS：
  1. 擁有者在分享視窗設定範圍、開啟公開連結、加入兩位成員；不存在的帳號被拒絕。
  2. 可編輯者從「與我共用」開啟，修改內文、儲存格並新增資料列；擁有者開著的頁面自動出現修改；成員看不到分享按鈕、新增欄位與編輯視圖。
  3. 唯讀者的編輯器與標題不可輸入；選字後以浮動工具列留言並加表情；頁面的內容與版本都沒有改變（內文沒有任何標記），唯讀者與擁有者的畫面都依引文標示出被留言的文字；唯讀者直接寫入內文回 403；擁有者看到作者，兩人的表情合計為 2。
  4. 匿名訪客開啟公開連結：文件帶 `X-Robots-Tag`；圖片經公開檔案端點載入；沒有留言與標記；私人頁面的標題不在送出的內容中；範圍內連結可前往子頁與資料庫；只使用 `/api/public/…`（與 `/api/version`）；需登入的端點一律 401。
  5. 關閉公開連結後舊網址失效；重新開啟為新網址。
  6. 可編輯者離線編輯共用子頁，離線重新載入後仍在，恢復連線後同步到擁有者。
  7. 可編輯者離線期間被移除：修改沒有寫入擁有者的頁面，草稿留在「離線與同步」可匯出，頁面與附件不再可讀，「與我共用」不再列出。
  8. 全程沒有未捕捉的前端錯誤。
- 回歸（同一映像、各自全新資料）：`scripts/check-offline-m9.mjs`（8 段）、`scripts/check-offline-sync.mjs`（3 段）、`scripts/check-annotation-removal.mjs`（3 段）、`scripts/check-sidebar-menu.mjs`、`scripts/check-app-update.mjs`（4 段，1.1.0 → 暫存測試版 1.1.1）全部 PASS。
- HTTPS overlay：以暫存的自簽憑證執行 `docker compose -p notes-m10-check -f compose.yaml -f compose.https.yaml up -d --build --wait`，兩個容器 healthy；以 `curl -k` 請求 `/s/<43 字元>`、`/api/public/<43 字元>/pages/…` 等位址後，`docker compose logs https` 的存取紀錄顯示為 `/s/-`、`/api/public/-/pages/…`，其他路徑照常記錄。
- 獨立審查：實作完成後由另一個 Claude 工作階段唯讀審查整份差異，並以自行撰寫的測試（放在暫存目錄）實際執行驗證。結論：陌生人、匿名訪客、公開連結持有者與前成員沒有任何可讀寫規則以外內容的途徑；範圍判定、SQL、DTO、生命週期、公開 API 都符合規則。指出兩項高風險、三項中風險與數項低風險，都是「成員對擁有者的頁面能做超出規則的事」，已全部修正並補測試後重跑上述所有檢查：(高) 唯讀成員可藉留言標記把任意內容寫進頁面並使頁面無法開啟——改為唯讀成員完全不寫入頁面，標示改由畫面依引文定位，並為編輯器加上錯誤邊界；(高) 可編輯者可用大量存檔擠掉擁有者的歷史版本——擁有者與成員的版本分開保留；(中) 唯讀留言使正在編輯的人遇到版本衝突——隨第一項消失；(中) 內建 nginx 的存取紀錄含公開連結 token——已遮蔽並實測；(中) 唯讀成員可解決他人的討論、無上限加表情、佔滿討論額度、回溯時間——已限制；(低) 公開內容中連到範圍外頁面的一般連結帶有頁面 id、降級後重送草稿得到當時的回應、垃圾桶中無法移除成員、附件清單連結未限制來源——已修正。未修正而列為已知限制：成員看得到共用頁內頁面提及的標題快照；檔案引用檢查沒有索引（每次讀檔掃描分享範圍內的內文）。
- 沒有驗證的部分：iOS Safari／Android 實體手機與觸控選字（唯讀成員的工具列在觸控裝置上停靠於底部，只有桌面 Chrome 實測）、手機 HTTPS、真實輸入法；大範圍分享（數百頁以上）下檔案引用檢查與 manifest 的耗時；多位成員同時編輯只以版本衝突的單元測試涵蓋，沒有瀏覽器實測；公開頁面的看板與清單視圖只有元件測試，瀏覽器實測的是表格；放在反向代理後面的來源位址限流沒有以實際代理驗證。正式環境尚未部署，migration 只在測試資料庫與可拋棄容器套用過。

## M9 離線擴充：資料庫、留言與附件（2026-11-10，版本 1.0.8，未單獨發布，併入 1.1.0）

- 範圍：使用者指示將新附件上傳、留言與反應、資料庫離線閱讀、資料列離線編輯（值、新增列、列內文）與資料庫結構／視圖離線修改全部列入 M9。新增 migration `0008_offline_receipts`；沒有新增或升級任何依賴。
- 本機檢查（Node 22.23.1／npm 10.9.8，安裝於暫存目錄後以 `PATH=<暫存>/node_modules/node/bin:<暫存>/node_modules/.bin:$PATH npm run check` 執行）：`npm run typecheck`、`npm run lint`、`npm test`（**33 檔／231 tests**）、`npm run build` 全部通過。開發期間另以本機預設的 Node 24.22.1 反覆執行同一組命令，結果相同。保留既有的 SQLite experimental 與 Vite 大 bundle 提示。
- 新增測試：`tests/server/offlineOps.test.ts`（操作只執行一次與重送、逐格合併與衝突、`force`、結構版本、留言附加／表情開關／重複刪除、驗證與 CSRF、他人帳號一律 404、manifest stamp、資料庫快照與批次頁面、附件自選 ID 重送）；`tests/shared/offlineOps.test.ts`（裝置畫面的套用規則可重複套用且與伺服器的視圖修剪一致、操作格式驗證、檔案類型判定與標頭）；`tests/client/outbox.test.ts`（連線直接送出並併入裝置副本、拒絕不保留、離線入列與畫面顯示、斷線以同一 operationId 入列、同範圍排隊、拒絕後擋住同範圍而其他範圍照常、覆蓋與捨棄、結構版本接續且不越過他處的修改、離線新增頁面上的留言等頁面上傳、stamp 變動才下載、線上刪除的處理、有未同步內文的列頁面不被覆蓋、附件先存裝置再上傳一次、不安全類型以沙箱下載、內容遺失會回報、換帳號保留他人未同步的修改）；`tests/client/databaseViews.test.tsx` 增加離線開啟資料庫並修改、新增列與欄位的元件測試。既有測試依新行為更新：儲存格改回報「開始編輯時的值」、留言改送操作、資料列頁面內文改存本機。
- 容器：為了不動到本機既有的 `notes_notes-data` volume，以獨立專案執行 `NOTES_PORT=18090 docker compose -p notes-m9-check up -d --build --wait`（映像以 Dockerfile 的 Node 22.23.1 建置），容器 healthy；`curl http://127.0.0.1:18090/healthz` 回 200，`/api/version` 回報 1.0.8 與更新說明。`node scripts/check-app.mjs http://127.0.0.1:18090`：**31 項 PASS**。每支瀏覽器腳本前都以 `docker compose -p notes-m9-check down -v` 重建全新資料。
- 真實 Chrome（桌面 1280×900、localhost 安全環境例外；`NOTES_PLAYWRIGHT_MODULE=<暫存>/node_modules/playwright-core/index.mjs NOTES_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node scripts/check-offline-m9.mjs http://127.0.0.1:18090`），新腳本 8 段全部 PASS：(1) 首次同步自動下載資料庫結構、資料列與列頁面；(2) 離線開啟資料庫、修改儲存格、新增資料列與欄位，顯示「3 項修改待同步」；(3) 離線開啟此裝置新增的資料列頁面，編輯列內文與屬性；(4) 離線新增留言與表情並標記原文，離線貼上圖片後由 Service Worker 以正式網址顯示（此時伺服器回 404）；(5) 離線重新載入後修改、標記與附件仍在，伺服器資料未變；(6) 恢復連線自動同步，以 API 核對資料列（沿用裝置產生的 ID）、欄位、列內文、留言、反應、筆記內的標記與附件網址、附件 200 `image/png`，佇列清空；(7) 同一格在兩邊都被修改時伺服器保留另一台的值並列為衝突，確認「以我的修改覆蓋」後才寫入；(8) 再次離線修改後恢復連線自動送出，全程沒有未捕捉的前端錯誤。
- 回歸（同一映像、各自全新資料）：`scripts/check-offline-sync.mjs`（3 段）、`scripts/check-annotation-removal.mjs`（3 段，刪除討論的等待條件改為新端點）、`scripts/check-sidebar-menu.mjs`、`scripts/check-app-update.mjs`（4 段，1.0.8 → 暫存測試版 1.0.9）全部 PASS。
- 獨立審查：實作完成後由另一個 Claude 工作階段唯讀審查整份差異（未執行測試，以閱讀程式路徑為準）。結論是沒有重大缺陷；提出六項中低風險與數項小問題，其中會影響資料的都已修正並補測試：刪除討論改為比對留言數（有沒看過的回覆則 409）、斷線後對剛顯示的討論留言不再誤報失敗、捨棄新增列的確認與匯出涵蓋列內文與留言、新列的本機頁面改在入列前建立且下載時會解除卡住的標記、附件被拒時引用它的筆記留在裝置、401／CSRF 中止整輪同步而不記為個別錯誤、核取方塊 false 與空值視為相同、舊版離線介面下離線加入附件會明確拒絕。修正後重新建置映像，上述瀏覽器腳本與 `check-app.mjs` 全部重跑通過，測試數由 228 增為 231。審查未涵蓋：資料格與視圖對話框的介面接線差異、測試與腳本本身、更新過程中新舊離線介面並存、快取媒體的 Range 請求。
- 沒有驗證的部分：iOS Safari／Android 實體手機、手機 HTTPS、真實鍵盤與輸入法；看板拖曳與 5,000 列等級資料庫的離線效能；大檔（數十 MB）附件的離線保存與上傳只有單元測試與極小圖片的瀏覽器實測；多分頁同時同步只做了程式路徑檢查，沒有瀏覽器實測。正式環境尚未部署，migration 只在測試資料庫與可拋棄容器套用過。

## 1.0.6 正式發布前檢查（2026-11-09）

- 使用者指定發布 1.0.6，將未發布工作版 1.0.7 的版號／更新功能與留言修正整併為同一正式版本。package.json、lockfile 根版本、版本 API、更新說明與正式發布文件統一為 **1.0.6**；不建立 v1.0.7 Release。下方工作紀錄中的 1.0.7／1.0.8 保留為當時實測數據，不代表正式發布。
- 在 Node 22.23.1／npm 10.9.8 下重新執行 `PATH=/tmp/notes-node22/node_modules/node/bin:/tmp/notes-node22/node_modules/.bin:$PATH npm run check`：`npm run typecheck`、`npm run lint`、`npm test`（**28 檔／167 tests**）、`npm run build` 全部通過。沒有資料庫 migration；`@tiptap/pm` 直接依賴 exact 3.33.0 與原間接版本一致，沒有升級 BlockNote。保留已知 SQLite experimental 與 Vite 大 bundle 提示。
- `docker compose exec -T app node dist/server/cli.js backup` 成功產生 SQLite 線上備份；`docker compose up --build --wait` 最終容器 healthy。`npm run test:app -- http://127.0.0.1:8080`：**31 項 PASS**，含 `/healthz` 200。`curl -fsS http://127.0.0.1:8080/api/version` 回報 **1.0.6**，且該版本更新資訊同時包含留言修正與版號／更新功能。
- 以最終 1.0.6 production 映像與兩個全新 `/data` tmpfs 容器，重新執行 `scripts/check-annotation-removal.mjs http://127.0.0.1:18084` 與 `scripts/check-app-update.mjs http://127.0.0.1:18085`（Node 22、`NOTES_PLAYWRIGHT_MODULE=/tmp/notes-offline-browser/node_modules/playwright/index.mjs`、`NOTES_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`）。涵蓋留言解決／刪除／最後反應取消、文字／粗體／重疊討論保留、離線重開，以及 1.0.6 → 暫存測試版 1.0.7 的實際兩版升級、失敗重試、待同步草稿／附件／登入保留、多分頁資源與手機側欄版號，全部 PASS。測試版只存在暫存資料，不會發布或修改正式版號；合成帳密未進版本控制或正式 volume。
- `git diff --check` 通過。首次從 1.0.5 或更早版升級，及曾開啟未發布工作版 1.0.7 的本機分頁，均需手動連線重新載入一次，左下角應顯示 v1.0.6。尚未有手機實機、外部 Cloudflare Tunnel 部署切換或真實手機 HTTPS 驗收；詳細範圍沿用下方各功能紀錄。

## 1.0.7 工作版：左下角版號與新版更新 Modal（2026-11-09，最終併入 1.0.6）

- 左下角以 Vite 建置版號標示目前介面；`GET /api/version` 供應已部署版號與繁體中文更新說明，維持 no-store。新版比較採數值比較，同版、較舊版或無效版號不誤報。新版 Modal 自動開啟，中文組字期間延後；同一分頁對相同新版只自動提醒一次，仍可手動重新開啟或檢查。
- 更新前透過 update guards 保存一般筆記標題／內文，阻止無法保存的輸入、未送出留言、資料格、設定表單與附件上傳被重載丟棄；待同步草稿可以持續保留。核對已安裝 worker 的目標版本後才 skipWaiting、等 controllerchange 並重新核對，再只重新載入發起更新的分頁。不清除 IndexedDB、cookie 或附件快取。其他舊分頁保留自己的資源，所有分頁完成更新後才清理舊 shell。
- `PATH=/tmp/notes-node22/node_modules/node/bin:/tmp/notes-node22/node_modules/.bin:$PATH npm run check`：Node 22.23.1／npm 10.9.8 下，`npm run typecheck`、`npm run lint`、`npm test`（**28 檔／167 tests**）及 `npm run build` 全通過；驗收腳本最後補強手機動畫完成與可視範圍斷言後，再執行 `npm run lint` 通過。測試涵蓋版號數值比較、Modal 更新資訊、同版／回滾、稍後與重新開啟、IME、未送出內容阻止更新、真正 autosave 在更新前寫入 IndexedDB、worker 版本不符／下載失敗／另一分頁已啟用新版、舊資源保留與清理。沒有新增依賴或 migration；保留既有 SQLite experimental 與 Vite 大 bundle 提示。
- 真實 Chrome：`NOTES_PLAYWRIGHT_MODULE=/tmp/notes-offline-browser/node_modules/playwright/index.mjs NOTES_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' /tmp/notes-node22/node_modules/node/bin/node scripts/check-app-update.mjs http://127.0.0.1:18085` 全數 PASS。腳本複製當前前端來源至暫存目錄，實際另建測試版 1.0.8，透過本機代理切換兩份前端，後端為全新 `/data` tmpfs 容器。1.0.8 僅為驗收用，正式容器／工作版本仍是 1.0.7，沒有發布測試版或修改工作區版號。
- 瀏覽器驗證：① 桌面側欄左下角是目前版號，透過前景定期檢查自動開啟新版 Modal 及更新內容；② 模擬 worker 503 時留在舊版並顯示可重試錯誤，恢復供應後按立即更新確實載入新 build；③ 刻意阻斷草稿上傳，更新後未同步內容仍在 IndexedDB 且畫面可讀，登入與附件快取保留；④ 另一舊分頁未被重載，仍能讀到自己的舊資源及草稿，主動更新後才移除舊 shell；⑤ 390×844 手機視口開啟側欄後，版號座標確實在可視範圍，沒有未捕捉前端錯誤。合成帳密只存記憶體，測試資料未寫入正式 volume；暫存前端與代理會自動清理。截圖存於 gitignored `.local/validation/app-version-mobile.png`。
- 部署前 `docker compose exec -T app node dist/server/cli.js backup` 線上備份成功。`docker compose up --build --wait` 最終容器 healthy；`npm run test:app -- http://127.0.0.1:8080` **31 項 PASS**，含 `/healthz` 200。`curl -fsS http://127.0.0.1:8080/api/version` 實測回報 1.0.7 及更新內容。`git diff --check` 通過。
- 限制：未做 iPhone Safari／Android 實機、手機 HTTPS 或外部 Cloudflare Tunnel 的部署切換驗收。一般明文 HTTP 不啟用 PWA，會以重新載入更新；關閉網站後不保證即時通知。首次從尚無偵測程式的舊介面升級，需手動連線重載一次；後續版本才會自動提示。只發布 GitHub Release 不會更新伺服器容器。

## 1.0.6 留言取消與黃色標記修正（2026-11-09）

- 重現：對獨立暫存容器執行 `scripts/check-annotation-removal.mjs`，點「標示為已解決」後確認伺服器 `resolved=true`，但實際 Chrome 背景仍為 `rgb(255, 240, 181)`，斷言「已解決的留言不應繼續顯示黃色標記」失敗。新增的刪除 API／介面測試也在修正前分別以 404／找不到「刪除整則討論」失敗。原因為 annotation 樣式無條件著色，未依討論狀態顯示，且沒有刪除入口。
- 修正：改以 ProseMirror decorations 顯示未解決且仍有內容的討論，背景狀態刷新不改寫筆記 JSON；刪除成功才從目前編輯器移除該討論 anchor，保留文字、其他格式與重疊討論。已解決與空反應討論可由「包含已解決／已取消」查看。按帳號／頁面保存最後讀取過的 active IDs，供離線重開使用；不新增討論離線寫入功能。版本更新至 1.0.6，直接宣告 exact `@tiptap/pm@3.33.0`（原間接依賴已是相同版本），沒有升級 BlockNote 或新增 migration。
- `PATH=/tmp/notes-node22/node_modules/node/bin:/tmp/notes-node22/node_modules/.bin:$PATH npm run check`：Node 22.23.1／npm 10.9.8，`npm run typecheck`、`npm run lint`、`npm test`（**25 檔／148 tests**）與 `npm run build` 全通過。新增刪除確認／取消、409 保留留言與草稿、移除 anchor 不損文字／粗體／重疊標記的測試，以及刪除 API 的登入、擁有者、CSRF、If-Match 與版本衝突測試。既有手機顏色、連結、格式與選取範圍測試均通過。直接修改編輯區 DOM 屬性的試驗曾造成手機顏色測試失敗，已撤除並改用 decorations；沒有留下 `[DEBUG-...]` 探針。保留既有 SQLite experimental 與 Vite 大 bundle 提示。
- 真實 Chrome：`NOTES_PLAYWRIGHT_MODULE=/tmp/notes-offline-browser/node_modules/playwright/index.mjs NOTES_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' /tmp/notes-node22/node_modules/node/bin/node scripts/check-annotation-removal.mjs http://127.0.0.1:18084`，使用全新測試容器及 `/data` tmpfs：① 解決後取消黃色，連線／離線重載維持取消，重新開啟恢復；② 取消刪除確認不刪資料，確認後刪除，保留文字／粗體／重疊討論，且伺服器內容不再含已刪 anchor；③ 移除唯一表情且沒有留言後取消黃色，連線／離線重載不復發，沒有未捕捉前端錯誤。全部 PASS；合成帳密僅存程序記憶體，沒有使用正式資料。
- 更新前 `docker compose exec -T app node dist/server/cli.js backup` 線上備份成功。`docker compose up --build --wait` 建置完成且 healthy；`curl -fsS http://127.0.0.1:8080/api/version` 回報 `1.0.6`。`npm run test:app -- http://127.0.0.1:8080`：**31 項 PASS**，含 `/healthz` 200。`git diff --check` 通過。
- 限制：沒有 iPhone Safari／Android 實體手機與真實 IME／鍵盤驗收；Chrome 使用 localhost 的安全環境例外。離線只沿用此裝置最後讀取過的標記狀態，無法離線取得其他裝置新改動的討論。更新後需關閉所有舊分頁／網站 App 再連線開啟，讓新 Service Worker 接手。

## 1.0.5 自動下載、同步提示與附件容量（2026-11-09）

- 版本更新為 1.0.5；沒有新增依賴、沒有資料庫 migration。新增 `/api/offline/manifest`，依帳號提供不含內文的版本與頁面資訊，支援一般筆記增量下載、遠端刪除標記、衝突草稿保留與同步完成時間。附件上傳預設改為 90 MB，離線附件預設 500 MB 總容量、可設定 100–10,000 MB。
- `PATH=/tmp/notes-node22/node_modules/node/bin:/tmp/notes-node22/node_modules/.bin:$PATH npm run check`：Node 22.23.1／npm 10.9.8 下，`npm run typecheck`、`npm run lint`、`npm test`（**25 檔／142 tests**）、`npm run build` 通過。仍有既有 SQLite experimental 與主 bundle 超過 500 kB 提示。
- 測試涵蓋：只下載新增或 metadata／版本變動的筆記；失敗退避與手動重試；部分下載失敗不宣稱完成；跨帳號 manifest／下載途中切換帳號；pending 衝突草稿不被下載覆蓋；刪除的乾淨副本不可離線開啟、後續本機救援草稿仍可讀；處理衝突時另一分頁改動草稿不被捨棄。伺服器驗證 ancestor 改名、搬移、刪除與帳號隔離，明確覆蓋仍核對 title baseline。Service Worker 驗證超過 20 MB、超過 100 個附件、依總容量淘汰、並行寫入與降低容量清理；狀態 UI 驗證傳輸中／失敗不冒稱完成，成功有完成提示與時間。
- 升級前執行 `docker compose exec -T app node dist/server/cli.js backup`，SQLite 線上備份成功。`docker compose up --build --wait` 完成並 healthy；`docker compose exec -T app printenv MAX_UPLOAD_MB` 實際回報 90。沒有輸出其他環境設定，沒有直接複製使用中的 SQLite。
- `npm run test:app -- http://127.0.0.1:8080`：**31 項 PASS**，包含 `/healthz` 200、PWA 資源、安全標頭與新增 manifest 的未登入 401。
- 真實 Chrome 手機視口（390×844、觸控、localhost 安全環境例外），對 production 映像的獨立容器與 `/data` tmpfs 執行 `NOTES_PLAYWRIGHT_MODULE=/tmp/notes-offline-browser/node_modules/playwright/index.mjs NOTES_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' /tmp/notes-node22/node_modules/node/bin/node scripts/check-offline-sync.mjs http://127.0.0.1:18083`：首次自動下載、切回前景下載遠端新增與修改、未造訪筆記離線開啟、本機草稿重載、恢復連線衝突保留／匯出、明確覆蓋及歷史保存、明確載入線上版本、**21 MB 真實附件上傳與 Service Worker 快取**、容量設定改為 700 MB，皆 PASS，沒有未捕捉的前端錯誤。合成帳密僅存在程序記憶體，沒有寫入正式 volume 或文件。
- 驗收腳本初輪最後一項曾因全形「／」選取條件寫成半形而逾時；修正選取條件、使用全新測試實例後全數通過。新增腳本的瀏覽器 globals lint 問題已改為 globalThis 存取並重跑完整檢查。
- 限制：沒有 iPhone Safari／Android 實體手機、手機 HTTPS、真實鍵盤／IME、OS 背景終止與儲存回收實測；也沒有從外部 Cloudflare Tunnel 實傳 90 MB 或測量瀏覽器可用的最大快取容量。大檔實測為本機 21 MB，Cloudflare 部署仍受其帳號與代理設定限制。手機關閉後不保證背景同步。升級後關閉所有舊分頁／網站 App 再連線開啟，讓新的 Service Worker 接手。

## 1.0.4 發布前檢查（2026-11-09）

- package.json 與 package-lock.json 根套件版本同步為 1.0.4；本版新增的測試依賴 `fake-indexeddb` 固定為 6.2.8，其餘依賴版本未變更。
- 以 Node 22.23.1／npm 10.9.8 執行 `npm run check`：`npm run typecheck`、`npm run lint`、`npm test`（24 檔／129 tests）、`npm run build` 全過。
- 升級前執行 `docker compose exec -T app node dist/server/cli.js backup`，SQLite 線上備份成功；沒有直接複製使用中的資料庫。
- `docker compose up --build --wait`：1.0.4 建置成功、容器 healthy。`npm run test:app -- http://127.0.0.1:8080` 30 項 PASS，包含 `/healthz` 200。`curl -fsS http://127.0.0.1:8080/api/version` 實測回報 `{"version":"1.0.4"}`。
- 本輪功能與真正瀏覽器驗收結果見下方 M8 及桌面選單段落；版本更新只調整套件版本與文件，未把先前沒有執行的手機實機驗收記為通過。發布說明見 [releases/1.0.4.md](releases/1.0.4.md)。

## 桌面側欄「…」選單移入後消失修正（2026-11-09）

- 重現：在真實 Chrome 的桌面視口，對一列一般筆記點「…」，再將滑鼠移入「加入最愛」。`scripts/check-sidebar-menu.mjs` 在修正前穩定失敗，訊息為「滑鼠從『…』移入選單後，選單必須保持開啟」。右鍵選單沒有相同定位按鈕問題。
- 原因：側欄按鈕原本只在頁面列 hover／focus-within 時顯示。選單透過 Portal 顯示於列外，滑鼠與焦點移入後，按鈕父容器變成 `display: none`；Menu 的 `aria-expanded` 仍為 true，但 Mantine 的 hideDetached 將選單也隱藏。僅在測試瀏覽器暫時固定按鈕顯示，即可讓移入檢查通過，確認是定位按鈕的可見性問題。
- 修正：`PageTreeItem` 明確追蹤目前選單開啟狀態，列上加入 `data-menu-open`；CSS 在開啟期間保留動作按鈕。保留正常的定位／關閉機制，不把整個側欄按鈕永久顯示。
- 保留真實瀏覽器迴歸腳本 `scripts/check-sidebar-menu.mjs`，只對一次性測試容器執行；合成帳號隨機產生，憑證僅留暫存檔，不輸出或提交。驗證滑鼠移入後持續可見、加入最愛確實送達伺服器、右鍵選單、Escape、鍵盤 Enter 開啟及點外關閉。修正後結果：`PASS 桌面「…」移入選單、選單操作、右鍵、Escape、鍵盤開啟與點外關閉`。測試會等待選單關閉動畫及 API 回應，避免把動畫中的兩個選單誤判為重複元素。
- 本輪命令：以 Node 22.23.1／npm 10.9.8 執行 `npm run check`，其中 `npm run typecheck`、`npm run lint`、`npm test`（24 檔／129 tests）與 `npm run build` 全通過；瀏覽器腳本最後調整後再跑 `npm run lint` 通過。`docker compose up --build --wait` healthy；`npm run test:app -- http://127.0.0.1:8080`（含 `/healthz` 200）30 項 PASS。
- 瀏覽器執行方式（需先啟動資料可拋棄的測試實例）：`NOTES_PLAYWRIGHT_MODULE=/tmp/notes-offline-browser/node_modules/playwright/index.mjs NOTES_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node scripts/check-sidebar-menu.mjs http://127.0.0.1:18082`。也可在已安裝 Playwright／Chromium 的環境省略這兩個環境變數。Playwright 沒有加入正式依賴。
- 預防：使用 hover 顯示的按鈕作為 Portal 選單定位點時，開啟狀態也必須維持定位點可見。這類 CSS 與浮動定位交互作用需用真實瀏覽器驗證；jsdom 的 Mantine test 環境會略過 hideDetached，不能單獨涵蓋本次症狀。暫時 CSS／除錯輸出均已移除，沒有更動資料庫或同步協定。

## M8 離線筆記（2026-11-09）

- 環境：macOS；最終檢查使用暫存安裝的 Node **22.23.1**、npm **10.9.8**，符合專案 engines。正式容器也使用鎖定的 Node 22.23.1 映像。最初本機預設 Node 24 的試跑不作為唯一驗收依據。
- `PATH=/tmp/notes-node22/node_modules/node/bin:/tmp/notes-node22/node_modules/.bin:$PATH npm run check`：依序執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run build`，全數通過；**24 檔／129 tests**。最後補上 PWA 靜態檢查後再執行 `npm run lint`，通過。建置仍有既有主 bundle 超過 500 kB 提示；Node 22 的 node:sqlite experimental 提示保留，沒有隱藏測試失敗。
- 新增 `tests/server/offline.test.ts`：同操作重送不重複建頁／增版；內文與標題基準衝突；明確覆蓋保存快照；登入、CSRF、If-Match、跨帳號 404、無效內容交易回退、拒絕資料庫離線同步。既有 migration 測試確認新 migration 只跑一次；搜尋 migration 的預期清單加入 0007。
- 新增 `tests/client/offline.test.ts`，使用 exact `fake-indexeddb@6.2.8`：持久草稿與新頁、重新載入模組後從 IndexedDB 讀回、未持久保存 CSRF、回應遺失時固定 operationId、送出期間繼續輸入不被舊回應清除、409 保留草稿與明確覆蓋、另一分頁草稿比較、404 不回退、不同登入不重播、失效登入保留草稿、登出清除及父頁先於子頁同步。
- 新增 `tests/client/offlineAutosave.test.ts`：真正 autosave hook 與 IndexedDB 整合，驗證本機保存後顯示待同步；載入另一分頁草稿不會刪掉該分頁尚未同步的內容。新增 `tests/server/offlineShell.test.ts`：以 Service Worker 事件模擬器確認離線深連結回介面、JSON／寫入不攔截、附件帳號隔離、401 不回退快取及下載／sandbox 標頭保留。這些模擬不等同手機實機。
- `docker compose up --build --wait`：最終映像建置成功，`notes-app-1` healthy。`curl -fsS http://127.0.0.1:8080/healthz` 回 `ok`、HTTP 200。`npm run test:app -- http://127.0.0.1:8080`：**30 項 PASS**，含新增 manifest、Service Worker JavaScript／重新驗證標頭、已替換的離線資源清單與圖示。
- 真正 Chrome（無頭模式，390×844、觸控手機視口）對最終 production 映像的隔離容器實測：① 連線建立筆記後切斷網路，編輯並確認 IndexedDB 寫入，離線重新載入仍有標題與內文；② 離線新增另一篇，完成保存後重新載入仍有內容；③ 恢復連線後自動同步，直接從伺服器 API 回讀兩篇內容均正確；④ 手機離線修改，同時透過另一 HTTP 請求修改伺服器，再連線會顯示衝突並保留手機草稿；點選明確覆蓋後，手機內容同步成功，遠端被覆蓋內容可從歷史 API 回讀。四組流程全部通過。
- 瀏覽器使用本機 `.local/validation/offline-smoke.mjs`，Playwright **1.65.0** 裝在 `/tmp/notes-offline-browser`，未加入正式依賴；合成帳號與密碼皆隨機產生，不輸出到紀錄。測試使用 `notes-offline-smoke` 一次性容器與 `/data` tmpfs，沒有把合成帳號寫進正式 volume。手機版截圖存於 gitignored `.local/validation/offline-mobile.png`。
- 瀏覽器腳本初版曾在新頁面導向前輸入舊頁面，及以未完成的 UI 狀態作為保存完成依據；已修正為等待新 URL，並核對當前頁面的 IndexedDB 內容後才重載，最終重跑通過。另補強標題編輯期間不被背景載入清除、按 Enter／失焦完成標題保存。
- 限制：尚未用 iPhone Safari、Android 實體手機、真實 IME／鍵盤、手機 HTTPS、OS 背景終止／空間回收驗收。本次 Chrome 使用 localhost 的安全環境例外，不能把它當成手機明文 HTTP 也支援。PWA 附件有 20 MB／檔及最近 100 檔限制；資料庫、留言、新附件上傳與其他頁面設定不納入離線修改。操作說明見 [OFFLINE.md](OFFLINE.md)。

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

## Code review 與資安修正（2026-11-10）

- 範圍：對 1.0.6 做整體 code review 與資安檢查後的修正，之後以 1.0.7 發布（見下一段）。問題清單與逐項狀態在本機的 `.local/CODE_REVIEW_2026-11-10.md`（不進版本控制）。
- 資安：全站請求大小上限（帳號端點 64 KB、JSON 8 MB、附件依 `NOTES_MAX_UPLOAD_MB`，chunked 也計數）；來源位址改取 `X-Forwarded-For` 最後一段並新增 `NOTES_CLIENT_IP_HEADER`，nginx 改為覆寫該標頭；登入限制改為「來源＋帳號」5 次、帳號總計 30 次，他人猜錯不再鎖住本人；登入／註冊檢查同源 `Origin` 並要求 `application/json`；邀請碼先驗證再寫入使用者；新增選用的 `NOTES_SETUP_TOKEN` 保護第一個管理者帳號；每小時清除過期 session；登入後導向只接受站內路徑。
- 離線與自動保存：輸入法組字中離開頁面／切背景會保存已輸入內容，連續組字最久 5 秒保存一次；資料列頁面不再把自己的保存當成遠端更新；衝突中繼續輸入的一般筆記仍存入裝置，無法存入時離開前先詢問；只改圖示／封面／最愛／搬移不再重載編輯器；被拒絕的草稿重試時送出修改後的內容；線上已刪除的筆記清除本機內文；換帳號時不再刪除另一帳號的未同步草稿，並移除其已同步副本與附件快取；還原歷史前先保存並同步。
- Service Worker：舊版不再刪除等待中新版的離線快取，啟用時補回缺少的介面檔；附件先回應再背景快取、可用 ETag 重新驗證、相同內容不重寫；不把 HTML 回應快取成資產。伺服器對不存在的 `/assets/*` 回 404。
- 其他：修改選項只移除指向已刪除選項的篩選，保留排序；資料庫仍在垃圾桶時拒絕單獨還原其資料列；標題輸入後立即離開仍會送出；斜線選單的子頁面可離線建立，失敗時顯示錯誤。
- 驗證中另外發現並修正：HTTPS overlay 的 nginx 把請求內容暫存到 16 MB 的 tmpfs，超過約 16 MB 的附件上傳回 500（`pwrite() ... No space left on device`）。改為串流轉送（`proxy_request_buffering off`、`proxy_max_temp_file_size 0`）。
- 實際命令：`npm run check`（typecheck、lint、test、build）全部通過，測試 30 檔／198 tests（新增 `tests/server/hardening.test.ts` 14 項、`tests/client/reviewFixes.test.tsx` 12 項、`tests/server/offlineShell.test.ts` 新增 5 項）。新增的客戶端測試在還原 `useAutosave.ts` 與 `offline/notes.ts` 後有 10 項失敗，確認能擋住回歸。`npm audit --omit=dev` 0 個漏洞。
- 容器：以獨立專案名稱與埠啟動（`docker compose -p notes-review -f compose.yaml -f compose.https.yaml up -d --build --wait`，自簽憑證、暫用 volume，未動到正式的 `notes_notes-data`），app 與 nginx 皆 healthy，`/healthz` 兩端 200，`node scripts/check-app.mjs http://127.0.0.1:18480` 31 項 PASS。經 nginx 實測：未登入送 300 MB（含 chunked）到登入端點 413 且記憶體維持約 29 MiB；輪替偽造 `X-Forwarded-For` 仍在額度用完後回 429；跨站 `Origin` 登入 403、`text/plain` 登入 415 且不設 cookie；已註冊與未註冊 email 搭配無效邀請碼回應相同；150 MB 上傳（上限 90 MB）413；50 MB 上傳 201 且下載回來內容相同。驗證後已 `down -v --rmi local` 移除。
- 限制：沒有實際瀏覽器、實體手機或真實輸入法的驗收；輸入法、離頁攔截與 Service Worker 行為以 jsdom／模擬環境測試為準。正式環境尚未重新部署。

## 1.0.7 發布前檢查（2026-11-10）

- `package.json` 與 `package-lock.json` 根套件版本同步更新為 1.0.7（`npm version 1.0.7 --no-git-tag-version`），沒有調整任何依賴版本；`src/server/releases.ts` 新增 1.0.7 的更新資訊，發布說明見 `docs/releases/1.0.7.md`。
- `npm run check`（typecheck、lint、30 檔／198 tests、build）全部通過；建置出的 `sw.js` 版號為 1.0.7。
- 容器：`docker compose -p notes-review up -d --build --wait`（獨立專案名稱、埠 18480、暫用 volume）healthy，`/healthz` 200，`GET /api/version` 實測回 1.0.7 與本版更新資訊，`node scripts/check-app.mjs http://127.0.0.1:18480` 31 項 PASS；驗證後已移除，未動到正式的 `notes_notes-data`。HTTPS overlay 的實測沿用上一段（程式碼相同，只差版號）。
- 限制沿用上一段：沒有實際瀏覽器、實體手機或真實輸入法的驗收；正式環境需另行重新部署。
