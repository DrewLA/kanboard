# Internal Tools

These tools are for trusted local operators. Do not commit generated private keys.

## Generate Team Identity

Recommended onboarding flow:

```bash
npm run identity:onboard
```

This generates an EVM wallet, warns that the seed phrase is shown once, asks for a password with hidden retype confirmation, writes the encrypted identity to `.kanboard/identity.json`, and saves the public address/user record to `.kanboard/user.json`.

The printed and saved `address` is the team user ID. Send that address or the saved `userRecord` to the team admin. Keep the seed phrase and password private.

## Team Startup Rules

Team mode requires:

- `TASKBOARD_MODE=team`
- `TASKBOARD_DB_STRING=upstash;url=...;token=...;prefix=...`
- either `TASKBOARD_EVM_PRIVATE_KEY=...` or encrypted identity file `.kanboard/identity.json`

On startup, the local backend derives the address from the env private key or decrypted local identity file and checks that the address exists in the remote `users` table.

## Initialize Team Board

Set `TASKBOARD_DB_STRING`, then run:

```bash
npm run team:init -- 0xAdminAddress "Admin Name" "admin"
```

This writes the initial modular table package to the shared DB and registers the first user.

## Add Team User

```bash
npm run team:add-user -- 0xUserAddress "User Name" "engineer"
```

The user can get their address from `npm run identity:onboard`.
