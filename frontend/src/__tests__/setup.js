import { expect, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

// Extender expect con matchers de jest-dom
expect.extend(matchers);

// Limpiar después de cada test
afterEach(() => {
  cleanup();
});

// Mock de localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};
global.localStorage = localStorageMock;

// Mock de fetch
global.fetch = vi.fn();

// Mock de console para evitar ruido en tests
console.error = vi.fn();
console.warn = vi.fn();
