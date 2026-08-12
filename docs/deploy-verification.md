# Deploy verification

This repo is deployed by Dokploy from branch `codex/fix-wa-payment-signal` of
`github.com/xanzada/Openbot-fastfood`, with `autoDeploy` off. Pushing does not
deploy; a deploy must be triggered, and a 200 from it only means *queued*.

The chain that must hold for a change to be live:

1. Edit in the agent clone `~/.agentdock/repos/Openbot-fastfood` — never in
   `/projects/*`, which Dokploy overwrites on every deploy.
2. Commit and push to `codex/fix-wa-payment-signal`.
3. Trigger the Dokploy deploy for the app.
4. Confirm the file inside the running container, not in the clone.

Step 4 is the only proof. This file exists so that the whole chain can be
checked without touching application code.
