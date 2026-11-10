# 交接紀錄

更新：2026-11-10。動手前讀本文件、[AGENTS.md](../AGENTS.md)、[ARCHITECTURE.md](ARCHITECTURE.md)、[DEPLOY.md](DEPLOY.md)。

桌面側欄「…」選單滑鼠移入即消失已修正：Portal 選單離開頁面列的 hover／focus 區域後，原本會讓定位按鈕 display:none，Mantine 因此隱藏選單。現在以 `menuOpened`／`data-menu-open` 在開啟期間保留按鈕可見。`scripts/check-sidebar-menu.mjs` 已先重現失敗再驗證通過，包含滑鼠、實際選單動作、右鍵、Escape、鍵盤與點外關閉；129 tests、typecheck、lint、build、容器及 30 項靜態檢查通過。詳見 VALIDATION 對應段落。

## 本輪工作：知道連結的本站帳號，版本 1.1.1（2026-11-10，已發布 v1.1.1；正式環境尚未部署）

v1.1.0 發布後使用者要求：在分享的「與本站帳號共用」新增「知道連結的人皆可編輯／唯讀」。我的理解與實作：這是給**已登入的本站帳號**的連結存取（不必逐一輸入 email），未登入的公開連結仍維持唯讀（使用者先前的決定）；回報這個理解後，使用者沒有提出異議，並指定以 1.1.1 發布。版號由使用者決定：這一版的 1.1.1 與先前的 1.0.8 都是我在未被要求時自行設定的，使用者已明確要求不要再這樣做。

- `page_shares.account_role` 與 `share_visitors`（migration `0010_share_account_link`）。連結就是頁面網址 `/p/<id>`，沒有另外的 token：知道頁面 id 的已登入帳號即取得該角色，範圍規則不變。
- 存取本身不需要紀錄；`GET /api/pages/:id` 另把「只靠連結取得存取」的分享根記入 `share_visitors`，用途只有三個：對方的「與我共用」清單、manifest（離線下載），以及檔案引用檢查（讀檔前必須先開過頁面）。關閉連結會刪除這些紀錄。
- 管理端點 `PUT /api/pages/:id/share/account-link`（`{ role: 'viewer' | 'editor' | null }`，僅擁有者）。`ShareDto` 多了 `accountRole` 與 `visitors`。
- 風險提示已寫入 SHARING：頁面 id 可能出現在其他共用頁面的頁面連結中，「皆可編輯」等於全站拿到網址的帳號都能改。
- 驗證見 VALIDATION 最上方段落。這一項沒有另外做獨立審查（改動集中在 `resolveAccess` 的一個查詢與分享列舉，伺服器測試涵蓋了開放前後、範圍、角色合併、關閉、未登入與檔案規則）。

## 前輪工作：M10 分享，版本 1.1.0（2026-11-10，已發布 v1.1.0；正式環境尚未部署）

M9（1.0.8）已依使用者指示 commit 到本機 `main`（`df3e2d8`），沒有 push、沒有部署。接著使用者要求「分享筆記的功能」，以 plan 模式逐項確認需求後核可計畫：公開連結（唯讀、無留言、可停用）、以 email 與站內帳號共用（唯讀／可編輯，皆可留言與表情）、範圍可選（此頁面／含子頁面／含資料庫）、可編輯者只改內容、共用筆記也可離線。全部已實作；使用說明見 [SHARING.md](SHARING.md)，協定見 ARCHITECTURE 的「M10 分享協定」，驗證見 VALIDATION 的 M10 段落。

做法摘要：

