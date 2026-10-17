# Tasks

- [x] 1. Truth table with presence grace (Requirement 5)
- [x] 2. Address release rules + audit on outcome change (Requirement 1)
- [x] 3. Capture rules + property test (Requirement 2)
- [x] 4. Capability tokens bound to canonical terms (Requirement 3)
- [x] 5. Negotiation oracle (Requirement 4)
- [x] 6. Purchase policy R13 (Requirement 6)
- [x] 7. KMS adapters: `MacProvider` over `GenerateMac`/`VerifyMac`; receipt signer over `Sign` (`MessageType=DIGEST`) + `derToRawP256`
  - `services/settlement/src/aws/kms.ts`; also `kmsVault` (encryption context `purpose=stoop-address`). Tested with mocked KMS: a KMS-signed receipt verifies offline.
- [x] 8. DynamoDB `Store` and `SpentTokenStore` (conditional put with TTL; `TransactWriteItems` for deal creation)
  - `services/settlement/src/aws/dynamo.ts`; `ifAbsent`/`ifVersion` become server-side conditions; a failed condition returns `false` like `MemoryStore`.
- [x] 9. Step Functions state machine mirroring `TickScheduler` job kinds (Wait + `TimestampPath`)
  - `StepFunctionsScheduler` (one Standard execution per job, Wait then SQS) + `pollJobs` in `services/settlement/src/aws/scheduler.ts`.
- [ ] 10. CDK `StoopStack` (KMS keys, table, Settlement Lambda with the only vault-decrypt grant, API Gateway, state machine)
  - Written in `infra/` and `cdk synth` is clean. Design change from the spec: the decrypt grant belongs to a dedicated Vault Lambda (the address boundary, `services/settlement/src/boundary.ts`) rather than all of Settlement, and the account root has no Decrypt either. Not deployed yet: the AWS account still returns `OptInRequired` for CloudFormation. API Gateway waits for the host decision (EC2 activation).
