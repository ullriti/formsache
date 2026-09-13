import type { ReactElement } from 'react';

import { CopyableAddress } from './CopyableAddress';

/**
 * The „Antwort später ändern"-address on the confirmation page.
 *
 * A thin wrapper around {@link CopyableAddress}, which carries the copying and
 * the failure handling both this and *Zwischenspeichern*'s saved-draft address
 *  need — see that component's doc comment for why the two
 * share one implementation rather than two.
 */
export function EditLink({ url }: { readonly url: string }): ReactElement {
  return (
    <CopyableAddress
      url={url}
      testId="public-edit-link"
      label="Adresse zu Ihrer Antwort"
      hint="Diese Antwort lässt sich über die folgende Adresse noch ändern. Bitte aufbewahren — sie ist der einzige Weg zurück zu dieser Antwort."
    />
  );
}
