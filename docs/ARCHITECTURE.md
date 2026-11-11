# 架構與里程碑

更新：2026-11-11。接手請先讀 [HANDOFF.md](HANDOFF.md)。

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
| 資料庫 | 資料列是 `kind='row'` 頁面，七種屬性存於 `row_values`；伺服器以 JS 排序／AND 篩選，最多 5,000 列（含垃圾桶），每批最多 200 列 |
| 匯入 | 伺服器端 markdown-it → 區塊 JSON；JEX（tar）與 Markdown 匯出（zip）；以 `import_key` 冪等 |
| 部署 | 單容器、`/data` named volume、唯讀根檔案系統、uid 101、`cap_drop ALL`；HTTPS 以 nginx overlay |

資料模型、API、自動保存協定與安全規則的完整說明以程式與本文件為準；部署、備份與 HTTPS 見 [DEPLOY.md](DEPLOY.md)。

## 里程碑

| 里程碑 | 範圍 | 狀態 |
|---|---|---|
| M0 骨架與容器 | 套件與設定、Hono `/healthz`、migration `0001_init`、Vite 骨架、Dockerfile／compose、AGENTS.md | 已驗證 |
| M1 帳號 | 註冊（邀請碼、第一位為管理者）、登入／登出／me、session、CSRF、速率限制、管理者邀請碼與使用者管理、登入／註冊／設定頁 | 已驗證（API 測試＋容器 curl＋瀏覽器） |
| M2 頁面與編輯器 | 頁面樹、CRUD、搬移、最愛、垃圾桶、麵包屑；BlockNote 完整 schema、IME 防護、自動保存協定、深淺色 | 已驗證；連續存檔、雙分頁兩種解法、遠端同步及覆蓋快照已補測 |
| M3 檔案與頁面標頭 | 上傳／提供、圖片與檔案區塊、封面、圖示、`@` 頁面提及 | 已驗證主要流程；圖示本機資料、封面位置、貼圖、附件與提及皆重測，下載事件觀測限制見 VALIDATION |
| M4 搜尋 | 文字擷取、FTS、Ctrl+K 指令面板 | 已完成並驗證（API／客戶端測試、既有索引 migration、容器與瀏覽器） |
| M5 資料庫 | 屬性、列、表格視圖含排序篩選、列頁面 | 已完成並驗證：七種型別、視圖保存、虛擬捲動、鍵盤、列頁面與雙分頁屬性衝突；76 tests／容器／瀏覽器通過 |
| M6 Joplin 匯入 | 管線、進度頁、報告 | 已取消（使用者決定不做；`import_jobs` 表與 `markdown-it`、`tar`、`fflate` 依賴保留但未使用） |
| M7 收尾 | 頁面歷史、手機版、快捷鍵、小字體、帳號稽核修正、備份 CLI、靜態檢查、CSP 稽核、HTTPS 冒煙、文件 | 已完成並驗證（見 VALIDATION 的 M7 段落） |
| M8 離線筆記（使用者追加授權） | PWA 離線介面、一般筆記本機保存／新增／標題與內文編輯、前景自動同步、版本衝突與草稿救援 | 已實作，驗證結果見 VALIDATION 的 M8 段落 |
| M9 離線擴充（使用者 2026-11-10 追加授權，全部項目） | 新附件上傳、留言與反應、資料庫離線閱讀、資料列值／新增列／列內文離線編輯、資料庫結構與視圖離線修改；可重送的操作佇列、逐格衝突比對、待同步清單的重試／覆蓋／匯出／捨棄 | 已實作，驗證結果見 VALIDATION 的 M9 段落 |
| M10 分享（使用者 2026-11-10 追加授權） | 公開連結（唯讀、無留言、可停用並換網址）、以 email 與站內帳號共用（唯讀／可編輯，皆可留言）、可選範圍（此頁面／含子頁面／含資料庫）、留言作者與每人表情、共用內容的離線下載與同步；1.1.1 追加「知道連結的本站帳號皆可唯讀／編輯」，1.1.2 改為公開連結底下的設定（共用同一個連結） | 已實作，驗證結果見 VALIDATION 的 M10 段落 |
| 頁面內尋找與取代（使用者 2026-11-11 要求） | 筆記頁以 Ctrl／⌘+F 開啟的尋找列（計數、上下一個、取代、全部取代），取代瀏覽器內建的尋找；唯讀共用頁與公開連結只能尋找 | 已實作，驗證結果見 VALIDATION 的對應段落 |
| 頂列顯示最後編輯時間（使用者 2026-11-11 要求） | 筆記頁頂列在保存狀態旁顯示「已於 4 小時前 編輯」，手機寬度列在頁面選單底部 | 已實作（版本 1.1.5），驗證結果見 VALIDATION 的對應段落 |
| 分頁標題與圖示跟著頁面（使用者 2026-11-11 要求） | 瀏覽器分頁顯示「頁面標題 \| Notes」與頁面的表情圖示，沒有圖示時顯示 LOGO | 已實作（版本 1.1.6），驗證結果見 VALIDATION 的對應段落 |
| 選取文字後右鍵恢復瀏覽器選單（使用者 2026-11-11 要求） | 移除 1.0.2 加入的「桌面對選取文字按右鍵改開格式面板」攔截；選取時格式面板照常自動出現 | 已實作（版本 1.1.7），驗證結果見 VALIDATION 的對應段落 |
| 強制更新與更新紀錄（使用者 2026-11-11 要求） | 發現新版後先儲存再顯示更新視窗，取消「稍後更新」；左下角版號改為開啟更新紀錄 Modal | 已實作（版本 1.1.7），驗證結果見 VALIDATION 最上方段落 |

