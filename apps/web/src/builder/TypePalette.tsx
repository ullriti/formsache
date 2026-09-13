import type { ReactElement } from 'react';

import { useBuilderStore } from './builder-store';
import { QUESTION_TYPES, QUESTION_TYPE_LABELS } from './question-defaults';

/**
 * The Fragetyp-Bibliothek of the right panel — what the panel
 * shows while no question is selected.
 *
 * Nine buttons, one per original type. The remaining seven of the handoff (Adresse,
 * Tabelle, Matrix, Bewertung, Datei-Upload, Veranstaltung, Infotext) are
 * **not** rendered as disabled placeholders: a control that cannot be used
 * still promises a feature, and they arrive later.
 */
export function TypePalette(): ReactElement {
  const addQuestion = useBuilderStore((state) => state.addQuestion);

  return (
    <div className="palette">
      <p className="palette__caption">Fragetyp hinzufügen</p>
      <div className="palette__grid">
        {QUESTION_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            className="palette__item"
            onClick={() => {
              // The id is minted here rather than in the store, so the store
              // stays a pure reducer over its own state — which is what makes
              // its reordering rules testable without stubbing a generator.
              addQuestion(type, crypto.randomUUID());
            }}
          >
            {QUESTION_TYPE_LABELS[type]}
          </button>
        ))}
      </div>
    </div>
  );
}
