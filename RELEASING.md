# Releasing Teepee

This repository publishes npm packages from workspaces and serves the product website from the root of the `main` branch via GitHub Pages.

## Prerequisites

- Node.js 20+
- `npm` authenticated with publish access to `teepee-cli`, `teepee-core`, and `teepee-server`
- `gh` authenticated with `repo` scope for `typeeffect/teepee`
- A clean release-ready worktree on top of `main`

## Standard flow

1. Verify the worktree only contains the intended release changes.
2. Bump versions in:
   - `package.json`
   - `packages/cli/package.json`
   - `packages/core/package.json`
   - `packages/server/package.json`
   - `packages/web/package.json`
3. Update `CHANGELOG.md` and any user-facing site/docs copy needed for the release.
4. Write GitHub release notes in `releases/v0.x.y.md`.
5. Refresh the lockfile:

```bash
npm install --package-lock-only --ignore-scripts
```

6. Run the release verification suite:

```bash
npm run release:verify
npm run release:pack
```

7. Commit the release and create the tag:

```bash
git checkout main
git pull --ff-only origin main
git add .
git commit -m "Release 0.x.y with <summary>"
git tag -a v0.x.y -m "Release v0.x.y"
```

8. Push the branch and tag:

```bash
git push origin main
git push origin v0.x.y
```

9. Publish the public npm packages from the tagged commit:

```bash
npm publish --workspace=packages/core --access public
npm publish --workspace=packages/server --access public
npm publish --workspace=packages/cli --access public
```

10. Publish the GitHub release:

```bash
gh release create v0.x.y --repo typeeffect/teepee --title "v0.x.y" --notes-file releases/v0.x.y.md
```

11. Verify public artifacts:

- `npm view teepee-core version`
- `npm view teepee-server version`
- `npm view teepee-cli version`
- `gh release view v0.x.y --repo typeeffect/teepee`
- Open `https://teepee.org/`

## Notes

- GitHub Pages is configured from the root of the `main` branch, so website publication happens as part of the normal push to `main`.
- `packages/web` is an internal workspace and should stay unpublished.
- If historical GitHub releases are missing, backfill them only from known release commits/tags; do not guess versions.
