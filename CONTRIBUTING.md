# Contributing to Floorplan

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

[Open an issue](https://github.com/haydenschmitty/floorplan/issues/new/choose) and include:
- what you asked your coding agent, which agent you used, and what happened;
- the output it showed, especially lines starting with `✗` or `!`;
- your project's languages and frameworks, and whether it's one repo or several;
- your OS and Node version.

**Please don't paste private code, secrets, or screenshots of a map of a private project.** A description of the shape of the problem is usually enough.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Suggesting a feature

Open an issue describing what you were trying to do and what got in the way. Plugin users are often not engineers, so ideas that make the map clearer for them are especially welcome.

## Pull requests

1. Read [Developing Floorplan](docs/development.md) for the layout and how to test a local copy.
2. Branch from `main` with a name like `fix/<issue number>-short-name` or `feat/short-name`, and link the issue in the PR.
3. Keep changes focused, and follow the guidelines there:
   - no dependencies;
   - plain language in anything the map shows;
   - never store or print secret values;
   - keep examples generic.
4. Try your change on at least one real project, and say which kind in the PR. If you fixed something Floorplan detects wrongly, add a small sample to `tests/` that shows it.
5. If you changed behaviour people will notice, add a line to `CHANGELOG.md` under an "Unreleased" heading at the top.
6. Before opening the PR, run:
   ```bash
   npm test
   claude plugin validate .
   ```

Pull requests are merged with their commits and authorship kept, and you're credited in the changelog and release notes.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
