package io.github.nickliapin.tdc.quick;

/** Raised for anything the quick API can explain better than the engine can. */
public final class TdcQuickException extends RuntimeException {

  private static final long serialVersionUID = 1L;

  public TdcQuickException(String message) {
    super(message);
  }
}
