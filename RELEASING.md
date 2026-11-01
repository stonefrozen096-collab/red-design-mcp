# Releasing red-design-mcp

Publish **one version at a time, always the latest code**. npm keeps every version you publish, and a version number can never be reused or overwritten. There is nothing to publish for older iterations.

## One-time setup
1. Create an account at https://www.npmjs.com/signup and verify your email.
2. Turn on two-factor authentication (Account settings). npm requires it to publish.
3. Install Node 18 or newer, then log in from your terminal:
   ```bash
   npm login
   npm whoami        # should print your username
   ```

## First release
```bash
npm install
npm test                      # builds and runs the automated tests
npm run inspect               # optional: try the tools in the MCP Inspector
npm view red-design-mcp       # a 404 means the name is free
npm pack --dry-run            # lists exactly which files will ship
npm publish                   # add --otp=123456 if npm asks for your 2FA code
```

Then check it from a clean folder:
```bash
cd "$(mktemp -d)"
npx red-design-mcp doctor
npx red-design-mcp install
```

Your package page appears at https://www.npmjs.com/package/red-design-mcp within a minute.

### Make the README banner show on npm
Add your repository to package.json before publishing (npm uses it to resolve the banner image):
```bash
npm pkg set repository.type=git
npm pkg set repository.url="git+https://github.com/YOUR_USERNAME/red-design-mcp.git"
npm pkg set homepage="https://github.com/YOUR_USERNAME/red-design-mcp#readme"
npm pkg set bugs.url="https://github.com/YOUR_USERNAME/red-design-mcp/issues"
```
npm may not render SVG images. If the banner is blank on npm, export `assets/banner.svg` as `banner.png` and point the README at it.

## Every later release
```bash
npm version patch   # bug fixes:      0.1.0 -> 0.1.1
npm version minor   # new features:   0.1.1 -> 0.2.0
npm version major   # breaking:       0.2.0 -> 1.0.0
npm publish
```
`npm version` also creates a git commit and tag. Versions below 1.0.0 signal "early, may change". Move to 1.0.0 once you have used it for a while.

## Automatic publishing with GitHub Actions (optional)
The repo includes two workflows in `.github/workflows`:
- `ci.yml` builds and tests on Node 18, 20 and 22 for every push and pull request.
- `publish.yml` publishes to npm whenever you create a GitHub release.

One-time setup for `publish.yml`:
1. On npmjs.com, create an access token (Granular access token, with publish permission for this package).
2. In your GitHub repo, go to Settings, Secrets and variables, Actions, and add a secret named `NPM_TOKEN` with that token.
3. Make sure the `repository` field in package.json points at this GitHub repo (needed for `--provenance`).

Then: bump the version, push, and create a release on GitHub. The workflow tests and publishes for you.

## If something goes wrong
- **404 or "package name too similar":** npm can reject names that look like existing packages. Pick another name in package.json.
- **E403 / "you must verify your email" or 2FA errors:** finish the account setup above.
- **Published a bad version:** publish a fixed patch version. `npm unpublish` is only allowed for the first 72 hours and should be a last resort.
