import { createLogger } from '@crowlog/logger';
import { triggerWebhook } from '@owlrelay/webhook';
import type { Address, Email } from 'postal-mime';
import PostalMime from 'postal-mime';
import packageJson from '../package.json';
import './types';

type ParsedEmail = Omit<Email, 'from'> & {
  from: Address;
  originalTo: Address[];
  originalFrom: Address;
};

type WebhookEmail = Parameters<typeof triggerWebhook>[0]['email'];

function toWebhookAttachmentContent(content: string | ArrayBuffer | Uint8Array): string | ArrayBuffer {
  if (typeof content === 'string' || content instanceof ArrayBuffer) {
    return content;
  }

  return new Uint8Array(content).buffer;
}

function toWebhookEmail(email: ParsedEmail): WebhookEmail {
  return {
    from: email.from,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    text: email.text,
    html: email.html,
    attachments: email.attachments.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      content: toWebhookAttachmentContent(attachment.content),
    })),
  };
}

async function parseEmail({
  rawMessage,
  realTo,
  realFrom,
}: {
  rawMessage: ReadableStream<Uint8Array>;
  realTo: string;
  realFrom: string;
}): Promise<{ email: ParsedEmail }> {
  const rawEmail = new Response(rawMessage);
  const parser = new PostalMime();

  const emailBuffer = await rawEmail.arrayBuffer();
  const email = await parser.parse(emailBuffer);

  const parsedFrom = email.from;

  return {
    email: {
      ...email,
      originalTo: email.to ?? [],
      originalFrom: parsedFrom ?? { address: realFrom, name: '' },
      to: [
        {
          address: realTo,
          name: email.to?.find((to) => to.address === realTo)?.name ?? '',
        },
      ],
      from: {
        address: realFrom,
        name: parsedFrom?.address === realFrom ? (parsedFrom.name ?? '') : '',
      },
    },
  };
}

class PermanentEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentEmailError';
  }
}

function parseConfig({ env }: { env: Env }) {
  const webhookUrl = env.WEBHOOK_URL;
  const webhookSecret = env.WEBHOOK_SECRET;

  if (!webhookUrl || !webhookSecret) {
    throw new PermanentEmailError('Missing required configuration: WEBHOOK_URL and WEBHOOK_SECRET');
  }

  return {
    webhookUrl,
    webhookSecret,
  };
}

function validateAccessConfig({ env }: { env: Env }) {
  const hasClientId = Boolean(env.CF_ACCESS_CLIENT_ID);
  const hasClientSecret = Boolean(env.CF_ACCESS_CLIENT_SECRET);

  if (hasClientId !== hasClientSecret) {
    throw new PermanentEmailError(
      'Incomplete Cloudflare Access configuration: set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or leave both unset',
    );
  }
}

function summarizeAttachments(attachments: ParsedEmail['attachments']) {
  const items = attachments ?? [];

  return {
    attachmentCount: items.length,
    attachmentBytes: items.reduce((total, attachment) => {
      const { content } = attachment;

      if (typeof content === 'string') {
        return total + content.length;
      }

      if (content instanceof ArrayBuffer) {
        return total + content.byteLength;
      }

      return total + content.byteLength;
    }, 0),
  };
}

/**
 * When both Access env vars are set, returns a fetch that adds Cloudflare Zero Trust
 * service-token headers so the webhook can reach an Access-protected origin.
 */
function createAccessFetch(env: Env): typeof fetch | undefined {
  const id = env.CF_ACCESS_CLIENT_ID;
  const secret = env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) {
    return undefined;
  }

  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('CF-Access-Client-Id', id);
    headers.set('CF-Access-Client-Secret', secret);
    return fetch(input, { ...init, headers });
  };
}

