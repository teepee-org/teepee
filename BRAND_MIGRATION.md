# Brand Migration Plan

Goal:

- umbrella brand: `TypeEffect`
- product brand: `Teepee`
- future repo home: `TypeEffect/teepee`

Current state:

- product site: `https://teepee.org`
- npm packages:
  - `teepee-cli`
  - `teepee-core`
  - `teepee-server`
- current GitHub repo: `teepee-org/teepee`
- current Pages source: `teepee-org/teepee` on `main` root

## Recommended public positioning

- Site copy: `Teepee by TypeEffect`
- README copy: `Teepee is a product by TypeEffect`
- Product name stays `Teepee`
- Domain stays `teepee.org` for the product

## Migration checklist

### 1. Create or prepare the destination org/repo

- Ensure the target GitHub organization exists: `TypeEffect`
- Ensure the destination repo name is available: `TypeEffect/teepee`
- Confirm org permissions, branch protection, and Pages access before transfer

### 2. Transfer the GitHub repository

- Transfer `teepee-org/teepee` to `TypeEffect/teepee`
- Keep the repository name `teepee`
- Do not rename the repo during the transfer

Expected outcome:

- GitHub should keep HTTP redirects from `teepee-org/teepee` to `TypeEffect/teepee`
- Existing repo links should continue working temporarily

### 3. Update repository metadata after transfer

Files to update:

- `README.md`
- `index.html`
- `packages/core/package.json`
- `packages/cli/package.json`
- `packages/server/package.json`

Replace:

- `https://github.com/teepee-org/teepee`

With:

- `https://github.com/TypeEffect/teepee`

And replace:

- `https://github.com/teepee-org/teepee.git`

With:

- `https://github.com/TypeEffect/teepee.git`

### 4. Re-verify GitHub Pages after transfer

In `TypeEffect/teepee`:

- `Settings` -> `Pages`
- `Source`: `Deploy from a branch`
- `Branch`: `main`
- `Folder`: `/(root)`
- `Custom domain`: `teepee.org`

Verify:

- Pages status is `built`
- `https://teepee.org` serves the new repo
- HTTPS is enforced

### 5. DNS checks

Keep:

- apex `teepee.org` pointing to GitHub Pages

Ensure:

- `www.teepee.org` is a `CNAME` to `teepee.org`

Avoid:

- stale `www` pointing at an unrelated user Pages site

### 6. Smoke tests after transfer

Verify:

- `https://teepee.org`
- `https://github.com/TypeEffect/teepee`
- old repo URL redirect from `teepee-org/teepee`
- README docs links
- site hero links
- package metadata links on npm

### 7. Optional later cleanup

Once the transfer has settled:

- update social links and launch copy to `TypeEffect`
- consider a small TypeEffect landing page that lists:
  - Teepee
  - the programming language
  - future tools

## What not to change now

- keep npm package names as-is
- keep the product name `Teepee`
- keep `teepee.org` as the product domain
- avoid a broad rename that mixes product identity and umbrella identity
