import { findColorLiteral, NAMED_COLORS } from './color-literals.js';

/**
 * Property names whose value is a colour. Only inside these does a bare word
 * like `red` count as a hardcoded colour — everywhere else it is just a word
 * (a variant name, a test fixture, a CSS class).
 */
const COLOR_PROPERTY =
  /^(?:color|fill|stroke|background|background-?color|background-?image|border-?color|border-?(?:top|right|bottom|left)-?color|outline-?color|caret-?color|text-?decoration-?color|column-?rule-?color|accent-?color|box-?shadow|text-?shadow)$/i;

/** Reads a property key as text, for both `{ color: … }` and `{ 'color': … }`. */
function propertyName(key) {
  if (key.type === 'Identifier') {
    return key.name;
  }

  if (key.type === 'Literal' && typeof key.value === 'string') {
    return key.value;
  }

  return null;
}

/**
 * ESLint rule enforcing that components must not spell colours out.
 * Every colour comes from the design tokens in
 * `apps/web/src/styles/tokens.css`, because tenant branding switches those
 * tokens at runtime — a literal in a component is invisible to that switch.
 */
export const noHardcodedColors = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hardcoded colour literals; use the design tokens instead.',
    },
    schema: [],
    messages: {
      hardcodedColor:
        'Hardcoded colour "{{color}}". Use a design token from apps/web/src/styles/tokens.css — tenant branding overrides those at runtime.',
    },
  },

  create(context) {
    function report(node, text) {
      const color = findColorLiteral(text);
      if (color !== null) {
        context.report({ node, messageId: 'hardcodedColor', data: { color } });
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') {
          report(node, node.value);
        }
      },

      TemplateElement(node) {
        report(node, node.value.raw);
      },

      Property(node) {
        const name = propertyName(node.key);
        if (name === null || !COLOR_PROPERTY.test(name)) {
          return;
        }

        const { value } = node;
        if (value.type !== 'Literal' || typeof value.value !== 'string') {
          return;
        }

        const word = value.value.trim().toLowerCase();
        if (NAMED_COLORS.includes(word)) {
          context.report({
            node: value,
            messageId: 'hardcodedColor',
            data: { color: word },
          });
        }
      },
    };
  },
};
