import { vi, beforeEach } from 'vitest';

function createChromeMock() {
  const alarms = new Map();
  const storageData = { timers: {} };
  const tabs = new Map();
  const listeners = {
    alarm: [],
    tabRemoved: [],
    runtimeStartup: [],
    messageExternal: []
  };

  return {
    _state: { alarms, storageData, tabs, listeners },
    alarms: {
      create: vi.fn((name, opts) => { alarms.set(name, opts); }),
      clear: vi.fn(async (name) => alarms.delete(name)),
      getAll: vi.fn(async () => Array.from(alarms.entries()).map(([name, o]) => ({ name, ...o }))),
      onAlarm: { addListener: vi.fn((cb) => listeners.alarm.push(cb)) }
    },
    storage: {
      session: {
        get: vi.fn(async (key) => {
          if (key == null) return { ...storageData };
          if (typeof key === 'string') return { [key]: storageData[key] };
          const out = {};
          for (const k of key) out[k] = storageData[k];
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(storageData, obj); }),
        remove: vi.fn(async (key) => { delete storageData[key]; })
      }
    },
    tabs: {
      remove: vi.fn(async (id) => { tabs.delete(id); }),
      get: vi.fn(async (id) => tabs.get(id)),
      query: vi.fn(async () => Array.from(tabs.values())),
      onRemoved: { addListener: vi.fn((cb) => listeners.tabRemoved.push(cb)) }
    },
    power: {
      requestKeepAwake: vi.fn(),
      releaseKeepAwake: vi.fn()
    },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {})
    },
    runtime: {
      onStartup: { addListener: vi.fn((cb) => listeners.runtimeStartup.push(cb)) },
      onMessage: { addListener: vi.fn((cb) => listeners.messageExternal.push(cb)) },
      onConnect: { addListener: vi.fn() },
      sendMessage: vi.fn(),
      connect: vi.fn(() => ({ disconnect: vi.fn(), onDisconnect: { addListener: vi.fn() } }))
    }
  };
}

beforeEach(() => {
  globalThis.chrome = createChromeMock();
});
