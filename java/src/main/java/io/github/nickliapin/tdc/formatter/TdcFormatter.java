package io.github.nickliapin.tdc.formatter;

import io.github.nickliapin.tdc.parser.PairedData;
import io.github.nickliapin.tdc.parser.generated.TDCLexer;
import io.github.nickliapin.tdc.parser.generated.TDCParser;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.antlr.v4.runtime.BaseErrorListener;
import org.antlr.v4.runtime.CharStreams;
import org.antlr.v4.runtime.CommonTokenStream;
import org.antlr.v4.runtime.RecognitionException;
import org.antlr.v4.runtime.Recognizer;
import org.antlr.v4.runtime.Token;

/**
 * Pretty-printer for {@code .tdc} documents.
 *
 * <p>Re-emits the parsed tree with consistent indentation, tidy attribute spacing, inline output
 * rows, and an aligned {@code <map>} table. Built to be SAFE: the formatted text must generate
 * byte-identical output to the original, which is what the tests check by rendering before and
 * after.
 *
 * <p>Preserved verbatim: {@code <data>} bodies (that is literal generator output), comments
 * reinjected from the token stream by position, and attribute order and values. Normalized:
 * indentation at four spaces a level, a single space between attributes, and {@code <map>} rows
 * on one line when short or as an aligned table when not.
 *
 * <p>A document with a syntax error is returned unchanged. Never reformat a file that cannot be
 * fully parsed — the output would be a guess about what the author meant.
 *
 * <p>Ported from {@code typescript/src/formatter/format.ts}. The three implementations must
 * produce the same bytes: a team using two of them would otherwise get a formatting diff on every
 * commit, which is exactly the churn a formatter exists to end.
 */
public final class TdcFormatter {

  private TdcFormatter() {}

  private static final String INDENT = "    ";

  /** Tags whose children always go on their own indented lines. */
  private static final Set<String> BLOCK_TAGS =
      Set.of(
          "tdc", "env", "block", "sequence", "mix", "switch", "distinct", "uniq",
          "before", "after", "before_block", "after_block", "delimiter_block",
          "before_line", "after_line", "delimiter_line");

  /** Longest an inlined element may be before it wraps. */
  private static final int INLINE_MAX = 100;

  /** Longest a one-line {@code <map>} may be before it becomes a table. */
  private static final int MAP_INLINE_MAX = 72;

  private record Comment(int position, String text) {}

  private static final class Context {
    final List<String> lines = new ArrayList<>();
    final List<Comment> comments = new ArrayList<>();
    int index;
  }

  /** A formatted config, or the source unchanged when it does not parse. */
  public static String format(String source) {
    PairedData.Rewrite rewritten = PairedData.preprocess(source);
    TDCLexer lexer = new TDCLexer(CharStreams.fromString(rewritten.source()));
    CommonTokenStream tokens = new CommonTokenStream(lexer);
    TDCParser parser = new TDCParser(tokens);

    List<String> problems = new ArrayList<>();
    BaseErrorListener fail =
        new BaseErrorListener() {
          @Override
          public void syntaxError(
              Recognizer<?, ?> recognizer, Object offending, int line, int column,
              String message, RecognitionException e) {
            problems.add(message);
          }
        };
    lexer.removeErrorListeners();
    lexer.addErrorListener(fail);
    parser.removeErrorListeners();
    parser.addErrorListener(fail);

    TDCParser.DocumentContext tree = parser.document();
    if (!problems.isEmpty() || !rewritten.problems().isEmpty()) {
      return source;
    }

    Context context = new Context();
    tokens.fill();
    for (Token token : tokens.getTokens()) {
      if (token.getType() == TDCLexer.COMMENT) {
        context.comments.add(
            new Comment(token.getStartIndex(), token.getText() == null ? "" : token.getText().trim()));
      }
    }

    for (TDCParser.ElementContext element : tree.element()) {
      flushCommentsBefore(start(element), 0, context);
      emitElement(element, 0, context);
    }
    flushCommentsBefore(Integer.MAX_VALUE, 0, context);

    return String.join("\n", context.lines) + "\n";
  }

  private static int start(org.antlr.v4.runtime.ParserRuleContext node) {
    return node.getStart() == null ? 0 : node.getStart().getStartIndex();
  }

