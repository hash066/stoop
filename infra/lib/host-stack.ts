// StoopHostStack: the public tester site and the judge site, behind CloudFront (HTTPS, no domain
// needed). One small instance builds the Docker image from the public GitHub repo at boot and
// runs two containers:
//   :8080  public  - the Stoop web app for testers: real shops, live models (Nova 2 Lite) under a daily cap
//   :8081  judge   - the same app plus the Alexa+ device tour, live models under its own daily cap
// Shops live in memory: replacing a container closes them.
// Feedback goes to /opt/stoop-data/feedback.jsonl; GET /api/feedback.jsonl?key=<AdminKey secret>.
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

export interface HostStackProps extends StackProps {
  repoUrl: string;
  branch?: string;
  /** Where budget alerts go. Passed in at deploy time (STOOP_BUDGET_EMAIL) so it never lands in git. */
  budgetEmail?: string;
  /** Monthly spending cap in USD (default 30). */
  monthlyCapUsd?: number;
  /** Paid model-call units per day on the judge site (default 1000). */
  judgeDailyModelCalls?: number;
  /** Paid model-call units per day on the public tester site (default 1500). */
  publicDailyModelCalls?: number;
  /** The Stoop Alexa skill (amzn1.ask.skill.…) whose endpoint is the tester site's /alexa. */
  alexaSkillId?: string;
}