## 驗證紀錄

見 [VALIDATION.md](VALIDATION.md)。

## M8 離線筆記協定

- `src/client/offline` 負責 IndexedDB 草稿、下載快取與同步佇列；資料按帳號隔離。登入只持久保存使用者資料，不保存密碼、session cookie 或 CSRF token。已下載筆記與草稿維持 BlockNote JSON，伺服器 SQLite 仍是跨裝置正式內容。
- 先將標題／內文寫入 IndexedDB，再顯示「已存此裝置，待同步」。同步完成才顯示「已同步」；本機儲存失敗不冒稱已保存。離線第一次開啟尚未下載的頁面顯示明確訊息。
- `PUT /api/offline/pages/:id` 帶 `If-Match`、`operationId`、`baseVersion`、`baseTitle`、`parentId`、標題與區塊內容。新筆記先在客戶端分配 UUID，`baseVersion=null`／`If-Match: "0"`；既有筆記同時比對內文版本與標題基準。只支援 `kind=page`。
- migration `0007_offline_operations` 保存各帳號／頁面最後一次成功操作的回應，與頁面更新在同一交易內提交。回應遺失時以同一 operationId 重送，不重複建頁／增版；既有 ID 不會被建立流程覆蓋。送出期間的新輸入維持待同步，確認舊操作後才採用其版本建立下一筆操作。新父頁會先於子頁同步。
- 同步前重新取得 `/api/auth/me` 與 CSRF，核對佇列擁有者；401 不以本機資料冒充有效登入。已知登入失效會關閉離線入口，但保留同帳號草稿供重新登入救援。登出前若有待同步內容會阻止登出；同步清單提供匯出與明確確認後捨棄，成功登出清除本機筆記及附件快取。跨分頁帳號異動會清除另一分頁的登入畫面與 Query 快取。
- IndexedDB 交易比較草稿 revision，舊分頁不得靜默替換另一分頁的草稿。伺服器 409 停止自動重送，保留草稿；使用者選擇載入最新版本或明確覆蓋。覆蓋仍核對新 head 並強制保存被覆蓋內容的快照；他人頁面、已刪頁面、驗證錯誤也保留本機草稿供匯出。
- 可見頁面恢復連線、重新開啟與切回前景時自動上傳及下載更新。`GET /api/offline/manifest` 依 user_id 回傳樹、一般筆記版本／metadata／麵包屑、帳號 ID 與實際上傳上限，不讀取筆記內文；前端比對後只 GET 新增或變動的筆記，每分鐘檢查一次，待上傳佇列每 15 秒檢查。傳輸序列化，失敗以 15 秒起算指數退避至 5 分鐘（或更長的伺服器 retryAfterSeconds）；手動重試可立即檢查。沒有假設 `navigator.onLine` 等於伺服器可達，也不依賴 Background Sync，不保證關閉或鎖屏後即時同步。
- 自動下載不覆蓋 pending 草稿；伺服器已移除的乾淨筆記標記 removed，離線讀取回 404，保留基準供尚未 flush 的編輯器救援。有衝突的草稿保留並停止該篇自動上傳。只有全部下載成功、無 pending 草稿且沒有儲存錯誤時，才記錄完整同步時間並顯示完成；網路失敗不誤報為本機儲存錯誤，也不顯示舊成功狀態冒充本輪完成。
- Vite 建置輸出 manifest 與版本化 Service Worker，預快取主介面及所有本機動態資源。API JSON 不進共用 Cache Storage。附件只在成功授權且擁有者一致時寫入帳號獨立快取，改採每裝置／每帳號 500 MB 預設總容量，可調 100–10,000 MB（IndexedDB `attachments:<userId>`），不限制 20 MB／檔或 100 檔。Service Worker 序列化寫入，依 Content-Length 加總並清除較早快取，降低設定容量後以 message 觸發清理；單檔大於預算只在線上提供。401／404 不回退快取，下載與 sandbox 標頭保持原樣。檔案 HTTP 快取為 `private, no-cache`，避免不同登入共用未重新授權的瀏覽器快取。上傳預設 90 MB，與裝置快取設定獨立。
- M8 當時一般筆記以外的操作都需伺服器；資料庫、列屬性、留言與新附件上傳已由 M9 納入離線（見下節），搜尋、歷史、最愛、搬移、垃圾桶、圖示／封面與新增資料庫仍需伺服器。手機正式使用必須 HTTPS；私人瀏覽、手動清除網站資料與裝置空間不足可能導致本機內容不可用。更多操作限制見 [OFFLINE.md](OFFLINE.md)。

## M9 離線擴充協定（1.0.8）