  private static void flushCommentsBefore(int position, int depth, Context context) {
    while (context.index < context.comments.size()) {
      Comment comment = context.comments.get(context.index);
      if (comment.position() >= position) {
        break;
      }
      context.lines.add(INDENT.repeat(depth) + comment.text());
      context.index++;
    }
  }

  private static void emitElement(TDCParser.ElementContext element, int depth, Context context) {
    if (element.mapElement() != null) {
      emitMap(element.mapElement(), depth, context);
      return;
    }
    if (element.dataElement() != null) {
      context.lines.add(INDENT.repeat(depth) + dataString(element.dataElement()));
      return;
    }
    if (element.selfClosingElement() != null) {
      TDCParser.SelfClosingElementContext self = element.selfClosingElement();
      context.lines.add(
          INDENT.repeat(depth) + "<" + self.name.getText() + attrString(self) + "/>");
      return;
    }
    if (element.openCloseElement() != null) {
      emitOpen(element.openCloseElement(), depth, context);
    }
  }

  private static void emitOpen(
      TDCParser.OpenCloseElementContext node, int depth, Context context) {
    String name = node.name.getText();
    String openTag = "<" + name + attrString(node) + ">";
    List<TDCParser.ElementContext> children = children(node.content());
    String pad = INDENT.repeat(depth);

    if (children.isEmpty()) {
      context.lines.add(pad + openTag + "</" + name + ">");
      return;
    }

    String inline =
        !BLOCK_TAGS.contains(name) && !hasCommentWithin(node, context) ? tryInlineOpen(node) : null;
    if (inline != null && (pad + inline).length() <= INLINE_MAX) {
      context.lines.add(pad + inline);
      return;
    }

    context.lines.add(pad + openTag);
    for (TDCParser.ElementContext child : children) {
      flushCommentsBefore(start(child), depth + 1, context);
      emitElement(child, depth + 1, context);
    }
    context.lines.add(pad + "</" + name + ">");
  }

  private static List<TDCParser.ElementContext> children(TDCParser.ContentContext content) {
    return content == null ? List.of() : content.element();
  }

  /** One-line rendering, or null when the element must span several. */
  private static String tryInline(TDCParser.ElementContext element) {
    if (element.mapElement() != null) {
      return inlineMap(element.mapElement());
    }
    if (element.dataElement() != null) {
      return dataString(element.dataElement());
    }
    if (element.selfClosingElement() != null) {
      TDCParser.SelfClosingElementContext self = element.selfClosingElement();
      return "<" + self.name.getText() + attrString(self) + "/>";
    }
    return element.openCloseElement() == null ? "" : tryInlineOpen(element.openCloseElement());
  }

  private static String tryInlineOpen(TDCParser.OpenCloseElementContext node) {
    String name = node.name.getText();
    if (BLOCK_TAGS.contains(name)) {
      return null;
    }
    String openTag = "<" + name + attrString(node) + ">";
    List<TDCParser.ElementContext> children = children(node.content());
    if (children.isEmpty()) {
      return openTag + "</" + name + ">";
    }

    StringBuilder inner = new StringBuilder();
    for (TDCParser.ElementContext child : children) {
      String part = tryInline(child);
      if (part == null) {
        return null;
      }
      inner.append(part);
    }
    return openTag + inner + "</" + name + ">";
  }

  // ── <data> ───────────────────────────────────────────────────────────────────────────────

  private static String dataString(TDCParser.DataElementContext node) {
    String attrs = attrString(node);
    TDCParser.DataContentContext content = dataContent(node);
    if (content == null) {
      // A self-closing <data …/> has no body.
      return "<data" + attrs + "/>";
    }
    String pair = attrMap(node).get("pair");
    String close = pair != null ? "</data pair=\"" + pair + "\">" : "</data>";
    return "<data" + attrs + ">" + PairedData.restore(content.getText()) + close;
  }

  private static TDCParser.DataContentContext dataContent(TDCParser.DataElementContext node) {
    try {
      return (TDCParser.DataContentContext)
          node.getClass().getMethod("dataContent").invoke(node);
    } catch (ReflectiveOperationException | ClassCastException e) {
      return null;
    }
  }

  // ── <map> ────────────────────────────────────────────────────────────────────────────────