- 伺服器只有 `src/server/services/access.ts` 不帶讀者自己的 `user_id` 查頁面。對成員開放的路由先 `requireAccess`，再以 `ownerId` 呼叫原本的 service；沒改的路由仍傳呼叫者自己的 id，因此預設拒絕。**新增任何路由時，除非明確要對成員開放，照舊傳 `c.get('auth')!.user.id` 即可；要開放就先呼叫 `requireAccess` 並寫進 `tests/server/shares.test.ts` 的矩陣。**
- 成員的頁面回應一律由 `pageResponse`／`rowResponse` 建構。裝置以摘要逐位元組比對，manifest 與 `GET /api/pages/:id` 的內容不一致會讓裝置每分鐘重新下載所有共用頁面；測試有檢查兩者相等。
- 唯讀成員完全不寫入頁面：他們的討論帶 `floating`，沒有內文標記，各人的畫面以 `locateQuote` 依引文找出位置來標示。初版讓伺服器接受讀者送來的已標記區塊，獨立審查證實可藉此寫入任意內容並讓頁面打不開，已整個移除。不要為了讓標記更精準而重新讓唯讀成員影響 `pages.content` 或 `version`。
- 公開連結的內容由 `publicContent` 清理後才送出；公開頁面（`src/client/features/share/PublicView.tsx`）不可呼叫 `useMe`、`useTree`、`loadNote` 等需要登入的東西，401 會清掉裝置記住的帳號。
- 前端以三個 context 傳遞角色：`PageLinkContext`（頁面連結的解析來源）、`DatabaseAccessContext`（能否改資料列／結構、資料列開啟的網址）、`ShareDialogHost`（全站共用一個分享視窗）。`PageRoute` 依 `initial.access` 決定可否輸入；唯讀時編輯器 `editable={false}` 且忽略 `onChange`，所以唯讀成員沒有草稿也沒有衝突流程。

行為改變，接手時留意：

- 留言 DTO 多了 `author`、`messages[].author`、`mine`、`counts`、`canDelete`；`reactions` 仍是「出現過的表情」。表情改為每人各自，舊紀錄（字串）視為擁有者的。判斷「我有沒有按」請用 `myReactions()`，不要直接看 `reactions`。
- `annotations` 的 service 多了 `actorId` 參數（預設為擁有者）；`updateContent` 多了 `actorId`，寫入者改變時強制留頁面歷史快照。
- `POST /api/files` 可帶 `pageId`；帶了且頁面是別人的，檔案歸頁面擁有者。`GET /api/files/:id` 的 `X-Notes-User` 現在是「請求者」而不是「檔案擁有者」（Service Worker 的快取判斷依賴它等於裝置上的帳號）。
- `trashPage` 會清掉子樹內的公開 token。
- `EditableCell` 會讀 `DatabaseAccessContext`：沒有 provider 時與以前相同（可編輯）。
- `tests/client/offlineStatus.test.tsx` 原本有時序競賽（畫面顯示「同步中」時 manifest 請求可能還沒送出），在全套平行執行時偶發失敗；已改為等請求送出後再回應。

獨立審查（唯讀，另一個 Claude 工作階段，以從頭寫的測試實際執行驗證）：沒有發現陌生人、匿名訪客、公開連結持有者或前成員能讀寫規則以外內容的途徑；指出成員可對擁有者頁面做超出規則的事，全部已修正並補測試：唯讀成員可藉留言標記寫入任意內容（改為不寫入頁面）、可編輯者可用大量存檔擠掉擁有者的歷史版本（改為分開保留）、唯讀留言造成擁有者版本衝突（隨上一項消失）、內建 nginx 存取紀錄含公開 token（已遮蔽）、唯讀成員可解決他人討論與無上限加表情／佔滿討論額度／回溯時間（已限制）、公開內容中連到範圍外頁面的一般連結洩漏頁面 id（已移除）、降級後重送草稿取得當時的回應（改回目前狀態）、垃圾桶中無法移除成員（已允許）、附件清單的連結未限制來源（已限制）。沒有修正而列為已知限制的：成員看得到共用頁內連結的標題快照；檔案引用檢查沒有索引。

已知限制（都已寫入 SHARING／發布說明）：以 email 加成員可探測帳號是否存在（每小時 30 次）；可編輯者若知道擁有者某檔案的 id 可使它被共用對象讀取；成員看得到共用頁內連結的標題快照；唯讀成員的討論標示依引文尋找，文字被改掉就不再標示，同段落重複文字時標示第一處；可編輯者能存入編輯器無法處理的內容（伺服器不驗證行內內容），此時頁面顯示錯誤並可由擁有者從歷史還原；檔案的引用檢查每次掃描分享範圍內的內文（沒有索引，大範圍分享下每張圖一次掃描）；共用頁面不進對方的搜尋；單一 bundle；沒有實機與手機 HTTPS 驗收。

