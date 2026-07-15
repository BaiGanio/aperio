# Nimbus Deploy Runbook (benchmark fixture)

This document is a fixture for the model-tier doc-graph qualification cases. The
runner copies it into an isolated workspace and indexes it so `doc_search` /
`doc_context` have real content to retrieve. It is not team documentation.

## Rollback

If a blue-green cutover fails the synthetic pricing check, roll back by shifting
traffic to the previous green release on Fly.io. The rollback is a single traffic
switch; no data migration is involved because Redis is treated as a disposable
cache and Postgres remains the system of record.

## Event bus

Nimbus publishes pricing events over NATS JetStream rather than Kafka, so the
rollback never has to drain a Kafka topic.
