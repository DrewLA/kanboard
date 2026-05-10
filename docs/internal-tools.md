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
   - Registers your profile in the team `users` table
   - If the table does not exist, creates it automatically
   - Shows step-by-step progress as it writes
8. **Summary**: Prints your address, name, and role, then tells you to run `make dev` and open the board

**For team members**: Each team member runs this same command on their own machine. They each get their own local identity file, but all register in the same shared DB.

## Re-onboarding

To generate a new identity:

```bash
npm run identity:onboard --force
```

This overwrites the existing identity file. Your old EVM address will no longer work; if you want to keep the same address in the team DB, manually add it via `team:add-user` after onboarding.

## Team Initialization (First-Time Setup)

If you are setting up a new team board from scratch and want to pre-create the team DB package before any members onboard:

```bash
npm run team:init -- <admin-address> "Admin Name" "admin"
```

This creates:

- The initial `users` table with the admin user registered
- Empty tables for epics, features, stories, tasks, comments, links, and metadata
- A new kanboard package at the configured DB prefix

Then, subsequent team members can run `npm run identity:onboard` and automatically register themselves.

## Add an Existing Address to the Team

If you have an EVM address (from `npm run identity:whoami` or saved from a previous onboarding) and want to add it to a team without re-running the full onboarding:

```bash
npm run team:add-user -- <existing-address> "User Name" "role"
```

This registers the address in the team `users` table without requiring the local identity password.

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
- It checks that the address is registered in the remote `users` table
- If registered, the board loads and becomes ready for mutations
- If not registered, the board loads but mutations are blocked until identity unlock succeeds

Every registered user is an **admin** — there is no per-user permission model. The shared DB connection string is the access boundary.
