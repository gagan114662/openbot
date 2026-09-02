import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  applyProductionMonitorTuning,
  draftProductionFix,
  fetchProductionEngineer,
  fetchSoftwareFactory,
  fixAutomationMessage,
  type ProductionEngineerDashboard,
  recordProductionInvestigation,
  rejectProductionMonitorTuning,
  tuneProductionMonitor,
  tuningProposalFrom,
  updateProductionIssueStatus,
} from "@/lib/production-engineer/queries";

export const Route = createFileRoute("/_authed/admin/production-engineer")({
  component: ProductionEngineerPage,
});

function ProductionEngineerPage() {
  const [investigationIssueId, setInvestigationIssueId] = useState("");
  const [investigationSummary, setInvestigationSummary] = useState("");
  const [investigationOutcome, setInvestigationOutcome] = useState("");
  const [investigationApproved, setInvestigationApproved] = useState(false);
  const queryClient = useQueryClient();
  const dashboard = useQuery({
    queryKey: ["production-engineer"],
    queryFn: fetchProductionEngineer,
    // Draft fixes are accepted background jobs. Polling this small admin projection makes the
    // durable issue row—not an HTTP socket—the source of truth for running and terminal state.
    refetchInterval: 2_000,
  });
  const factory = useQuery({
    queryKey: ["software-factory"],
    queryFn: fetchSoftwareFactory,
    refetchInterval: 5_000,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["production-engineer"] });
  const tune = useMutation({
    mutationFn: tuneProductionMonitor,
    onSuccess: refresh,
  });
  const applyTuning = useMutation({
    mutationFn: applyProductionMonitorTuning,
    onSuccess: refresh,
  });
  const rejectTuning = useMutation({
    mutationFn: rejectProductionMonitorTuning,
    onSuccess: refresh,
  });
  const fix = useMutation({
    mutationFn: draftProductionFix,
    onSuccess: refresh,
  });
  const investigation = useMutation({
    mutationFn: recordProductionInvestigation,
    onSuccess: () => {
      setInvestigationSummary("");
      setInvestigationOutcome("");
      setInvestigationApproved(false);
      return refresh();
    },
  });
  const issueStatus = useMutation({
    mutationFn: updateProductionIssueStatus,
    onSuccess: refresh,
  });
  const selectedInvestigationIssue =
    investigationIssueId || dashboard.data?.issues[0]?.id || "";
  return (
    <PageShell
      action={
        <Button
          render={<a href="/api/production-engineer/prometheus-rules" />}
          size="sm"
          variant="outline"
        >
          Export Prometheus rules
        </Button>
      }
      description="Persistent monitors, correlated alert triage, tuning proposals, reviewed on-call learning, and fix pull requests. Admin-only; fixes never target main directly."
      title="Production Engineer"
      width="wide"
    >
      <PageSection title="Software factory">
        <p className="mb-3 text-muted-foreground text-sm">
          Benchmark-routed managed agents use a judging orchestrator, bounded
          workers, and tenant-isolated graph context. Outcome cost feeds the
          next routing decision.
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          <FactoryCard
            label="Execution tiers"
            value={factory.data?.executionTiers.join(" → ") ?? "Loading…"}
          />
          <FactoryCard
            label="Managed jobs"
            value={factory.data?.managedJobKinds.join(", ") ?? "Loading…"}
          />
          <FactoryCard
            label="Context graph"
            value={
              factory.data
                ? `${factory.data.contextGraph.nodes} nodes · ${factory.data.contextGraph.edges} edges · ${factory.data.contextGraph.sourceSystems} systems`
                : "Loading…"
            }
          />
          <FactoryCard
            label="Benchmarked routes"
            value={`${factory.data?.benchmarks.length ?? 0} model/job configurations`}
          />
          <FactoryCard
            label="Managed executions"
            value={`${factory.data?.jobs.length ?? 0} durable jobs`}
          />
          <FactoryCard
            label="Webhook reconciler"
            value={
              factory.data?.webhooks
                ? `${factory.data.webhooks.pending} pending · ${factory.data.webhooks.processed} processed · ${factory.data.webhooks.dead} dead-letter`
                : "Unavailable"
            }
          />
          <FactoryCard
            label="Shadow traffic"
            value={
              factory.data?.shadowTraffic
                ? `${factory.data.shadowTraffic.completed} comparisons · ${(factory.data.shadowTraffic.averageAgreement / 100).toFixed(1)}% agreement · ${factory.data.shadowTraffic.averageLatencyMs} ms`
                : "Unavailable"
            }
          />
        </div>
      </PageSection>
      <PageSection title="Monitors">
        {(dashboard.data?.monitors.length ?? 0) === 0 ? (
          <PageEmpty>No merged-change monitors exist yet.</PageEmpty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {dashboard.data?.monitors.map((monitor) => (
              <MonitorCard
                key={monitor.id}
                monitor={monitor}
                applying={applyTuning.isPending}
                rejecting={rejectTuning.isPending}
                onApply={() => applyTuning.mutate(monitor.id)}
                onReject={() => rejectTuning.mutate(monitor.id)}
                onTune={() => tune.mutate(monitor.id)}
                tuning={tune.isPending}
              />
            ))}
          </div>
        )}
      </PageSection>
      {tune.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {tune.error.message}
        </p>
      ) : null}
      {applyTuning.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {applyTuning.error.message}
        </p>
      ) : null}
      {rejectTuning.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {rejectTuning.error.message}
        </p>
      ) : null}
      <PageSection title="Production issues">
        <p
          className="mb-3 text-muted-foreground text-sm"
          id="fix-automation-status"
          role="status"
        >
          {fixAutomationMessage(dashboard.data?.fixAutomationEnabled === true)}
        </p>
        {fix.isError ? (
          <p className="mb-3 text-destructive text-sm" role="alert">
            {fix.error.message}
          </p>
        ) : null}
        {(dashboard.data?.issues.length ?? 0) === 0 ? (
          <PageEmpty>No genuine firing alerts have opened an issue.</PageEmpty>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs uppercase">
                <tr>
                  <th className="px-4 py-2">Issue</th>
                  <th className="px-4 py-2">Severity</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Triage</th>
                  <th className="px-4 py-2">Fix</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.data?.issues.map((issue) => (
                  <tr className="border-border border-t" key={issue.id}>
                    <td className="px-4 py-2 font-medium">{issue.title}</td>
                    <td className="px-4 py-2">{issue.severity}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1">
                        <span>{issue.status}</span>
                        {issue.status === "open" ? (
                          <>
                            <Button
                              disabled={issueStatus.isPending}
                              onClick={() =>
                                issueStatus.mutate({
                                  issueId: issue.id,
                                  status: "resolved",
                                })
                              }
                              size="sm"
                              variant="ghost"
                            >
                              Resolve
                            </Button>
                            <Button
                              disabled={issueStatus.isPending}
                              onClick={() =>
                                issueStatus.mutate({
                                  issueId: issue.id,
                                  status: "dismissed",
                                })
                              }
                              size="sm"
                              variant="ghost"
                            >
                              Dismiss
                            </Button>
                          </>
                        ) : (
                          <Button
                            disabled={issueStatus.isPending}
                            onClick={() =>
                              issueStatus.mutate({
                                issueId: issue.id,
                                status: "open",
                              })
                            }
                            size="sm"
                            variant="ghost"
                          >
                            Reopen
                          </Button>
                        )}
                      </div>
                    </td>
                    <td className="max-w-xl px-4 py-2">{issue.rootCause}</td>
                    <td className="px-4 py-2">
                      {issue.pullRequestUrl ? (
                        <a className="underline" href={issue.pullRequestUrl}>
                          Open PR
                        </a>
                      ) : issue.fixStatus === "none" ||
                        issue.fixStatus === "failed" ? (
                        <Button
                          aria-describedby="fix-automation-status"
                          disabled={
                            !dashboard.data?.fixAutomationEnabled ||
                            fix.isPending
                          }
                          onClick={() => fix.mutate(issue.id)}
                          size="sm"
                          variant="outline"
                        >
                          {dashboard.data?.fixAutomationEnabled
                            ? issue.fixStatus === "failed"
                              ? "Retry draft fix"
                              : "Draft fix PR"
                            : "Fix automation off"}
                        </Button>
                      ) : issue.fixStatus === "review_required" ? (
                        <a className="underline" href="/admin/analytics">
                          Debt review required
                        </a>
                      ) : issue.fixStatus === "running" ? (
                        "Drafting…"
                      ) : (
                        issue.fixStatus
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageSection>
      <PageSection title="Reviewed on-call learning">
        <p className="text-muted-foreground text-sm">
          {dashboard.data?.investigations.filter((item) => item.approved)
            .length ?? 0}{" "}
          approved investigations are eligible for future triage context.
          Unreviewed notes are never learned.
        </p>
        {(dashboard.data?.issues.length ?? 0) > 0 ? (
          <div className="mt-4 grid max-w-3xl gap-3 rounded-lg border border-border bg-card p-4">
            <label className="grid gap-1 text-sm">
              Production issue
              <select
                className="h-9 rounded-md border border-input bg-background px-3"
                onChange={(event) =>
                  setInvestigationIssueId(event.target.value)
                }
                value={selectedInvestigationIssue}
              >
                {dashboard.data?.issues.map((issue) => (
                  <option key={issue.id} value={issue.id}>
                    {issue.title}
                  </option>
                ))}
              </select>
            </label>
            <Input
              aria-label="Investigation summary"
              onChange={(event) => setInvestigationSummary(event.target.value)}
              placeholder="What caused the alert?"
              value={investigationSummary}
            />
            <Input
              aria-label="Investigation outcome"
              onChange={(event) => setInvestigationOutcome(event.target.value)}
              placeholder="What resolved or disproved it?"
              value={investigationOutcome}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                checked={investigationApproved}
                onChange={(event) =>
                  setInvestigationApproved(event.target.checked)
                }
                type="checkbox"
              />
              Reviewed and approved for future triage context
            </label>
            <Button
              disabled={
                !selectedInvestigationIssue ||
                !investigationSummary.trim() ||
                !investigationOutcome.trim() ||
                investigation.isPending
              }
              onClick={() =>
                investigation.mutate({
                  issueId: selectedInvestigationIssue,
                  summary: investigationSummary.trim(),
                  outcome: investigationOutcome.trim(),
                  approved: investigationApproved,
                })
              }
              size="sm"
            >
              Save investigation
            </Button>
            {investigation.isError ? (
              <p className="text-destructive text-sm" role="alert">
                {investigation.error.message}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="mt-4 grid gap-2">
          {dashboard.data?.investigations.map((item) => (
            <div
              className="rounded-md border border-border p-3 text-sm"
              key={item.id}
            >
              <div className="font-medium">{item.summary}</div>
              <div className="text-muted-foreground">{item.outcome}</div>
              <div className="mt-1 text-muted-foreground text-xs uppercase">
                {item.approved ? "Approved learning" : "Unreviewed note"}
              </div>
            </div>
          ))}
        </div>
      </PageSection>
    </PageShell>
  );
}

function FactoryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="font-medium text-sm">{label}</p>
      <p className="mt-1 text-muted-foreground text-sm">{value}</p>
    </div>
  );
}

function MonitorCard({
  monitor,
  tuning,
  applying,
  rejecting,
  onTune,
  onApply,
  onReject,
}: {
  monitor: NonNullable<ProductionEngineerDashboard["monitors"]>[number];
  tuning: boolean;
  applying: boolean;
  rejecting: boolean;
  onTune: () => void;
  onApply: () => void;
  onReject: () => void;
}) {
  const proposal = tuningProposalFrom(monitor.tuningProposal);
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="font-medium">{monitor.title}</div>
      <div className="text-muted-foreground text-sm">
        {monitor.key} · baseline {monitor.baseline ?? "pending"} · threshold{" "}
        {monitor.threshold} · {monitor.firingCount} firings ·{" "}
        {monitor.falsePositiveCount} noise
      </div>
      {proposal ? (
        <div
          className="mt-3 rounded-md border border-border bg-muted/40 p-3 text-sm"
          role="status"
        >
          <div className="font-medium">
            Proposed threshold: {proposal.proposedThreshold}
          </div>
          <div className="text-muted-foreground">{proposal.reason}</div>
          <div className="mt-1 text-muted-foreground text-xs uppercase">
            {proposal.requiresApproval
              ? "Administrator approval required"
              : "No threshold change recommended"}
          </div>
        </div>
      ) : null}
      <Button
        className="mt-2"
        disabled={tuning}
        onClick={onTune}
        size="sm"
        variant="outline"
      >
        {proposal ? "Re-evaluate tuning" : "Propose tuning"}
      </Button>
      {proposal?.requiresApproval ? (
        <>
          <Button
            className="mt-2 ml-2"
            disabled={applying || rejecting}
            onClick={onApply}
            size="sm"
          >
            Apply proposed threshold
          </Button>
          <Button
            className="mt-2 ml-2"
            disabled={applying || rejecting}
            onClick={onReject}
            size="sm"
            variant="ghost"
          >
            Reject proposal
          </Button>
        </>
      ) : null}
    </div>
  );
}
