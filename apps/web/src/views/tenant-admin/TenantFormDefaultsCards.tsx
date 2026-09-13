import type { ReactElement } from 'react';
import type {
  PartialTenantFormSettings,
  TenantFormSettings,
} from '@formsache/shared';

import type { SettingIssues } from '../settings/SettingsControls';
import { SettingsSectionCard } from '../settings/SettingsSectionCard';
import {
  SECTION_DEFINITIONS,
  SettingsSectionFields,
} from '../settings/SettingsSectionFields';

import '../settings-view.css';

/**
 * **The four section cards of the Formular-Standards** — pure display over
 * somebody else's values.
 *
 * Two hosts since ADR-0025: the page *Formular-Standards* and the sixth
 * step of the organisation assistant. What stands here is only the
 * order and the wiring of the building blocks that are shared anyway — the
 * state belongs to `use-tenant-form-defaults.ts`.
 *
 * **Four and not five**: *Verfügbarkeit* stands only at the form (ADR-0011,
 * continuation 2026-08-14) — the type of this document does not carry the keys
 * in the first place.
 */
export function TenantFormDefaultsCards({
  values,
  issues,
  onChange,
}: {
  readonly values: TenantFormSettings;
  readonly issues: SettingIssues;
  readonly onChange: (next: PartialTenantFormSettings) => void;
}): ReactElement {
  return (
    <>
      {SECTION_DEFINITIONS.map((definition) => (
        <SettingsSectionCard key={definition.key} definition={definition}>
          <SettingsSectionFields
            section={definition.key}
            values={values}
            issues={issues}
            onChange={onChange}
          />
        </SettingsSectionCard>
      ))}
    </>
  );
}