/** Prefer Workers' native `fetch`; `@owlrelay/webhook` defaults to `ofetch`, which can mis-handle large POST bodies. */
function resolveWebhookFetch(env: Env): typeof fetch {
  return createAccessFetch(env) ?? ((input, init) => fetch(input, init));
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

const logger = createLogger({ namespace: 'email-proxy' });
const createRequestId = ({ now = new Date() }: { now?: Date } = {}) =>
  `req_${now.getTime()}${Math.random().toString(36).substring(2, 15)}`;

const HTTP_ONLY_BODY = 'not serving HTTP';

type HealthCheck = {
  ok: boolean;
  message?: string;
};

function getConfigHealth(env: Env) {
  const hasWebhookUrl = Boolean(env.WEBHOOK_URL);
  const hasWebhookSecret = Boolean(env.WEBHOOK_SECRET);
  const hasClientId = Boolean(env.CF_ACCESS_CLIENT_ID);
  const hasClientSecret = Boolean(env.CF_ACCESS_CLIENT_SECRET);
  const hasCompleteAccessConfig = hasClientId === hasClientSecret;

  const checks = {
    webhookUrl: {
      ok: hasWebhookUrl,
      ...(hasWebhookUrl ? {} : { message: 'WEBHOOK_URL is not set' }),
    },
    webhookSecret: {
      ok: hasWebhookSecret,
      ...(hasWebhookSecret ? {} : { message: 'WEBHOOK_SECRET is not set' }),
    },
    accessConfig: {
      ok: hasCompleteAccessConfig,
      ...(hasCompleteAccessConfig
        ? {}
        : { message: 'Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or leave both unset' }),
    },
  } satisfies Record<string, HealthCheck>;

  return {
    ok: checks.webhookUrl.ok && checks.webhookSecret.ok && checks.accessConfig.ok,
    checks,
  };
}

function handleFetch(request: Request, env: Env): Response {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/health') {
    const { ok, checks } = getConfigHealth(env);

    return Response.json(
      {
        status: ok ? 'ok' : 'unhealthy',
        version: packageJson.version,
        checks,
      },
      {
        status: ok ? 200 : 503,
        headers: { 'cache-control': 'no-store' },
      },
    );
  }

  return new Response(HTTP_ONLY_BODY, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  fetch(request: Request, env: Env): Response {
    return handleFetch(request, env);
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const requestId = createRequestId();
    const messageId = message.headers.get('message-id') ?? undefined;
    const headerSubject = message.headers.get('subject') ?? undefined;

    try {
      const { webhookUrl, webhookSecret } = parseConfig({ env });
      validateAccessConfig({ env });
      const { email } = await parseEmail({
        rawMessage: message.raw,
        realTo: message.to,
        realFrom: message.from,
      });

      const { attachmentCount, attachmentBytes } = summarizeAttachments(email.attachments);

      logger.info(
        {
          from: email.from,
          originalFrom: email.originalFrom,
          to: email.to,
          originalTo: email.originalTo,
          requestId,
          messageId,
          subject: email.subject ?? headerSubject,
          attachmentCount,
          attachmentBytes,
          rawSize: message.rawSize,
        },
        'Received email',
      );

      const response = await triggerWebhook({
        email: toWebhookEmail(email),
        webhookUrl,
        webhookSecret,
        httpClient: resolveWebhookFetch(env),
      });

      if (!response.ok) {
        const bodyPreview = await response.text().then(
          (t) => t.slice(0, 500),
          () => '',
        );
        const detail = `Webhook HTTP ${response.status} ${response.statusText}${bodyPreview ? `: ${bodyPreview}` : ''}`;

        if (response.status >= 400 && response.status < 500) {
          logger.error(
            {
              requestId,
              messageId,
              subject: email.subject ?? headerSubject,
              webhookStatus: response.status,
              bodyPreview: bodyPreview || undefined,
            },
            'Webhook rejected permanently',
          );
          message.setReject(detail);
          return;
        }

        throw new Error(detail);
      }

      logger.info({ requestId, messageId, webhookStatus: response.status }, 'Webhook triggered successfully');
    } catch (error) {
      logger.error(
        {
          requestId,
          messageId,
          subject: headerSubject,
          rcptTo: message.to,
          rawSize: message.rawSize,
          ...serializeError(error),
        },
        'Email worker failed',
      );

      if (error instanceof PermanentEmailError) {
        message.setReject(error.message);
        return;
      }

      throw error;
    }
  },
};
