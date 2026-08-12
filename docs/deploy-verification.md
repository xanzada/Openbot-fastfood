# Deploy verification

This repo is deployed by Dokploy from branch `codex/fix-wa-payment-signal` of
`github.com/xanzada/Openbot-fastfood`, with `autoDeploy` off. Pushing does not
deploy; a deploy must be triggered, and a 200 from it only means *queued*.

The chain that must hold for a change to be live:

1. Edit in the agent clone `~/.agentdock/repos/Openbot-fastfood` — never in
   `/projects/*` or `/etc/dokploy/compose/*/code`, which Dokploy overwrites on
   every deploy.
2. Commit and push to `codex/fix-wa-payment-signal`.
3. Trigger the Dokploy deploy for the app.
4. Confirm the change inside the running container, not in the clone.

Step 4 is the only proof.

## The trap that makes a green deploy a lie

The Dockerfile copies **only** `package*.json`, `tsconfig.json` and `src/`.
Change anything else — docs, scripts, a README, a config file outside src — and
the build legitimately reports every layer `CACHED`, the image digest does not
move, and compose leaves the old container `Running` instead of recreating it.
The deployment goes green and nothing changed, because nothing *could* change.

So a change outside those three paths needs the Dockerfile extended first.
And a verification marker must live inside `src/`, or it proves nothing: this
file was originally added on its own, the deploy passed in 7.5 s, and the file
never appeared in the container.
