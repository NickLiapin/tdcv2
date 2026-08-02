package io.github.nickliapin.tdc.parser;

import io.github.nickliapin.tdc.parser.generated.TDCLexer;
import io.github.nickliapin.tdc.parser.generated.TDCParser;
import java.util.ArrayList;
import java.util.List;
import org.antlr.v4.runtime.BaseErrorListener;
import org.antlr.v4.runtime.CharStreams;
import org.antlr.v4.runtime.CommonTokenStream;
import org.antlr.v4.runtime.RecognitionException;
import org.antlr.v4.runtime.Recognizer;

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

  /** Parse a config, collecting syntax errors rather than printing them. */
  public static Result parse(String source) {
    List<SyntaxProblem> problems = new ArrayList<>();
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
            problems.add(new SyntaxProblem(line, charPositionInLine, msg));
          }
        };

    TDCLexer lexer = new TDCLexer(CharStreams.fromString(normalize(source)));
    lexer.removeErrorListeners();
    lexer.addErrorListener(collector);

    TDCParser parser = new TDCParser(new CommonTokenStream(lexer));
    parser.removeErrorListeners();
    parser.addErrorListener(collector);
    parser.addParseListener(new DepthGuard());

    try {
      return new Result(parser.document(), List.copyOf(problems));
    } catch (ElementDepthException refusal) {
      // Past the ceiling there is no tree worth building — parsing it IS the
      // danger. Callers get what garbage input gets: an empty document plus
      // the problem that explains it.
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
   * Normalize paired raw text before lexing.
   *
   * <p>The grammar keeps a single static {@code </data>} close token, which cannot express
   * {@code <data pair="X">…</data pair="X">} where the body may itself contain a literal
   * {@code </data>}. The reference implementation rewrites the closing tag before lexing, and
   * a port has to do the same or the two will disagree on any config using pairs.
   *
   * <p>Not yet implemented — no fixture in the golden set uses paired raw text, and guessing
   * at the rewrite would be worse than leaving it visible. Tracked against the fixtures that
   * do exercise it.
   */
  private static String normalize(String source) {
    return source;
  }
}
