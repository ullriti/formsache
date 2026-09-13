import { describe, expect, it } from 'vitest';

import { parseHealthResponse } from './health.ts';

describe('parseHealthResponse', () => {
  it('accepts a well-formed health payload', () => {
    expect(
      parseHealthResponse({
        status: 'ok',
        version: '1.2.3',
        uptimeSeconds: 12.5,
      }),
    ).toStrictEqual({ status: 'ok', version: '1.2.3', uptimeSeconds: 12.5 });
  });

  it('rejects an unknown status', () => {
    expect(() =>
      parseHealthResponse({
        status: 'burning',
        version: '1.2.3',
        uptimeSeconds: 1,
      }),
    ).toThrow();
  });

  it('rejects a missing version instead of defaulting it', () => {
    expect(() =>
      parseHealthResponse({ status: 'ok', uptimeSeconds: 1 }),
    ).toThrow();
  });

  it('rejects a negative uptime', () => {
    expect(() =>
      parseHealthResponse({
        status: 'ok',
        version: '1.2.3',
        uptimeSeconds: -1,
      }),
    ).toThrow();
  });
});
