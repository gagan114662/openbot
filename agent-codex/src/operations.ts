export type RunPermit = { startedAt: number };

type PersistedUsage = { day: string; runs: number };

export class AdapterOperations {
  private readonly durationBuckets = [
    1_000, 5_000, 15_000, 30_000, 60_000, 120_000,
  ];
  private readonly durationBucketCounts = new Map<number, number>();
  private active = 0;
  private total = 0;
  private completed = 0;
  private errors = 0;
  private refusals = 0;
  private toolCalls = 0;
  private durationMs = 0;
  private usage: PersistedUsage = { day: this.today(), runs: 0 };

  constructor(
    readonly dailyBudget: number,
    readonly maxConcurrent: number,
    private readonly stateFile?: string,
    readonly deploymentId = "local",
  ) {}

  private today(now = new Date()): string {
    return now.toISOString().slice(0, 10);
  }

  async load(): Promise<void> {
    if (!this.stateFile || !(await Bun.file(this.stateFile).exists())) return;
    try {
      const value = (await Bun.file(this.stateFile).json()) as PersistedUsage;
      if (typeof value.day === "string" && Number.isInteger(value.runs)) {
        this.usage =
          value.day === this.today() ? value : { day: this.today(), runs: 0 };
      }
    } catch {
      throw new Error(
        "Codex usage state is unreadable; refusing to lose the budget boundary",
      );
    }
  }

  private async persist(): Promise<void> {
    if (!this.stateFile) return;
    await Bun.write(this.stateFile, `${JSON.stringify(this.usage)}\n`, {
      mode: 0o600,
    });
  }

  async begin(): Promise<RunPermit | { refused: string }> {
    const day = this.today();
    if (this.usage.day !== day) this.usage = { day, runs: 0 };
    if (this.active >= this.maxConcurrent) {
      this.refusals += 1;
      return {
        refused: `The tenant concurrency limit of ${this.maxConcurrent} runs is active.`,
      };
    }
    if (this.dailyBudget > 0 && this.usage.runs >= this.dailyBudget) {
      this.refusals += 1;
      return {
        refused: `The tenant daily budget of ${this.dailyBudget} runs is exhausted.`,
      };
    }
    this.active += 1;
    this.total += 1;
    this.usage.runs += 1;
    await this.persist();
    return { startedAt: Date.now() };
  }

  finish(permit: RunPermit, succeeded: boolean): void {
    this.active = Math.max(0, this.active - 1);
    const duration = Math.max(0, Date.now() - permit.startedAt);
    this.durationMs += duration;
    for (const bucket of this.durationBuckets) {
      if (duration <= bucket) {
        this.durationBucketCounts.set(
          bucket,
          (this.durationBucketCounts.get(bucket) ?? 0) + 1,
        );
      }
    }
    if (succeeded) this.completed += 1;
    else this.errors += 1;
  }

  recordToolCall(refused: boolean): void {
    this.toolCalls += 1;
    if (refused) this.refusals += 1;
  }

  snapshot() {
    return {
      active: this.active,
      total: this.total,
      completed: this.completed,
      errors: this.errors,
      refusals: this.refusals,
      toolCalls: this.toolCalls,
      durationMs: this.durationMs,
      dailyRuns: this.usage.runs,
      dailyBudget: this.dailyBudget,
      maxConcurrent: this.maxConcurrent,
    };
  }

  prometheus(): string {
    const m = this.snapshot();
    const escapedDeployment = this.deploymentId
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\n", "\\n");
    const labels = `{deployment="${escapedDeployment}"}`;
    const lines: Array<[string, number]> = [
      ["openbot_codex_runs_total", m.total],
      ["openbot_codex_runs_completed_total", m.completed],
      ["openbot_codex_run_errors_total", m.errors],
      ["openbot_codex_refusals_total", m.refusals],
      ["openbot_codex_tool_calls_total", m.toolCalls],
      ["openbot_codex_run_duration_milliseconds_total", m.durationMs],
      ["openbot_codex_active_runs", m.active],
      ["openbot_codex_daily_runs", m.dailyRuns],
      ["openbot_codex_daily_run_budget", m.dailyBudget],
      ["openbot_codex_max_concurrent_runs", m.maxConcurrent],
    ];
    const histogram = this.durationBuckets.map(
      (bucket) =>
        `openbot_codex_run_duration_milliseconds_bucket{deployment="${escapedDeployment}",le="${bucket}"} ${this.durationBucketCounts.get(bucket) ?? 0}`,
    );
    histogram.push(
      `openbot_codex_run_duration_milliseconds_bucket{deployment="${escapedDeployment}",le="+Inf"} ${m.completed + m.errors}`,
      `openbot_codex_run_duration_milliseconds_count${labels} ${m.completed + m.errors}`,
      `openbot_codex_run_duration_milliseconds_sum${labels} ${m.durationMs}`,
    );
    return `${lines.map(([name, value]) => `${name}${labels} ${value}`).join("\n")}\n${histogram.join("\n")}\n`;
  }
}
