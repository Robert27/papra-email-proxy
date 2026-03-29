import type { Address, Email } from 'postal-mime';
import type { Env } from './types';
import { createLogger } from '@crowlog/logger';
import { triggerWebhook } from '@owlrelay/webhook';
import PostalMime from 'postal-mime';

async function parseEmail({
  rawMessage,
  realTo,
  realFrom,
}: {
  rawMessage: ReadableStream<Uint8Array>;
  realTo: string;
  realFrom: string;
}): Promise<{ email: Email & { originalTo: Address[]; originalFrom: Address } }> {
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
          name: email.to?.find(to => to.address === realTo)?.name ?? '',
        },
      ],
      from: {
        address: realFrom,
        name: parsedFrom?.address === realFrom ? (parsedFrom.name ?? '') : '',
      },
    },
  };
}

function parseConfig({ env }: { env: Env }) {
  const webhookUrl = env.WEBHOOK_URL;
  const webhookSecret = env.WEBHOOK_SECRET;

  if (!webhookUrl || !webhookSecret) {
    throw new Error('Missing required configuration: WEBHOOK_URL and WEBHOOK_SECRET');
  }

  return {
    webhookUrl,
    webhookSecret,
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
const createRequestId = ({ now = new Date() }: { now?: Date } = {}) => `req_${now.getTime()}${Math.random().toString(36).substring(2, 15)}`;

const HTTP_ONLY_BODY
  = 'not serving HTTP';

export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response(HTTP_ONLY_BODY, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const requestId = createRequestId();

    try {
      const { webhookUrl, webhookSecret } = parseConfig({ env });
      const { email } = await parseEmail({
        rawMessage: message.raw,
        realTo: message.to,
        realFrom: message.from,
      });

      logger.info({
        from: email.from,
        originalFrom: email.originalFrom,
        to: email.to,
        originalTo: email.originalTo,
        requestId,
        rawSize: message.rawSize,
      }, 'Received email');

      const response = await triggerWebhook({
        email,
        webhookUrl,
        webhookSecret,
        httpClient: resolveWebhookFetch(env),
      });

      if (!response.ok) {
        const bodyPreview = await response.text().then(
          t => t.slice(0, 500),
          () => '',
        );
        throw new Error(
          `Webhook HTTP ${response.status} ${response.statusText}${bodyPreview ? `: ${bodyPreview}` : ''}`,
        );
      }

      logger.info({ requestId }, 'Webhook triggered successfully');
    } catch (error) {
      logger.error({
        requestId,
        rcptTo: message.to,
        rawSize: message.rawSize,
        ...serializeError(error),
      }, 'Email worker failed');
      throw error;
    }
  },
};
