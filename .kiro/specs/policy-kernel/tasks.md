# Tasks

- [x] 1. Truth table with presence grace (Requirement 5)
- [x] 2. Address release rules + audit on outcome change (Requirement 1)
- [x] 3. Capture rules + property test (Requirement 2)
- [x] 4. Capability tokens bound to canonical terms (Requirement 3)
- [x] 5. Negotiation oracle (Requirement 4)
- [x] 6. Purchase policy R13 (Requirement 6)
- [ ] 7. KMS adapters: `MacProvider` over `GenerateMac`/`VerifyMac`; receipt signer over `Sign` (`MessageType=DIGEST`) + `derToRawP256`
- [ ] 8. DynamoDB `Store` and `SpentTokenStore` (conditional put with TTL; `TransactWriteItems` for deal creation)
- [ ] 9. Step Functions state machine mirroring `TickScheduler` job kinds (Wait + `TimestampPath`)
- [ ] 10. CDK `StoopStack` (KMS keys, table, Settlement Lambda with the only vault-decrypt grant, API Gateway, state machine)
