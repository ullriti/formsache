import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  TENANT_LOGO_REFS,
  deliverableBranding,
  uploadedLogoRef,
  type TenantBrandingSettings,
  type TenantBrandingWrite,
} from '@formsache/shared';

import { FileStorage } from '../files/file-storage';
import { sweepUnreferencedLogos } from '../files/logo-sweep';
import { ownedLogoRef, type TenantWithLogoFiles } from '../files/owned-logo';
import type { TenantScope } from '../tenancy/tenant-scope';

/**
 * The answer to a save that started from a branding somebody else has replaced.
 *
 * Worded like `STALE_SETTINGS_MESSAGE` and for the same reason: the remedy is
 * to reload and look at what is now there, and a message that explains the
 * mechanism would ask an admin to act on something they cannot act on.
 */
export const STALE_BRANDING_MESSAGE =
  'Das Erscheinungsbild wurde zwischenzeitlich geändert. Bitte neu laden.';

/**
 * The organisation is gone between the guard chain and the write — possible only if
 * somebody deleted it in that window. Not a 500: nothing broke.
 */
export const TENANT_NOT_FOUND_MESSAGE =
  'Die Organisation wurde nicht gefunden.';

/**
 * The answer to a save that names an upload this organisation is not currently showing.
 *
 * Almost always the honest cause: a tab that was open while the logo was
 * replaced, and whose document still holds the previous reference. The remedy
 * is to reload, so that is what it says.
 */
export const UNKNOWN_LOGO_MESSAGE =
  'Dieses Logo gehört nicht mehr zu dieser Organisation. Bitte neu laden.';

/**
 * Reading and writing the branding of the *active* Organisation.
 *
 * **No `PrismaService` in the constructor**, exactly as `FormSettingsService`
 * does it: the only way to a row is the `TenantScope` the guard chain hands in,
 * so „forgetting the tenant" would be a visible change to this constructor
 * rather than a missing `where` key (`CONTRIBUTING.md`). `scope.tenant` has no way
 * to name a *different* Organisation at all — which is what makes „das Erscheinungsbild
 * einer fremden Organisation ist weder les- noch schreibbar" structural rather than
 * checked.
 *
 * **Both directions pass the delivery gate**, including the read that feeds the
 * editor. The tab paints the stored colours into swatches and the logo into
 * an `<img>`, so it is an output like any other; a value that reached the row
 * past the API must not become an admin's `src` either.
 */
@Injectable()
export class TenantBrandingService {
  constructor(private readonly storage: FileStorage) {}

  /** What the *Erscheinungsbild* tab shows. */
  async read(scope: TenantScope): Promise<TenantBrandingSettings> {
    return this.present(await this.load(scope));
  }

  /**
   * Replaces the branding of the active Organisation.
   *
   * The colours and the logo were decided by `tenantBrandingWriteSchema`
   * before this method sees them — gate 1, in `packages/shared`. Nothing is
   * re-validated here: a second, weaker restatement of the rule is exactly the
   * duplication the requirement exists to prevent.
   */
  async replace(
    scope: TenantScope,
    request: TenantBrandingWrite,
  ): Promise<TenantBrandingSettings> {
    // The row is loaded first only so a vanished Organisation answers 404 rather than
    // the 409 a failed conditional update would otherwise produce — the
    // *decision* about concurrency stays inside the single conditional write.
    const before = await this.load(scope);
    this.requireOwnLogo(before, request);

    const { revision, ...branding } = request;
    const written = await scope.tenant.updateBranding(revision, branding);
    if (!written) {
      throw new ConflictException(STALE_BRANDING_MESSAGE);
    }

    // **The way back from „eigenes" to „ausgeliefertes" is where the file
    // goes** (`files/logo-sweep.ts`). A save that picks an asset
    // or none leaves the uploaded row referenced by nobody, and nothing else
    // collects it — the purge of ADR-0014 no. 15 touches no Logo. Runs after
    // the write and re-derives its candidates from the column, so it can never
    // take the file the organisation now shows.
    await sweepUnreferencedLogos(scope, this.storage);

    return this.present(await this.load(scope));
  }

  /**
   * **The `upload` arm means „behalte mein Logo", never „nimm dieses"**.
   *
   * Choosing an upload is the upload route's act — it writes `logo_ref` in the
   * transaction that mints the row — so the only upload reference this save may
   * carry is the one the organisation is *already* showing. Anything else is refused
   * rather than written.
   *
   * Two things it keeps out, and neither is hypothetical:
   *
   * - **another organisation's file.** The delivery gate would refuse to hand it on
   *   (`deliverableBranding` + `ownedLogoRef`, ADR-0014 no. 12), so this is
   *   defence in depth rather than the boundary — but a column that can hold a
   *   foreign reference is one raw read away from being followed by something
   *   that does not ask the gate;
   * - **a reference of this organisation that the sweep is about to remove.** Without
   *   this check, a stale tab could re-point `logo_ref` at a row whose bytes are
   *   already gone, and the organisation's page would show a broken image instead of
   *   the logo it just uploaded.
   *
   * The comparison is against the **loaded row's own delivered logo**, not
   * against the column: `ownedLogoRef` has proven the file belongs to this organisation
   * through the relation, and comparing against anything else would be the
   * „zwei Werte aus derselben Zeile" that ADR-0014 no. 12 rejects.
   */
  private requireOwnLogo(
    tenant: TenantWithLogoFiles,
    request: TenantBrandingWrite,
  ): void {
    const wanted = uploadedLogoRef(request.logoRef);
    if (wanted === null) {
      return;
    }
    const current = uploadedLogoRef(
      deliverableBranding(tenant, ownedLogoRef(tenant)).logoRef,
    );
    if (wanted !== current) {
      throw new BadRequestException(UNKNOWN_LOGO_MESSAGE);
    }
  }

  private async load(scope: TenantScope): Promise<TenantWithLogoFiles> {
    // The third shore of ADR-0014 no. 12 — the tab that shows an organisation its own
    // Logo. The relation comes with the row, so a `logo_ref` naming another
    // organisation's upload has nothing here to be proven by.
    const tenant = await scope.tenant.findWithLogoFile();
    if (tenant === null) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    return tenant;
  }

  /**
   * The row as the tab receives it — **through the gate**.
   *
   * `logoChoices` travels rather than being compiled into the view, so the set
   * the tab offers and the set the server accepts are the same list — and it stays the **shipped** set now that uploads were added:
   * an uploaded logo is not a choice picked from a list, it is the file the
   * Organisation sent to `POST /tenant/branding/logo`, and it arrives here as
   * `logoRef` with `kind: 'upload'`.
   *
   * What is still *not* in this payload: an upload URL, a token, a path. The
   * address of the route is the client's own constant, and the only file
   * reference that leaves here is one the relation proved (ADR-0014 no. 12).
   */
  private present(tenant: TenantWithLogoFiles): TenantBrandingSettings {
    const { logoRef, branding } = deliverableBranding(
      tenant,
      ownedLogoRef(tenant),
    );
    return {
      name: tenant.name,
      shortName: tenant.shortName,
      // The gate's own answer (ADR-0014 no. 12). `logoChoices` still lists
      // only the **shipped** assets — an upload is not a choice the tab offers
      // from a list, it is the file the organisation sent to the upload route.
      logoRef,
      logoWide: branding.wideLogo,
      stripeColors: [...branding.stripe],
      accent: branding.accent,
      headerBg: branding.headerBg,
      canvasBg: branding.canvasBg,
      logoChoices: [...TENANT_LOGO_REFS],
      revision: tenant.brandingRevision,
    };
  }
}
