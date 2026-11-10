import { z } from "zod";

/**
 * Zod Schemas for API Input Validation
 */

// --- Authentication Schemas ---
export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Please enter a valid email address."),
  password: z
    .string()
    .min(1, "Password is required."),
});

export const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Full name must be between 2 and 100 characters.")
    .max(100, "Full name must be between 2 and 100 characters."),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Please enter a valid email address.")
    .max(255, "Email address is too long."),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters long."),
  role: z
    .enum(["Front Desk", "Customer Support", "Staff", "Admin", "Manager", "Supervisor"])
    .optional(),
});

export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Please enter a valid email address."),
});

export const resetPasswordSchema = z.object({
  token: z
    .string()
    .min(10, "Invalid reset token format."),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters long."),
});

// --- Shift Schemas ---
export const shiftCreateSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Shift title cannot be empty.")
    .max(100, "Shift title must be 100 characters or fewer."),
  start_time: z
    .string()
    .refine((val) => !isNaN(Date.parse(val)), {
      message: "Start time must be a valid ISO date-time string.",
    }),
  end_time: z
    .string()
    .refine((val) => !isNaN(Date.parse(val)), {
      message: "End time must be a valid ISO date-time string.",
    }),
  user_id: z.number().int().positive().nullable().optional(),
  location: z.string().trim().max(100).nullable().optional(),
  color: z.string().trim().max(50).nullable().optional(),
}).refine(
  (data) => {
    const start = new Date(data.start_time).getTime();
    const end = new Date(data.end_time).getTime();
    return end > start;
  },
  {
    message: "End time must be strictly after start time.",
    path: ["end_time"],
  }
);

export const shiftUpdateSchema = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  start_time: z
    .string()
    .refine((val) => !isNaN(Date.parse(val)), {
      message: "Start time must be a valid ISO date-time string.",
    })
    .optional(),
  end_time: z
    .string()
    .refine((val) => !isNaN(Date.parse(val)), {
      message: "End time must be a valid ISO date-time string.",
    })
    .optional(),
  user_id: z.number().int().positive().nullable().optional(),
  location: z.string().trim().max(100).nullable().optional(),
  color: z.string().trim().max(50).nullable().optional(),
});

// --- Shift Swap Schemas ---
export const shiftSwapRequestSchema = z.object({
  shiftId: z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/).transform((v) => parseInt(v, 10)),
  ]),
  targetShiftId: z
    .union([
      z.number().int().positive(),
      z.string().regex(/^\d+$/).transform((v) => parseInt(v, 10)),
    ])
    .nullable()
    .optional(),
  targetUserId: z
    .union([
      z.number().int().positive(),
      z.string().regex(/^\d+$/).transform((v) => parseInt(v, 10)),
    ])
    .nullable()
    .optional(),
  reason: z.string().trim().max(500, "Reason cannot exceed 500 characters.").optional(),
});

export const shiftSwapRespondSchema = z.object({
  action: z.enum(["approve", "reject", "accept", "decline", "cancel"]),
});

// --- User Settings Schemas ---
export const userSettingsSchema = z.object({
  theme: z.enum(["light", "dark", "system"]).optional(),
  language: z.enum(["en", "es", "fr", "de"]).optional(),
  timezone: z.string().min(1).max(100).optional(),
  quiet_hours_enabled: z.boolean().optional(),
  quiet_hours_start: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Quiet hours start must be in HH:MM format.")
    .optional(),
  quiet_hours_end: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Quiet hours end must be in HH:MM format.")
    .optional(),
  notification_categories: z.record(z.string(), z.boolean()).optional(),
  revision: z.number().int().nonnegative().optional(),
  force: z.boolean().optional(),
});

// --- Billing Schemas ---
export const paystackInitializeSchema = z.object({
  plan: z.string().min(1, "Plan identifier is required."),
  interval: z.enum(["monthly", "yearly"]).optional(),
  callbackUrl: z.string().url("Callback URL must be a valid URL.").optional(),
});

/**
 * Generic validator helper function.
 * Returns either validated typed data or a formatted error message.
 */
export function validateInput<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: string; issues: z.ZodIssue[] } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const firstError = result.error.issues[0]?.message || "Validation failed.";
  return {
    success: false,
    error: firstError,
    issues: result.error.issues,
  };
}