## 前輪工作：M9 離線擴充，版本 1.0.8（2026-11-10，commit `df3e2d8`，未單獨發布，併入 v1.1.0）

使用者先詢問「資料庫／留言／新附件上傳是否也能離線」，評估後指示把所有項目列入 M9 並開始執行：新附件上傳、留言與反應、資料庫離線閱讀、資料列值／新增列／列內文離線編輯、資料庫結構與視圖離線修改。全部已實作；使用說明見 [OFFLINE.md](OFFLINE.md) 的「資料庫、留言與附件」，協定見 ARCHITECTURE 的「M9 離線擴充協定」，驗證見 VALIDATION 的 M9 段落。實作後請另一個獨立的 Claude 工作階段審查整份差異：沒有重大缺陷，提出的六項中低風險問題（刪除討論會連同他處新回覆一起刪除、斷線後的留言可能誤報失敗、捨棄新增列未說明會刪除列內文、跨分頁時新列內文可能永遠不上傳、附件被拒時筆記仍送出、同步途中換帳號被記成個別錯誤）與兩項小問題（核取方塊 false／空值誤判衝突、捨棄改名後列頁面標題未還原）都已修正並補測試。

做法摘要：資料庫與留言的修改改為小而可重送的操作，經新端點 `POST /api/offline/ops` 執行，以 migration `0008_offline_receipts` 保證每個 operationId 只執行一次；ID 由用戶端產生。資料列逐格比對（`{ base, value }`），結構修改比對 `schema_version`，留言不比對版本（附加／明確開關）。用戶端 `src/client/offline/outbox.ts` 保存待送操作，畫面顯示「裝置副本＋待送操作」；`uploads.ts` 把離線加入的附件存入 Cache Storage，Service Worker 以正式網址提供。manifest 增加資料庫與留言的 stamp，變動才下載。列頁面內文改與一般筆記相同先存本機。檔案類型規則移到 `src/shared/files.ts` 供前後端共用。

行為改變，接手時留意：

- 線上編輯資料庫與留言也改走 `/api/offline/ops`（連線時直接送出並當場顯示錯誤），因此資料列線上衝突也變成逐格判定。原有 REST 端點（`/api/databases/*`、`/api/rows/*`、`/api/pages/:id/annotations`）保留且行為不變，但前端只用它們讀取。
- `EditableCell` 的 `onSave(value, base)` 第二個參數由列版本改為「開始編輯時該格的值」。
- 資料列頁面不再經 `PUT /api/pages/:id/content` 保存（有本機副本時），列名稱一律走 `row.update`。
- 仍需連線：搜尋、頁面歷史、最愛、搬移、垃圾桶（含資料列）、圖示／封面、新增資料庫。
- 版號已改為 1.0.8（package／lockfile、`src/server/releases.ts`、[releases/1.0.8.md](releases/1.0.8.md)），**尚未 commit、push 或建立 Release**，等使用者指示。正式環境需重新部署才會套用 migration 與新介面。

未驗證與已知限制：沒有 iOS Safari／Android 實體手機、手機 HTTPS 或真實輸入法的驗收；瀏覽器實測是桌面 Chrome（localhost 安全環境例外）。資料庫有變動時整個資料庫的結構與資料列會重新下載（列內文只下載變動的頁面），列數很多時下載量較大。待上傳的大附件只存在裝置上，瀏覽器回收空間會遺失（清單會顯示「內容已遺失」）。同一裝置多個分頁之間，另一分頁的資料庫畫面要等自己的 30 秒輪詢才更新。此裝置連續送出結構修改時，若前一項的回應剛處理完、畫面尚未更新就再改一次，後者可能被列為與自己的修改衝突（不會覆蓋資料，重試即可）。

## 前次發布：1.0.7（2026-11-10）

對 1.0.6 做整體 code review 與資安檢查，修正所有發現的問題後，使用者指定 commit、push 並發布 **1.0.7**。內容是請求大小上限、速率限制來源、登入限制與來源檢查等資安強化，以及輸入法離頁遺失文字、資料列誤判衝突、Service Worker 刪除新版快取等保存與離線修正；沒有新增 migration，依賴版本不變。新增選用設定 `NOTES_CLIENT_IP_HEADER`（經 Cloudflare 時設 `cf-connecting-ip`）與 `NOTES_SETUP_TOKEN`。