- **操作，不是草稿**：資料庫與留言的修改是小而可重送的操作（`src/shared/offline.ts` 的 `offlineOpSchema`：`row.create`／`row.update`、`property.*`、`view.*`、`annotation.*`）。新資料列、欄位、視圖、討論、留言與附件的 ID 一律由用戶端產生。`POST /api/offline/ops` 帶 `operationId`、`force` 與一項操作；migration `0008_offline_receipts` 記錄各帳號已執行的 operationId（保留 30 天），與操作在同一交易提交。重送同一 operationId 不再執行，只回傳目標目前的狀態；失敗的操作不留紀錄。所有服務仍以 `user_id` 查詢，他人資料回 404。
- **衝突判定**：`row.update` 每格帶 `{ base, value }`，伺服器值等於 `value` 視為已套用、等於 `base` 則寫入，否則 409 並列出衝突欄位，整項操作不寫入；列名稱同理。結構操作帶 `baseVersion`（`schema_version`）。`force` 只在使用者於待同步清單明確選擇「以我的修改覆蓋」時設定，略過上述比對但仍驗證內容。留言操作不比對版本：留言以用戶端 `messageId` 附加一次、表情帶明確的 `on`、已解決取最後一次；刪除帶使用者看到的留言數，伺服器上留言較多（有沒看過的回覆）則 409，已不存在的討論可重複刪除；既有 REST 端點（`If-Match`）行為不變。
- **用戶端佇列**（`src/client/offline/outbox.ts`）：`submitOp` 在連線且同一範圍（`db:<id>` 或 `ann:<pageId>`）沒有待送操作時直接送出，拒絕會回報給呼叫端且不保留；連線失敗則以同一 operationId 存入 IndexedDB（`op:<userId>:<排序鍵>`）。同一範圍的操作序列化送出；被拒絕的操作留下原因並擋住同範圍後續操作，其他範圍照常。結構操作成功後，接續其後、以前一版為基準的操作改用新版本；基準更舊的操作不改寫，輪到時回報衝突。
- **裝置副本與畫面**：`db:<userId>:<id>` 保存 `{ stamp, meta, rows }`，`annotations:<userId>:<pageId>` 保存討論。顯示時以 `applyDatabaseOp`／`applyAnnotationOp`（純函式、可重複套用、不拋例外）把待送操作疊在副本上。伺服器確認的操作會併入副本並以回應為準。資料庫與留言的查詢在沒有待送操作且連得上時讀伺服器，否則讀裝置副本並標示；排序與篩選用共用的 `evaluateRows`。
- **下載**：manifest 增加 `databases: { id, stamp }[]` 與 `annotations: { pageId, stamp }[]`（stamp 由結構版本、列數、列的屬性／內文版本總和與最後更新時間組成）。stamp 改變才 `GET /api/offline/databases/:id`（結構、全部資料列、資料庫頁面、列頁面摘要），再以 `GET /api/offline/pages?ids=`（每批 50）下載摘要不同的列頁面；全部存好才記錄 stamp。有待同步內文的列頁面不被覆蓋；線上刪除的乾淨副本標記 removed。
- **列頁面**：`kind='row'` 的內文與一般筆記同樣先寫入 IndexedDB 再經 `PUT /api/offline/pages/:id` 同步；列名稱屬於儲存格，走 `row.update`，該端點對列不比對也不修改標題。離線新增的列先建立 `localOnly` 的本機頁面（基準版本 1，與伺服器新列相同），`row.create` 執行後才同步其內文。
- **附件**（`src/client/offline/uploads.ts`）：`POST /api/files` 接受用戶端指定的 `id`，重送回傳同一檔案（200），他人已用的 ID 回 409。離線時檔案存入 Cache Storage `notes-uploads-<userId>`，鍵為正式網址，標頭由共用的 `src/shared/files.ts`（magic bytes 判定、只有四種圖片 inline、其餘 attachment＋`sandbox`）決定；Service Worker 只在伺服器回 404 或連線失敗、且目前登入者是擁有者時由此回應。上傳成功後移入一般附件快取。
- **同步順序**：附件 → 操作佇列 → 筆記／列內文草稿 → 再跑一次操作佇列（離線新增頁面上的留言須等頁面建立）→ 下載。被伺服器拒絕而仍留在裝置上的附件，引用它的筆記不會送出。連線失敗、401 或 CSRF 被拒（同步途中換了登入）會中止整輪同步稍後重試，不記為個別項目的錯誤。任何待送項目存在時不宣稱同步完成，並阻止登出；換帳號時保留他人尚未同步的操作與附件，只清除乾淨副本。

## 介面版號與更新協定（1.0.6）

