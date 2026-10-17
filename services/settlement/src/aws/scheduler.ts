// Step Functions twin of TickScheduler (Kiro task 9). Each job is one Standard execution:
// Wait (TimestampPath $.fireAt) -> SQS SendMessage($.job). The host long-polls the queue, so it
// needs no inbound endpoint, and a job still fires if the host restarted in between.
import { SFNClient, StartExecutionCommand, StopExecutionCommand } from "@aws-sdk/client-sfn";
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { newId, type ScheduledJob, type Scheduler } from "../infra.ts";

export class StepFunctionsScheduler implements Scheduler {
  private jobs = new Map<string, ScheduledJob>();
  private arns = new Map<string, string>();
  private cancelled = new Set<string>();

  constructor(
    private readonly sfn: SFNClient,
    private readonly stateMachineArn: string,
    private readonly onError: (e: unknown) => void = (e) => console.error("scheduler:", e),
  ) {}

  schedule(job: Omit<ScheduledJob, "id">): string {
    const j: ScheduledJob = { ...job, id: newId("job") };
    this.jobs.set(j.id, j);
    const input = JSON.stringify({ fireAt: new Date(Math.max(j.at, Date.now())).toISOString(), job: j });
    this.sfn
      .send(new StartExecutionCommand({ stateMachineArn: this.stateMachineArn, name: j.id, input }))
      .then((r) => {
        this.arns.set(j.id, r.executionArn!);
        if (this.cancelled.has(j.id)) void this.stop(j.id); // cancelled before the start returned
      })
      .catch(this.onError);
    return j.id;
  }

  cancelFor(dealId: string, kind?: ScheduledJob["kind"]): void {
    for (const j of [...this.jobs.values()]) {
      if (j.dealId !== dealId || (kind !== undefined && j.kind !== kind)) continue;
      this.jobs.delete(j.id);
      this.cancelled.add(j.id);
      if (this.arns.has(j.id)) void this.stop(j.id);
    }
  }

  pending(): ScheduledJob[] {
    return [...this.jobs.values()].sort((a, b) => a.at - b.at);
  }

  /** A delivered job runs unless it was cancelled here (a stopped execution never delivers). */
  accept(job: ScheduledJob): boolean {
    this.jobs.delete(job.id);
    this.arns.delete(job.id);
    return !this.cancelled.delete(job.id);
  }

  private async stop(id: string) {
    const arn = this.arns.get(id);
    if (!arn) return;
    this.arns.delete(id);
    await this.sfn.send(new StopExecutionCommand({ executionArn: arn, cause: "cancelled by Settlement" })).catch(this.onError);
  }
}

/** Long-poll the job queue and hand each delivered job to Settlement. Stops when `signal` aborts. */
export async function pollJobs(opts: {
  sqs: SQSClient;
  queueUrl: string;
  scheduler: StepFunctionsScheduler;
  handle: (job: ScheduledJob) => Promise<void>;
  signal: AbortSignal;
  onError?: (e: unknown) => void;
}): Promise<void> {
  const onError = opts.onError ?? ((e) => console.error("job poller:", e));
  while (!opts.signal.aborted) {
    try {
      const r = await opts.sqs.send(new ReceiveMessageCommand({ QueueUrl: opts.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20 }), {
        abortSignal: opts.signal,
      });
      for (const m of r.Messages ?? []) {
        const job = JSON.parse(m.Body!) as ScheduledJob;
        if (opts.scheduler.accept(job)) await opts.handle(job).catch(onError);
        await opts.sqs.send(new DeleteMessageCommand({ QueueUrl: opts.queueUrl, ReceiptHandle: m.ReceiptHandle! }));
      }
    } catch (e) {
      if (opts.signal.aborted) return;
      onError(e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