發布說明見 [releases/1.0.7.md](releases/1.0.7.md)，命令與結果見 VALIDATION 的「Code review 與資安修正」與「1.0.7 發布前檢查」。逐項問題清單只在本機的 `.local/CODE_REVIEW_2026-11-10.md`，不進版本控制。本輪沒有實際瀏覽器、實體手機或真實輸入法的驗收；正式環境需另行重新部署。曾開啟 2026-11-09 未發布工作版 1.0.7 的本機分頁版號相同，不會收到更新提示，須手動重新載入一次。

## 更早發布：1.0.6（2026-11-09）

使用者指定 commit、push 並發布 **1.0.6**。原未發布工作版 1.0.7 的版號／更新提示，與前輪留言修正整併為同一個 1.0.6 正式版本；package／lockfile、版本 API、更新說明及文件均以 1.0.6 為準，不發布 v1.0.7。下方保留歷史工作紀錄，其中 1.0.7／1.0.8 瀏覽器測試版號不代表已發布版本。

發布說明見 [releases/1.0.6.md](releases/1.0.6.md)，實際發布前驗證見 VALIDATION 的 1.0.6 發布段落。曾開啟未發布工作版 1.0.7 的本機分頁，須手動重新載入一次才能切回正式 1.0.6；同版／回滾不自動提示的比較規則不變。

## 歷史工作版：1.0.7 版號與更新提示（2026-11-09，最終併入 1.0.6）

使用者授權：左下角顯示版號，偵測新版時自動顯示更新說明 Modal，提供立即更新按鈕。`src/client/updates` 比對目前 build 與伺服器 `/api/version`，每分鐘與前景／恢復連線檢查；更新說明維護於 `src/server/releases.ts`。更新前保存筆記，未送出留言／表單與上傳會阻止重新載入，保留 IndexedDB、登入及附件快取。

新 worker 透過版本握手與明確訊息 skipWaiting，只重新載入發起分頁。其他分頁保留目前內容與舊資源並收到更新提示；所有分頁都回報新版後才清理舊 shell。`scripts/check-app-update.mjs` 在暫存目錄實際建置下一個 patch 版前端，配合獨立資料容器驗證真正的兩版切換、失敗重試、待同步草稿／附件保留與多分頁行為，不使用正式帳號。首次從舊版升級需先手動重載一次，後續新版才有自動提醒。

當時工作版本為 1.0.7，含前輪尚未提交的 1.0.6 留言修正；未覆寫任何前輪修改。這些功能最終依使用者要求整併為 1.0.6，發布說明見 [releases/1.0.6.md](releases/1.0.6.md)。下方保留前輪紀錄。

## 前輪追加：1.0.6 留言取消與黃色標記（2026-11-09）

使用者回報選取文字加入留言／反應後，無法取消且文字持續黃色。Chrome 已重現：伺服器 resolved=true 時背景仍為 rgb(255, 240, 181)。原因是 annotation 字串樣式無條件著色，未依討論狀態顯示，且缺少刪除討論入口。

修正為 ProseMirror decorations 依討論狀態顯示黃色；已解決、已刪除或沒有留言／反應的空討論不標黃，重疊的其他 active 討論仍保留。新增確認後「刪除整則討論」與帶 CSRF／If-Match／擁有者檢查的 DELETE API；只有成功刪除後才清除此討論 anchor，文字、其他格式與重疊標記保留，經既有頁面版本自動保存。最後已知的 active IDs 按帳號／頁面快取，支援離線重開。曾試驗直接改寫編輯區 DOM 屬性會干擾手機選取範圍，已撤除並改用 decorations；手機格式測試重新通過。

工作版本為 1.0.6，`@tiptap/pm` 改為 exact 3.33.0 的直接依賴，與原 lockfile 的間接版本相同，沒有升級 BlockNote 或新增 migration。完整結果見 VALIDATION 的 1.0.6 段落，變更說明見 [releases/1.0.6.md](releases/1.0.6.md)。下方保留 1.0.5 與更早紀錄。

## 前輪追加：1.0.5 自動下載與快取容量（2026-11-09）

