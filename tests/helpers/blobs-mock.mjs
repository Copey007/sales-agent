// In-memory stand-in for @netlify/blobs used only by the test suite.
const stores = globalThis.__stores ||= new Map();
export function getStore(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name);
  return {
    get: async k => m.get(k) ?? null,
    set: async (k, v) => { m.set(k, v); },
    setJSON: async (k, v) => { m.set(k, v); },
    getJSON: async k => m.get(k) ?? null,
    delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ blobs: [...m.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) })
  };
}
