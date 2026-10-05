// Narrow test adapter around the extension registration API: captures the
// handlers the extension registers and lets tests dispatch real events
// through them. This drives the ACTUAL registered callbacks — the test never
// calls internal recovery functions directly.

import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { RecoveryIdentity } from "../../src/core/identity.ts";

export interface MockModel {
  provider: string;
  id: string;
}

export interface MockCtx {
  sessionManager: {
    getSessionId: () => string | undefined;
    getLeafId: () => string | undefined;
    getBranch: () => Array<{ type: string; id: string; customType?: string; data?: unknown }>;
  };
  model: MockModel | undefined;
  thinkingLevel: string | undefined;
  ui: { notify: (message: string, kind?: string) => Promise<void> };
}

type Handler = (event: unknown, ctx: MockCtx) => unknown;

export interface MockAgentDir {
  agentDir: string;
  cleanup: () => void;
}

export function createMockPi() {
  const agentDir = mkdtempSync(join(tmpdir(), "pinx-recovery-harness-"));
  const sessionId = `sess-${Math.random().toString(36).slice(2, 10)}`;
  const handlers = new Map<string, Handler[]>();
  const busHandlers = new Map<string, Handler[]>();
  const busLog: Array<{ channel: string; payload: unknown }> = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const sentMessages: Array<{ customType: string; content: unknown; display: boolean }> = [];
  let tools: string[] = ["read", "edit", "bash"];

  const identity = (over: Partial<RecoveryIdentity> = {}): RecoveryIdentity => ({
    sessionId: "sess-1",
    headId: "head-1",
    provider: "intern",
    model: "glm-5.3",
    thinkingLevel: undefined,
    toolLoadoutHash: "loadout-1",
    contextGeneration: 0,
    ...over,
  });

  const makeCtx = (over: Partial<MockCtx> = {}): MockCtx => ({
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => "head-1",
      getBranch: () => [],
    },
    model: { provider: "intern", id: "glm-5.3" },
    thinkingLevel: undefined,
    ui: { notify: async () => {} },
    ...over,
  });

  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerCommand: () => {},
    registerTool: () => {},
    getActiveTools: () => tools,
    getSettings: () => ({}),
    appendEntry: (customType: string, data: unknown) => {
      appendedEntries.push({ customType, data });
    },
    sendMessage: (message: { customType: string; content: unknown; display: boolean }) => {
      sentMessages.push(message);
    },
    events: {
      emit: (channel: string, payload: unknown) => {
        busLog.push({ channel, payload });
        for (const h of busHandlers.get(channel) ?? []) h(payload);
      },
      on: (channel: string, handler: (payload: unknown) => void) => {
        const list = busHandlers.get(channel) ?? [];
        list.push(handler);
        busHandlers.set(channel, list);
        return () => {};
      },
    },
    __test: {
      setTools: (names: string[]) => {
        tools = names;
      },
      dispatch: async (event: string, payload: unknown, ctxOver: Partial<MockCtx> = {}) => {
        const results: unknown[] = [];
        for (const h of handlers.get(event) ?? []) {
          results.push(await h(payload, makeCtx(ctxOver)));
        }
        return results;
      },
      busLog,
      appendedEntries,
      sentMessages,
      identity,
      setIdentityTools: (names: string[]) => {
        tools = names;
      },
    },
  };

  const cleanup = () => rmSync(agentDir, { recursive: true, force: true });
  return {
    pi: pi as typeof pi & { default?: unknown },
    agentDir,
    sessionId,
    cleanup,
    busLog,
    appendedEntries,
    sentMessages,
    dispatch: pi.__test.dispatch,
    identity,
    setTools: pi.__test.setTools,
  };
}
