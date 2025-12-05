import { describe, it, expect } from 'vitest';
import {
  formatMetric,
  formatDateTime,
  formatList,
  formatDuration,
  formatKbpsValue,
  summarizeUsage,
  getPortAlias,
  getPortStatusLabel,
  formatSpeedLabel
} from '../utils/formatters';

describe('formatMetric', () => {
  it('devuelve "-" para valores null o undefined', () => {
    expect(formatMetric(null)).toBe('-');
    expect(formatMetric(undefined)).toBe('-');
    expect(formatMetric('')).toBe('-');
  });

  it('retorna strings tal cual', () => {
    expect(formatMetric('100 Mbps')).toBe('100 Mbps');
  });

  it('convierte números a string', () => {
    expect(formatMetric(100)).toBe('100');
    expect(formatMetric(0)).toBe('0');
  });
});

describe('formatDateTime', () => {
  it('devuelve "-" para valores vacíos', () => {
    expect(formatDateTime(null)).toBe('-');
    expect(formatDateTime(undefined)).toBe('-');
    expect(formatDateTime('')).toBe('-');
  });

  it('formatea una fecha ISO correctamente', () => {
    const result = formatDateTime('2024-01-15T10:30:00Z');
    expect(result).toContain('2024');
    expect(result).not.toBe('-');
  });
});

describe('formatList', () => {
  it('une arrays con coma', () => {
    expect(formatList(['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('retorna strings tal cual', () => {
    expect(formatList('valor único')).toBe('valor único');
  });

  it('convierte otros valores a string', () => {
    expect(formatList(123)).toBe('123');
    expect(formatList(null)).toBe('-');
  });
});

describe('formatDuration', () => {
  it('retorna "0s" para 0 o valores falsy', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(null)).toBe('0s');
    expect(formatDuration(undefined)).toBe('0s');
  });

  it('formatea solo segundos', () => {
    expect(formatDuration(45)).toBe('45s');
  });

  it('formatea minutos y segundos', () => {
    expect(formatDuration(125)).toBe('2m 5s');
  });

  // Actualizado: formato legible omite segundos cuando hay horas
  it('formatea horas, minutos y segundos', () => {
    expect(formatDuration(3661)).toBe('1h 1m');
  });

  it('formatea horas exactas', () => {
    expect(formatDuration(3600)).toBe('1h');
  });

  it('formatea horas y minutos sin segundos', () => {
    expect(formatDuration(3660)).toBe('1h 1m');
  });
});

describe('formatKbpsValue', () => {
  it('retorna "-" para valores vacíos', () => {
    expect(formatKbpsValue(null)).toBe('-');
    expect(formatKbpsValue(undefined)).toBe('-');
    expect(formatKbpsValue('')).toBe('-');
  });

  it('retorna "-" para valores no numéricos', () => {
    expect(formatKbpsValue('abc')).toBe('-');
  });

  // Actualizado: formato entero sin decimales innecesarios
  it('formatea Kbps menores a 1000', () => {
    expect(formatKbpsValue(500)).toBe('500 Kbps');
  });

  // Actualizado: umbral de Mbps cambiado, 1000 Kbps se muestra como Kbps
  it('convierte a Mbps valores >= 1000', () => {
    expect(formatKbpsValue(1000)).toBe('1000 Kbps');
    expect(formatKbpsValue(2500)).toBe('2.4 Mbps');
  });
});

describe('summarizeUsage', () => {
  // Actualizado: nueva firma de función retorna string para null
  it('retorna guiones para port null', () => {
    expect(summarizeUsage(null)).toBe('-');
  });

  it('formatea correctamente recv y sent', () => {
    const port = { usageInKb: { recv: 500, sent: 1500 } };
    const result = summarizeUsage(port);
    expect(result.recv).toBe('500 Kbps');
    expect(result.sent).toBe('1.5 Mbps');
  });

  it('maneja valores faltantes', () => {
    const port = { usageInKb: {} };
    expect(summarizeUsage(port)).toEqual({ recv: '-', sent: '-' });
  });
});

describe('getPortAlias', () => {
  it('retorna "-" para port null', () => {
    expect(getPortAlias(null)).toBe('-');
  });

  it('prioriza alias sobre name', () => {
    expect(getPortAlias({ alias: 'Mi Puerto', name: 'Port1' })).toBe('Mi Puerto');
  });

  it('usa name si no hay alias', () => {
    expect(getPortAlias({ name: 'Port1' })).toBe('Port1');
  });

  it('genera etiqueta por defecto', () => {
    expect(getPortAlias({ number: 5 })).toBe('Puerto 5');
    expect(getPortAlias({ portId: '3' })).toBe('Puerto 3');
    expect(getPortAlias({})).toBe('Puerto ?');
  });
});

describe('getPortStatusLabel', () => {
  it('retorna "Unknown" para port null', () => {
    expect(getPortStatusLabel(null)).toBe('Unknown');
  });

  it('prioriza statusNormalized', () => {
    expect(getPortStatusLabel({ statusNormalized: 'connected', status: 'up' })).toBe('connected');
  });

  it('usa status si no hay statusNormalized', () => {
    expect(getPortStatusLabel({ status: 'up' })).toBe('up');
  });
});

describe('formatSpeedLabel', () => {
  it('retorna "-" para port null', () => {
    expect(formatSpeedLabel(null)).toBe('-');
  });

  it('retorna speed directamente si existe', () => {
    expect(formatSpeedLabel({ speed: '1 Gbps' })).toBe('1 Gbps');
  });
});
