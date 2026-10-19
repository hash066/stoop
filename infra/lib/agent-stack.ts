// StoopAgentStack: the negotiating agent on Amazon Bedrock AgentCore Runtime.
//   - code deployment (Node 22): services/negotiator-runtime/dist (one bundled file) as a CDK asset
//   - an execution role that can call Nova on Bedrock and write its logs and traces, nothing else
//   - the hosted sites' instance role may invoke this runtime (and only this one)
// The agent reaches a shop only through that shop's negotiation port with a one-time grant, so this
// role needs no access to Stoop's data at all.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import type { Construct } from "constructs";

export interface AgentStackProps extends StackProps {
  /** The hosted sites' instance role (StoopHostStack), allowed to invoke the runtime. */
  hostRoleName?: string;
}

const here = fileURLToPath(new URL(".", import.meta.url));

export class AgentStack extends Stack {
  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    const code = new s3assets.Asset(this, "NegotiatorCode", { path: join(here, "../../services/negotiator-runtime/dist") });

    const role = new iam.Role(this, "RuntimeRole", {
      description: "Stoop negotiator on AgentCore Runtime: Nova on Bedrock, its own logs and traces",
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` },
        },
      }),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"],
        resources: ["arn:aws:bedrock:*::foundation-model/amazon.nova-*", `arn:aws:bedrock:*:${this.account}:inference-profile/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:DescribeLogGroups"],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`, `arn:aws:logs:${this.region}:${this.account}:log-group:*`],
      }),
    );
    role.addToPolicy(new iam.PolicyStatement({ actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"], resources: ["*"] }));
    role.addToPolicy(
      new iam.PolicyStatement({ actions: ["cloudwatch:PutMetricData"], resources: ["*"], conditions: { StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } } }),
    );
    code.grantRead(role);

    const runtime = new agentcore.CfnRuntime(this, "Negotiator", {
      agentRuntimeName: "stoop_negotiator",
      description: "Stoop's negotiating agent (Strands, Nova 2 Lite). Talks to a shop only through its one-time negotiation port.",
      roleArn: role.roleArn,
      networkConfiguration: { networkMode: "PUBLIC" },
      agentRuntimeArtifact: {
        codeConfiguration: {
          code: { s3: { bucket: code.s3BucketName, prefix: code.s3ObjectKey } },
          runtime: "NODE_22",
          entryPoint: ["server.js"],
        },
      },
      environmentVariables: {
        LLM_MODE: "bedrock",
        // the shop counts each turn against its own daily cap before calling; this is a backstop
        LLM_DAILY_CALL_CAP: "6000",
      },
    });
    runtime.node.addDependency(role);

    if (props.hostRoleName) {
      iam.Role.fromRoleName(this, "HostRole", props.hostRoleName).addToPrincipalPolicy(
        new iam.PolicyStatement({ actions: ["bedrock-agentcore:InvokeAgentRuntime"], resources: [runtime.attrAgentRuntimeArn, `${runtime.attrAgentRuntimeArn}/*`] }),
      );
    }

    new CfnOutput(this, "NegotiatorRuntimeArn", { value: runtime.attrAgentRuntimeArn });
  }
}
