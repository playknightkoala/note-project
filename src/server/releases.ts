import type { VersionInfo } from '../shared/version.ts';
import { isNewerVersion } from '../shared/version.ts';

const releases: VersionInfo['releases'] = [
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