- 左下角版號由 Vite 在建置時從 package.json 注入，代表目前執行的前端版本；不以 `/api/version` 的伺服器版號冒充目前介面版本。公開 `/api/version` 回 `{ version, releases: [{ version, title, changes }] }`，維持 no-store，只回已部署版本及以前的更新資訊，沒有使用者資料。
- `src/client/updates` 每分鐘於前景檢查版本，並於開啟、恢復連線、切回前景與收到 controllerchange 通知時重查；只有數值比較較新的版本會進入更新流程，同版／回滾不提示。
- **先儲存、再出現、不能延後**（使用者 2026-11-11 要求，取代原本的「稍後更新」）：發現新版後先執行元件註冊的 update guards（保存筆記標題／內文）、等候進行中的 Query mutations 與附件上傳，全部通過才顯示更新視窗。視窗沒有關閉按鈕、Esc 與點擊外側都關不掉，只有「立即更新」。只能由使用者完成的內容（未送出的留言、開著的欄位／視圖／排序設定、個人資料與密碼表單、編輯中的資料格、未解決的衝突、輸入法組字）無法代為儲存：視窗先不出現，每 2 秒重試，左下角顯示「有新版」，更新紀錄視窗裡說明還在等什麼。這是實作時的判斷：強制送出半寫的留言或表單不是使用者要的結果，而視窗一旦出現就擋住畫面，不能在還有未儲存內容時出現。
- 按「立即更新」時再執行一次同樣的儲存；若視窗開啟後又出現無法代存的內容，視窗先退下，完成後再出現。下載或接手新版失敗時顯示錯誤，視窗保留供重試。瀏覽器離線時視窗暫時退下（否則離線中的使用者會被擋住而無法使用筆記），恢復連線後再出現。已成功持久保存的 pending 草稿不必先上傳，更新不清除 IndexedDB、cookie 或附件快取。
- **更新紀錄**：左下角版號點擊後以 Modal 顯示各版本的標題與更新內容（原本是手動檢查更新；開啟時仍會順便向伺服器重查版本）。清單在 `src/shared/releases.ts`，伺服器的 `/api/version` 與前端共用；前端只顯示不比目前介面新的版本並標示「目前版本」，內容隨介面打包，離線也能看。
- 呼叫 registration.update 下載新版後，以 MessageChannel 核對 worker 版號，只有目標版本才接受 `notes:activate-update` 並 skipWaiting；等 controllerchange 並再次核對版號後，只重新載入發起更新的分頁。無 Service Worker 支援時使用帶更新識別的同源重新載入；下載／安裝／接手失敗顯示錯誤供重試。
- Worker 版號與離線資源列表由 Vite 注入；shell hash 包含資源、worker source 與版號。所有分頁回報各自的 build version，未知或舊分頁仍存在時保留舊 shell，靜態資源請求可從舊 shell 找到自己的 hashed assets。所有分頁回報新版後才清理舊 shell，附件快取不受影響。其他分頁各自儲存後出現自己的更新視窗，由使用者在該分頁按「立即更新」，沒有全域無條件 reload。
- 發布新版時同步調整 package.json／lockfile 根版本與 `src/server/releases.ts` 的繁體中文更新資訊，再建置部署。偵測對象是已部署伺服器，沒有依賴 GitHub Release 或外部更新服務。1.0.5 及以前的前端需手動連線重載一次才能取得此機制。

## 選取範圍留言與反應（追加功能）

- 桌面選取面板提供段落類型的右側子選單、文字格式、留言與表情反應，不包含 Skills 或 AI。自訂段落選單關閉焦點攔截與返回焦點，並保存選取範圍，避免點第一項時連同外層面板關閉。清除格式不移除留言標記；圖片／附件保留原本的格式工具。
- 手機／粗指標裝置（寬度小於 768px 或 pointer: coarse）不掛載會自動顯示的 FormattingToolbarController，桌面改用 DesktopFormattingToolbarController。手機只在編輯器聚焦時顯示小型「格式與段落」入口；組字、開啟格式面板或留言時隱藏入口。原生長按／選取選單不攔截，只有主動點擊才開啟獨立控制的底部 Drawer，並在此時保存範圍、讓編輯器失焦與清除原生 DOM 選取。
- 手機底部面板內切換段落、格式、顏色、連結與留言，不依鍵盤開關或編輯器焦點決定存續。useSavedSelection 將 bookmark 映射到後續文件變更，套用前還原原範圍；原選取內容已被刪除時拒絕誤改相鄰文字。相同選取不重設 selection，以保留游標處尚待輸入的粗體／斜體等 stored marks。
- 手機工具入口及面板以 VisualViewport 的可見矩形定位，預留工具入口高度並在游標移動／鍵盤縮放時捲動避讓；未提供 VisualViewport 的環境使用視窗尺寸。viewport meta 加入 interactive-widget=resizes-content。真正手機的鍵盤、長按選單與組字行為仍需實機驗收。
- migration `0005_annotations` 新增 `page_annotations`。留言與反應屬於頁面擁有者，所有查詢同時驗證 `page_id` 與 `user_id`，垃圾桶頁面不開放操作，永久刪頁時外鍵級聯清除。
- `GET|POST /api/pages/:pageId/annotations` 讀取／建立討論；`PATCH /api/pages/:pageId/annotations/:id` 以討論自己的 `version` 與 `If-Match` 新增回覆、切換反應或設定解決狀態，過期版本回 409。上限每頁 500 則討論、每則 100 個留言、留言 4,000 字、原文摘要 8,000 字。
- `DELETE /api/pages/:pageId/annotations/:id` 需要登入、同源 CSRF 與目前討論版本的 `If-Match`，在交易內檢查擁有者及版本後刪除整則討論。介面先確認，成功後只移除目前內文中該討論的 anchor，透過既有自動保存與頁面版本協定保存；保留文字、其他格式及重疊討論，409 保留討論與未送出的草稿。
- 黃色由 `annotationHighlights` 的 ProseMirror decorations 表示，只標出未解決且仍有留言或反應的討論；已解決、已刪除及移除最後反應後的空討論不顯示黃色。背景刷新討論狀態不改寫 BlockNote JSON；重新開啟討論可恢復標記。最後讀取過的 active IDs 依帳號／頁面快取至 IndexedDB，離線重開沿用該裝置已知狀態；不把討論內容改成離線可寫。`@tiptap/pm` 宣告為直接依賴並固定 3.33.0，沿用既有間接依賴版本。
- 正式 BlockNote JSON 的自訂 `annotation` 字串樣式記錄討論 ID，可同時記錄多個重疊範圍；標記隨文字編輯移動，走既有自動保存與頁面版本衝突流程。討論先獨立保存，標記再隨內文保存；即使標記尚未保存、原文被刪或版本還原後找不到標記，討論與原文摘要仍可由列表開啟。
- 討論內容／反應／解決狀態獨立於頁面歷史；還原內文不回退討論。複製頁面保留文字格式，但不複製原頁討論及其標記。備份 CLI 的 SQLite 線上備份自然包含討論資料表。
- 表情符號共用本機 frimousse 資料，不連外部 CDN；內文反應不插入文字。客戶端快取按帳號及頁面隔離，每 15 秒刷新，409 保留草稿並重新取得目前版本；沒有即時多人協作或對外分享留言。

