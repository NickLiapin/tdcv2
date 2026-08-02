/**
 * Public surface of the validator module.
 */

export { validate, type ValidationOptions, type ValidationResult } from './validate.js';
export {
  KNOWN_GEN_TYPES,
  KNOWN_TEMPLATE_PATHS,
  localesHavingPath,
  KNOWN_TDC_CHILDREN,
  KNOWN_ENV_CHILDREN,
  KNOWN_MIX_CHILDREN,
  KNOWN_SWITCH_CHILDREN,
  KNOWN_CASE_CHILDREN,
  SUPPORTED_BINARY_OPERATORS,
  SUPPORTED_UNARY_OPERATORS,
  BUILTIN_SEQUENCES,
} from './known.js';
export { COMPUTE_TAGS } from './compute.js';
export { ATTRIBUTE_OWNERS, CLOSED_TAG_ATTRIBUTES, GEN_ATTRIBUTES } from './unknown-attrs.js';
