import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { smtpSettings } from "../../db/schema.js";

// DB settings (the admin-UI path, see routes/smtp.ts) win per-field over the
// env vars — the env vars are a fallback for an existing .env-based setup,
// not removed, since this used to be the only way to configure it.
async function resolveSettings() {
  const [row] = await db.select().from(smtpSettings).where(eq(smtpSettings.id, 1)).limit(1);
  return {
    host: row?.host || process.env.SMTP_HOST,
    port: row?.port || Number(process.env.SMTP_PORT ?? 587),
    user: row?.user || process.env.SMTP_USER,
    password: row?.password || process.env.SMTP_PASSWORD,
    from: row?.from || process.env.SMTP_FROM || "Looksee <looksee@localhost>",
  };
}

// Rebuilt whenever settings actually change (cheap JSON-equality check)
// rather than on every send — nodemailer transporters are meant to be
// reused, and settings changes are rare (an admin saving the settings
// form), not per-request.
let cached: { transporter: ReturnType<typeof nodemailer.createTransport>; from: string; key: string } | null = null;

async function getTransporter() {
  const settings = await resolveSettings();
  const key = JSON.stringify(settings);
  if (!cached || cached.key !== key) {
    cached = {
      transporter: nodemailer.createTransport({
        host: settings.host,
        port: settings.port,
        auth: settings.user ? { user: settings.user, pass: settings.password } : undefined,
      }),
      from: settings.from,
      key,
    };
  }
  return cached;
}

export async function sendEmail(config: unknown, message: string) {
  const to = typeof config === "object" && config && "to" in config ? String((config as { to: unknown }).to) : undefined;
  if (!to) throw new Error("Email channel config is missing 'to'");
  const { transporter, from } = await getTransporter();
  await transporter.sendMail({ from, to, subject: "Looksee alert", text: message });
}

// Used by the "Send test email" button on the Channels page — lets someone
// confirm their SMTP settings actually work without waiting for a real
// alert to fire.
export async function sendTestEmail(to: string) {
  const { transporter, from } = await getTransporter();
  await transporter.sendMail({
    from,
    to,
    subject: "Looksee test email",
    text: "This is a test email from Looksee to confirm your SMTP settings work.",
  });
}