## 搜尋與版本保存協定補充（M2–M4）

- `PUT /api/pages/:id/content` 仍必須帶 `If-Match`；使用者選擇解決衝突時，以目前衝突 head 重送並帶 `overwrite: true`，伺服器強制保存被覆蓋版本的快照。若 head 又變更，仍回 409。
- `GET /api/search?q&limit&offset` 需要登入，只回自己的非垃圾桶頁面（含資料庫與列頁面）。`q` 最長 200 字元，limit 預設 20、上限 50，offset 上限 10000；空查詢回空集合。回傳 `results`、`total`、`limit`、`offset`，每筆包含麵包屑與純文字 snippet。
- FTS 長查詢以雙引號包成字面片語，內部引號跳脫；短查詢以參數化 LIKE 並跳脫 `%`、`_`、反斜線。FTS 以標題較高權重排序，再依更新時間與 ID 排序。
- migration `0003_search_content` 將外部內容 FTS 欄名修正為 `content_text`，重建既有索引；不改筆記內容。套用紀錄確保只執行一次。
- 圖示資料取自固定版本 BlockNote 的本機動態 chunk，不開放外部 CDN。只有 PNG／JPEG／GIF／WebP inline；SVG 與所有非圖片以 attachment＋sandbox 提供。

## M5 資料庫協定與限制

- `GET /api/databases/:id` 回 `{ id, version, properties, views }`；建立資料庫時已有一個預設表格視圖。屬性型別為文字、數字、單選、多選、日期、核取方塊、網址；選項有穩定 UUID 與九種標籤顏色。
- `POST /api/databases/:id/properties`、`PATCH|DELETE /api/databases/:id/properties/:pid`、`POST /api/databases/:id/views`、`PATCH|DELETE /api/databases/:id/views/:vid` 皆以資料庫 `schema_version` 做 If-Match；成功變更使 schema_version 遞增。最多 50 個屬性、每個單選／多選欄位最多 100 個選項。
- 有資料的欄位拒絕直接改型別；仍被使用的選項拒絕刪除，避免靜默丟資料。刪除欄位會級聯移除值，並清除已儲存視圖對該欄位的排序、篩選與顯示設定；介面須確認刪除。
- `POST /api/databases/:id/rows` 以 schema_version 驗證當前結構，新增列不會增版結構。`GET /api/rows/:id` 回資料列及屬性版本；`PATCH /api/rows/:id/values` 以該列 `attributes_version` 做 If-Match，可更新名稱與部分屬性值，null 清除值。
- 區塊內文仍使用原本 `pages.version` 與 page_versions，與屬性版本獨立。migration `0004_database_versions` 新增 schema_version、attributes_version；row_title_version trigger 確保透過頁面標題 API 改名也會讓舊屬性寫入衝突。更新在單一交易內完成。
- `GET /api/databases/:id/rows?sort=<JSON>&filter=<JSON>&offset&limit` 回 `{ rows, total, offset, limit }`。排序最多 10 層、篩選最多 20 個且採 AND；型別與欄位歸屬均驗證，空值固定排最後，選項依標籤文字排序。回傳當前使用者的活動列；資料庫刪除與還原沿用頁面子樹機制。
- 每個資料庫上限 5,000 列包含垃圾桶內的列，防止還原後突破上限。客戶端以 100 列分批載入，CSS grid＋react-virtual 呈現 34px 列。欄寬依資料庫存於 localStorage；排序／篩選／顯示欄位可放在網址，也可保存到預設視圖。
- 儲存格開啟時固定草稿與基準版本；背景刷新不會偷偷採用新版本號。409 保留草稿並讓使用者明確選擇捨棄、重新載入。列頁面上方顯示 RowPropertiesPanel，內文仍使用完整 BlockNote。
- M5 原先僅提供單一預設表格；2026-11-08 依使用者追加授權擴充為表格／清單／看板，細節如下。OR 群組、公式／關聯欄位與已刪屬性的回收站仍未實作。

## 資料庫多視圖與直接編輯（追加功能）

- 資料庫頁桌面採獨立寬版容器，使用主內容區寬度並留 32px 邊距；一般筆記／列頁面維持閱讀欄。桌面看板欄寬在 220–280px 間分配，手機維持固定 280px 與橫向捲動。

