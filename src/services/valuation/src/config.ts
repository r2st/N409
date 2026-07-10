import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3001),
  DATABASE_URL: z.string().min(1).default('postgres://n409:n409_dev@localhost:5432/n409_dev'),
  LOG_LEVEL: z.string().default('info'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_ISSUER: z.string().default('n409'),
  JWT_TTL_SECONDS: z.coerce.number().int().default(28800),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  // M1 core pipeline — internal service URLs + document storage
  AI_URL: z.string().url().default('http://127.0.0.1:3002'),
  ENGINE_URL: z.string().url().default('http://127.0.0.1:3003'),
  DOCUMENTS_DIR: z.string().min(1).default('./data/documents'),
  // Auto-pipeline on upload (extraction → param fill → draft calculation).
  // 'off' disables it globally; per-valuation opt-out is valuations.auto_pipeline.
  AUTO_PIPELINE: z.enum(['on', 'off']).default('on'),
  // Auto email workflows — 'smtp' delivers through SMTP_HOST; 'log' records
  // delivery in the service log (outbox rows track status either way); 'off'
  // only queues. 'smtp' without SMTP_HOST falls back to 'log'.
  EMAIL_MODE: z.enum(['smtp', 'log', 'off']).default('log'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('N409 Valuations <no-reply@n409.local>'),
  // SMS drip campaigns (§15.6) — 'log' records delivery in the service log
  // (a real provider adapter slots into buildEmailTransports); 'off' only
  // queues outbox rows.
  SMS_MODE: z.enum(['log', 'off']).default('log'),
  // Drip campaign scan interval in minutes; 0 disables the interval (the
  // POST /admin/auto-emails/run endpoint still works).
  AUTO_EMAIL_SCAN_MINUTES: z.coerce.number().int().min(0).default(15),
  // Stripe payment processing (remaining-gaps §3 #1). Routes 503 when unset.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Base URL the browser lands on after Stripe checkout (the web frontend).
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  // Accounting integrations (§23) — each provider activates when its OAuth
  // client id + secret are both set; unset providers show as "not configured".
  XERO_CLIENT_ID: z.string().optional(),
  XERO_CLIENT_SECRET: z.string().optional(),
  QUICKBOOKS_CLIENT_ID: z.string().optional(),
  QUICKBOOKS_CLIENT_SECRET: z.string().optional(),
  FRESHBOOKS_CLIENT_ID: z.string().optional(),
  FRESHBOOKS_CLIENT_SECRET: z.string().optional(),
  NETSUITE_CLIENT_ID: z.string().optional(),
  NETSUITE_CLIENT_SECRET: z.string().optional(),
  SAGE_CLIENT_ID: z.string().optional(),
  SAGE_CLIENT_SECRET: z.string().optional(),
  WAVE_CLIENT_ID: z.string().optional(),
  WAVE_CLIENT_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
