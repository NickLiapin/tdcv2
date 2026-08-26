package io.github.nickliapin.tdc.parser;

import io.github.nickliapin.tdc.parser.generated.TDCLexer;
import io.github.nickliapin.tdc.parser.generated.TDCParser;
import java.util.ArrayList;
import java.util.List;
import org.antlr.v4.runtime.BaseErrorListener;
import org.antlr.v4.runtime.CharStreams;
import org.antlr.v4.runtime.CommonTokenStream;
import org.antlr.v4.runtime.Parser;
import org.antlr.v4.runtime.RecognitionException;
import org.antlr.v4.runtime.Recognizer;
import org.antlr.v4.runtime.RuleContext;
import org.antlr.v4.runtime.Token;

/**
 * Turns TDC source text into a parse tree.
 *
 * <p>The grammar comes from {@code ../grammar}, the same files the TypeScript implementation
 * generates its parser from. Keeping one grammar is what stops the two languages from slowly
 * accepting different dialects.
 *
 * <p>ANTLR's default behaviour is to print syntax errors to the console and carry on with a
 * best-effort tree. That is wrong for a data generator: a config that half-parsed would
 * produce data that looks plausible and is not what the user asked for. Errors are collected
 * here and the caller decides.
 */
public final class TdcParserFacade {

  /** One syntax error, with the position a user can act on. */
  public record SyntaxProblem(int line, int column, String message) {
    @Override
    public String toString() {
      return line + ":" + column + " " + message;
    }
  }

  /** A parse tree plus whatever went wrong producing it. */
  public record Result(TDCParser.DocumentContext tree, List<SyntaxProblem> problems) {
    public boolean ok() {
      return problems.isEmpty();
    }
  }

  private TdcParserFacade() {}

  /**
   * A hard ceiling on element nesting. The parser recurses once per nested element, so input
   * depth IS stack depth: a runaway document must be refused, not parsed until the stack gives
   * out. Real configs nest a handful of levels.
   */
  public static final int MAX_ELEMENT_DEPTH = 64;

  /** Raised when a document nests elements deeper than {@link #MAX_ELEMENT_DEPTH}. */
  private static final class ElementDepthException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    final int line;
    final int column;

