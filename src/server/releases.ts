import type { VersionInfo } from '../shared/version.ts';
import { isNewerVersion } from '../shared/version.ts';

const releases: VersionInfo['releases'] = [
  { version: '1.0.7', title: '資安強化與保存可靠性修正', changes: [
    '輸入法組字中離開頁面、切到背景或關閉分頁時，已輸入的文字會先保存。',
    '資料列頁面不再於自動保存後跳出「已在其他地方更新」或重新載入。',
    '衝突尚未處理時繼續輸入的內容仍保存在此裝置；無法保存時離開前會先詢問。',
    '只改圖示、封面、最愛或搬移頁面，不再重新載入開啟中的編輯器。',
    '更新後離線介面保持可用；附件載入更快，相同內容不重複下載。',
    '同一瀏覽器換帳號時，不會刪除另一個帳號尚未同步的草稿。',
    '登入限制改為依來源與帳號計算，別人猜錯密碼不再鎖住帳號本人。',
    '強化請求大小上限、登入與註冊的來源檢查；經 HTTPS 代理可上傳超過 16 MB 的附件。',
  ] },
  { version: '1.0.6', title: '留言修正、版號與立即更新', changes: [
    '左下角顯示目前介面版號，可點擊檢查更新。',
    '偵測到新版時自動顯示更新資訊，提供立即更新按鈕。',
    '更新前保存筆記，保留此裝置的離線資料與附件快取；其他分頁會收到更新提醒。',
    '可刪除整則討論，保留筆記文字與格式。',
    '已解決討論，或移除最後一個表情且沒有留言時，取消黃色標記。',
    '連線與離線重開會保留此裝置最後讀取過的標記狀態。',
  ] },
  { version: '1.0.5', title: '自動下載更新與離線同步狀態', changes: [
    '一般筆記會自動下載更新，並顯示同步完成提示與時間。',
    '附件上傳預設 90 MB，離線附件快取預設 500 MB 並可自行調整。',
  ] },
];

export function versionInfo(version: string): VersionInfo {
  return { version, releases: releases.filter(release => !isNewerVersion(release.version, version)) };
}
