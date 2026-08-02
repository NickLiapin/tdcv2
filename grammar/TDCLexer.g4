lexer grammar TDCLexer;

/*
 * Lexer for the TDC DSL.
 *
 * ANTLR4 requires that grammars using lexer modes be pure lexer grammars
 * (a "combined" grammar with both parser and lexer rules cannot declare
 * modes). Accordingly, TDC's lexer and parser are split: this file
 * declares all tokens and modes; TDCParser.g4 imports the token
 * vocabulary and declares parser rules.
 *
 * Scope — current TypeScript implementation. Paired <data> closers are
 * normalized before lexing; this lexer still sees a static </data>
 * delimiter after that pre-pass.
 */

// ========== Default (structural) mode ==========

// Opens a <data> tag. Matches just "<data" (no closing >) so that
// attributes on <data> can be parsed before we commit to raw-text mode.
// Once in DATA_ATTRS mode, the '>' transition flips us to DATA_BODY.
// ANTLR's longest-match rule ensures this wins over bare LT + NAME.
DATA_TAG_OPEN : '<data' -> pushMode(DATA_ATTRS) ;

// Opens a <map> tag — a raw-text container (like <data>) whose body is a
// compact `KEY:VALUE, …` lookup table for <switch>. Mirrors the <data>
// three-mode dance so attributes could be parsed before the raw-text body.
MAP_TAG_OPEN : '<map' -> pushMode(MAP_ATTRS) ;

// "</foo>" consumed as one token so the parser sees a clean closing marker.
// Must be declared before LT so it wins longest-match over a bare '<'.
END_TAG : '</' IDENT '>' ;

LT       : '<' ;
GT       : '>' ;
SLASH_GT : '/>' ;
EQ       : '=' ;

NAME : IDENT ;

// Attribute values: double-quoted, no line breaks, no embedded '"'.
STRING : '"' ~["\r\n]* '"' ;

COMMENT  : '<!--' .*? '-->'  -> channel(HIDDEN) ;
XML_DECL : '<?xml' .*? '?>'  -> channel(HIDDEN) ;
WS       : [ \t\r\n]+         -> channel(HIDDEN) ;

fragment IDENT : [a-zA-Z_] [a-zA-Z0-9_]* ;

// ========== <data> attribute mode ==========
//
// Between '<data' and the closing '>' we parse any number of
// attribute=value pairs. Tokens are emitted with the same types as
// in the default mode (NAME, EQ, STRING, GT, SLASH_GT) so the parser
// sees a uniform grammar regardless of whether attrs sit on <data>
// or on a regular tag.

mode DATA_ATTRS;

DATA_ATTRS_WS      : [ \t\r\n]+           -> channel(HIDDEN) ;
DATA_ATTR_NAME     : IDENT                -> type(NAME) ;
DATA_ATTR_EQ       : '='                  -> type(EQ) ;
DATA_ATTR_STRING   : '"' ~["\r\n]* '"'    -> type(STRING) ;
DATA_ATTR_GT       : '>'                  -> type(GT), mode(DATA_BODY) ;
DATA_ATTR_SELFCLOSE: '/>'                 -> type(SLASH_GT), popMode ;

// ========== Raw-text mode for <data> body ==========
//
// In DATA_BODY the lexer consumes every character as an opaque DATA_TEXT
// token until it hits the literal '</data>', which pops back to default
// mode. This realises the "raw-text container" semantics of <data> from
// docs/vision/03-dsl.md: anything inside — even tag-like constructs — is
// literal text destined for the generator output.

mode DATA_BODY;

DATA_CLOSE : '</data>' -> popMode ;
DATA_TEXT  : . ;

// ========== <map> attribute mode ==========
//
// Same shape as DATA_ATTRS: parse optional attributes between '<map' and the
// closing '>' (emitting NAME/EQ/STRING/GT/SLASH_GT so the parser reuses the
// generic attr rule), then flip to MAP_BODY on '>'.

mode MAP_ATTRS;

MAP_ATTRS_WS       : [ \t\r\n]+        -> channel(HIDDEN) ;
MAP_ATTR_NAME      : IDENT             -> type(NAME) ;
MAP_ATTR_EQ        : '='               -> type(EQ) ;
MAP_ATTR_STRING    : '"' ~["\r\n]* '"' -> type(STRING) ;
MAP_ATTR_GT        : '>'               -> type(GT), mode(MAP_BODY) ;
MAP_ATTR_SELFCLOSE : '/>'              -> type(SLASH_GT), popMode ;

// ========== Raw-text mode for <map> body ==========
//
// Consume every character as opaque MAP_TEXT until the literal '</map>'.
// The compact key:value table inside is parsed by the extractor, not the
// grammar — so ':', ',', '|' etc. are just literal characters here.

mode MAP_BODY;

MAP_CLOSE : '</map>' -> popMode ;
MAP_TEXT  : . ;
