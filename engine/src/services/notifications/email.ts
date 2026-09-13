import nodemailer from "nodemailer";

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    });
  }
  return transporter;
}

export async function sendEmail(config: unknown, message: string) {
  const to = typeof config === "object" && config && "to" in config ? String((config as { to: unknown }).to) : undefined;
  if (!to) throw new Error("Email channel config is missing 'to'");
  await getTransporter().sendMail({
    from: process.env.SMTP_FROM ?? "Looksee <looksee@localhost>",
    to,
    subject: "Looksee alert",
    text: message,
  });
}
