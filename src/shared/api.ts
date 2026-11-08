// Request/response contracts shared by server validation and client typing.
import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9_.-]{3,32}$/, '使用者名稱只能用小寫英數字、底線、點與連字號，3 到 32 字');
export const passwordSchema = z.string().min(10, '密碼至少 10 個字元').max(200);
export const displayNameSchema = z.string().trim().min(1, '請輸入顯示名稱').max(80);

export const registerSchema = z.object({
  email: emailSchema,
  username: usernameSchema.optional(),
  displayName: displayNameSchema,
  password: passwordSchema,
  inviteCode: z.string().trim().min(1).max(200).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export const profileUpdateSchema = z.object({
  displayName: displayNameSchema.optional(),
  username: usernameSchema.nullable().optional(),
});

export const inviteCreateSchema = z.object({
  expiresInHours: z.number().int().min(1).max(720).default(72),
  note: z.string().trim().max(200).optional(),
});

export const userUpdateSchema = z.object({
  disabled: z.boolean().optional(),
  role: z.enum(['admin', 'user']).optional(),
});

export interface UserDto {
  id: string;
  email: string;
  username: string | null;
  displayName: string;
  role: 'admin' | 'user';
  createdAt: number;
}

export interface AdminUserDto extends UserDto { disabledAt: number | null; pageCount: number }

export interface SessionDto { user: UserDto; csrfToken: string }

export interface InviteDto {
  id: string;
  note: string | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedBy: string | null;
  revokedAt: number | null;
}

export interface AuthStatusDto { setupRequired: boolean }
