/**
 * Job model + JobContext threaded through every orchestrator step.
 *
 * `JobContext` is the only argument every generator/step receives. Adding a
 * new cross-cutting capability (telemetry, cost tracking) means extending this
 * type — keep it small.
 */
export {};
