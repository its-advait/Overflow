# SCRIPTED recordings

A recording holds the model's answers for one mission, keyed by model-call step
(`oracle.extract`, `sample.judge`, `mission.plan`, `mission.synthesize`,
`agent.research`, `agent.finance`, `agent.verification`), in call order. Only the
model is replaced: in replay the service still asks the seller for order terms,
signs, settles through the treasury, funds the escrow, verifies the delivery and
books the ledger on Base Sepolia. Every file here says `"scripted": true` and is
produced by a real run with `DEMO_SCRIPTED=record`; nothing is hand-written.

Schema: `ScriptedRecordingSchema` in `apps/service/src/orchestration/scripted-model.ts`.

## Record (needs ANTHROPIC_API_KEY, CLAUDE_MODEL and a funded live environment)

```
DEMO_SCRIPTED=record DEMO_SCRIPTED_FILE=data/scripted/honest-seller.json pnpm --filter @overflow/service dev
pnpm --filter @overflow/service flow:demo -- --beat honest
```

The service rewrites the file after each model call. A recording holds one
mission; calls from a later mission in the same process are served live and logged
as skipped.

## Replay (no API key needed)

```
DEMO_SCRIPTED=replay DEMO_SCRIPTED_FILE=data/scripted/honest-seller.json pnpm --filter @overflow/service dev
pnpm --filter @overflow/service flow:demo -- --beat honest
```

Boot refuses when the file is missing or malformed. A step with no recorded answer
left fails that model call loudly; nothing is invented and the API is never called.
