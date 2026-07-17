/// <reference path="../worker-configuration.d.ts" />

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: interface merging with generated Env
  interface Env {
    WEBHOOK_SECRET?: string;
    WEBHOOK_URL?: string;
    CF_ACCESS_CLIENT_ID?: string;
    CF_ACCESS_CLIENT_SECRET?: string;
  }
}

export {};
