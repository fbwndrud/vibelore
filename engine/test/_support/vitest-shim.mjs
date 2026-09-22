/**
 * vitest-shim — node:test + node:assert based vitest compatibility layer.
 *
 * `@vibelore/novel-engine` runs its suite on the Node 22 built-in test runner
 * (`node --test`) with zero external deps. The ported specs were written for
 * vitest, so this shim re-exports node:test's structure primitives and supplies
 * `expect` / `vi` with the exact matcher surface the suite uses.
 *
 * Matchers (grep-verified): toBe, toEqual, toContain, toContainEqual,
 * toHaveLength, toBeGreaterThan(OrEqual), toBeLessThan(OrEqual), toMatch,
 * toBeNull, toBeDefined, toBeUndefined, toBeNaN, toBeTruthy, toBeFalsy,
 * toBeInstanceOf, toBeCloseTo, toMatchObject, toHaveProperty, toThrow(Error),
 * toHaveBeenCalled(Times|With) — all with a `.not` chain, plus async
 * `.rejects` / `.resolves`. Asymmetric: expect.arrayContaining (+ any/
 * objectContaining/stringContaining/stringMatching). Assertion counting:
 * expect.assertions(n) / expect.hasAssertions().
 *
 * toEqual mirrors vitest (recursive, ignores `undefined`-valued properties),
 * not raw deepStrictEqual.
 */

import {
  describe as nodeDescribe,
  it as nodeIt,
  test as nodeTest,
  beforeEach,
  afterEach,
} from 'node:test';

// ─── per-test assertion accounting (expect.assertions) ──────────────────────
// node:test runs tests within a file sequentially, so a single module-level
// pointer is safe. Set on entry to each wrapped test, restored on exit.
let currentAssertionState = null;

function bumpAssertion() {
  if (currentAssertionState) currentAssertionState.count += 1;
}

// ─── deep helpers ───────────────────────────────────────────────────────────

function isAsymmetric(v) {
  return v != null && typeof v === 'object' && typeof v.asymmetricMatch === 'function';
}

function isPlainish(v) {
  return v != null && typeof v === 'object';
}

/** vitest-style recursive equality: ignores undefined-valued props; NaN===NaN. */
function equals(a, b) {
  if (isAsymmetric(b)) return b.asymmetricMatch(a);
  if (isAsymmetric(a)) return a.asymmetricMatch(b);
  if (Object.is(a, b)) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (aArr !== bArr || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equals(a[i], b[i])) return false;
    }
    return true;
  }

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !equals(v, b.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    for (const v of a) {
      if (!b.has(v)) return false;
    }
    return true;
  }

  // Plain objects — union of keys, undefined-valued keys treated as absent.
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    if (av === undefined && bv === undefined) continue;
    if (!equals(av, bv)) return false;
  }
  return true;
}

/** Partial deep match for toMatchObject: index-wise for arrays, key-subset for objects. */
function matchObject(actual, expected) {
  if (isAsymmetric(expected)) return expected.asymmetricMatch(actual);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((e, i) => matchObject(actual[i], e));
  }
  if (isPlainish(expected)) {
    if (!isPlainish(actual)) return false;
    return Object.keys(expected).every((k) => matchObject(actual[k], expected[k]));
  }
  return equals(actual, expected);
}

