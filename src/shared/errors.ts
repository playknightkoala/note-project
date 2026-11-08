// Error codes shared by the API and the client; messages are what users see.
export type ErrorCode =
  | 'bad_request' | 'unauthorized' | 'forbidden' | 'csrf' | 'not_found' | 'conflict' | 'version_conflict'
  | 'precondition_required' | 'payload_too_large' | 'rate_limited' | 'invite_invalid' | 'account_disabled'
  | 'unsupported_media' | 'internal';

export const errorStatus: Record<ErrorCode, number> = {
  bad_request: 400, unauthorized: 401, forbidden: 403, csrf: 403, not_found: 404, conflict: 409, version_conflict: 409,
  precondition_required: 428, payload_too_large: 413, rate_limited: 429, invite_invalid: 400, account_disabled: 403,
  unsupported_media: 415, internal: 500,
};

export const errorMessages: Record<ErrorCode, string> = {
  bad_request: '請求格式不正確。',
  unauthorized: '請先登入。',
  forbidden: '沒有權限執行此操作。',
  csrf: '請求來源驗證失敗，請重新整理頁面後再試。',
  not_found: '找不到資料。',
  conflict: '操作與目前狀態衝突。',
  version_conflict: '此頁面已在其他地方更新。',
  precondition_required: '缺少版本資訊。',
  payload_too_large: '內容超過大小限制。',
  rate_limited: '嘗試次數過多，請稍後再試。',
  invite_invalid: '邀請碼無效或已過期。',
  account_disabled: '此帳號已停用。',
  unsupported_media: '不支援的檔案類型。',
  internal: '伺服器發生錯誤。',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? errorMessages[code]);
    this.code = code;
    this.status = errorStatus[code];
    this.details = details;
  }
}

export interface ErrorBody { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } }
