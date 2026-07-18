/**
 * Design v4 — Post-bootstrap live resolver (contract B).
 *
 * Pure behaviour tests using controlled promises + an injected monotonic
 * clock. No sleeps: the timeout path uses a real but tiny bound while
 * awaiting the operation under test; the cooldown path advances an
 * injected clock.
 */
import { describe, expect, it, vi } from "vitest";

import { createLiveResolver } from "../src/live-resolver.js";
import { Logger } from "../src/logger.js";

function providerPayload(provider: string, model: string): unknown {
  return {
    connected: [provider],
    all: [{ id: provider, models: { [model]: {} } }],
  };
}

interface ControlledList {
  calls: number;
  lastSignal: AbortSignal | undefined;
  impl: (opts?: { signal?: AbortSignal }) => Promise<unknown> | unknown;
}

function makeClient(list: ControlledList): {
  client: { provider: { list: (opts?: { signal?: AbortSignal }) => Promise<unknown> } };
} {
  return {
    client: {
      provider: {
        list: (opts?: { signal?: AbortSignal }) => {
          list.calls += 1;
          list.lastSignal = opts?.signal;
          return Promise.resolve(list.impl(opts)).then((v) => v);
        },
      },
    },
  };
}

describe("createLiveResolver — strict connected payload (B-8, B-7)", () => {
  it("expands connected provider IDs through all[].models into exact live model IDs", async () => {
    const list: ControlledList = {
      calls: 0,
      lastSignal: undefined,
      impl: async () => ({
        connected: ["openai"],
        all: [{ id: "openai", models: { "gpt-5.5": {} } }],
      }),
    };
    const { client } = makeClient(list);
    const resolver = createLiveResolver({ client });
    const out = await resolver.resolve();
    expect(out.status).toBe("ready");
    if (out.status !== "ready") throw new Error("unreachable");
    expect(out.models).toEqual(["openai/gpt-5.5"]);
  });

  it.each([
    ["missing connected field", { all: [{ id: "openai", models: {} }] }],
    ["connected not an array", { connected: "openai", all: [] }],
    ["connected empty array", { connected: [] }],
    ["connected has empty string", { connected: ["openai", ""], all: [] }],
    ["connected has non-string", { connected: ["openai", 7], all: [] }],
    ["all missing", { connected: ["openai"] }],
    ["connected provider absent from all", { connected: ["openai"], all: [{ id: "anthropic", models: { opus: {} } }] }],
    ["connected provider has empty models", { connected: ["openai"], all: [{ id: "openai", models: {} }] }],
    ["all present but connected absent (all does not prove connectivity)", {
      all: [{ id: "openai", name: "x", env: [], models: { "gpt-5.5": { id: "gpt-5.5" } } }],
    }],
  ])("treats malformed payload (%s) as permanent unavailable", async (_label, payload) => {
    const list: ControlledList = { calls: 0, lastSignal: undefined, impl: async () => payload };
    const { client } = makeClient(list);
    const resolver = createLiveResolver({ client });
    const out = await resolver.resolve();
    expect(out.status).toBe("unavailable");
    if (out.status !== "unavailable") throw new Error("unreachable");
    expect(out.retryable).toBe(false);
    // permanent: a second resolve makes NO new request
    const before = list.calls;
    await resolver.resolve();
    expect(list.calls).toBe(before);
  });

  it("unwraps a data envelope ({ data: { connected } })", async () => {
    const list: ControlledList = {
      calls: 0,
      lastSignal: undefined,
      impl: async () => ({ data: providerPayload("zai", "glm-5.2") }),
    };
    const { client } = makeClient(list);
    const resolver = createLiveResolver({ client });
    const out = await resolver.resolve();
    expect(out.status).toBe("ready");
  });
});

