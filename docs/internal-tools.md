# Internal Tools

These tools set up and administer the board. All are designed for local, trusted operator use only.

## Identity Onboarding

The first-run setup script is **fully interactive** and guides you through setup step-by-step:

```bash
npm run identity:onboard
```

This script:

1. **Intro**: Shows the detected mode (private / private-backup / team) and explains what will happen
2. **DB connectivity check** (if configured):
   - Pings the DB and reports connection status
   - Detects if this is a first-time team setup (no `users` table yet)
   - Shows informational messages as it goes
3. **Profile entry**: Prompts for name, role, and optional email
4. **Identity generation**: Generates a new EVM wallet and shows the seed phrase once (you must write it down)
5. **Password**: Prompts you to set and confirm an identity password
6. **Local storage**: Writes encrypted identity to `.kanboard/identity.json` and profile to `.kanboard/user.json`
7. **DB registration** (if configured):
   - If the team DB is empty, initializes the full shared board package automatically
   - Registers your profile in the team `users` table
   - Shows step-by-step progress as it writes
8. **Summary**: Prints your address, name, and role, then tells you to run `make dev` and open the board

**For team members**: Each team member runs this same command on their own machine. They each get their own local identity file, but all register in the same shared DB.

## Re-onboarding

To generate a new identity:

```bash
npm run identity:onboard --force
```

This overwrites the existing identity file. Your old EVM address will no longer be usable from this machine; rerun onboarding to register the new address in the shared team DB.

## Verify Current Identity

To print the current local identity address:

```bash
npm run identity:whoami
```

Returns the public EVM address from the local `.kanboard/identity.json` file.

## Team Mode Rules

Team mode requires:

- `TASKBOARD_MODE=team`
- `TASKBOARD_DB_STRING=upstash;url=...;token=...;prefix=...`
- Either `TASKBOARD_EVM_PRIVATE_KEY=...` or an encrypted identity file at `.kanboard/identity.json`

On startup:

- The backend derives the public address from the env private key (if set) or from the decrypted identity file
- If the team DB is empty, the first successful `npm run identity:onboard` initializes it
- It checks that the address is registered in the remote `users` table
- If registered, the board loads and becomes ready for mutations
- If not registered, the board loads but mutations are blocked until identity unlock succeeds

Every registered user is an **admin** — there is no per-user permission model. The shared DB connection string is the access boundary.