    ElementDepthException(int line, int column) {
      super(
          "elements nested deeper than "
              + MAX_ELEMENT_DEPTH
              + " levels — refusing a runaway document");
      this.line = line;
      this.column = column;
    }
  }

  /**
   * Counts {@code element} rule entries and refuses the level past the ceiling. A parse
   * listener fires before the rule body recurses — exactly the moment the 65th level is about
   * to open and the stack is still shallow.
   */
  private static final class DepthGuard implements org.antlr.v4.runtime.tree.ParseTreeListener {
    private int depth = 0;

    @Override
    public void enterEveryRule(org.antlr.v4.runtime.ParserRuleContext ctx) {
      if (ctx.getRuleIndex() != TDCParser.RULE_element) {
        return;
      }
      depth++;
      if (depth > MAX_ELEMENT_DEPTH) {
        throw new ElementDepthException(
            ctx.getStart().getLine(), ctx.getStart().getCharPositionInLine());
      }
    }

    @Override
    public void exitEveryRule(org.antlr.v4.runtime.ParserRuleContext ctx) {
      if (ctx.getRuleIndex() == TDCParser.RULE_element) {
        depth--;
      }
    }

    @Override
    public void visitTerminal(org.antlr.v4.runtime.tree.TerminalNode node) {}

    @Override
    public void visitErrorNode(org.antlr.v4.runtime.tree.ErrorNode node) {}
  }

  /**
   * Records the first closing tag whose name is not its element's.
   *
   * <p>{@code openCloseElement : LT name=NAME attr* GT content endTag=END_TAG ;} takes ANY name
   * in the closing tag, so {@code <sequence>…</gen>} was a structurally valid document and
   * nothing downstream compared the two: the element is built under its OPENING name and the
   * closing tag is thrown away.
   *
   * <p>Only the first is kept. A closing tag on the wrong element shifts every closing tag after
   * it, so one typo would otherwise produce a mismatch per remaining level — all describing the
   * same typo, and only the first one placed where the author can act on it.
   */
  private static final class ClosingTagGuard
      implements org.antlr.v4.runtime.tree.ParseTreeListener {
    private SyntaxProblem found;

    @Override
    public void enterEveryRule(org.antlr.v4.runtime.ParserRuleContext ctx) {}

    @Override
    public void exitEveryRule(org.antlr.v4.runtime.ParserRuleContext ctx) {
      if (found != null || ctx.getRuleIndex() != TDCParser.RULE_openCloseElement) {
        return;
      }
      TDCParser.OpenCloseElementContext element = (TDCParser.OpenCloseElementContext) ctx;
      org.antlr.v4.runtime.Token open = element.name;
      org.antlr.v4.runtime.Token close = element.endTag;
      // Recovery can leave either token missing or synthesised. A guess about what the author
      // meant to close is worth less than the parser's own complaint about the tag itself.
      if (open == null || close == null || close.getType() != TDCParser.END_TAG) {
        return;
      }
      String closes = closingName(close.getText());
      if (closes == null || closes.equals(open.getText())) {
        return;
      }
      found =
          new SyntaxProblem(
              close.getLine(),
              close.getCharPositionInLine(),
              "</"
                  + closes
                  + "> closes <"
                  + open.getText()
                  + ">, which was opened on line "
                  + open.getLine());
    }

    @Override
    public void visitTerminal(org.antlr.v4.runtime.tree.TerminalNode node) {}

    @Override
    public void visitErrorNode(org.antlr.v4.runtime.tree.ErrorNode node) {}
  }

  /** {@code </gen>} to {@code gen}. Null for anything that is not a closing tag. */
  private static String closingName(String text) {
    if (text == null || !text.startsWith("</") || !text.endsWith(">")) {
      return null;
    }
    return text.substring(2, text.length() - 1);
  }

  /**
   * Puts the mismatch in its place, and drops what the parser said after it.
   *
   * <p>Everything reported past a misplaced closing tag is reading a tree that has already gone
   * wrong — {@code extraneous input '</tdc>'} at the bottom of the file being the usual one. What
   * was said BEFORE it is about a part of the document the mismatch had not reached.
   */
  private static List<SyntaxProblem> withClosingTagMismatch(
      List<SyntaxProblem> problems, SyntaxProblem mismatch) {
    if (mismatch == null) {
      return problems;
    }
    List<SyntaxProblem> kept = new ArrayList<>();
    for (SyntaxProblem problem : problems) {
      if (problem.line() < mismatch.line()
          || (problem.line() == mismatch.line() && problem.column() < mismatch.column())) {
        kept.add(problem);
      }
    }
    kept.add(mismatch);
    return kept;
  }

  /** Parse a config, collecting syntax errors rather than printing them. */
  public static Result parse(String source) {
    List<SyntaxProblem> problems = new ArrayList<>();
    List<SyntaxProblem> fromAntlr = new ArrayList<>();

    PairedData.Rewrite rewritten = PairedData.preprocess(source);
    // Ahead of ANTLR's own, because they were found ahead of it: a config whose paired tags do not
    // line up is misread from that point on, and the first thing said about it should say why.
    for (PairedData.Problem problem : rewritten.problems()) {
      problems.add(new SyntaxProblem(problem.line(), problem.column(), problem.message()));
    }

    // See enclosingOpenTag: ANTLR's EOF messages either name the unclosed tag in a shape a
    // reader has to decode, or do not name it at all.
    BaseErrorListener collector =
        new BaseErrorListener() {
          @Override
          public void syntaxError(
              Recognizer<?, ?> recognizer,
              Object offendingSymbol,
              int line,
              int charPositionInLine,
              String msg,
              RecognitionException e) {
            String message = msg;
            if (recognizer instanceof Parser parser
                && offendingSymbol instanceof Token token
                && token.getType() == Token.EOF) {
              String open = enclosingOpenTag(parser);
              if (open != null) {
                message = "<" + open + "> is never closed";
              }
            }
            fromAntlr.add(new SyntaxProblem(line, charPositionInLine, message));
          }
        };

    TDCLexer lexer = new TDCLexer(CharStreams.fromString(rewritten.source()));
    lexer.removeErrorListeners();
    lexer.addErrorListener(collector);

    TDCParser parser = new TDCParser(new CommonTokenStream(lexer));
    parser.removeErrorListeners();
    parser.addErrorListener(collector);
    parser.addParseListener(new DepthGuard());
    ClosingTagGuard closingTags = new ClosingTagGuard();
    parser.addParseListener(closingTags);

    try {
      TDCParser.DocumentContext tree = parser.document();
      problems.addAll(withClosingTagMismatch(fromAntlr, closingTags.found));
      return new Result(tree, List.copyOf(problems));
    } catch (ElementDepthException refusal) {
      // Past the ceiling there is no tree worth building — parsing it IS the
      // danger. Callers get what garbage input gets: an empty document plus
      // the problem that explains it.
      problems.addAll(fromAntlr);
      problems.add(new SyntaxProblem(refusal.line, refusal.column, refusal.getMessage()));
      return new Result(emptyDocument(), List.copyOf(problems));
    }
  }

  /** A tree with nothing in it, for when the source is refused mid-parse. */
  private static TDCParser.DocumentContext emptyDocument() {
    return new TDCParser(new CommonTokenStream(new TDCLexer(CharStreams.fromString(""))))
        .document();
  }

  /**
   * The tag that was still open when the input ended.
   *
   * <p>ANTLR's own words for this are {@code mismatched input '<EOF>' expecting '</data>'} and
   * {@code missing END_TAG at '<EOF>'} — the first names the tag in a shape a reader has to
   * decode, the second does not name it at all. The parser knows which rule it was inside and
   * that rule carries the tag's name, so the question is answerable: walk out to the nearest
   * tag-opening rule and read it.
   *
   * <p>{@code null} when no such rule is on the stack, in which case ANTLR's message stands — a
   * wrong guess about which tag is open would be worse than jargon.
   */
  private static String enclosingOpenTag(Parser parser) {
    for (RuleContext ctx = parser.getContext(); ctx != null; ctx = ctx.parent) {
      String rule = parser.getRuleNames()[ctx.getRuleIndex()];
      switch (rule) {
        case "dataElement" -> {
          return "data";
        }
        case "mapElement" -> {
          return "map";
        }
        case "openCloseElement" -> {
          // `openCloseElement : LT name=NAME attr* GT content endTag=END_TAG`
          Token named = ((TDCParser.OpenCloseElementContext) ctx).name;
          return named == null || named.getText().isEmpty() ? null : named.getText();
        }
        default -> {
          // Not a tag-opening rule; keep walking out.
        }
      }
    }
    return null;
  }
}