  private record Row(String keys, String value) {}

  private static List<Row> mapRows(TDCParser.MapElementContext node) {
    TDCParser.MapContentContext content;
    try {
      content = (TDCParser.MapContentContext) node.getClass().getMethod("mapContent").invoke(node);
    } catch (ReflectiveOperationException | ClassCastException e) {
      return List.of();
    }
    if (content == null) {
      return List.of();
    }

    List<Row> rows = new ArrayList<>();
    for (String raw : content.getText().split(",", -1)) {
      String row = raw.trim();
      if (row.isEmpty()) {
        continue;
      }
      int colon = row.indexOf(':');
      if (colon < 0) {
        continue;
      }
      List<String> keys = new ArrayList<>();
      for (String part : row.substring(0, colon).split("\\|", -1)) {
        if (!part.trim().isEmpty()) {
          keys.add(part.trim());
        }
      }
      if (keys.isEmpty()) {
        continue;
      }
      rows.add(new Row(String.join("|", keys), row.substring(colon + 1).trim()));
    }
    return rows;
  }

  private static String inlineMap(TDCParser.MapElementContext node) {
    List<String> parts = new ArrayList<>();
    for (Row row : mapRows(node)) {
      parts.add(row.keys() + ":" + row.value());
    }
    return "<map" + attrString(node) + ">" + String.join(", ", parts) + "</map>";
  }

  private static void emitMap(TDCParser.MapElementContext node, int depth, Context context) {
    String pad = INDENT.repeat(depth);
    List<Row> rows = mapRows(node);
    if (rows.isEmpty()) {
      context.lines.add(pad + "<map" + attrString(node) + "></map>");
      return;
    }

    String inline = inlineMap(node);
    if (rows.size() <= 1 || (pad + inline).length() <= MAP_INLINE_MAX) {
      context.lines.add(pad + inline);
      return;
    }

    // An aligned table: keys padded to the widest, a " : " separator, and a trailing comma on all
    // but the last row — the map reader splits on commas.
    int width = 0;
    for (Row row : rows) {
      width = Math.max(width, row.keys().length());
    }
    context.lines.add(pad + "<map" + attrString(node) + ">");
    for (int i = 0; i < rows.size(); i++) {
      Row row = rows.get(i);
      String comma = i < rows.size() - 1 ? "," : "";
      context.lines.add(
          pad + INDENT + padRight(row.keys(), width) + " : " + row.value() + comma);
    }
    context.lines.add(pad + "</map>");
  }

  private static String padRight(String text, int width) {
    return text.length() >= width ? text : text + " ".repeat(width - text.length());
  }

  // ── attributes and comments ──────────────────────────────────────────────────────────────

  @SuppressWarnings("unchecked")
  private static List<TDCParser.AttrContext> attrList(Object node) {
    try {
      return (List<TDCParser.AttrContext>) node.getClass().getMethod("attr").invoke(node);
    } catch (ReflectiveOperationException | ClassCastException e) {
      return List.of();
    }
  }

  private static Map<String, String> attrMap(Object node) {
    Map<String, String> out = new LinkedHashMap<>();
    for (TDCParser.AttrContext attr : attrList(node)) {
      if (attr.attrName == null) {
        continue;
      }
      String value = attr.attrValue == null ? "" : attr.attrValue.getText();
      if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
        value = value.substring(1, value.length() - 1);
      }
      out.put(attr.attrName.getText(), value);
    }
    return out;
  }

  private static String attrString(Object node) {
    StringBuilder out = new StringBuilder();
    for (Map.Entry<String, String> entry : attrMap(node).entrySet()) {
      if (!entry.getKey().isEmpty()) {
        out.append(' ').append(entry.getKey()).append("=\"").append(entry.getValue()).append('"');
      }
    }
    return out.toString();
  }

  private static boolean hasCommentWithin(
      org.antlr.v4.runtime.ParserRuleContext node, Context context) {
    int from = node.getStart() == null ? 0 : node.getStart().getStartIndex();
    int to = node.getStop() == null ? from : node.getStop().getStopIndex();
    for (Comment comment : context.comments) {
      if (comment.position() > from && comment.position() < to) {
        return true;
      }
    }
    return false;
  }
}