export class HostStack extends Stack {
  constructor(scope: Construct, id: string, props: HostStackProps) {
    super(scope, id, props);

    // Public subnets only and no NAT gateway: nothing here needs private networking.
    const vpc = new ec2.Vpc(this, "Vpc", { maxAzs: 1, natGateways: 0, subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC }] });
    const sg = new ec2.SecurityGroup(this, "Web", { vpc, description: "Stoop public (8080) and judge (8081) sites, reached through CloudFront" });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcpRange(8080, 8081), "CloudFront origin fetches");

    const adminKey = new secretsmanager.Secret(this, "AdminKey", {
      description: "Key for GET /api/feedback.jsonl on the Stoop sites",
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    adminKey.grantRead(role);
    // Both containers run the agents and vision on Bedrock
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: ["arn:aws:bedrock:*::foundation-model/amazon.nova-*", `arn:aws:bedrock:*:${this.account}:inference-profile/*`],
      }),
    );

    const branch = props.branch ?? "main";
    const run = (name: string, port: number, extra: string) =>
      // host networking: the judge container reaches the instance role via IMDS (hop limit 1)
      `docker run -d --name ${name} --restart always --network host -e PORT=${port} -e PUBLIC_PROTO=https -e ADMIN_KEY="$ADMIN_KEY" ${extra} -v /opt/stoop-data-${name}:/data stoop`;
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -euxo pipefail",
      // the image build (pnpm install + four Vite builds) wants more than 2 GB at its peak
      "fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile",
      "dnf install -y docker git",
      "systemctl enable --now docker",
      `git clone --depth 1 -b ${branch} ${props.repoUrl} /opt/stoop`,
      "docker build -t stoop /opt/stoop",
      `ADMIN_KEY=$(aws secretsmanager get-secret-value --region ${this.region} --secret-id ${adminKey.secretArn} --query SecretString --output text)`,
      "install -d -o 1000 -g 1000 /opt/stoop-data-public /opt/stoop-data-judge",
      run("public", 8080, `-e LLM_MODE=bedrock -e AWS_REGION=${this.region} -e MAX_SANDBOXES=20 -e MAX_SHOPS=80${props.alexaSkillId ? ` -e ALEXA_SKILL_ID=${props.alexaSkillId}` : ""} -e LLM_DAILY_CALL_CAP=${props.publicDailyModelCalls ?? 1500}`),
      run("judge", 8081, `-e LLM_MODE=bedrock -e AWS_REGION=${this.region} -e MAX_SANDBOXES=10 -e MAX_SHOPS=40 -e DEVICE_DEMO=1 -e LLM_DAILY_CALL_CAP=${props.judgeDailyModelCalls ?? 1000}`),
    );

    const instance = new ec2.Instance(this, "Host", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
      role,
      userData,
      requireImdsv2: true,
      blockDevices: [{ deviceName: "/dev/xvda", volume: ec2.BlockDeviceVolume.ebs(20, { volumeType: ec2.EbsDeviceVolumeType.GP3 }) }],
    });

    // CloudFront in front of each container: HTTPS, no caching, every header (incl. Authorization,
    // MCP session ids, Host) forwarded so MCP, SSE and the sandbox routing behave as on localhost.
    const site = (name: string, port: number, comment: string) =>
      new cloudfront.Distribution(this, name, {
        comment,
        defaultBehavior: {
          origin: new origins.HttpOrigin(instance.instancePublicDnsName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            httpPort: port,
            readTimeout: Duration.seconds(60),
            keepaliveTimeout: Duration.seconds(60),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
      });
    const pub = site("PublicSite", 8080, "Stoop: public sandboxes for testers");
    const judge = site("JudgeSite", 8081, "Stoop: judge sandboxes on Amazon Bedrock");

    // Spending guardrails. Inside the app: the judge site's daily model-call cap (instant). In AWS:
    // a monthly budget whose actions stop the instance and deny Bedrock at the cap (billing data
    // lags by hours, so this is the backstop, not the first line).
    if (props.budgetEmail) {
      const cap = props.monthlyCapUsd ?? 30;
      const subscribers = [{ subscriptionType: "EMAIL", address: props.budgetEmail }];
      const budget = new budgets.CfnBudget(this, "SpendCap", {
        budget: {
          budgetName: `stoop-cap-${cap}usd`,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: cap, unit: "USD" },
          costTypes: { includeCredit: false, includeRefund: false },
        },
        notificationsWithSubscribers: [50, 80, 100].map((threshold) => ({
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold, thresholdType: "PERCENTAGE" },
          subscribers,
        })),
      });
      const denyBedrock = new iam.ManagedPolicy(this, "SpendStop", {
        description: "Attached to the host role by the budget action at the spending cap",
        statements: [new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ["bedrock:*"], resources: ["*"] })],
      });
      // The role AWS Budgets assumes to act: stop this instance through SSM (managed policy), and
      // attach/detach exactly the deny policy, on exactly the host role.
      const actionsRole = new iam.Role(this, "BudgetActionsRole", {
        assumedBy: new iam.ServicePrincipal("budgets.amazonaws.com"),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AWSBudgetsActions_RolePolicyForResourceAdministrationWithSSM")],
      });
      actionsRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["iam:AttachRolePolicy", "iam:DetachRolePolicy"],
          resources: [role.roleArn],
          conditions: { ArnEquals: { "iam:PolicyARN": denyBedrock.managedPolicyArn } },
        }),
      );
      actionsRole.addToPolicy(
        new iam.PolicyStatement({ actions: ["iam:PassRole"], resources: [actionsRole.roleArn], conditions: { StringEquals: { "iam:PassedToService": "ssm.amazonaws.com" } } }),
      );
      const atCap = {
        budgetName: budget.ref,
        notificationType: "ACTUAL",
        actionThreshold: { type: "PERCENTAGE", value: 100 },
        approvalModel: "AUTOMATIC",
        executionRoleArn: actionsRole.roleArn,
        subscribers: [{ type: "EMAIL", address: props.budgetEmail }],
      };
      new budgets.CfnBudgetsAction(this, "StopHostAtCap", {
        ...atCap,
        actionType: "RUN_SSM_DOCUMENTS",
        definition: { ssmActionDefinition: { subtype: "STOP_EC2_INSTANCES", region: this.region, instanceIds: [instance.instanceId] } },
      });
      new budgets.CfnBudgetsAction(this, "DenyBedrockAtCap", {
        ...atCap,
        actionType: "APPLY_IAM_POLICY",
        definition: { iamActionDefinition: { policyArn: denyBedrock.managedPolicyArn, roles: [role.roleName] } },
      });
    }

    new CfnOutput(this, "PublicUrl", { value: `https://${pub.distributionDomainName}` });
    new CfnOutput(this, "JudgeUrl", { value: `https://${judge.distributionDomainName}` });
    new CfnOutput(this, "AdminKeySecretArn", { value: adminKey.secretArn });
    new CfnOutput(this, "InstanceId", { value: instance.instanceId });
  }
}