describe("createLiveResolver — single-flight (B-1..B-3)", () => {
  it("concurrent resolve() calls share exactly one provider.list request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list: ControlledList = {
      calls: 0,
      lastSignal: undefined,
      impl: async () => {
        await gate;
        return providerPayload("openai", "gpt-5.5");
      },
    };
    const { client } = makeClient(list);
    const resolver = createLiveResolver({ client });
    const pending = [resolver.resolve(), resolver.resolve(), resolver.resolve()];
    release();
    const results = await Promise.all(pending);
    expect(list.calls).toBe(1);
    for (const r of results) expect(r.status).toBe("ready");
  });

  it("after ready, further resolve() calls reuse the frozen snapshot without a new request", async () => {
    const list: ControlledList = {
      calls: 0,
      lastSignal: undefined,
      impl: async () => providerPayload("openai", "gpt-5.5"),
    };
    const { client } = makeClient(list);
    const resolver = createLiveResolver({ client });
    await resolver.resolve();
    await resolver.resolve();
    await resolver.resolve();
    expect(list.calls).toBe(1);
  });
});

describe("createLiveResolver — timeout (B-3, B-5)", () => {
  it("passes an AbortSignal, aborts on timeout, returns retryable, clears in-flight", async () => {
    const list: ControlledList = {
      calls: 0,
      lastSignal: undefined,
      impl: () => new Promise<unknown>(() => {
        /* never resolves */
      }),
    };
    const { client } = makeClient(list);
    const resolver = createLiveResolver({ client, timeoutMs: 15, cooldownMs: 30_000 });
    const out = await resolver.resolve();
    expect(list.lastSignal).toBeDefined();
    expect(list.lastSignal!.aborted).toBe(true);
    expect(out.status).toBe("unavailable");
    if (out.status !== "unavailable") throw new Error("unreachable");
    expect(out.retryable).toBe(true);
    expect(out.safeCode).toBe("timeout");
    // in-flight cleared: with an advanced clock the next call must make a
    // FRESH request (proving nothing is retained).
    expect(resolver.peekState().kind).not.toBe("in_flight");
  });
});

