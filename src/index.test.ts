import type { Email } from 'postal-mime';
import PostalMime from 'postal-mime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockTriggerWebhook, mockLoggerInfo, mockLoggerError } = vi.hoisted(() => ({
  mockTriggerWebhook: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@owlrelay/webhook', () => ({
  triggerWebhook: (...args: unknown[]) => mockTriggerWebhook(...args),
}));

vi.mock('@crowlog/logger', () => ({
  createLogger: () => ({
    info: mockLoggerInfo,
    error: mockLoggerError,
  }),
}));

import packageJson from '../package.json';
import worker from './index';

function mockParsedEmail(email: Partial<Email>): Email {
  return email as Email;
}

const baseEnv: Env = {
  WEBHOOK_URL: 'https://papra.example/api/intake-emails/ingest',
  WEBHOOK_SECRET: 'test-secret',
};

function createRawStream(raw: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(raw));
      controller.close();
    },
  });
}

function createMockMessage({
  raw,
  to = 'recipient@example.com',
  from = 'sender@example.com',
  headers = {},
  rawSize = 128,
}: {
  raw: string;
  to?: string;
  from?: string;
  headers?: Record<string, string>;
  rawSize?: number;
}): ForwardableEmailMessage {
  return {
    to,
    from,
    raw: createRawStream(raw),
    rawSize,
    headers: new Headers(headers),
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  };
}

function okWebhookResponse(body = 'ok'): Response {
  return new Response(body, { status: 200, statusText: 'OK' });
}

const simpleMime = [
  'From: Alice <alice@example.com>',
  'To: Bob <bob@example.com>',
  'Subject: Hello',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello world',
].join('\r\n');

beforeEach(() => {
  vi.clearAllMocks();
  mockTriggerWebhook.mockResolvedValue(okWebhookResponse());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetch', () => {
  it('returns a static HTTP-only response for non-health routes', async () => {
    const response = worker.fetch(new Request('https://worker.example/'), {});

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('not serving HTTP');
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns healthy status when configuration is valid', async () => {
    const response = worker.fetch(new Request('https://worker.example/health'), baseEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      version: packageJson.version,
      checks: {
        webhookUrl: { ok: true },
        webhookSecret: { ok: true },
        accessConfig: { ok: true },
      },
    });
  });

  it('returns unhealthy status when webhook URL is missing', async () => {
    const response = worker.fetch(new Request('https://worker.example/health'), {
      WEBHOOK_SECRET: baseEnv.WEBHOOK_SECRET,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: 'unhealthy',
      version: packageJson.version,
      checks: {
        webhookUrl: { ok: false, message: 'WEBHOOK_URL is not set' },
        webhookSecret: { ok: true },
        accessConfig: { ok: true },
      },
    });
  });

  it('returns unhealthy status when webhook secret is missing', async () => {
    const response = worker.fetch(new Request('https://worker.example/health'), {
      WEBHOOK_URL: baseEnv.WEBHOOK_URL,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: 'unhealthy',
      version: packageJson.version,
      checks: {
        webhookUrl: { ok: true },
        webhookSecret: { ok: false, message: 'WEBHOOK_SECRET is not set' },
        accessConfig: { ok: true },
      },
    });
  });

  it('returns unhealthy status when Cloudflare Access config is incomplete', async () => {
    const response = worker.fetch(new Request('https://worker.example/health'), {
      ...baseEnv,
      CF_ACCESS_CLIENT_ID: 'client-id',
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: 'unhealthy',
      version: packageJson.version,
      checks: {
        webhookUrl: { ok: true },
        webhookSecret: { ok: true },
        accessConfig: {
          ok: false,
          message: 'Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or leave both unset',
        },
      },
    });
  });
});

