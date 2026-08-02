package io.github.nickliapin.tdc.compute;

/** A compute tree that could not be evaluated. Structural mistakes are caught by the validator. */
public class ComputeError extends RuntimeException {

    private static final long serialVersionUID = 1L;

  public ComputeError(String message) {
    super(message);
  }
}