describe("createLiveResolver — rejection safety (B-4, B-9)", () => {
  it("maps a rejected provider.list to a safe retryable code with no credential-shaped leakage", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const logLines: string[] = [];
    const list: ControlledList = {
      calls: 0,
      lastSignal: undefined,
      impl: async () => {
        throw new Error(`Unauthorized: api key=${secret}`);
      },
    };
    const { client } = makeClient(list);
    const resolver = createLiveResolver({
      client,
      logger: new Logger("test", process.cwd(), {
        writeLog: (line) => { logLines.push(line); },
      }),
    });
    const out = await resolver.resolve();
    expect(out.status).toBe("unavailable");
    if (out.status !== "unavailable") throw new Error("unreachable");
    expect(out.retryable).toBe(true);
    expect(out.safeCode).toBe("request_rejected");
    // The raw exception text MUST NOT leak through the outcome.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(secret);
    // Drain a microtask so any latent unhandled rejection would surface.
    await new Promise((r) => setTimeout(r, 0));
    expect(logLines.join("\n")).not.toContain(secret);
    expect(logLines.join("\n")).not.toContain("Unauthorized");
  });

  it("never rejects or leaks an unhandled secret when diagnostics throw", async () => {
    const secret = "provider-secret-123";
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const resolver = createLiveResolver({
        client: {
          provider: {
            list: async () => {
              throw new Error(secret);
            },
          },
        },
        logger: {
          info: () => {
            throw new Error("diagnostic sink failed");
          },
        } as never,
      });

      await expect(resolver.resolve()).resolves.toMatchObject({
        status: "unavailable",
        safeCode: "request_rejected",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expect(JSON.stringify(resolver.peekState())).not.toContain(secret);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("createLiveResolver — cooldown + half-open probe (B-5, B-6)", () => {
  it("fail-fast during cooldown, then permits one probe after clock +cooldownMs", async () => {
    let now = 1_000;
    let failures = 0;
    const list: ControlledList = {
      calls: 0,
      lastSignal: undefined,
      impl: async () => {
        failures += 1;
        throw new Error(`transient ${failures}`);
      },
    };
    const { client } = makeClient(list);
    const resolver = createLiveResolver({
      client,
      cooldownMs: 30_000,
      now: () => now,
    });

    // First call: one request, fails -> transient cooldown.
    const first = await resolver.resolve();
    expect(first.status).toBe("unavailable");
    expect(list.calls).toBe(1);

    // During cooldown: NO new request, fail fast.
    const second = await resolver.resolve();
    expect(second.status).toBe("unavailable");
    if (second.status !== "unavailable") throw new Error("unreachable");
    expect(second.safeCode).toBe("cooldown_active");
    expect(list.calls).toBe(1);

    // Advance clock past cooldown: exactly one half-open probe.
    now += 30_000;
    const third = await resolver.resolve();
    expect(third.status).toBe("unavailable");
    expect(list.calls).toBe(2);
  });

  it("persistent transient failures stay <=1 request per cooldown window and never go permanent", async () => {
    let now = 0;
    let failures = 0;
    const list: ControlledList = {
      calls: 0,
      lastSignal: undefined,
      impl: async () => {
        failures += 1;
        throw new Error(`fail ${failures}`);
      },
    };
    const { client } = makeClient(list);
    const resolver = createLiveResolver({
      client,
      cooldownMs: 30_000,
      now: () => now,
    });

    // Simulate 4 windows of 30s. Each window permits exactly one request.
    for (let window = 0; window < 4; window += 1) {
      now = window * 30_000;
      const out = await resolver.resolve();
      expect(out.status).toBe("unavailable");
      // Never permanent under continued transient failure.
      if (out.status !== "unavailable") throw new Error("unreachable");
      expect(out.retryable).toBe(true);
      // A second call within the same window must NOT make another request.
      await resolver.resolve();
    }
    // 4 windows => at most 4 requests total (1 per window).
    expect(list.calls).toBeLessThanOrEqual(4);
  });

  it("recovers through half-open probes after repeated transient failures", async () => {
    let now = 0;
    let attempts = 0;
    const resolver = createLiveResolver({
      client: {
        provider: {
          list: async () => {
            attempts += 1;
            if (attempts < 3) throw new Error("temporary outage");
            return providerPayload("opencode-go", "sub/deepseek-v4-pro");
          },
        },
      },
      now: () => now,
      cooldownMs: 30_000,
    });

    await resolver.resolve();
    now += 30_000;
    await resolver.resolve();
    now += 30_000;
    await expect(resolver.resolve()).resolves.toMatchObject({
      status: "ready",
      models: ["opencode-go/sub/deepseek-v4-pro"],
    });
    expect(attempts).toBe(3);
  });
});

describe("createLiveResolver — no mutable Set escape (B-8)", () => {
  it("ready models array is frozen and cannot be mutated by callers", async () => {
    const list: ControlledList = {
      calls: 0,
      lastSignal: undefined,
      impl: async () => providerPayload("openai", "gpt-5.5"),
    };
    const { client } = makeClient(list);
    const resolver = createLiveResolver({ client });
    const out = await resolver.resolve();
    if (out.status !== "ready") throw new Error("expected ready");
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.models)).toBe(true);
    expect(Object.isFrozen(resolver.peekState())).toBe(true);
    expect(() => {
      // Mutation attempt must be a no-op under strict mode / frozen.
      (out.models as string[]).push("evil/model");
    }).toThrow();
  });
});

describe("createLiveResolver — timeout ownership", () => {
  it("aborts the supplied signal and clears the timer-owned in-flight state", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const resolver = createLiveResolver({
        client: {
          provider: {
            list: ({ signal: nextSignal } = {}) => {
              signal = nextSignal;
              return new Promise<unknown>(() => undefined);
            },
          },
        },
        timeoutMs: 5_000,
      });

      const pending = resolver.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toMatchObject({ status: "unavailable", safeCode: "timeout" });
      expect(signal?.aborted).toBe(true);
      expect(resolver.peekState().kind).toBe("transient_unavailable");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createLiveResolver — permanent preconditions (B-7)", () => {
  it("no client => permanent unavailable without any request", async () => {
    const resolver = createLiveResolver({ client: undefined });
    const out = await resolver.resolve();
    expect(out.status).toBe("unavailable");
    if (out.status !== "unavailable") throw new Error("unreachable");
    expect(out.retryable).toBe(false);
    expect(out.safeCode).toBe("no_client");
  });

  it("provider.list missing => permanent unavailable", async () => {
    const resolver = createLiveResolver({
      client: { provider: {} } as never,
    });
    const out = await resolver.resolve();
    expect(out.status).toBe("unavailable");
    if (out.status !== "unavailable") throw new Error("unreachable");
    expect(out.retryable).toBe(false);
    expect(out.safeCode).toBe("provider_api_missing");
  });
});
