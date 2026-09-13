import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TENANT_BRANDING,
  TENANT_LOGO_REFS,
  tenantLogoSchema,
  uploadedLogoRef,
  deliverableBranding,
  isBrandColor,
  isTenantLogoRef,
  tenantBrandingWriteSchema,
  type StoredTenantBranding,
} from './branding.ts';

/**
 * **One test block per gate.**
 *
 * Both gates ask the same predicate, which is what makes a document that
 * passes one and fails the other impossible. It is also what makes a
 * save-then-read integration test blind to gate 2: remove gate 2 alone and that
 * test stays green, because gate 1 already refused everything gate 2 would
 * have caught. So each gate is tested here on its own, and gate 2's tests
 * establish the precondition only gate 2 can meet — a stored row that gate 1
 * **never saw**, built by hand exactly as a hand-written `UPDATE`, an older
 * version or a restore would leave it.
 *
 * *Reproductions, run while writing this file:*
 * - Widening {@link isBrandColor} back to `#rgb`/`#rrggbbaa` → the alphabet
 *   tests below go red.
 * - Removing the `logoRef` allow-list from {@link deliverableBranding} → the
 *   two database probes (`javascript:` and `https://fremd.example`) go red and
 *   nothing else.
 * - Removing the colour check from {@link deliverableBranding} → the gate 2
 *   colour tests go red while every gate 1 test stays green.
 */

/** Six-digit hex, the only shape the colour schema allows. */
const GOOD_COLORS = ['#e30000', '#CEA967', '#000000', '#ffffff'];

/**
 * Everything that is not.
 *
 * The first three are the shapes the *old*, wider alphabet accepted — they are
 * here because narrowing is the decision this file records, not an accident.
 * The rest is why the check exists at all: a value that closes the declaration
 * and smuggles a second one in behind it.
 */
const BAD_COLORS = [
  '#fff',
  '#ffff',
  '#cea967ff',
  '#cea96',
  '#gggggg',
  '',
  'red',
  'rgb(255 0 0)',
  'var(--color-accent)',
  ' #e30000',
  '#e30000 ',
  '#e30000; }',
  '#fff; background: url(https://evil.example/pixel.png)',
  '#e30000; } body { display: none }',
  'expression(alert(1))',
];

/** A branding an organisation could legitimately save. */
const VALID_WRITE = {
  name: 'Ortsgruppe Musterstadt',
  logoRef: { kind: 'asset', ref: 'assets/beispiel-emblem.svg' },
  logoWide: false,
  stripeColors: ['#e30000', '#cad0d3', '#131313'],
  accent: '#e30000',
  headerBg: '#131313',
  canvasBg: '#e9e6df',
  revision: 1,
};

/** A stored row exactly as the seed leaves it — nothing to repair. */
const STORED: StoredTenantBranding = {
  logoRef: 'assets/beispiel-signet.svg',
  logoWide: true,
  stripeColors: ['#212226', '#7c0800', '#cea967'],
  accentColor: '#cea967',
  headerColor: '#212226',
  canvasColor: '#e9e6df',
};

describe('the colour predicate', () => {
  it.each(GOOD_COLORS)('accepts %s', (value) => {
    expect(isBrandColor(value)).toBe(true);
  });

  it.each(BAD_COLORS)('rejects %s', (value) => {
    expect(isBrandColor(value)).toBe(false);
  });

  it('is not anchored loosely enough to accept a newline behind it', () => {
    // Green today because JavaScript's `$` means end-of-input — but it stops
    // meaning that the moment somebody adds the `m` flag, and in several other
    // languages it never did. A newline is a declaration separator in CSS, so
    // this is the anchoring mistake that would be invisible in review.
    expect(isBrandColor('#e30000\n')).toBe(false);
    expect(isBrandColor('#e30000\nbody{display:none}')).toBe(false);
  });
});

