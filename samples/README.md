# Sample queries — legitimate usage patterns

Every file is one GraphQL request body. Run them through the gateway with:

```bash
curl -s http://localhost:4000/graphql \
  -H 'content-type: application/json' \
  -H 'x-api-key: demo-free-001' \
  --data @samples/01-me-feed.json | jq
```

The `npm run demo` script replays all of these plus the attack suite.
