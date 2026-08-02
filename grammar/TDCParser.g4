parser grammar TDCParser;

/*
 * Parser for the TDC DSL.
 *
 * Imports the token vocabulary declared in TDCLexer.g4.
 *
 * Scope — current TypeScript implementation. Parses the canonical
 * fixtures plus runtime-supported constructs into a structurally valid
 * parse tree; semantic checks live in the validator.
 *
 * Semantic support for <switch>/<case> is implemented in the TypeScript
 * runtime/validator; grammar-level structure stays intentionally generic.
 * See docs/vision/03-dsl.md for the full DSL specification.
 *
 * Note: paired raw text (`<data pair="X">...</data pair="X">`) is
 * normalized before lexing so the lexer can keep a simple static
 * DATA_CLOSE token while still preserving literal nested `</data>` text.
 */

options { tokenVocab = TDCLexer; }

// Top-level document: a sequence of elements. A valid TDC file has a
// single top-level <tdc>, but the grammar is intentionally permissive at
// this level so that comment-only or empty inputs also parse.
document : element* EOF ;

element
    : dataElement
    | mapElement
    | openCloseElement
    | selfClosingElement
    ;

openCloseElement   : LT name=NAME attr* GT content endTag=END_TAG ;
selfClosingElement : LT name=NAME attr* SLASH_GT ;
// <data [attr="value"]*> body </data>  OR  <data [attr="value"]* />
// Self-closing `<data/>` is syntactically allowed but semantically
// meaningless in the current runtime (empty text); kept for symmetry
// with regular tags.
dataElement
    : DATA_TAG_OPEN attr* GT dataContent DATA_CLOSE  # dataWithBody
    | DATA_TAG_OPEN attr* SLASH_GT                   # dataSelfClosed
    ;

// <map [attr="value"]*> KEY:VALUE, … </map>  OR  <map [attr="value"]* />
// A raw-text container (like <data>) holding a compact lookup table for
// <switch>. The body is opaque MAP_TEXT; the extractor parses key:value rows.
mapElement
    : MAP_TAG_OPEN attr* GT mapContent MAP_CLOSE   # mapWithBody
    | MAP_TAG_OPEN attr* SLASH_GT                  # mapSelfClosed
    ;

content     : element* ;
dataContent : DATA_TEXT* ;
mapContent  : MAP_TEXT* ;

attr : attrName=NAME EQ attrValue=STRING ;