describe('gate 1 — saving („Ablehnung beim Speichern")', () => {
  it('accepts a branding an organisation could have configured', () => {
    expect(tenantBrandingWriteSchema.parse(VALID_WRITE)).toEqual(VALID_WRITE);
  });

  it.each(BAD_COLORS)('refuses %s as the accent, naming the field', (value) => {
    const result = tenantBrandingWriteSchema.safeParse({
      ...VALID_WRITE,
      accent: value,
    });

    expect(result.success).toBe(false);
    // The message has to say *which* field is wrong — a form with seven colour
    // pickers and a bare „ungültig" tells an editor nothing.
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ['accent'],
    ]);
  });

  it.each(['headerBg', 'canvasBg'] as const)(
    'refuses an unsafe %s and names it',
    (field) => {
      const result = tenantBrandingWriteSchema.safeParse({
        ...VALID_WRITE,
        [field]: '#fff; } body { display: none }',
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([
        [field],
      ]);
    },
  );

  /**
   * **The name of the organisation is single-line** (ADR-0026).
   *
   * The same two-gate construction as with the colours, only with a different
   * target: a colour lands in a CSS property, this value lands in the body
   * of every system mail of this organisation (invitation, reset, notice
   * about a password that has been set) and in the display name of the sender.
   * In the text version a `\n` is not a character but a new line — whoever
   * holds `can_manage_settings` would thereby write into a mail that goes out
   * over the identity of the **installation**.
   *
   * *Counter-check:* take `isSingleLineText` out of the field → this case goes
   * red; `tenantCreateSchema` in `tenant-admin.test.ts` measures the same value
   * on the second write path.
   */
  it('refuses a name that would open a second line in a system mail', () => {
    for (const name of [
      'Ortsgruppe\n\nDein Zugang läuft ab: https://boese.example',
      'Ortsgruppe\u{202E}Nord',
    ]) {
      const result = tenantBrandingWriteSchema.safeParse({
        ...VALID_WRITE,
        name,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([
        ['name'],
      ]);
    }
  });

  it('refuses an unsafe colour anywhere in a list, with its index', () => {
    const result = tenantBrandingWriteSchema.safeParse({
      ...VALID_WRITE,
      stripeColors: ['#e30000', 'red', '#131313'],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ['stripeColors', 1],
    ]);
  });

  /**
   * A write that carries a field the schema does not know is **refused**,
   * not silently stripped.
   *
   * That is `strictObject` and no frill: the tab writes the whole
   * document, and a field the server throws away would look to an old tab
   * exactly like one it saves.
   */
  it('refuses a write that carries a field outside the schema', () => {
    expect(
      tenantBrandingWriteSchema.safeParse({
        ...VALID_WRITE,
        extraField: ['#e30000', '#cad0d3', '#131313'],
      }).success,
    ).toBe(false);
  });

  it('bounds the stripe instead of letting a payload grow one', () => {
    const nine = Array.from({ length: 9 }, () => '#e30000');

    expect(
      tenantBrandingWriteSchema.safeParse({
        ...VALID_WRITE,
        stripeColors: nine,
      }).success,
    ).toBe(false);
    expect(
      tenantBrandingWriteSchema.safeParse({ ...VALID_WRITE, stripeColors: [] })
        .success,
    ).toBe(false);
  });

  it.each([
    'javascript:alert(1)',
    'https://fremd.example/logo.png',
    'assets/../../etc/passwd',
    'assets/beispiel-signet.svg ',
    '__proto__',
    'constructor',
  ])(
    'refuses the logo %s — neither a shipped asset nor a file reference',
    (ref) => {
      const result = tenantBrandingWriteSchema.safeParse({
        ...VALID_WRITE,
        logoRef: { kind: 'asset', ref },
      });

      expect(result.success).toBe(false);
      // The discriminator is matched, so the issue is the arm's own field —
      // which is the property that makes „welcher Resolver" and „welcher Wert"
      // one decision instead of two (`tenantLogoSchema`).
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([
        ['logoRef', 'ref'],
      ]);
    },
  );

  /**
   * The bare string is what `logo_ref` used to be on the wire. A save that
   * still sends one is refused rather than guessed at — a schema that accepted
   * both spellings would be the prefix convention ADR-0014 no. 12 ruled out,
   * arrived at by compatibility instead of by decision.
   */
  it.each(TENANT_LOGO_REFS)('refuses the bare string %s', (logoRef) => {
    expect(
      tenantBrandingWriteSchema.safeParse({ ...VALID_WRITE, logoRef }).success,
    ).toBe(false);
  });

  it.each(TENANT_LOGO_REFS)('accepts the shipped logo %s', (ref) => {
    expect(
      tenantBrandingWriteSchema.safeParse({
        ...VALID_WRITE,
        logoRef: { kind: 'asset', ref },
      }).success,
    ).toBe(true);
  });

  /**
   * The `upload` arm passes **gate 1** — it has to, because the tab hands the
   * document it read straight back. What it does not pass is the server, which
   * refuses any reference other than the one currently in `logo_ref`
   * (`TenantBrandingService`): choosing an upload is the upload route's act,
   * this schema can only carry „behalte es".
   */
  it('accepts the upload arm as „keep what is there"', () => {
    expect(
      tenantBrandingWriteSchema.safeParse({
        ...VALID_WRITE,
        logoRef: { kind: 'upload', ref: 'iM4a5oW1hLcVKQr3jd0lZQ' },
      }).success,
    ).toBe(true);
  });

  it('accepts an organisation without a logo', () => {
    expect(
      tenantBrandingWriteSchema.safeParse({ ...VALID_WRITE, logoRef: null })
        .success,
    ).toBe(true);
  });

  it('refuses a field it does not know', () => {
    // An allow list: a colour axis added later has to be added here, and
    // until it is, a client sending it gets an answer instead of silence.
    expect(
      tenantBrandingWriteSchema.safeParse({
        ...VALID_WRITE,
        focusRing: '#e30000',
      }).success,
    ).toBe(false);
  });

  it('refuses a write that names no revision', () => {
    // An optimistic lock the client may omit is one the next client forgets,
    // and the loss it guards against is document-shaped: the branding is
    // written whole, so the loser of a race loses every colour.
    const withoutRevision = Object.fromEntries(
      Object.entries(VALID_WRITE).filter(([key]) => key !== 'revision'),
    );

    expect(tenantBrandingWriteSchema.safeParse(withoutRevision).success).toBe(
      false,
    );
  });
});

describe('gate 2 — delivering („und beim Ausliefern")', () => {
  it('hands a sound branding on unchanged', () => {
    expect(deliverableBranding(STORED)).toEqual({
      // The union of ADR-0014 no. 12, not a bare string: a shipped reference
      // arrives as the `asset` arm, and nothing can be concatenated into an
      // `src` without naming which arm it came from.
      logoRef: { kind: 'asset', ref: 'assets/beispiel-signet.svg' },
      branding: {
        accent: '#cea967',
        headerBg: '#212226',
        canvasBg: '#e9e6df',
        stripe: ['#212226', '#7c0800', '#cea967'],
        wideLogo: true,
      },
    });
  });

  it.each(BAD_COLORS)(
    'refuses to deliver %s written past the API as the accent',
    (accentColor) => {
      // The precondition only this gate can establish: a row gate 1 never saw.
      const delivered = deliverableBranding({ ...STORED, accentColor });

      expect(delivered.branding.accent).toBe(DEFAULT_TENANT_BRANDING.accent);
      expect(delivered.branding.accent).not.toContain(';');
      // The other axes are untouched — a repair must not be a reset.
      expect(delivered.branding.headerBg).toBe('#212226');
    },
  );

  it('refuses a poisoned header and canvas colour the same way', () => {
    const delivered = deliverableBranding({
      ...STORED,
      headerColor: '#fff; } body { display: none }',
      canvasColor: 'url(https://evil.example/x)',
    });

    expect(delivered.branding.headerBg).toBe(DEFAULT_TENANT_BRANDING.headerBg);
    expect(delivered.branding.canvasBg).toBe(DEFAULT_TENANT_BRANDING.canvasBg);
  });

  it('drops a whole stripe rather than a single colour out of it', () => {
    // Two colours where the organisation configured three is a stripe nobody designed.
    const delivered = deliverableBranding({
      ...STORED,
      stripeColors: ['#212226', 'red', '#cea967'],
    });

    expect(delivered.branding.stripe).toEqual(
      DEFAULT_TENANT_BRANDING.stripeColors,
    );
  });

  it('falls back for an empty colour list too', () => {
    const delivered = deliverableBranding({
      ...STORED,
      stripeColors: [],
    });

    expect(delivered.branding.stripe).toEqual(
      DEFAULT_TENANT_BRANDING.stripeColors,
    );
  });

  it.each([
    'javascript:alert(1)',
    'https://fremd.example/logo.png',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    '//fremd.example/logo.png',
    'assets/../../etc/passwd',
    '__proto__',
    'constructor',
  ])('refuses to deliver the logo %s ', (logoRef) => {
    // The two that matter most: a `javascript:` value, and a
    // foreign host — which would be an outbound call from inside an organisation's own
    // page, telling a stranger who opened which form.
    expect(deliverableBranding({ ...STORED, logoRef }).logoRef).toBeNull();
  });

  it('never throws — a wrong column costs colours, not the page', () => {
    expect(() =>
      deliverableBranding({
        logoRef: 'javascript:alert(1)',
        logoWide: false,
        stripeColors: ['nonsense'],
        accentColor: 'nonsense',
        headerColor: 'nonsense',
        canvasColor: 'nonsense',
      }),
    ).not.toThrow();
  });

  it('delivers a branding that satisfies the wire contract', () => {
    // The reason gate 2 substitutes instead of omitting: `tenantBrandingSchema`
    // has no room for "no accent", so a payload carrying a rejected value would
    // fail to parse on the client and take the whole page with it.
    const delivered = deliverableBranding({
      logoRef: null,
      logoWide: false,
      stripeColors: [],
      accentColor: 'nonsense',
      headerColor: 'nonsense',
      canvasColor: 'nonsense',
    });

    for (const value of [
      delivered.branding.accent,
      delivered.branding.headerBg,
      delivered.branding.canvasBg,
      ...delivered.branding.stripe,
    ]) {
      expect(isBrandColor(value)).toBe(true);
    }
  });
});

describe('the shipped logo', () => {
  it('is a closed set, and every entry is a bundled asset path', () => {
    expect(TENANT_LOGO_REFS.length).toBeGreaterThan(0);
    for (const ref of TENANT_LOGO_REFS) {
      expect(isTenantLogoRef(ref)).toBe(true);
      expect(ref.startsWith('assets/')).toBe(true);
    }
  });

  it('answers a name off the prototype chain like any other unknown', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'valueOf']) {
      expect(isTenantLogoRef(key)).toBe(false);
    }
  });

  it('has nothing for an organisation without a logo', () => {
    expect(isTenantLogoRef(null)).toBe(false);
  });

  it('holds every default colour to the same predicate', () => {
    for (const value of [
      DEFAULT_TENANT_BRANDING.accent,
      DEFAULT_TENANT_BRANDING.headerBg,
      DEFAULT_TENANT_BRANDING.canvasBg,
      ...DEFAULT_TENANT_BRANDING.stripeColors,
    ]) {
      expect(isBrandColor(value)).toBe(true);
    }
  });
});