describe('email', () => {
  it('forwards parsed email to the webhook on success', async () => {
    const message = createMockMessage({
      raw: simpleMime,
      to: 'bob@example.com',
      from: 'alice@example.com',
      headers: {
        'message-id': '<msg-1@example.com>',
        subject: 'Header subject',
      },
    });

    await worker.email(message, baseEnv);

    expect(mockTriggerWebhook).toHaveBeenCalledOnce();
    expect(message.setReject).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.stringMatching(/^req_\d+[a-z0-9]+$/),
        messageId: '<msg-1@example.com>',
        subject: 'Hello',
        attachmentCount: 0,
        attachmentBytes: 0,
      }),
      'Received email',
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ webhookStatus: 200 }),
      'Webhook triggered successfully',
    );
  });

  it('rejects permanently when required webhook config is missing', async () => {
    const message = createMockMessage({ raw: simpleMime });

    await worker.email(message, { WEBHOOK_URL: 'https://papra.example' });

    expect(message.setReject).toHaveBeenCalledWith('Missing required configuration: WEBHOOK_URL and WEBHOOK_SECRET');
    expect(mockTriggerWebhook).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'PermanentEmailError' }),
      'Email worker failed',
    );
  });

  it('rejects permanently when Cloudflare Access config is incomplete', async () => {
    const message = createMockMessage({ raw: simpleMime });

    await worker.email(message, {
      ...baseEnv,
      CF_ACCESS_CLIENT_ID: 'client-id',
    });

    expect(message.setReject).toHaveBeenCalledWith(
      'Incomplete Cloudflare Access configuration: set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or leave both unset',
    );
    expect(mockTriggerWebhook).not.toHaveBeenCalled();
  });

  it('rejects permanently on 4xx webhook responses with a body preview', async () => {
    const message = createMockMessage({ raw: simpleMime });
    mockTriggerWebhook.mockResolvedValue(
      new Response('invalid payload details', { status: 422, statusText: 'Unprocessable Entity' }),
    );

    await worker.email(message, baseEnv);

    expect(message.setReject).toHaveBeenCalledWith('Webhook HTTP 422 Unprocessable Entity: invalid payload details');
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookStatus: 422,
        bodyPreview: 'invalid payload details',
      }),
      'Webhook rejected permanently',
    );
  });

  it('rejects permanently on 4xx webhook responses when body text cannot be read', async () => {
    const message = createMockMessage({ raw: simpleMime });
    mockTriggerWebhook.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: () => Promise.reject(new Error('stream closed')),
    } as Response);

    await worker.email(message, baseEnv);

    expect(message.setReject).toHaveBeenCalledWith('Webhook HTTP 400 Bad Request');
  });

  it('rethrows on 5xx webhook responses', async () => {
    const message = createMockMessage({ raw: simpleMime });
    mockTriggerWebhook.mockResolvedValue(new Response('upstream error', { status: 503, statusText: 'Unavailable' }));

    await expect(worker.email(message, baseEnv)).rejects.toThrow('Webhook HTTP 503 Unavailable: upstream error');
    expect(message.setReject).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(expect.objectContaining({ name: 'Error' }), 'Email worker failed');
  });

  it('rethrows non-permanent errors after logging', async () => {
    const message = createMockMessage({ raw: simpleMime });
    mockTriggerWebhook.mockRejectedValue('transient failure');

    await expect(worker.email(message, baseEnv)).rejects.toBe('transient failure');
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'transient failure' }),
      'Email worker failed',
    );
  });

  it('rejects permanently when only the Access client secret is set', async () => {
    const message = createMockMessage({ raw: simpleMime });

    await worker.email(message, {
      ...baseEnv,
      CF_ACCESS_CLIENT_SECRET: 'client-secret',
    });

    expect(message.setReject).toHaveBeenCalledWith(
      'Incomplete Cloudflare Access configuration: set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or leave both unset',
    );
  });

  it('uses the default fetch client when Access env vars are unset', async () => {
    const message = createMockMessage({ raw: simpleMime });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await worker.email(message, baseEnv);

    const { httpClient } = mockTriggerWebhook.mock.calls[0][0] as { httpClient: typeof fetch };
    await httpClient('https://papra.example/webhook');

    expect(fetchSpy).toHaveBeenCalledWith('https://papra.example/webhook', undefined);
  });

  it('adds Cloudflare Access headers when service token env vars are set', async () => {
    const message = createMockMessage({ raw: simpleMime });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await worker.email(message, {
      ...baseEnv,
      CF_ACCESS_CLIENT_ID: 'access-client-id',
      CF_ACCESS_CLIENT_SECRET: 'access-client-secret',
    });

    const { httpClient } = mockTriggerWebhook.mock.calls[0][0] as { httpClient: typeof fetch };
    await httpClient('https://protected.example/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://protected.example/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
      }),
    );

    const headers = fetchSpy.mock.calls[0][1]?.headers as Headers;
    expect(headers.get('CF-Access-Client-Id')).toBe('access-client-id');
    expect(headers.get('CF-Access-Client-Secret')).toBe('access-client-secret');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('maps parsed addresses, attachment content types, and webhook payload shape', async () => {
    const parseSpy = vi.spyOn(PostalMime.prototype, 'parse').mockResolvedValue(
      mockParsedEmail({
        from: { address: 'header-sender@example.com', name: 'Header Sender' },
        to: [
          { address: 'recipient@example.com', name: 'Recipient Name' },
          { address: 'other@example.com', name: 'Other' },
        ],
        cc: [{ address: 'cc@example.com', name: 'CC' }],
        subject: 'Attachments',
        text: 'plain text',
        html: '<p>html</p>',
        attachments: [
          {
            filename: 'note.txt',
            mimeType: 'text/plain',
            disposition: 'attachment',
            content: 'hello',
          },
          {
            filename: 'buffer.bin',
            mimeType: 'application/octet-stream',
            disposition: 'attachment',
            content: new ArrayBuffer(4),
          },
          {
            filename: 'bytes.bin',
            mimeType: 'application/octet-stream',
            disposition: 'attachment',
            content: new Uint8Array([1, 2, 3]),
          },
        ],
      }),
    );

    const message = createMockMessage({
      raw: simpleMime,
      to: 'recipient@example.com',
      from: 'envelope-sender@example.com',
    });

    await worker.email(message, baseEnv);

    expect(parseSpy).toHaveBeenCalled();
    expect(mockTriggerWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: baseEnv.WEBHOOK_URL,
        webhookSecret: baseEnv.WEBHOOK_SECRET,
        email: {
          from: { address: 'envelope-sender@example.com', name: '' },
          to: [{ address: 'recipient@example.com', name: 'Recipient Name' }],
          cc: [{ address: 'cc@example.com', name: 'CC' }],
          subject: 'Attachments',
          text: 'plain text',
          html: '<p>html</p>',
          attachments: [
            {
              filename: 'note.txt',
              mimeType: 'text/plain',
              content: 'hello',
            },
            {
              filename: 'buffer.bin',
              mimeType: 'application/octet-stream',
              content: expect.any(ArrayBuffer),
            },
            {
              filename: 'bytes.bin',
              mimeType: 'application/octet-stream',
              content: expect.any(ArrayBuffer),
            },
          ],
        },
      }),
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        originalFrom: { address: 'header-sender@example.com', name: 'Header Sender' },
        originalTo: [
          { address: 'recipient@example.com', name: 'Recipient Name' },
          { address: 'other@example.com', name: 'Other' },
        ],
        attachmentCount: 3,
        attachmentBytes: 12,
      }),
      'Received email',
    );
  });

  it('uses the header subject when the parsed email has no subject', async () => {
    vi.spyOn(PostalMime.prototype, 'parse').mockResolvedValue(
      mockParsedEmail({
        from: { address: 'sender@example.com', name: '' },
        to: [{ address: 'recipient@example.com', name: '' }],
        attachments: [],
      }),
    );

    const message = createMockMessage({
      raw: simpleMime,
      headers: { subject: 'Header-only subject' },
    });

    await worker.email(message, baseEnv);

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Header-only subject' }),
      'Received email',
    );
  });

  it('uses the header subject in permanent webhook rejection logs', async () => {
    vi.spyOn(PostalMime.prototype, 'parse').mockResolvedValue(
      mockParsedEmail({
        from: { address: 'sender@example.com', name: '' },
        to: [{ address: 'recipient@example.com', name: '' }],
        attachments: [],
      }),
    );

    const message = createMockMessage({
      raw: simpleMime,
      headers: { subject: 'Header-only subject' },
    });
    mockTriggerWebhook.mockResolvedValue(new Response('bad request', { status: 400, statusText: 'Bad Request' }));

    await worker.email(message, baseEnv);

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Header-only subject', webhookStatus: 400 }),
      'Webhook rejected permanently',
    );
  });

  it('treats missing attachment lists as empty when summarizing and forwarding', async () => {
    vi.spyOn(PostalMime.prototype, 'parse').mockResolvedValue(
      mockParsedEmail({
        from: { address: 'sender@example.com', name: '' },
        to: [{ address: 'recipient@example.com', name: '' }],
        subject: 'No attachments field',
      }),
    );

    const message = createMockMessage({ raw: simpleMime });

    await worker.email(message, baseEnv);

    expect(mockTriggerWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        email: expect.objectContaining({ attachments: [] }),
      }),
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentCount: 0, attachmentBytes: 0 }),
      'Received email',
    );
  });

  it('clears the from display name when envelope from matches but parsed name is missing', async () => {
    vi.spyOn(PostalMime.prototype, 'parse').mockResolvedValue(
      mockParsedEmail({
        from: { address: 'sender@example.com' } as Email['from'],
        to: [{ address: 'recipient@example.com', name: '' }],
        subject: 'Missing from name',
        attachments: [],
      }),
    );

    const message = createMockMessage({
      raw: simpleMime,
      from: 'sender@example.com',
    });

    await worker.email(message, baseEnv);

    expect(mockTriggerWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        email: expect.objectContaining({
          from: { address: 'sender@example.com', name: '' },
        }),
      }),
    );
  });

  it('uses an empty original recipient list when parsed to is missing', async () => {
    vi.spyOn(PostalMime.prototype, 'parse').mockResolvedValue(
      mockParsedEmail({
        from: { address: 'sender@example.com', name: '' },
        subject: 'No recipients',
        attachments: [],
      }),
    );

    const message = createMockMessage({
      raw: simpleMime,
      to: 'recipient@example.com',
    });

    await worker.email(message, baseEnv);

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        originalTo: [],
        to: [{ address: 'recipient@example.com', name: '' }],
      }),
      'Received email',
    );
  });

  it('falls back to envelope addresses when parsed from is missing', async () => {
    vi.spyOn(PostalMime.prototype, 'parse').mockResolvedValue(
      mockParsedEmail({
        to: [{ address: 'recipient@example.com', name: '' }],
        subject: 'No from header',
      }),
    );

    const message = createMockMessage({
      raw: simpleMime,
      to: 'recipient@example.com',
      from: 'envelope-sender@example.com',
    });

    await worker.email(message, baseEnv);

    expect(mockTriggerWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        email: expect.objectContaining({
          from: { address: 'envelope-sender@example.com', name: '' },
        }),
      }),
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        originalFrom: { address: 'envelope-sender@example.com', name: '' },
        attachmentCount: 0,
        attachmentBytes: 0,
      }),
      'Received email',
    );
  });

  it('preserves parsed from name when envelope from matches the header from', async () => {
    vi.spyOn(PostalMime.prototype, 'parse').mockResolvedValue(
      mockParsedEmail({
        from: { address: 'sender@example.com', name: 'Sender Name' },
        to: [{ address: 'recipient@example.com', name: '' }],
        subject: 'Matched from',
        attachments: [],
      }),
    );

    const message = createMockMessage({
      raw: simpleMime,
      to: 'recipient@example.com',
      from: 'sender@example.com',
    });

    await worker.email(message, baseEnv);

    expect(mockTriggerWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        email: expect.objectContaining({
          from: { address: 'sender@example.com', name: 'Sender Name' },
        }),
      }),
    );
  });
});
