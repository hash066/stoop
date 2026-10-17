// StoopStack (Kiro task 10): the AWS twins of Settlement's local infrastructure.
//
//   Table          DynamoDB single table (pk, doc, ver, ttl)       <- DynamoStore, spent tokens
//   ReceiptKey     KMS ECC_NIST_P256 SIGN_VERIFY                    <- receipt signer (JWS ES256)
//   TokenMacKey    KMS HMAC_256                                     <- capability tokens
//   AddressKey     KMS symmetric; Decrypt ONLY by the Vault Lambda  <- the address boundary
//   VaultFunction  Lambda running services/settlement/src/aws/vault-lambda.ts
//   HandoffSaga    Step Functions Standard: Wait(TimestampPath) -> SQS  <- StepFunctionsScheduler
//   HostPolicy     what the host (MCP server, agents, Settlement) may do; never kms:Decrypt
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Must match ADDRESS_CONTEXT in services/settlement/src/aws/kms.ts. */
const ADDRESS_PURPOSE = "stoop-address";

export class StoopStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Hackathon stack: everything is disposable (`pnpm --filter @stoop/infra destroy`).
    const table = new dynamodb.Table(this, "Table", {
      tableName: "stoop",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const receiptKey = new kms.Key(this, "ReceiptKey", {
      alias: "alias/stoop-receipts",
      description: "Signs Proof-of-Handoff receipts (JWS ES256)",
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7),
    });
    const tokenMacKey = new kms.Key(this, "TokenMacKey", {
      alias: "alias/stoop-capability-tokens",
      description: "MACs single-use capability tokens bound to the terms a human approved",
      keySpec: kms.KeySpec.HMAC_256,
      keyUsage: kms.KeyUsage.GENERATE_VERIFY_MAC,
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7),
    });

    const vaultFn = new NodejsFunction(this, "VaultFunction", {
      functionName: "stoop-vault",
      description: "Address boundary: the only principal that can decrypt an address; re-checks R2 itself",
      entry: join(ROOT, "services/settlement/src/aws/vault-lambda.ts"),
      handler: "handler",
      projectRoot: ROOT,
      depsLockFilePath: join(ROOT, "pnpm-lock.yaml"),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup: new logs.LogGroup(this, "VaultLogs", { logGroupName: "/aws/lambda/stoop-vault", retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
      bundling: {
        format: OutputFormat.ESM,
        mainFields: ["module", "main"],
        minify: true,
        sourceMap: true,
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });

    // The address key's policy is the boundary. The account may administer the key and encrypt,
    // but there is no Decrypt for the account (so none for any IAM user or role, root included)
    // and no CreateGrant (no side door). Only the Vault Lambda's role decrypts, and only addresses.
    const addressKey = new kms.Key(this, "AddressKey", {
      alias: "alias/stoop-address-vault",
      description: "Encrypts household addresses; only the Vault Lambda can decrypt",
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7),
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: "AccountAdministersButCannotRead",
            principals: [new iam.AccountRootPrincipal()],
            actions: [
              "kms:CreateAlias", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*",
              "kms:Disable*", "kms:Get*", "kms:Delete*", "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion",
            ],
            resources: ["*"],
          }),
          new iam.PolicyStatement({
            sid: "AccountMayEncryptAddresses",
            principals: [new iam.AccountRootPrincipal()],
            actions: ["kms:Encrypt"],
            resources: ["*"],
            conditions: { StringEquals: { "kms:EncryptionContext:purpose": ADDRESS_PURPOSE } },
          }),
          new iam.PolicyStatement({
            sid: "OnlyTheVaultLambdaDecrypts",
            principals: [vaultFn.role!],
            actions: ["kms:Decrypt"],
            resources: ["*"],
            conditions: { StringEquals: { "kms:EncryptionContext:purpose": ADDRESS_PURPOSE } },
          }),
        ],
      }),
    });
    vaultFn.addEnvironment("TABLE_NAME", table.tableName);
    vaultFn.addEnvironment("VAULT_KEY_ID", addressKey.keyArn);
    table.grantReadData(vaultFn);

    // Saga timers: one Standard execution per job, Wait until it's due, then hand it to the host.
    const jobQueue = new sqs.Queue(this, "JobQueue", {
      queueName: "stoop-jobs",
      visibilityTimeout: Duration.seconds(60),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
    });
    const saga = new sfn.StateMachine(this, "HandoffSaga", {
      stateMachineName: "stoop-handoff-saga",
      stateMachineType: sfn.StateMachineType.STANDARD,
      comment: "Deal timers (window open/close, inspection, reservation, presence grace). Mirrors TickScheduler.",
      definitionBody: sfn.DefinitionBody.fromChainable(
        new sfn.Wait(this, "WaitUntilDue", { time: sfn.WaitTime.timestampPath("$.fireAt") }).next(
          new tasks.SqsSendMessage(this, "DeliverJob", { queue: jobQueue, messageBody: sfn.TaskInput.fromJsonPathAt("$.job") }),
        ),
      ),
      timeout: Duration.days(30),
    });

    // Everything the host process needs, and nothing that reads an address.
    const hostPolicy = new iam.ManagedPolicy(this, "HostPolicy", {
      managedPolicyName: "StoopHostPolicy",
      description: "Stoop host (MCP server, agents, Settlement): no kms:Decrypt on addresses",
      statements: [
        new iam.PolicyStatement({
          sid: "Bedrock",
          actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
          resources: ["arn:aws:bedrock:*::foundation-model/amazon.nova-*", `arn:aws:bedrock:*:${this.account}:inference-profile/*`],
        }),
        new iam.PolicyStatement({
          sid: "Store",
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:ConditionCheckItem"],
          resources: [table.tableArn],
        }),
        new iam.PolicyStatement({ sid: "EncryptAddresses", actions: ["kms:Encrypt"], resources: [addressKey.keyArn] }),
        new iam.PolicyStatement({ sid: "SignReceipts", actions: ["kms:Sign", "kms:GetPublicKey"], resources: [receiptKey.keyArn] }),
        new iam.PolicyStatement({ sid: "CapabilityTokens", actions: ["kms:GenerateMac", "kms:VerifyMac"], resources: [tokenMacKey.keyArn] }),
        new iam.PolicyStatement({ sid: "AskTheVault", actions: ["lambda:InvokeFunction"], resources: [vaultFn.functionArn] }),
        new iam.PolicyStatement({
          sid: "SagaTimers",
          actions: ["states:StartExecution", "states:StopExecution"],
          resources: [saga.stateMachineArn, `arn:aws:states:${this.region}:${this.account}:execution:${saga.stateMachineName}:*`],
        }),
        new iam.PolicyStatement({ sid: "JobQueue", actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], resources: [jobQueue.queueArn] }),
      ],
    });
    // TransactWriteItems is authorized per item as PutItem/ConditionCheckItem, covered above.
    const hostRole = new iam.Role(this, "HostRole", {
      roleName: "StoopHostRole",
      description: "Assumed by the Stoop host (EC2 instance profile when deployed)",
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [hostPolicy],
    });

    const out = (id: string, value: string) => new CfnOutput(this, id, { value });
    out("TableName", table.tableName);
    out("ReceiptKeyArn", receiptKey.keyArn);
    out("TokenMacKeyArn", tokenMacKey.keyArn);
    out("AddressKeyArn", addressKey.keyArn);
    out("VaultFunctionName", vaultFn.functionName);
    out("StateMachineArn", saga.stateMachineArn);
    out("JobQueueUrl", jobQueue.queueUrl);
    out("HostRoleArn", hostRole.roleArn);
  }
}
