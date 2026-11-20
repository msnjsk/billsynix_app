import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** Every environment variable the API reads, validated once at start-up. */
export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    API_PREFIX: z
      .string()
      .default('api/v1')
      .transform((p) => p.replace(/^\/+|\/+$/g, '')),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z
      .string()
      .regex(
        /^postgres(ql)?:\/\//,
        'must be a postgresql:// connection string',
      ),
    DIRECT_URL: z.string().optional(),
    CORS_ORIGINS: list,
    SWAGGER_ENABLED: bool,
    // Access-token signing secret: ≥ 16 characters anywhere, ≥ 32 in production (checked below).
    // (Refresh tokens are opaque random values stored hashed — they need no secret.)
    JWT_ACCESS_SECRET: z.string().min(16, 'must be at least 16 characters'),
    /** Browser origin of the web app; password-reset links point here. */
    FRONTEND_URL: z.url().default('http://localhost:3000'),
    MAIL_FROM: z.string().default('Billing <no-reply@billing.local>'),
    /** Set when behind a load balancer/reverse proxy so client IPs (rate limits, audit) are real. */
    TRUST_PROXY: bool,
    /** Requests per minute per client IP, all endpoints. */
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
    /** Sign-in / PIN / password-reset attempts per minute per client IP. */
    AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
    /** Where uploaded files go: `local` disk (development, single server) or an S3-compatible store. */
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('storage'),
    /** Leave empty for AWS S3; set for R2 / MinIO (path-style addressing is used). */
    OBJECT_STORAGE_ENDPOINT: z
      .string()
      .optional()
      .transform((v) => v || undefined)
      .pipe(z.url().optional()),
    OBJECT_STORAGE_REGION: z.string().default('auto'),
    OBJECT_STORAGE_BUCKET: z.string().optional(),
    OBJECT_STORAGE_ACCESS_KEY: z.string().optional(),
    OBJECT_STORAGE_SECRET_KEY: z.string().optional(),
    /** Subscription payments (Phase 10): `none` until a gateway account is set up. */
    PAYMENT_PROVIDER: z.enum(['none', 'razorpay']).default('none'),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    /** Secret set on the Razorpay webhook; signatures of incoming webhooks are checked with it. */
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === 's3') {
      for (const k of [
        'OBJECT_STORAGE_BUCKET',
        'OBJECT_STORAGE_ACCESS_KEY',
        'OBJECT_STORAGE_SECRET_KEY',
      ] as const) {
        if (!env[k])
          ctx.addIssue({
            code: 'custom',
            path: [k],
            message: 'is required when STORAGE_DRIVER=s3',
          });
      }
    }
    if (env.PAYMENT_PROVIDER === 'razorpay') {
      for (const k of [
        'RAZORPAY_KEY_ID',
        'RAZORPAY_KEY_SECRET',
        'RAZORPAY_WEBHOOK_SECRET',
      ] as const) {
        if (!env[k])
          ctx.addIssue({
            code: 'custom',
            path: [k],
            message: 'is required when PAYMENT_PROVIDER=razorpay',
          });
      }
    }
    if (env.NODE_ENV !== 'production') return;
    if (env.JWT_ACCESS_SECRET.length < 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_ACCESS_SECRET'],
        message: 'must be at least 32 characters in production',
      });
    }
    if (env.CORS_ORIGINS.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'wildcard origin is not allowed in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parses `source` (normally `process.env`). Throws one readable error listing every problem,
 * so a misconfigured deployment fails at boot instead of on the first request.
 */
export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  current = result.data;
  return result.data;
}

let current: Env | undefined;

/**
 * The configuration most recently loaded by the app. For code that runs outside dependency
 * injection (e.g. rate-limit decorators); everything else should inject `ENV`.
 */
export function getEnv(): Env {
  current ??= loadEnv();
  return current;
}
