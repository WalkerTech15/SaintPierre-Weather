import { describe, it, expect, vi } from "vitest";
import { createAsyncCache, createBoundedCache } from "./cache.js";

describe("createAsyncCache", () => {
  it("dedupes concurrent calls for the same key", () => {
    const cache = createAsyncCache(60000);
    let calls = 0;
    const factory = () => {
      calls++;
      return Promise.resolve("value");
    };
    const p1 = cache.get("a", factory);
    const p2 = cache.get("a", factory);
    expect(p1).toBe(p2); // same in-flight promise, factory only called once
    expect(calls).toBe(1);
  });

  it("calls the factory again for a different key", () => {
    const cache = createAsyncCache(60000);
    let calls = 0;
    const factory = () => {
      calls++;
      return Promise.resolve("value");
    };
    cache.get("a", factory);
    cache.get("b", factory);
    expect(calls).toBe(2);
  });

  it("refetches once the TTL after success has expired", async () => {
    vi.useFakeTimers();
    try {
      const cache = createAsyncCache(1000);
      let calls = 0;
      const factory = () => {
        calls++;
        return Promise.resolve("value");
      };
      cache.get("a", factory);
      expect(calls).toBe(1);
      await Promise.resolve(); // let the first request settle and start its TTL
      vi.advanceTimersByTime(1500);
      cache.get("a", factory);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a slow in-flight request deduplicated past the TTL and starts expiry after success", async () => {
    vi.useFakeTimers();
    try {
      const cache = createAsyncCache(1000);
      let resolveFirst;
      let calls = 0;
      const first = new Promise((resolve) => {
        resolveFirst = resolve;
      });
      const p1 = cache.get("a", () => {
        calls++;
        return first;
      });

      vi.advanceTimersByTime(1500);
      expect(cache.get("a", () => Promise.resolve("duplicate"))).toBe(p1);
      expect(calls).toBe(1);

      resolveFirst("value");
      await expect(p1).resolves.toBe("value");
      await Promise.resolve(); // allow the cache's fulfillment handler to record its TTL start
      expect(cache.get("a", () => Promise.resolve("early"))).toBe(p1);

      vi.advanceTimersByTime(1001);
      cache.get("a", () => {
        calls++;
        return Promise.resolve("refreshed");
      });
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a cleared request's rejection evict its replacement", async () => {
    const cache = createAsyncCache(60000);
    let rejectFirst;
    const first = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
    const p1 = cache.get("a", () => first);
    cache.clear();
    const p2 = cache.get("a", () => Promise.resolve("new"));

    rejectFirst(new Error("old request failed"));
    await expect(p1).rejects.toThrow("old request failed");
    await Promise.resolve();
    expect(cache.get("a", () => Promise.resolve("unexpected"))).toBe(p2);
  });

  it("evicts a rejected entry so the next call retries", async () => {
    const cache = createAsyncCache(60000);
    let calls = 0;
    const factory = () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("ok");
    };
    await expect(cache.get("a", factory)).rejects.toThrow("boom");
    // give the .catch() eviction microtask a turn
    await Promise.resolve();
    await expect(cache.get("a", factory)).resolves.toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("createBoundedCache", () => {
  it("stores and retrieves values", () => {
    const cache = createBoundedCache(3);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("missing")).toBe(false);
  });

  it("evicts the oldest entry once the size limit is exceeded", () => {
    const cache = createBoundedCache(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // pushes "a" out
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });
});
