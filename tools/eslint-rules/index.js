import { noHardcodedColors } from './no-hardcoded-colors.js';

/**
 * Local ESLint plugin. Kept in-repo rather than published: these rules encode
 * this project's acceptance criteria, not general-purpose lint knowledge.
 */
export const formsachePlugin = {
  meta: { name: 'formsache-eslint-rules' },
  rules: {
    'no-hardcoded-colors': noHardcodedColors,
  },
};