function fmt(v) {
  try {
    if (typeof v === 'function') return v.name ? `[Function ${v.name}]` : '[Function]';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'bigint') return `${v}n`;
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function assertPass(pass, negated, message) {
  bumpAssertion();
  if (negated ? pass : !pass) {
    throw new Error(negated ? `[not] ${message}` : message);
  }
}

function checkThrow(threw, error, arg, negated) {
  bumpAssertion();
  let pass = threw;
  if (threw && arg !== undefined && arg !== null) {
    const msg = error && error.message !== undefined ? String(error.message) : String(error);
    if (typeof arg === 'string') pass = msg.includes(arg);
    else if (arg instanceof RegExp) pass = arg.test(msg);
    else if (typeof arg === 'function') pass = error instanceof arg;
  }
  const label =
    arg === undefined || arg === null
      ? 'throw'
      : `throw matching ${arg instanceof RegExp ? arg : fmt(arg)}`;
  const got = threw ? `threw ${error && error.message !== undefined ? fmt(error.message) : fmt(error)}` : 'did not throw';
  if (negated ? pass : !pass) {
    throw new Error(`${negated ? '[not] ' : ''}expected function to ${label} (${got})`);
  }
}

function mockCallsOf(actual) {
  if (actual && actual.mock && Array.isArray(actual.mock.calls)) return actual.mock.calls;
  return [];
}

// ─── sync matcher set (shared by direct + `.not`) ───────────────────────────

function makeMatchers(actual, negated) {
  return {
    toBe(expected) {
      assertPass(Object.is(actual, expected), negated, `expected ${fmt(actual)} to be ${fmt(expected)}`);
    },
    toEqual(expected) {
      assertPass(equals(actual, expected), negated, `expected ${fmt(actual)} to equal ${fmt(expected)}`);
    },
    toStrictEqual(expected) {
      assertPass(equals(actual, expected), negated, `expected ${fmt(actual)} to strictly equal ${fmt(expected)}`);
    },
    toContain(expected) {
      let pass;
      if (typeof actual === 'string') pass = actual.includes(expected);
      else if (Array.isArray(actual)) {
        pass = actual.includes(expected) || (isPlainish(expected) && actual.some((x) => equals(x, expected)));
      } else if (actual instanceof Set) pass = actual.has(expected);
      else pass = false;
      assertPass(pass, negated, `expected ${fmt(actual)} to contain ${fmt(expected)}`);
    },
    toContainEqual(expected) {
      const pass = Array.isArray(actual) && actual.some((x) => equals(x, expected));
      assertPass(pass, negated, `expected ${fmt(actual)} to contain equal ${fmt(expected)}`);
    },
    toHaveLength(n) {
      assertPass(actual != null && actual.length === n, negated, `expected length ${actual == null ? 'n/a' : actual.length} to be ${n}`);
    },
    toBeGreaterThan(n) {
      assertPass(actual > n, negated, `expected ${fmt(actual)} > ${fmt(n)}`);
    },
    toBeGreaterThanOrEqual(n) {
      assertPass(actual >= n, negated, `expected ${fmt(actual)} >= ${fmt(n)}`);
    },
    toBeLessThan(n) {
      assertPass(actual < n, negated, `expected ${fmt(actual)} < ${fmt(n)}`);
    },
    toBeLessThanOrEqual(n) {
      assertPass(actual <= n, negated, `expected ${fmt(actual)} <= ${fmt(n)}`);
    },
    toMatch(expected) {
      const s = String(actual);
      const pass = expected instanceof RegExp ? expected.test(s) : s.includes(expected);
      assertPass(pass, negated, `expected ${fmt(actual)} to match ${expected instanceof RegExp ? expected : fmt(expected)}`);
    },
    toBeNull() {
      assertPass(actual === null, negated, `expected ${fmt(actual)} to be null`);
    },
    toBeDefined() {
      assertPass(actual !== undefined, negated, `expected ${fmt(actual)} to be defined`);
    },
    toBeUndefined() {
      assertPass(actual === undefined, negated, `expected ${fmt(actual)} to be undefined`);
    },
    toBeNaN() {
      assertPass(Number.isNaN(actual), negated, `expected ${fmt(actual)} to be NaN`);
    },
    toBeTruthy() {
      assertPass(Boolean(actual), negated, `expected ${fmt(actual)} to be truthy`);
    },
    toBeFalsy() {
      assertPass(!actual, negated, `expected ${fmt(actual)} to be falsy`);
    },
    toBeInstanceOf(cls) {
      assertPass(actual instanceof cls, negated, `expected ${fmt(actual)} to be instance of ${cls && cls.name ? cls.name : fmt(cls)}`);
    },
    toBeCloseTo(n, digits = 2) {
      const pass = Math.abs(actual - n) < Math.pow(10, -digits) / 2;
      assertPass(pass, negated, `expected ${fmt(actual)} to be close to ${fmt(n)}`);
    },
    toMatchObject(expected) {
      assertPass(matchObject(actual, expected), negated, `expected ${fmt(actual)} to match object ${fmt(expected)}`);
    },
    toHaveProperty(path, ...rest) {
      const keys = Array.isArray(path) ? path : String(path).split('.');
      let cur = actual;
      let exists = true;
      for (const k of keys) {
        if (cur != null && (typeof cur === 'object' || typeof cur === 'function') && k in cur) {
          cur = cur[k];
        } else {
          exists = false;
          break;
        }
      }
      const pass = rest.length ? exists && equals(cur, rest[0]) : exists;
      assertPass(pass, negated, `expected property ${keys.join('.')}${rest.length ? ` = ${fmt(rest[0])}` : ''}`);
    },
    toThrow(arg) {
      let threw = false;
      let error;
      if (typeof actual === 'function') {
        try {
          actual();
        } catch (e) {
          threw = true;
          error = e;
        }
      }
      checkThrow(threw, error, arg, negated);
    },
    toThrowError(arg) {
      this.toThrow(arg);
    },
    toHaveBeenCalled() {
      assertPass(mockCallsOf(actual).length > 0, negated, 'expected mock to have been called');
    },
    toHaveBeenCalledTimes(n) {
      const c = mockCallsOf(actual).length;
      assertPass(c === n, negated, `expected mock to have been called ${n} time(s), got ${c}`);
    },
    toHaveBeenCalledWith(...args) {
      const pass = mockCallsOf(actual).some((call) => equals(call, args));
      assertPass(pass, negated, `expected mock to have been called with ${fmt(args)}`);
    },
  };
}

// ─── async matcher set (`.rejects` / `.resolves`) ───────────────────────────

function makeAsyncMatchers(actual, mode, negated) {
  const settle = async () => {
    try {
      const value = await actual;
      return { resolved: true, value };
    } catch (error) {
      return { rejected: true, error };
    }
  };

  // apply(settled) -> void|throw
  const wrap = (applyToValue, applyToError) => async () => {
    const s = await settle();
    if (mode === 'rejects') {
      if (!s.rejected) {
        bumpAssertion();
        throw new Error('expected promise to reject, but it resolved');
      }
      return applyToError(s.error);
    }
    if (!s.resolved) {
      bumpAssertion();
      throw new Error('expected promise to resolve, but it rejected');
    }
    return applyToValue(s.value);
  };

  const set = {
    toThrow: (arg) =>
      wrap(
        () => {
          bumpAssertion();
          throw new Error('resolves.toThrow is not meaningful');
        },
        (err) => checkThrow(true, err, arg, negated),
      )(),
    toBeInstanceOf: (cls) =>
      wrap(
        (val) => assertPass(val instanceof cls, negated, `expected resolved value instance of ${cls && cls.name}`),
        (err) => assertPass(err instanceof cls, negated, `expected rejection instance of ${cls && cls.name}`),
      )(),
    toBe: (expected) =>
      wrap(
        (val) => assertPass(Object.is(val, expected), negated, `expected resolved ${fmt(val)} to be ${fmt(expected)}`),
        (err) => assertPass(Object.is(err, expected), negated, `expected rejection ${fmt(err)} to be ${fmt(expected)}`),
      )(),
    toEqual: (expected) =>
      wrap(
        (val) => assertPass(equals(val, expected), negated, `expected resolved ${fmt(val)} to equal ${fmt(expected)}`),
        (err) => assertPass(equals(err, expected), negated, `expected rejection ${fmt(err)} to equal ${fmt(expected)}`),
      )(),
    toBeDefined: () =>
      wrap(
        (val) => assertPass(val !== undefined, negated, 'expected resolved value to be defined'),
        (err) => assertPass(err !== undefined, negated, 'expected rejection to be defined'),
      )(),
  };
  return set;
}

// ─── expect ─────────────────────────────────────────────────────────────────

export function expect(actual) {
  const base = makeMatchers(actual, false);
  base.not = makeMatchers(actual, true);
  base.rejects = makeAsyncMatchers(actual, 'rejects', false);
  base.resolves = makeAsyncMatchers(actual, 'resolves', false);
  return base;
}

// Assertion accounting.
expect.assertions = (n) => {
  if (currentAssertionState) currentAssertionState.expected = n;
};
expect.hasAssertions = () => {
  if (currentAssertionState) currentAssertionState.expected = 'atLeastOne';
};

// Asymmetric matchers.
expect.arrayContaining = (expected) => ({
  asymmetricMatch(received) {
    return Array.isArray(received) && expected.every((e) => received.some((r) => equals(r, e)));
  },
});
expect.objectContaining = (expected) => ({
  asymmetricMatch(received) {
    return isPlainish(received) && Object.keys(expected).every((k) => equals(received[k], expected[k]));
  },
});
expect.stringContaining = (expected) => ({
  asymmetricMatch(received) {
    return typeof received === 'string' && received.includes(expected);
  },
});
expect.stringMatching = (expected) => ({
  asymmetricMatch(received) {
    if (typeof received !== 'string') return false;
    return expected instanceof RegExp ? expected.test(received) : received.includes(expected);
  },
});
expect.any = (ctor) => ({
  asymmetricMatch(received) {
    if (received == null) return false;
    if (ctor === String) return typeof received === 'string' || received instanceof String;
    if (ctor === Number) return typeof received === 'number' || received instanceof Number;
    if (ctor === Boolean) return typeof received === 'boolean';
    if (ctor === BigInt) return typeof received === 'bigint';
    if (ctor === Function) return typeof received === 'function';
    if (ctor === Object) return typeof received === 'object';
    return received instanceof ctor;
  },
});

// ─── vi (mock functions) ────────────────────────────────────────────────────

function fn(impl) {
  const mockFn = (...args) => {
    mockFn.mock.calls.push(args);
    let value;
    let threw = false;
    let thrown;
    if (mockFn._impl) {
      try {
        value = mockFn._impl(...args);
      } catch (e) {
        threw = true;
        thrown = e;
      }
    }
    mockFn.mock.results.push(
      threw ? { type: 'throw', value: thrown } : { type: 'return', value },
    );
    if (threw) throw thrown;
    return value;
  };
  mockFn.mock = { calls: [], results: [] };
  mockFn._impl = typeof impl === 'function' ? impl : undefined;
  mockFn.mockImplementation = (newImpl) => {
    mockFn._impl = newImpl;
    return mockFn;
  };
  mockFn.mockImplementationOnce = (newImpl) => {
    const prev = mockFn._impl;
    mockFn._impl = (...a) => {
      mockFn._impl = prev;
      return newImpl(...a);
    };
    return mockFn;
  };
  mockFn.mockReturnValue = (v) => mockFn.mockImplementation(() => v);
  mockFn.mockResolvedValue = (v) => mockFn.mockImplementation(() => Promise.resolve(v));
  mockFn.mockRejectedValue = (v) => mockFn.mockImplementation(() => Promise.reject(v));
  mockFn.mockClear = () => {
    mockFn.mock.calls = [];
    mockFn.mock.results = [];
    return mockFn;
  };
  mockFn.mockReset = () => {
    mockFn.mockClear();
    mockFn._impl = undefined;
    return mockFn;
  };
  return mockFn;
}

export const vi = {
  fn,
};

// ─── test structure (wrapped so expect.assertions can be verified) ──────────

function wrapTest(nodeFn) {
  const wrapped = (name, fn2, opts) => {
    if (typeof fn2 !== 'function') {
      return opts !== undefined ? nodeFn(name, fn2, opts) : nodeFn(name, fn2);
    }
    const runner = async (...targs) => {
      const prev = currentAssertionState;
      const state = { count: 0, expected: null };
      currentAssertionState = state;
      try {
        const result = await fn2(...targs);
        if (state.expected === 'atLeastOne') {
          if (state.count < 1) throw new Error('expected at least one assertion, but none were called');
        } else if (state.expected !== null && state.count !== state.expected) {
          throw new Error(`expected ${state.expected} assertion(s), but ${state.count} were called`);
        }
        return result;
      } finally {
        currentAssertionState = prev;
      }
    };
    return opts !== undefined ? nodeFn(name, opts, runner) : nodeFn(name, runner);
  };
  return wrapped;
}

export const it = wrapTest(nodeIt);
export const test = wrapTest(nodeTest);
export const describe = nodeDescribe;
export { beforeEach, afterEach };
