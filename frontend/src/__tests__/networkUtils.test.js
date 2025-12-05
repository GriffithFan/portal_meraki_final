import { describe, it, expect } from 'vitest';
import {
  normalizeReachability,
  getStatusColor,
  resolvePortColor,
  looksLikeSerial,
  looksLikeMAC,
  normalizeMAC
} from '../utils/networkUtils';

describe('normalizeReachability', () => {
  it('retorna fallback para valores vacíos', () => {
    expect(normalizeReachability(null)).toBe('unknown');
    expect(normalizeReachability(undefined)).toBe('unknown');
    expect(normalizeReachability('')).toBe('unknown');
  });

  it('reconoce estados desconectados', () => {
    expect(normalizeReachability('disconnected')).toBe('disconnected');
    expect(normalizeReachability('offline')).toBe('disconnected');
    expect(normalizeReachability('down')).toBe('disconnected');
    expect(normalizeReachability('Not Connected')).toBe('disconnected');
    expect(normalizeReachability('unplugged')).toBe('disconnected');
  });

  it('reconoce estados de advertencia', () => {
    expect(normalizeReachability('alerting')).toBe('warning');
    expect(normalizeReachability('warning')).toBe('warning');
    expect(normalizeReachability('degraded')).toBe('warning');
    expect(normalizeReachability('unstable')).toBe('warning');
  });

  it('reconoce estados conectados', () => {
    expect(normalizeReachability('connected')).toBe('connected');
    expect(normalizeReachability('online')).toBe('connected');
    expect(normalizeReachability('up')).toBe('connected');
    expect(normalizeReachability('active')).toBe('connected');
  });

  it('reconoce estado disabled', () => {
    expect(normalizeReachability('disabled')).toBe('disabled');
  });

  it('usa fallback personalizado', () => {
    expect(normalizeReachability(null, 'otro')).toBe('otro');
  });
});

describe('getStatusColor', () => {
  it('retorna verde para connected', () => {
    expect(getStatusColor('connected')).toBe('#22c55e');
    expect(getStatusColor('online')).toBe('#22c55e');
  });

  it('retorna amarillo para warning', () => {
    expect(getStatusColor('alerting')).toBe('#f59e0b');
    expect(getStatusColor('warning')).toBe('#f59e0b');
  });

  it('retorna rojo para disconnected', () => {
    expect(getStatusColor('disconnected')).toBe('#ef4444');
    expect(getStatusColor('offline')).toBe('#ef4444');
  });

  it('retorna gris para disabled', () => {
    expect(getStatusColor('disabled')).toBe('#94a3b8');
  });

  it('retorna color por defecto para estados desconocidos', () => {
    expect(getStatusColor('otro')).toBe('#6366f1');
  });
});

describe('resolvePortColor', () => {
  it('retorna gris si port está deshabilitado', () => {
    expect(resolvePortColor({ enabled: false })).toBe('#94a3b8');
  });

  it('retorna verde para puertos conectados', () => {
    expect(resolvePortColor({ statusNormalized: 'connected' })).toBe('#047857');
    expect(resolvePortColor({ status: 'online' })).toBe('#047857');
  });

  it('retorna amarillo para warning', () => {
    expect(resolvePortColor({ status: 'alerting' })).toBe('#f59e0b');
  });

  it('retorna rojo para disconnected', () => {
    expect(resolvePortColor({ status: 'offline' })).toBe('#ef4444');
  });
});

describe('looksLikeSerial', () => {
  it('retorna false para valores vacíos', () => {
    expect(looksLikeSerial(null)).toBe(false);
    expect(looksLikeSerial('')).toBe(false);
    expect(looksLikeSerial(undefined)).toBe(false);
  });

  it('reconoce formatos de número de serie', () => {
    expect(looksLikeSerial('Q2PN-XXXX-YYYY')).toBe(true);
    expect(looksLikeSerial('ABC-123-DEF')).toBe(true);
  });

  it('reconoce seriales compactos', () => {
    expect(looksLikeSerial('Q2PNXXXXXXYYYY')).toBe(true);
  });

  it('rechaza strings cortos', () => {
    expect(looksLikeSerial('ABC')).toBe(false);
  });
});

describe('looksLikeMAC', () => {
  it('retorna false para valores vacíos', () => {
    expect(looksLikeMAC(null)).toBe(false);
    expect(looksLikeMAC('')).toBe(false);
  });

  it('reconoce MAC con dos puntos', () => {
    expect(looksLikeMAC('e4:55:a8:55:f2:6d')).toBe(true);
    expect(looksLikeMAC('E4:55:A8:55:F2:6D')).toBe(true);
  });

  it('reconoce MAC con guiones', () => {
    expect(looksLikeMAC('e4-55-a8-55-f2-6d')).toBe(true);
  });

  it('reconoce formato Cisco', () => {
    expect(looksLikeMAC('e455.a855.f26d')).toBe(true);
  });

  it('reconoce MAC sin separadores', () => {
    expect(looksLikeMAC('e455a855f26d')).toBe(true);
  });

  it('rechaza formatos inválidos', () => {
    expect(looksLikeMAC('not-a-mac')).toBe(false);
    expect(looksLikeMAC('12345')).toBe(false);
  });
});

describe('normalizeMAC', () => {
  it('retorna string vacío para valores null', () => {
    expect(normalizeMAC(null)).toBe('');
    expect(normalizeMAC(undefined)).toBe('');
  });

  it('elimina separadores y normaliza a minúsculas', () => {
    expect(normalizeMAC('E4:55:A8:55:F2:6D')).toBe('e455a855f26d');
    expect(normalizeMAC('e4-55-a8-55-f2-6d')).toBe('e455a855f26d');
    expect(normalizeMAC('e455.a855.f26d')).toBe('e455a855f26d');
  });
});