使用者已追加授權：一般筆記自動下載更新、附件上傳預設 90 MB、離線附件改採可設定總容量（預設 500 MB），以及完整同步完成提示。實作以 `/api/offline/manifest` 比對版本與 metadata，只下載有變動的一般筆記；開啟、恢復連線與切回前景檢查，可見時每分鐘重查。pending 草稿不被下載覆蓋，刪除的乾淨副本標記不可離線開啟。完整同步時間只有全部下載成功且沒有 pending 後才保存。

衝突沿用 409 停止該篇上傳與草稿救援，新增目前編輯內容匯出與兩種處理的確認訊息；即使明確覆蓋也要求最新 title baseline，處理期間另一分頁改動草稿則拒絕捨棄。附件快取按帳號隔離，Service Worker 序列化寫入與總容量清理，可設定 100–10,000 MB；超額只清裝置快取，不刪伺服器原檔。沒有新增依賴或 migration。

實際驗證見 [VALIDATION.md](VALIDATION.md) 的 1.0.5 段落，發布說明見 [releases/1.0.5.md](releases/1.0.5.md)。下方保留 1.0.4 與早期里程碑紀錄，其 20 MB／100 個快取限制已由本輪取代。

## 前輪追加：M8 離線筆記（2026-11-09）

使用者已授權實作 iOS／Android 共用的 PWA 離線筆記。一般筆記支援離線開啟、新增（含已下載父頁底下的子頁）、標題與 BlockNote 內文編輯、IndexedDB 持久保存、前景自動同步、版本衝突及草稿匯出／捨棄。手機需 HTTPS；不承諾關閉後背景同步。資料庫、列屬性、留言、新附件上傳與其他頁面設定維持連線操作。完整操作與限制見 [OFFLINE.md](OFFLINE.md)，協定見 ARCHITECTURE 的 M8 段落。

新增 migration `0007_offline_operations`，同步交易保存最後一次操作回應，支援回應遺失後安全重試。所有筆記依帳號隔離；不將 session／CSRF／密碼持久保存。附件改為重新授權的 HTTP 快取，Service Worker 的帳號獨立快取保留原下載／sandbox 標頭，最多 20 MB／檔、最近 100 檔。

本輪以 Node 22.23.1／npm 10.9.8 執行 typecheck、lint、24 檔／129 tests、build，全部通過；容器以同版本 Node 建置且 healthy，`/healthz` 200，`test:app` 新增 PWA 檢查後共 30 項 PASS。Chrome 手機視口實測離線重載、離線新增後重載、恢復連線自動同步、衝突保留草稿與明確覆蓋歷史均通過。沒有 iOS／Android 實體手機、Safari 引擎、真實鍵盤／IME 或手機 HTTPS 的實機驗收。

本輪工作環境為 macOS，正式 compose 在 `http://127.0.0.1:8080/`；以下舊紀錄的 Windows／8081 為先前環境。瀏覽器測試使用另一個一次性容器與記憶體資料目錄，合成帳號沒有寫入正式 volume。測試依賴只新增 exact `fake-indexeddb@6.2.8`；Playwright 與 Node 22 驗證工具放暫存目錄，沒有加到正式依賴。M8 與側欄選單修正整併至 1.0.4，發布說明見 [releases/1.0.4.md](releases/1.0.4.md)。

## 目前狀態

目前工作區版本為 **1.0.8**（M9 離線擴充，見最上方；尚未 commit／發布）；已發布的最新版本是 **1.0.7**（資安強化與保存可靠性修正）；**1.0.6** 包含介面版號、更新提示及留言取消與黃色標記修正；**1.0.5** 新增自動下載更新、同步完成提示與可設定附件快取容量。各輪驗證結果見 VALIDATION。以下保留歷史紀錄。

2026-11-09 手機格式面板修正納入 1.0.3，已套用本機容器：手機保留原生長按選單，主動點「格式與段落」才開底部面板；段落類型在面板內切換，桌面第一項子選單也補上焦點保護。保存並映射原選取範圍，支援連續格式操作、留言切換與鍵盤避讓；中文組字期間隱藏入口。最新 typecheck、lint、20 檔／116 tests、build 全過，容器 healthy、healthz 200、靜態檢查 25 項 PASS。依使用者指示略過瀏覽器測試，未做實體手機／真實 IME 驗收。

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
