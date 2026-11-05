import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';

// Recent versions of Node define a localStorage global that shadows jsdom's and can't store anything.
const values = new Map<string, string>();
const storage: Storage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => void values.delete(key),
  setItem: (key, value) => void values.set(key, String(value)),
};
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });

beforeEach(() => storage.clear());