- migration `0006_database_views` 在交易中重建 `db_views`，將 type 的 CHECK 擴為 `table|list|board`；保留既有 ID、名稱、config、順序、建立時間與頁面刪除級聯。沿用 migration 紀錄，重跑不重建。
- 每個資料庫最多 20 個視圖，至少保留一個。上方分頁與「＋」提供切換及新增；「編輯視圖」可重新命名、選擇類型／看板分組、確認刪除。刪除視圖僅刪設定，不刪資料列；所有讀寫仍驗證擁有者、CSRF 與版本。
- `views[]` 增加 `type`，config 新增可選 `groupBy`（必須是此資料庫的單選欄位）。舊客戶端 PATCH 省略 type 時保留原類型。看板新增時若沒有 groupBy，自動選第一個單選欄位；沒有單選欄位則在同交易建立含「尚未開始／進行中／已完成」的狀態欄位。既有資料不自動改值，留在「未設定」。屬性刪除或改成非單選時清除 grouping，介面要求重新選組；刪選項仍受既有值保護。
- `?view=<id>` 保存目前視圖，重載仍可開啟；無效 ID 回第一個視圖。每個視圖各自保存排序、篩選、欄位顯示與分組；暫存條件仍用既有 URL override，切換視圖會清除 override。分頁支援方向鍵與 Home／End。
- 空表格且無篩選時，至少呈現兩個資料列／空白輸入位置；空白位置不寫 SQLite，任一欄位輸入並儲存後才 POST 建立正式列。原有「新增資料列」視窗改成底部直接輸入名稱；工具列「新增」也開啟同樣輸入。篩選可能隱藏新資料時顯示提示。
- 名稱、文字、數字、網址改為原位編輯，Enter／失焦儲存，Escape 取消；中文組字期間 Enter 不送出，未完成數字不轉成 null。核取方塊點擊即更新；選項／日期保留選擇浮層。提交時防止 Enter＋blur 重複送出，錯誤保留輸入，409 不自動採用新版重送。表格虛擬捲動保留焦點列，結構版本刷新時保留前一批資料，避免僅因重新載入就卸載編輯格。
- 清單可原位編輯名稱與屬性並開啟列頁面。看板依選項與未設定分組，可從群組底部新增，拖曳把手或卡片選單移組；以拖曳開始時的列版本提交，不做成功前的樂觀搬移。僅支援跨群組變更值，沒有卡片手動排序。清單／看板沿用每批 100 列並手動載入更多，畫面明示未載入完整資料時的總數／群組計數範圍；表格仍自動分批載入。

## M10 分享協定（1.1.0）

使用說明與各角色權限表見 [SHARING.md](SHARING.md)。

