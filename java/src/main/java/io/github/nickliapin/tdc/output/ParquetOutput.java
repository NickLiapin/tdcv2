package io.github.nickliapin.tdc.output;

import io.github.nickliapin.tdc.engine.RowSource;
import io.github.nickliapin.tdc.format.Interpolate;
import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.output.parquet.Convert;
import io.github.nickliapin.tdc.output.parquet.Writer;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * A run written as a typed binary file instead of as text.
 *
 * <p>The same preparation as the text renderer — one engine, one registry — so a config exported
 * to Parquet holds exactly the data it would have printed for that seed. Only the serialisation
 * differs: instead of formatting a record, each named {@code <data>} becomes a typed column.
 *
 * <p>Rows go out in row groups, each built, written and released before the next one starts, so
 * memory stays bounded however large the run is.
 */
public final class ParquetOutput {

  /**
   * Rows per row group.
   *
   * <p>Bounds peak memory and lets a reader skip whole groups. It is also the unit parallel
   * generation would split on, because a group's bytes do not depend on where it sits in the file.
   */
  public static final int ROW_GROUP_ROWS = 50_000;

  /** An untyped column is text. Never guess from the values — a string never corrupts data. */
  private static final ColumnType DEFAULT_TYPE = ColumnType.parse("string");

  private ParquetOutput() {}

  /** Write the run to a sink as a {@code .parquet} file. */
  public static void write(Config config, RowSource rows, OutputStream out) {
    Plan plan = plan(config);
    Writer.write(plan.columns, batches(plan, config, rows), out);
  }

  /** The same, in memory — for a small output and for tests. */
  public static byte[] toBytes(Config config, RowSource rows) {
    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    write(config, rows, out);
    return out.toByteArray();
  }

  /** The resolved schema, for telling the user which types were chosen. */
  public static List<Writer.Column> schemaOf(Config config) {
    return plan(config).columns;
  }

  /** Everything decided before a single row is rendered. */
  private record Plan(
      List<Columns.Declared> declared,
      List<Writer.Column> columns,
      List<ColumnType> types,
      List<String> separators) {}

  private static Plan plan(Config config) {
    List<Columns.Declared> declared = new ArrayList<>();
    for (Config.Line line : config.block()) {
      for (Config.DataPart part : line.parts()) {
        String name = part.name() == null ? null : part.name().trim();
        if (name == null || name.isEmpty()) {
          continue; // decorative text, not a column
        }
        ColumnType type = null;
        if (part.type() != null) {
          try {
            type = ColumnType.parseOutput(part.type());
          } catch (RuntimeException e) {
            throw new IllegalArgumentException("column \"" + name + "\": " + e.getMessage(), e);
          }
        }
        declared.add(new Columns.Declared(name, part.text(), type));
      }
    }
    if (declared.isEmpty()) {
      throw new IllegalArgumentException(
          "Parquet output needs at least one named column — add name=\"…\" to a <data> in the <block>");
    }
    Columns.checkUnique(declared);

    List<ColumnType> types = new ArrayList<>(declared.size());
    List<String> separators = new ArrayList<>(declared.size());
    List<Writer.Column> columns = new ArrayList<>(declared.size());
    for (Columns.Declared column : declared) {
      ColumnType type = Columns.resolve(column, config);
      if (type == null) {
        type = DEFAULT_TYPE;
      }
      types.add(type);
      // A declared []T needs a separator too; a comma when the column was typed by hand rather
      // than derived from a repeating generator.
      if (type.isList()) {
        String source = Columns.soleReference(column.template(), config.inject());
        String separator = source == null ? null : Columns.separatorOf(source, config);
        separators.add(separator == null ? "," : separator);
      } else {
        separators.add(null);
      }
      columns.add(new Writer.Column(column.name(), type));
    }
    return new Plan(declared, columns, types, separators);
  }

  private static Writer.Batches batches(Plan plan, Config config, RowSource rows) {
    int count = rows.count();
    return new Writer.Batches() {
      private int start;

      @Override
      public List<List<Writer.Cell>> next() {
        if (start >= count) {
          return null;
        }
        int end = Math.min(start + ROW_GROUP_ROWS, count);
        List<List<Writer.Cell>> batch = new ArrayList<>(plan.columns.size());
        for (int i = 0; i < plan.columns.size(); i++) {
          batch.add(new ArrayList<>(end - start));
        }

        for (int row = start; row < end; row++) {
          for (int i = 0; i < plan.declared.size(); i++) {
            Columns.Declared column = plan.declared.get(i);
            String text =
                Interpolate.apply(column.template(), config.inject(), lookup(rows, row));
            ColumnType type = plan.types.get(i);
            try {
              if (type.isList()) {
                // An empty cell is an EMPTY LIST, not a list holding one blank — splitting ""
                // on a comma would otherwise conjure a phantom element.
                batch
                    .get(i)
                    .add(
                        new Writer.Elements(
                            text.isEmpty() ? List.of() : split(text, plan.separators.get(i))));
              } else {
                batch.get(i).add(new Writer.Scalar(Convert.value(text, type)));
              }
            } catch (RuntimeException e) {
              throw new IllegalArgumentException(
                  "column \"" + column.name() + "\", row " + (row + 1) + ": " + e.getMessage(), e);
            }
          }
        }
        start = end;
        return batch;
      }
    };
  }

  private static Interpolate.Lookup lookup(RowSource rows, int row) {
    return new Interpolate.Lookup() {
      @Override
      public boolean has(String name) {
        return rows.value(name, row) != null || rows.sequenceNames().contains(name);
      }

      @Override
      public String value(String name) {
        String v = rows.value(name, row);
        return v == null ? "" : v;
      }
    };
  }

  /** A literal split, not a regular expression — the separator is a piece of data. */
  private static List<String> split(String text, String separator) {
    List<String> out = new ArrayList<>();
    int at = 0;
    while (true) {
      int next = text.indexOf(separator, at);
      if (next < 0) {
        out.add(text.substring(at));
        return out;
      }
      out.add(text.substring(at, next));
      at = next + separator.length();
    }
  }
}
