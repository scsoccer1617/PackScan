// Transactional email helper. Uses Resend's REST API when RESEND_API_KEY is
// configured; otherwise logs the email body to the console so the rest of the
// auth flow remains testable in dev environments without a provider hooked up.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'PackScan <onboarding@resend.dev>';

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(opts: SendEmailOptions): Promise<{ ok: boolean; error?: string }> {
  if (!RESEND_API_KEY) {
    console.log('[email] RESEND_API_KEY not set — printing email instead of sending.');
    console.log(`[email] To: ${opts.to}`);
    console.log(`[email] Subject: ${opts.subject}`);
    console.log(`[email] Body:\n${opts.text || opts.html}`);
    return { ok: true };
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error('[email] Resend error:', resp.status, body);
      return { ok: false, error: body };
    }
    return { ok: true };
  } catch (err: any) {
    console.error('[email] send error:', err);
    return { ok: false, error: err.message };
  }
}

export function verificationEmail(name: string | null, link: string) {
  const display = name || 'there';
  return {
    subject: 'Verify your PackScan email',
    html: `<p>Hi ${escapeHtml(display)},</p>
      <p>Welcome to PackScan! Please verify your email address by clicking the link below:</p>
      <p><a href="${link}">Verify email</a></p>
      <p>This link expires in 24 hours.</p>`,
    text: `Hi ${display},\n\nWelcome to PackScan! Verify your email by visiting:\n${link}\n\nThis link expires in 24 hours.`,
  };
}

export function passwordResetEmail(name: string | null, link: string) {
  const display = name || 'there';
  return {
    subject: 'Reset your PackScan password',
    html: `<p>Hi ${escapeHtml(display)},</p>
      <p>We received a request to reset your PackScan password. Click below to set a new one:</p>
      <p><a href="${link}">Reset password</a></p>
      <p>This link expires in 1 hour. If you did not request this, you can safely ignore this email.</p>`,
    text: `Hi ${display},\n\nReset your PackScan password by visiting:\n${link}\n\nThis link expires in 1 hour. If you did not request this, ignore this email.`,
  };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