- **資料**（migration `0009_shares`）：`page_shares` 每頁至多一筆（`scope`：`page`／`subpages`／`all`，選填的 `link_token`）；`share_members`（帳號與角色 `viewer`／`editor`）。`page_annotations.author_id`、`files.uploaded_by`、`pages.content_by` 記錄「不是擁有者的操作者」，NULL 代表擁有者。資料列不能作為分享的根。公開 token 為 32 bytes base64url，明文保存以便擁有者再次複製；它只授予讀取同一資料庫裡的內容。
- **單一權限入口**（`src/server/services/access.ts`）：`requireAccess(db, viewerId, pageId, 'view'|'comment'|'edit')` 是唯一不帶讀者自己的 `user_id` 查頁面的地方，回傳 `{ ownerId, role, chain, member }`。對成員開放的路由先呼叫它，再以 `ownerId` 呼叫既有的 service（service 的 SQL 仍一律帶 `user_id`）；沒有修改的路由繼續傳呼叫者自己的 id，所以預設拒絕。陌生人、垃圾桶中的頁面、擁有者已停用 → 404；成員角色不足 → 403。公開連結由 `resolveLink`／`linkChain` 以同樣方式解析。
- **範圍**（`src/shared/shares.ts` 的 `scopeCovers`，SQL 版為 `access.ts` 的 `scopePages`，測試以隨機樹驗證兩者一致）：令 `below` 為分享根以下到目標各節點的 kind。`page`：`below` 為空或只有一個 `row`；`subpages`：不含 `database`；`all`：全部。巢狀分享取最高角色，以最上層涵蓋該頁的分享為根。
- **成員看到的頁面**（`pageResponse`）：`access: { role, rootId, owner }`（自己的頁面不輸出這個鍵）、麵包屑只到分享根、根的 `parentId` 為 null、`isFavorite` 一律 false。manifest、`GET /api/pages/:id`、`/api/offline/pages` 與 `/api/offline/databases/:id` 用同一個建構函式，因為裝置以摘要逐位元組比對判斷是否需要重新下載。
- **路由**：成員可讀 `GET /api/pages/:id`、`/head`、資料庫與資料列的讀取、留言；可編輯者另可 `PUT /content`、`PATCH`（只有一般頁面的 `title`）、`PUT /api/offline/pages/:id`、`row.create`／`row.update` 操作，以及帶 `pageId` 的 `POST /api/files`。留言操作任何成員皆可；刪除整則討論限擁有者與發起者。資料庫結構與視圖（REST 與 `property.*`／`view.*` 操作）、新增頁面、搬移、最愛、複製、歷史、垃圾桶、分享管理都只有擁有者。離線操作在查 receipt 之前先重新確認權限，被移除的成員重送舊的 `operationId` 得不到任何資料；重送的回應一律是「現在看得到的狀態」，不是當時存下的回應。
- **唯讀成員的留言**：唯讀成員不寫入頁面。他們發起的討論帶 `floating`（`page_annotations.floating`），內文沒有標記；每個讀者的畫面由 `annotationHighlights.ts` 的 `locateQuote` 在討論的 `blockIds` 內尋找引文並加上裝飾（decoration），找不到就不標示。頁面的內容與版本因此完全不受唯讀成員影響，也不會讓正在編輯的人遇到版本衝突。（初版曾讓伺服器接受讀者送來的已標記區塊，獨立審查指出可藉此寫入任意內容，已整個移除。）標示已解決限擁有者、可編輯成員與發起者；非擁有者每頁最多發起 100 則討論、每則每人 20 個表情；`at` 最多回溯 30 天。
- **留言身分**：`messages[].authorId` 與每人各自的 `reactions: [{ emoji, userId }]`；舊紀錄（沒有作者、表情為字串）視為擁有者的。DTO 依讀者計算 `author`、`messages[].author`、`mine`、`counts`、`canDelete`，原有欄位不變，因此裝置上的舊副本仍可使用。
- **附件**：在別人的頁面上傳的檔案歸頁面擁有者（`uploaded_by` 記上傳者，上傳者自己可讀）。非擁有者讀檔的條件是：自己可存取、屬於檔案擁有者的頁面，其封面或內文引用了它（`scopeShowsFile`，在分享範圍內以 `instr(content, '/api/files/<id>')` 判斷，沒有另建索引）。`X-Notes-User` 為請求者的 id，Service Worker 的帳號別快取照常運作。
- **公開連結**（`src/server/routes/public.ts`，頁面路由 `/s/:token[/:pageId]`）：`/api/public/:token`（根與範圍內的樹）、`…/pages/:id`（頁面；資料庫附結構與資料列，資料列附儲存格）、`…/files/:id`。只有 GET；未知、已停用的 token 與範圍外的頁面回應相同的 404；依來源位址每分鐘 600 次；回應帶 `X-Robots-Tag: noindex, nofollow`；未處理錯誤的 log 與內建 HTTPS overlay 的 nginx 存取紀錄都會遮蔽 token。內容經 `publicContent` 清理：去掉留言標記、範圍外的頁面提及換成文字「無法存取的頁面」、連到範圍外頁面的一般連結只留文字、範圍內的改指向公開網址、檔案網址改寫為 token 版。前端的公開頁面不呼叫任何需要登入的端點（401 會清掉裝置記住的帳號），也不註冊 Service Worker。
- **知道連結的本站帳號**（1.1.1 的 migration `0010_share_account_link` 加入欄位；1.1.2 以 `0011_share_single_link` 改為公開連結的設定）：一個分享只有一個連結，即公開連結 `/s/<token>`。`page_shares.account_role`（NULL／`viewer`／`editor`）是這個連結的設定，只有 `link_token` 存在時才能設（否則 400），關閉公開連結或把頁面移至垃圾桶時連同 `share_visitors` 一併清除。權限由「開啟連結」授予：`POST /api/shares/open { token, pageId? }`（需登入與 CSRF，每帳號每分鐘 120 次）在連結有帳號角色時把呼叫者記入 `share_visitors`（`openLink`，`INSERT OR IGNORE`），回傳要開啟的頁面 id；`resolveAccess` 只對「有開啟紀錄」的帳號計入 `account_role`，並與個別成員的角色取較高者，因此只知道頁面 id（`/p/<id>`）沒有任何權限。列舉分享、manifest 與檔案引用檢查同樣以開啟紀錄為準。`GET /api/public/:token` 仍不需登入；唯一受 session 影響的是：請求帶有效 session，且連結會把這個帳號帶進頁面本身（擁有者、個別成員，或連結有帳號角色）時，回應改為 `{ account: true }`（不寫入任何東西），前端 `PublicView` 才改由 `RequireAuth` 取得 CSRF token 並呼叫上述端點，再導向 `/p/<id>`。未登入者與沒有被帶入的帳號看到的公開內容與規則完全不變。升級時，1.1.1 中「沒有公開連結卻開放給帳號」的分享會被清除該設定與開啟紀錄（不替擁有者開啟公開連結）。
- **生命週期**：把頁面移至垃圾桶會清掉其子樹內的公開 token（成員名單保留，垃圾桶中仍可移除成員）；擁有者停用時所有分享失效。
- **頁面歷史**：寫入者改變時，被取代的內容一定留一份快照（`page_versions.written_by` 記下那份內容是誰寫的）。擁有者寫的與成員寫的各自保留最新 100 份，成員的存檔不會擠掉擁有者的版本；成員重複的「覆蓋」不會每次都產生快照。伺服器只檢查區塊的外形，不檢查行內內容，因此編輯器外包了一層錯誤邊界：內容無法建立時頁面仍可使用，擁有者可從頁面歷史還原。
- **離線**：manifest 另列共用的頁面摘要、資料庫與留言 stamp 與 `shared`（側欄用），既有的下載流程照常運作，分享結束後由「不在清單 → 標記移除」處理。待同步的草稿保留基準，但會更新 `access`。用戶端在共用頁面底下不建立本機子頁（伺服器會永遠拒絕），共用頁面的草稿不併入自己的頁面樹。被降級（403）或移除（404）時，未同步的修改成為待處理項目，可匯出或捨棄。

