# 架構與里程碑

更新：2026-11-09。接手請先讀 [HANDOFF.md](HANDOFF.md)。

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
- 一般筆記以外的頁面操作、資料庫、列屬性、搜尋、留言與新附件上傳仍需伺服器，不納入離線修改佇列。手機正式使用必須 HTTPS；私人瀏覽、手動清除網站資料與裝置空間不足可能導致本機內容不可用。更多操作限制見 [OFFLINE.md](OFFLINE.md)。

## 介面版號與更新協定（1.0.6）

- 左下角版號由 Vite 在建置時從 package.json 注入，代表目前執行的前端版本；不以 `/api/version` 的伺服器版號冒充目前介面版本。公開 `/api/version` 回 `{ version, releases: [{ version, title, changes }] }`，維持 no-store，只回已部署版本及以前的更新資訊，沒有使用者資料。
- `src/client/updates` 每分鐘於前景檢查版本，並於開啟、恢復連線、切回前景與收到 controllerchange 通知時重查；只有數值比較較新的版本會彈出 Modal，同版／回滾不重複提示。中文組字期間延後開啟。可稍後更新，該分頁對同一新版只自動提示一次，仍可從左下角重新開啟。
- 點「立即更新」先執行元件註冊的 update guards，保存筆記標題／內文，阻止未保存、衝突中的可見修改、未送出留言與表單資料被重新載入丟棄，並等候進行中的 Query mutations；附件上傳亦會阻止更新。已成功持久保存的 pending 草稿不必先上傳，更新不清除 IndexedDB、cookie 或附件快取。
- 呼叫 registration.update 下載新版後，以 MessageChannel 核對 worker 版號，只有目標版本才接受 `notes:activate-update` 並 skipWaiting；等 controllerchange 並再次核對版號後，只重新載入發起更新的分頁。無 Service Worker 支援時使用帶更新識別的同源重新載入；下載／安裝／接手失敗顯示錯誤供重試。
- Worker 版號與離線資源列表由 Vite 注入；shell hash 包含資源、worker source 與版號。所有分頁回報各自的 build version，未知或舊分頁仍存在時保留舊 shell，靜態資源請求可從舊 shell 找到自己的 hashed assets。所有分頁回報新版後才清理舊 shell，附件快取不受影響。其他分頁收到通知後自行決定更新，沒有全域無條件 reload。
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
