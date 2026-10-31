/**
 * Logic engine package boundary (spec: "A logic package will own the pure
 * visibility/jump/variable engine. M0 creates the package boundary but
 * implements no rules.").
 *
 * The port below is the contract M1/M2 will implement. Nothing in M0 may call
 * `evaluate` on a real engine — the default factory refuses to run, so an
 * accidental dependency on logic behavior fails loudly.
 */

export interface VisibleBlock {
  readonly id: string;
  readonly kind: string;
  /** Question blocks produce answers; welcome/ending blocks do not. */
  readonly producesAnswer: boolean;
}

export interface LogicPort {
  /**
   * Returns the subset of `blocks` that should be visible for the given raw
   * answers. Implementations must be pure: no I/O, no clock, no randomness.
   */
  evaluate(
    blocks: readonly VisibleBlock[],
    answers: Readonly<Record<string, string>>,
  ): readonly string[];
}

export class LogicNotImplementedError extends Error {
  constructor() {
    super(
      "The logic engine is not implemented in M0 (port stub only; arrives in M1/M2).",
    );
    this.name = "LogicNotImplementedError";
  }
}

/** M0 factory: returns a port that refuses evaluation. */
export function createLogicEngine(): LogicPort {
  return {
    evaluate() {
      throw new LogicNotImplementedError();
    },
  };
}
