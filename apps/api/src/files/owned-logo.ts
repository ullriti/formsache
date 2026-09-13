import type { Prisma, Tenant } from '@prisma/client';
import { isFileRef, isTenantLogoRef, type FileRef } from '@formsache/shared';

/**
 * **The ownership check of ADR-0014 no. 12 — as a query fragment, not as a
 * comparison after the load.**
 *
 * `deliverableBranding()` cannot answer „gehört diese Datei dieser Organisation?": it
 * is pure and total, it has no database, and both values it could compare come
 * out of the same row. The check therefore stands **before** the gate, and it
 * is structural: the reading query loads the Logo file **through the tenant
 * relation**, so a `logo_ref` naming another organisation's file simply finds nothing.
 *
 * That is the difference this file exists for. A comparison after the load —
 * „ist `file.tenant_id` gleich der Organisation?" — is a check somebody can forget, can
 * invert, or can write against the wrong of two ids. A relation include cannot
 * return a foreign row at all: `tenant.files` is the organisation's own set by
 * definition of the foreign key.
 *
 * ## The four shores, and why the fragment is one constant
 *
 * ADR-0014 no. 12 names them: the sessionless fill-in page
 * (`public/public-forms.service.ts`), the session payload
 * (`auth/session-user.ts`), the *Erscheinungsbild* tab
 * (`tenant-admin/tenant-branding.service.ts`) and the superadmin overview
 * across Organisationen (`admin/admin.service.ts`). Four queries, one fragment: a second
 * spelling of „welche Dateien gehören dieser Organisation" is the drift this repository
 * has paid for three times over.
 *
 * ## What is deliberately *not* bounded here
 *
 * The include has no `take`. A `take` would be a silent wrong answer — the
 * matching row could be the one cut off — and it is not needed: since the logo
 * life cycle was decided (ADR-0014 no. 19), **an organisation holds at most one
 * `tenant_logo` row**. The upload adopts in the same transaction that stores,
 * and the sweep takes every row the organisation no longer names, so „mehr als eine"
 * is a state this application does not produce. `tenant-logo.spec.ts` asserts
 * that invariant after *every* operation rather than only where a deletion is
 * expected, which is what makes the missing bound safe rather than lucky.
 */
export const OWNED_LOGO_INCLUDE = {
  files: {
    where: { kind: 'tenant_logo' },
    select: { publicRef: true },
  },
} satisfies Prisma.TenantInclude;

/**
 * A tenant row with its own Logo files loaded — **optional on purpose**.
 *
 * The optionality is the ADR's decision, not laziness: „ein Aufrufer, der die
 * Datei-Relation nicht mitlädt, verliert das Logo (sichtbar, harmlos,
 * Rückfall auf kein Logo) — er liefert nie einen fremden Verweis aus". A
 * forgotten shore is a display bug; making the field required would turn it
 * into a compile error at four sites today and would still not stop a fifth
 * from passing an empty array.
 */
export interface TenantLogoFiles {
  readonly files?: readonly { readonly publicRef: string }[];
}

/**
 * A tenant row as {@link OWNED_LOGO_INCLUDE} loads it.
 *
 * Declared **here**, next to the include that produces it, and not a second
 * time next to each reader: two aliases for one shape differing by a trailing
 * „s" is precisely the drift `CONTRIBUTING.md` rules out, and it had already
 * happened once in this package before the review gate caught it.
 */
export type TenantWithLogoFiles = Tenant & Required<TenantLogoFiles>;

/**
 * The reference this query **proved** to be the organisation's own, or `null`.
 *
 * What comes back is taken from the loaded row, never from the `logo_ref`
 * column: the column is the *question*, the relation is the answer. A shipped
 * asset is `null` here rather than a miss — it is not an upload, and
 * `deliverableBranding` reads it from the column itself.
 */
export function ownedLogoRef(
  tenant: { readonly logoRef: string | null } & TenantLogoFiles,
): FileRef | null {
  const stored = tenant.logoRef;
  if (stored === null || isTenantLogoRef(stored) || !isFileRef(stored)) {
    return null;
  }
  return (
    tenant.files?.find((file) => file.publicRef === stored)?.publicRef ?? null
  );
}