## 瀏覽器分頁的標題與圖示（追加功能）

- **做法**（`src/client/app/documentHead.ts` 的 `useDocumentHead`）：純前端，沒有 API 與 migration。頁面開啟時把 `document.title` 設為「頁面標題 | Notes」（沒有標題是「無標題 | Notes」），並把 `<link rel="icon">` 換成頁面的圖示；頁面沒有圖示時是原本的 `/notes-icon.svg`。離開頁面（首頁、垃圾桶、設定、登入頁）時還原為「Notes」與 LOGO。
- **圖示**：頁面的圖示是一段文字（表情符號），以 SVG 的 data URI 畫成分頁圖示，與 LOGO 同為 SVG 圖示；CSP 的 `img-src` 原本就允許 `data:`。圖示文字經 XML 跳脫後才放進 SVG。更新時換掉整個 `<link>` 元素，不只改 `href`。表情符號的樣子取決於裝置的字型，各平台不同。
- **接入**：`PageRoute.tsx` 的 `PageView`（`meta.title`、`meta.icon`，改標題、換圖示、別處更新載入新內容時都會跟著變；一般頁面、資料列、資料庫、別人共用的頁面都走這裡）與 `PublicView.tsx` 的公開連結頁。PWA 的安裝圖示與 manifest 不變。

## 頂列的最後編輯時間（追加功能）

- **來源**：頁面的 `updatedAt`（`pages.updated_at`），純前端顯示，沒有 API 與 migration。這個時間除了內文與標題，改圖示、封面、全寬、搬移、加入或移除最愛、還原時伺服器也會更新；要只計內文需要另外的欄位與 migration，目前沒有做。
- **更新**：`PageRoute.tsx` 取「開啟時的 `updatedAt`、之後從伺服器收到的 `updatedAt`、在這裡編輯內文或標題的時間」三者中最新的一個。在這裡編輯以此裝置的時鐘計，立刻顯示「剛剛編輯」，不等保存完成；別人或其他分頁的修改在既有的版本輪詢載入新內容時一併更新。
- **文字**（`src/client/features/page/relativeTime.ts` 的 `editedLabel`）：不到 1 分鐘「剛剛編輯」，之後依序是分鐘、小時、天（無條件捨去），滿 7 天顯示日期，不同年加上年份。時間比此裝置的時鐘晚（伺服器與裝置時鐘有差）時視為剛剛。`EditedTime.tsx` 每 30 秒與分頁回到前景時重算；滑鼠停留顯示完整時間。
- **位置**：電腦寬度在頂列保存狀態的左邊；手機寬度（<768px）頂列放不下，改列在頁面選單（⋯）底部。資料庫頁面不顯示：資料列各自編輯，資料庫頁面自己的 `updatedAt` 不反映資料列的修改。公開連結頁不顯示。

## 頁面內尋找與取代（追加功能）

- **範圍**：只搜尋目前頁面的內文（BlockNote 編輯器內的文字，含表格、程式碼區塊與折疊列表的子項目）。標題、資料列屬性、側邊欄與資料庫頁面不在範圍內；資料庫頁面（沒有編輯器）不攔截 Ctrl／⌘+F。跨頁搜尋仍是 Ctrl+K（伺服器 FTS）。純前端功能，沒有 API 與 migration。
- **比對**（`src/client/features/editor/findReplace.ts` 的 `findMatches`）：不分大小寫的子字串比對，逐一文字區塊進行；同一段落內可跨不同樣式的文字，不跨區塊，也不跨行內的頁面連結。大小寫轉換保持長度不變，位置才能對回原文。
- **高亮**：以 ProseMirror plugin 的 decoration 顯示（`find-match`、目前結果 `find-match--current`），與留言高亮同一做法；搜尋本身不產生文件變更，不觸發自動保存，也不進復原紀錄。尋找列開著時在內文打字，結果與計數會即時重算。
- **取代**：是一般的編輯交易，走既有的 `onChange` → 自動保存（線上或離線草稿）與版本衝突流程。「全部取代」是單一交易，一次復原即可全部還原；取代後的文字沿用被取代文字第一個字的樣式（含留言標記）；取代文字包含搜尋文字時，下一筆從取代結果之後開始，不會重複取代同一處。編輯器不可編輯時（唯讀成員、公開連結）`replaceCurrent`／`replaceAll` 不動作，介面也不顯示取代。
- **尋找列**（`FindBar.tsx`）：以 portal 掛在頁面頂列（`.page > .topbar`）下方，跟著頂列走。macOS 只認 ⌘F（Ctrl+F 在文字欄位是游標右移），其他平台只認 Ctrl+F。開啟時帶入內文中已選取的單行文字，並從選取或游標位置（沒有時從畫面頂端）開始找；修改搜尋文字時停在目前結果附近。Enter／Shift+Enter 與 Ctrl／⌘+G 切換結果，目前結果在收合的折疊列表內時會展開並捲入畫面。Esc 關閉並把游標放在目前結果開頭。輸入法組字中的 Enter／Esc 不動作。
- **交還瀏覽器**：焦點在尋找欄位時再按一次 Ctrl／⌘+F 會關閉尋找列且不攔截，讓瀏覽器自己的尋找出現（用來找標題、側邊欄等範圍外的文字）；有對話框（`aria-modal`）開啟時也不攔截。
