# Brand Status

Current brand structure:

- umbrella brand: `TypeEffect`
- product brand: `Teepee`
- product site: `https://teepee.org`
- GitHub repo: `https://github.com/typeeffect/teepee`

Current package names:

- `teepee-cli`
- `teepee-core`
- `teepee-server`

Current positioning:

- site copy: `Teepee by TypeEffect`
- README copy: `Teepee is a product by TypeEffect`

## Migration completed

Completed:

- moved the repository from `teepee-org/teepee` to `typeeffect/teepee`
- kept the repo name `teepee`
- preserved `teepee.org` as the product domain
- kept npm package names unchanged
- moved GitHub Pages for `teepee.org` to the product repo
- updated repo metadata links to the new GitHub location

Expected behavior:

- old GitHub links under `teepee-org/teepee` should redirect to `typeeffect/teepee`

## Remaining manual follow-up

Still recommended:

- set `www.teepee.org` DNS to `CNAME teepee.org`

That removes the stale dependency on an unrelated GitHub Pages hostname and keeps the product domain clean.