/**
 * **The Logo as a union, and the ownership that decides its arm** (ADR-0014 no. 12).
 *
 * The block exists because the gate cannot answer „gehört diese Datei diesem
 * Organisation?" and must not pretend to: it is pure, it has no database, and both
 * values it could compare come out of one row. The query answers it, the
 * default answers a query that did not — and *that* default is what the tests
 * below actually measure.
 *
 * *Reproductions, run while writing this block:*
 * - Dropping the `stored === ownedUpload` comparison → „refuses a reference
 *   this organisation does not own" goes red (measured: red).
 * - Changing the default of `ownedUpload` from `null` to the stored value →
 *   „a caller that does not load the relation loses the logo" goes red
 *   (measured: red).
 * - Testing the upload arm **before** the asset arm → nothing goes red today,
 *   and that is stated rather than claimed: no shipped reference matches
 *   `isFileRef` (both contain `/` and `.`), so the order is defence against a
 *   future entry, not against a current one.
 */
describe('the logo union and its ownership', () => {
  /** 16 bytes of base64url — the shape `public_ref` has (ADR-0014 no. 9). */
  const OWN_UPLOAD = 'iM4a5oW1hLcVKQr3jd0lZQ';
  const FOREIGN_UPLOAD = 'ZHkQ2rTaP9sLcVK1jd0liM';

  it('delivers a shipped reference as the asset arm', () => {
    expect(deliverableBranding(STORED).logoRef).toEqual({
      kind: 'asset',
      ref: 'assets/beispiel-signet.svg',
    });
  });

  it('delivers an upload the query proved to be this organisation’s', () => {
    const delivered = deliverableBranding(
      { ...STORED, logoRef: OWN_UPLOAD },
      OWN_UPLOAD,
    );

    expect(delivered.logoRef).toEqual({ kind: 'upload', ref: OWN_UPLOAD });
  });

  /**
   * **The case this guards against.** The column names a file, and the
   * tenant-bound query found a *different* one (or, for a foreign reference,
   * none at all). Handing the column's value on would be delivering another
   * organisation's file from inside this organisation's page.
   */
  it('refuses a reference this organisation does not own', () => {
    expect(
      deliverableBranding({ ...STORED, logoRef: FOREIGN_UPLOAD }, OWN_UPLOAD)
        .logoRef,
    ).toBeNull();
  });

  /**
   * The default, which is the safety of the whole design: a shore that forgets
   * to load the relation loses the logo. Visible, harmless, and never
   * somebody else's file — „ein vergessenes Ufer ist ein Anzeigefehler und kein
   * Datenabfluss" (ADR-0014 no. 12).
   */
  it('loses the logo when the caller does not load the relation', () => {
    expect(
      deliverableBranding({ ...STORED, logoRef: OWN_UPLOAD }).logoRef,
    ).toBe(null);
  });

  /**
   * Ownership alone is not enough. A `logo_ref` written past the API can hold
   * anything, and „die Query hat es gefunden" says nothing about the shape of
   * the string — so the predicate runs even on a value the query matched.
   */
  it('refuses a matched reference that is not a reference at all', () => {
    const poisoned = 'javascript:alert(1)';

    expect(
      deliverableBranding({ ...STORED, logoRef: poisoned }, poisoned).logoRef,
    ).toBeNull();
  });

  it.each(TENANT_LOGO_REFS)(
    'reads the shipped %s as an asset even when handed as an owned upload',
    (logoRef) => {
      expect(
        deliverableBranding({ ...STORED, logoRef }, logoRef).logoRef,
      ).toEqual({ kind: 'asset', ref: logoRef });
    },
  );

  /**
   * The seam this replaces (`assetLogoRef`) narrowed the wire to the shipped
   * assets before uploads existed; the wire now carries the union itself.
   * What is left is the question the *life cycle* asks — „ist das der eigene
   * Upload?" — because its callers delete bytes.
   */
  it('names the uploaded arm, and only that one', () => {
    expect(uploadedLogoRef({ kind: 'upload', ref: OWN_UPLOAD })).toBe(
      OWN_UPLOAD,
    );
    expect(
      uploadedLogoRef({ kind: 'asset', ref: 'assets/beispiel-signet.svg' }),
    ).toBeNull();
    expect(uploadedLogoRef(null)).toBeNull();
  });
});

