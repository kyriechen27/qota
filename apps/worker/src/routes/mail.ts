import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser, requireAdmin } from '../middleware/auth';
import { getMailSettings, getMailStatus, saveMailSettings, getMailConfig, mailAddress } from '../lib/mail-config';
import { sendMail, SMTPError } from '../lib/smtp';
import { audit } from '../lib/audit';
import { HttpError } from '../utils/errors';

export const mailRoutes = new Hono<AppEnv>();
mailRoutes.use('*', requireUser);

mailRoutes.get('/status', async (c) => c.json(await getMailStatus(c.env)));

mailRoutes.get('/settings', requireAdmin, async (c) => c.json(await getMailSettings(c.env)));

mailRoutes.put('/settings', requireAdmin, async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  const settings = await saveMailSettings(c.env, c.get('user')!.id, body);
  await audit(c, {
    action: 'mail.settings.update', targetType: 'mail_settings', targetId: 1,
    meta: { enabled: settings.enabled },
  });
  return c.json(settings);
});

mailRoutes.post('/test', requireAdmin, async (c) => {
  const body = await c.req.json<{ to?: unknown }>().catch(() => null);
  const to = mailAddress(body?.to);
  const config = await getMailConfig(c.env, { requireEnabled: false });
  try {
    await sendMail(c.env, config, {
      to, subject: 'QOTA 邮件配置测试',
      text: '这是一封 QOTA 邮件配置测试邮件。收到此邮件表示邮件发送配置可用。',
    });
  } catch (error) {
    await audit(c, { action: 'mail.test', targetType: 'mail_settings', targetId: 1, meta: { ok: false } });
    // Never return or log the upstream server reply, credentials or endpoint.
    const safeCodes = ['smtp_auth', 'smtp_connect', 'smtp_tls', 'smtp_timeout', 'smtp_recipient', 'smtp_send'];
    const code = error instanceof SMTPError && safeCodes.includes(error.code) ? error.code : 'mail_test_failed';
    const messages: Record<string, string> = {
      smtp_auth: 'mail authentication failed; check the username and password',
      smtp_connect: 'could not connect to the mail server; check the host and port',
      smtp_tls: 'secure mail connection failed; check the security mode and server certificate',
      smtp_timeout: 'the mail server timed out; try again later',
      smtp_recipient: 'the mail server did not accept the recipient address',
    };
    throw new HttpError(502, code, messages[code] ?? 'test email could not be sent; check the saved mail settings');
  }
  await audit(c, { action: 'mail.test', targetType: 'mail_settings', targetId: 1, meta: { ok: true } });
  return c.json({ ok: true });
});