/**
 * **The union on the wire** (ADR-0014 no. 12).
 *
 * The schema is the contract four payloads share — the session, the public
 * fill-in page, and both directions of the *Erscheinungsbild* tab. What it has
 * to refuse is what a string column can hold and an `<img src>` would follow.
 */
describe('tenantLogoSchema', () => {
  const OWN_UPLOAD = 'iM4a5oW1hLcVKQr3jd0lZQ';

  it("accepts a shipped asset and this organisation's upload", () => {
    expect(
      tenantLogoSchema.parse({
        kind: 'asset',
        ref: 'assets/beispiel-signet.svg',
      }),
    ).toEqual({ kind: 'asset', ref: 'assets/beispiel-signet.svg' });
    expect(tenantLogoSchema.parse({ kind: 'upload', ref: OWN_UPLOAD })).toEqual(
      { kind: 'upload', ref: OWN_UPLOAD },
    );
    expect(tenantLogoSchema.parse(null)).toBeNull();
  });

  /**
   * The two arms do not share an alphabet, and that is the whole point of the
   * discriminator: an asset reference is not a file reference and the other way
   * round, so neither arm can be used to smuggle the other's value.
   */
  it("refuses each arm the other's value", () => {
    expect(
      tenantLogoSchema.safeParse({ kind: 'asset', ref: OWN_UPLOAD }).success,
    ).toBe(false);
    expect(
      tenantLogoSchema.safeParse({
        kind: 'upload',
        ref: 'assets/beispiel-signet.svg',
      }).success,
    ).toBe(false);
  });

  it('refuses a bare string, a URL and an unknown arm', () => {
    // The prefix convention ADR-0014 no. 12 ruled out, and what it would have
    // let through.
    expect(tenantLogoSchema.safeParse('upload:' + OWN_UPLOAD).success).toBe(
      false,
    );
    expect(
      tenantLogoSchema.safeParse({
        kind: 'upload',
        ref: 'https://fremd.example/x.png',
      }).success,
    ).toBe(false);
    expect(
      tenantLogoSchema.safeParse({ kind: 'url', ref: 'javascript:alert(1)' })
        .success,
    ).toBe(false);
  });
});
